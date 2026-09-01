/**
 * End-to-end tests for Nova Accounts inside Nova.Help.
 *
 * The unit tests in accounts.test.mjs prove the identity module behaves. These prove the
 * portal wired it up correctly, which is a different question and the one that actually
 * breaks: a form that posts an address the server should have ignored, a ticket page that
 * opens for the wrong account, a sign-out that clears a cookie and leaves the session alive.
 *
 * Every test drives the site the way a browser does — form posts, a cookie jar, redirects
 * followed by hand — and the ones that matter most are the ones asserting a REFUSAL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createApp } from '../server/app.mjs';

/** scrypt at production cost would make this file take minutes. The wiring is identical. */
const CHEAP = { N: 1024, r: 8, p: 1 };

const PASSWORD = 'a passphrase nobody guesses';

async function startServer(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'novahelp-acct-'));
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

/**
 * A browser-ish client: one cookie jar, redirects left alone so tests can assert on them.
 * Each `client()` is a separate device, which is how "another account cannot open this" is
 * tested without any cookie leaking between the two.
 */
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
    cookieHeader: header,
    get: (url, options) => go(url, options),
    post: (url, fields, options = {}) =>
      go(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...(options.headers ?? {}) },
        body: new URLSearchParams(fields).toString(),
        ...options,
      }),
    json: (url, body, options = {}) =>
      go(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
        body: JSON.stringify(body),
        ...options,
      }),
  };
}

const FLOW = '/help/online-earth/globe/globe-not-loading';

const TICKET = {
  subject: 'The globe never finishes loading',
  description: 'It sits on the loading spinner forever on a fresh profile, on two machines.',
  priority: 'high',
};

const idFrom = (response) =>
  decodeURIComponent(response.headers.get('location').split('/').pop().split('?')[0]);

/** Create an account and end up signed in, the way the sign-up form does. */
async function signUp(browser, { email, name = 'Ann', next } = {}) {
  const response = await browser.post('/account/new', {
    email,
    displayName: name,
    password: PASSWORD,
    passwordConfirm: PASSWORD,
    ...(next ? { next } : {}),
  });
  assert.equal(response.status, 303, await response.text());
  return response;
}

/* ── The header ────────────────────────────────────────────────────────────────────────── */

test('the header offers an account to a guest and never demands one', async (t) => {
  const { origin } = await startServer(t);
  const browser = client(origin);

  const html = await browser.get('/').then((r) => r.text());
  assert.match(html, /account-chip--guest/, 'a signed-out visitor gets a sign-in link');
  assert.match(html, /\/account\/sign-in\?next=%2F/, 'and it brings them back where they were');

  // The homepage still leads with the guided flow, not with a wall.
  assert.match(html, /What do you need help with\?/);
  assert.equal(html.includes('You must sign in'), false);
});

test('the header shows the person once they are signed in', async (t) => {
  const { origin } = await startServer(t);
  const browser = client(origin);
  await signUp(browser, { email: 'ann@example.com' });

  const html = await browser.get('/').then((r) => r.text());
  assert.match(html, /account-chip__avatar/);
  assert.match(html, /Ann</);
  assert.equal(html.includes('account-chip--guest'), false);
});

/* ── Creating an account ───────────────────────────────────────────────────────────────── */

test('creating an account signs you in and lands you back where you were', async (t) => {
  const { origin } = await startServer(t);
  const browser = client(origin);

  const response = await signUp(browser, { email: 'ann@example.com', next: FLOW });
  assert.equal(response.headers.get('location'), FLOW);
  assert.ok(browser.jar.has('nova_session'), 'a session cookie should have been set');

  const cookie = response.headers.getSetCookie().find((c) => c.startsWith('nova_session='));
  assert.match(cookie, /HttpOnly/, 'the session cookie must not be readable by script');
  assert.match(cookie, /SameSite=Lax/, 'and must not ride along on a cross-site POST');
});

test('a weak password is refused and creates nothing', async (t) => {
  const { origin, app } = await startServer(t);
  const browser = client(origin);

  const response = await browser.post('/account/new', {
    email: 'ann@example.com',
    password: 'short',
    passwordConfirm: 'short',
  });

  assert.equal(response.status, 422);
  const html = await response.text();
  assert.match(html, /at least 10 characters/);
  assert.equal(html.includes('value="short"'), false, 'the password must never be echoed into the page');
  assert.equal(browser.jar.has('nova_session'), false);
  assert.equal(await app.ctx.accounts.count(), 0);
});

