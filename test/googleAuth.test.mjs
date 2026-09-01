/**
 * Google sign-in, end to end, against a real OpenID Connect provider on a real port.
 *
 * The provider in test/helpers/fakeProvider.mjs is not a mock of the verification — it holds
 * an RSA key, publishes a JWKS, signs real ID tokens and checks PKCE and the client secret at
 * its token endpoint. So the happy paths here exercise the signature check, the issuer and
 * audience checks and the PKCE round trip for real, and the negative paths fail for the
 * reasons the code says they should rather than because a stub was told to refuse.
 *
 * THE TESTS THAT MATTER MOST ARE THE ONES THAT REFUSE. A federated sign-in that works is
 * table stakes; a federated sign-in that cannot be used to walk into somebody else's account
 * is the feature. The takeover section at the bottom is the reason this file exists.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createApp } from '../server/app.mjs';
import { startFakeProvider, newKeyPair } from './helpers/fakeProvider.mjs';

const CHEAP = { N: 1024, r: 8, p: 1 };
const PASSWORD = 'a passphrase nobody guesses';

/** A portal wired to a throwaway provider. Both are torn down with the test. */
async function startServer(t, { providerOptions = {} } = {}) {
  const google = await startFakeProvider(providerOptions);
  const dir = await mkdtemp(path.join(tmpdir(), 'novahelp-oauth-'));

  const app = await createApp({
    dataDir: dir,
    dev: true,
    passwordCost: CHEAP,
    logger: { warn() {}, error() {} },
    oauth: {
      google: {
        clientId: google.clientId,
        clientSecret: google.clientSecret,
        endpoints: google.endpoints,
      },
    },
  });

  const server = http.createServer((req, res) => app.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await google.close();
    await rm(dir, { recursive: true, force: true });
  });

  return { origin: `http://127.0.0.1:${server.address().port}`, app, google };
}

/** One browser: one cookie jar, redirects left alone. */
function client(origin) {
  const jar = new Map();

  const stash = (response) => {
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '') jar.delete(name);
      else jar.set(name, value);
    }
  };

  const header = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');

  const go = async (url, options = {}) => {
    const response = await fetch(`${origin}${url}`, {
      redirect: 'manual',
      ...options,
      headers: { ...(options.headers ?? {}), ...(jar.size ? { cookie: header() } : {}) },
    });
    stash(response);
    return response;
  };

  return {
    jar,
    get: (url, options) => go(url, options),
    post: (url, fields, options = {}) =>
      go(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...(options.headers ?? {}) },
        body: new URLSearchParams(fields).toString(),
        ...options,
      }),
  };
}

/** Press "Continue with Google" and read what we would have sent the browser to. */
async function beginGoogle(browser, url = '/account/auth/google') {
  const response = await browser.get(url);
  assert.equal(response.status, 303, `expected a redirect to the provider, got ${response.status}`);

  const target = new URL(response.headers.get('location'));
  return {
    response,
    target,
    state: target.searchParams.get('state'),
    nonce: target.searchParams.get('nonce'),
    challenge: target.searchParams.get('code_challenge'),
  };
}

const callback = (browser, { code, state }) =>
  browser.get(`/account/auth/google/callback?${new URLSearchParams({ ...(code ? { code } : {}), ...(state ? { state } : {}) })}`);

/** The whole round trip, for the many tests that only care about where it ends up. */
async function signInWithGoogle(browser, google, person, { start = '/account/auth/google' } = {}) {
  const flow = await beginGoogle(browser, start);
  const code = google.grant({ ...person, nonce: flow.nonce, challenge: flow.challenge });
  return callback(browser, { code, state: flow.state });
}

const signUpWithPassword = (browser, email, name = 'Ann') =>
  browser.post('/account/new', { email, displayName: name, password: PASSWORD, passwordConfirm: PASSWORD });

/* ── The flow is built correctly ───────────────────────────────────────────────────────── */

