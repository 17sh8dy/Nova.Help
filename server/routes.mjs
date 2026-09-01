/**
 * The HTML routes — the guided flow, the ticket form, and the ticket page.
 *
 * Two conventions hold everywhere in this file:
 *
 * 1. A ROUTE DECIDES AND RENDERS; IT DOES NOT REASON. Validation lives in core/validation,
 *    ticket rules in core/tickets, access in lib/access. A route reads a request, calls one
 *    of those, and picks a page. When a route starts to look clever, the cleverness belongs
 *    somewhere else.
 *
 * 2. EVERY POST ENDS IN A REDIRECT ON SUCCESS. Post/redirect/get, so a reload never files a
 *    second ticket and the back button never re-submits. Failures re-render the form in
 *    place, with what was typed still in it.
 *
 * 3. WHO YOU ARE COMES FROM THE SESSION, NEVER FROM THE FORM. A signed-in reporter's address
 *    is read off their Nova Account on the server; the submitted `email` field is ignored
 *    entirely rather than merely defaulted, so a hand-edited form cannot file a ticket under
 *    somebody else's address and cannot attach a ticket to an account that is not theirs.
 *    lib/viewer.mjs holds the two kinds of proof and the rule that keeps them apart.
 */
import { articlesFor, resolveSelection } from './core/catalog.mjs';
import { decorate } from './core/tickets.mjs';
import { normalizeTicketId } from './core/ids.mjs';
import { ATTACHMENT_LIMITS, serveTypeFor } from './core/attachments.mjs';
import { validateLookupInput } from './core/validation.mjs';
import { parseBody } from './lib/body.mjs';
import { PASS_COOKIE } from './lib/access.mjs';
import { baseHeaders, clientIp, cookie, redirect, sendHtml } from './lib/http.mjs';
import { sameEmail } from './store/fileStore.mjs';
import { homePage } from './views/pages/home.mjs';
import { projectPage, categoryPage } from './views/pages/browse.mjs';
import { newTicketPage } from './views/pages/newTicket.mjs';
import { ticketPage } from './views/pages/ticket.mjs';
import { lookupPage } from './views/pages/lookup.mjs';
import { privacyPage } from './views/pages/privacy.mjs';
import { forbiddenPage, notFoundPage, tooManyPage } from './views/pages/status.mjs';

/** Body cap: the attachment allowance plus room for the fields and multipart overhead. */
const BODY_LIMIT = ATTACHMENT_LIMITS.maxBytesTotal + 1024 * 1024;

const notFound = (res, what) => sendHtml(res, notFoundPage({ what }), { status: 404 });