test('mismatched passwords are refused, and the address survives the re-render', async (t) => {
  const { origin, app } = await startServer(t);
  const browser = client(origin);

  const response = await browser.post('/account/new', {
    email: 'ann@example.com',
    displayName: 'Ann',
    password: PASSWORD,
    passwordConfirm: 'a different passphrase',
  });

  assert.equal(response.status, 422);
  const html = await response.text();
  assert.match(html, /do not match/);
  assert.match(html, /value="ann@example\.com"/, 'what was typed should still be in the form');
  assert.equal(html.includes(PASSWORD), false);
  assert.equal(await app.ctx.accounts.count(), 0);
});

test('a second account cannot take an address that already has one', async (t) => {
  const { origin, app } = await startServer(t);

  await signUp(client(origin), { email: 'ann@example.com' });

  const second = client(origin);
  const response = await second.post('/account/new', {
    email: 'ANN@example.com',
    password: PASSWORD,
    passwordConfirm: PASSWORD,
  });

  assert.equal(response.status, 422);
  assert.match(await response.text(), /already uses that address/);
  assert.equal(second.jar.has('nova_session'), false);
  assert.equal(await app.ctx.accounts.count(), 1);
});

/* ── Signing in and out ────────────────────────────────────────────────────────────────── */

test('signing in works, and every way of failing says the same thing', async (t) => {
  const { origin } = await startServer(t);
  await signUp(client(origin), { email: 'ann@example.com' });

  const wrongPassword = client(origin);
  const wrong = await wrongPassword.post('/account/sign-in', {
    email: 'ann@example.com',
    password: 'not the password',
  });
  assert.equal(wrong.status, 401);
  const wrongHtml = await wrong.text();
  assert.match(wrongHtml, /That did not sign you in/);
  assert.equal(wrongPassword.jar.has('nova_session'), false);

  const unknown = client(origin);
  const missing = await unknown.post('/account/sign-in', {
    email: 'nobody@example.com',
    password: 'not the password',
  });
  assert.equal(missing.status, 401);
  const missingHtml = await missing.text();
  assert.match(missingHtml, /That did not sign you in/);
  assert.equal(
    missingHtml.replace(/nobody@example\.com/g, 'X'),
    wrongHtml.replace(/ann@example\.com/g, 'X'),
    'an unknown address and a wrong password must be indistinguishable',
  );

  const right = client(origin);
  const ok = await right.post('/account/sign-in', { email: 'Ann@Example.com', password: PASSWORD });
  assert.equal(ok.status, 303);
  assert.ok(right.jar.has('nova_session'));
});

test('signing out ends the session on the server, not only in the browser', async (t) => {
  const { origin } = await startServer(t);
  const browser = client(origin);
  await signUp(browser, { email: 'ann@example.com' });

  const stolen = browser.cookieHeader();
  assert.match(stolen, /nova_session=/);

  const out = await browser.post('/account/sign-out', {});
  assert.equal(out.status, 303);
  assert.equal(browser.jar.has('nova_session'), false);

  // The exact cookie the browser was holding a moment ago, replayed.
  const replay = await fetch(`${origin}/account`, { redirect: 'manual', headers: { cookie: stolen } });
  assert.equal(replay.status, 303);
  assert.match(replay.headers.get('location'), /\/account\/sign-in/);
});

test('signing out everywhere kills the other devices and keeps this one', async (t) => {
  const { origin } = await startServer(t);

  const laptop = client(origin);
  await signUp(laptop, { email: 'ann@example.com' });

  const phone = client(origin);
  await phone.post('/account/sign-in', { email: 'ann@example.com', password: PASSWORD });
  assert.equal((await phone.get('/account')).status, 200);

  assert.equal((await laptop.post('/account/sign-out-everywhere', {})).status, 303);

  assert.equal((await phone.get('/account')).status, 303, 'the other device should be signed out');
  assert.equal((await laptop.get('/account')).status, 200, 'and this one should not be');
});

test('the account page is private, and the sign-in form knows where to send you back', async (t) => {
  const { origin } = await startServer(t);
  const browser = client(origin);

  const redirected = await browser.get('/account');
  assert.equal(redirected.status, 303);
  assert.equal(redirected.headers.get('location'), '/account/sign-in?next=%2Faccount');

  await signUp(browser, { email: 'ann@example.com' });
  assert.equal((await browser.get('/account')).status, 200);
});

