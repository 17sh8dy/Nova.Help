/**
 * The ticket store on Cloudflare D1 — the same six methods as store/fileStore.mjs.
 *
 * Nothing above this file knows which store it is talking to. core/tickets.mjs still hands
 * `update()` a mutator that receives a whole document and returns a whole document; that this
 * one turns into rows and a version check is entirely this file's business.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHY OPTIMISTIC CONCURRENCY RATHER THAN A LOCK.
 *
 * D1 operates in auto-commit and has no interactive transaction: `batch()` takes a list of
 * statements decided in advance, so there is no way to hold `BEGIN`, run a caller's JavaScript,
 * and then `COMMIT`. A read-modify-write with an arbitrary mutator in the middle therefore
 * CANNOT be made atomic by a transaction here. It has to be attempted and checked, which is
 * what `version` is for: every write says which version it read, and the database refuses it
 * if that is no longer the version it has.
 *
 * THE MUTATOR CONTRACT THAT COMES WITH THAT, and which the JSON store does not need:
 *
 *     A MUTATOR MUST BE A PURE FUNCTION OF THE DOCUMENT, AND MAY RUN MORE THAN ONCE.
 *
 * A losing attempt is discarded and the mutator is re-run against fresh state, so a mutator
 * that appends to something outside its document, writes a file, or calls a service will do it
 * once per attempt. Assigning to a variable in the enclosing scope is fine -- a re-run
 * overwrites it -- and that is what setStatus and signOut already do. Appending to one is not.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHY MOST WRITES NEVER RETRY ANYWAY.
 *
 * Because events are rows and not a JSON array, appending one is an INSERT that collides with
 * nothing. A reply is a fact: it happened, and it is recorded. Only a change that depends on
 * what it read -- a guarded status transition -- is a decision, and only a decision can lose a
 * race and be retried. In practice `addReply` and `addInternalNote` retry only when they also
 * move the status, and `assign` never does.
 *
 * THE BATCH ORDER IS LOAD-BEARING. Every statement is guarded by the version that was read,
 * and the `UPDATE` that bumps the version goes LAST. Reversed, the update would bump the
 * version before the guarded inserts tested it and every insert would silently drop its row.
 * A batch rolls back on a statement ERROR, but a guarded statement that matches nothing is a
 * perfectly successful statement reporting `changes: 0` -- so the guard has to be on each
 * statement individually, not left to the rollback.
 */

/** Normalised exactly as fileStore's `sameEmail` normalises, or the two stores disagree. */
const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase();

/**
 * The address as an index key. WebCrypto rather than node:crypto so this file runs unchanged
 * in a Worker.
 */
