/**
 * The rate-limiting Durable Object.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS RATHER THAN THE CLOUDFLARE RATE-LIMITING BINDING, which was the first
 * choice and was measured before being rejected. The binding cannot express what this site
 * already does, on five counts:
 *
 *   1. `simple.period` MUST BE 10 OR 60 SECONDS. Every window here is longer — ten minutes for
 *      replies, fifteen for sign-in and lookup, an hour for registration and ticket creation.
 *      Wrangler refuses the configuration outright: "simple.period must be either 10 or 60 but
 *      got 900". On its own this ends the question.
 *   2. `limit()` RETURNS `{ success }` AND NOTHING ELSE. Verified by running it. There is no
 *      retry-after, so the Retry-After header and the "try again in N minutes" line on the 429
 *      page would both have to be invented, and an invented number is worse than none.
 *   3. THERE IS NO WAY TO RESET A KEY. A correct password clears the counters here, so that
 *      one forgotten password does not lock somebody out for the afternoon. That behaviour
 *      simply cannot be written against the binding.
 *   4. COUNTERS ARE PER CLOUDFLARE LOCATION. An attacker spread across points of presence gets
 *      the limit multiplied by the number of them, which is precisely the wrong property for
 *      the thing standing in front of a login form.
 *   5. IT IS EXPLICITLY BEST-EFFORT — the documentation says it is "intentionally designed to
 *      not be used as an accurate accounting system".
 *
 * Points 1 and 2 were confirmed against a running Worker, not read and believed.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHY ONE OBJECT PER KEY, which is what "narrowest" means here.
 *
 * The instance name is the limiter's name and the key it is counting — one object for
 * `signIn` and this address, another for `register` and that IP. It is tempting to keep one
 * object per limiter holding a map of keys, and that would be a global bottleneck: every
 * sign-in on the site, worldwide, serialised through a single object in a single location.
 * Per key, the objects are independent, each holds one small counter, and each hibernates
 * when its window ends.
 *
 * THE KEY IS HASHED INTO THE NAME. Instance names appear in Cloudflare's own dashboards and
 * metrics, and the keys here include email addresses and client IPs. A digest counts exactly
 * as well as the address does and puts nothing legible where it does not belong — the same
 * reasoning that made the ticket store index addresses by digest.
 *
 * THE LIMITS ARE NOT CONFIGURED HERE. `hit` is told the window and the maximum by its caller,
 * so every limit on the site stays written down in one place, in app.mjs, exactly as it was
 * before any of this. An object that knew its own limit would be a second place to change
 * them, and the two would eventually disagree.
 */
import { DurableObject } from 'cloudflare:workers';

import { clearWindow, hitWindow } from './lib/rateLimitWindow.mjs';

export class RateLimiterObject extends DurableObject {
  /**
   * Count one attempt. Returns `{ ok, remaining, retryAfter }`.
   *
   * No `blockConcurrencyWhile` and no transaction: every await inside `hitWindow` is a storage
   * operation, and the runtime's input gates already hold new events off while those are in
   * flight. Read-modify-write is atomic here by construction, which is the property that made
   * a Durable Object the right shape for this in the first place.
   */
  async hit(windowMs, max) {
    return hitWindow(this.ctx.storage, { windowMs, max });
  }

  /** Forget this counter — what a correct password and a successful lookup call. */
  async clear() {
    await clearWindow(this.ctx.storage);
  }

  /** The window ended. Drop the state so an idle key costs nothing to keep. */
  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
