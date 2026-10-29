/**
 * Two-step verification at Nova.Help's own front door.
 *
 * Nova.Help signs people in with the same package and the same database as the Nova site, so an
 * account that turned two-step on THERE must not be able to sign in HERE with a password alone.
 * That is the whole point of these tests: the second factor protects the account, not one
 * website. Enrolment itself happens on the Nova site (and is tested there and in mfa.test.mjs);
 * here it is done through the service so the HTTP behaviour can be examined.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createApp } from '../server/app.mjs';
import { createMemoryMailer } from '@nova/accounts';
import { base32Decode, hotp, stepAt } from '../packages/nova-accounts/totp.mjs';

const CHEAP = { N: 1024, r: 8, p: 1 };
const PASSWORD = 'a passphrase nobody guesses';
const NEW_PASSWORD = 'an entirely different passphrase';

async function startServer(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'novahelp2fa-'));
  const mailer = createMemoryMailer();
  const app = await createApp({ dataDir: dir, dev: true, logger: { warn() {}, error() {}, info() {} }, passwordCost: CHEAP, mailer });
  const server = http.createServer((req, res) => app.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, mailer, accounts: app.ctx.accounts };
}

function client(origin) {
  const jar = new Map();
  const go = async (url, options = {}) => {
    const response = await fetch(`${origin}${url}`, {
      redirect: 'manual',
      ...options,
      headers: { ...(options.headers ?? {}), ...(jar.size ? { cookie: [...jar].map(([n, v]) => `${n}=${v}`).join('; ') } : {}) },
    });
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const eq = pair.indexOf('=');
      const value = pair.slice(eq + 1).trim();
      if (value === '') jar.delete(pair.slice(0, eq).trim());
      else jar.set(pair.slice(0, eq).trim(), value);
    }
    return response;
  };
  return {
    jar,
    get: (url) => go(url),
    post: (url, fields) =>
      go(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() }),
  };
}

async function enrolled(t) {
  const site = await startServer(t);
  const made = await site.accounts.register({ email: 'ann@example.com', password: PASSWORD, passwordConfirm: PASSWORD });
  assert.equal(made.ok, true);
  const id = made.account.id;
  await site.accounts.beginMfaEnrollment(id, { currentPassword: PASSWORD });
  const setup = await site.accounts.pendingMfaSetup(id);
  const secret = base32Decode(new URL(setup.uri).searchParams.get('secret'));
  const done = await site.accounts.confirmMfaEnrollment(id, hotp(secret, stepAt()));
  assert.equal(done.ok, true);
  return { ...site, id, secret, codes: done.recoveryCodes };
}

const ticketFrom = (page) => /name="ticket" value="([^"]+)"/.exec(page)[1];
const hasSession = (b) => [...b.jar.keys()].some((name) => /session/i.test(name));

test('Nova.Help: a correct password is not a sign-in for an account with two-step on', async (t) => {
  const { origin, secret } = await enrolled(t);
  const b = client(origin);
  const first = await b.post('/account/sign-in', { email: 'ann@example.com', password: PASSWORD });
  assert.equal(first.status, 200);
  assert.equal(hasSession(b), false, 'no session cookie yet');
  const page = await first.text();
  assert.match(page, /Authentication code/);

  assert.equal((await b.get('/account')).status, 303, 'the account area is still closed');

  const wrong = await b.post('/account/sign-in/verify', { ticket: ticketFrom(page), code: '000000' });
  assert.equal(wrong.status, 401);
  assert.equal(hasSession(b), false);

  const right = await b.post('/account/sign-in/verify', { ticket: ticketFrom(page), code: hotp(secret, stepAt() + 1) });
  assert.equal(right.status, 303);
  assert.equal(hasSession(b), true);
  assert.equal((await b.get('/account')).status, 200);
});

test('Nova.Help: a recovery code works once; forged tickets and wrong passwords get nowhere', async (t) => {
  const { origin, codes } = await enrolled(t);
  const b = client(origin);

  const bad = await b.post('/account/sign-in', { email: 'ann@example.com', password: 'wrong wrong wrong' });
  assert.equal(bad.status, 401);
  assert.ok(!/Authentication code/.test(await bad.text()));

  for (const ticket of ['', 'x', 'a.b.c']) {
    const r = await b.post('/account/sign-in/verify', { ticket, code: codes[0] });
    assert.equal(r.status, 401, ticket);
  }
  assert.equal(hasSession(b), false);

  const page = await (await b.post('/account/sign-in', { email: 'ann@example.com', password: PASSWORD })).text();
  const ticket = ticketFrom(page);
  assert.equal((await b.post('/account/sign-in/verify', { ticket, code: codes[0] })).status, 303);

  const c = client(origin);
  const page2 = await (await c.post('/account/sign-in', { email: 'ann@example.com', password: PASSWORD })).text();
  assert.equal((await c.post('/account/sign-in/verify', { ticket: ticketFrom(page2), code: codes[0] })).status, 401, 'spent');
});

test('Nova.Help: a password-reset link does not sign an enrolled account in', async (t) => {
  const { origin, mailer } = await enrolled(t);
  const b = client(origin);
  await b.post('/account/forgot', { email: 'ann@example.com' });
  const last = mailer.sent.at(-1);
  const token = new URLSearchParams(/account\/reset\?(token=[^\s]+)/.exec(last.text)[1]).get('token');

  const reset = await b.post('/account/reset', { token, password: NEW_PASSWORD, passwordConfirm: NEW_PASSWORD });
  assert.equal(reset.status, 303);
  assert.match(reset.headers.get('location'), /^\/account\/sign-in/);
  assert.equal(hasSession(b), false, 'the mailbox alone is not the second factor');

  const page = await (await b.get('/account/sign-in?oauth=reset-done')).text();
  assert.match(page, /Your password has been changed/);

  const again = await b.post('/account/sign-in', { email: 'ann@example.com', password: NEW_PASSWORD });
  assert.match(await again.text(), /Authentication code/);
});
