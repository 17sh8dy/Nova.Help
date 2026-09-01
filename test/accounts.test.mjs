/**
 * Unit tests for Nova Accounts.
 *
 * These cover the parts that decide who somebody is, which is the one place in this codebase
 * where being wrong is not a bug report but an incident: how a password is stored, whether a
 * failed sign-in tells a stranger anything, and whether signing out actually ends a session
 * rather than merely hiding the cookie.
 *
 * Most of them run with a deliberately cheap scrypt setting, because the suite would otherwise
 * spend minutes proving arithmetic. The production cost is exercised on its own, once.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createAccounts, deriveSessionSecret, publicView, DEFAULT_COST } from '../server/accounts/index.mjs';
import { hashPassword, needsRehash, verifyPassword } from '../server/accounts/passwords.mjs';
import { isAccountId, newAccountId } from '../server/accounts/ids.mjs';
import { createSessionTokens } from '../server/accounts/sessions.mjs';
import { createAccountStore } from '../server/accounts/store.mjs';
import { validateRegistration, validateSignIn, normalizeEmail } from '../server/accounts/validation.mjs';

/** Cheap enough to run hundreds of times; the shape of the record is identical. */
const CHEAP = { N: 1024, r: 8, p: 1 };
const SECRET = 'a-test-signing-secret-of-sufficient-length';

const PASSWORD = 'a passphrase nobody guesses';

async function harness(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'novaacct-'));
  const accounts = await createAccounts({ dir, secret: SECRET, cost: CHEAP });
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, accounts };
}

const register = (accounts, overrides = {}) =>
  accounts.register({
    email: 'ann@example.com',
    displayName: 'Ann',
    password: PASSWORD,
    passwordConfirm: PASSWORD,
    ...overrides,
  });

/* ── Passwords ─────────────────────────────────────────────────────────────────────────── */

test('a stored password is a salted scrypt record, not the password', async () => {
  const stored = await hashPassword(PASSWORD, { cost: CHEAP });
  const [algorithm, cost, salt, hash] = stored.split('$');

  assert.equal(algorithm, 'scrypt');
  assert.equal(cost, 'N=1024,r=8,p=1');
  assert.ok(salt.length >= 20 && hash.length >= 80);
  assert.equal(stored.includes(PASSWORD), false);
  assert.equal(stored.toLowerCase().includes('passphrase'), false);
});

test('the same password hashes differently every time', async () => {
  const a = await hashPassword(PASSWORD, { cost: CHEAP });
  const b = await hashPassword(PASSWORD, { cost: CHEAP });
  assert.notEqual(a, b, 'two hashes of one password must not be equal — the salt is the point');
  assert.equal(await verifyPassword(PASSWORD, a), true);
  assert.equal(await verifyPassword(PASSWORD, b), true);
});

test('verification accepts the right password and refuses everything else', async () => {
  const stored = await hashPassword(PASSWORD, { cost: CHEAP });
  assert.equal(await verifyPassword(PASSWORD, stored), true);
  assert.equal(await verifyPassword(`${PASSWORD} `, stored), false);
  assert.equal(await verifyPassword(PASSWORD.toUpperCase(), stored), false);
  assert.equal(await verifyPassword('', stored), false);
});

test('a malformed or unknown stored record fails closed rather than throwing', async () => {
  for (const broken of [undefined, null, '', 'not-a-record', 'bcrypt$x$y$z', 'scrypt$N=0,r=8,p=1$aa$bb', 'scrypt$$$']) {
    assert.equal(await verifyPassword(PASSWORD, broken), false, `should refuse ${JSON.stringify(broken)}`);
  }
});

test('a record cannot ask us to allocate an unbounded amount of memory', async () => {
  // N far above the ceiling decodeCost allows. It must be refused, not attempted.
  const hostile = 'scrypt$N=1073741824,r=32,p=16$aaaa$bbbb';
  assert.equal(await verifyPassword(PASSWORD, hostile), false);
});

