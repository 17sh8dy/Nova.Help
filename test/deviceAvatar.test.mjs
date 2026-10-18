/**
 * GET /api/account/avatar - the `avatar` scope.
 *
 * What matters: the picture is reachable only with a token the person approved for it, only
 * for the token's own account, and is served inert. There is no public URL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createApp } from '../server/app.mjs';
import { newAvatarKey } from '@nova/accounts';

const PASSWORD = 'a passphrase nobody guesses';
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(64).fill(7)]);

async function boot(t, avatars) {
  const dir = await mkdtemp(path.join(tmpdir(), 'novahelp-avatar-'));
  const app = await createApp({
    dataDir: dir,
    dev: true,
    passwordCost: { N: 1024, r: 8, p: 1 },
    logger: { warn() {}, error() {} },
    ...(avatars ? { stores: { avatars } } : {}),
  });
  const server = http.createServer((req, res) => app.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  return { app, origin: `http://127.0.0.1:${server.address().port}` };
}

const json = (origin, url, body, token) =>
  fetch(origin + url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

const form = (fields, cookie) => ({
  method: 'POST',
  redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
  body: new URLSearchParams(fields),
});

async function signUp(origin, email) {
  const reg = await fetch(
    `${origin}/account/new`,
    form({ email, displayName: email.split('@')[0], password: PASSWORD, passwordConfirm: PASSWORD }),
  );
  return reg.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

/** Sign up a person (cookie), connect a product as an app, return { token, accountId, scope }. */
async function connect(origin, email, product) {
  const cookie = await signUp(origin, email);
  const start = await (await json(origin, '/api/device/code', { product, scope: 'identity avatar' })).json();
  await fetch(`${origin}/account/device`, form({ code: start.user_code, action: 'approve', confirm: start.user_code }, cookie));
  const tok = await (await json(origin, '/api/device/token', { device_code: start.device_code })).json();
  return { token: tok.access_token, accountId: tok.account.id, scope: tok.scope };
}

const reader = (files) => ({ read: async (key) => files.get(key) ?? null });
const get = (origin, token, extra = {}) =>
  fetch(`${origin}/api/account/avatar`, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra } });

test('nova-review is granted the avatar scope; other products are not', async (t) => {
  const { origin } = await boot(t, reader(new Map()));
  const review = await connect(origin, 'a@example.com', 'nova-review');
  assert.match(review.scope, /avatar/);
  const atlas = await connect(origin, 'b@example.com', 'atlas');
  assert.doesNotMatch(atlas.scope, /avatar/, 'atlas is not registered for it');
});

test('serves the token owner own picture, inert, with an ETag', async (t) => {
  const files = new Map();
  const { origin, app } = await boot(t, reader(files));
  const { token, accountId } = await connect(origin, 'ann@example.com', 'nova-review');
  const objectKey = newAvatarKey(accountId);
  files.set(objectKey, PNG);
  await app.ctx.accounts.setAvatar(accountId, { objectKey, contentType: 'image/png', size: PNG.length });

  const res = await get(origin, token);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), PNG);

  const again = await get(origin, token, { 'if-none-match': res.headers.get('etag') });
  assert.equal(again.status, 304, 'an unchanged picture is not re-sent');
});

test('a changed picture has a new ETag; a removed one is a 404', async (t) => {
  const files = new Map();
  const { origin, app } = await boot(t, reader(files));
  const { token, accountId } = await connect(origin, 'ann@example.com', 'nova-review');
  const first = newAvatarKey(accountId);
  files.set(first, PNG);
  await app.ctx.accounts.setAvatar(accountId, { objectKey: first, contentType: 'image/png', size: PNG.length });
  const a = await get(origin, token);

  const second = newAvatarKey(accountId);
  files.set(second, PNG);
  await app.ctx.accounts.setAvatar(accountId, { objectKey: second, contentType: 'image/png', size: PNG.length });
  const b = await get(origin, token, { 'if-none-match': a.headers.get('etag') });
  assert.equal(b.status, 200);
  assert.notEqual(b.headers.get('etag'), a.headers.get('etag'));

  await app.ctx.accounts.clearAvatar(accountId);
  assert.equal((await get(origin, token)).status, 404);
});

test('each token only ever gets its OWN account picture', async (t) => {
  const files = new Map();
  const { origin, app } = await boot(t, reader(files));
  const ann = await connect(origin, 'ann@example.com', 'nova-review');
  const bob = await connect(origin, 'bob@example.com', 'nova-review');
  const key = newAvatarKey(ann.accountId);
  files.set(key, PNG);
  await app.ctx.accounts.setAvatar(ann.accountId, { objectKey: key, contentType: 'image/png', size: PNG.length });

  assert.equal((await get(origin, bob.token)).status, 404, 'bob has no picture and is not handed ann');
});

test('needs a token with the scope: no token, bad token, no scope are all refused', async (t) => {
  const { origin } = await boot(t, reader(new Map()));
  assert.equal((await get(origin, null)).status, 400, 'invalid_grant is a 400, like /api/account');
  assert.equal((await get(origin, 'nope')).status, 400);
  const atlas = await connect(origin, 'c@example.com', 'atlas');
  assert.equal((await get(origin, atlas.token)).status, 403, 'a token without the avatar scope may not read pictures');
});

test('without a reader (Node) the endpoint is simply "no picture"', async (t) => {
  const { origin } = await boot(t, null);
  const { token } = await connect(origin, 'd@example.com', 'nova-review');
  assert.equal((await get(origin, token)).status, 404);
});

test('the approval page describes the avatar permission in a sentence', async (t) => {
  const { origin } = await boot(t, null);
  const cookie = await signUp(origin, 'e@example.com');
  const start = await (await json(origin, '/api/device/code', { product: 'nova-review', scope: 'identity avatar' })).json();
  const page = await (await fetch(`${origin}/account/device?code=${start.user_code}`, { headers: { cookie } })).text();
  assert.match(page, /profile picture/);
});
