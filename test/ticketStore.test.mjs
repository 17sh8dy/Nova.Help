/**
 * Every ticket store, held to the same contract.
 *
 * The contract itself is in helpers/ticketStoreContract.mjs. This file only says which
 * implementations exist and how to stand each one up; adding a third backend later should be
 * three lines here and no new assertions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createFileStore } from '../server/store/fileStore.mjs';
import { createD1TicketStore } from '../server/store/d1Store.mjs';
import { createSqliteD1 } from '../server/store/sqliteD1.mjs';
import { applyTicketSchema } from '../server/store/migrate.mjs';
import { aTicket, describeTicketStore } from './helpers/ticketStoreContract.mjs';

describeTicketStore('fileStore', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'novahelp-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const open = async () => {
    const store = createFileStore({ dir });
    await store.init();
    return store;
  };

  const store = await open();
  /* The contract uses this to prove a write reached storage rather than only memory. */
  store.reopen = open;
  return store;
});

describeTicketStore('d1Store', async (t) => {
  /* A file rather than :memory: so `reopen` can prove a write actually reached storage — an
     in-memory database would hand back the same pages and prove nothing. */
  const dir = await mkdtemp(path.join(tmpdir(), 'novahelp-d1-'));
  const file = path.join(dir, 'nova.sqlite');
  const handles = [];
  t.after(async () => {
    for (const handle of handles) handle.close();
    await rm(dir, { recursive: true, force: true });
  });

  const open = async () => {
    const db = createSqliteD1({ path: file });
    handles.push(db);
    await applyTicketSchema(db);
    const store = createD1TicketStore({ db });
    await store.init();
    return store;
  };

  const store = await open();
  store.reopen = open;
  return store;
});

/* ── Behaviour specific to D1 ───────────────────────────────────────────────────────────── */

/** A D1 store over a fresh in-memory database. */
async function d1(t) {
  const db = createSqliteD1();
  t.after(() => db.close());
  await applyTicketSchema(db);
  const store = createD1TicketStore({ db });
  await store.init();
  return { db, store };
}

test('[d1Store] a pure append never bumps the version, so it cannot lose a race', async (t) => {
  const { db, store } = await d1(t);
  await store.create(aTicket({ id: 'NH-D1-0001' }));

  const version = () => db.prepare('SELECT version FROM tickets WHERE id = ?').bind('NH-D1-0001').first('version');
  assert.equal(await version(), 1);

  await store.update('NH-D1-0001', (doc) => {
    doc.events.push({ id: 'evt_reply', at: '2026-02-01T00:00:00.000Z', type: 'reply', actor: { kind: 'user', name: null }, visibility: 'public', body: 'hello', meta: null });
    doc.updatedAt = '2026-02-01T00:00:00.000Z';
    return doc;
  });
  assert.equal(await version(), 1, 'appending history is a fact, not a decision');

  await store.update('NH-D1-0001', (doc) => {
    doc.status = 'in_progress';
    return doc;
  });
  assert.equal(await version(), 2, 'changing decidable state does bump it');
});

test('[d1Store] a decision made against a stale version is retried, not applied', async (t) => {
  const { db, store } = await d1(t);
  await store.create(aTicket({ id: 'NH-D1-0002' }));

  let attempts = 0;
  const seen = [];
  await store.update('NH-D1-0002', (doc) => {
    attempts += 1;
    seen.push(doc.status);
    /* Commit a competing change from underneath, exactly once, after this mutator has already
       read the document — the shape of two staff consoles moving one ticket at the same time. */
    if (attempts === 1) {
      db.raw ??= null;
      return (async () => {
        await db
          .prepare('UPDATE tickets SET status = ?, version = version + 1 WHERE id = ?')
          .bind('waiting_user', 'NH-D1-0002')
          .run();
        doc.status = 'resolved';
        return doc;
      })();
    }
    doc.status = 'resolved';
    return doc;
  });

  assert.equal(attempts, 2, 'the losing attempt was discarded and re-run');
  assert.deepEqual(seen, ['open', 'waiting_user'], 'the second attempt saw the committed state');
  assert.equal((await store.get('NH-D1-0002')).status, 'resolved');
});