test('starting a flow sends the right request and seals the state in a cookie', async (t) => {
  const { origin, google } = await startServer(t);
  const browser = client(origin);

  const flow = await beginGoogle(browser);

  assert.equal(flow.target.origin, google.origin);
  assert.equal(flow.target.pathname, '/authorize');
  assert.equal(flow.target.searchParams.get('client_id'), google.clientId);
  assert.equal(flow.target.searchParams.get('response_type'), 'code');
  assert.equal(flow.target.searchParams.get('code_challenge_method'), 'S256');
  assert.match(flow.target.searchParams.get('scope'), /openid/);
  assert.match(flow.target.searchParams.get('redirect_uri'), /\/account\/auth\/google\/callback$/);
  assert.ok(flow.state && flow.nonce && flow.challenge);

  // The PKCE verifier is never in anything the browser was handed.
  assert.equal(flow.target.searchParams.has('code_verifier'), false);

  const cookie = flow.response.headers.getSetCookie().find((c) => c.startsWith('nova_oauth='));
  assert.ok(cookie, 'the state envelope must be set as a cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/, 'Strict would withhold the cookie on the callback navigation');
  // The state is in the cookie too, but the cookie must not simply be the state.
  assert.equal(cookie.includes(`nova_oauth=${flow.state}`), false);
});

test('the code exchange carries the client secret and the PKCE verifier', async (t) => {
  const { origin, google } = await startServer(t);
  const browser = client(origin);

  await signInWithGoogle(browser, google, { sub: 'g-1', email: 'ann@example.com' });

  assert.equal(google.tokenRequests.length, 1);
  const sent = google.tokenRequests[0];
  assert.equal(sent.grant_type, 'authorization_code');
  assert.equal(sent.client_id, google.clientId);
  assert.equal(sent.client_secret, google.clientSecret);
  assert.ok(sent.code_verifier, 'PKCE verifier must be sent');
  assert.match(sent.redirect_uri, /\/account\/auth\/google\/callback$/);
});

/* ── Successful authentication ─────────────────────────────────────────────────────────── */

test('a first Google sign-in creates a Nova Account and signs it in', async (t) => {
  const { origin, app, google } = await startServer(t);
  const browser = client(origin);

  const done = await signInWithGoogle(browser, google, {
    sub: 'google-sub-1',
    email: 'Ann@Example.com',
    name: 'Ann Example',
  });

  assert.equal(done.status, 303);
  assert.match(done.headers.get('location'), /welcome=created/);
  assert.ok(browser.jar.has('nova_session'), 'a Nova session should have been opened');
  assert.equal(browser.jar.has('nova_oauth'), false, 'the state envelope must be spent');

  const account = await app.ctx.accounts.store.getByEmail('ann@example.com');
  assert.ok(account, 'an account should exist');
  assert.equal(account.email, 'ann@example.com', 'the address is normalised');
  assert.equal(account.displayName, 'Ann Example');
  assert.equal(account.password, null, 'no password is invented for a federated account');
  assert.equal(account.emailVerified, true, 'the provider confirmed the address');
  assert.deepEqual(
    account.identities.map((i) => [i.provider, i.subject]),
    [['google', 'google-sub-1']],
  );

  const page = await browser.get('/account');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /ann@example\.com/);
  assert.match(html, /Connected as ann@example\.com/);
});

test('a second Google sign-in signs in to the same account rather than making another', async (t) => {
  const { origin, app, google } = await startServer(t);

  const first = client(origin);
  await signInWithGoogle(first, google, { sub: 'google-sub-1', email: 'ann@example.com' });
  const created = await app.ctx.accounts.store.getByEmail('ann@example.com');

  const second = client(origin);
  const done = await signInWithGoogle(second, google, { sub: 'google-sub-1', email: 'ann@example.com' });

  assert.equal(done.status, 303);
  assert.match(done.headers.get('location'), /welcome=signed-in/);
  assert.equal(await app.ctx.accounts.count(), 1, 'no second account may be created');

  const page = await second.get('/account').then((r) => r.text());
  assert.match(page, new RegExp(created.id));
});

test('the identity is matched on the provider subject, not on the address', async (t) => {
  const { origin, app, google } = await startServer(t);

  const browser = client(origin);
  await signInWithGoogle(browser, google, { sub: 'google-sub-1', email: 'ann@example.com' });
  const before = await app.ctx.accounts.store.getByEmail('ann@example.com');

  // The same person, who has since changed the address on their Google account.
  const later = client(origin);
  const done = await signInWithGoogle(later, google, { sub: 'google-sub-1', email: 'ann@newplace.example' });

  assert.equal(done.status, 303);
  assert.match(done.headers.get('location'), /welcome=signed-in/);
  assert.equal(await app.ctx.accounts.count(), 1);

  const after = await app.ctx.accounts.store.get(before.id);
  assert.equal(after.email, 'ann@example.com', "a provider must not move a Nova Account's address");
  assert.equal(after.identities[0].email, 'ann@newplace.example', 'but the identity record follows it');
});

