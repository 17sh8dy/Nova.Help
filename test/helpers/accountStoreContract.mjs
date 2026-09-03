/**
 * The account store contract — one suite, run against every implementation of the seam.
 *
 * Nova Accounts is meant to end up behind one identity service for every Nova product, so the
 * meaning of these methods must not drift as the backend changes underneath them. This file is
 * that meaning, written once. It is deliberately about ACCOUNTS and says nothing about
 * tickets, support or Nova.Help — the same rule the module itself obeys.
 *
 * The two invariants worth reading first are the uniqueness ones. They are the only rules here
 * that are not per-document, and they are the reason the JSON store needed locks at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

let counter = 0;

export function anAccount(overrides = {}) {
  counter += 1;
  return {
    id: overrides.id ?? `acct_TEST${String(counter).padStart(4, '0')}`,
    schemaVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    email: overrides.email ?? `person${counter}@example.com`,
    emailVerified: false,
    displayName: 'Ann',
    password: 'scrypt$N=1024,r=8,p=1$c2FsdA$aGFzaA',
    status: 'active',
    sessions: [],
    identities: [],
    products: { 'nova.help': { firstSeenAt: '2026-01-01T00:00:00.000Z' } },
    ...overrides,
  };
}

export const anIdentity = (overrides = {}) => ({
  provider: 'google',
  subject: '11223344',
  email: 'ann@example.com',
  emailVerified: true,
  linkedAt: '2026-01-02T00:00:00.000Z',
  ...overrides,
});

const aSession = (overrides = {}) => ({
  id: `sess_${Math.random().toString(36).slice(2, 10)}`,
  createdAt: '2026-01-03T00:00:00.000Z',
  expiresAt: '2099-01-01T00:00:00.000Z',
  product: 'nova.help',
  ...overrides,
});

export function describeAccountStore(label, makeStore) {
  const name = (what) => `[${label}] ${what}`;

  /* ── Creating and reading ────────────────────────────────────────────────────────────── */

  test(name('a created account comes back exactly as it was stored'), async (t) => {
    const store = await makeStore(t);
    const account = anAccount();
    const created = await store.create(account);

    assert.equal(created.ok, true);
    assert.deepEqual(created.account, account);
    assert.deepEqual(await store.get(account.id), account);
  });

  test(name('an account that does not exist reads as null'), async (t) => {
    const store = await makeStore(t);
    assert.equal(await store.get('acct_NOPE'), null);
    assert.equal(await store.getByEmail('nobody@example.com'), null);
    assert.equal(await store.getByIdentity('google', 'nobody'), null);
    assert.equal(await store.has('acct_NOPE'), false);
    assert.equal(await store.emailTaken('nobody@example.com'), false);
    assert.equal(await store.identityTaken('google', 'nobody'), false);
  });

  test(name('an account with sessions, identities and products round-trips whole'), async (t) => {
    const store = await makeStore(t);
    const account = anAccount({
      emailVerified: true,
      displayName: null,
      password: null,
      sessions: [aSession({ id: 'sess_a' }), aSession({ id: 'sess_b', product: null })],
      identities: [anIdentity(), anIdentity({ provider: 'apple', subject: 'apple-99', email: null, emailVerified: false })],
      products: {
        'nova.help': { firstSeenAt: '2026-01-01T00:00:00.000Z' },
        'nova.launcher': { firstSeenAt: '2026-02-01T00:00:00.000Z' },
      },
    });
    await store.create(account);

    const found = await store.get(account.id);
    assert.deepEqual(found.products, account.products);
    assert.deepEqual(new Set(found.sessions.map((s) => s.id)), new Set(['sess_a', 'sess_b']));
    assert.deepEqual(
      new Set(found.identities.map((i) => `${i.provider}:${i.subject}`)),
      new Set(['google:11223344', 'apple:apple-99']),
    );
    assert.equal(found.password, null);
    assert.equal(found.displayName, null);
    assert.equal(found.emailVerified, true);
  });

  test(name('what a read returns cannot be mutated back into the store'), async (t) => {
    const store = await makeStore(t);
    const account = anAccount({ sessions: [aSession({ id: 'sess_a' })] });
    await store.create(account);

    const first = await store.get(account.id);
    first.password = 'tampered';
    first.sessions.push(aSession({ id: 'injected' }));
    first.products.evil = { firstSeenAt: 'now' };

    const second = await store.get(account.id);
    assert.equal(second.password, account.password);
    assert.deepEqual(second.sessions.map((s) => s.id), ['sess_a']);
    assert.deepEqual(Object.keys(second.products), ['nova.help']);
  });

  /* ── One address, one account ────────────────────────────────────────────────────────── */

  test(name('an address is claimed once, and the loser is told why'), async (t) => {
    const store = await makeStore(t);
    assert.equal((await store.create(anAccount({ id: 'acct_a', email: 'ann@example.com' }))).ok, true);

    const second = await store.create(anAccount({ id: 'acct_b', email: 'ann@example.com' }));
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'email-taken');
    assert.equal(await store.count(), 1);
  });

  test(name('an address is matched however it was typed'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a', email: 'Ann@Example.COM' }));

    assert.equal((await store.getByEmail('ann@example.com')).id, 'acct_a');
    assert.equal((await store.getByEmail('  ANN@EXAMPLE.com ')).id, 'acct_a');
    assert.equal(await store.emailTaken('AnN@eXaMpLe.CoM'), true);

    const clash = await store.create(anAccount({ id: 'acct_b', email: '  ann@EXAMPLE.com  ' }));
    assert.equal(clash.ok, false, 'and case is not a way around the rule');
    assert.equal(clash.reason, 'email-taken');
  });

  test(name('the address they typed is kept, not the normalised one'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a', email: 'Ann.Smith@Example.COM' }));
    assert.equal((await store.get('acct_a')).email, 'Ann.Smith@Example.COM');
  });

  test(name('two simultaneous sign-ups for one address produce exactly one account'), async (t) => {
    const store = await makeStore(t);
    const results = await Promise.all([
      store.create(anAccount({ id: 'acct_a', email: 'race@example.com' })),
      store.create(anAccount({ id: 'acct_b', email: 'race@example.com' })),
      store.create(anAccount({ id: 'acct_c', email: 'race@example.com' })),
    ]);

    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(results.filter((r) => r.reason === 'email-taken').length, 2);
    assert.equal(await store.count(), 1);
  });

  /* ── One provider identity, one account ──────────────────────────────────────────────── */

  test(name('an identity is found by subject, and grants nothing by address'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a', email: 'ann@example.com' }));
    await store.claimIdentity('acct_a', anIdentity({ email: 'someone.else@example.com' }));

    assert.equal((await store.getByIdentity('google', '11223344')).id, 'acct_a');
    assert.equal(await store.identityTaken('google', '11223344'), true);
    /* The identity's address is an attribute of it and is not an index into anything. */
    assert.equal(await store.getByEmail('someone.else@example.com'), null);
  });

  test(name('claiming an identity another account holds is refused'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a', email: 'a@example.com' }));
    await store.create(anAccount({ id: 'acct_b', email: 'b@example.com' }));

    assert.equal((await store.claimIdentity('acct_a', anIdentity())).ok, true);
    const second = await store.claimIdentity('acct_b', anIdentity());
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'identity-taken');

    assert.equal((await store.getByIdentity('google', '11223344')).id, 'acct_a');
    assert.equal((await store.get('acct_b')).identities.length, 0);
  });

  test(name('re-claiming an identity for the account that already holds it is a no-op'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a' }));
    await store.claimIdentity('acct_a', anIdentity());

    const again = await store.claimIdentity('acct_a', anIdentity());
    assert.equal(again.ok, true);
    assert.equal((await store.get('acct_a')).identities.length, 1);
  });

  test(name('claiming for an account that does not exist is refused, not created'), async (t) => {
    const store = await makeStore(t);
    const result = await store.claimIdentity('acct_NOPE', anIdentity());
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-such-account');
    assert.equal(await store.identityTaken('google', '11223344'), false);
  });

  test(name('connecting a provider again replaces that provider, not the others'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a' }));
    await store.claimIdentity('acct_a', anIdentity({ provider: 'apple', subject: 'apple-1' }));
    await store.claimIdentity('acct_a', anIdentity({ subject: 'google-old' }));
    await store.claimIdentity('acct_a', anIdentity({ subject: 'google-new' }));

    const found = await store.get('acct_a');
    assert.equal(found.identities.length, 2);
    assert.deepEqual(
      new Set(found.identities.map((i) => `${i.provider}:${i.subject}`)),
      new Set(['apple:apple-1', 'google:google-new']),
    );
    assert.equal(await store.identityTaken('google', 'google-old'), false);
  });

  test(name('two accounts cannot claim one identity by racing'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a', email: 'a@example.com' }));
    await store.create(anAccount({ id: 'acct_b', email: 'b@example.com' }));

    const results = await Promise.all([
      store.claimIdentity('acct_a', anIdentity()),
      store.claimIdentity('acct_b', anIdentity()),
    ]);

    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(results.filter((r) => r.reason === 'identity-taken').length, 1);

    const a = await store.get('acct_a');
    const b = await store.get('acct_b');
    assert.equal(a.identities.length + b.identities.length, 1, 'exactly one document holds it');
  });

  test(name('releasing an identity frees it for another account'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a', email: 'a@example.com' }));
    await store.create(anAccount({ id: 'acct_b', email: 'b@example.com' }));
    await store.claimIdentity('acct_a', anIdentity());

    const released = await store.releaseIdentity('acct_a', 'google');
    assert.equal(released.ok, true);
    assert.equal(released.account.identities.length, 0);
    assert.equal(await store.identityTaken('google', '11223344'), false);
    assert.equal(await store.getByIdentity('google', '11223344'), null);

    assert.equal((await store.claimIdentity('acct_b', anIdentity())).ok, true);
  });

  test(name('releasing a provider that is not linked changes nothing'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a' }));
    await store.claimIdentity('acct_a', anIdentity());

    const result = await store.releaseIdentity('acct_a', 'apple');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not-linked');
    assert.equal((await store.get('acct_a')).identities.length, 1);
    assert.equal(await store.identityTaken('google', '11223344'), true);
  });

  test(name('releasing from an account that does not exist is refused, not thrown'), async (t) => {
    const store = await makeStore(t);
    const result = await store.releaseIdentity('acct_NOPE', 'google');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-such-account');
  });

  /* ── The last way in ─────────────────────────────────────────────────────────────────── */

  test(name('requireAnotherWayIn refuses to remove the only way into an account'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a', password: null }));
    await store.claimIdentity('acct_a', anIdentity());

    const refused = await store.releaseIdentity('acct_a', 'google', { requireAnotherWayIn: true });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'last-way-in');
    assert.equal((await store.get('acct_a')).identities.length, 1, 'and left it attached');
  });

  test(name('requireAnotherWayIn allows the removal when a password remains'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a' })); // has a password
    await store.claimIdentity('acct_a', anIdentity());

    const released = await store.releaseIdentity('acct_a', 'google', { requireAnotherWayIn: true });
    assert.equal(released.ok, true);
    assert.equal(released.account.identities.length, 0);
  });

  test(name('requireAnotherWayIn allows the removal when another identity remains'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a', password: null }));
    await store.claimIdentity('acct_a', anIdentity());
    await store.claimIdentity('acct_a', anIdentity({ provider: 'apple', subject: 'apple-1' }));

    const released = await store.releaseIdentity('acct_a', 'google', { requireAnotherWayIn: true });
    assert.equal(released.ok, true);
    assert.deepEqual(
      released.account.identities.map((i) => i.provider),
      ['apple'],
    );
  });

  test(name('an empty-string password does not count as a way in'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a', password: '' }));
    await store.claimIdentity('acct_a', anIdentity());

    const refused = await store.releaseIdentity('acct_a', 'google', { requireAnotherWayIn: true });
    assert.equal(refused.ok, false, 'a blank password is not a password');
    assert.equal(refused.reason, 'last-way-in');
  });

  test(name('without requireAnotherWayIn the store still does exactly as it is told'), async (t) => {
    /* The rule belongs to the service, which is the layer that knows there is no reset flow.
       The store applies it when asked and does not invent it when not. */
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a', password: null }));
    await store.claimIdentity('acct_a', anIdentity());

    const released = await store.releaseIdentity('acct_a', 'google');
    assert.equal(released.ok, true);
    assert.equal(released.account.identities.length, 0);
  });

  test(name('two unlinks racing cannot empty a passwordless account'), async (t) => {
    /* THE REGRESSION. A passwordless account with exactly two identities, and both unlinked at
       once. Each call, reading on its own, sees two identities and concludes that one will
       survive it. If the counting and the removal are not one operation, both proceed and the
       account is left with no password, no identity, and no way back in — permanently, because
       there is no password-reset flow to rescue it. */
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a', password: null }));
    await store.claimIdentity('acct_a', anIdentity());
    await store.claimIdentity('acct_a', anIdentity({ provider: 'apple', subject: 'apple-1' }));

    const [google, apple] = await Promise.all([
      store.releaseIdentity('acct_a', 'google', { requireAnotherWayIn: true }),
      store.releaseIdentity('acct_a', 'apple', { requireAnotherWayIn: true }),
    ]);

    const final = await store.get('acct_a');
    assert.equal(final.identities.length, 1, 'exactly one way in survived');
    assert.equal([google, apple].filter((r) => r.ok).length, 1, 'exactly one unlink succeeded');
    assert.equal([google, apple].filter((r) => r.reason === 'last-way-in').length, 1);

    // And the survivor is still usable: the index agrees with the document.
    const [survivor] = final.identities;
    const found = await store.getByIdentity(survivor.provider, survivor.subject);
    assert.equal(found?.id, 'acct_a', 'the identity that remains still resolves to the account');
  });

  test(name('many unlinks racing still leave a way in'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a', password: null }));
    const providers = ['google', 'apple', 'discord', 'github', 'gitlab'];
    for (const [i, provider] of providers.entries()) {
      await store.claimIdentity('acct_a', anIdentity({ provider, subject: `subject-${i}` }));
    }

    const results = await Promise.all(
      providers.map((provider) => store.releaseIdentity('acct_a', provider, { requireAnotherWayIn: true })),
    );

    const final = await store.get('acct_a');
    assert.equal(final.identities.length, 1, 'the last one is always refused');
    assert.equal(results.filter((r) => r.ok).length, 4);
    assert.equal(results.filter((r) => r.reason === 'last-way-in').length, 1);
  });

  /* ── Updating ────────────────────────────────────────────────────────────────────────── */

  test(name('update applies the mutation and returns the new document'), async (t) => {
    const store = await makeStore(t);
    const account = anAccount({ id: 'acct_a' });
    await store.create(account);

    const returned = await store.update('acct_a', (doc) => {
      doc.password = 'scrypt$N=2048,r=8,p=1$c2FsdA$bmV3';
      doc.updatedAt = '2026-02-01T00:00:00.000Z';
      return doc;
    });

    assert.equal(returned.password, 'scrypt$N=2048,r=8,p=1$c2FsdA$bmV3');
    assert.deepEqual(await store.get('acct_a'), returned);
  });

  test(name('a mutator returning nothing aborts the update'), async (t) => {
    const store = await makeStore(t);
    const account = anAccount({ id: 'acct_a' });
    await store.create(account);

    const returned = await store.update('acct_a', (doc) => {
      doc.status = 'disabled';
      doc.sessions.push(aSession());
      return null;
    });

    assert.equal(returned, null);
    assert.deepEqual(await store.get('acct_a'), account);
  });

  test(name('updating an account that does not exist is null, and never runs the mutator'), async (t) => {
    const store = await makeStore(t);
    let ran = false;
    const returned = await store.update('acct_NOPE', (doc) => {
      ran = true;
      return doc;
    });
    assert.equal(returned, null);
    assert.equal(ran, false);
  });

  /* ── Sessions ────────────────────────────────────────────────────────────────────────── */

  test(name('opening a session records it, and closing it removes it'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a' }));

    await store.update('acct_a', (doc) => {
      doc.sessions = [...doc.sessions, aSession({ id: 'sess_1' })];
      return doc;
    });
    assert.deepEqual((await store.get('acct_a')).sessions.map((s) => s.id), ['sess_1']);

    await store.update('acct_a', (doc) => {
      doc.sessions = doc.sessions.filter((s) => s.id !== 'sess_1');
      return doc;
    });
    assert.deepEqual((await store.get('acct_a')).sessions, []);
  });

  test(name('a session keeps every field it was opened with'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a' }));
    const session = aSession({ id: 'sess_1', createdAt: '2026-05-05T05:05:05.000Z', product: 'nova.launcher' });

    await store.update('acct_a', (doc) => {
      doc.sessions = [session];
      return doc;
    });
    assert.deepEqual((await store.get('acct_a')).sessions, [session]);
  });

  test(name('concurrent sign-ins all end up on the account'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a' }));

    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.update('acct_a', (doc) => {
          doc.sessions = [...doc.sessions, aSession({ id: `sess_${i}` })];
          doc.updatedAt = new Date().toISOString();
          return doc;
        }),
      ),
    );

    const found = await store.get('acct_a');
    assert.equal(found.sessions.length, 8, 'no sign-in was lost');
    assert.equal(new Set(found.sessions.map((s) => s.id)).size, 8);
  });

  test(name('a sign-out concurrent with a sign-in does not resurrect the closed session'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a', sessions: [aSession({ id: 'old' })] }));

    await Promise.all([
      store.update('acct_a', (doc) => {
        doc.sessions = doc.sessions.filter((s) => s.id !== 'old');
        return doc;
      }),
      store.update('acct_a', (doc) => {
        doc.sessions = [...doc.sessions, aSession({ id: 'new' })];
        return doc;
      }),
    ]);

    const found = await store.get('acct_a');
    assert.equal(found.sessions.some((s) => s.id === 'old'), false, 'the revoked session stayed revoked');
  });

  test(name('signing out everywhere leaves nothing behind'), async (t) => {
    const store = await makeStore(t);
    await store.create(
      anAccount({ id: 'acct_a', sessions: [aSession({ id: 's1' }), aSession({ id: 's2' }), aSession({ id: 's3' })] }),
    );

    await store.update('acct_a', (doc) => {
      doc.sessions = [];
      return doc;
    });
    assert.deepEqual((await store.get('acct_a')).sessions, []);
  });

  /* ── Products ────────────────────────────────────────────────────────────────────────── */

  test(name('recording a product is idempotent, and persists what it was given'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a', products: {} }));

    /* This is the shape of the service's `touchProduct`, which is `??=` and so never rewrites
       a date it already has. The store's job is to persist faithfully; keeping the earliest
       date is the service's rule, and asserting it here would be testing the wrong layer. */
    const touch = (at) =>
      store.update('acct_a', (doc) => {
        doc.products ??= {};
        doc.products['nova.launcher'] ??= { firstSeenAt: at };
        return doc;
      });

    await touch('2026-03-01T00:00:00.000Z');
    await touch('2026-09-09T00:00:00.000Z');

    assert.deepEqual((await store.get('acct_a')).products, {
      'nova.launcher': { firstSeenAt: '2026-03-01T00:00:00.000Z' },
    });
  });

  test(name('an account may be used with several products at once'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a', products: {} }));

    await store.update('acct_a', (doc) => {
      doc.products = {
        'nova.help': { firstSeenAt: '2026-01-01T00:00:00.000Z' },
        'nova.launcher': { firstSeenAt: '2026-02-01T00:00:00.000Z' },
        'open.cut': { firstSeenAt: '2026-03-01T00:00:00.000Z' },
      };
      return doc;
    });

    assert.deepEqual(Object.keys((await store.get('acct_a')).products).sort(), [
      'nova.help',
      'nova.launcher',
      'open.cut',
    ]);
  });

  /* ── Password reset ──────────────────────────────────────────────────────────────────── */

  const aReset = (overrides = {}) => ({
    tokenHash: 'a'.repeat(64),
    requestedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    ...overrides,
  });

  /** The store compares digests through whatever the service passes in; here, plain equality. */
  const matches = (a, b) => a === b;
  const NEW_HASH = 'scrypt$N=1024,r=8,p=1$bmV3$cGFzcw';

  test(name('an account with no outstanding reset has no passwordReset key at all'), async (t) => {
    const store = await makeStore(t);
    const account = anAccount({ id: 'acct_a' });
    await store.create(account);

    /* Not `null`, absent — the two stores must produce the same document, and one of them has
       no row to read rather than a column holding null. */
    assert.equal('passwordReset' in (await store.get('acct_a')), false);
  });

  test(name('a reset is recorded and reads back whole'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a' }));

    const issued = await store.issuePasswordReset('acct_a', aReset());
    assert.equal(issued.ok, true);
    assert.deepEqual((await store.get('acct_a')).passwordReset, aReset());
  });

  test(name('asking again replaces the outstanding reset, so only the newest link works'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a' }));

    await store.issuePasswordReset('acct_a', aReset({ tokenHash: 'b'.repeat(64) }));
    await store.issuePasswordReset('acct_a', aReset({ tokenHash: 'c'.repeat(64) }));

    assert.equal((await store.get('acct_a')).passwordReset.tokenHash, 'c'.repeat(64));

    // And the older link is dead, not merely superseded.
    const stale = await store.redeemPasswordReset('acct_a', {
      tokenHash: 'b'.repeat(64),
      password: NEW_HASH,
      matches,
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, 'token-mismatch');
  });

  test(name('issuing for an account that does not exist is refused'), async (t) => {
    const store = await makeStore(t);
    const issued = await store.issuePasswordReset('acct_NOPE', aReset());
    assert.equal(issued.ok, false);
    assert.equal(issued.reason, 'no-such-account');
  });

  test(name('redeeming sets the password, ends every session and spends the token'), async (t) => {
    const store = await makeStore(t);
    await store.create(
      anAccount({
        id: 'acct_a',
        sessions: [aSession({ id: 's1' }), aSession({ id: 's2' })],
      }),
    );
    await store.issuePasswordReset('acct_a', aReset());

    const redeemed = await store.redeemPasswordReset('acct_a', {
      tokenHash: aReset().tokenHash,
      password: NEW_HASH,
      matches,
    });

    assert.equal(redeemed.ok, true);
    const stored = await store.get('acct_a');
    assert.equal(stored.password, NEW_HASH, 'the new password is set');
    assert.deepEqual(stored.sessions, [], 'every session ended');
    assert.equal('passwordReset' in stored, false, 'the token is spent');
    assert.equal(stored.emailVerified, true, 'somebody proved they read mail we sent');
  });

  test(name('a token works exactly once'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a' }));
    await store.issuePasswordReset('acct_a', aReset());

    const first = await store.redeemPasswordReset('acct_a', {
      tokenHash: aReset().tokenHash,
      password: NEW_HASH,
      matches,
    });
    const second = await store.redeemPasswordReset('acct_a', {
      tokenHash: aReset().tokenHash,
      password: 'scrypt$N=1024,r=8,p=1$b3RoZXI$b3RoZXI',
      matches,
    });

    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'no-reset');
    assert.equal((await store.get('acct_a')).password, NEW_HASH, 'the second did not overwrite the first');
  });

  test(name('two redemptions of one token racing spend it once'), async (t) => {
    /* THE PROPERTY. Two requests carrying the same link, arriving together — a double-click, a
       mail client that prefetches, a retry. Checking the token and then writing would let both
       through; the store redeems atomically so exactly one can win. */
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a', sessions: [aSession({ id: 's1' })] }));
    await store.issuePasswordReset('acct_a', aReset());

    const [first, second] = await Promise.all([
      store.redeemPasswordReset('acct_a', { tokenHash: aReset().tokenHash, password: NEW_HASH, matches }),
      store.redeemPasswordReset('acct_a', { tokenHash: aReset().tokenHash, password: NEW_HASH, matches }),
    ]);

    assert.equal([first, second].filter((r) => r.ok).length, 1, 'exactly one redemption succeeded');
    const stored = await store.get('acct_a');
    assert.equal('passwordReset' in stored, false);
    assert.deepEqual(stored.sessions, []);
  });

  test(name('an expired token is refused and left alone'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a' }));
    await store.issuePasswordReset('acct_a', aReset({ expiresAt: '2020-01-01T00:00:00.000Z' }));

    const result = await store.redeemPasswordReset('acct_a', {
      tokenHash: aReset().tokenHash,
      password: NEW_HASH,
      matches,
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'expired');
    assert.notEqual((await store.get('acct_a')).password, NEW_HASH, 'nothing was changed');
  });

  test(name('a token that does not match is refused without spending the real one'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a' }));
    await store.issuePasswordReset('acct_a', aReset());

    const wrong = await store.redeemPasswordReset('acct_a', {
      tokenHash: 'f'.repeat(64),
      password: NEW_HASH,
      matches,
    });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.reason, 'token-mismatch');

    // The genuine link still works afterwards — a wrong guess must not burn it.
    const right = await store.redeemPasswordReset('acct_a', {
      tokenHash: aReset().tokenHash,
      password: NEW_HASH,
      matches,
    });
    assert.equal(right.ok, true);
  });

  test(name('redeeming with no outstanding reset is refused'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a' }));

    const result = await store.redeemPasswordReset('acct_a', {
      tokenHash: aReset().tokenHash,
      password: NEW_HASH,
      matches,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-reset');
  });

  test(name('a disabled account cannot be redeemed into'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a', status: 'disabled' }));
    await store.issuePasswordReset('acct_a', aReset());

    const result = await store.redeemPasswordReset('acct_a', {
      tokenHash: aReset().tokenHash,
      password: NEW_HASH,
      matches,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not-active');
    assert.notEqual((await store.get('acct_a')).password, NEW_HASH);
  });

  test(name('redeeming for an account that does not exist is refused'), async (t) => {
    const store = await makeStore(t);
    const result = await store.redeemPasswordReset('acct_NOPE', {
      tokenHash: aReset().tokenHash,
      password: NEW_HASH,
      matches,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-such-account');
  });

  test(name('clearing drops an outstanding reset'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a' }));
    await store.issuePasswordReset('acct_a', aReset());

    assert.equal((await store.clearPasswordReset('acct_a')).ok, true);
    assert.equal('passwordReset' in (await store.get('acct_a')), false);
    assert.equal((await store.clearPasswordReset('acct_a')).ok, false, 'and again is a no-op');
  });

  test(name('a reset survives a round trip through create'), async (t) => {
    const store = await makeStore(t);
    const account = anAccount({ id: 'acct_a', passwordReset: aReset() });
    await store.create(account);

    assert.deepEqual((await store.get('acct_a')).passwordReset, aReset());
  });

  /* ── Device authorizations ──────────────────────────────────────────────────────────────
   *
   * The four methods behind the device grant. They are in the CONTRACT rather than in a
   * D1-only or file-only test because the two implementations could not be less alike — three
   * in-memory Maps under a lock on one side, a table and guarded statements on the other — and
   * the only thing that keeps them interchangeable is that they are held to the same
   * behaviour here.
   *
   * The two that carry the security are `decideDeviceAuthorization` (a grant is decided ONCE,
   * so a race cannot pick which account a device attaches to) and `redeemDeviceAuthorization`
   * (a grant is spent ONCE, so two pollers cannot both walk away with a token).
   */

  const aGrant = (overrides = {}) => ({
    id: `dev_${Math.random().toString(36).slice(2, 10)}`,
    deviceCodeHash: `hash_${Math.random().toString(36).slice(2, 10)}`,
    userCode: 'KDMX7QRT',
    product: 'open-cut',
    scopes: ['identity', 'sync'],
    deviceName: 'A laptop',
    status: 'pending',
    accountId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    lastPolledAt: null,
    ...overrides,
  });

  test(name('a pending grant is found by the code a person types'), async (t) => {
    const store = await makeStore(t);
    const grant = aGrant();
    assert.equal((await store.createDeviceAuthorization(grant)).ok, true);

    const found = await store.getDeviceAuthorizationByUserCode('KDMX7QRT');
    assert.equal(found.product, 'open-cut');
    assert.deepEqual(found.scopes, ['identity', 'sync']);
    assert.equal(found.status, 'pending');
    assert.equal(found.deviceName, 'A laptop');
    assert.equal(found.accountId, null, 'nobody has approved it yet');
  });

  test(name('two live grants may not share one user code'), async (t) => {
    const store = await makeStore(t);
    assert.equal((await store.createDeviceAuthorization(aGrant())).ok, true);

    const second = await store.createDeviceAuthorization(aGrant());
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'user-code-taken', 'or they could be approved into each other');
  });

  test(name('a user code nobody minted is simply not found'), async (t) => {
    const store = await makeStore(t);
    assert.equal(await store.getDeviceAuthorizationByUserCode('ZZZZ9999'), null);
  });

  test(name('a lapsed grant is still READ — expiry is a fact here, not a decision'), async (t) => {
    const store = await makeStore(t);
    await store.createDeviceAuthorization(aGrant({ expiresAt: '2020-01-01T00:00:00.000Z' }));

    /* The store hands back what it holds; deviceService.mjs decides whether to say "expired"
       or to say nothing at all. Sweeping on read would take that choice away from it — and
       the D1 store cannot sweep on read anyway, so the two would answer differently. */
    const found = await store.getDeviceAuthorizationByUserCode('KDMX7QRT');
    assert.equal(found.expiresAt, '2020-01-01T00:00:00.000Z');
    assert.equal(found.status, 'pending');
  });

  test(name('approving records the account and the decision'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a' }));
    await store.createDeviceAuthorization(aGrant());

    const decided = await store.decideDeviceAuthorization('KDMX7QRT', {
      accountId: 'acct_a',
      status: 'approved',
    });
    assert.equal(decided.ok, true);
    assert.equal(decided.grant.accountId, 'acct_a');
    assert.equal(decided.grant.status, 'approved');
  });

  test(name('a grant is decided ONCE — the second approval changes nothing'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a' }));
    await store.create(anAccount({ id: 'acct_b' }));
    await store.createDeviceAuthorization(aGrant());

    assert.equal(
      (await store.decideDeviceAuthorization('KDMX7QRT', { accountId: 'acct_a', status: 'approved' })).ok,
      true,
    );
    const second = await store.decideDeviceAuthorization('KDMX7QRT', {
      accountId: 'acct_b',
      status: 'approved',
    });
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'already-decided');

    const still = await store.getDeviceAuthorizationByUserCode('KDMX7QRT');
    assert.equal(still.accountId, 'acct_a', 'the first decision is the one that stands');
  });

  test(name('denying records no account at all'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a' }));
    await store.createDeviceAuthorization(aGrant());

    const decided = await store.decideDeviceAuthorization('KDMX7QRT', {
      accountId: 'acct_a',
      status: 'denied',
    });
    assert.equal(decided.ok, true);
    assert.equal(decided.grant.accountId, null, 'a refusal must not write an account onto it');
  });

  test(name('a lapsed grant cannot be approved'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a' }));
    await store.createDeviceAuthorization(aGrant({ expiresAt: '2020-01-01T00:00:00.000Z' }));

    const decided = await store.decideDeviceAuthorization('KDMX7QRT', {
      accountId: 'acct_a',
      status: 'approved',
    });
    assert.equal(decided.ok, false);
    assert.equal(decided.reason, 'expired');
  });

  test(name('polling a pending grant says so and does not spend it'), async (t) => {
    const store = await makeStore(t);
    await store.createDeviceAuthorization(aGrant({ deviceCodeHash: 'hash_x' }));

    const result = await store.redeemDeviceAuthorization({ deviceCodeHash: 'hash_x' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'authorization_pending');
    assert.ok(await store.getDeviceAuthorizationByUserCode('KDMX7QRT'), 'still there');
  });

  test(name('an approved grant is redeemed, once'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a' }));
    await store.createDeviceAuthorization(aGrant({ deviceCodeHash: 'hash_x' }));
    await store.decideDeviceAuthorization('KDMX7QRT', { accountId: 'acct_a', status: 'approved' });

    const first = await store.redeemDeviceAuthorization({ deviceCodeHash: 'hash_x' });
    assert.equal(first.ok, true);
    assert.equal(first.grant.accountId, 'acct_a');
    assert.deepEqual(first.grant.scopes, ['identity', 'sync']);

    const second = await store.redeemDeviceAuthorization({ deviceCodeHash: 'hash_x' });
    assert.equal(second.ok, false, 'two devices must not both get a token for one approval');
    assert.equal(second.reason, 'expired_token');
  });

  test(name('a denied grant is refused and consumed'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a' }));
    await store.createDeviceAuthorization(aGrant({ deviceCodeHash: 'hash_x' }));
    await store.decideDeviceAuthorization('KDMX7QRT', { accountId: 'acct_a', status: 'denied' });

    const result = await store.redeemDeviceAuthorization({ deviceCodeHash: 'hash_x' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'access_denied');
    assert.equal(await store.getDeviceAuthorizationByUserCode('KDMX7QRT'), null, 'and gone');
  });

  test(name('a device code nobody minted is refused exactly like a lapsed one'), async (t) => {
    const store = await makeStore(t);
    const unknown = await store.redeemDeviceAuthorization({ deviceCodeHash: 'hash_nope' });
    assert.equal(unknown.reason, 'expired_token', 'so polling cannot enumerate live codes');

    await store.createDeviceAuthorization(aGrant({ deviceCodeHash: 'hash_old', expiresAt: '2020-01-01T00:00:00.000Z' }));
    const lapsed = await store.redeemDeviceAuthorization({ deviceCodeHash: 'hash_old' });
    assert.equal(lapsed.reason, 'expired_token');
  });

  test(name('polling faster than the interval is told to slow down, and keeps the grant'), async (t) => {
    const store = await makeStore(t);
    await store.createDeviceAuthorization(aGrant({ deviceCodeHash: 'hash_x' }));

    const at = (iso) => new Date(iso);
    const first = await store.redeemDeviceAuthorization({
      deviceCodeHash: 'hash_x',
      minIntervalSeconds: 5,
      now: at('2026-01-01T00:00:10.000Z'),
    });
    assert.equal(first.reason, 'authorization_pending', 'the first poll has nothing to compare against');

    const tooSoon = await store.redeemDeviceAuthorization({
      deviceCodeHash: 'hash_x',
      minIntervalSeconds: 5,
      now: at('2026-01-01T00:00:12.000Z'),
    });
    assert.equal(tooSoon.reason, 'slow_down');

    const patient = await store.redeemDeviceAuthorization({
      deviceCodeHash: 'hash_x',
      minIntervalSeconds: 5,
      now: at('2026-01-01T00:00:20.000Z'),
    });
    assert.equal(patient.reason, 'authorization_pending', 'and the grant survived being scolded');
  });

  test(name('a lapsed grant is swept rather than left to be counted forever'), async (t) => {
    const store = await makeStore(t);
    await store.createDeviceAuthorization(aGrant({ expiresAt: '2020-01-01T00:00:00.000Z' }));
    await store.createDeviceAuthorization(aGrant({ userCode: 'AAAA1111', deviceCodeHash: 'hash_live' }));

    assert.equal(await store.countDeviceAuthorizations(), 1);
    assert.equal(
      (await store.createDeviceAuthorization(aGrant())).ok,
      true,
      'and the swept code is free to mint again',
    );
  });

  test(name('a device session round-trips with its kind, scopes and label'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a' }));
    await store.update('acct_a', (doc) => {
      doc.sessions = [
        {
          id: 'sess_device',
          createdAt: '2026-01-03T00:00:00.000Z',
          expiresAt: '2099-01-01T00:00:00.000Z',
          product: 'atlas',
          kind: 'device',
          scopes: ['identity', 'sync'],
          label: 'Studio PC',
        },
      ];
      return doc;
    });

    assert.deepEqual((await store.get('acct_a')).sessions, [
      {
        id: 'sess_device',
        createdAt: '2026-01-03T00:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
        product: 'atlas',
        kind: 'device',
        scopes: ['identity', 'sync'],
        label: 'Studio PC',
      },
    ]);
  });

  /* ── Sync documents ─────────────────────────────────────────────────────────────────────
   *
   * The version check is the only thing standing between a fresh install and somebody's
   * settings, so it is checked here rather than in either store's own file — the two
   * implementations share nothing but this contract.
   */

  const DOC = JSON.stringify({ theme: 'midnight' });
  const OTHER = JSON.stringify({ theme: 'daylight' });

  test(name('an account that has never synced has nothing stored'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a' }));
    assert.equal(await store.getSyncDocument('acct_a', 'open-cut'), null);
  });

  test(name('a first write lands at version 1 and reads back'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a' }));

    const written = await store.putSyncDocument('acct_a', 'open-cut', {
      baseVersion: 0,
      document: DOC,
      now: new Date('2026-02-01T00:00:00.000Z'),
    });
    assert.deepEqual(written, { ok: true, version: 1, updatedAt: '2026-02-01T00:00:00.000Z' });

    assert.deepEqual(await store.getSyncDocument('acct_a', 'open-cut'), {
      version: 1,
      document: DOC,
      updatedAt: '2026-02-01T00:00:00.000Z',
    });
  });

  test(name('a stale base version is REFUSED, not applied'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a' }));
    await store.putSyncDocument('acct_a', 'open-cut', { baseVersion: 0, document: DOC });
    await store.putSyncDocument('acct_a', 'open-cut', { baseVersion: 1, document: OTHER });

    const stale = await store.putSyncDocument('acct_a', 'open-cut', { baseVersion: 1, document: DOC });
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, 'conflict');
    assert.equal((await store.getSyncDocument('acct_a', 'open-cut')).document, OTHER, 'unchanged');
  });

  test(name('baseVersion 0 is "I have never synced", NOT a wildcard'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a' }));
    await store.putSyncDocument('acct_a', 'open-cut', { baseVersion: 0, document: DOC });

    /* This is the whole protection a fresh install has to defeat before it can flatten a year
       of settings, so it is the one assertion in this section that must never be softened. */
    const naive = await store.putSyncDocument('acct_a', 'open-cut', { baseVersion: 0, document: OTHER });
    assert.equal(naive.ok, false);
    assert.equal(naive.reason, 'conflict');
    assert.equal((await store.getSyncDocument('acct_a', 'open-cut')).document, DOC);
  });

  test(name('two products on one account do not share a document'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a' }));
    await store.putSyncDocument('acct_a', 'open-cut', { baseVersion: 0, document: DOC });
    await store.putSyncDocument('acct_a', 'atlas', { baseVersion: 0, document: OTHER });

    assert.equal((await store.getSyncDocument('acct_a', 'open-cut')).document, DOC);
    assert.equal((await store.getSyncDocument('acct_a', 'atlas')).document, OTHER);
    assert.equal((await store.getSyncDocument('acct_a', 'atlas')).version, 1, 'versions are per product');
  });

  test(name('two accounts do not share a document'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a' }));
    await store.create(anAccount({ id: 'acct_b' }));
    await store.putSyncDocument('acct_a', 'open-cut', { baseVersion: 0, document: DOC });

    assert.equal(await store.getSyncDocument('acct_b', 'open-cut'), null);
  });

  test(name('there is nothing to sync for an account that does not exist'), async (t) => {
    const store = await makeStore(t);
    const written = await store.putSyncDocument('acct_NOPE', 'open-cut', { baseVersion: 0, document: DOC });
    assert.equal(written.ok, false);
    assert.equal(written.reason, 'no-such-account');
  });

  test(name('deleting removes it, and again is a no-op'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a' }));
    await store.putSyncDocument('acct_a', 'open-cut', { baseVersion: 0, document: DOC });

    assert.equal((await store.deleteSyncDocument('acct_a', 'open-cut')).ok, true);
    assert.equal(await store.getSyncDocument('acct_a', 'open-cut'), null);

    const again = await store.deleteSyncDocument('acct_a', 'open-cut');
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'nothing-stored');
  });

  test(name('a deleted document starts again from version 0'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a' }));
    await store.putSyncDocument('acct_a', 'open-cut', { baseVersion: 0, document: DOC });
    await store.deleteSyncDocument('acct_a', 'open-cut');

    assert.equal((await store.putSyncDocument('acct_a', 'open-cut', { baseVersion: 0, document: OTHER })).ok, true);
  });

  test(name('a sync document is not part of the account document'), async (t) => {
    const store = await makeStore(t);
    await store.create(anAccount({ id: 'acct_a' }));
    await store.putSyncDocument('acct_a', 'open-cut', { baseVersion: 0, document: DOC });

    /* Both stores keep it beside the account rather than inside it, so `get()` means the same
       thing in each — and so a Worker's account read does not carry a table it rarely wants. */
    assert.equal('sync' in (await store.get('acct_a')), false);
  });

  /* ── Counting ────────────────────────────────────────────────────────────────────────── */

  test(name('count reflects what exists'), async (t) => {
    const store = await makeStore(t);
    assert.equal(await store.count(), 0);
    await store.create(anAccount());
    await store.create(anAccount());
    assert.equal(await store.count(), 2);
  });
}
