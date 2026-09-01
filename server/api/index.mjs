/**
 * The JSON API.
 *
 * WHY IT EXISTS IN VERSION ONE. It is the seam the eventual assistant plugs into. When
 * something can read the catalog, look up an article, and file a ticket through the same
 * service the web form uses, the assistant becomes a client of this portal rather than a
 * second implementation of it — which is the difference between adding a feature and
 * rebuilding the system.
 *
 * WHAT IT DELIBERATELY DOES NOT HAVE. No staff endpoints, no listing of other people's
 * tickets, no status changes, and no authentication scheme of its own: it accepts exactly the
 * two proofs the web pages accept, through server/lib/viewer.mjs, so there is one answer to
 * "may this request open this ticket" in the whole codebase. Adding a staff console means
 * adding real authorisation, and half of one would be worse than none.
 *
 * THERE IS NO SIGN-IN ENDPOINT HERE ON PURPOSE. Nova Accounts is a foundation for the
 * ecosystem, and the shape of the call other Nova products will make is a decision to take
 * when the second product needs it — not one to guess at now and then be stuck with. What
 * exists today is the session cookie the browser already holds; see docs/NOVA-ACCOUNTS.md.
 *
 * `GET /api/catalog` carries `sensitive` on every issue type and a `policy` block describing
 * what an automated client may do with it. A client that reads this API is told, in the data
 * itself, which requests it must never try to answer.
 */
import {
  articles,
  priorities,
  projects,
  statuses,
  transitions,
  getProject,
  resolveSelection,
} from '../core/catalog.mjs';
import { decorate, publicEvents, summarize } from '../core/tickets.mjs';
import { assistantScope } from '../core/policy.mjs';
import { normalizeTicketId } from '../core/ids.mjs';
import { validateLookupInput } from '../core/validation.mjs';
import { parseBody } from '../lib/body.mjs';
import { clientIp, sendJson } from '../lib/http.mjs';
import { sameEmail } from '../store/fileStore.mjs';

const issueView = (issueType) => ({
  id: issueType.id,
  label: issueType.label,
  blurb: issueType.blurb ?? null,
  priorityMode: issueType.priorityMode,
  priority: issueType.priority,
  sensitive: issueType.sensitive,
  articles: [...issueType.articles],
  path: issueType.path,
});

const categoryView = (category) => ({
  id: category.id,
  label: category.label,
  blurb: category.blurb ?? null,
  icon: category.icon ?? null,
  sensitive: category.sensitive,
  issueTypes: category.issueTypes.map(issueView),
});

const projectView = (project) => ({
  id: project.id,
  name: project.name,
  subtitle: project.subtitle ?? null,
  blurb: project.blurb,
  kind: project.kind,
  environment: project.environment,
  categories: project.categories.map(categoryView),
});

/**
 * The rules an automated client is bound by, served alongside the catalog so they cannot be
 * left behind in a document nobody reads.
 */
const POLICY = {
  humanOnly:
    'Issue types marked "sensitive" are decided by a person. An automated client must not answer, promise, or resolve them — it may only help the reporter file one.',
  neverDecide: ['account ownership', 'account suspension', 'security incidents', 'refunds and payments', 'legal requests'],
  autoRespond: false,
  sourceOfTruth: 'Support articles are suggestions. Ticket status and staff replies are the only authoritative record.',
};

