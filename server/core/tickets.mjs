/**
 * The ticket service — every rule about what a ticket is and how it may change.
 *
 * Routes call this; this calls the store. No HTTP type appears in this file, and no route
 * writes a ticket document directly, so the JSON API, the HTML form and a future assistant
 * filing on someone's behalf cannot drift apart in behaviour.
 *
 * THE DOCUMENT SHAPE IS THE THING TO GET RIGHT NOW, because it is what a later staff console,
 * assignment, internal notes and a real database all have to live with:
 *
 *   id, schemaVersion, createdAt, updatedAt
 *   project / category / issueType   — catalog ids, never labels; labels are looked up for
 *                                      display so renaming a category renames it everywhere
 *   subject, description, priority, status
 *   requester { name, email }
 *   accountId                        — the Nova Account that filed it, or null for a guest
 *                                      ticket. It is the ONLY thing that grants an account
 *                                      access to a ticket; see docs/NOVA-ACCOUNTS.md for why
 *                                      a matching email address deliberately does not.
 *   environment { platform, appVersion }
 *   attachments []                   — metadata; the bytes live in the attachment store
 *   assignee                         — null in this version; the field exists so assigning
 *                                      later is a write, not a migration
 *   tags []                          — unused by the UI, populated by staff or triage later
 *   routing { humanOnly, reason }    — decided by policy.mjs at creation
 *   source { channel, ip }           — 'web' | 'api' | 'assistant', so a ticket a machine
 *                                      filed is always distinguishable from one a person did
 *   events []                        — the history. APPEND ONLY.
 *
 * EVENTS ARE THE HISTORY AND THE CONVERSATION AT ONCE. Every change appends one, nothing
 * rewrites one, and each carries `visibility: 'public' | 'internal'` so that internal notes
 * can exist in the same list the reporter's page renders from — the ticket page filters on
 * visibility, which is the only reason internal notes can be added later without touching it.
 */
import { canTransition, getCategory, getIssueType, getProject, getStatus, DEFAULT_STATUS } from './catalog.mjs';
import { newEventId, newTicketId } from './ids.mjs';
import { classify } from './policy.mjs';
import { validateFiles } from './attachments.mjs';
import { validateReplyInput, validateTicketInput } from './validation.mjs';

/**
 * 2 added `accountId`. The field is additive and read as `?? null`, so a version 1 document
 * on disk is still a valid guest ticket and no migration is needed.
 */
const SCHEMA_VERSION = 2;

/** Who did a thing. `kind` is what matters; `name` is only for display. */
const actorOf = (actor = {}) => ({
  kind: actor.kind ?? 'user',
  name: actor.name ?? null,
});

function event({ type, actor, body = null, visibility = 'public', meta = null }) {
  return {
    id: newEventId(),
    at: new Date().toISOString(),
    type,
    actor: actorOf(actor),
    visibility,
    body,
    meta,
  };
}