test('[d1Store] a discarded attempt leaves nothing behind, not even its events', async (t) => {
  const { db, store } = await d1(t);
  await store.create(aTicket({ id: 'NH-D1-0003' }));

  let attempts = 0;
  await store.update('NH-D1-0003', (doc) => {
    attempts += 1;
    const attempt = attempts;
    doc.events.push({ id: `evt_attempt_${attempt}`, at: '2026-02-01T00:00:00.000Z', type: 'status_changed', actor: { kind: 'staff', name: null }, visibility: 'public', body: null, meta: null });
    doc.status = 'in_progress';
    if (attempt === 1) {
      return (async () => {
        await db.prepare('UPDATE tickets SET version = version + 1 WHERE id = ?').bind('NH-D1-0003').run();
        return doc;
      })();
    }
    return doc;
  });

  const events = await db
    .prepare('SELECT id FROM ticket_events WHERE ticket_id = ? ORDER BY seq')
    .bind('NH-D1-0003')
    .all();
  assert.deepEqual(
    events.results.map((r) => r.id).filter((id) => id.startsWith('evt_attempt')),
    ['evt_attempt_2'],
    'the losing attempt inserted no event',
  );
});

test('[d1Store] rewriting history is refused rather than silently accepted', async (t) => {
  const { store } = await d1(t);
  await store.create(aTicket({ id: 'NH-D1-0004' }));

  await assert.rejects(
    () =>
      store.update('NH-D1-0004', (doc) => {
        doc.events[0].body = 'not what they wrote';
        doc.events.push({ id: 'evt_x', at: '2026-02-01T00:00:00.000Z', type: 'reply', actor: { kind: 'user', name: null }, visibility: 'public', body: 'x', meta: null });
        return doc;
      }),
    /append-only/,
  );

  await assert.rejects(
    () =>
      store.update('NH-D1-0004', (doc) => {
        doc.events = [];
        return doc;
      }),
    /append-only/,
  );
});

test('[d1Store] a write that can never win fails loudly instead of reporting success', async (t) => {
  const { db, store } = await d1(t);
  await store.create(aTicket({ id: 'NH-D1-0005' }));

  await assert.rejects(
    () =>
      store.update('NH-D1-0005', (doc) => {
        doc.status = 'in_progress';
        // Move the version on every single attempt, so no attempt can ever commit.
        return (async () => {
          await db.prepare('UPDATE tickets SET version = version + 1 WHERE id = ?').bind('NH-D1-0005').run();
          return doc;
        })();
      }),
    /could not commit after 5 attempts/,
  );

  assert.equal((await store.get('NH-D1-0005')).status, 'open', 'and changed nothing');
});

test('[d1Store] deleting a ticket takes its events and attachments with it', async (t) => {
  const { db, store } = await d1(t);
  await store.create(
    aTicket({
      id: 'NH-D1-0006',
      attachments: [{ id: 'att_1', filename: 'a.png', declaredType: null, size: 1, uploadedAt: '2026-01-01T00:00:00.000Z' }],
    }),
  );

  await db.prepare('DELETE FROM tickets WHERE id = ?').bind('NH-D1-0006').run();
  const events = await db.prepare('SELECT COUNT(*) AS n FROM ticket_events WHERE ticket_id = ?').bind('NH-D1-0006').first('n');
  const attachments = await db.prepare('SELECT COUNT(*) AS n FROM ticket_attachments WHERE ticket_id = ?').bind('NH-D1-0006').first('n');
  assert.equal(events, 0, 'foreign keys are on, as they are in D1');
  assert.equal(attachments, 0);
});

test('[d1Store] an address is indexed by digest, never in the clear', async (t) => {
  const { db, store } = await d1(t);
  await store.create(aTicket({ id: 'NH-D1-0007', requester: { name: 'Ann', email: 'Ann@Example.COM' } }));

  const row = await db.prepare('SELECT requester_email, requester_email_hash FROM tickets WHERE id = ?').bind('NH-D1-0007').first();
  assert.match(row.requester_email_hash, /^[0-9a-f]{64}$/);
  assert.equal(row.requester_email_hash.includes('example'), false);
  assert.equal(row.requester_email, 'Ann@Example.COM', 'what they typed is kept for display');
  assert.equal((await store.list({ email: 'ann@example.com' })).total, 1, 'and the digest still finds it');
});

/* ── Behaviour specific to the JSON files ───────────────────────────────────────────────── */

test('[fileStore] one unreadable document does not stop the store opening', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'novahelp-broken-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const store = createFileStore({ dir });
  await store.init();
  await store.create({ id: 'NH-OK-0001', status: 'open', createdAt: '2026-01-01T00:00:00.000Z', events: [] });

  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(dir, 'tickets', 'NH-BAD-0001.json'), '{ not json', 'utf8');

  const reopened = createFileStore({ dir });
  const { loaded, broken } = await reopened.init();
  assert.equal(loaded, 1);
  assert.equal(broken, 1);
  assert.equal((await reopened.get('NH-OK-0001')).status, 'open');
});
