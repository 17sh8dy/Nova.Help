/**
 * Concurrency regression tests for the two stores.
 *
 * These exist because both stores make a written promise at the top of their file — writes are
 * atomic, updates are serialised — and one of them was not keeping it. The account store held
 * three DIFFERENT locks over the same document (`email:`, `id:` and `identity:`), so two
 * writers in different domains could interleave, and both wrote through the same temp filename
 * while doing it.
 *
 * Every test here drives the store the way two overlapping HTTP requests would: start both
 * without awaiting the first, then await them together. That is the only shape that catches
 * this class of bug, because each one needs a real `await` inside the critical section to
 * open the window.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createAccountStore } from '@nova/accounts/store';
import { createFileStore } from '../server/store/fileStore.mjs';

async function accountStore(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'novaconc-'));
  const store = createAccountStore({ dir });
  await store.init();
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, store };
}

async function ticketStore(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'novaconc-t-'));
  const store = createFileStore({ dir });
  await store.init();
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, store };
}

const anAccount = (overrides = {}) => ({
  id: 'acct_test_0001',
  schemaVersion: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  email: 'ann@example.com',
  emailVerified: false,
  displayName: 'Ann',
  password: 'scrypt$N=1024,r=8,p=1$c2FsdA$aGFzaA',
  status: 'active',
  sessions: [],
  identities: [],
  products: {},
  ...overrides,
});

const anIdentity = (overrides = {}) => ({
  provider: 'google',
  subject: '11223344',
  email: 'ann@example.com',
  emailVerified: true,
  linkedAt: '2026-01-02T00:00:00.000Z',
  ...overrides,
});

/* ── The lost-link race ─────────────────────────────────────────────────────────────────── */

test('linking a provider while another request writes the same account keeps both changes', async (t) => {
  const { store } = await accountStore(t);
  await store.create(anAccount());

  /* The exact shape of the bug: `claimIdentity` locked on `identity:google:11223344` and
     `update` locked on `id:acct_test_0001`, so nothing serialised them against each other.
     Both read the same pre-link document and the last write won. */
  const [claimed, updated] = await Promise.all([
    store.claimIdentity('acct_test_0001', anIdentity()),
    store.update('acct_test_0001', (doc) => {
      doc.sessions = [...doc.sessions, { id: 'sess_1', expiresAt: '2099-01-01T00:00:00.000Z' }];
      return doc;
    }),
  ]);

  assert.equal(claimed.ok, true);
  assert.ok(updated);

  const final = await store.get('acct_test_0001');
  assert.equal(final.identities.length, 1, 'the Google link survived');
  assert.equal(final.sessions.length, 1, 'the session survived');
});

test('the identity index never claims a link the document does not have', async (t) => {
  const { dir, store } = await accountStore(t);
  await store.create(anAccount());

  await Promise.all([
    store.claimIdentity('acct_test_0001', anIdentity()),
    store.update('acct_test_0001', (doc) => {
      doc.sessions = [{ id: 'sess_1', expiresAt: '2099-01-01T00:00:00.000Z' }];
      return doc;
    }),
  ]);

  /* The index and the document have to agree, in memory AND on disk — a divergence here
     survives until the next restart and then silently unlinks the person's provider. */
  const viaIndex = await store.getByIdentity('google', '11223344');
  const onDisk = JSON.parse(await readFile(path.join(dir, 'accounts', 'acct_test_0001.json'), 'utf8'));

  if (viaIndex) {
    assert.equal(viaIndex.id, 'acct_test_0001');
    assert.equal(onDisk.identities.length, 1, 'the index says linked, so the document must be too');
  }
  assert.equal(
    Boolean(viaIndex),
    onDisk.identities.length === 1,
    'the identity index and the stored document must agree',
  );
});

test('two writers in different lock domains cannot tear a document on disk', async (t) => {
  const { dir, store } = await accountStore(t);
  await store.create(anAccount());

  /* Both stores wrote to `${target}.${process.pid}.tmp`. Two concurrent writers to one id
     therefore shared a temp path: one writeFile could interleave with the other before either
     rename, leaving a file that parses as neither document. */
  await Promise.all([
    store.claimIdentity('acct_test_0001', anIdentity()),
    store.update('acct_test_0001', (doc) => {
      doc.displayName = 'Ann'.padEnd(4000, '!');
      return doc;
    }),
    store.releaseIdentity('acct_test_0001', 'nonexistent-provider'),
  ]);

  const raw = await readFile(path.join(dir, 'accounts', 'acct_test_0001.json'), 'utf8');
  const parsed = JSON.parse(raw); // throws if the write was torn
  assert.equal(parsed.id, 'acct_test_0001');

  const leftovers = (await readdir(path.join(dir, 'accounts'))).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, [], 'no temp files left behind');
});

