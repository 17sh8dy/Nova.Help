/**
 * The whole portal, standing on D1 and R2, driven the way a browser drives it.
 *
 * The store contracts prove each adapter means what the JSON one means. This proves the
 * ASSEMBLY: that createApp wires the D1 stores in, that a ticket filed through the real guided
 * flow lands in real tables, that an attachment goes to the bucket and comes back with the
 * headers that keep it from executing, and that a Nova Account signs in, sees its own tickets
 * and signs out again with its sessions living in `account_sessions` rather than in a JSON
 * array on disk.
 *
 * The journeys are the ones the file-backed suite already covers, deliberately. If these two
 * ever disagree, the migration has changed behaviour — which is the thing it must not do.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createApp } from '../server/app.mjs';
import { createD1TicketStore } from '../server/store/d1Store.mjs';
import { createD1AccountStore } from '@nova/accounts/d1Store';
import { createR2AttachmentStore } from '../server/store/r2Attachments.mjs';
import { createSqliteD1 } from '../server/store/sqliteD1.mjs';
import { createLocalR2 } from '../server/store/localR2.mjs';
import { applySchema } from '../server/store/migrate.mjs';

const CHEAP = { N: 1024, r: 8, p: 1 };
const PASSWORD = 'a passphrase nobody guesses';
const FLOW = '/help/online-earth/globe/globe-not-loading';

const TICKET = {
  subject: 'The globe never finishes loading',
  description: 'It sits on the loading spinner forever on a fresh profile, on two machines.',
  email: 'reporter@example.com',
  name: 'Sam',
  priority: 'high',
  platform: 'Windows',
  appVersion: '1.4.0',
};

/** The portal on D1 + R2, on an ephemeral port. */
async function startServer(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'novahelp-d1app-'));
  const db = createSqliteD1({ path: path.join(dir, 'nova.sqlite') });
  await applySchema(db);
  const bucket = createLocalR2({ dir: path.join(dir, 'r2') });

  const app = await createApp({
    dataDir: dir,
    dev: true,
    logger: { warn() {}, error() {} },
    passwordCost: CHEAP,
    signingSecret: 'a-test-signing-secret-of-sufficient-length',
    stores: {
      tickets: createD1TicketStore({ db }),
      accounts: createD1AccountStore({ db }),
      attachments: createR2AttachmentStore({ bucket }),
    },
  });

  const server = http.createServer((req, res) => app.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  return { origin, db, bucket, app };
}

/** A browser-ish client with one cookie jar, matching the one the file-backed suite uses. */
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
    raw: go,
  };
}

const idFrom = (response) => decodeURIComponent(response.headers.get('location').split('/').pop().split('?')[0]);

async function fileTicket(browser, overrides = {}) {
  const response = await browser.post(FLOW, { ...TICKET, ...overrides });
  assert.equal(response.status, 303, await response.text());
  return { id: idFrom(response), location: response.headers.get('location') };
}

const signUp = (browser, email, name = 'Ann') =>
  browser.post('/account/new', { email, displayName: name, password: PASSWORD, passwordConfirm: PASSWORD });

/* ── Filing and reading a ticket ─────────────────────────────────────────────────────────── */

test('[d1] a ticket filed through the flow lands in the tables', async (t) => {
  const { origin, db } = await startServer(t);
  const { id } = await fileTicket(client(origin));

  const row = await db.prepare('SELECT * FROM tickets WHERE id = ?').bind(id).first();
  assert.equal(row.subject, TICKET.subject);
  assert.equal(row.status, 'open');
  assert.equal(row.project, 'online-earth');
  assert.equal(row.priority, 'high');
  assert.equal(row.version, 1, 'a fresh ticket is at version 1');
  assert.equal(row.account_id, null, 'filed as a guest');
  assert.match(row.requester_email_hash, /^[0-9a-f]{64}$/);
  assert.equal(row.requester_email_hash.includes('reporter'), false, 'the index holds a digest');

  const events = await db.prepare('SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY seq').bind(id).all();
  assert.equal(events.results.length, 1);
  assert.equal(events.results[0].type, 'created');
  assert.equal(events.results[0].seq, 0);
  assert.equal(events.results[0].visibility, 'public');
});

test('[d1] the ticket page opens with the pass it handed back, and not without it', async (t) => {
  const { origin } = await startServer(t);
  const browser = client(origin);
  const { id, location } = await fileTicket(browser);

  const withPass = await browser.get(location);
  assert.equal(withPass.status, 200);
  assert.match(await withPass.text(), /The globe never finishes loading/);

  const stranger = await client(origin).get(`/tickets/${id}`);
  assert.equal(stranger.status, 403, 'an id on its own opens nothing');
});

