/**
 * End-to-end tests against a real server on a real port.
 *
 * These exist because the unit tests cannot see the things that actually break a support
 * portal: a form that posts to the wrong place, a ticket page that opens without a pass, an
 * attachment served with a content type a browser will execute. Every test here drives the
 * portal the way a browser does — form-encoded posts, cookies, redirects followed by hand.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createApp } from '../server/app.mjs';

/** Start the portal on an ephemeral port with a throwaway data directory. */
async function startServer(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'novahelp-http-'));
  const app = await createApp({ dataDir: dir, dev: true, logger: { warn() {}, error() {} } });
  const server = http.createServer((req, res) => app.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  return { origin, dir, app };
}

/** fetch, with redirects left alone so the tests can assert on them. */
const call = (origin, url, options = {}) =>
  fetch(`${origin}${url}`, { redirect: 'manual', ...options });

const formPost = (origin, url, fields, options = {}) =>
  call(origin, url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(options.headers ?? {}) },
    body: new URLSearchParams(fields).toString(),
    ...options,
  });

const cookieFrom = (response) => (response.headers.get('set-cookie') ?? '').split(';')[0];

const TICKET = {
  subject: 'The globe never finishes loading',
  description: 'It sits on the loading spinner forever on a fresh profile, on two machines.',
  email: 'reporter@example.com',
  name: 'Sam',
  priority: 'high',
  platform: 'Windows',
  appVersion: '1.4.0',
};

const FLOW = '/help/online-earth/globe/globe-not-loading';

/** File a ticket the way the form does, and return its id plus the pass cookie. */
async function fileTicket(origin, overrides = {}) {
  const response = await formPost(origin, FLOW, { ...TICKET, ...overrides });
  assert.equal(response.status, 303, await response.text());
  const location = response.headers.get('location');
  return {
    id: decodeURIComponent(location.split('/').pop().split('?')[0]),
    cookie: cookieFrom(response),
    location,
  };
}

/* ── The guided flow ───────────────────────────────────────────────────────────────────── */

test('the homepage asks the question and lists every product', async (t) => {
  const { origin } = await startServer(t);
  const response = await call(origin, '/');
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /What do you need help with\?/);
  for (const name of ['Nova Site', 'Online Earth', 'Atlas', 'Open Cut', 'Nova Engine', 'Replay.GG']) {
    assert.ok(html.includes(name), `homepage is missing ${name}`);
  }
  // The launcher is deliberately not offered yet.
  assert.equal(html.includes('Nova Launcher'), false);
});

