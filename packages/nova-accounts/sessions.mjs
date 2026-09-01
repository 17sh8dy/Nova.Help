/**
 * Nova Account sessions — the cryptographic envelope only.
 *
 * A session token is `accountId.sessionId.expiry.HMAC(accountId.sessionId.expiry)`. It is
 * carried in an HttpOnly cookie and is never readable by a page.
 *
 * WHY IT IS NOT A BARE SIGNED CLAIM. Nova.Help already has one of those: lib/access.mjs mints
 * a stateless pass for a single ticket, and a stateless pass cannot be withdrawn — signing out
 * only deletes the cookie in front of you, and a copy taken beforehand keeps working until it
 * expires. That is an acceptable trade for a two-week pass to one ticket. It is not an
 * acceptable trade for the credential that will eventually open every Nova product, so the
 * signature here proves the token was minted by us, and the `sessionId` inside it must ALSO
 * still be listed on the account. Signing out removes the id; changing a password removes all
 * of them; both take effect on the next request everywhere.
 *
 * The signature is checked before the account is ever looked up, so a forged token costs a
 * hash and no I/O.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'nova_session';

/** Long enough that signing in is rare; short enough that an abandoned session lapses. */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

const sign = (secret, payload) =>
  createHmac('sha256', secret).update(`nova.session.v1|${payload}`).digest('base64url');

const equal = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};

export function createSessionTokens({ secret, ttlSeconds = SESSION_TTL_SECONDS }) {
  if (!secret || String(secret).length < 16) {
    throw new Error('Nova Account sessions need a signing secret of at least 16 characters.');
  }

  return {
    /** Mint a token for a session the store has already recorded on the account. */
    issue({ accountId, sessionId, expiresAt }) {
      const expiry = Math.floor(new Date(expiresAt).getTime() / 1000);
      const payload = `${accountId}.${sessionId}.${expiry}`;
      return `${payload}.${sign(secret, payload)}`;
    },

    /**
     * Unpack a token, or null when it is absent, altered or past its expiry.
     *
     * A non-null result means only "we minted this and it has not expired". Whether the
     * session is still live is the store's answer, not this one's.
     */
    verify(token) {
      if (typeof token !== 'string') return null;
      const parts = token.split('.');
      if (parts.length !== 4) return null;

      const [accountId, sessionId, expiry, signature] = parts;
      if (!equal(signature, sign(secret, `${accountId}.${sessionId}.${expiry}`))) return null;
      if (!/^\d+$/.test(expiry) || Number(expiry) < Math.floor(Date.now() / 1000)) return null;

      return { accountId, sessionId, expiresAt: new Date(Number(expiry) * 1000).toISOString() };
    },

    ttlSeconds,
  };
}
