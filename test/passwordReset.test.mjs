/**
 * Forgotten passwords, driven the way a person meets them: through the pages, with a mailbox.
 *
 * The store contract proves a token can be spent exactly once. This proves the flow — that the
 * link in the mail works, that it stops working afterwards, that every other device is signed
 * out, that the notification arrives, and above all that NOTHING ANYWHERE ANSWERS "does this
 * address have an account?".
 *
 * That last one is why the enumeration tests compare whole responses rather than checking for
 * a phrase. A difference in status, in length, or in a single word is the disclosure; asserting
 * on "does it say the right thing" would miss all three.
 *
 * The suite runs twice, once per store, because the redemption that makes a token single-use is
 * implemented completely differently in each and both have to mean the same thing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createApp } from '../server/app.mjs';
import { createMemoryMailer } from '@nova/accounts';
import { createD1AccountStore } from '@nova/accounts/d1Store';
import { createD1TicketStore } from '../server/store/d1Store.mjs';
import { createSqliteD1 } from '../server/store/sqliteD1.mjs';
import { applySchema } from '../server/store/migrate.mjs';

const CHEAP = { N: 1024, r: 8, p: 1 };
const PASSWORD = 'a passphrase nobody guesses';
const NEW_PASSWORD = 'an entirely different passphrase';

/** Stand the portal up with a mailbox we can read. */
async function startServer(t, backend) {
  const dir = await mkdtemp(path.join(tmpdir(), 'novareset-'));
  const mailer = createMemoryMailer();

  let stores;
  if (backend === 'd1Store') {
    const db = createSqliteD1();
    await applySchema(db);
    t.after(() => db.close());
    stores = { tickets: createD1TicketStore({ db }), accounts: createD1AccountStore({ db }) };
  }

  const app = await createApp({
    dataDir: dir,
    dev: true,
    logger: { warn() {}, error() {}, info() {} },
    passwordCost: CHEAP,
    mailer,
    ...(stores ? { stores } : {}),
  });

  const server = http.createServer((req, res) => app.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  return { origin, mailer, app };
}

/** A browser-ish client with a cookie jar. */
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
  const header = () => [...jar].map(([n, v]) => `${n}=${v}`).join('; ');
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

const signUp = (browser, email) =>
  browser.post('/account/new', { email, password: PASSWORD, passwordConfirm: PASSWORD });

/** The reset link out of the most recent message, as a path. */
function linkFrom(mailer) {
  const last = mailer.sent.at(-1);
  assert.ok(last, 'no mail was sent');
  const found = /https?:\/\/[^\s]+\/account\/reset\?token=[^\s]+/.exec(last.text);
  assert.ok(found, `no reset link in:\n${last.text}`);
  return new URL(found[0]).pathname + new URL(found[0]).search;
}

const tokenFrom = (mailer) => new URLSearchParams(linkFrom(mailer).split('?')[1]).get('token');

for (const backend of ['fileStore', 'd1Store']) {
  const name = (what) => `[${backend}] ${what}`;
  const serve = (t) => startServer(t, backend);

  /* ── The happy path ──────────────────────────────────────────────────────────────────── */

  test(name('a reset link arrives, works once, and signs the person in'), async (t) => {
    const { origin, mailer } = await serve(t);
    await signUp(client(origin), 'ann@example.com');

    const asking = client(origin);
    const requested = await asking.post('/account/forgot', { email: 'ann@example.com' });
    assert.equal(requested.status, 200);
    assert.match(await requested.text(), /Check your email/i);

    assert.equal(mailer.sent.length, 1);
    assert.equal(mailer.sent[0].to, 'ann@example.com');
    assert.match(mailer.sent[0].subject, /reset/i);

    // The form opens from the link.
    const opening = client(origin);
    const form = await opening.get(linkFrom(mailer));
    assert.equal(form.status, 200);
    assert.match(await form.text(), /Choose a new password/i);

    const saved = await opening.post('/account/reset', {
      token: tokenFrom(mailer),
      password: NEW_PASSWORD,
      passwordConfirm: NEW_PASSWORD,
    });
    assert.equal(saved.status, 303, await saved.text());
    assert.match(saved.headers.get('location'), /welcome=password-reset/);

    // Signed in on this device, on the new password.
    assert.equal((await opening.get('/account')).status, 200);

    const fresh = client(origin);
    assert.equal(
      (await fresh.post('/account/sign-in', { email: 'ann@example.com', password: NEW_PASSWORD })).status,
      303,
      'the new password works',
    );
    assert.equal(
      (await client(origin).post('/account/sign-in', { email: 'ann@example.com', password: PASSWORD })).status,
      401,
      'and the old one does not',
    );
  });

  test(name('the link is single-use'), async (t) => {
    const { origin, mailer } = await serve(t);
    await signUp(client(origin), 'ann@example.com');
    await client(origin).post('/account/forgot', { email: 'ann@example.com' });
    const token = tokenFrom(mailer);

    const first = await client(origin).post('/account/reset', {
      token,
      password: NEW_PASSWORD,
      passwordConfirm: NEW_PASSWORD,
    });
    assert.equal(first.status, 303);

    const second = await client(origin).post('/account/reset', {
      token,
      password: 'a third completely different one',
      passwordConfirm: 'a third completely different one',
    });
    assert.equal(second.status, 400, 'the spent link is refused');
    assert.match(await second.text(), /cannot be used/i);

    // And the second attempt did not take.
    assert.equal(
      (await client(origin).post('/account/sign-in', { email: 'ann@example.com', password: NEW_PASSWORD })).status,
      303,
    );
  });

  test(name('two requests carrying the same link cannot both succeed'), async (t) => {
    /* A double-click, a mail client that prefetches, a retry. The redemption is atomic in both
       stores, so exactly one of these changes the password. */
    const { origin, mailer } = await serve(t);
    await signUp(client(origin), 'ann@example.com');
    await client(origin).post('/account/forgot', { email: 'ann@example.com' });
    const token = tokenFrom(mailer);

    const results = await Promise.all([
      client(origin).post('/account/reset', { token, password: NEW_PASSWORD, passwordConfirm: NEW_PASSWORD }),
      client(origin).post('/account/reset', { token, password: NEW_PASSWORD, passwordConfirm: NEW_PASSWORD }),
    ]);

    assert.equal(results.filter((r) => r.status === 303).length, 1, 'exactly one redemption won');
    assert.equal(results.filter((r) => r.status === 400).length, 1);
  });

  test(name('resetting signs every other device out'), async (t) => {
    const { origin, mailer } = await serve(t);
    const laptop = client(origin);
    await signUp(laptop, 'ann@example.com');

    const phone = client(origin);
    await phone.post('/account/sign-in', { email: 'ann@example.com', password: PASSWORD });
    assert.equal((await phone.get('/account')).status, 200, 'the phone is signed in to begin with');

    await client(origin).post('/account/forgot', { email: 'ann@example.com' });
    await client(origin).post('/account/reset', {
      token: tokenFrom(mailer),
      password: NEW_PASSWORD,
      passwordConfirm: NEW_PASSWORD,
    });

    assert.equal((await phone.get('/account')).status, 303, 'the phone was signed out');
    assert.equal((await laptop.get('/account')).status, 303, 'and so was the browser that signed up');
  });

  test(name('a notification is sent after the password actually changes'), async (t) => {
    const { origin, mailer } = await serve(t);
    await signUp(client(origin), 'ann@example.com');
    await client(origin).post('/account/forgot', { email: 'ann@example.com' });

    assert.equal(mailer.sent.length, 1, 'only the reset link so far');

    await client(origin).post('/account/reset', {
      token: tokenFrom(mailer),
      password: NEW_PASSWORD,
      passwordConfirm: NEW_PASSWORD,
    });

    assert.equal(mailer.sent.length, 2);
    const notification = mailer.sent[1];
    assert.equal(notification.to, 'ann@example.com');
    assert.match(notification.subject, /password was changed/i);
    assert.match(notification.text, /signed out/i, 'it says what happened to the sessions');
    assert.match(notification.text, /NOT you/i, 'and what to do if it was not them');
  });

  test(name('a failed attempt sends no notification'), async (t) => {
    const { origin, mailer } = await serve(t);
    await signUp(client(origin), 'ann@example.com');
    await client(origin).post('/account/forgot', { email: 'ann@example.com' });

    await client(origin).post('/account/reset', {
      token: 'acct_nonsense.deadbeef',
      password: NEW_PASSWORD,
      passwordConfirm: NEW_PASSWORD,
    });
    assert.equal(mailer.sent.length, 1, 'nothing beyond the original link');
  });

  /* ── Not telling anybody who has an account ──────────────────────────────────────────── */

  test(name('an address with an account and one without are indistinguishable'), async (t) => {
    const { origin, mailer } = await serve(t);
    await signUp(client(origin), 'real@example.com');

    const known = await client(origin).post('/account/forgot', { email: 'real@example.com' });
    const unknown = await client(origin).post('/account/forgot', { email: 'nobody@example.com' });

    assert.equal(known.status, unknown.status, 'same status');

    /* Byte for byte, once the address that was typed is taken out — that is the only thing
       either page is allowed to differ by, because the visitor typed it. */
    const normalise = (html) => html.replaceAll('real@example.com', 'X').replaceAll('nobody@example.com', 'X');
    assert.equal(normalise(await known.text()), normalise(await unknown.text()), 'same page');

    // The only difference in the world is the mailbox.
    assert.equal(mailer.sent.length, 1);
    assert.equal(mailer.sent[0].to, 'real@example.com');
  });

  test(name('a disabled account is treated like no account at all'), async (t) => {
    const { origin, mailer, app } = await serve(t);
    await signUp(client(origin), 'off@example.com');

    const store = app.ctx.accounts.store;
    const account = await store.getByEmail('off@example.com');
    await store.update(account.id, (doc) => {
      doc.status = 'disabled';
      return doc;
    });

    const disabled = await client(origin).post('/account/forgot', { email: 'off@example.com' });
    const unknown = await client(origin).post('/account/forgot', { email: 'nobody@example.com' });

    assert.equal(disabled.status, unknown.status);
    assert.equal(mailer.sent.length, 0, 'no way in is minted for an account that cannot sign in');
  });

  test(name('an unconfigured mail transport still gives nothing away'), async (t) => {
    /* The failure mode that matters operationally: mail is broken, and the form must not
       become an oracle by answering differently. */
    const dir = await mkdtemp(path.join(tmpdir(), 'novareset-nomail-'));
    const broken = {
      configured: true,
      async send() {
        throw new Error('smtp is down');
      },
    };
    const app = await createApp({
      dataDir: dir,
      dev: true,
      logger: { warn() {}, error() {}, info() {} },
      passwordCost: CHEAP,
      mailer: broken,
    });
    const server = http.createServer((req, res) => app.handle(req, res));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    t.after(async () => {
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    });

    await signUp(client(origin), 'real@example.com');
    const known = await client(origin).post('/account/forgot', { email: 'real@example.com' });
    const unknown = await client(origin).post('/account/forgot', { email: 'nobody@example.com' });

    assert.equal(known.status, 200, 'a broken transport is not a 500 the visitor sees');
    assert.equal(known.status, unknown.status);
  });

  /* ── Bad links ───────────────────────────────────────────────────────────────────────── */

  test(name('a malformed or unknown token gets an explanation, not a form'), async (t) => {
    const { origin } = await serve(t);

    for (const token of ['', 'nonsense', 'acct_x.', '.secret', 'acct_x.notarealsecret']) {
      const response = await client(origin).get(`/account/reset?token=${encodeURIComponent(token)}`);
      assert.equal(response.status, 400, `token ${JSON.stringify(token)}`);
      const html = await response.text();
      assert.equal(/name="password"/.test(html), false, 'no form for a dead link');
      assert.match(html, /Ask for another link/i);
    }
  });

  test(name('an expired link is refused and says so'), async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'novareset-exp-'));
    const mailer = createMemoryMailer();
    const app = await createApp({
      dataDir: dir,
      dev: true,
      logger: { warn() {}, error() {}, info() {} },
      passwordCost: CHEAP,
      mailer,
    });
    const server = http.createServer((req, res) => app.handle(req, res));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    t.after(async () => {
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    });

    await signUp(client(origin), 'ann@example.com');
    await client(origin).post('/account/forgot', { email: 'ann@example.com' });
    const token = tokenFrom(mailer);

    // Age the stored request past its expiry rather than waiting an hour for it.
    const store = app.ctx.accounts.store;
    const account = await store.getByEmail('ann@example.com');
    await store.issuePasswordReset(account.id, {
      ...account.passwordReset,
      expiresAt: '2020-01-01T00:00:00.000Z',
    });

    const opened = await client(origin).get(`/account/reset?token=${encodeURIComponent(token)}`);
    assert.equal(opened.status, 400);
    assert.match(await opened.text(), /expired/i);

    const posted = await client(origin).post('/account/reset', {
      token,
      password: NEW_PASSWORD,
      passwordConfirm: NEW_PASSWORD,
    });
    assert.equal(posted.status, 400);
    assert.match(await posted.text(), /expired/i);
  });

  test(name('asking again replaces the previous link'), async (t) => {
    const { origin, mailer } = await serve(t);
    await signUp(client(origin), 'ann@example.com');

    await client(origin).post('/account/forgot', { email: 'ann@example.com' });
    const first = tokenFrom(mailer);
    await client(origin).post('/account/forgot', { email: 'ann@example.com' });
    const second = tokenFrom(mailer);

    assert.notEqual(first, second);
    const stale = await client(origin).post('/account/reset', {
      token: first,
      password: NEW_PASSWORD,
      passwordConfirm: NEW_PASSWORD,
    });
    assert.equal(stale.status, 400, 'the older link is dead');

    const current = await client(origin).post('/account/reset', {
      token: second,
      password: NEW_PASSWORD,
      passwordConfirm: NEW_PASSWORD,
    });
    assert.equal(current.status, 303, 'the newest one works');
  });

  test(name('signing in with the password kills an outstanding link'), async (t) => {
    /* Somebody asks for a reset, then remembers the password. The link in their inbox should
       not still be a way in a week later. */
    const { origin, mailer } = await serve(t);
    await signUp(client(origin), 'ann@example.com');
    await client(origin).post('/account/forgot', { email: 'ann@example.com' });
    const token = tokenFrom(mailer);

    const remembered = await client(origin).post('/account/sign-in', {
      email: 'ann@example.com',
      password: PASSWORD,
    });
    assert.equal(remembered.status, 303);

    const stale = await client(origin).post('/account/reset', {
      token,
      password: NEW_PASSWORD,
      passwordConfirm: NEW_PASSWORD,
    });
    assert.equal(stale.status, 400, 'the link was retired by the successful sign-in');
  });

  /* ── The new password has to be a password ───────────────────────────────────────────── */

  test(name('a weak or mismatched password is refused without spending the link'), async (t) => {
    const { origin, mailer } = await serve(t);
    await signUp(client(origin), 'ann@example.com');
    await client(origin).post('/account/forgot', { email: 'ann@example.com' });
    const token = tokenFrom(mailer);

    const short = await client(origin).post('/account/reset', { token, password: 'abc', passwordConfirm: 'abc' });
    assert.equal(short.status, 422);
    assert.match(await short.text(), /at least 10 characters/i);

    const mismatch = await client(origin).post('/account/reset', {
      token,
      password: NEW_PASSWORD,
      passwordConfirm: 'something else entirely',
    });
    assert.equal(mismatch.status, 422);
    assert.match(await mismatch.text(), /do not match/i);

    // The link survived both refusals.
    const good = await client(origin).post('/account/reset', {
      token,
      password: NEW_PASSWORD,
      passwordConfirm: NEW_PASSWORD,
    });
    assert.equal(good.status, 303);
  });

  test(name('a malformed address on the request form is a plain validation error'), async (t) => {
    const { origin } = await serve(t);
    const response = await client(origin).post('/account/forgot', { email: 'not-an-address' });
    assert.equal(response.status, 422);
    assert.match(await response.text(), /does not look like an email address/i);
  });

  /* ── Rate limiting ───────────────────────────────────────────────────────────────────── */

  test(name('reset requests are rate limited, and the limit does not leak either'), async (t) => {
    const { origin, mailer } = await serve(t);
    await signUp(client(origin), 'ann@example.com');

    // Per source: 6 an hour.
    for (let i = 0; i < 6; i += 1) {
      const allowed = await client(origin).post('/account/forgot', { email: `person${i}@example.com` });
      assert.equal(allowed.status, 200, `request ${i}`);
    }

    const throttled = await client(origin).post('/account/forgot', { email: 'ann@example.com' });
    assert.equal(throttled.status, 429);
    assert.equal(mailer.sent.length, 0, 'and nothing was sent for any of the unknown addresses');
  });

  test(name('one address cannot be used to flood somebody inbox'), async (t) => {
    const { origin, mailer } = await serve(t);
    await signUp(client(origin), 'target@example.com');

    // Per address: 4 an hour. The 5th is answered neutrally and simply not acted on.
    for (let i = 0; i < 4; i += 1) {
      assert.equal((await client(origin).post('/account/forgot', { email: 'target@example.com' })).status, 200);
    }
    assert.equal(mailer.sent.length, 4);

    const fifth = await client(origin).post('/account/forgot', { email: 'target@example.com' });
    assert.equal(fifth.status, 200, 'the same neutral page — a 429 here would be a signal');
    assert.equal(mailer.sent.length, 4, 'but no fifth mail');
  });

  /* ── A provider-only account setting its first password ──────────────────────────────── */

  test(name('an account with no password can use this to set one'), async (t) => {
    const { origin, mailer, app } = await serve(t);

    /* The shape a Google sign-up leaves behind: no password, one identity. Built through the
       service so it is the real thing rather than a document written by hand. */
    const created = await app.ctx.accounts.withProviderIdentity({
      provider: 'google',
      subject: 'google-sub-1',
      email: 'fed@example.com',
      emailVerified: true,
      displayName: 'Fed',
    });
    assert.equal(created.ok, true);
    assert.equal((await app.ctx.accounts.store.get(created.account.id)).password, null);

    await client(origin).post('/account/forgot', { email: 'fed@example.com' });
    const saved = await client(origin).post('/account/reset', {
      token: tokenFrom(mailer),
      password: NEW_PASSWORD,
      passwordConfirm: NEW_PASSWORD,
    });
    assert.equal(saved.status, 303);

    assert.equal(
      (await client(origin).post('/account/sign-in', { email: 'fed@example.com', password: NEW_PASSWORD })).status,
      303,
      'they can now sign in with a password as well as with Google',
    );
  });

  /* ── Discoverability ─────────────────────────────────────────────────────────────────── */

  test(name('the sign-in page offers the way to reset'), async (t) => {
    const { origin } = await serve(t);
    const html = await client(origin).get('/account/sign-in').then((r) => r.text());
    assert.match(html, /\/account\/forgot/);
    assert.equal(/no password reset yet/i.test(html), false, 'the old apology is gone');
  });

  test(name('somebody already signed in is sent away from the forgot form'), async (t) => {
    const { origin } = await serve(t);
    const browser = client(origin);
    await signUp(browser, 'ann@example.com');

    const response = await browser.get('/account/forgot');
    assert.equal(response.status, 303);
  });
}
