/**
 * The device grant, end to end — an app and a browser, both driven for real.
 *
 * The store contract proves the state machine behaves. These prove the portal wired it up:
 * that an app can actually get a token, that the token opens only what its scopes say, that
 * the two kinds of proof cannot be swapped for each other, and — the ones that matter most —
 * that each refusal actually refuses.
 *
 * Two clients throughout, deliberately:
 *
 *   `app`      speaks JSON and holds a bearer token. Never has a cookie.
 *   `browser`  holds a session cookie and posts forms. Never sees a bearer token.
 *
 * Anything that works when a value is moved from one to the other is a bug, and there are
 * tests below whose only purpose is to try exactly that.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createApp } from '../server/app.mjs';

const CHEAP = { N: 1024, r: 8, p: 1 };
const PASSWORD = 'a passphrase nobody guesses';

async function startServer(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'novahelp-device-'));
  const app = await createApp({
    dataDir: dir,
    dev: true,
    passwordCost: CHEAP,
    logger: { warn() {}, error() {} },
  });
  const server = http.createServer((req, res) => app.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  return { origin, dir, app };
}

/** A browser: one cookie jar, redirects left alone so a test can assert on them. */
function browserClient(origin) {
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

/** An installed app: JSON in, JSON out, a bearer token, and no cookie jar at all. */
function appClient(origin) {
  let token = null;

  const call = async (method, url, body, { auth = true, headers = {} } = {}) => {
    const response = await fetch(`${origin}${url}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(auth && token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, json, text, headers: response.headers };
  };

  return {
    get token() {
      return token;
    },
    set token(value) {
      token = value;
    },
    get: (url, options) => call('GET', url, undefined, options),
    post: (url, body, options) => call('POST', url, body ?? {}, options),
    put: (url, body, options) => call('PUT', url, body ?? {}, options),
  };
}

async function signUp(browser, { email = 'ann@example.com', name = 'Ann' } = {}) {
  const response = await browser.post('/account/new', {
    email,
    displayName: name,
    password: PASSWORD,
    passwordConfirm: PASSWORD,
  });
  assert.equal(response.status, 303, await response.text());
}

/**
 * The whole happy path, as one helper, because most tests below start from "an app is
 * connected" and only the first few are about getting there.
 */
async function connect(origin, { product = 'open-cut', scope = 'identity sync', email = 'ann@example.com' } = {}) {
  const app = appClient(origin);
  const browser = browserClient(origin);
  await signUp(browser, { email });

  const started = await app.post('/api/device/code', { product, scope, device_name: 'A laptop' });
  assert.equal(started.status, 201, started.text);

  const approved = await browser.post('/account/device', {
    code: started.json.user_code,
    action: 'approve',
  });
  assert.equal(approved.status, 303, 'approving redirects');

  const polled = await app.post('/api/device/token', { device_code: started.json.device_code });
  assert.equal(polled.status, 200, polled.text);
  app.token = polled.json.access_token;

  return { app, browser, started, polled };
}

/* ── The happy path ────────────────────────────────────────────────────────────────────── */

test('an app signs in without ever seeing a password', async (t) => {
  const { origin } = await startServer(t);
  const { app, started, polled } = await connect(origin);

  assert.match(started.json.user_code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(started.json.verification_uri.endsWith('/account/device'), true);
  assert.equal(started.json.interval, 5);
  assert.equal(polled.json.token_type, 'Bearer');

  /* The one assertion this whole flow exists for: the app never handled the password, and the
     credential it holds is not the browser's. */
  assert.equal(polled.text.includes(PASSWORD), false);
  assert.equal(app.token.includes('nova_session'), false);

  const me = await app.get('/api/account');
  assert.equal(me.status, 200);
  assert.equal(me.json.account.displayName, 'Ann');
  assert.equal(me.json.product, 'open-cut');
});

test('a poll before anybody approves says "still waiting", and does not spend the grant', async (t) => {
  const { origin } = await startServer(t);
  const app = appClient(origin);
  const browser = browserClient(origin);
  await signUp(browser);

  const started = await app.post('/api/device/code', { product: 'atlas', scope: 'identity' });
  const pending = await app.post('/api/device/token', { device_code: started.json.device_code });
  assert.equal(pending.status, 400);
  assert.equal(pending.json.error, 'authorization_pending');

  await browser.post('/account/device', { code: started.json.user_code, action: 'approve' });

  /* Asked again a millisecond later, so this is the impatient client rather than the patient
     one — and `slow_down` is the answer that proves the point: a grant that had been consumed
     by the early poll would come back `expired_token` instead. It is still there, waiting for
     a client that respects the interval it was given. */
  const impatient = await app.post('/api/device/token', { device_code: started.json.device_code });
  assert.equal(impatient.json.error, 'slow_down', 'the grant survived being polled early');
});

test('the code a person types is forgiving about case, spacing and the dash', async (t) => {
  const { origin } = await startServer(t);
  const app = appClient(origin);
  const browser = browserClient(origin);
  await signUp(browser);

  const started = await app.post('/api/device/code', { product: 'replay-gg' });
  const typed = started.json.user_code.toLowerCase().replace('-', ' ');

  const approved = await browser.post('/account/device', { code: typed, action: 'approve' });
  assert.equal(approved.status, 303);
  assert.equal((await app.post('/api/device/token', { device_code: started.json.device_code })).status, 200);
});

/* ── Refusals ──────────────────────────────────────────────────────────────────────────── */

test('a grant is redeemed once — a replayed device code gets nothing', async (t) => {
  const { origin } = await startServer(t);
  const { app, started } = await connect(origin);

  const again = await app.post('/api/device/token', { device_code: started.json.device_code });
  assert.equal(again.status, 400);
  assert.equal(again.json.error, 'expired_token', 'two devices must not hold one approval');
});

test('refusing on the page means the app gets nothing', async (t) => {
  const { origin } = await startServer(t);
  const app = appClient(origin);
  const browser = browserClient(origin);
  await signUp(browser);

  const started = await app.post('/api/device/code', { product: 'open-cut' });
  await browser.post('/account/device', { code: started.json.user_code, action: 'deny' });

  const polled = await app.post('/api/device/token', { device_code: started.json.device_code });
  assert.equal(polled.status, 403);
  assert.equal(polled.json.error, 'access_denied');
});

test('a product that is not registered may not start a flow', async (t) => {
  const { origin } = await startServer(t);
  const app = appClient(origin);

  const started = await app.post('/api/device/code', { product: 'not-a-nova-product' });
  assert.equal(started.status, 400);
  assert.equal(started.json.error, 'unauthorized_client');
});

test('a WEB product may not mint itself a bearer token', async (t) => {
  const { origin } = await startServer(t);
  const app = appClient(origin);

  /* Nova.Help and the Nova site sign in with a cookie at their own origin. If a page could run
     this flow it would be handing itself a credential that outlives its own session. */
  for (const product of ['nova.help', 'nova']) {
    const started = await app.post('/api/device/code', { product });
    assert.equal(started.json.error, 'unauthorized_client', `${product} must be refused`);
  }
});

test('an unknown device code is refused exactly like a lapsed one', async (t) => {
  const { origin } = await startServer(t);
  const app = appClient(origin);

  const guess = await app.post('/api/device/token', { device_code: 'not-a-real-code' });
  assert.equal(guess.status, 400);
  assert.equal(guess.json.error, 'expired_token', 'so polling cannot enumerate live codes');
});

test('approving requires a signed-in person, and brings them back to the code', async (t) => {
  const { origin } = await startServer(t);
  const app = appClient(origin);
  const stranger = browserClient(origin);

  const started = await app.post('/api/device/code', { product: 'atlas' });
  const attempt = await stranger.post('/account/device', {
    code: started.json.user_code,
    action: 'approve',
  });

  assert.equal(attempt.status, 303);
  assert.match(attempt.headers.get('location'), /^\/account\/sign-in\?next=/);
  assert.equal(
    (await app.post('/api/device/token', { device_code: started.json.device_code })).json.error,
    'authorization_pending',
    'nothing was approved',
  );
});

test('a signed-out visitor with no code still gets the page, not a redirect', async (t) => {
  const { origin } = await startServer(t);
  const browser = browserClient(origin);

  /* The page explains itself before asking for anything. That is the difference between an
     invitation and a wall, and this whole feature is meant to be the former. */
  const response = await browser.get('/account/device');
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Connect an app/);
  assert.match(html, /Connecting is optional/);
});

/* ── The two proofs do not mix ─────────────────────────────────────────────────────────── */

test('a product token is not a session cookie', async (t) => {
  const { origin } = await startServer(t);
  const { app } = await connect(origin);

  /* The token is signed under a key derived for products, not for sessions, so presenting it
     as a cookie fails the signature check before anything is looked up. Without that key
     split, a token leaking out of a desktop app's config file would be a browser login. */
  const impostor = await fetch(`${origin}/account`, {
    redirect: 'manual',
    headers: { cookie: `nova_session=${app.token}` },
  });
  assert.equal(impostor.status, 303);
  assert.match(impostor.headers.get('location'), /sign-in/);
});

test('a session cookie is not a product token', async (t) => {
  const { origin } = await startServer(t);
  const { browser } = await connect(origin);

  const cookie = browser.jar.get('nova_session');
  assert.ok(cookie, 'the browser has one');

  const response = await fetch(`${origin}/api/account`, {
    headers: { authorization: `Bearer ${cookie}` },
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'invalid_grant');
});

test('the app endpoints ignore a cookie entirely', async (t) => {
  const { origin } = await startServer(t);
  const { browser } = await connect(origin);

  /* A signed-in browser hitting the app endpoint is still not an app. If a cookie were
     honoured here, every scope restriction would be optional for anything that could get one. */
  const response = await fetch(`${origin}/api/account`, {
    headers: { cookie: `nova_session=${browser.jar.get('nova_session')}` },
  });
  assert.equal(response.status, 400);
});

/* ── Scopes ────────────────────────────────────────────────────────────────────────────── */

test('an app gets only the scopes its product is allowed, however it asks', async (t) => {
  const { origin } = await startServer(t);
  const app = appClient(origin);
  const browser = browserClient(origin);
  await signUp(browser);

  /* Replay.GG is registered for `support` and nothing else. Asking for `email` and `sync`
     must come back without them rather than as an error — a product whose author got the
     list slightly wrong should still be usable. */
  const started = await app.post('/api/device/code', {
    product: 'replay-gg',
    scope: 'identity email sync support made-up',
  });
  assert.equal(started.json.scope, 'identity support');

  await browser.post('/account/device', { code: started.json.user_code, action: 'approve' });
  const polled = await app.post('/api/device/token', { device_code: started.json.device_code });
  app.token = polled.json.access_token;

  assert.equal(polled.json.scope, 'identity support');
  assert.equal('email' in polled.json.account, false, 'no address it was not granted');
  assert.equal(polled.json.account.displayName, 'Ann', 'but it knows who it is');
});

test('the email address arrives only when the scope was granted', async (t) => {
  const { origin } = await startServer(t);

  const without = await connect(origin, { product: 'open-cut', scope: 'identity sync' });
  assert.equal('email' in without.polled.json.account, false);

  /* No Nova product asks for `email` on a device today, and the registry is what decides it —
     so this asserts the OTHER half: asking loudly does not get it either. */
  const asked = await without.app.post('/api/device/code', { product: 'open-cut', scope: 'email' });
  assert.equal(asked.json.scope, 'identity');
});

test('an app without the sync scope cannot touch sync', async (t) => {
  const { origin } = await startServer(t);
  const { app } = await connect(origin, { product: 'replay-gg', scope: 'identity support' });

  assert.equal((await app.get('/api/sync')).status, 403);
  assert.equal((await app.put('/api/sync', { baseVersion: 0, data: { a: 1 } })).status, 403);
});

/* ── Sync ──────────────────────────────────────────────────────────────────────────────── */

test('a product syncs a document and reads it back', async (t) => {
  const { origin } = await startServer(t);
  const { app } = await connect(origin);

  assert.deepEqual((await app.get('/api/sync')).json, { version: 0, updatedAt: null, data: null });

  const written = await app.put('/api/sync', { baseVersion: 0, data: { theme: 'midnight' } });
  assert.equal(written.status, 200);
  assert.equal(written.json.version, 1);

  const read = await app.get('/api/sync');
  assert.deepEqual(read.json.data, { theme: 'midnight' });
  assert.equal(read.json.version, 1);
});

test('a stale write is REFUSED and hands back what it lost the race to', async (t) => {
  const { origin } = await startServer(t);
  const { app } = await connect(origin);

  await app.put('/api/sync', { baseVersion: 0, data: { theme: 'midnight' } });
  await app.put('/api/sync', { baseVersion: 1, data: { theme: 'daylight' } });

  const stale = await app.put('/api/sync', { baseVersion: 1, data: { theme: 'clobbered' } });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error, 'conflict');
  assert.deepEqual(stale.json.current.data, { theme: 'daylight' }, 'so the client can merge');
  assert.deepEqual((await app.get('/api/sync')).json.data, { theme: 'daylight' }, 'unchanged');
});

test('a fresh install cannot flatten an existing document by claiming it has never synced', async (t) => {
  const { origin } = await startServer(t);
  const { app, browser } = await connect(origin);
  await app.put('/api/sync', { baseVersion: 0, data: { savedPlaces: ['home', 'work'] } });

  /* The second machine. Same account, new device, empty local state — and the moment it
     pushes, a year of settings is either safe or gone. This is that moment. */
  const second = appClient(origin);
  const started = await second.post('/api/device/code', { product: 'open-cut', scope: 'sync' });
  await browser.post('/account/device', { code: started.json.user_code, action: 'approve' });
  second.token = (await second.post('/api/device/token', { device_code: started.json.device_code })).json
    .access_token;

  const naive = await second.put('/api/sync', { baseVersion: 0, data: {} });
  assert.equal(naive.status, 409, 'refused, not applied');
  assert.deepEqual(naive.json.current.data, { savedPlaces: ['home', 'work'] });
  assert.deepEqual((await app.get('/api/sync')).json.data, { savedPlaces: ['home', 'work'] });
});

test('one product cannot read another product’s document', async (t) => {
  const { origin } = await startServer(t);
  const { app, browser } = await connect(origin, { product: 'open-cut', scope: 'sync' });
  await app.put('/api/sync', { baseVersion: 0, data: { secret: 'open cut only' } });

  const atlas = appClient(origin);
  const started = await atlas.post('/api/device/code', { product: 'atlas', scope: 'sync' });
  await browser.post('/account/device', { code: started.json.user_code, action: 'approve' });
  atlas.token = (await atlas.post('/api/device/token', { device_code: started.json.device_code })).json
    .access_token;

  /* There is no parameter to tamper with: the product half of the key comes from the token. */
  assert.deepEqual((await atlas.get('/api/sync')).json, { version: 0, updatedAt: null, data: null });
});

test('a document larger than the limit is refused rather than truncated', async (t) => {
  const { origin } = await startServer(t);
  const { app } = await connect(origin);

  const huge = await app.put('/api/sync', { baseVersion: 0, data: { blob: 'x'.repeat(300 * 1024) } });
  assert.equal(huge.status, 413);
  assert.deepEqual((await app.get('/api/sync')).json.data, null, 'and nothing was stored');
});

/* ── Signing out ───────────────────────────────────────────────────────────────────────── */

test('an app can sign itself out, and its token stops working', async (t) => {
  const { origin } = await startServer(t);
  const { app } = await connect(origin);

  assert.equal((await app.post('/api/device/sign-out')).status, 200);
  assert.equal((await app.get('/api/account')).status, 400, 'the session is gone, not just the copy');
});

test('signing an app out does NOT delete what it synced', async (t) => {
  const { origin } = await startServer(t);
  const { app, browser } = await connect(origin);
  await app.put('/api/sync', { baseVersion: 0, data: { theme: 'midnight' } });
  await app.post('/api/device/sign-out');

  /* "Sign out" must never be a data-loss button. Signing back in finds the document intact. */
  const again = appClient(origin);
  const started = await again.post('/api/device/code', { product: 'open-cut', scope: 'sync' });
  await browser.post('/account/device', { code: started.json.user_code, action: 'approve' });
  again.token = (await again.post('/api/device/token', { device_code: started.json.device_code })).json
    .access_token;

  assert.deepEqual((await again.get('/api/sync')).json.data, { theme: 'midnight' });
});

test('the account page lists connected apps and can sign one out', async (t) => {
  const { origin } = await startServer(t);
  const { app, browser } = await connect(origin);

  const page = await browser.get('/account').then((r) => r.text());
  assert.match(page, /Open Cut/, 'the product is named');
  assert.match(page, /A laptop/, 'and the device it said it was');

  const session = /name="session" value="([^"]+)"/.exec(page)?.[1];
  assert.ok(session, 'with a way to sign it out');

  const revoked = await browser.post('/account/devices/revoke', { session });
  assert.equal(revoked.status, 303);
  assert.equal((await app.get('/api/account')).status, 400, 'the app is signed out');
});

test('signing out everywhere signs the apps out too', async (t) => {
  const { origin } = await startServer(t);
  const { app, browser } = await connect(origin);

  /* This is the "I lost my laptop" button, and it is only true if it reaches installed apps as
     well as browsers. It does because a device session lives in the same session list. */
  assert.equal((await browser.post('/account/sign-out-everywhere', {})).status, 303);
  assert.equal((await app.get('/api/account')).status, 400);
});

test('a password reset signs the apps out too', async (t) => {
  const { origin, app: server } = await startServer(t);
  const { app } = await connect(origin);

  await server.ctx.accounts.signOutEverywhere(
    (await server.ctx.accounts.store.getByEmail('ann@example.com')).id,
  );
  assert.equal((await app.get('/api/account')).status, 400);
});

/* ── Nothing was taken away ────────────────────────────────────────────────────────────── */

test('the guest path is untouched by any of this', async (t) => {
  const { origin } = await startServer(t);
  const browser = browserClient(origin);

  const home = await browser.get('/').then((r) => r.text());
  assert.match(home, /What do you need help with\?/);
  assert.equal(home.includes('You must sign in'), false);

  /* And a guest can still file a ticket without an account, which is the promise the whole
     feature is written around. */
  const filed = await browser.post('/help/online-earth/globe/globe-not-loading', {
    subject: 'The globe never finishes loading',
    description: 'It sits on the loading spinner forever on a fresh profile, on two machines.',
    email: 'guest@example.com',
    name: 'A guest',
    priority: 'high',
  });
  assert.equal(filed.status, 303, 'still files');
});

/* ── Reachable from another origin ─────────────────────────────────────────────────────────
 *
 * Online Earth is a web page: in the desktop shell it runs on a `file://` origin, and in a
 * browser on its own. Every call it makes to these endpoints is cross-origin, so without CORS
 * headers a browser refuses to show it the response and the app can never sign in — which is
 * exactly the "could not reach Nova Accounts" symptom, with the server answering perfectly.
 */

test('the app endpoints answer a preflight', async (t) => {
  const { origin } = await startServer(t);

  const response = await fetch(`${origin}/api/device/code`, {
    method: 'OPTIONS',
    headers: {
      origin: 'null',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization, content-type',
    },
  });

  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.match(response.headers.get('access-control-allow-headers'), /authorization/i);
});

test('every app endpoint allows a cross-origin read, and NONE allows credentials', async (t) => {
  const { origin } = await startServer(t);
  const { app } = await connect(origin);

  for (const [method, path] of [
    ['POST', '/api/device/code'],
    ['POST', '/api/device/token'],
    ['GET', '/api/account'],
    ['GET', '/api/sync'],
    ['PUT', '/api/sync'],
  ]) {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        origin: 'https://online-earth.example',
        authorization: `Bearer ${app.token}`,
        ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
      },
      ...(method === 'GET' ? {} : { body: '{}' }),
    });

    assert.equal(response.headers.get('access-control-allow-origin'), '*', `${method} ${path}`);
    /* THE ONE THAT MUST NEVER CHANGE. These routes ignore cookies, so `*` means a browser will
       not attach a visitor's `nova_session` to a cross-origin call here. Allowing credentials
       would turn every one of them into a cross-site request forgery, and `*` is what makes
       that impossible rather than merely unintended. */
    assert.equal(
      response.headers.get('access-control-allow-credentials'),
      null,
      `${method} ${path} must never allow credentials`,
    );
  }
});

test('the account PAGES stay same-origin, cookie-only', async (t) => {
  const { origin } = await startServer(t);

  /* The opposite rule, and the reason the two halves are worth testing together: a page that
     answers a session cookie must not also be readable from another origin. */
  for (const path of ['/account', '/account/sign-in', '/account/device']) {
    const response = await fetch(`${origin}${path}`, {
      redirect: 'manual',
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(response.headers.get('access-control-allow-origin'), null, path);
  }
});