test('a Google-created account cannot be opened with a password', async (t) => {
  const { origin, google } = await startServer(t);
  await signInWithGoogle(client(origin), google, { sub: 'google-sub-1', email: 'ann@example.com' });

  const attacker = client(origin);

  /* A guessed password is an authentication failure (401) and an empty one never reaches the
     account at all (422, the form is incomplete). Neither opens a session, which is the part
     that matters — the account has no password, so nothing can match one. */
  for (const [password, status] of [[PASSWORD, 401], [' ', 401], ['null', 401], ['undefined', 401], ['', 422]]) {
    const attempt = await attacker.post('/account/sign-in', { email: 'ann@example.com', password });
    assert.equal(attempt.status, status, `password "${password}" must not open a passwordless account`);
    assert.equal(attacker.jar.has('nova_session'), false);
  }
});

/* ── Linking ───────────────────────────────────────────────────────────────────────────── */

test('a signed-in account can connect Google, and it is the same account', async (t) => {
  const { origin, app, google } = await startServer(t);
  const browser = client(origin);

  await signUpWithPassword(browser, 'ann@example.com');
  const before = await app.ctx.accounts.store.getByEmail('ann@example.com');

  const done = await signInWithGoogle(browser, google, { sub: 'google-sub-1', email: 'ann@example.com' });

  assert.equal(done.status, 303);
  assert.match(done.headers.get('location'), /welcome=linked/);
  assert.equal(await app.ctx.accounts.count(), 1, 'linking must not create a second account');

  const after = await app.ctx.accounts.store.get(before.id);
  assert.deepEqual(after.identities.map((i) => i.subject), ['google-sub-1']);
  assert.equal(after.password, before.password, 'the password is untouched');

  // And now Google alone opens that same account, on a clean device.
  const elsewhere = client(origin);
  const signedIn = await signInWithGoogle(elsewhere, google, { sub: 'google-sub-1', email: 'ann@example.com' });
  assert.match(signedIn.headers.get('location'), /welcome=signed-in/);
  assert.match(await elsewhere.get('/account').then((r) => r.text()), new RegExp(before.id));
});

test('linking works even when the Google address differs from the account address', async (t) => {
  const { origin, app, google } = await startServer(t);
  const browser = client(origin);

  await signUpWithPassword(browser, 'ann@work.example');
  const done = await signInWithGoogle(browser, google, { sub: 'google-sub-1', email: 'ann@personal.example' });

  assert.match(done.headers.get('location'), /welcome=linked/);
  const account = await app.ctx.accounts.store.getByEmail('ann@work.example');
  assert.equal(account.identities[0].email, 'ann@personal.example');
  assert.equal(await app.ctx.accounts.count(), 1);
});

test('connecting the same Google account twice is not an error and changes nothing', async (t) => {
  const { origin, app, google } = await startServer(t);
  const browser = client(origin);

  await signUpWithPassword(browser, 'ann@example.com');
  await signInWithGoogle(browser, google, { sub: 'google-sub-1', email: 'ann@example.com' });
  const after = await signInWithGoogle(browser, google, { sub: 'google-sub-1', email: 'ann@example.com' });

  assert.equal(after.status, 303);
  const account = await app.ctx.accounts.store.getByEmail('ann@example.com');
  assert.equal(account.identities.length, 1, 'no duplicate identity records');
});

test('disconnecting is refused when it is the only way in, and allowed when it is not', async (t) => {
  const { origin, app, google } = await startServer(t);

  // Federated only: no password, one identity.
  const only = client(origin);
  await signInWithGoogle(only, google, { sub: 'google-sub-1', email: 'ann@example.com' });

  const page = await only.get('/account').then((r) => r.text());
  assert.match(page, /Your only way in/);
  assert.equal(page.includes('/account/unlink/google'), false, 'the button must not be offered');

  const refused = await only.post('/account/unlink/google', {});
  assert.match(refused.headers.get('location'), /oauth=last-way-in/);
  const still = await app.ctx.accounts.store.getByEmail('ann@example.com');
  assert.equal(still.identities.length, 1, 'the identity must survive the refusal');
  assert.equal((await only.get('/account')).status, 200, 'and they are still signed in');

  // With a password there is another way in, so disconnecting is fine.
  const both = client(origin);
  await signUpWithPassword(both, 'bob@example.com', 'Bob');
  await signInWithGoogle(both, google, { sub: 'google-sub-2', email: 'bob@example.com' });
  const removed = await both.post('/account/unlink/google', {});
  assert.match(removed.headers.get('location'), /welcome=unlinked/);
  assert.deepEqual((await app.ctx.accounts.store.getByEmail('bob@example.com')).identities, []);
});