test('[d1] looking a ticket up needs the address it was filed with', async (t) => {
  const { origin } = await startServer(t);
  const { id } = await fileTicket(client(origin));

  /* A wrong address fails exactly like an unknown id — same status, same message — so the
     form cannot be used to find out whether a ticket exists. */
  const wrong = await client(origin).post('/tickets', { ticketId: id, email: 'someone@else.com' });
  const unknown = await client(origin).post('/tickets', { ticketId: 'NH-0000-0000', email: TICKET.email });
  assert.equal(wrong.status, 404);
  assert.equal(unknown.status, 404);

  const right = await client(origin).post('/tickets', { ticketId: id.toLowerCase(), email: 'REPORTER@example.com' });
  assert.equal(right.status, 303, 'and the address is matched however it was typed');
});

/* ── Replies ─────────────────────────────────────────────────────────────────────────────── */

test('[d1] a reply is appended as its own row and shows on the page', async (t) => {
  const { origin, db } = await startServer(t);
  const browser = client(origin);
  const { id } = await fileTicket(browser);

  const reply = await browser.post(`/tickets/${id}/replies`, { body: 'Still happening after the update.' });
  assert.equal(reply.status, 303, await reply.text());

  const events = await db.prepare('SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY seq').bind(id).all();
  assert.deepEqual(events.results.map((e) => e.seq), [0, 1]);
  assert.equal(events.results[1].type, 'reply');
  assert.equal(events.results[1].body, 'Still happening after the update.');

  const page = await browser.get(`/tickets/${id}`).then((r) => r.text());
  assert.match(page, /Still happening after the update\./);
});

test('[d1] concurrent replies to one ticket all land, and each takes its own position', async (t) => {
  const { origin, db } = await startServer(t);
  const browser = client(origin);
  const { id } = await fileTicket(browser);

  /* The case that made the JSON store need a lock at all. Here the append is a row, so these
     do not contend — and none of them may be lost or duplicated. */
  const responses = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      browser.post(`/tickets/${id}/replies`, { body: `Reply number ${i}, with enough text to pass validation.` }),
    ),
  );
  assert.deepEqual([...new Set(responses.map((r) => r.status))], [303]);

  const events = await db
    .prepare("SELECT * FROM ticket_events WHERE ticket_id = ? AND type = 'reply' ORDER BY seq")
    .bind(id)
    .all();
  assert.equal(events.results.length, 6, 'no reply was lost');
  assert.equal(new Set(events.results.map((e) => e.seq)).size, 6, 'and none shared a position');
  assert.equal(new Set(events.results.map((e) => e.id)).size, 6, 'and none was written twice');
});

/* ── Attachments ─────────────────────────────────────────────────────────────────────────── */

test('[d1] an attached file goes to the bucket, and comes back as a download', async (t) => {
  const { origin, bucket, db } = await startServer(t);
  const browser = client(origin);

  const form = new FormData();
  for (const [key, value] of Object.entries(TICKET)) form.set(key, value);
  form.set('files', new Blob(['log line one\nlog line two'], { type: 'text/plain' }), 'session.log');

  const created = await browser.raw(FLOW, { method: 'POST', body: form });
  assert.equal(created.status, 303, await created.text());
  const id = idFrom(created);

  const stored = await db.prepare('SELECT * FROM ticket_attachments WHERE ticket_id = ?').bind(id).all();
  assert.equal(stored.results.length, 1);
  assert.equal(stored.results[0].filename, 'session.log');
  assert.equal(stored.results[0].position, 0);

  const object = await bucket.get(`tickets/${id}/${stored.results[0].id}`);
  assert.notEqual(object, null, 'the bytes are in R2, not in D1');
  assert.equal(object.httpMetadata.contentType, 'application/octet-stream');

  const page = await browser.get(`/tickets/${id}`).then((r) => r.text());
  assert.match(page, /session\.log/);
  const href = /href="(\/tickets\/[^"]*\/attachments\/[^"]*)"/.exec(page)?.[1];
  assert.ok(href, 'no attachment link on the ticket page');

  const download = await browser.get(href);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /^attachment;/);
  assert.equal(await download.text(), 'log line one\nlog line two');
});

/* ── Accounts ────────────────────────────────────────────────────────────────────────────── */

test('[d1] an account signs up and its session lives in the sessions table', async (t) => {
  const { origin, db } = await startServer(t);
  const browser = client(origin);

  const registered = await signUp(browser, 'bo@example.com', 'Bo');
  assert.equal(registered.status, 303, await registered.text());

  const row = await db.prepare('SELECT * FROM accounts WHERE email_normalized = ?').bind('bo@example.com').first();
  assert.ok(row, 'the account is a row');
  assert.match(row.password, /^scrypt\$/, 'and the password is a hash record, not a password');
  assert.equal(row.email, 'bo@example.com');
  assert.equal(row.status, 'active');

  const sessions = await db.prepare('SELECT * FROM account_sessions WHERE account_id = ?').bind(row.id).all();
  assert.equal(sessions.results.length, 1, 'signing up opened exactly one session');
  assert.equal(sessions.results[0].product, 'nova.help');

  const products = await db.prepare('SELECT product FROM account_products WHERE account_id = ?').bind(row.id).all();
  assert.deepEqual(products.results.map((p) => p.product), ['nova.help']);

  const page = await browser.get('/account');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Bo/);
});