test('needsRehash spots a hash made with weaker parameters than today', async () => {
  const weak = await hashPassword(PASSWORD, { cost: CHEAP });
  assert.equal(needsRehash(weak, { cost: DEFAULT_COST }), true);
  assert.equal(needsRehash(weak, { cost: CHEAP }), false);
  assert.equal(needsRehash('nonsense', { cost: CHEAP }), true);
});

test('the shipped default cost produces a working hash', async () => {
  // Slow on purpose — that is the feature. Run once so the default is never merely declared.
  const stored = await hashPassword(PASSWORD);
  assert.match(stored, /^scrypt\$N=131072,r=8,p=1\$/);
  assert.equal(await verifyPassword(PASSWORD, stored), true);
  assert.equal(await verifyPassword('something else entirely', stored), false);
});

/* ── Validation ────────────────────────────────────────────────────────────────────────── */

test('registration normalises the address and keeps what was typed', () => {
  const result = validateRegistration({
    email: '  Ann@Example.COM ',
    displayName: '  Ann   Example ',
    password: PASSWORD,
    passwordConfirm: PASSWORD,
  });
  assert.equal(result.ok, true);
  assert.equal(result.values.email, 'ann@example.com');
  assert.equal(result.values.displayName, 'Ann Example');
});

test('registration refuses short, obvious, and mismatched passwords', () => {
  const short = validateRegistration({ email: 'a@b.co', password: 'short', passwordConfirm: 'short' });
  assert.match(short.errors.password, /at least 10/);

  const obvious = validateRegistration({ email: 'a@b.co', password: 'password123', passwordConfirm: 'password123' });
  assert.match(obvious.errors.password, /first anybody guesses/);

  const echoed = validateRegistration({ email: 'averylongaddress@example.com', password: 'averylongaddress@example.com', passwordConfirm: 'averylongaddress@example.com' });
  assert.match(echoed.errors.password, /cannot be your email address/);

  const mismatch = validateRegistration({ email: 'a@b.co', password: PASSWORD, passwordConfirm: 'something else' });
  assert.match(mismatch.errors.passwordConfirm, /do not match/);
});

test('validation never carries the password back in its values', () => {
  const result = validateRegistration({ email: 'a@b.co', password: 'short', passwordConfirm: 'short' });
  assert.equal(Object.hasOwn(result.values, 'password'), false);
  assert.equal(JSON.stringify(result.values).includes('short'), false);

  const signIn = validateSignIn({ email: 'a@b.co', password: PASSWORD });
  assert.equal(Object.hasOwn(signIn.values, 'password'), false);
});

test('addresses compare after normalisation', () => {
  assert.equal(normalizeEmail('  Ann@Example.COM '), 'ann@example.com');
});

/* ── Ids ───────────────────────────────────────────────────────────────────────────────── */

test('account ids are recognisable, unambiguous and unique', () => {
  const seen = new Set();
  for (let i = 0; i < 5000; i += 1) {
    const id = newAccountId();
    assert.ok(isAccountId(id), `${id} should be a valid account id`);
    assert.equal(/[ILOU]/.test(id.slice(3)), false, 'the confusable letters must not appear');
    seen.add(id);
  }
  assert.equal(seen.size, 5000);
  assert.equal(isAccountId('NH-4T7K-9QW2'), false, 'a ticket id is not an account id');
});

/* ── Session tokens ────────────────────────────────────────────────────────────────────── */

test('a session token round-trips, and refuses to when it is touched', () => {
  const tokens = createSessionTokens({ secret: SECRET });
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const token = tokens.issue({ accountId: 'NA-1111-2222-3333', sessionId: 'sid-1', expiresAt });

  const claim = tokens.verify(token);
  assert.equal(claim.accountId, 'NA-1111-2222-3333');
  assert.equal(claim.sessionId, 'sid-1');

  assert.equal(tokens.verify(`${token}x`), null, 'a tampered signature must not verify');
  assert.equal(tokens.verify(token.replace('sid-1', 'sid-2')), null, 'a swapped session id must not verify');
  assert.equal(tokens.verify(token.replace('NA-1111-2222-3333', 'NA-9999-9999-9999')), null);
  assert.equal(tokens.verify('nonsense'), null);
  assert.equal(tokens.verify(undefined), null);
});