export function registerApi(router, ctx) {
  const { tickets, viewer, limiters, config } = ctx;
  const ip = (req) => clientIp(req, { trustProxy: config.trustProxy });

  /**
   * Three ways in, and no fourth.
   *
   * 1. A guest pass cookie for this ticket, or a Nova Account session that owns it — both
   *    decided by viewer.mayOpen, the same call the HTML routes make.
   * 2. The email address the ticket was filed with, supplied on the request. THIS ONE IS
   *    REFUSED FOR A TICKET THAT BELONGS TO AN ACCOUNT, exactly as the web lookup form
   *    refuses it: an account-owned ticket is behind the account, or the weaker proof would
   *    silently be a way around the stronger one.
   *
   * A missing ticket and an unauthorised one answer 404 and 403 respectively only after the
   * caller has failed to prove anything, and both bodies say the same thing, so this endpoint
   * cannot be walked to discover which ids exist.
   */
  async function authorize(req, ticketId, suppliedEmail) {
    const ticket = await tickets.get(ticketId);

    const grant = await viewer.mayOpen(req, ticket);
    if (grant.ok) return { ok: true, ticket, via: grant.via };

    const refusal = { ok: false, status: 403, error: 'Provide the email address this ticket was filed with.' };
    if (!ticket) return refusal;

    if (suppliedEmail && !ticket.accountId && sameEmail(ticket.requester?.email, suppliedEmail)) {
      return { ok: true, ticket, via: 'email' };
    }
    if (suppliedEmail && ticket.accountId && sameEmail(ticket.requester?.email, suppliedEmail)) {
      return { ok: false, status: 403, error: 'This ticket belongs to a Nova Account. Sign in to open it.' };
    }
    return refusal;
  }

  router.get('/api/health', (req, res) => sendJson(res, { ok: true, service: 'nova.help' }));

  router.get('/api/catalog', (req, res) =>
    sendJson(res, {
      projects: projects.map(projectView),
      statuses,
      priorities,
      transitions,
      policy: POLICY,
    }),
  );

  router.get('/api/catalog/:project', (req, res) => {
    const project = getProject(req.params.project);
    if (!project) return sendJson(res, { error: 'No such project.' }, { status: 404 });
    return sendJson(res, { project: projectView(project), policy: POLICY });
  });

  router.get('/api/articles', (req, res) => sendJson(res, { articles }));

  /**
   * Create a ticket from JSON. No attachments — a file upload belongs on the multipart form,
   * and pretending otherwise here would mean a second upload path to keep honest.
   */
  router.post('/api/tickets', async (req, res) => {
    const gate = await limiters.create.hit(ip(req) ?? 'unknown');
    if (!gate.ok) {
      return sendJson(res, { error: 'Too many requests.', retryAfter: gate.retryAfter }, {
        status: 429,
        headers: { 'retry-after': String(gate.retryAfter) },
      });
    }

    const body = await parseBody(req, { limit: 256 * 1024 });
    if (!body.ok) return sendJson(res, { error: 'Could not read the request body.' }, { status: 400 });

    const channel = body.fields.source === 'assistant' ? 'assistant' : 'api';

    /* A browser calling this endpoint carries the same session cookie the pages do, so a
       signed-in reporter gets the same treatment here: address off the account, ticket owned
       by the account, submitted address ignored. */
    const account = await viewer.current(req);
    const input = account
      ? { ...body.fields, email: account.email, name: account.displayName ?? '' }
      : body.fields;

    const result = await tickets.create({
      input,
      files: [],
      source: { channel, ip: ip(req) },
      accountId: account?.id ?? null,
    });

    if (!result.ok) {
      return sendJson(res, { error: 'Validation failed.', fields: result.errors }, { status: 422 });
    }

    const ticket = decorate(result.ticket);
    return sendJson(
      res,
      {
        ticket: summarize(result.ticket),
        routing: ticket.routing,
        assistant: assistantScope(result.ticket),
      },
      { status: 201 },
    );
  });

  router.get('/api/tickets/:id', async (req, res) => {
    const id = normalizeTicketId(req.params.id);
    if (!id) return sendJson(res, { error: 'Not a ticket id.' }, { status: 400 });

    const email = new URL(req.url, 'http://local').searchParams.get('email');
    const auth = await authorize(req, id, email);
    if (!auth.ok) return sendJson(res, { error: auth.error }, { status: auth.status });

    const ticket = decorate(auth.ticket);
    return sendJson(res, {
      ticket: {
        ...summarize(auth.ticket),
        description: ticket.description,
        requester: { name: ticket.requester?.name ?? null, email: ticket.requester?.email },
        environment: ticket.environment,
        routing: ticket.routing,
        attachments: (ticket.attachments ?? []).map((a) => ({
          id: a.id,
          filename: a.filename,
          size: a.size,
          uploadedAt: a.uploadedAt,
        })),
        events: publicEvents(auth.ticket).map((e) => ({
          id: e.id,
          at: e.at,
          type: e.type,
          actor: e.actor.kind,
          body: e.body,
          meta: e.meta,
        })),
      },
      assistant: assistantScope(auth.ticket),
    });
  });

  router.post('/api/tickets/:id/replies', async (req, res) => {
    const id = normalizeTicketId(req.params.id);
    if (!id) return sendJson(res, { error: 'Not a ticket id.' }, { status: 400 });

    const body = await parseBody(req, { limit: 256 * 1024 });
    if (!body.ok) return sendJson(res, { error: 'Could not read the request body.' }, { status: 400 });

    const auth = await authorize(req, id, body.fields.email);
    if (!auth.ok) return sendJson(res, { error: auth.error }, { status: auth.status });

    const gate = await limiters.reply.hit(id);
    if (!gate.ok) {
      return sendJson(res, { error: 'Too many replies.', retryAfter: gate.retryAfter }, { status: 429 });
    }

    const result = await tickets.addReply(id, {
      body: body.fields.body,
      actor: { kind: 'user', name: auth.ticket.requester?.name ?? null },
    });
    if (!result.ok) return sendJson(res, { error: 'Validation failed.', fields: result.errors }, { status: 422 });

    return sendJson(res, { ticket: summarize(result.ticket) }, { status: 201 });
  });

  /** Resolve a selection — the call a classifier makes to check its own guess is real. */
  router.get('/api/resolve/:project/:category/:issue', (req, res) => {
    const found = resolveSelection({
      project: req.params.project,
      category: req.params.category,
      issueType: req.params.issue,
    });
    if (!found.ok) return sendJson(res, { error: `Unknown ${found.missing}.` }, { status: 404 });

    return sendJson(res, {
      project: { id: found.project.id, name: found.project.name },
      category: { id: found.category.id, label: found.category.label },
      issueType: issueView(found.issueType),
      formUrl: `/help/${found.project.id}/${found.category.id}/${found.issueType.id}`,
      assistant: assistantScope({
        project: found.project.id,
        category: found.category.id,
        issueType: found.issueType.id,
        priority: found.issueType.priority,
      }),
    });
  });

  /** Operational counts. No ticket contents, no addresses — safe to expose to a dashboard. */
  router.get('/api/stats', async (req, res) => sendJson(res, await tickets.counts()));
}
