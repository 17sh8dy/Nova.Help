/**
 * A fixed-window rate limiter, in memory.
 *
 * Two things on this site need one: creating tickets (so the queue cannot be flooded) and the
 * ticket lookup form (so an id cannot be brute-forced against a list of email addresses).
 *
 * In memory means it resets when the process restarts and is per-process. That is honest for
 * a single-process deployment and stated here rather than discovered later; a multi-process
 * deployment needs a shared store, which is a swap of this module's two methods.
 */
export function createRateLimiter({ windowMs, max }) {
  const hits = new Map(); // key -> { count, resetAt }

  /** Drop expired buckets so the map cannot grow without bound. */
  function sweep(now) {
    if (hits.size < 512) return;
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
  }

  return {
    /**
     * Count one attempt. Returns `{ ok, remaining, retryAfter }`; `retryAfter` is in seconds
     * and is what the Retry-After header and the on-screen message both use.
     */
    hit(key) {
      const now = Date.now();
      sweep(now);
      const entry = hits.get(key);

      if (!entry || entry.resetAt <= now) {
        hits.set(key, { count: 1, resetAt: now + windowMs });
        return { ok: true, remaining: max - 1, retryAfter: 0 };
      }

      entry.count += 1;
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      return { ok: entry.count <= max, remaining: Math.max(0, max - entry.count), retryAfter };
    },

    /** Forget a key — called after a successful lookup so one mistake is not held against you. */
    clear(key) {
      hits.delete(key);
    },
  };
}
