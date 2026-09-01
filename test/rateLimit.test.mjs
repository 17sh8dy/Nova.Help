/**
 * Every rate limiter, held to the same contract.
 *
 * The contract is in helpers/rateLimitContract.mjs. This file stands each implementation up and
 * then covers what is specific to one of them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createRateLimiter } from '../server/lib/rateLimit.mjs';
import { createDurableRateLimiter } from '../server/lib/doRateLimit.mjs';
import { createLocalDurableObjects } from '../server/lib/localDurableObjects.mjs';
import { hitWindow, clearWindow } from '../server/lib/rateLimitWindow.mjs';
import { describeRateLimiter } from './helpers/rateLimitContract.mjs';

describeRateLimiter('inMemory', ({ windowMs, max }) => createRateLimiter({ windowMs, max }));

/* One namespace shared by every limiter in the suite, as there is one namespace in the Worker.
   That is deliberate: it is what proves the `name` prefix keeps two limiters apart rather than
   a fresh namespace per limiter hiding the question. */
const namespace = createLocalDurableObjects();
describeRateLimiter('durableObject', ({ name, windowMs, max }) =>
  createDurableRateLimiter({ namespace, name, windowMs, max }),
);

/* ── The window logic, directly ─────────────────────────────────────────────────────────── */

/** Storage with the four operations rateLimitWindow.mjs uses, and a visible alarm. */
function storage() {
  const values = new Map();
  return {
    alarms: [],
    async get(key) {
      return values.get(key);
    },
    async put(key, value) {
      values.set(key, value);
    },
    async deleteAll() {
      values.clear();
    },
    async setAlarm(at) {
      this.alarms.push(at);
    },
    async deleteAlarm() {
      this.alarms.push(null);
    },
    size: () => values.size,
  };
}

test('[window] a new window sets an alarm for its own end', async () => {
  const store = storage();
  const now = 1_000_000;
  await hitWindow(store, { windowMs: 60_000, max: 5, now });

  assert.deepEqual(store.alarms, [now + 60_000], 'so an idle key cleans itself up');
});

test('[window] continuing a window does not reschedule the alarm', async () => {
  const store = storage();
  const now = 1_000_000;
  await hitWindow(store, { windowMs: 60_000, max: 5, now });
  await hitWindow(store, { windowMs: 60_000, max: 5, now: now + 1_000 });
  await hitWindow(store, { windowMs: 60_000, max: 5, now: now + 2_000 });

  assert.deepEqual(store.alarms, [now + 60_000], 'the window ends when it was always going to');
});

test('[window] crossing the boundary starts a fresh window and a fresh alarm', async () => {
  const store = storage();
  const now = 1_000_000;
  await hitWindow(store, { windowMs: 60_000, max: 1, now });
  assert.equal((await hitWindow(store, { windowMs: 60_000, max: 1, now: now + 59_999 })).ok, false);

  const after = await hitWindow(store, { windowMs: 60_000, max: 1, now: now + 60_000 });
  assert.equal(after.ok, true, 'the window is over at exactly resetAt');
  assert.deepEqual(store.alarms, [now + 60_000, now + 120_000]);
});

test('[window] retryAfter rounds up, so it never says zero while a window is open', async () => {
  const store = storage();
  const now = 1_000_000;
  await hitWindow(store, { windowMs: 60_000, max: 1, now });

  // 100ms before the window ends: a truncating limiter would say "retry in 0 seconds".
  const refused = await hitWindow(store, { windowMs: 60_000, max: 1, now: now + 59_900 });
  assert.equal(refused.ok, false);
  assert.equal(refused.retryAfter, 1);
});

test('[window] clearing drops the alarm as well as the count', async () => {
  const store = storage();
  await hitWindow(store, { windowMs: 60_000, max: 1, now: 1_000_000 });
  await clearWindow(store);

  assert.equal(store.size(), 0);
  assert.equal(store.alarms.at(-1), null, 'no alarm left pointing at a bucket that is gone');
});

/* ── The Durable Object client ──────────────────────────────────────────────────────────── */

test('[durableObject] one object per key, and none shared between limiters', async () => {
  const isolated = createLocalDurableObjects();
  const signIn = createDurableRateLimiter({ namespace: isolated, name: 'signIn', windowMs: 60_000, max: 5 });
  const register = createDurableRateLimiter({ namespace: isolated, name: 'register', windowMs: 60_000, max: 5 });

  await signIn.hit('1.2.3.4');
  assert.equal(isolated.size, 1);

  await signIn.hit('1.2.3.4');
  assert.equal(isolated.size, 1, 'the same key reaches the same object');

  await signIn.hit('5.6.7.8');
  assert.equal(isolated.size, 2, 'a different key gets its own');

  await register.hit('1.2.3.4');
  assert.equal(isolated.size, 3, 'and so does the same key under a different limiter');
});

/** The instance name the limiter will address, derived the way doRateLimit.mjs derives it. */
async function instanceNameFor(name, key) {
  const bytes = new TextEncoder().encode(`nova.help.ratelimit.v1|${name}|${key}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `${name}:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

test('[durableObject] the key is not legible in the instance name', async () => {
  const isolated = createLocalDurableObjects();
  const limiter = createDurableRateLimiter({ namespace: isolated, name: 'signIn', windowMs: 60_000, max: 5 });

  await limiter.hit('email:ann@example.com');

  /* Instance names appear in Cloudflare's own dashboards and metrics. The keys counted here
     are email addresses and client IPs, and a digest separates them just as well. */
  const expected = await instanceNameFor('signIn', 'email:ann@example.com');
  const instance = isolated.peek(expected);

  assert.ok(instance, 'the limiter addressed the object by the digest of its key');
  assert.equal(isolated.size, 1);
  assert.equal(instance.name.includes('ann@example.com'), false);
  assert.equal(instance.name.includes('@'), false);
  assert.match(instance.name, /^signIn:[0-9a-f]{64}$/);
});

test('[durableObject] an expired window is cleaned up by its alarm', async () => {
  const isolated = createLocalDurableObjects();
  const limiter = createDurableRateLimiter({ namespace: isolated, name: 'expire', windowMs: 60_000, max: 1 });

  await limiter.hit('ip');
  assert.equal((await limiter.hit('ip')).ok, false);

  const instance = isolated.peek(await instanceNameFor('expire', 'ip'));
  await instance.storage.runAlarm();

  const after = await limiter.hit('ip');
  assert.equal(after.ok, true, 'the object dropped its state when the window ended');
  assert.equal(after.remaining, 0);
});