async function emailHash(value) {
  const bytes = new TextEncoder().encode(normalizeEmail(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const parseJson = (value, fallback) => {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

/** A ticket row plus its events and attachments, as the document the rest of the app expects. */
function toDocument(row, eventRows, attachmentRows) {
  return {
    id: row.id,
    schemaVersion: row.schema_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,

    project: row.project,
    category: row.category,
    issueType: row.issue_type,

    subject: row.subject,
    description: row.description,
    priority: row.priority,
    status: row.status,

    requester: { name: row.requester_name, email: row.requester_email },
    accountId: row.account_id,
    environment: { platform: row.platform, appVersion: row.app_version },

    attachments: attachmentRows.map((a) => ({
      id: a.id,
      filename: a.filename,
      declaredType: a.declared_type,
      size: a.size,
      uploadedAt: a.uploaded_at,
    })),
    assignee: row.assignee,
    tags: parseJson(row.tags, []),
    routing: { humanOnly: Boolean(row.routing_human_only), reason: row.routing_reason },
    source: { channel: row.source_channel, ip: row.source_ip },

    events: eventRows.map((e) => ({
      id: e.id,
      at: e.at,
      type: e.type,
      actor: { kind: e.actor_kind, name: e.actor_name },
      visibility: e.visibility,
      body: e.body,
      meta: parseJson(e.meta, null),
    })),
  };
}

const TICKET_COLUMNS = `
  id, version, schema_version, created_at, updated_at, project, category, issue_type,
  subject, description, priority, status, requester_name, requester_email,
  requester_email_hash, account_id, platform, app_version, assignee, tags,
  routing_human_only, routing_reason, source_channel, source_ip`;

/** The values for those columns, in the same order. */
const ticketValues = (ticket, version, hash) => [
  ticket.id,
  version,
  ticket.schemaVersion ?? 2,
  ticket.createdAt,
  ticket.updatedAt,
  ticket.project,
  ticket.category,
  ticket.issueType,
  ticket.subject,
  ticket.description,
  ticket.priority,
  ticket.status,
  ticket.requester?.name ?? null,
  ticket.requester?.email ?? '',
  hash,
  ticket.accountId ?? null,
  ticket.environment?.platform ?? null,
  ticket.environment?.appVersion ?? null,
  ticket.assignee ?? null,
  JSON.stringify(ticket.tags ?? []),
  ticket.routing?.humanOnly ? 1 : 0,
  ticket.routing?.reason ?? null,
  ticket.source?.channel ?? 'web',
  ticket.source?.ip ?? null,
];

/**
 * Appending an event, with the database choosing its position.
 *
 * `seq` is deliberately NOT computed in JavaScript. Two writers that each read "the history is
 * 4 long" would both write event 4 and one would lose to the primary key; computed inside the
 * statement, each insert takes the next free position at the moment it executes, so concurrent
 * appends queue behind each other instead of colliding.
 */
const APPEND_EVENT = `
  INSERT INTO ticket_events (ticket_id, seq, id, at, type, actor_kind, actor_name, visibility, body, meta)
  SELECT ?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM ticket_events WHERE ticket_id = ?), ?, ?, ?, ?, ?, ?, ?, ?`;

const eventValues = (ticketId, event) => [
  ticketId,
  ticketId,
  event.id,
  event.at,
  event.type,
  event.actor?.kind ?? 'user',
  event.actor?.name ?? null,
  event.visibility ?? 'public',
  event.body ?? null,
  event.meta === null || event.meta === undefined ? null : JSON.stringify(event.meta),
];

const isUniqueViolation = (error) => /UNIQUE constraint failed/i.test(String(error?.message ?? ''));

export function createD1TicketStore({ db, retries = 5 }) {
  /* Assembling a document is three reads, sent as one batch so it costs one round trip
     rather than three. Ordering by `seq` is what makes the history a history. */
  const readStatements = (id) => [
    db.prepare(`SELECT ${TICKET_COLUMNS} FROM tickets WHERE id = ?`).bind(id),
    db.prepare('SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY seq ASC').bind(id),
    db.prepare('SELECT * FROM ticket_attachments WHERE ticket_id = ? ORDER BY position ASC').bind(id),
  ];

  /** The document plus the version it was read at. Internal; `version` never leaves this file. */
  async function readWithVersion(id) {
    const [ticket, events, attachments] = await db.batch(readStatements(id));
    const row = ticket.results[0];
    if (!row) return null;
    return { version: row.version, doc: toDocument(row, events.results, attachments.results) };
  }

  /** Load events and attachments for a page of tickets in two queries rather than 2N. */
  async function hydrate(rows) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const holes = ids.map(() => '?').join(', ');
    const [events, attachments] = await db.batch([
      db
        .prepare(`SELECT * FROM ticket_events WHERE ticket_id IN (${holes}) ORDER BY ticket_id, seq ASC`)
        .bind(...ids),
      db
        .prepare(
          `SELECT * FROM ticket_attachments WHERE ticket_id IN (${holes}) ORDER BY ticket_id, position ASC`,
        )
        .bind(...ids),
    ]);

    const grouped = (results) => {
      const out = new Map(ids.map((id) => [id, []]));
      for (const row of results) out.get(row.ticket_id)?.push(row);
      return out;
    };
    const eventsBy = grouped(events.results);
    const attachmentsBy = grouped(attachments.results);

    return rows.map((row) => toDocument(row, eventsBy.get(row.id) ?? [], attachmentsBy.get(row.id) ?? []));
  }

  return {
    /**
     * There is nothing to load: the database is the index. The count is read once so the boot
     * line still says how many tickets exist, which is the only reason this returns a shape at
     * all. `broken` is always 0 -- a document that will not parse is a JSON-file failure mode,
     * and D1 has its own.
     */
    async init() {
      const loaded = await db.prepare('SELECT COUNT(*) AS n FROM tickets').first('n');
      return { loaded: Number(loaded ?? 0), broken: 0 };
    },

    async has(id) {
      return Boolean(await db.prepare('SELECT 1 AS ok FROM tickets WHERE id = ?').bind(id).first('ok'));
    },

    /**
     * Insert a new ticket with its history and attachments, as one transaction. Rejects rather
     * than overwriting an existing id -- enforced by the primary key, not by a prior read, so
     * two simultaneous creates of one id cannot both believe they are first.
     */
    async create(ticket) {
      const hash = await emailHash(ticket.requester?.email);
      const holes = ticketValues(ticket, 1, hash).map(() => '?').join(', ');

      const statements = [
        db
          .prepare(`INSERT INTO tickets (${TICKET_COLUMNS}) VALUES (${holes})`)
          .bind(...ticketValues(ticket, 1, hash)),
        ...(ticket.events ?? []).map((event) =>
          db.prepare(APPEND_EVENT).bind(...eventValues(ticket.id, event)),
        ),
        ...(ticket.attachments ?? []).map((attachment, position) =>
          db
            .prepare(
              `INSERT INTO ticket_attachments
                 (ticket_id, id, position, filename, declared_type, size, uploaded_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              ticket.id,
              attachment.id,
              position,
              attachment.filename,
              attachment.declaredType ?? null,
              attachment.size,
              attachment.uploadedAt,
            ),
        ),
      ];

      try {
        await db.batch(statements);
      } catch (error) {
        if (isUniqueViolation(error)) throw new Error(`Ticket ${ticket.id} already exists.`);
        throw error;
      }
      return ticket;
    },

    async get(id) {
      const found = await readWithVersion(id);
      return found ? found.doc : null;
    },

    /**
     * Read-modify-write, checked rather than locked. See the header for the mutator contract.
     *
     * `mutate` may run more than once. Each attempt reads the current version, builds the
     * whole batch guarded by it, and asks the database whether that version is still current;
     * a `changes: 0` on the final statement means somebody else committed in between and the
     * attempt is discarded whole -- nothing partial can have landed, because every statement
     * carries the same guard.
     */
    async update(id, mutate) {
      for (let attempt = 0; attempt < retries; attempt += 1) {
        const found = await readWithVersion(id);
        if (!found) return null;

        const { version, doc } = found;
        const next = await mutate(structuredClone(doc));
        if (!next) return null;

        const before = doc.events ?? [];
        const after = next.events ?? [];

        /* The history is append-only, and this is where that stops being a convention.
           Only events beyond the ones already stored are written, so an edit to an earlier one
           would not reach the database at all — it would be dropped in silence while the
           document handed back to the caller showed the edit as applied. Comparing the whole
           event rather than its id is what turns that into an error somebody can act on. */
        if (after.length < before.length) {
          throw new Error(`update(${id}) removed events; a ticket history is append-only.`);
        }
        for (let i = 0; i < before.length; i += 1) {
          const was = JSON.stringify(eventValues(id, before[i]));
          const now = after[i] === undefined ? null : JSON.stringify(eventValues(id, after[i]));
          if (was !== now) {
            throw new Error(`update(${id}) rewrote event ${i}; a ticket history is append-only.`);
          }
        }

        const appended = after.slice(before.length);
        const hash = await emailHash(next.requester?.email);

        /* ── Is this a fact, or a decision? ────────────────────────────────────────────────
         *
         * A mutation that only appended history is a FACT: a reply happened, a note was
         * written. It cannot be invalidated by whatever else committed in the meantime, so it
         * is not guarded, does not bump the version, and can never lose a race or be retried
         * -- which is what keeps a busy ticket from starving its own reporter's reply.
         *
         * A mutation that changed anything else is a DECISION: a status transition validated
         * against the status it read, an assignment, an edit. That must not be applied on top
         * of state it never saw, so it carries the version and fails if it has moved.
         *
         * The comparison is over the column values rather than the objects, so it does not
         * depend on a mutator preserving key order, and `updated_at` is excluded because
         * every write touches it.
         */
        const columns = (docToCompare, docHash) =>
          JSON.stringify(ticketValues(docToCompare, 0, docHash).filter((_, i) => i !== 4));
        const attachmentsChanged =
          JSON.stringify(next.attachments ?? []) !== JSON.stringify(doc.attachments ?? []);
        const isPureAppend =
          !attachmentsChanged && columns(next, hash) === columns(doc, await emailHash(doc.requester?.email));

        if (isPureAppend) {
          if (!appended.length) return next; // the mutator changed nothing at all
          await db.batch([
            ...appended.map((event) => db.prepare(APPEND_EVENT).bind(...eventValues(id, event))),
            db
              .prepare('UPDATE tickets SET updated_at = ? WHERE id = ?')
              .bind(next.updatedAt ?? new Date().toISOString(), id),
          ]);
          return next;
        }

        const guarded = (sql, values) => db.prepare(sql).bind(...values, id, version);

        const statements = [
          /* Guarded inserts first, the version bump last: reversed, the bump would invalidate
             every guard behind it and the inserts would all quietly write nothing. */
          ...appended.map((event) =>
            guarded(`${APPEND_EVENT}\n  WHERE (SELECT version FROM tickets WHERE id = ?) = ?`, eventValues(id, event)),
          ),
        ];

        /* Attachments are written at creation and not touched by any current mutator, so this
           only runs if one starts to. Replacing the set is correct and rare; doing it under
           the same guard keeps the attempt all-or-nothing. */
        if (attachmentsChanged) {
          statements.push(
            guarded(
              `DELETE FROM ticket_attachments
               WHERE ticket_id = ? AND (SELECT version FROM tickets WHERE id = ?) = ?`,
              [id],
            ),
            ...(next.attachments ?? []).map((attachment, position) =>
              guarded(
                `INSERT INTO ticket_attachments
                   (ticket_id, id, position, filename, declared_type, size, uploaded_at)
                 SELECT ?, ?, ?, ?, ?, ?, ?
                 WHERE (SELECT version FROM tickets WHERE id = ?) = ?`,
                [
                  id,
                  attachment.id,
                  position,
                  attachment.filename,
                  attachment.declaredType ?? null,
                  attachment.size,
                  attachment.uploadedAt,
                ],
              ),
            ),
          );
        }

        statements.push(
          db
            .prepare(
              `UPDATE tickets SET
                 version = version + 1,
                 schema_version = ?, created_at = ?, updated_at = ?,
                 project = ?, category = ?, issue_type = ?,
                 subject = ?, description = ?, priority = ?, status = ?,
                 requester_name = ?, requester_email = ?, requester_email_hash = ?,
                 account_id = ?, platform = ?, app_version = ?,
                 assignee = ?, tags = ?, routing_human_only = ?, routing_reason = ?,
                 source_channel = ?, source_ip = ?
               WHERE id = ? AND version = ?`,
            )
            /* `slice(2)` drops `id` and `version`: the first is the key this matches on and
               the second is bumped by the statement itself, so neither is in the SET list. */
            .bind(...ticketValues(next, 0, hash).slice(2), id, version),
        );

        const results = await db.batch(statements);
        // The version bump is the last statement, and it is the one that says who won.
        if (results.at(-1).meta.changes === 1) return next;
      }

      /* Every attempt lost. Under the JSON store this could not happen -- writers queued -- so
         a caller has never had to render it. Failing loudly is the only honest option: the
         alternative is telling somebody their reply was filed when it was not. */
      throw new Error(
        `update(${id}) could not commit after ${retries} attempts; the ticket is being written to concurrently.`,
      );
    },

    /**
     * Filtered list, newest first. Every filter is exact-match and indexed; there is no
     * free-text search in this version, and pretending otherwise would be worse than not
     * offering it.
     */
    async list({ email, accountId, project, status, limit = 50, offset = 0 } = {}) {
      const where = [];
      const values = [];

      if (email) {
        where.push('requester_email_hash = ?');
        values.push(await emailHash(email));
      }
      // Exact match on an opaque id; a guest ticket has account_id NULL and can never match.
      if (accountId) {
        where.push('account_id = ?');
        values.push(accountId);
      }
      if (project) {
        where.push('project = ?');
        values.push(project);
      }
      if (status) {
        where.push('status = ?');
        values.push(status);
      }

      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const [counted, page] = await db.batch([
        db.prepare(`SELECT COUNT(*) AS n FROM tickets ${clause}`).bind(...values),
        db
          .prepare(
            `SELECT ${TICKET_COLUMNS} FROM tickets ${clause}
             ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
          )
          .bind(...values, limit, offset),
      ]);

      return { total: Number(counted.results[0]?.n ?? 0), tickets: await hydrate(page.results) };
    },

    /** Counts by status, for an operational view. Derived on read; never stored. */
    async counts() {
      const { results } = await db.prepare('SELECT status, COUNT(*) AS n FROM tickets GROUP BY status').all();
      const byStatus = {};
      let total = 0;
      for (const row of results) {
        byStatus[row.status] = Number(row.n);
        total += Number(row.n);
      }
      return { total, byStatus };
    },
  };
}
