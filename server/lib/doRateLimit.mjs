/**
 * A rate limiter backed by the Durable Object in server/rateLimiterObject.mjs.
 *
 * Same two methods as lib/rateLimit.mjs, same return shape, one difference: they are async.
 * Every call site awaits them, which costs the in-memory limiter nothing — awaiting a plain
 * object resolves to that object — so the Node path keeps the limiter it always had and the
 * routes do not branch on which one they are talking to.
 *
 * The limits are not here. `windowMs` and `max` are handed in by app.mjs, where every limit on
 * the site is written down together, and passed through to the object per call.
 */

/**
 * The instance name for a key.
 *
 * Namespaced by limiter, so `signIn` and `register` count the same IP separately, exactly as
 * two Maps did. Hashed because instance names show up in Cloudflare's dashboards and metrics
 * and these keys are email addresses and client IPs; a digest distinguishes them just as well
 * and reveals nothing.
 */
async function instanceName(name, key) {
  const bytes = new TextEncoder().encode(`nova.help.ratelimit.v1|${name}|${key}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `${name}:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function createDurableRateLimiter({ namespace, name, windowMs, max }) {
  const stubFor = async (key) => namespace.get(namespace.idFromName(await instanceName(name, key)));

  return {
    /** Count one attempt. Returns `{ ok, remaining, retryAfter }`; `retryAfter` is in seconds. */
    async hit(key) {
      const stub = await stubFor(key);
      return stub.hit(windowMs, max);
    },

    /** Forget a key — called after a correct password and a successful lookup. */
    async clear(key) {
      const stub = await stubFor(key);
      await stub.clear();
    },
  };
}