test('a disconnected Google identity can be connected to a different account afterwards', async (t) => {
  const { origin, app, google } = await startServer(t);

  const ann = client(origin);
  await signUpWithPassword(ann, 'ann@example.com');
  await signInWithGoogle(ann, google, { sub: 'shared-sub', email: 'ann@example.com' });
  await ann.post('/account/unlink/google', {});

  const bob = client(origin);
  await signUpWithPassword(bob, 'bob@example.com', 'Bob');
  const linked = await signInWithGoogle(bob, google, { sub: 'shared-sub', email: 'bob@example.com' });

  assert.match(linked.headers.get('location'), /welcome=linked/);
  assert.deepEqual((await app.ctx.accounts.store.getByEmail('ann@example.com')).identities, []);
  assert.deepEqual(
    (await app.ctx.accounts.store.getByEmail('bob@example.com')).identities.map((i) => i.subject),
    ['shared-sub'],
  );
});

/* ── Invalid state ─────────────────────────────────────────────────────────────────────── */

test('a callback with no state cookie signs nobody in', async (t) => {
  const { origin, google } = await startServer(t);

  // A flow really was started — in somebody else's browser.
  const attacker = client(origin);
  const flow = await beginGoogle(attacker);
  const code = google.grant({ sub: 'attacker-sub', email: 'attacker@example.com', nonce: flow.nonce, challenge: flow.challenge });

  // The victim's browser is sent to the callback carrying the attacker's code. This is login
  // CSRF, and the missing cookie is what stops it.
  const victim = client(origin);
  const done = await callback(victim, { code, state: flow.state });

  assert.equal(done.status, 303);
  assert.match(done.headers.get('location'), /oauth=failed/);
  assert.equal(victim.jar.has('nova_session'), false, 'no session may be opened');
});

test('a callback whose state does not match the cookie signs nobody in', async (t) => {
  const { origin, app, google } = await startServer(t);
  const browser = client(origin);

  const flow = await beginGoogle(browser);
  const code = google.grant({ sub: 'g-1', email: 'ann@example.com', nonce: flow.nonce, challenge: flow.challenge });

  const done = await callback(browser, { code, state: 'a-state-of-my-own-invention' });
  assert.match(done.headers.get('location'), /oauth=failed/);
  assert.equal(browser.jar.has('nova_session'), false);
  assert.equal(await app.ctx.accounts.count(), 0);
});

test('a tampered state cookie signs nobody in', async (t) => {
  const { origin, google } = await startServer(t);
  const browser = client(origin);

  const flow = await beginGoogle(browser);
  const code = google.grant({ sub: 'g-1', email: 'ann@example.com', nonce: flow.nonce, challenge: flow.challenge });

  const envelope = browser.jar.get('nova_oauth');
  const [body, signature] = [envelope.slice(0, envelope.lastIndexOf('.')), envelope.slice(envelope.lastIndexOf('.') + 1)];

  for (const forged of [`${body}.${signature.slice(0, -2)}xx`, `${body}x.${signature}`, body, 'nonsense']) {
    const response = await fetch(`${origin}/account/auth/google/callback?code=${code}&state=${flow.state}`, {
      redirect: 'manual',
      headers: { cookie: `nova_oauth=${encodeURIComponent(forged)}` },
    });
    assert.match(response.headers.get('location'), /oauth=failed/, 'a forged envelope must be refused');
    assert.equal((response.headers.getSetCookie() ?? []).some((c) => c.startsWith('nova_session=')), false);
  }
});