export function createTicketService({ store, attachments }) {
  /** Generate an id that is not already taken. Collisions are vanishingly rare; loops are cheap. */
  async function allocateId() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = newTicketId();
      if (!(await store.has(id))) return id;
    }
    throw new Error('Could not allocate a unique ticket id.');
  }

  return {
    /**
     * Create a ticket.
     *
     * Returns `{ ok: true, ticket }` or `{ ok: false, errors, attachmentErrors, values }`.
     * It never throws for bad input — invalid input is an expected outcome of a public form,
     * not an exception.
     *
     * Attachments are written only after the input validates, and are removed again if the
     * document fails to persist, so a failed submission never leaves orphaned bytes on disk.
     */
    async create({ input = {}, files = [], source = {}, accountId = null } = {}) {
      const validated = validateTicketInput(input);
      const fileCheck = validateFiles(files);

      if (!validated.ok || !fileCheck.ok) {
        return {
          ok: false,
          errors: validated.errors,
          attachmentErrors: fileCheck.errors,
          values: validated.values,
        };
      }

      const { values } = validated;
      const routing = classify(values);
      const id = await allocateId();

      let saved = [];
      try {
        saved = await attachments.save(id, fileCheck.files);
      } catch (err) {
        await attachments.discard(id);
        throw err;
      }

      const now = new Date().toISOString();
      const ticket = {
        id,
        schemaVersion: SCHEMA_VERSION,
        createdAt: now,
        updatedAt: now,

        project: values.project,
        category: values.category,
        issueType: values.issueType,

        subject: values.subject,
        description: values.description,
        priority: values.priority,
        status: DEFAULT_STATUS,

        requester: { name: values.name || null, email: values.email },
        accountId: accountId ?? null,
        environment: {
          platform: values.platform || null,
          appVersion: values.appVersion || null,
        },

        attachments: saved,
        assignee: null,
        tags: [],
        routing: { humanOnly: routing.humanOnly, reason: routing.reason },
        source: { channel: source.channel ?? 'web', ip: source.ip ?? null },

        events: [
          event({
            type: 'created',
            actor: { kind: source.channel === 'assistant' ? 'assistant' : 'user', name: values.name || null },
            body: values.description,
            meta: { attachments: saved.map((a) => a.id) },
          }),
        ],
      };

      try {
        await store.create(ticket);
      } catch (err) {
        await attachments.discard(id);
        throw err;
      }

      return { ok: true, ticket };
    },

    /** A ticket by id, or null. No access check — callers decide who may see it. */
    async get(id) {
      return store.get(id);
    },

    /**
     * Append a reply from the reporter.
     *
     * A reply on a ticket that was waiting for the user hands it back to support, because
     * that is what the reporter believes has happened; a reply on a resolved or closed
     * ticket reopens it, because otherwise the reporter is talking to nobody.
     */
    async addReply(id, { body, actor = { kind: 'user' } } = {}) {
      const validated = validateReplyInput({ body });
      if (!validated.ok) return { ok: false, errors: validated.errors, values: validated.values };

      const ticket = await store.update(id, (doc) => {
        doc.events.push(event({ type: 'reply', actor, body: validated.values.body }));

        const shouldReopen = ['waiting_user', 'resolved', 'closed'].includes(doc.status);
        if (shouldReopen) {
          const next = doc.status === 'closed' ? 'open' : 'in_progress';
          if (canTransition(doc.status, next)) {
            doc.events.push(
              event({
                type: 'status_changed',
                actor: { kind: 'system' },
                visibility: 'public',
                meta: { from: doc.status, to: next, cause: 'reply' },
              }),
            );
            doc.status = next;
          }
        }

        doc.updatedAt = new Date().toISOString();
        return doc;
      });

      return ticket ? { ok: true, ticket } : { ok: false, errors: { body: 'That ticket no longer exists.' } };
    },

    /**
     * Move a ticket to another status. Refuses transitions the catalog does not allow, so
     * neither a staff console nor an automated caller can invent a state machine of its own.
     */
    async setStatus(id, nextStatus, { actor = { kind: 'staff' }, note = null } = {}) {
      if (!getStatus(nextStatus)) return { ok: false, error: `Unknown status "${nextStatus}".` };

      let refusal = null;
      const ticket = await store.update(id, (doc) => {
        if (doc.status === nextStatus) {
          refusal = `Ticket is already ${nextStatus}.`;
          return null;
        }
        if (!canTransition(doc.status, nextStatus)) {
          refusal = `Cannot move a ticket from ${doc.status} to ${nextStatus}.`;
          return null;
        }
        doc.events.push(
          event({
            type: 'status_changed',
            actor,
            body: note,
            meta: { from: doc.status, to: nextStatus },
          }),
        );
        doc.status = nextStatus;
        doc.updatedAt = new Date().toISOString();
        return doc;
      });

      if (refusal) return { ok: false, error: refusal };
      return ticket ? { ok: true, ticket } : { ok: false, error: 'No such ticket.' };
    },

    /**
     * A note only support sees. Present from the first version because the alternative — a
     * public event field that "we will hide later" — is how internal notes leak.
     */
    async addInternalNote(id, { body, actor = { kind: 'staff' } } = {}) {
      const text = String(body ?? '').trim();
      if (!text) return { ok: false, error: 'A note needs some text.' };

      const ticket = await store.update(id, (doc) => {
        doc.events.push(event({ type: 'note', actor, body: text, visibility: 'internal' }));
        doc.updatedAt = new Date().toISOString();
        return doc;
      });
      return ticket ? { ok: true, ticket } : { ok: false, error: 'No such ticket.' };
    },

    /** Assign to a member of staff, or pass null to unassign. */
    async assign(id, assignee, { actor = { kind: 'staff' } } = {}) {
      const ticket = await store.update(id, (doc) => {
        doc.assignee = assignee ?? null;
        doc.events.push(event({ type: 'assigned', actor, visibility: 'internal', meta: { assignee: doc.assignee } }));
        doc.updatedAt = new Date().toISOString();
        return doc;
      });
      return ticket ? { ok: true, ticket } : { ok: false, error: 'No such ticket.' };
    },

    /**
     * Every ticket belonging to one Nova Account, newest first.
     *
     * Filtering on the account id and never on the address is the point: an account whose
     * address happens to match a guest ticket gets nothing, because until addresses are
     * verified an address is not proof of anything.
     */
    async listForAccount(accountId, { limit = 50, offset = 0 } = {}) {
      if (!accountId) return { total: 0, tickets: [] };
      return store.list({ accountId, limit, offset });
    },

    list: (query) => store.list(query),
    counts: () => store.counts(),
  };
}

/* ── Views ─────────────────────────────────────────────────────────────────────────────── */

/**
 * Resolve a ticket's catalog ids to their current labels for display.
 *
 * Ids are what is stored; labels are what is shown. A category renamed in data/ is renamed on
 * every historical ticket at once, and a category that is deleted degrades to its raw id
 * rather than to `undefined`.
 */
export function decorate(ticket) {
  if (!ticket) return null;
  const project = getProject(ticket.project);
  const category = getCategory(ticket.project, ticket.category);
  const issueType = getIssueType(ticket.project, ticket.category, ticket.issueType);
  const status = getStatus(ticket.status);

  return {
    ...ticket,
    labels: {
      project: project?.name ?? ticket.project,
      category: category?.label ?? ticket.category,
      issueType: issueType?.label ?? ticket.issueType,
    },
    projectRef: project ?? null,
    statusRef: status ?? null,
  };
}

/** The events a reporter is allowed to see. The only place that filter is applied. */
export const publicEvents = (ticket) => (ticket?.events ?? []).filter((e) => e.visibility !== 'internal');

/** A compact record for lists and API responses — no description, no event bodies. */
export function summarize(ticket) {
  const decorated = decorate(ticket);
  return {
    id: decorated.id,
    subject: decorated.subject,
    status: decorated.status,
    priority: decorated.priority,
    project: decorated.project,
    category: decorated.category,
    issueType: decorated.issueType,
    labels: decorated.labels,
    createdAt: decorated.createdAt,
    updatedAt: decorated.updatedAt,
    replyCount: publicEvents(ticket).filter((e) => e.type === 'reply').length,
    attachmentCount: ticket.attachments?.length ?? 0,
  };
}
