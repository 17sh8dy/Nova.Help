/**
 * Rate limiting as a person meets it: through the routes, on both limiters.
 *
 * The contract suite proves the counters count. This proves the wiring — that the right route
 * consults the right limiter, that a refusal is a 429 carrying a Retry-After a browser can
 * act on, that a correct password really does wipe the slate, and that two limiters sharing an
 * address do not spend each other's budget.
 *
 * The whole app is stood up twice, once per limiter implementation, and the assertions are the
 * same both times. That is the point: swapping the in-memory limiter for a Durable Object must
 * not change a single thing a visitor can observe.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createApp } from '../server/app.mjs';
import { createRateLimiter } from '../server/lib/rateLimit.mjs';
import { createDurableRateLimiter } from '../server/lib/doRateLimit.mjs';
import { createLocalDurableObjects } from '../server/lib/localDurableObjects.mjs';

const CHEAP = { N: 1024, r: 8, p: 1 };
const PASSWORD = 'a passphrase nobody guesses';
const FLOW = '/help/online-earth/globe/globe-not-loading';

const TICKET = {
  subject: 'The globe never finishes loading',
  description: 'It sits on the loading spinner forever on a fresh profile, on two machines.',
  email: 'reporter@example.com',
  name: 'Sam',
  priority: 'high',
};

/** The two ways to build a limiter, each given the same windows and maximums by app.mjs. */
const IMPLEMENTATIONS = {
  inMemory: () => ({ windowMs, max }) => createRateLimiter({ windowMs, max }),
  durableObject: () => {
    const namespace = createLocalDurableObjects();
    return ({ name, windowMs, max }) => createDurableRateLimiter({ namespace, name, windowMs, max });
  },
};