test('the state envelope is single use', async (t) => {
  const { origin, google } = await startServer(t);
  const browser = client(origin);

  const flow = await beginGoogle(browser);
  const first = google.grant({ sub: 'g-1', email: 'ann@example.com', nonce: flow.nonce, challenge: flow.challenge });
  const replay = google.grant({ sub: 'g-1', email: 'ann@example.com', nonce: flow.nonce, challenge: flow.challenge });

  const ok = await callback(browser, { code: first, state: flow.state });
  assert.match(ok.headers.get('location'), /welcome=created/);
  assert.equal(browser.jar.has('nova_oauth'), false, 'the envelope must be cleared on use');

  /* The same state, replayed with a fresh code from the same flow. There is no envelope left
     to open, so it is refused like any other callback that cannot prove this browser started
     it — and because they are now signed in, the refusal lands on their account page. */
  const again = await callback(browser, { code: replay, state: flow.state });
  assert.match(again.headers.get('location'), /^\/account\?oauth=failed/);
});

test('a callback for a provider that was not the one the flow started with is refused', async (t) => {
  const { origin, google } = await startServer(t);
  const browser = client(origin);

  const flow = await beginGoogle(browser);
  const code = google.grant({ sub: 'g-1', email: 'ann@example.com', nonce: flow.nonce, challenge: flow.challenge });

  const done = await browser.get(`/account/auth/apple/callback?code=${code}&state=${flow.state}`);
  assert.match(done.headers.get('location'), /oauth=failed/);
  assert.equal(browser.jar.has('nova_session'), false);
});

test('the provider saying "the person cancelled" is not treated as a sign-in', async (t) => {
  const { origin } = await startServer(t);
  const browser = client(origin);

  await beginGoogle(browser);
  const done = await browser.get('/account/auth/google/callback?error=access_denied&state=whatever');

  assert.match(done.headers.get('location'), /oauth=cancelled/);
  assert.equal(browser.jar.has('nova_session'), false);
});

test('a callback with a state but no code is refused', async (t) => {
  const { origin } = await startServer(t);
  const browser = client(origin);

  const flow = await beginGoogle(browser);
  const done = await callback(browser, { state: flow.state });

  assert.match(done.headers.get('location'), /oauth=failed/);
  assert.equal(browser.jar.has('nova_session'), false);
});

/* ── Invalid tokens ────────────────────────────────────────────────────────────────────── */

test('an identity token that fails any check signs nobody in', async (t) => {
  const other = newKeyPair();
  const stale = Math.floor(Date.now() / 1000) - 7200;

  const forgeries = {
    'signed with the wrong key': { signWith: other.privateKey },
    'wrong issuer': { claims: { iss: 'https://accounts.evil.example' } },
    'wrong audience': { claims: { aud: 'some-other-client.apps.googleusercontent.com' } },
    expired: { claims: { iat: stale, exp: stale + 60 } },
    'mismatched nonce': { nonceOverride: 'a-nonce-from-another-flow' },
    'no subject': { claims: { sub: undefined } },
    'unknown signing key': { header: { kid: 'a-key-that-was-never-published' } },
    'algorithm "none"': { header: { alg: 'none' } },
    'symmetric algorithm': { header: { alg: 'HS256' } },
  };

  for (const [label, forgery] of Object.entries(forgeries)) {
    const { origin, app, google } = await startServer(t);
    const browser = client(origin);

    const flow = await beginGoogle(browser);
    const code = google.grant({
      sub: 'g-1',
      email: 'ann@example.com',
      nonce: forgery.nonceOverride ?? flow.nonce,
      challenge: flow.challenge,
      claims: forgery.claims,
      signWith: forgery.signWith,
      header: forgery.header,
    });

    const done = await callback(browser, { code, state: flow.state });

    assert.match(done.headers.get('location'), /oauth=failed/, `${label} should be refused`);
    assert.equal(browser.jar.has('nova_session'), false, `${label} must not open a session`);
    assert.equal(await app.ctx.accounts.count(), 0, `${label} must not create an account`);
  }
});

test('a broken PKCE verifier means the provider never issues a token', async (t) => {
  const { origin, app, google } = await startServer(t);
  const browser = client(origin);

  const flow = await beginGoogle(browser);
  // A code minted against a challenge from some other flow: our verifier will not match it.
  const code = google.grant({
    sub: 'g-1',
    email: 'ann@example.com',
    nonce: flow.nonce,
    challenge: 'a-challenge-from-a-different-flow',
  });

  const done = await callback(browser, { code, state: flow.state });
  assert.match(done.headers.get('location'), /oauth=failed/);
  assert.equal(await app.ctx.accounts.count(), 0);
});