test('[d1] a taken address is refused by the unique index, not by a lock', async (t) => {
  const { origin } = await startServer(t);
  assert.equal((await signUp(client(origin), 'clash@example.com')).status, 303);

  const second = await signUp(client(origin), 'clash@example.com');
  assert.equal(second.status, 422, 're-renders the form rather than redirecting');
  assert.match(await second.text(), /already uses that address/i);
});

test('[d1] signing in on two devices at once records both sessions', async (t) => {
  const { origin, db } = await startServer(t);
  await signUp(client(origin), 'two@example.com');

  /* Under the JSON store this needed a lock, and without one a device could be handed a token
     for a session that was never recorded. Here a session is a row and they cannot collide. */
  const devices = [client(origin), client(origin), client(origin)];
  const results = await Promise.all(
    devices.map((browser) => browser.post('/account/sign-in', { email: 'two@example.com', password: PASSWORD })),
  );
  assert.deepEqual([...new Set(results.map((r) => r.status))], [303]);

  const account = await db.prepare('SELECT id FROM accounts WHERE email_normalized = ?').bind('two@example.com').first('id');
  const sessions = await db.prepare('SELECT * FROM account_sessions WHERE account_id = ?').bind(account).all();
  assert.equal(sessions.results.length, 4, 'the sign-up session plus one per device');

  // And every one of them actually works.
  for (const browser of devices) assert.equal((await browser.get('/account')).status, 200);
});

test('[d1] signing out removes the row, and the old cookie stops working', async (t) => {
  const { origin, db } = await startServer(t);
  const browser = client(origin);
  await signUp(browser, 'out@example.com');

  const cookie = [...browser.jar].map(([n, v]) => `${n}=${v}`).join('; ');
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM account_sessions').first('n'), 1);

  assert.equal((await browser.post('/account/sign-out', {})).status, 303);
  assert.equal(
    await db.prepare('SELECT COUNT(*) AS n FROM account_sessions').first('n'),
    0,
    'the session is gone from the store, not merely from the browser',
  );

  /* The whole reason sessions are stored rather than only signed: the old cookie is still a
     valid signature, and it must still stop working. */
  const replay = await client(origin).get('/account', { headers: { cookie } });
  assert.equal(replay.status, 303, 'sent back to sign in');
});

test('[d1] signing out everywhere clears every session at once', async (t) => {
  const { origin, db } = await startServer(t);
  const first = client(origin);
  await signUp(first, 'all@example.com');
  const second = client(origin);
  await second.post('/account/sign-in', { email: 'all@example.com', password: PASSWORD });

  assert.equal((await second.get('/account')).status, 200);
  assert.equal((await first.post('/account/sign-out-everywhere', {})).status, 303);

  /* The route clears every session and then opens a fresh one for the device that asked, so
     the person pressing the button is not signed out of the page they are looking at. */
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM account_sessions').first('n'), 1);
  assert.equal((await first.get('/account')).status, 200, 'this device stays in');
  assert.equal((await second.get('/account')).status, 303, 'and every other device is out');
});

test('[d1] an account sees its own tickets and never a guest ticket at the same address', async (t) => {
  const { origin, db } = await startServer(t);
  const browser = client(origin);
  await signUp(browser, 'mine@example.com');

  await fileTicket(browser, { email: 'mine@example.com', subject: 'Mine and mine alone, filed while signed in' });
  // The same address, but filed by a guest. It must not be swept in.
  await fileTicket(client(origin), { email: 'mine@example.com', subject: 'Filed as a guest, not owned' });

  const account = await db.prepare('SELECT id FROM accounts WHERE email_normalized = ?').bind('mine@example.com').first('id');
  const owned = await db.prepare('SELECT subject FROM tickets WHERE account_id = ?').bind(account).all();
  assert.deepEqual(owned.results.map((r) => r.subject), ['Mine and mine alone, filed while signed in']);

  const html = await browser.get('/account').then((r) => r.text());
  assert.match(html, /Mine and mine alone/);
  assert.equal(
    /Filed as a guest, not owned/.test(html),
    false,
    'a matching address is not proof of anything — see docs/NOVA-ACCOUNTS.md',
  );
});

/* ── The operational view ────────────────────────────────────────────────────────────────── */

test('[d1] the stats endpoint counts by status straight from SQL', async (t) => {
  const { origin } = await startServer(t);
  const browser = client(origin);
  await fileTicket(browser);
  await fileTicket(browser, { subject: 'A second thing that is comprehensively broken' });

  const response = await browser.get('/api/stats');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { total: 2, byStatus: { open: 2 } });
});

test('[d1] the JSON API answers for a caller holding the filing address, and not otherwise', async (t) => {
  const { origin } = await startServer(t);
  const { id } = await fileTicket(client(origin));

  const found = await client(origin).get(`/api/tickets/${id}?email=${encodeURIComponent(TICKET.email)}`);
  assert.equal(found.status, 200);
  const body = await found.json();
  assert.equal(body.ticket.id, id);
  assert.equal(body.ticket.subject, TICKET.subject);

  const denied = await client(origin).get(`/api/tickets/${id}`);
  assert.equal(denied.status, 403);
});