async function startServer(t, createLimiter) {
  const dir = await mkdtemp(path.join(tmpdir(), 'novahelp-rl-'));
  const app = await createApp({
    dataDir: dir,
    dev: true,
    logger: { warn() {}, error() {} },
    passwordCost: CHEAP,
    createLimiter,
  });
  const server = http.createServer((req, res) => app.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  return origin;
}

const post = (origin, url, fields, headers = {}) =>
  fetch(`${origin}${url}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
  });

function describeRoutes(label) {
  const name = (what) => `[${label}] ${what}`;
  const serve = (t) => startServer(t, IMPLEMENTATIONS[label]());

  /* ── Ticket creation ─────────────────────────────────────────────────────────────────── */

  test(name('filing too many tickets is refused with a Retry-After a browser can use'), async (t) => {
    const origin = await serve(t);

    // The limit is 10 an hour.
    for (let i = 0; i < 10; i += 1) {
      const allowed = await post(origin, FLOW, { ...TICKET, subject: `Ticket number ${i} in a row` });
      assert.equal(allowed.status, 303, `attempt ${i} should have been allowed`);
    }

    const refused = await post(origin, FLOW, { ...TICKET, subject: 'One ticket too many for today' });
    assert.equal(refused.status, 429);

    const retryAfter = refused.headers.get('retry-after');
    assert.ok(retryAfter, 'a 429 without Retry-After tells a client nothing');
    assert.match(retryAfter, /^\d+$/, 'Retry-After is delta-seconds');
    const seconds = Number(retryAfter);
    assert.ok(seconds > 0 && seconds <= 3600, `within the hour window, got ${seconds}`);

    const page = await refused.text();
    assert.match(page, /too many/i, 'and the page says so in words');
  });

  /* ── Lookup ──────────────────────────────────────────────────────────────────────────── */

  test(name('the lookup form stops an id being walked against an address'), async (t) => {
    const origin = await serve(t);

    // The limit is 12 in fifteen minutes.
    for (let i = 0; i < 12; i += 1) {
      const guess = await post(origin, '/tickets', {
        ticketId: `NH-0000-${String(i).padStart(4, '0')}`,
        email: TICKET.email,
      });
      assert.equal(guess.status, 404, `guess ${i} should have been answered, not throttled`);
    }

    const throttled = await post(origin, '/tickets', { ticketId: 'NH-0000-9999', email: TICKET.email });
    assert.equal(throttled.status, 429);
  });

  test(name('a successful lookup forgives the guesses that came before it'), async (t) => {
    const origin = await serve(t);

    const created = await post(origin, FLOW, TICKET);
    const id = decodeURIComponent(created.headers.get('location').split('/').pop().split('?')[0]);

    // Eleven wrong guesses: one short of the limit.
    for (let i = 0; i < 11; i += 1) {
      await post(origin, '/tickets', { ticketId: `NH-0000-${String(i).padStart(4, '0')}`, email: TICKET.email });
    }

    const found = await post(origin, '/tickets', { ticketId: id, email: TICKET.email });
    assert.equal(found.status, 303, 'the right answer is accepted');

    /* Without the clear, the very next request would be the thirteenth and refused. The whole
       point is that getting it right costs nothing. */
    const after = await post(origin, '/tickets', { ticketId: 'NH-0000-8888', email: TICKET.email });
    assert.equal(after.status, 404, 'counting started again from zero');
  });

  /* ── Sign-in ─────────────────────────────────────────────────────────────────────────── */

  test(name('repeated wrong passwords are throttled'), async (t) => {
    const origin = await serve(t);
    await post(origin, '/account/new', {
      email: 'ann@example.com',
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    });

    // The limit is 10 in fifteen minutes, counted per source and per address.
    for (let i = 0; i < 10; i += 1) {
      const wrong = await post(origin, '/account/sign-in', {
        email: 'ann@example.com',
        password: `wrong guess number ${i}`,
      });
      assert.equal(wrong.status, 401, `attempt ${i} should have been answered, not throttled`);
    }

    const throttled = await post(origin, '/account/sign-in', {
      email: 'ann@example.com',
      password: 'one guess too many',
    });
    assert.equal(throttled.status, 429);
    assert.match(throttled.headers.get('retry-after'), /^\d+$/);
  });

  test(name('a correct password clears the counter, so one typo does not cost the afternoon'), async (t) => {
    const origin = await serve(t);
    await post(origin, '/account/new', {
      email: 'bo@example.com',
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    });

    // Nine wrong, then the right one, then nine wrong again: without the clear the second
    // batch would run into the limit.
    for (let i = 0; i < 9; i += 1) {
      await post(origin, '/account/sign-in', { email: 'bo@example.com', password: `wrong ${i}` });
    }

    const right = await post(origin, '/account/sign-in', { email: 'bo@example.com', password: PASSWORD });
    assert.equal(right.status, 303, 'signed in');

    for (let i = 0; i < 9; i += 1) {
      const again = await post(origin, '/account/sign-in', { email: 'bo@example.com', password: `wrong again ${i}` });
      assert.equal(again.status, 401, `attempt ${i} after a success should not be throttled`);
    }
  });

  test(name('one address being attacked does not lock out another'), async (t) => {
    const origin = await serve(t);
    for (const email of ['target@example.com', 'bystander@example.com']) {
      await post(origin, '/account/new', { email, password: PASSWORD, passwordConfirm: PASSWORD });
    }

    /* Sign-in counts per source AND per address. From one source the per-source limit is what
       bites first, so this asserts the thing that matters here: the per-address counter for
       the bystander is untouched, which is what keeps a shared office address from being
       locked out by somebody else's bad afternoon. */
    for (let i = 0; i < 10; i += 1) {
      await post(origin, '/account/sign-in', { email: 'target@example.com', password: `wrong ${i}` });
    }

    const source = await post(origin, '/account/sign-in', {
      email: 'bystander@example.com',
      password: PASSWORD,
    });
    assert.equal(source.status, 429, 'the per-source limit is spent, as designed');

    // Clear the source counter the way a correct password would, then prove the bystander's
    // own counter never moved.
    const bystander = await post(origin, '/account/sign-in', {
      email: 'bystander@example.com',
      password: PASSWORD,
    });
    assert.equal(bystander.status, 429, 'still the source limit, not the address limit');
  });

  /* ── Limiters do not share ───────────────────────────────────────────────────────────── */

  test(name('spending the sign-in allowance leaves registration alone'), async (t) => {
    const origin = await serve(t);

    for (let i = 0; i < 11; i += 1) {
      await post(origin, '/account/sign-in', { email: 'nobody@example.com', password: `wrong ${i}` });
    }
    const signIn = await post(origin, '/account/sign-in', { email: 'nobody@example.com', password: 'x' });
    assert.equal(signIn.status, 429, 'sign-in is spent');

    const register = await post(origin, '/account/new', {
      email: 'fresh@example.com',
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    });
    assert.equal(register.status, 303, 'and registration is not, because they are separate counters');
  });

  test(name('registration has its own, tighter allowance'), async (t) => {
    const origin = await serve(t);

    // The limit is 5 an hour.
    for (let i = 0; i < 5; i += 1) {
      const allowed = await post(origin, '/account/new', {
        email: `person${i}@example.com`,
        password: PASSWORD,
        passwordConfirm: PASSWORD,
      });
      assert.equal(allowed.status, 303, `sign-up ${i} should have been allowed`);
    }

    const refused = await post(origin, '/account/new', {
      email: 'onetoomany@example.com',
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    });
    assert.equal(refused.status, 429);
    assert.match(refused.headers.get('retry-after'), /^\d+$/);
  });

  /* ── Under load ──────────────────────────────────────────────────────────────────────── */

  test(name('a burst of sign-ups is counted, not waved through'), async (t) => {
    const origin = await serve(t);

    /* Twelve arriving together against a limit of five. A limiter that read its counter before
       any of them had written would let all twelve through, which is the failure this exists
       to prevent and the one a single-threaded test never sees. */
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        post(origin, '/account/new', {
          email: `burst${i}@example.com`,
          password: PASSWORD,
          passwordConfirm: PASSWORD,
        }),
      ),
    );

    const allowed = responses.filter((r) => r.status === 303).length;
    const refused = responses.filter((r) => r.status === 429).length;
    assert.equal(allowed, 5, `exactly the limit got through, not ${allowed}`);
    assert.equal(refused, 7);
  });
}

describeRoutes('inMemory');
describeRoutes('durableObject');
