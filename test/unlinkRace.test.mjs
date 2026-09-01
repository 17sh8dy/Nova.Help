/**
 * Disconnecting two providers at once must not lock somebody out of their account.
 *
 * THE BUG THIS FILE EXISTS FOR. `unlinkProvider` read the account, satisfied itself that
 * another way in would remain, and then asked the store to remove the identity. Nothing held
 * the account still between the reading and the asking. Two unlinks of two DIFFERENT providers
 * arriving together on an account with no password and exactly two identities would each see
 * two, each conclude that one would survive, and both go ahead — leaving an account with no
 * password, no identity, and nothing to sign in with. There is no password-reset flow here, so
 * that is not an inconvenience; it is the account gone.
 *
 * It is a plausible accident rather than an exotic one: a double-click on a slow connection, a
 * page open in two tabs, a retry after a request that looked like it hung.
 *
 * WHY THESE ARE DETERMINISTIC. Nothing here sleeps or races the clock. Both calls are started
 * before either is awaited, which is precisely the interleaving an HTTP server produces, and
 * the invariant is asserted on the state afterwards rather than on who won. The fix makes the
 * counting and the removal one operation — under a lock in the JSON store, inside the DELETE
 * statement in D1 — so the second call is always decided against what the first one left, and
 * the outcome is the same every run whichever of them gets there first.
 *
 * These drive the SERVICE, which is where the broken check lived. The store contract covers
 * the same ground one layer down, for both backends.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createAccounts } from '@nova/accounts';
import { createD1AccountStore } from '@nova/accounts/d1Store';
import { createSqliteD1 } from '../server/store/sqliteD1.mjs';
import { applyAccountSchema } from '../server/store/migrate.mjs';

const CHEAP = { N: 1024, r: 8, p: 1 };
const SECRET = 'a-test-signing-secret-of-sufficient-length';
const PASSWORD = 'a passphrase nobody guesses';

/** Nova Accounts over the JSON store. */
async function fileBacked(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'novaunlink-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return createAccounts({ dir, secret: SECRET, cost: CHEAP });
}

/** Nova Accounts over D1. */
async function d1Backed(t) {
  const db = createSqliteD1();
  t.after(() => db.close());
  await applyAccountSchema(db);
  return createAccounts({ secret: SECRET, cost: CHEAP, store: createD1AccountStore({ db }) });
}

const BACKENDS = { fileStore: fileBacked, d1Store: d1Backed };

/** An identity as a verified provider would hand it over. */
const identity = (provider, subject, email) => ({
  provider,
  subject,
  email,
  emailVerified: true,
  displayName: 'Ann',
});

/**
 * An account created by a provider — so it has NO password — with `providers` linked to it.
 *
 * Built through the public API rather than by writing documents, so what is under test is the
 * account a real federated sign-up produces.
 */
async function federatedAccount(accounts, providers) {
  const [first, ...rest] = providers;
  const created = await accounts.withProviderIdentity(identity(first, `${first}-sub`, 'ann@example.com'));
  assert.equal(created.ok, true);
  assert.equal(created.outcome, 'created');

  for (const provider of rest) {
    const linked = await accounts.withProviderIdentity(identity(provider, `${provider}-sub`, 'ann@example.com'), {
      currentAccountId: created.account.id,
    });
    assert.equal(linked.ok, true, `linking ${provider}`);
  }

  const stored = await accounts.store.get(created.account.id);
  assert.equal(stored.password, null, 'the account has no password, which is the whole premise');
  assert.equal(stored.identities.length, providers.length);
  return created.account.id;
}