test('next= cannot be used to bounce somebody off this site', async (t) => {
  const { origin } = await startServer(t);

  for (const hostile of ['https://evil.example/steal', '//evil.example', '/\\evil.example', 'javascript:alert(1)']) {
    const browser = client(origin);
    const response = await browser.post('/account/new', {
      email: `user-${Math.random().toString(36).slice(2, 8)}@example.com`,
      password: PASSWORD,
      passwordConfirm: PASSWORD,
      next: hostile,
    });
    assert.equal(response.status, 303);
    const location = response.headers.get('location');
    assert.ok(location.startsWith('/account'), `next=${hostile} should not have gone to ${location}`);
  }
});

test('repeated wrong passwords are rate limited', async (t) => {
  const { origin } = await startServer(t);
  await signUp(client(origin), { email: 'ann@example.com' });

  const attacker = client(origin);
  let blocked = false;
  for (let attempt = 0; attempt < 14; attempt += 1) {
    const response = await attacker.post('/account/sign-in', {
      email: 'ann@example.com',
      password: `guess-${attempt}`,
    });
    if (response.status === 429) {
      blocked = true;
      break;
    }
  }
  assert.ok(blocked, 'the sign-in form must stop answering after a run of failures');

  // And the limit is real: the correct password does not get through while it holds.
  const correct = await attacker.post('/account/sign-in', { email: 'ann@example.com', password: PASSWORD });
  assert.equal(correct.status, 429);
});

/* ── The guest path must stay exactly as it was ────────────────────────────────────────── */

