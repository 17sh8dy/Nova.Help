/**
 * The rate limiter contract — one suite, run against every implementation.
 *
 * There are two now: the in-memory one this site has always used, and a Durable Object per key
 * for Cloudflare, where "in memory" would mean per isolate and a limit of ten would become ten
 * per isolate. The point of this file is that the second one is not a reimplementation with
 * its own opinions. Everything a route depends on — the counting, the shape of the answer, the
 * seconds in `retryAfter`, the fact that keys do not see each other, and that a correct
 * password wipes the slate — is asserted here against both.
 *
 * `retryAfter` gets more attention than it looks like it deserves, because it is the field the
 * Cloudflare rate-limiting binding does not have. It reaches a person twice: as the
 * `Retry-After` header, and as the "try again in N minutes" line on the 429 page. A limiter
 * that counts correctly but cannot say when is not a drop-in for this one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Register the contract against one implementation.
 *
 * `makeLimiter({ name, windowMs, max })` returns `{ hit, clear }`. Both may be async; the
 * assertions await either way, exactly as the routes do.
 */
export function describeRateLimiter(label, makeLimiter) {
  const name = (what) => `[${label}] ${what}`;

  /* ── Counting ────────────────────────────────────────────────────────────────────────── */

  test(name('the first attempt is allowed and reports the remaining allowance'), async () => {
    const limiter = await makeLimiter({ name: 'first', windowMs: 60_000, max: 5 });
    const gate = await limiter.hit('1.2.3.4');

    assert.equal(gate.ok, true);
    assert.equal(gate.remaining, 4);
    assert.equal(gate.retryAfter, 0, 'nothing to wait for while the window is fresh');
  });

  test(name('attempts up to the maximum are allowed, and the next one is not'), async () => {
    const limiter = await makeLimiter({ name: 'upto', windowMs: 60_000, max: 3 });

    assert.deepEqual(
      [await limiter.hit('ip'), await limiter.hit('ip'), await limiter.hit('ip')].map((g) => g.ok),
      [true, true, true],
    );
    assert.equal((await limiter.hit('ip')).ok, false, 'the fourth is refused');
    assert.equal((await limiter.hit('ip')).ok, false, 'and so is everything after it');
  });

  test(name('the remaining allowance counts down and stops at zero'), async () => {
    const limiter = await makeLimiter({ name: 'remaining', windowMs: 60_000, max: 3 });

    assert.equal((await limiter.hit('ip')).remaining, 2);
    assert.equal((await limiter.hit('ip')).remaining, 1);
    assert.equal((await limiter.hit('ip')).remaining, 0);
    assert.equal((await limiter.hit('ip')).remaining, 0, 'never negative');
    assert.equal((await limiter.hit('ip')).remaining, 0);
  });

  /* ── retryAfter ──────────────────────────────────────────────────────────────────────── */

  test(name('retryAfter is whole seconds, and never longer than the window'), async () => {
    const limiter = await makeLimiter({ name: 'retry', windowMs: 60_000, max: 1 });

    await limiter.hit('ip');
    const refused = await limiter.hit('ip');

    assert.equal(refused.ok, false);
    assert.equal(Number.isInteger(refused.retryAfter), true, 'a Retry-After header is an integer');
    assert.ok(refused.retryAfter > 0 && refused.retryAfter <= 60, `got ${refused.retryAfter}`);
  });

  test(name('retryAfter describes the window, not the verdict'), async () => {
    /* Reported on an allowed attempt too, as long as a window is already open. The route only
       reads it when it refuses, but a limiter that returned 0 here would be describing the
       answer rather than the window, and the two are not the same thing. */
    const limiter = await makeLimiter({ name: 'describes', windowMs: 60_000, max: 10 });

    assert.equal((await limiter.hit('ip')).retryAfter, 0, 'the window opens with this attempt');
    const second = await limiter.hit('ip');
    assert.equal(second.ok, true);
    assert.ok(second.retryAfter > 0, 'and is already ticking for the next one');
  });

  test(name('a longer window reports a proportionally longer wait'), async () => {
    const short = await makeLimiter({ name: 'short', windowMs: 10 * 60 * 1000, max: 1 });
    const long = await makeLimiter({ name: 'long', windowMs: 60 * 60 * 1000, max: 1 });

    await short.hit('ip');
    await long.hit('ip');
    const shortWait = (await short.hit('ip')).retryAfter;
    const longWait = (await long.hit('ip')).retryAfter;

    assert.ok(shortWait > 500 && shortWait <= 600, `ten minutes, got ${shortWait}s`);
    assert.ok(longWait > 3500 && longWait <= 3600, `an hour, got ${longWait}s`);
  });

  /* ── Keys are independent ────────────────────────────────────────────────────────────── */

  test(name('one key running out does not affect another'), async () => {
    const limiter = await makeLimiter({ name: 'keys', windowMs: 60_000, max: 2 });

    await limiter.hit('1.2.3.4');
    await limiter.hit('1.2.3.4');
    assert.equal((await limiter.hit('1.2.3.4')).ok, false);

    const other = await limiter.hit('5.6.7.8');
    assert.equal(other.ok, true, 'a different address is untouched');
    assert.equal(other.remaining, 1);
  });

  test(name('two limiters do not share a key'), async () => {
    /* `signIn` and `register` both count an IP address, and they are separate allowances. If
       naming did not keep them apart, failing to sign in would spend the sign-up budget. */
    const signIn = await makeLimiter({ name: 'signIn', windowMs: 60_000, max: 1 });
    const register = await makeLimiter({ name: 'register', windowMs: 60_000, max: 1 });

    assert.equal((await signIn.hit('1.2.3.4')).ok, true);
    assert.equal((await signIn.hit('1.2.3.4')).ok, false, 'signIn is spent');
    assert.equal((await register.hit('1.2.3.4')).ok, true, 'register is not');
  });

  test(name('keys that look alike are still different keys'), async () => {
    const limiter = await makeLimiter({ name: 'alike', windowMs: 60_000, max: 1 });

    assert.equal((await limiter.hit('email:ann@example.com')).ok, true);
    assert.equal((await limiter.hit('email:ann@example.co')).ok, true);
    assert.equal((await limiter.hit('email:ann@example.comm')).ok, true);
    assert.equal((await limiter.hit('email:ann@example.com')).ok, false);
  });

  /* ── Clearing ────────────────────────────────────────────────────────────────────────── */

  test(name('clearing a key gives it a fresh allowance'), async () => {
    /* This is what makes one forgotten password cost nothing: the sign-in route calls it the
       moment a correct password arrives. */
    const limiter = await makeLimiter({ name: 'clearing', windowMs: 60_000, max: 2 });

    await limiter.hit('ip');
    await limiter.hit('ip');
    assert.equal((await limiter.hit('ip')).ok, false, 'spent');

    await limiter.clear('ip');

    const after = await limiter.hit('ip');
    assert.equal(after.ok, true, 'and forgiven');
    assert.equal(after.remaining, 1);
    assert.equal(after.retryAfter, 0);
  });

  test(name('clearing one key leaves the others alone'), async () => {
    const limiter = await makeLimiter({ name: 'clearone', windowMs: 60_000, max: 1 });

    await limiter.hit('mine');
    await limiter.hit('theirs');
    await limiter.clear('mine');

    assert.equal((await limiter.hit('mine')).ok, true);
    assert.equal((await limiter.hit('theirs')).ok, false, 'still spent');
  });

  test(name('clearing a key that was never counted is harmless'), async () => {
    const limiter = await makeLimiter({ name: 'clearunknown', windowMs: 60_000, max: 1 });
    await limiter.clear('never-seen');
    assert.equal((await limiter.hit('never-seen')).ok, true);
  });

  /* ── The window ends ─────────────────────────────────────────────────────────────────── */

  test(name('the allowance comes back once the window has passed'), async () => {
    const limiter = await makeLimiter({ name: 'expiry', windowMs: 120, max: 2 });

    await limiter.hit('ip');
    await limiter.hit('ip');
    assert.equal((await limiter.hit('ip')).ok, false, 'spent inside the window');

    await sleep(200);

    const after = await limiter.hit('ip');
    assert.equal(after.ok, true, 'a new window, a new allowance');
    assert.equal(after.remaining, 1);
    assert.equal(after.retryAfter, 0);
  });

  test(name('a window that has not ended is not reset by merely waiting a little'), async () => {
    const limiter = await makeLimiter({ name: 'noreset', windowMs: 5_000, max: 1 });

    await limiter.hit('ip');
    await sleep(120);
    assert.equal((await limiter.hit('ip')).ok, false, 'still inside the window');
  });

  /* ── Under load ──────────────────────────────────────────────────────────────────────── */

  test(name('simultaneous attempts on one key are all counted'), async () => {
    /* Ten requests arriving together must not each read "nothing counted yet" and all be let
       through — which is exactly the failure mode a rate limiter exists to prevent. */
    const limiter = await makeLimiter({ name: 'burst', windowMs: 60_000, max: 4 });

    const results = await Promise.all(Array.from({ length: 10 }, () => limiter.hit('ip')));
    const allowed = results.filter((gate) => gate.ok).length;

    assert.equal(allowed, 4, `exactly the maximum got through, not ${allowed}`);
    assert.equal(results.filter((gate) => !gate.ok).length, 6);
  });

  test(name('simultaneous attempts on different keys each get their own allowance'), async () => {
    const limiter = await makeLimiter({ name: 'burstkeys', windowMs: 60_000, max: 1 });

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => limiter.hit(`ip-${i}`)),
    );
    assert.equal(results.every((gate) => gate.ok), true, 'no key blocked another');
  });
}
