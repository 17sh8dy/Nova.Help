/**
 * The shared client, driven against the real portal.
 *
 * @nova/account-client is what all four installed Nova products use, so a bug in it is a bug
 * in all four at once — which is the argument for it existing, and the argument for testing it
 * against a running server rather than against a mock of one.
 *
 * The behaviours worth pinning are the ones an app gets wrong under stress rather than in the
 * happy path: what it does when the network disappears mid-flow, what it does with a token the
 * server has revoked, and — the one that loses somebody's data — what it does when the account
 * has a document it has never seen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createApp } from '../server/app.mjs';
import { createNovaAccountClient, memoryStorage } from '../packages/nova-account-client/index.mjs';
import { fileStorage } from '../packages/nova-account-client/nodeStorage.mjs';

const CHEAP = { N: 1024, r: 8, p: 1 };
const PASSWORD = 'a passphrase nobody guesses';

async function startServer(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'novahelp-client-'));
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

/** A browser that can sign up and approve a code — the human half of every test here. */
function browser(origin) {
  const jar = new Map();

  const go = async (url, fields) => {
    const response = await fetch(`${origin}${url}`, {
      method: fields ? 'POST' : 'GET',
      redirect: 'manual',
      headers: {
        ...(fields ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
      },
      ...(fields ? { body: new URLSearchParams(fields).toString() } : {}),
    });
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const eq = pair.indexOf('=');
      jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    return response;
  };

  return {
    signUp: (email = 'ann@example.com') =>
      go('/account/new', { email, displayName: 'Ann', password: PASSWORD, passwordConfirm: PASSWORD }),
    approve: (code) => go('/account/device', { code, action: 'approve' }),
    deny: (code) => go('/account/device', { code, action: 'deny' }),
  };
}

/** No real waiting: the poll interval is honoured in shape, not in seconds. */
const instant = () => Promise.resolve();

const clientFor = (origin, overrides = {}) =>
  createNovaAccountClient({
    product: 'open-cut',
    scopes: ['sync'],
    origin,
    storage: memoryStorage(),
    sleep: instant,
    ...overrides,
  });

/** The happy path, since most tests below start from "signed in". */
async function signIn(origin, client, person) {
  const flow = await client.beginSignIn({ deviceName: 'A laptop' });
  assert.equal(flow.ok, true);
  const waiting = flow.wait();
  await person.approve(flow.userCode);
  const result = await waiting;
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

/* ── Signing in ────────────────────────────────────────────────────────────────────────── */

test('a client is inert until somebody asks it to sign in', async (t) => {
  const { origin } = await startServer(t);

  /* Constructing one must make no network call and read nothing. That is what lets a product
     wire this in and still be honestly account-free for somebody who never uses it. */
  const client = createNovaAccountClient({ product: 'atlas', origin: 'http://127.0.0.1:1' });
  assert.equal(client.isSignedIn(), false);
  assert.equal(client.account(), null);
  assert.deepEqual(client.scopes(), []);
  assert.ok(origin);
});

test('the whole flow: a code, an approval, a token', async (t) => {
  const { origin } = await startServer(t);
  const person = browser(origin);
  await person.signUp();
  const client = clientFor(origin);

  const result = await signIn(origin, client, person);
  assert.equal(result.account.displayName, 'Ann');
  assert.equal(client.isSignedIn(), true);
  assert.deepEqual(client.scopes(), ['identity', 'sync']);
  assert.equal('email' in result.account, false, 'Open Cut was never granted an address');
});

test('a refused code comes back as "denied", and nothing is stored', async (t) => {
  const { origin } = await startServer(t);
  const person = browser(origin);
  await person.signUp();
  const client = clientFor(origin);

  const flow = await client.beginSignIn();
  const waiting = flow.wait();
  await person.deny(flow.userCode);

  assert.deepEqual(await waiting, { ok: false, reason: 'denied' });
  assert.equal(client.isSignedIn(), false);
});

test('a cancelled flow stops polling and leaves no trace', async (t) => {
  const { origin } = await startServer(t);
  const person = browser(origin);
  await person.signUp();
  const client = clientFor(origin);

  const flow = await client.beginSignIn();
  const waiting = flow.wait();
  flow.cancel();

  assert.deepEqual(await waiting, { ok: false, reason: 'cancelled' });
  assert.equal(client.isSignedIn(), false);
});

test('a server that cannot be reached is one clear reason, not a stack trace', async (t) => {
  const { origin } = await startServer(t);
  assert.ok(origin);

  /* Port 1 answers nothing. Every network failure an app can hit — offline, DNS, a captive
     portal, a firewall — arrives here, and there is exactly one thing the app can do about
     any of them. */
  const client = createNovaAccountClient({ product: 'atlas', origin: 'http://127.0.0.1:1' });
  assert.deepEqual(await client.beginSignIn(), { ok: false, reason: 'unavailable' });
});

test('a product the server does not accept is refused, not retried forever', async (t) => {
  const { origin } = await startServer(t);
  const client = createNovaAccountClient({ product: 'not-a-nova-product', origin, sleep: instant });
  assert.deepEqual(await client.beginSignIn(), { ok: false, reason: 'refused' });
});

/* ── Staying signed in ─────────────────────────────────────────────────────────────────── */

test('a token survives a restart when storage is a file', async (t) => {
  const { origin, dir } = await startServer(t);
  const person = browser(origin);
  await person.signUp();

  const first = clientFor(origin, { storage: fileStorage(path.join(dir, 'client')) });
  await signIn(origin, first, person);

  // A second client over the same directory is the same app, launched again.
  const second = clientFor(origin, { storage: fileStorage(path.join(dir, 'client')) });
  assert.equal(second.isSignedIn(), true);
  assert.equal((await second.refresh()).state, 'signed-in');
});

test('OFFLINE IS NOT A SIGN-OUT — the token is kept when the server cannot be reached', async (t) => {
  const { origin, dir } = await startServer(t);
  const person = browser(origin);
  await person.signUp();

  const storage = fileStorage(path.join(dir, 'client'));
  await signIn(origin, clientFor(origin, { storage }), person);

  /* The same stored token, against a server that is not there. An app that forgot its session
     on a flaky connection would sign somebody out for no reason at all — on a train, at a
     hotel, behind a captive portal — which is the single most annoying bug this class of code
     has, and it is a one-line mistake. */
  const offline = clientFor('http://127.0.0.1:1', { storage });
  const checked = await offline.refresh();
  assert.equal(checked.state, 'offline');
  assert.equal(offline.isSignedIn(), true, 'still signed in');
});

test('a revoked token IS a sign-out, and the client stops claiming otherwise', async (t) => {
  const { origin, app } = await startServer(t);
  const person = browser(origin);
  await person.signUp();
  const client = clientFor(origin);
  await signIn(origin, client, person);

  const account = await app.ctx.accounts.store.getByEmail('ann@example.com');
  await app.ctx.accounts.signOutEverywhere(account.id);

  assert.equal((await client.refresh()).state, 'signed-out');
  assert.equal(client.isSignedIn(), false);
});

test('signing out forgets the token even when the server cannot be told', async (t) => {
  const { origin, dir } = await startServer(t);
  const person = browser(origin);
  await person.signUp();

  const storage = fileStorage(path.join(dir, 'client'));
  await signIn(origin, clientFor(origin, { storage }), person);

  /* Telling the server is better, because that is what actually revokes. But an app that will
     not forget a token because the network is down is an app somebody cannot sign out of. */
  const offline = clientFor('http://127.0.0.1:1', { storage });
  await offline.signOut();
  assert.equal(offline.isSignedIn(), false);
  assert.equal(clientFor(origin, { storage }).isSignedIn(), false, 'and it stayed forgotten');
});

/* ── Sync ──────────────────────────────────────────────────────────────────────────────── */

test('push and pull round-trip a document', async (t) => {
  const { origin } = await startServer(t);
  const person = browser(origin);
  await person.signUp();
  const client = clientFor(origin);
  await signIn(origin, client, person);

  assert.deepEqual(await client.pull(), { ok: true, version: 0, data: null, updatedAt: null });

  const pushed = await client.push({ baseVersion: 0, data: { theme: 'midnight' } });
  assert.equal(pushed.ok, true);
  assert.equal(pushed.version, 1);

  const pulled = await client.pull();
  assert.deepEqual(pulled.data, { theme: 'midnight' });
});

test('a conflict comes back WITH the server document, so a client can merge', async (t) => {
  const { origin } = await startServer(t);
  const person = browser(origin);
  await person.signUp();

  const laptop = clientFor(origin);
  await signIn(origin, laptop, person);
  await laptop.push({ baseVersion: 0, data: { places: ['home'] } });

  const desktop = clientFor(origin);
  await signIn(origin, desktop, person);

  /* The second machine, freshly installed, with nothing of its own. This is the moment a naive
     sync loses a year of settings, and the only reason it does not is that `push` has no way
     to say "just take mine". */
  const blind = await desktop.push({ baseVersion: 0, data: {} });
  assert.equal(blind.ok, false);
  assert.equal(blind.reason, 'conflict');
  assert.deepEqual(blind.current.data, { places: ['home'] }, 'here is what you would have lost');

  // Having seen it, the client can merge and push against the version it now knows.
  const merged = await desktop.push({
    baseVersion: blind.current.version,
    data: { places: [...blind.current.data.places, 'work'] },
  });
  assert.equal(merged.ok, true);
  assert.deepEqual((await laptop.pull()).data, { places: ['home', 'work'] });
});

test('offline is distinguishable from empty, so nothing uploads over an unread document', async (t) => {
  const { origin, dir } = await startServer(t);
  const person = browser(origin);
  await person.signUp();

  const storage = fileStorage(path.join(dir, 'client'));
  await signIn(origin, clientFor(origin, { storage }), person);

  /* If `pull` returned "nothing saved" when it simply could not ask, a client would conclude
     the account is empty and push over whatever is really there. So the two answers are
     different, and this is the assertion that keeps them that way. */
  const offline = clientFor('http://127.0.0.1:1', { storage });
  const pulled = await offline.pull();
  assert.equal(pulled.ok, false);
  assert.equal(pulled.reason, 'offline');
  assert.equal(pulled.offline, true);
});

test('a product without the sync scope is told so, and never calls the server', async (t) => {
  const { origin } = await startServer(t);
  const person = browser(origin);
  await person.signUp();

  const client = clientFor(origin, { product: 'replay-gg', scopes: ['support'] });
  await signIn(origin, client, person);

  assert.deepEqual(await client.pull(), { ok: false, reason: 'no-scope' });
  assert.deepEqual(await client.push({ baseVersion: 0, data: {} }), { ok: false, reason: 'no-scope' });
});

test('sync refuses politely when nobody is signed in', async (t) => {
  const { origin } = await startServer(t);
  const client = clientFor(origin);

  assert.deepEqual(await client.pull(), { ok: false, reason: 'signed-out' });
  assert.deepEqual(await client.push({ baseVersion: 0, data: {} }), { ok: false, reason: 'signed-out' });
});