export function registerRoutes(router, ctx) {
  const { tickets, attachments, access, viewer, limiters, config } = ctx;

  const signedIn = (req) => viewer.current(req);
  const grantCookie = (ticketId) =>
    cookie(PASS_COOKIE, access.issue(ticketId), { maxAge: access.ttlSeconds, secure: config.secureCookies });
  const ip = (req) => clientIp(req, { trustProxy: config.trustProxy });

  /* ── The guided flow ─────────────────────────────────────────────────────────────────── */

  router.get('/', async (req, res) => sendHtml(res, homePage({ account: await signedIn(req) })));

  router.get('/privacy', async (req, res) => sendHtml(res, privacyPage({ account: await signedIn(req) })));

  router.get('/help/:project', async (req, res) => {
    const found = resolveSelection({ project: req.params.project });
    if (!found.ok) return notFound(res, 'That product');
    return sendHtml(res, projectPage(found.project, { account: await signedIn(req) }));
  });

  router.get('/help/:project/:category', async (req, res) => {
    const found = resolveSelection({ project: req.params.project, category: req.params.category });
    if (!found.ok) {
      return notFound(res, found.missing === 'project' ? 'That product' : 'That area');
    }
    return sendHtml(res, categoryPage(found.project, found.category, { account: await signedIn(req) }));
  });

  /* The third click. Lands on the form with the selection already made. */
  router.get('/help/:project/:category/:issue', async (req, res) => {
    const found = resolveSelection({
      project: req.params.project,
      category: req.params.category,
      issueType: req.params.issue,
    });
    if (!found.ok) return notFound(res, 'That issue');

    return sendHtml(
      res,
      newTicketPage({
        project: found.project,
        category: found.category,
        issueType: found.issueType,
        articles: articlesFor(found.issueType),
        values: { priority: found.issueType.priority },
        account: await signedIn(req),
      }),
    );
  });

  router.post('/help/:project/:category/:issue', async (req, res) => {
    const found = resolveSelection({
      project: req.params.project,
      category: req.params.category,
      issueType: req.params.issue,
    });
    if (!found.ok) return notFound(res, 'That issue');

    const { project, category, issueType } = found;
    const account = await signedIn(req);
    const renderForm = (extra) =>
      sendHtml(
        res,
        newTicketPage({ project, category, issueType, articles: articlesFor(issueType), account, ...extra }),
        { status: extra.submitError || extra.errors ? 422 : 200 },
      );

    const gate = await limiters.create.hit(ip(req) ?? 'unknown');
    if (!gate.ok) {
      return sendHtml(res, tooManyPage({ retryAfter: gate.retryAfter }), {
        status: 429,
        headers: { 'retry-after': String(gate.retryAfter) },
      });
    }

    const body = await parseBody(req, {
      limit: BODY_LIMIT,
      maxFileBytes: ATTACHMENT_LIMITS.maxBytesPerFile + 1,
    });

    if (!body.ok) {
      const reason =
        body.reason === 'too-large'
          ? 'Those attachments are too large to send in one ticket. Try again with fewer or smaller files.'
          : 'We could not read that submission. Please try again.';
      return renderForm({ submitError: reason, values: {}, errors: {}, attachmentErrors: [] });
    }

    /* The honeypot field is invisible and off the tab order, so a person never fills it in.
       Nothing is stored, and the reason shown is honest rather than a fake success. */
    if (String(body.fields.website ?? '').trim()) {
      return renderForm({
        submitError: 'That submission looked automated, so it was not sent. If you are not a bot, remove any browser autofill from the hidden field and try again.',
        values: body.fields,
        errors: {},
        attachmentErrors: [],
      });
    }

    const input = {
      ...body.fields,
      project: project.id,
      category: category.id,
      issueType: issueType.id,
    };

    /* Signed in: the contact details come off the account and the submitted ones are
       discarded. The form does not render those fields at all, so anything arriving in them
       was put there by hand. */
    if (account) {
      input.email = account.email;
      input.name = account.displayName ?? '';
    }

    const files = body.files.filter((file) => file.field === 'files');

    const result = await tickets.create({
      input,
      files,
      source: { channel: 'web', ip: ip(req) },
      accountId: account?.id ?? null,
    });

    if (!result.ok) {
      return renderForm({
        values: result.values,
        errors: result.errors,
        attachmentErrors: result.attachmentErrors,
      });
    }

    /* A guest gets a pass for the ticket they just filed. A signed-in reporter does NOT:
       their access comes from the account, and minting a guest pass as well would leave the
       ticket openable on this device after they sign out — which is exactly the crossing
       between the two access paths that the lookup form refuses to make. */
    return redirect(res, `/tickets/${encodeURIComponent(result.ticket.id)}?created=1`, {
      headers: account ? {} : { 'set-cookie': grantCookie(result.ticket.id) },
    });
  });

  /* ── Tickets ─────────────────────────────────────────────────────────────────────────── */

  router.get('/tickets', async (req, res) =>
    sendHtml(res, lookupPage({ account: await signedIn(req) })));

  router.post('/tickets', async (req, res) => {
    const account = await signedIn(req);

    const gate = await limiters.lookup.hit(ip(req) ?? 'unknown');
    if (!gate.ok) {
      return sendHtml(res, lookupPage({ rateLimited: gate.retryAfter, account }), { status: 429 });
    }

    const body = await parseBody(req, { limit: 64 * 1024 });
    const validated = validateLookupInput(body.fields);
    if (!validated.ok) {
      return sendHtml(res, lookupPage({ values: validated.values, errors: validated.errors, account }), { status: 422 });
    }

    const id = normalizeTicketId(validated.values.ticketId);
    const ticket = id ? await tickets.get(id) : null;

    /* One message for "no such ticket" and "wrong address", so this form cannot be used to
       discover which ticket ids exist. */
    if (!ticket || !sameEmail(ticket.requester?.email, validated.values.email)) {
      return sendHtml(res, lookupPage({ values: validated.values, failed: true, account }), { status: 404 });
    }

    /* THIS FORM ISSUES GUEST PASSES, AND A TICKET THAT BELONGS TO AN ACCOUNT DOES NOT TAKE
       ONE. Otherwise the id and the address — the weaker proof — would open a ticket that is
       supposed to be behind the stronger one, and the two access paths would have quietly
       become one. The owner is sent to it directly; anybody else is told to sign in. */
    if (ticket.accountId) {
      if (account?.id === ticket.accountId) {
        await limiters.lookup.clear(ip(req) ?? 'unknown');
        return redirect(res, `/tickets/${encodeURIComponent(ticket.id)}`);
      }
      return sendHtml(res, lookupPage({ values: validated.values, accountOwned: true, account }), { status: 403 });
    }

    await limiters.lookup.clear(ip(req) ?? 'unknown');
    return redirect(res, `/tickets/${encodeURIComponent(ticket.id)}`, {
      headers: { 'set-cookie': grantCookie(ticket.id) },
    });
  });

  /**
   * The ticket page.
   *
   * A GUEST PASS OR AN OWNING ACCOUNT OPENS IT; NOTHING ELSE DOES. The ticket is loaded before
   * the check so that an account can be matched against it, and a refusal is the same 403
   * whether the ticket is somebody else's or does not exist at all — a 404 here would turn
   * this URL into a way to find out which ticket ids are real.
   */
  router.get('/tickets/:id', async (req, res) => {
    const id = normalizeTicketId(req.params.id);
    if (!id) return notFound(res, 'That ticket');

    const ticket = await tickets.get(id);
    const grant = await viewer.mayOpen(req, ticket);
    if (!grant.ok) return sendHtml(res, forbiddenPage(), { status: 403 });

    const params = new URL(req.url, 'http://local').searchParams;
    return sendHtml(
      res,
      ticketPage({
        ticket: decorate(ticket),
        created: params.get('created') === '1',
        replySent: params.get('replied') === '1',
        account: await signedIn(req),
      }),
    );
  });

  router.post('/tickets/:id/replies', async (req, res) => {
    const id = normalizeTicketId(req.params.id);
    if (!id) return notFound(res, 'That ticket');

    const existing = await tickets.get(id);
    const grant = await viewer.mayOpen(req, existing);
    if (!grant.ok) return sendHtml(res, forbiddenPage(), { status: 403 });

    const gate = await limiters.reply.hit(id);
    if (!gate.ok) {
      return sendHtml(res, tooManyPage({ retryAfter: gate.retryAfter }), {
        status: 429,
        headers: { 'retry-after': String(gate.retryAfter) },
      });
    }

    const body = await parseBody(req, { limit: 256 * 1024 });
    const ticket = await tickets.get(id);
    if (!ticket) return notFound(res, 'That ticket');

    const result = await tickets.addReply(id, {
      body: body.fields.body,
      actor: { kind: 'user', name: ticket.requester?.name ?? null },
    });

    if (!result.ok) {
      return sendHtml(
        res,
        ticketPage({
          ticket: decorate(ticket),
          replyError: result.errors?.body ?? 'That reply could not be added.',
          replyValue: String(body.fields.body ?? ''),
          account: await signedIn(req),
        }),
        { status: 422 },
      );
    }

    return redirect(res, `/tickets/${encodeURIComponent(id)}?replied=1`);
  });

  /**
   * Attachment download.
   *
   * Served with the type decided by extension and always as a download, so a file a stranger
   * uploaded can never execute as a page on this origin. Access is the same check that gates
   * the ticket page — an attachment id on its own opens nothing.
   */
  router.get('/tickets/:id/attachments/:attachmentId', async (req, res) => {
    const id = normalizeTicketId(req.params.id);
    if (!id) return notFound(res, 'That file');

    const ticket = await tickets.get(id);
    const grant = await viewer.mayOpen(req, ticket);
    if (!grant.ok) return sendHtml(res, forbiddenPage(), { status: 403 });

    const record = ticket?.attachments?.find((a) => a.id === req.params.attachmentId);
    if (!record) return notFound(res, 'That file');

    const bytes = await attachments.read(id, record.id);
    if (!bytes) return notFound(res, 'That file');

    /* The filename is quoted and stripped of quotes and control characters; the RFC 5987 form
       carries the real name for clients that understand it. */
    const asciiName = record.filename.replace(/["\\]/g, '_').replace(/[^\x20-\x7e]/g, '_');
    res.writeHead(
      200,
      baseHeaders({
        'content-type': serveTypeFor(record),
        'content-length': bytes.length,
        'content-disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(record.filename)}`,
        'cache-control': 'private, no-store',
      }),
    );
    res.end(bytes);
  });
}
