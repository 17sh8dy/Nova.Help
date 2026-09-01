/**
 * The ticket store — one JSON document per ticket under var/tickets/.
 *
 * THIS IS THE SEAM. Everything above it (server/core/tickets.mjs) talks to the six methods at
 * the bottom of this file and knows nothing else about storage. Moving to Postgres means
 * writing a module with the same six methods; no page, route or service changes.
 *
 * Why JSON files for the first version: a support queue starts empty and grows slowly, the
 * whole corpus is trivially inspectable while the product is young, and a ticket that exists
 * on disk survives every mistake this codebase can make. The cost is that the entire index is
 * held in memory — at the volume one studio's support queue reaches before it earns a real
 * database, that is a few megabytes.
 *
 * Two correctness properties are load-bearing:
 *
 * 1. WRITES ARE ATOMIC. Every save is written to a temp file and renamed over the target, so
 *    a crash mid-write leaves the previous document intact rather than a truncated one.
 *
 * 2. UPDATES ARE SERIALISED PER TICKET. `update()` takes a mutator and runs it inside a
 *    per-id promise chain, so two replies arriving together cannot read-modify-write over
 *    each other and lose an event.
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';

/** Constant-time comparison of two email addresses, so the lookup form is not an oracle. */
export function sameEmail(a, b) {
  const ha = createHash('sha256').update(String(a ?? '').trim().toLowerCase()).digest();
  const hb = createHash('sha256').update(String(b ?? '').trim().toLowerCase()).digest();
  return timingSafeEqual(ha, hb);
}

export function createFileStore({ dir }) {
  const ticketsDir = path.join(dir, 'tickets');
  const tickets = new Map(); // id -> ticket document
  const locks = new Map(); // id -> promise chain tail
  let ready = null;

  const fileFor = (id) => path.join(ticketsDir, `${id}.json`);

  async function persist(ticket) {
    const target = fileFor(ticket.id);
    /* A random suffix rather than the pid. Every write to one ticket is serialised by the lock
       below, so sharing a scratch path is currently safe here — but the atomicity promise at
       the top of this file should not depend on a caller elsewhere holding the right lock. */
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(ticket, null, 2), 'utf8');
    try {
      await rename(temp, target);
    } catch (err) {
      await unlink(temp).catch(() => {});
      throw err;
    }
  }

  /** Serialise work per ticket id. Returns whatever `fn` returns. */
  function withLock(id, fn) {
    const previous = locks.get(id) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    // Keep the chain alive but never let a rejection poison the next waiter.
    locks.set(
      id,
      next.then(
        () => {},
        () => {},
      ),
    );
    return next;
  }

  async function load() {
    await mkdir(ticketsDir, { recursive: true });
    const entries = await readdir(ticketsDir);
    let broken = 0;
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      try {
        const doc = JSON.parse(await readFile(path.join(ticketsDir, entry), 'utf8'));
        if (doc?.id) tickets.set(doc.id, doc);
      } catch {
        // A single unreadable document must not stop the portal from opening. It stays on
        // disk untouched so it can be recovered by hand.
        broken += 1;
      }
    }
    return { loaded: tickets.size, broken };
  }

  return {
    /** Read every document into memory. Safe to call more than once. */
    async init() {
      if (!ready) ready = load();
      return ready;
    },

    /** True when no ticket with this id exists. Used by id generation. */
    async has(id) {
      return tickets.has(id);
    },

    /** Insert a new document. Rejects rather than overwriting an existing id. */
    async create(ticket) {
      return withLock(ticket.id, async () => {
        if (tickets.has(ticket.id)) throw new Error(`Ticket ${ticket.id} already exists.`);
        await persist(ticket);
        tickets.set(ticket.id, ticket);
        return ticket;
      });
    },

    /** A deep copy, so nothing above the store can mutate the in-memory document by accident. */
    async get(id) {
      const found = tickets.get(id);
      return found ? structuredClone(found) : null;
    },

    /**
     * Read-modify-write under the per-id lock. `mutate` receives a copy and returns the new
     * document; returning a falsy value aborts the update and leaves the store untouched.
     */
    async update(id, mutate) {
      return withLock(id, async () => {
        const current = tickets.get(id);
        if (!current) return null;
        const next = await mutate(structuredClone(current));
        if (!next) return null;
        await persist(next);
        tickets.set(id, next);
        return structuredClone(next);
      });
    },

    /**
     * Filtered list, newest first. Filters are exact-match; there is no free-text search in
     * this version, and pretending otherwise would be worse than not offering it.
     */
    async list({ email, accountId, project, status, limit = 50, offset = 0 } = {}) {
      let rows = [...tickets.values()];
      if (email) rows = rows.filter((t) => sameEmail(t.requester?.email, email));
      // Exact match on an opaque id; a guest ticket has `accountId` null and can never match.
      if (accountId) rows = rows.filter((t) => t.accountId === accountId);
      if (project) rows = rows.filter((t) => t.project === project);
      if (status) rows = rows.filter((t) => t.status === status);
      /* Newest first, with the id breaking ties. Without the tiebreaker two tickets filed in
         the same millisecond order by whatever `readdir` returned at boot, so `offset` paging
         could skip one and repeat another — and differently before and after a restart. */
      rows.sort(
        (a, b) =>
          String(b.createdAt).localeCompare(String(a.createdAt)) || String(b.id).localeCompare(String(a.id)),
      );
      return {
        total: rows.length,
        tickets: rows.slice(offset, offset + limit).map((t) => structuredClone(t)),
      };
    },

    /** Counts by status, for an operational view. Derived on read; never stored. */
    async counts() {
      const out = {};
      for (const t of tickets.values()) out[t.status] = (out[t.status] ?? 0) + 1;
      return { total: tickets.size, byStatus: out };
    },
  };
}