test('a guest still files, opens, replies to and reopens a ticket with no account', async (t) => {
  const { origin } = await startServer(t);
  const browser = client(origin);

  const form = await browser.get(FLOW).then((r) => r.text());
  assert.match(form, /How would you like to continue\?/);
  assert.match(form, /Continue with your email/);
  assert.match(form, /id="email"/, 'the guest email field must still be on the form');

  const created = await browser.post(FLOW, { ...TICKET, email: 'guest@example.com', name: 'Gus' });
  assert.equal(created.status, 303);
  const id = idFrom(created);

  const page = await browser.get(`/tickets/${id}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), new RegExp(id));

  const reply = await browser.post(`/tickets/${id}/replies`, { body: 'It happens on a second machine too.' });
  assert.equal(reply.status, 303);

  // Another device, using the ID and the address — the original way back in.
  const elsewhere = client(origin);
  const lookup = await elsewhere.post('/tickets', { ticketId: id, email: 'guest@example.com' });
  assert.equal(lookup.status, 303);
  assert.equal((await elsewhere.get(`/tickets/${id}`)).status, 200);
});

test('a guest ticket is stored as a guest ticket', async (t) => {
  const { origin, app } = await startServer(t);
  const browser = client(origin);

  const created = await browser.post(FLOW, { ...TICKET, email: 'guest@example.com' });
  const stored = await app.ctx.tickets.get(idFrom(created));

  assert.equal(stored.accountId, null);
  assert.equal(stored.requester.email, 'guest@example.com');
});

/* ── Filing while signed in ────────────────────────────────────────────────────────────── */

test('the form stops asking a signed-in reporter for their address', async (t) => {
  const { origin } = await startServer(t);
  const browser = client(origin);
  await signUp(browser, { email: 'ann@example.com' });

  const html = await browser.get(FLOW).then((r) => r.text());
  assert.match(html, /Filing as Ann/);
  assert.match(html, /ann@example\.com/);
  assert.equal(html.includes('How would you like to continue?'), false);
  assert.equal(/<input[^>]*id="email"/.test(html), false, 'there should be no email field to fill in');
});

test('a ticket filed while signed in belongs to the account', async (t) => {
  const { origin, app } = await startServer(t);
  const browser = client(origin);
  await signUp(browser, { email: 'ann@example.com' });

  const created = await browser.post(FLOW, TICKET);
  assert.equal(created.status, 303);
  const id = idFrom(created);

  const stored = await app.ctx.tickets.get(id);
  const account = await app.ctx.accounts.store.getByEmail('ann@example.com');

  assert.equal(stored.accountId, account.id);
  assert.equal(stored.requester.email, 'ann@example.com');
  assert.equal(stored.requester.name, 'Ann', 'the name comes off the account');

  const page = await browser.get(`/tickets/${id}`);
  assert.equal(page.status, 200, 'the account opens its own ticket');
});

test('a signed-in submission ignores an address somebody typed into the request by hand', async (t) => {
  const { origin, app } = await startServer(t);
  const browser = client(origin);
  await signUp(browser, { email: 'ann@example.com' });

  // The form does not render these fields; anything arriving in them was added deliberately.
  const created = await browser.post(FLOW, {
    ...TICKET,
    email: 'victim@example.com',
    name: 'Somebody Else',
  });

  const stored = await app.ctx.tickets.get(idFrom(created));
  assert.equal(stored.requester.email, 'ann@example.com', 'the session decides the address, not the form');
  assert.equal(stored.requester.name, 'Ann');
});

test('an account cannot be attached to a ticket by posting an account id', async (t) => {
  const { origin, app } = await startServer(t);

  const ann = client(origin);
  await signUp(ann, { email: 'ann@example.com' });
  const annAccount = await app.ctx.accounts.store.getByEmail('ann@example.com');

  const stranger = client(origin);
  const created = await stranger.post(FLOW, {
    ...TICKET,
    email: 'stranger@example.com',
    accountId: annAccount.id,
  });

  const stored = await app.ctx.tickets.get(idFrom(created));
  assert.equal(stored.accountId, null, 'a submitted accountId must be ignored entirely');
});

test('the account lists its own tickets and nobody else s', async (t) => {
  const { origin } = await startServer(t);

  const guest = client(origin);
  const guestTicket = idFrom(await guest.post(FLOW, { ...TICKET, email: 'ann@example.com' }));

  const ann = client(origin);
  await signUp(ann, { email: 'ann@example.com' });
  const mine = idFrom(await ann.post(FLOW, TICKET));

  const bob = client(origin);
  await signUp(bob, { email: 'bob@example.com', name: 'Bob' });
  const bobs = idFrom(await bob.post(FLOW, TICKET));

  const page = await ann.get('/account').then((r) => r.text());
  assert.ok(page.includes(mine), 'the account should list the ticket it filed');
  assert.equal(page.includes(bobs), false, "another account's ticket must not appear");
  assert.equal(
    page.includes(guestTicket),
    false,
    'a guest ticket filed with the same address must not be claimed by the account',
  );
});

/* ── The refusals. These are the tests this feature exists to pass. ────────────────────── */

test('one account cannot open another account s ticket', async (t) => {
  const { origin } = await startServer(t);

  const ann = client(origin);
  await signUp(ann, { email: 'ann@example.com' });
  const annsTicket = idFrom(await ann.post(FLOW, TICKET));

  const bob = client(origin);
  await signUp(bob, { email: 'bob@example.com', name: 'Bob' });

  assert.equal((await bob.get(`/tickets/${annsTicket}`)).status, 403);
  assert.equal((await bob.post(`/tickets/${annsTicket}/replies`, { body: 'Let me in please.' })).status, 403);
  assert.equal((await bob.get('/account').then((r) => r.text())).includes(annsTicket), false);
});

test('a stranger with the ticket id alone opens nothing', async (t) => {
  const { origin } = await startServer(t);

  const ann = client(origin);
  await signUp(ann, { email: 'ann@example.com' });
  const annsTicket = idFrom(await ann.post(FLOW, TICKET));

  const stranger = client(origin);
  assert.equal((await stranger.get(`/tickets/${annsTicket}`)).status, 403);
});

test('an unknown ticket id refuses exactly like somebody else s ticket', async (t) => {
  const { origin } = await startServer(t);

  const ann = client(origin);
  await signUp(ann, { email: 'ann@example.com' });
  const real = idFrom(await ann.post(FLOW, TICKET));

  const stranger = client(origin);
  const toReal = await stranger.get(`/tickets/${real}`);
  const toNothing = await stranger.get('/tickets/NH-0000-0000');

  assert.equal(toReal.status, toNothing.status);
  assert.equal(await toReal.text(), await toNothing.text(), 'the two must be indistinguishable');
});

test('the ID-and-address form does not open a ticket that belongs to an account', async (t) => {
  const { origin } = await startServer(t);

  const ann = client(origin);
  await signUp(ann, { email: 'ann@example.com' });
  const annsTicket = idFrom(await ann.post(FLOW, TICKET));

  // Somebody holding both the id and the right address still does not get in this way.
  const stranger = client(origin);
  const attempt = await stranger.post('/tickets', { ticketId: annsTicket, email: 'ann@example.com' });

  assert.equal(attempt.status, 403);
  assert.match(await attempt.text(), /belongs to a Nova Account/);
  assert.equal(stranger.jar.has('nh_pass'), false, 'no guest pass may be issued for an account ticket');
  assert.equal((await stranger.get(`/tickets/${annsTicket}`)).status, 403);
});

test('registering somebody s address does not hand over the tickets they filed as a guest', async (t) => {
  const { origin } = await startServer(t);

  // A guest files a ticket with their address.
  const victim = client(origin);
  const theirTicket = idFrom(await victim.post(FLOW, { ...TICKET, email: 'victim@example.com' }));

  // Somebody else registers that same address — nothing verifies it, so this is possible.
  const impostor = client(origin);
  await signUp(impostor, { email: 'victim@example.com', name: 'Not Them' });

  assert.equal((await impostor.get(`/tickets/${theirTicket}`)).status, 403);
  assert.equal((await impostor.get('/account').then((r) => r.text())).includes(theirTicket), false);
});

test('signing out revokes access to the tickets the session opened', async (t) => {
  const { origin } = await startServer(t);
  const browser = client(origin);
  await signUp(browser, { email: 'ann@example.com' });

  const id = idFrom(await browser.post(FLOW, TICKET));
  assert.equal((await browser.get(`/tickets/${id}`)).status, 200);

  await browser.post('/account/sign-out', {});
  assert.equal(
    (await browser.get(`/tickets/${id}`)).status,
    403,
    'filing while signed in must not also leave a guest pass on the device',
  );
});

test('a guest pass for one ticket still opens nothing else, account or not', async (t) => {
  const { origin } = await startServer(t);

  const ann = client(origin);
  await signUp(ann, { email: 'ann@example.com' });
  const annsTicket = idFrom(await ann.post(FLOW, TICKET));

  const guest = client(origin);
  const guestTicket = idFrom(await guest.post(FLOW, { ...TICKET, email: 'guest@example.com' }));

  assert.equal((await guest.get(`/tickets/${guestTicket}`)).status, 200);
  assert.equal((await guest.get(`/tickets/${annsTicket}`)).status, 403);
  assert.equal((await ann.get(`/tickets/${guestTicket}`)).status, 403);
});

/* ── The JSON API follows the same rules ───────────────────────────────────────────────── */

test('the API will not hand over an account ticket to somebody who only knows the address', async (t) => {
  const { origin } = await startServer(t);

  const ann = client(origin);
  await signUp(ann, { email: 'ann@example.com' });
  const annsTicket = idFrom(await ann.post(FLOW, TICKET));

  const stranger = client(origin);
  const refused = await stranger.get(`/api/tickets/${annsTicket}?email=ann%40example.com`);
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).error, /Nova Account/);

  const allowed = await ann.get(`/api/tickets/${annsTicket}`);
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).ticket.id, annsTicket);
});

test('the API still opens a guest ticket with its filing address', async (t) => {
  const { origin } = await startServer(t);
  const guest = client(origin);
  const id = idFrom(await guest.post(FLOW, { ...TICKET, email: 'guest@example.com' }));

  const stranger = client(origin);
  const response = await stranger.get(`/api/tickets/${id}?email=guest%40example.com`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ticket.id, id);
});

test('a ticket filed through the API while signed in belongs to the account', async (t) => {
  const { origin, app } = await startServer(t);
  const browser = client(origin);
  await signUp(browser, { email: 'ann@example.com' });

  const response = await browser.json('/api/tickets', {
    project: 'online-earth',
    category: 'globe',
    issueType: 'globe-not-loading',
    ...TICKET,
    email: 'someone-else@example.com',
  });

  assert.equal(response.status, 201);
  const { ticket } = await response.json();
  const stored = await app.ctx.tickets.get(ticket.id);
  const account = await app.ctx.accounts.store.getByEmail('ann@example.com');

  assert.equal(stored.accountId, account.id);
  assert.equal(stored.requester.email, 'ann@example.com');
});

/* ── Nothing sensitive reaches a page ──────────────────────────────────────────────────── */

test('no page ever renders a password hash, a session token or another account s address', async (t) => {
  const { origin, app } = await startServer(t);

  const ann = client(origin);
  await signUp(ann, { email: 'ann@example.com' });
  const id = idFrom(await ann.post(FLOW, TICKET));

  const bob = client(origin);
  await signUp(bob, { email: 'bob@example.com', name: 'Bob' });

  const stored = await app.ctx.accounts.store.getByEmail('ann@example.com');
  const token = ann.cookieHeader().split('nova_session=')[1]?.split(';')[0];

  for (const url of ['/', '/account', `/tickets/${id}`, FLOW, '/tickets', '/privacy']) {
    const html = await ann.get(url).then((r) => r.text());
    assert.equal(html.includes(stored.password), false, `${url} rendered the password hash`);
    assert.equal(html.includes('scrypt$'), false, `${url} rendered a hash record`);
    assert.equal(html.includes(token), false, `${url} rendered the session token`);
    assert.equal(html.includes('bob@example.com'), false, `${url} rendered another account's address`);
  }
});