test('three clicks reach the ticket form with the selection made', async (t) => {
  const { origin } = await startServer(t);

  const step1 = await call(origin, '/help/online-earth');
  assert.equal(step1.status, 200);
  assert.match(await step1.text(), /Globe &amp; maps/);

  const step2 = await call(origin, '/help/online-earth/globe');
  assert.equal(step2.status, 200);
  assert.match(await step2.text(), /globe isn&#39;t loading/);

  const step3 = await call(origin, FLOW);
  const form = await step3.text();
  assert.equal(step3.status, 200);
  assert.match(form, /Online Earth/);
  assert.match(form, /Globe &amp; maps/);
  assert.match(form, /enctype="multipart\/form-data"/);
});

test('an issue type with articles offers them above the form', async (t) => {
  const { origin } = await startServer(t);
  const html = await call(origin, FLOW).then((r) => r.text());
  assert.match(html, /Worth trying first/);
  assert.match(html, /WebGL/);
});

test('an issue type with no articles shows no suggestion panel', async (t) => {
  const { origin } = await startServer(t);
  const html = await call(origin, '/help/online-earth/globe/search-results').then((r) => r.text());
  assert.equal(html.includes('Worth trying first'), false);
});

test('unknown products, areas and issues are 404 pages, not crashes', async (t) => {
  const { origin } = await startServer(t);
  for (const url of ['/help/nope', '/help/atlas/nope', '/help/atlas/voice/nope', '/nothing-here']) {
    const response = await call(origin, url);
    assert.equal(response.status, 404, url);
    assert.match(await response.text(), /could not find that/i);
  }
});

/* ── Creating a ticket ─────────────────────────────────────────────────────────────────── */

test('submitting the form creates a ticket and grants access to it', async (t) => {
  const { origin } = await startServer(t);
  const { id, cookie, location } = await fileTicket(origin);

  assert.match(id, /^NH-/);
  assert.match(location, /\?created=1$/);
  assert.match(cookie, /^nh_pass=/);

  const page = await call(origin, location, { headers: { cookie } });
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.ok(html.includes(id));
  assert.match(html, /has been created/);
  assert.match(html, /The globe never finishes loading/);
});

test('an invalid submission re-renders the form with the text still in it', async (t) => {
  const { origin } = await startServer(t);
  const response = await formPost(origin, FLOW, { ...TICKET, email: 'nonsense' });
  const html = await response.text();

  assert.equal(response.status, 422);
  assert.match(html, /Your ticket was not sent/);
  assert.match(html, /does not look like an email address/);
  assert.ok(html.includes('It sits on the loading spinner forever'), 'description was lost');
});

test('a submission that fills the honeypot is refused', async (t) => {
  const { origin } = await startServer(t);
  const response = await formPost(origin, FLOW, { ...TICKET, website: 'http://spam.example' });
  assert.equal(response.status, 422);
  assert.match(await response.text(), /looked automated/);
});

test('a tampered priority on a pinned issue type is ignored', async (t) => {
  const { origin } = await startServer(t);
  const { id, cookie } = await fileTicket(origin, {}, {});

  // File a feature request claiming urgency.
  const response = await formPost(origin, '/help/online-earth/feedback/feature-request', {
    ...TICKET,
    priority: 'urgent',
  });
  const featureId = decodeURIComponent(response.headers.get('location').split('/').pop().split('?')[0]);
  const featureCookie = cookieFrom(response);

  const html = await call(origin, `/tickets/${featureId}`, { headers: { cookie: featureCookie } }).then((r) => r.text());
  assert.match(html, /badge[^>]*>Low</);
  assert.ok(id && cookie);
});

test('rate limiting stops a flood of tickets', async (t) => {
  const { origin } = await startServer(t);
  let limited = false;
  for (let i = 0; i < 12; i += 1) {
    const response = await formPost(origin, FLOW, { ...TICKET, subject: `Ticket number ${i} in a row` });
    if (response.status === 429) {
      limited = true;
      assert.ok(response.headers.get('retry-after'));
      break;
    }
  }
  assert.equal(limited, true, 'the create limiter never engaged');
});

/* ── Reading a ticket ──────────────────────────────────────────────────────────────────── */

test('a ticket page is refused without a pass', async (t) => {
  const { origin } = await startServer(t);
  const { id } = await fileTicket(origin);

  const response = await call(origin, `/tickets/${id}`);
  assert.equal(response.status, 403);
  assert.match(await response.text(), /need to open this ticket first/);
});

test('a pass for one ticket does not open another', async (t) => {
  const { origin } = await startServer(t);
  const first = await fileTicket(origin);
  const second = await fileTicket(origin, { subject: 'A different problem entirely here' });

  const response = await call(origin, `/tickets/${second.id}`, { headers: { cookie: first.cookie } });
  assert.equal(response.status, 403);
});

test('lookup with the right id and address opens the ticket', async (t) => {
  const { origin } = await startServer(t);
  const { id } = await fileTicket(origin);

  const response = await formPost(origin, '/tickets', { ticketId: id.toLowerCase(), email: 'REPORTER@example.com' });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), `/tickets/${id}`);

  const page = await call(origin, `/tickets/${id}`, { headers: { cookie: cookieFrom(response) } });
  assert.equal(page.status, 200);
});