test('an unknown authorization code signs nobody in', async (t) => {
  const { origin, app } = await startServer(t);
  const browser = client(origin);

  const flow = await beginGoogle(browser);
  const done = await callback(browser, { code: 'a-code-nobody-issued', state: flow.state });

  assert.match(done.headers.get('location'), /oauth=failed/);
  assert.equal(await app.ctx.accounts.count(), 0);
});

/* ── Preventing takeover through unsafe automatic linking ──────────────────────────────── */

test('ATTACKER FIRST: a password account on an address does not absorb that address Google identity', async (t) => {
  const { origin, app, google } = await startServer(t);

  /* An attacker registers the victim's address. Nothing sends mail, so nothing stopped them
     claiming it — which is exactly the situation the linking rule exists for. */
  const attacker = client(origin);
  await signUpWithPassword(attacker, 'victim@example.com', 'Not The Victim');
  const attackerAccount = await app.ctx.accounts.store.getByEmail('victim@example.com');

  // The real owner of the address arrives with Google.
  const victim = client(origin);
  const done = await signInWithGoogle(victim, google, {
    sub: 'the-real-victim',
    email: 'victim@example.com',
  });

  assert.equal(done.status, 303);
  assert.match(done.headers.get('location'), /oauth=email-has-account/);

  // Nothing happened: no session, no link, no second account.
  assert.equal(victim.jar.has('nova_session'), false, 'the victim must NOT be signed into the attacker account');
  assert.equal(await app.ctx.accounts.count(), 1, 'and no account may be created behind the refusal');

  const unchanged = await app.ctx.accounts.store.get(attackerAccount.id);
  assert.deepEqual(unchanged.identities, [], "the attacker's account must not gain the victim's identity");

  // The refusal explains the way through rather than dead-ending.
  const page = await victim.get('/account/sign-in?oauth=email-has-account').then((r) => r.text());
  assert.match(page, /already has a Nova Account/);
  assert.match(page, /Sign in with your password/);
});

test('ATTACKER SECOND: a Google identity asserting an existing account address is refused', async (t) => {
  const { origin, app, google } = await startServer(t);

  const victim = client(origin);
  await signUpWithPassword(victim, 'victim@example.com', 'Victim');
  const victimAccount = await app.ctx.accounts.store.getByEmail('victim@example.com');
  const victimTicket = await fileTicket(victim, origin);

  // An attacker turns up with a provider identity claiming the victim's address.
  const attacker = client(origin);
  const done = await signInWithGoogle(attacker, google, {
    sub: 'attacker-google-sub',
    email: 'victim@example.com',
  });

  assert.match(done.headers.get('location'), /oauth=email-has-account/);
  assert.equal(attacker.jar.has('nova_session'), false);
  assert.equal(await app.ctx.accounts.count(), 1);

  const unchanged = await app.ctx.accounts.store.get(victimAccount.id);
  assert.deepEqual(unchanged.identities, []);

  // And the thing that would have been stolen is still not reachable.
  assert.equal((await attacker.get(`/tickets/${victimTicket}`)).status, 403);
});

test('a provider identity already on one account cannot be attached to another', async (t) => {
  const { origin, app, google } = await startServer(t);

  const ann = client(origin);
  await signInWithGoogle(ann, google, { sub: 'shared-sub', email: 'ann@example.com' });
  const annAccount = await app.ctx.accounts.store.getByEmail('ann@example.com');

  const bob = client(origin);
  await signUpWithPassword(bob, 'bob@example.com', 'Bob');
  const done = await signInWithGoogle(bob, google, { sub: 'shared-sub', email: 'ann@example.com' });

  assert.match(done.headers.get('location'), /oauth=identity-taken/);

  const stillAnns = await app.ctx.accounts.store.getByIdentity('google', 'shared-sub');
  assert.equal(stillAnns.id, annAccount.id, 'the identity must stay where it was');
  assert.deepEqual((await app.ctx.accounts.store.getByEmail('bob@example.com')).identities, []);
});

test('a provider that will not vouch for the address is refused outright', async (t) => {
  const { origin, app, google } = await startServer(t);

  /* Set as a raw claim rather than through the helper, so that `undefined` really means the
     claim is absent from the token instead of falling back to the helper's default. */
  for (const claimed of [false, 'false', undefined, null, 'yes', 1]) {
    const browser = client(origin);
    const done = await signInWithGoogle(browser, google, {
      sub: `unverified-${String(claimed)}`,
      email: 'someone@example.com',
      claims: { email_verified: claimed },
    });

    assert.match(done.headers.get('location'), /oauth=unverified/, `email_verified=${claimed} must be refused`);
    assert.equal(browser.jar.has('nova_session'), false);
  }
  assert.equal(await app.ctx.accounts.count(), 0, 'no account may be created without a confirmed address');
});