for (const [label, makeAccounts] of Object.entries(BACKENDS)) {
  const name = (what) => `[${label}] ${what}`;

  test(name('two providers disconnected at once cannot empty the account'), async (t) => {
    const accounts = await makeAccounts(t);
    const id = await federatedAccount(accounts, ['google', 'apple']);

    /* Both started before either is awaited — the interleaving two overlapping requests
       produce, and the one the old check could not survive. */
    const [google, apple] = await Promise.all([
      accounts.unlinkProvider(id, 'google'),
      accounts.unlinkProvider(id, 'apple'),
    ]);

    const stored = await accounts.store.get(id);
    assert.equal(stored.identities.length, 1, 'a way in survived');
    assert.equal(stored.password, null, 'and it was not a password, because there is none');

    assert.equal([google, apple].filter((r) => r.ok).length, 1, 'exactly one disconnect succeeded');
    const refused = [google, apple].find((r) => !r.ok);
    assert.equal(refused.reason, 'last-way-in', 'and the other was told why');
  });

  test(name('the identity that survives is still a working way in'), async (t) => {
    const accounts = await makeAccounts(t);
    const id = await federatedAccount(accounts, ['google', 'apple']);

    await Promise.all([accounts.unlinkProvider(id, 'google'), accounts.unlinkProvider(id, 'apple')]);

    /* Surviving the count is not enough — the index has to agree with the document, or the
       person is locked out anyway by a provider that no longer resolves to their account. */
    const stored = await accounts.store.get(id);
    const [survivor] = stored.identities;
    const signedIn = await accounts.withProviderIdentity(
      identity(survivor.provider, survivor.subject, 'ann@example.com'),
    );

    assert.equal(signedIn.ok, true);
    assert.equal(signedIn.outcome, 'signed-in');
    assert.equal(signedIn.account.id, id, 'and it is still their account');
  });

  test(name('five providers disconnected at once still leave one'), async (t) => {
    const accounts = await makeAccounts(t);
    const providers = ['google', 'apple', 'discord', 'github', 'gitlab'];
    const id = await federatedAccount(accounts, providers);

    const results = await Promise.all(providers.map((provider) => accounts.unlinkProvider(id, provider)));

    const stored = await accounts.store.get(id);
    assert.equal(stored.identities.length, 1);
    assert.equal(results.filter((r) => r.ok).length, providers.length - 1);
    assert.equal(results.filter((r) => r.reason === 'last-way-in').length, 1);
  });

  test(name('the same provider disconnected twice at once removes it once'), async (t) => {
    const accounts = await makeAccounts(t);
    const id = await federatedAccount(accounts, ['google', 'apple']);

    const [first, second] = await Promise.all([
      accounts.unlinkProvider(id, 'google'),
      accounts.unlinkProvider(id, 'google'),
    ]);

    const stored = await accounts.store.get(id);
    assert.deepEqual(stored.identities.map((i) => i.provider), ['apple']);
    assert.equal([first, second].filter((r) => r.ok).length, 1, 'one did it');
    assert.equal([first, second].find((r) => !r.ok).reason, 'not-linked', 'the other found it gone');
  });

  test(name('an account with a password may disconnect everything'), async (t) => {
    /* The guard is about ways IN, not about identities. An account with a password is not at
       risk and must not be obstructed — the fix must not have made the rule stricter. */
    const accounts = await makeAccounts(t);
    const registered = await accounts.register({
      email: 'bo@example.com',
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    });
    assert.equal(registered.ok, true);
    const id = registered.account.id;

    for (const provider of ['google', 'apple']) {
      const linked = await accounts.withProviderIdentity(
        identity(provider, `${provider}-sub`, 'bo@example.com'),
        { currentAccountId: id },
      );
      assert.equal(linked.ok, true);
    }

    const results = await Promise.all([
      accounts.unlinkProvider(id, 'google'),
      accounts.unlinkProvider(id, 'apple'),
    ]);

    assert.equal(results.every((r) => r.ok), true, 'both disconnects were allowed');
    assert.deepEqual((await accounts.store.get(id)).identities, [], 'the password is the way in');
  });

  /* ── Behaviour that must not have changed ────────────────────────────────────────────── */

  test(name('disconnecting the only way in is still refused on its own'), async (t) => {
    const accounts = await makeAccounts(t);
    const id = await federatedAccount(accounts, ['google']);

    const refused = await accounts.unlinkProvider(id, 'google');
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'last-way-in');
    assert.equal((await accounts.store.get(id)).identities.length, 1);
  });

  test(name('disconnecting one of two is still allowed on its own'), async (t) => {
    const accounts = await makeAccounts(t);
    const id = await federatedAccount(accounts, ['google', 'apple']);

    const released = await accounts.unlinkProvider(id, 'google');
    assert.equal(released.ok, true);
    assert.deepEqual(released.account.identities.map((i) => i.provider), ['apple']);
  });

  test(name('a provider that was never linked is still not-linked'), async (t) => {
    const accounts = await makeAccounts(t);
    const id = await federatedAccount(accounts, ['google']);

    const result = await accounts.unlinkProvider(id, 'apple');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not-linked');
  });

  test(name('an account that does not exist is still no-such-account'), async (t) => {
    const accounts = await makeAccounts(t);
    const result = await accounts.unlinkProvider('acct_NOPE', 'google');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-such-account');
  });

  test(name('a successful disconnect still returns a public view, not the document'), async (t) => {
    const accounts = await makeAccounts(t);
    const registered = await accounts.register({
      email: 'view@example.com',
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    });
    await accounts.withProviderIdentity(identity('google', 'google-sub', 'view@example.com'), {
      currentAccountId: registered.account.id,
    });

    const released = await accounts.unlinkProvider(registered.account.id, 'google');
    assert.equal(released.ok, true);
    assert.equal('password' in released.account, false, 'no password hash leaves the service');
    assert.equal('sessions' in released.account, false);
    assert.equal(released.account.hasPassword, true);
  });
}