test('lookup with the wrong address fails exactly like an unknown id', async (t) => {
  const { origin } = await startServer(t);
  const { id } = await fileTicket(origin);

  const wrongEmail = await formPost(origin, '/tickets', { ticketId: id, email: 'someone@else.com' });
  const wrongId = await formPost(origin, '/tickets', { ticketId: 'NH-0000-0000', email: TICKET.email });

  // The two responses differ only in the values echoed back into the form. Everything that
  // could tell an attacker a ticket exists — the status and the message — is identical.
  assert.equal(wrongEmail.status, 404);
  assert.equal(wrongId.status, 404);

  const message = /<p class="notice__title">([^<]*)<\/p>\s*<p>([^<]*)<\/p>/;
  const [, wrongEmailTitle, wrongEmailBody] = message.exec(await wrongEmail.text());
  const [, wrongIdTitle, wrongIdBody] = message.exec(await wrongId.text());

  assert.equal(wrongEmailTitle, wrongIdTitle);
  assert.equal(wrongEmailBody, wrongIdBody);
  assert.match(wrongEmailTitle, /could not open that ticket/);
});

/* ── Replying ──────────────────────────────────────────────────────────────────────────── */

test('a reply appears on the ticket, and needs a pass', async (t) => {
  const { origin } = await startServer(t);
  const { id, cookie } = await fileTicket(origin);

  const refused = await formPost(origin, `/tickets/${id}/replies`, { body: 'Any news?' });
  assert.equal(refused.status, 403);

  const accepted = await formPost(origin, `/tickets/${id}/replies`, {
    body: 'I have attached the log file now.',
  }, { headers: { cookie } });
  assert.equal(accepted.status, 303);

  const html = await call(origin, `/tickets/${id}`, { headers: { cookie } }).then((r) => r.text());
  assert.match(html, /I have attached the log file now\./);
});

test('an empty reply is rejected in place', async (t) => {
  const { origin } = await startServer(t);
  const { id, cookie } = await fileTicket(origin);

  const response = await formPost(origin, `/tickets/${id}/replies`, { body: '  ' }, { headers: { cookie } });
  assert.equal(response.status, 422);
  assert.match(await response.text(), /Write your reply/);
});

/* ── Attachments ───────────────────────────────────────────────────────────────────────── */

test('an uploaded file round-trips and is served as a download', async (t) => {
  const { origin } = await startServer(t);

  const form = new FormData();
  for (const [key, value] of Object.entries(TICKET)) form.set(key, value);
  form.set('files', new Blob(['log line one\nlog line two'], { type: 'text/plain' }), 'session.log');

  const created = await call(origin, FLOW, { method: 'POST', body: form });
  assert.equal(created.status, 303);
  const id = decodeURIComponent(created.headers.get('location').split('/').pop().split('?')[0]);
  const cookie = cookieFrom(created);

  const page = await call(origin, `/tickets/${id}`, { headers: { cookie } }).then((r) => r.text());
  assert.match(page, /session\.log/);

  const href = /href="(\/tickets\/[^"]*\/attachments\/[^"]*)"/.exec(page)?.[1];
  assert.ok(href, 'no attachment link on the ticket page');

  const download = await call(origin, href, { headers: { cookie } });
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /^attachment;/);
  assert.equal(await download.text(), 'log line one\nlog line two');

  const refused = await call(origin, href);
  assert.equal(refused.status, 403);
});

test('an HTML upload is refused rather than stored', async (t) => {
  const { origin } = await startServer(t);

  const form = new FormData();
  for (const [key, value] of Object.entries(TICKET)) form.set(key, value);
  form.set('files', new Blob(['<script>alert(1)</script>'], { type: 'text/html' }), 'payload.html');

  const response = await call(origin, FLOW, { method: 'POST', body: form });
  assert.equal(response.status, 422);
  assert.match(await response.text(), /cannot accept/);
});

/* ── Escaping ──────────────────────────────────────────────────────────────────────────── */

test('markup in a subject is rendered as text, not as markup', async (t) => {
  const { origin } = await startServer(t);
  const subject = '<img src=x onerror="alert(1)"> broken globe';
  const { id, cookie } = await fileTicket(origin, { subject });

  const html = await call(origin, `/tickets/${id}`, { headers: { cookie } }).then((r) => r.text());
  assert.equal(html.includes('<img src=x'), false);
  assert.match(html, /&lt;img src=x/);
});

/* ── Headers and static assets ─────────────────────────────────────────────────────────── */