test('an expired token verifies as nothing', () => {
  const tokens = createSessionTokens({ secret: SECRET });
  const token = tokens.issue({
    accountId: 'NA-1111-2222-3333',
    sessionId: 'sid-1',
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  assert.equal(tokens.verify(token), null);
});

test('a token signed with another key is refused', () => {
  const mine = createSessionTokens({ secret: SECRET });
  const theirs = createSessionTokens({ secret: 'a-completely-different-signing-secret' });
  const token = theirs.issue({
    accountId: 'NA-1111-2222-3333',
    sessionId: 'sid-1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(mine.verify(token), null);
});

test('the session key is derived from the application secret, not equal to it', () => {
  const derived = deriveSessionSecret(SECRET);
  assert.notEqual(derived, SECRET);
  assert.equal(derived, deriveSessionSecret(SECRET), 'derivation must be stable across restarts');
  assert.notEqual(derived, deriveSessionSecret(`${SECRET}!`));
});

test('a session signer refuses to exist without a real secret', () => {
  assert.throws(() => createSessionTokens({ secret: 'short' }), /signing secret/);
  assert.throws(() => createSessionTokens({}), /signing secret/);
});

/* ── The store ─────────────────────────────────────────────────────────────────────────── */

test('one address gets one account, whatever case it is typed in', async (t) => {
  const { accounts } = await harness(t);

  assert.equal((await register(accounts)).ok, true);

  const again = await register(accounts, { email: 'ANN@Example.com' });
  assert.equal(again.ok, false);
  assert.match(again.errors.email, /already uses that address/);
  assert.equal(again.reason, 'email-taken');
});

test('two simultaneous sign-ups for one address cannot both win', async (t) => {
  const { accounts } = await harness(t);
  const both = await Promise.all([
    register(accounts, { email: 'race@example.com' }),
    register(accounts, { email: 'race@example.com' }),
  ]);
  assert.equal(both.filter((r) => r.ok).length, 1, 'exactly one sign-up may succeed');
});

test('accounts survive a restart of the store', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'novaacct-restart-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const first = await createAccounts({ dir, secret: SECRET, cost: CHEAP });
  const created = await register(first);
  assert.equal(created.ok, true);

  const second = await createAccounts({ dir, secret: SECRET, cost: CHEAP });
  assert.equal(second.loaded.loaded, 1);

  const signedIn = await second.signIn({ email: 'ann@example.com', password: PASSWORD });
  assert.equal(signedIn.ok, true);
  assert.equal(signedIn.account.id, created.account.id);
});

test('the stored file holds a hash and never the password', async (t) => {
  const { dir, accounts } = await harness(t);
  await register(accounts);

  const files = await readdir(path.join(dir, 'accounts'));
  assert.equal(files.length, 1);

  const raw = await readFile(path.join(dir, 'accounts', files[0]), 'utf8');
  assert.equal(raw.includes(PASSWORD), false, 'the plaintext password must never reach the disk');
  assert.match(raw, /"password": "scrypt\$/);
});

test('a document that will not parse does not stop the store loading', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'novaacct-broken-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const first = await createAccounts({ dir, secret: SECRET, cost: CHEAP });
  await register(first);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(dir, 'accounts', 'NA-0000-0000-0000.json'), '{ not json', 'utf8');

  const second = await createAccounts({ dir, secret: SECRET, cost: CHEAP });
  assert.equal(second.loaded.loaded, 1);
  assert.equal(second.loaded.broken, 1);
});

test('the store hands out copies, so a caller cannot edit what is stored', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'novaacct-copy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const store = createAccountStore({ dir });
  await store.init();
  await store.create({ id: 'NA-1111-2222-3333', email: 'a@b.co', password: 'scrypt$x', sessions: [] });

  const copy = await store.get('NA-1111-2222-3333');
  copy.password = 'tampered';
  copy.sessions.push({ id: 'forged' });

  const fresh = await store.get('NA-1111-2222-3333');
  assert.equal(fresh.password, 'scrypt$x');
  assert.deepEqual(fresh.sessions, []);
});

/* ── The service ───────────────────────────────────────────────────────────────────────── */

test('nothing the service returns carries a password or a session list', async (t) => {
  const { accounts } = await harness(t);

  const created = await register(accounts);
  const started = await accounts.startSession(created.account.id);
  const fetched = await accounts.get(created.account.id);

  for (const [label, value] of [
    ['register', created.account],
    ['startSession', started.account],
    ['get', fetched],
    ['publicView', publicView({ id: 'x', email: 'a@b.co', password: 'scrypt$secret', sessions: [{ id: 's' }] })],
  ]) {
    const json = JSON.stringify(value);
    assert.equal(Object.hasOwn(value, 'password'), false, `${label} must not expose a password`);
    assert.equal(Object.hasOwn(value, 'sessions'), false, `${label} must not expose sessions`);
    assert.equal(json.includes('scrypt'), false, `${label} leaked a hash`);
  }
});

test('every way a sign-in can fail gives the same answer', async (t) => {
  const { accounts } = await harness(t);
  await register(accounts);

  const wrongPassword = await accounts.signIn({ email: 'ann@example.com', password: 'not the password' });
  const noSuchAccount = await accounts.signIn({ email: 'nobody@example.com', password: 'not the password' });

  assert.equal(wrongPassword.ok, false);
  assert.equal(noSuchAccount.ok, false);
  assert.equal(wrongPassword.reason, 'invalid');
  assert.equal(noSuchAccount.reason, 'invalid');
  assert.deepEqual(Object.keys(wrongPassword), Object.keys(noSuchAccount));
});

test('a disabled account cannot sign in or start a session', async (t) => {
  const { accounts } = await harness(t);
  const created = await register(accounts);

  await accounts.store.update(created.account.id, (doc) => {
    doc.status = 'disabled';
    return doc;
  });

  const attempt = await accounts.signIn({ email: 'ann@example.com', password: PASSWORD });
  assert.equal(attempt.ok, false);
  assert.equal(attempt.reason, 'invalid', 'a disabled account must look exactly like a wrong password');

  const session = await accounts.startSession(created.account.id);
  assert.equal(session.ok, false);
});

test('a session resolves to its account, and signing out kills it immediately', async (t) => {
  const { accounts } = await harness(t);
  const created = await register(accounts);

  const started = await accounts.startSession(created.account.id);
  assert.equal(started.ok, true);

  const resolved = await accounts.resolveSession(started.token);
  assert.equal(resolved.account.id, created.account.id);
  assert.equal(resolved.account.email, 'ann@example.com');

  assert.equal(await accounts.signOut(started.token), true);
  assert.equal(await accounts.resolveSession(started.token), null, 'a signed-out token must be dead, not merely forgotten');
  assert.equal(await accounts.signOut(started.token), false, 'signing out twice removes nothing the second time');
});

test('a token that verifies but whose session was revoked opens nothing', async (t) => {
  const { accounts } = await harness(t);
  const created = await register(accounts);
  const started = await accounts.startSession(created.account.id);

  // The signature is still perfectly valid — this is exactly the stolen-cookie case.
  assert.ok(accounts.tokens.verify(started.token));
  await accounts.signOutEverywhere(created.account.id);
  assert.ok(accounts.tokens.verify(started.token), 'the envelope is still intact');
  assert.equal(await accounts.resolveSession(started.token), null, 'but the session behind it is gone');
});

test('signing out everywhere ends every session, not just the current one', async (t) => {
  const { accounts } = await harness(t);
  const created = await register(accounts);

  const laptop = await accounts.startSession(created.account.id);
  const phone = await accounts.startSession(created.account.id);
  assert.ok(await accounts.resolveSession(laptop.token));
  assert.ok(await accounts.resolveSession(phone.token));

  await accounts.signOutEverywhere(created.account.id);
  assert.equal(await accounts.resolveSession(laptop.token), null);
  assert.equal(await accounts.resolveSession(phone.token), null);
});

test('one account cannot resolve to another', async (t) => {
  const { accounts } = await harness(t);
  const ann = await register(accounts);
  const bob = await register(accounts, { email: 'bob@example.com', displayName: 'Bob' });

  const annSession = await accounts.startSession(ann.account.id);
  const resolved = await accounts.resolveSession(annSession.token);

  assert.equal(resolved.account.id, ann.account.id);
  assert.notEqual(resolved.account.id, bob.account.id);
});

test('a session records which Nova product opened it', async (t) => {
  const { accounts } = await harness(t);
  const created = await register(accounts);
  await accounts.startSession(created.account.id, { product: 'nova.launcher' });

  const stored = await accounts.store.get(created.account.id);
  assert.deepEqual(
    stored.sessions.map((s) => s.product),
    ['nova.launcher'],
  );
  // The product seam records use across the ecosystem without either product knowing about
  // the other — the whole point of one account rather than several.
  assert.deepEqual(Object.keys(stored.products).sort(), ['nova.help', 'nova.launcher']);
});

test('a weak stored password is upgraded on the next correct sign-in', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'novaacct-rehash-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const weak = await createAccounts({ dir, secret: SECRET, cost: { N: 1024, r: 8, p: 1 } });
  const created = await register(weak);
  assert.match((await weak.store.get(created.account.id)).password, /N=1024/);

  const stronger = await createAccounts({ dir, secret: SECRET, cost: { N: 4096, r: 8, p: 1 } });
  const signedIn = await stronger.signIn({ email: 'ann@example.com', password: PASSWORD });
  assert.equal(signedIn.ok, true);

  const after = await stronger.store.get(created.account.id);
  assert.match(after.password, /N=4096/, 'the hash should have been re-made at the higher cost');
  assert.equal(await verifyPassword(PASSWORD, after.password), true);
});

