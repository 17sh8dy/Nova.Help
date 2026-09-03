/**
 * Product tokens — what a Nova app holds instead of a session cookie.
 *
 * A product token is `accountId.sessionId.product.scopes.expiry.HMAC(all of the above)`, sent
 * as `Authorization: Bearer …`. It is the credential Open Cut, Online Earth, Replay.GG and
 * Atlas end up with after the device grant.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THE ONE THING THAT MAKES THIS SAFE: IT IS SIGNED UNDER A DIFFERENT KEY THAN A SESSION.
 *
 * `sessions.mjs` signs with `HMAC(secret, "nova.accounts.session.v1")`. This signs with
 * `HMAC(secret, "nova.accounts.product.v1")`. They are derived from the same application
 * secret and are not each other, and the consequence is worth stating plainly:
 *
 *   - A product token pasted into the `nova_session` cookie fails the signature check. It can
 *     never become a web session, so a token that leaks out of a desktop app's config file
 *     cannot be used to log into nova.help in a browser as that person.
 *   - A session cookie stolen from a browser and presented as a Bearer token fails too, so a
 *     cookie cannot be replayed against the scoped API.
 *
 * Without the key split those two are the same string and every scope restriction below is
 * decoration, because the holder could simply use the token as a cookie and get everything.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE SCOPES ARE IN THE SIGNED PAYLOAD AND ALSO ON THE STORED SESSION.
 *
 * The payload is what makes them cheap to read — a scope check costs a hash, no I/O. The
 * stored copy is what makes them TRUE: `resolveProductToken` intersects the two and takes the
 * narrower, so a token whose scope list was widened by an attacker who somehow obtained the
 * signing key still cannot exceed what was actually granted, and a grant narrowed later
 * (revoked, or the registry changed) takes effect on the next request rather than at expiry.
 *
 * SESSIONS ARE STILL STORED, so everything sessions.mjs says about revocation holds here:
 * the `sessionId` has to still be listed on the account, signing out everywhere kills device
 * tokens as well as browsers, and a password reset does the same. That is the property that
 * makes "I lost my laptop" answerable, and it is why a product token lives in the same
 * session list rather than in a parallel one that revocation would have to remember about.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** A desktop app is signed in until it is signed out; re-authorising a TV every month is not a feature. */
export const PRODUCT_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 180; // 180 days

/** Derive the product-token key from the application secret. Domain-separated, one-way. */
export const deriveProductSecret = (secret) =>
  createHmac('sha256', String(secret)).update('nova.accounts.product.v1').digest('hex');

const sign = (secret, payload) =>
  createHmac('sha256', secret).update(`nova.product.v1|${payload}`).digest('base64url');

const equal = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};

export function createProductTokens({ secret, ttlSeconds = PRODUCT_TOKEN_TTL_SECONDS }) {
  if (!secret || String(secret).length < 16) {
    throw new Error('Nova product tokens need a signing secret of at least 16 characters.');
  }

  return {
    /** Mint a token for a session the store has already recorded on the account. */
    issue({ accountId, sessionId, product, scopes = [], expiresAt }) {
      const expiry = Math.floor(new Date(expiresAt).getTime() / 1000);
      /* Scopes are joined with `+` because `.` is the field separator and a scope containing
         one would silently shift every field after it. The registry's scopes never do, and
         this is what keeps that from mattering if one ever did. */
      const payload = `${accountId}.${sessionId}.${product}.${[...scopes].sort().join('+')}.${expiry}`;
      return `${payload}.${sign(secret, payload)}`;
    },

    /**
     * Unpack a token, or null when it is absent, altered, or past its expiry.
     *
     * A non-null result means only "we minted this and it has not lapsed". Whether the session
     * behind it is still live — and what it may actually do — is the service's answer.
     */
    verify(token) {
      if (typeof token !== 'string') return null;
      const parts = token.split('.');
      if (parts.length !== 6) return null;

      const [accountId, sessionId, product, scopes, expiry, signature] = parts;
      if (!equal(signature, sign(secret, `${accountId}.${sessionId}.${product}.${scopes}.${expiry}`))) {
        return null;
      }
      if (!/^\d+$/.test(expiry) || Number(expiry) < Math.floor(Date.now() / 1000)) return null;

      return {
        accountId,
        sessionId,
        product,
        scopes: scopes ? scopes.split('+').filter(Boolean) : [],
        expiresAt: new Date(Number(expiry) * 1000).toISOString(),
      };
    },

    ttlSeconds,
  };
}

/**
 * Pull a bearer token out of an Authorization header.
 *
 * Returns null for anything that is not exactly one `Bearer <token>`, including the empty
 * bearer that a client with no token configured sends by accident.
 */
export function bearerToken(header) {
  const match = /^Bearer\s+([A-Za-z0-9._~+/-]+=*)$/.exec(String(header ?? '').trim());
  return match ? match[1] : null;
}