test('a token carrying no address at all is refused', async (t) => {
  const { origin, app, google } = await startServer(t);
  const browser = client(origin);

  const flow = await beginGoogle(browser);
  const code = google.grant({
    sub: 'no-email',
    nonce: flow.nonce,
    challenge: flow.challenge,
    claims: { email: undefined },
  });

  const done = await callback(browser, { code, state: flow.state });
  assert.match(done.headers.get('location'), /oauth=unverified/);
  assert.equal(await app.ctx.accounts.count(), 0);
});

test('a linked Google account opens only its own tickets', async (t) => {
  const { origin, google } = await startServer(t);

  const ann = client(origin);
  await signInWithGoogle(ann, google, { sub: 'g-ann', email: 'ann@example.com' });
  const annsTicket = await fileTicket(ann, origin);

  const bob = client(origin);
  await signInWithGoogle(bob, google, { sub: 'g-bob', email: 'bob@example.com' });

  assert.equal((await bob.get(`/tickets/${annsTicket}`)).status, 403);
  assert.equal((await ann.get(`/tickets/${annsTicket}`)).status, 200);
  assert.equal((await bob.get('/account').then((r) => r.text())).includes(annsTicket), false);
});

/* ── Everything that was working still works ───────────────────────────────────────────── */

const FLOW = '/help/online-earth/globe/globe-not-loading';

async function fileTicket(browser, origin, overrides = {}) {
  const response = await browser.post(FLOW, {
    subject: 'The globe never finishes loading',
    description: 'It sits on the loading spinner forever on a fresh profile, on two machines.',
    priority: 'high',
    ...overrides,
  });
  assert.equal(response.status, 303, await response.text());
  return decodeURIComponent(response.headers.get('location').split('/').pop().split('?')[0]);
}

test('guest and password flows are untouched by any of this', async (t) => {
  const { origin, app } = await startServer(t);

  // Guest: no account, email on the ticket, ID + address to get back in.
  const guest = client(origin);
  const id = await fileTicket(guest, origin, { email: 'guest@example.com', name: 'Gus' });
  assert.equal((await app.ctx.tickets.get(id)).accountId, null);
  assert.equal((await guest.get(`/tickets/${id}`)).status, 200);

  const elsewhere = client(origin);
  const lookup = await elsewhere.post('/tickets', { ticketId: id, email: 'guest@example.com' });
  assert.equal(lookup.status, 303);

  // Password: still works, still owns its tickets.
  const ann = client(origin);
  await signUpWithPassword(ann, 'ann@example.com');
  const mine = await fileTicket(ann, origin);
  const account = await app.ctx.accounts.store.getByEmail('ann@example.com');
  assert.equal((await app.ctx.tickets.get(mine)).accountId, account.id);

  const again = client(origin);
  const signedIn = await again.post('/account/sign-in', { email: 'ann@example.com', password: PASSWORD });
  assert.equal(signedIn.status, 303);
});

test('a ticket filed while signed in with Google belongs to that account', async (t) => {
  const { origin, app, google } = await startServer(t);
  const browser = client(origin);

  await signInWithGoogle(browser, google, { sub: 'g-1', email: 'ann@example.com', name: 'Ann' });

  const form = await browser.get(FLOW).then((r) => r.text());
  assert.match(form, /Filing as Ann/);
  assert.equal(/<input[^>]*id="email"/.test(form), false);

  const id = await fileTicket(browser, origin, { email: 'someone-else@example.com' });
  const stored = await app.ctx.tickets.get(id);
  const account = await app.ctx.accounts.store.getByEmail('ann@example.com');

  assert.equal(stored.accountId, account.id);
  assert.equal(stored.requester.email, 'ann@example.com', 'the session decides the address');
});

test('a Google sign-in returns the person to where they were going', async (t) => {
  const { origin, google } = await startServer(t);
  const browser = client(origin);

  const done = await signInWithGoogle(
    browser,
    google,
    { sub: 'g-1', email: 'ann@example.com' },
    { start: `/account/auth/google?next=${encodeURIComponent(FLOW)}` },
  );

  assert.equal(done.headers.get('location'), FLOW);
});