/**
 * A federated account has no password, and that fact must not be measurable.
 *
 * `verifyPassword` already fails closed on a null record, so removing the explicit guard in
 * `signIn` changes no answer — it changes only how FAST the answer comes back. Skipping the
 * key derivation for accounts that have no password turns the sign-in form into a stopwatch
 * oracle for "this address signs in with Google", which is exactly the kind of thing the
 * generic-failure wording elsewhere is there to avoid leaking.
 *
 * So this is a timing test, and it is written to be a blunt one: the cost is set high enough
 * that a skipped derivation is a hundredfold difference, and the assertion allows a 3x spread
 * before it complains. It is comparing two paths on the same machine in the same process, not
 * asserting an absolute duration.
 */
test('signing in to a passwordless account costs the same as signing in to no account', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'novaacct-timing-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const cost = { N: 65536, r: 8, p: 1 };
  const accounts = await createAccounts({ dir, secret: SECRET, cost });

  const created = await accounts.withProviderIdentity({
    provider: 'google',
    subject: 'timing-subject',
    email: 'federated@example.com',
    emailVerified: true,
  });
  assert.equal(created.ok, true);
  assert.equal((await accounts.store.get(created.account.id)).password, null);

  const timeOf = async (email) => {
    let best = Infinity;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const started = process.hrtime.bigint();
      const result = await accounts.signIn({ email, password: 'not the password anyway' });
      const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'invalid');
      best = Math.min(best, elapsed);
    }
    return best;
  };

  const noAccount = await timeOf('nobody@example.com');
  const passwordless = await timeOf('federated@example.com');

  assert.ok(noAccount > 10, `the baseline should be doing real work, took ${noAccount.toFixed(1)}ms`);
  assert.ok(
    passwordless > noAccount / 3,
    `a passwordless account answered in ${passwordless.toFixed(1)}ms against a ${noAccount.toFixed(1)}ms baseline — the derivation is being skipped, which makes the form a membership oracle`,
  );
});

test('an expired session is not resolvable and does not accumulate', async (t) => {
  const { accounts } = await harness(t);
  const created = await register(accounts);

  const brief = await accounts.startSession(created.account.id, { ttlSeconds: -1 });
  assert.equal(await accounts.resolveSession(brief.token), null);

  await accounts.startSession(created.account.id);
  const stored = await accounts.store.get(created.account.id);
  assert.equal(stored.sessions.length, 1, 'the lapsed session should have been pruned on the next write');
});
