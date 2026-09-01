/**
 * The fixed-window counter itself, over any durable key-value storage.
 *
 * This is lib/rateLimit.mjs's arithmetic, lifted out so that the Durable Object and the
 * in-memory limiter cannot drift apart. The Node implementation is untouched and still does
 * its own bookkeeping in a Map; this exists so the thing running on Cloudflare is the same
 * decision procedure rather than a second one that was meant to match.
 *
 * `storage` is whatever the caller has: a Durable Object's `ctx.storage` in a Worker, a plain
 * Map wrapper in the tests. It needs `get`, `put`, `deleteAll` and `setAlarm`.
 *
 * WHY IT IS PERSISTED AND NOT HELD IN MEMORY. A Durable Object can be evicted between
 * requests, and an evicted counter that came back at zero would hand an attacker a fresh
 * allowance for the price of a pause. The count has to outlive the instance holding it, so
 * every hit is a write. For a rate limiter that is the correct trade: the write is the point.
 *
 * WHY AN ALARM RATHER THAN A SWEEP. The in-memory limiter walks its Map when it grows past
 * 512 entries, because nothing else would ever free the memory. Here each key is its own
 * object, so there is no shared map to walk; instead the window's end is set as an alarm and
 * the object deletes its own state when it fires. An object with no storage costs nothing.
 *
 * ⚠ THIS FUNCTION IS NOT RACE-SAFE ON ITS OWN, AND IS NOT MEANT TO BE. It reads, decides, and
 * writes across two awaits; run it twice concurrently against one storage and both calls read
 * the same count and one write is lost. Ten concurrent calls against a maximum of four let all
 * ten through, which was measured, not assumed.
 *
 * What makes it correct is the caller. In a Durable Object every await here is a storage
 * operation, and the runtime's INPUT GATES hold new events off while those are in flight — so
 * read-modify-write is atomic by construction and no lock, transaction or
 * `blockConcurrencyWhile` is needed. That is the single property this whole design rests on,
 * which is why the local stub in lib/localDurableObjects.mjs serialises calls per instance to
 * model it, and why the burst case is also driven against a real Worker: a stub that let the
 * race through would make the contract's concurrency test meaningless.
 *
 * Any future caller must provide the same guarantee.
 */

/** The single storage key. One counter per object, so it does not need a name of its own. */
const BUCKET = 'bucket';

/**
 * Count one attempt against the window.
 *
 * Returns `{ ok, remaining, retryAfter }` — the same shape lib/rateLimit.mjs returns, with
 * `retryAfter` in seconds, because the 429 page and the Retry-After header both read it and
 * neither should care which limiter answered.
 *
 * `now` is injectable so a test can cross a window boundary without waiting for one.
 */
export async function hitWindow(storage, { windowMs, max, now = Date.now() }) {
  const entry = await storage.get(BUCKET);

  /* No window, or the last one has run out. Start a fresh one and arrange for it to clean up
     after itself. The alarm is set before the count so an object cannot end up holding a
     counter that nothing will ever remove. */
  if (!entry || entry.resetAt <= now) {
    const resetAt = now + windowMs;
    await storage.setAlarm(resetAt);
    await storage.put(BUCKET, { count: 1, resetAt });
    return { ok: true, remaining: max - 1, retryAfter: 0 };
  }

  const count = entry.count + 1;
  await storage.put(BUCKET, { count, resetAt: entry.resetAt });

  return {
    ok: count <= max,
    remaining: Math.max(0, max - count),
    /* Deliberately reported whether or not this attempt was allowed, exactly as the in-memory
       limiter reports it: it describes the window, not the verdict. */
    retryAfter: Math.ceil((entry.resetAt - now) / 1000),
  };
}

/**
 * Forget the counter.
 *
 * This is what makes a correct password cost nothing: the sign-in and lookup routes call it on
 * success so that one forgotten password does not spend the rest of somebody's afternoon. It
 * is also the operation the Cloudflare rate-limiting binding has no way to express, and one of
 * the reasons this object exists at all.
 */
export async function clearWindow(storage) {
  await storage.deleteAlarm?.();
  await storage.deleteAll();
}