test('next= cannot be used to bounce somebody off the site', async (t) => {
  const { origin, google } = await startServer(t);

  for (const hostile of ['https://evil.example/steal', '//evil.example', '/\\evil.example']) {
    const browser = client(origin);
    const done = await signInWithGoogle(
      browser,
      google,
      { sub: `g-${Math.random()}`, email: `user-${Math.random().toString(36).slice(2, 8)}@example.com` },
      { start: `/account/auth/google?next=${encodeURIComponent(hostile)}` },
    );
    assert.ok(done.headers.get('location').startsWith('/account'), `next=${hostile} escaped to ${done.headers.get('location')}`);
  }
});

/* ── Configuration ─────────────────────────────────────────────────────────────────────── */

test('with no provider configured the site is exactly what it was', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'novahelp-nooauth-'));
  const app = await createApp({ dataDir: dir, dev: true, passwordCost: CHEAP, logger: { warn() {}, error() {} } });
  const server = http.createServer((req, res) => app.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  const browser = client(origin);
  const signIn = await browser.get('/account/sign-in').then((r) => r.text());
  assert.equal(signIn.includes('Continue with Google'), false, 'no button for an unconfigured provider');
  assert.equal(signIn.includes('providers__or'), false);
  assert.match(signIn, /Sign in to Nova/, 'the password form is still there');

  // And the routes do not quietly work.
  const started = await browser.get('/account/auth/google');
  assert.equal(started.status, 404);
  assert.equal(browser.jar.has('nova_oauth'), false);

  // Password sign-up still works end to end.
  assert.equal((await signUpWithPassword(browser, 'ann@example.com')).status, 303);
  assert.equal((await browser.get('/account')).status, 200);
});

test('a half-configured provider is ignored rather than half-offered', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'novahelp-halfoauth-'));
  const warnings = [];
  const app = await createApp({
    dataDir: dir,
    dev: true,
    passwordCost: CHEAP,
    logger: { warn: (m) => warnings.push(m), error() {} },
    oauth: { google: { clientId: 'only-an-id' } },
  });
  t.after(() => rm(dir, { recursive: true, force: true }));

  assert.equal(app.ctx.accounts.providers.enabled, false);
  assert.ok(warnings.some((w) => /half-configured/.test(w)), 'it should say so loudly');
});

/* ── Extensibility ─────────────────────────────────────────────────────────────────────── */

test('a second provider drops in without Nova Accounts changing', async (t) => {
  /* Standing up a whole second provider through the generic OIDC client is the test: if
     adding Apple or Discord needed a change to the account model, the store or the service,
     this would not compile, let alone pass. */
  const { createOidcProvider } = await import('../server/accounts/providers/oidc.mjs');
  const acme = await startFakeProvider({ clientId: 'acme-client', clientSecret: 'acme-secret' });
  const dir = await mkdtemp(path.join(tmpdir(), 'novahelp-acme-'));

  const app = await createApp({ dataDir: dir, dev: true, passwordCost: CHEAP, logger: { warn() {}, error() {} } });
  t.after(async () => {
    await acme.close();
    await rm(dir, { recursive: true, force: true });
  });

  const provider = createOidcProvider({
    id: 'acme',
    label: 'Acme',
    clientId: acme.clientId,
    clientSecret: acme.clientSecret,
    ...acme.endpoints,
  });

  assert.equal(provider.id, 'acme');
  const url = new URL(
    provider.authorizationUrl({
      state: 's',
      nonce: 'n',
      codeVerifier: 'v'.repeat(43),
      redirectUri: 'https://nova.help/account/auth/acme/callback',
    }),
  );
  assert.equal(url.searchParams.get('client_id'), 'acme-client');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');

  // And the account service accepts its identity through the same one method Google uses.
  const result = await app.ctx.accounts.withProviderIdentity({
    provider: 'acme',
    subject: 'acme-person-1',
    email: 'person@acme.example',
    emailVerified: true,
    displayName: 'A Person',
  });

  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'created');
  const stored = await app.ctx.accounts.store.getByIdentity('acme', 'acme-person-1');
  assert.equal(stored.email, 'person@acme.example');
  assert.equal(stored.identities[0].provider, 'acme');
});