test('concurrent sign-ins on one account all end up on the account', async (t) => {
  const { store } = await accountStore(t);
  await store.create(anAccount());

  const opens = Array.from({ length: 8 }, (_, i) =>
    store.update('acct_test_0001', (doc) => {
      doc.sessions = [...doc.sessions, { id: `sess_${i}`, expiresAt: '2099-01-01T00:00:00.000Z' }];
      return doc;
    }),
  );
  await Promise.all(opens);

  const final = await store.get('acct_test_0001');
  assert.equal(final.sessions.length, 8, 'no sign-in was lost');
});

test('a sign-out concurrent with a sign-in does not resurrect the closed session', async (t) => {
  const { store } = await accountStore(t);
  await store.create(anAccount({ sessions: [{ id: 'old', expiresAt: '2099-01-01T00:00:00.000Z' }] }));

  await Promise.all([
    store.update('acct_test_0001', (doc) => {
      doc.sessions = doc.sessions.filter((s) => s.id !== 'old');
      return doc;
    }),
    store.update('acct_test_0001', (doc) => {
      doc.sessions = [...doc.sessions, { id: 'new', expiresAt: '2099-01-01T00:00:00.000Z' }];
      return doc;
    }),
  ]);

  const final = await store.get('acct_test_0001');
  assert.equal(
    final.sessions.some((s) => s.id === 'old'),
    false,
    'the revoked session stayed revoked',
  );
});

/* ── Uniqueness under load ─────────────────────────────────────────────────────────────── */

test('two simultaneous sign-ups for one address produce exactly one account', async (t) => {
  const { store } = await accountStore(t);

  const results = await Promise.all([
    store.create(anAccount({ id: 'acct_a' })),
    store.create(anAccount({ id: 'acct_b' })),
  ]);

  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => r.reason === 'email-taken').length, 1);
  assert.equal(await store.count(), 1);
});

test('two accounts cannot claim one provider identity by racing', async (t) => {
  const { store } = await accountStore(t);
  await store.create(anAccount({ id: 'acct_a', email: 'a@example.com' }));
  await store.create(anAccount({ id: 'acct_b', email: 'b@example.com' }));

  const results = await Promise.all([
    store.claimIdentity('acct_a', anIdentity()),
    store.claimIdentity('acct_b', anIdentity()),
  ]);

  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => r.reason === 'identity-taken').length, 1);

  const holder = await store.getByIdentity('google', '11223344');
  const a = await store.get('acct_a');
  const b = await store.get('acct_b');
  assert.equal(a.identities.length + b.identities.length, 1, 'exactly one document holds it');
  assert.equal(holder.identities.length, 1);
});

/* ── The ticket store, which already held this line ─────────────────────────────────────── */

test('concurrent replies to one ticket all land', async (t) => {
  const { store } = await ticketStore(t);
  await store.create({ id: 'NH-TEST-0001', status: 'open', createdAt: '2026-01-01T00:00:00.000Z', events: [] });

  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      store.update('NH-TEST-0001', (doc) => {
        doc.events.push({ id: `evt_${i}`, type: 'reply' });
        return doc;
      }),
    ),
  );

  const final = await store.get('NH-TEST-0001');
  assert.equal(final.events.length, 10, 'no reply was lost');
});

test('a ticket document is never left torn or shadowed by a temp file', async (t) => {
  const { dir, store } = await ticketStore(t);
  await store.create({ id: 'NH-TEST-0002', status: 'open', createdAt: '2026-01-01T00:00:00.000Z', events: [] });

  await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      store.update('NH-TEST-0002', (doc) => {
        doc.events.push({ id: `evt_${i}`, body: 'x'.repeat(2000) });
        return doc;
      }),
    ),
  );

  const raw = await readFile(path.join(dir, 'tickets', 'NH-TEST-0002.json'), 'utf8');
  assert.equal(JSON.parse(raw).events.length, 6);
  assert.deepEqual(
    (await readdir(path.join(dir, 'tickets'))).filter((f) => f.includes('.tmp')),
    [],
  );
});