test('every page carries the security headers', async (t) => {
  const { origin } = await startServer(t);
  const response = await call(origin, '/');
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
});

test('the stylesheet and script are served', async (t) => {
  const { origin } = await startServer(t);
  for (const [url, type] of [
    ['/assets/help.css', /text\/css/],
    ['/assets/help.js', /javascript/],
    ['/assets/favicon.svg', /image\/svg/],
  ]) {
    const response = await call(origin, url);
    assert.equal(response.status, 200, url);
    assert.match(response.headers.get('content-type'), type);
  }
});

test('static serving cannot be walked out of public/', async (t) => {
  const { origin } = await startServer(t);
  for (const url of ['/assets/../../package.json', '/../package.json', '/assets/%2e%2e/%2e%2e/package.json']) {
    const response = await call(origin, url);
    assert.notEqual(response.status, 200, url);
  }
});

/* ── The JSON API ──────────────────────────────────────────────────────────────────────── */

test('the catalog API serves the whole tree with the policy attached', async (t) => {
  const { origin } = await startServer(t);
  const body = await call(origin, '/api/catalog').then((r) => r.json());

  assert.equal(body.projects.length, 6);
  assert.equal(body.statuses.length, 5);
  assert.equal(body.policy.autoRespond, false);

  const account = body.projects
    .find((p) => p.id === 'online-earth')
    .categories.find((c) => c.id === 'account');
  assert.equal(account.sensitive, true);
  assert.equal(account.issueTypes.every((t2) => t2.sensitive), true);
});

test('the API creates a ticket through the same service as the form', async (t) => {
  const { origin } = await startServer(t);
  const response = await call(origin, '/api/tickets', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      project: 'atlas',
      category: 'voice',
      issueType: 'no-speech',
      subject: 'Atlas stopped speaking after an update',
      description: 'Voice output worked yesterday and produces silence today on the same device.',
      email: 'someone@example.com',
      priority: 'normal',
      source: 'assistant',
    }),
  });

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.match(body.ticket.id, /^NH-/);
  assert.equal(body.ticket.status, 'open');
  assert.equal(body.assistant.autoRespond, false);
  assert.equal(body.assistant.mayDecide, false);
});

test('the API refuses an invalid ticket with per-field errors', async (t) => {
  const { origin } = await startServer(t);
  const response = await call(origin, '/api/tickets', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: 'atlas' }),
  });

  assert.equal(response.status, 422);
  const body = await response.json();
  assert.ok(body.fields.subject);
  assert.ok(body.fields.email);
});

test('the API will not hand over a ticket without the filing address', async (t) => {
  const { origin } = await startServer(t);
  const { id } = await fileTicket(origin);

  assert.equal((await call(origin, `/api/tickets/${id}`)).status, 403);
  assert.equal((await call(origin, `/api/tickets/${id}?email=wrong@example.com`)).status, 403);

  const allowed = await call(origin, `/api/tickets/${id}?email=${encodeURIComponent(TICKET.email)}`);
  assert.equal(allowed.status, 200);
  const body = await allowed.json();
  assert.equal(body.ticket.id, id);
  assert.equal(body.ticket.events.length, 1);
});

test('resolve tells a classifier whether its guess exists and who may answer it', async (t) => {
  const { origin } = await startServer(t);

  const ok = await call(origin, '/api/resolve/online-earth/account/account-security').then((r) => r.json());
  assert.equal(ok.issueType.sensitive, true);
  assert.equal(ok.assistant.suggest, false);
  assert.equal(ok.formUrl, '/help/online-earth/account/account-security');

  assert.equal((await call(origin, '/api/resolve/online-earth/account/invented')).status, 404);
});

test('unknown API paths answer in JSON, not HTML', async (t) => {
  const { origin } = await startServer(t);
  const response = await call(origin, '/api/nothing');
  assert.equal(response.status, 404);
  assert.match(response.headers.get('content-type'), /application\/json/);
});

test('a GET-only route answers 405 with Allow when posted to', async (t) => {
  const { origin } = await startServer(t);
  const response = await formPost(origin, '/help/online-earth', {});
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET');
});
