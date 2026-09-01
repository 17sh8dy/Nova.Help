/**
 * Password-reset tokens — the cryptography and the encoding, and nothing else.
 *
 * A token is `accountId.secret`, where `secret` is 32 bytes from the system CSPRNG. What is
 * stored is `sha256(secret)`, never the secret, for the same reason a password is stored as a
 * scrypt record: a copy of the database must not be a set of working reset links. A token is
 * therefore reconstructible from nothing, and a leak of the store gives an attacker digests
 * they cannot use.
 *
 * WHY THE ACCOUNT ID IS IN THE TOKEN. It makes the lookup a read of one known row rather than
 * a scan for a matching digest, which keeps both stores simple and keeps the JSON store from
 * needing a fourth in-memory index — two of the three bugs found in this module so far were an
 * index that had drifted from the documents. The id is not a secret and grants nothing on its
 * own: every route that accepts one still requires the secret half, which is compared in
 * constant time against a digest. Session tokens already carry an account id for the same
 * reason.
 *
 * WHY THERE IS NO HMAC, unlike sessions.mjs. A session token is a signed claim checked before
 * any I/O, because sessions are presented on every request and a forgery should cost a hash.
 * A reset token is presented once, behind a rate limiter, so the extra key buys nothing that
 * the stored digest does not already provide — and one fewer key is one fewer thing to rotate.
 *
 * SINGLE USE IS NOT ENFORCED HERE. This module can say whether a token matches and whether it
 * has expired; it cannot say whether it has already been spent, because that is a fact about
 * storage and two requests can ask at once. The store redeems a token atomically — see
 * `redeemPasswordReset` — and that is what makes it single-use.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Long enough to arrive, be read and be acted on; short enough that a link left in an inbox
 * or a mail archive stops being a way in.
 */
export const RESET_TTL_SECONDS = 60 * 60;

/** 32 bytes, which is well past what anything is going to guess. */
const SECRET_BYTES = 32;

const digest = (secret) => createHash('sha256').update(`nova.reset.v1|${secret}`).digest('hex');

export function createResetTokens({ ttlSeconds = RESET_TTL_SECONDS } = {}) {
  return {
    /**
     * Mint a token for an account.
     *
     * Returns the token to send, and the record to store — deliberately as two values, so it
     * is impossible to store the token by accident: the caller has to reach for `tokenHash`.
     */
    issue(accountId, { now = new Date() } = {}) {
      const secret = randomBytes(SECRET_BYTES).toString('base64url');
      const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
      return {
        token: `${accountId}.${secret}`,
        record: { tokenHash: digest(secret), requestedAt: now.toISOString(), expiresAt },
      };
    },

    /**
     * Split a token into the account it names and the secret half, or null if it is not the
     * shape of a token at all. A non-null result means only "this is well-formed".
     */
    parse(token) {
      if (typeof token !== 'string') return null;
      const at = token.indexOf('.');
      if (at <= 0 || at === token.length - 1) return null;

      const accountId = token.slice(0, at);
      const secret = token.slice(at + 1);
      // A dot in the secret half would mean the split was wrong; the encoding has none.
      if (secret.includes('.') || !/^[A-Za-z0-9_-]+$/.test(secret)) return null;

      return { accountId, secret, tokenHash: digest(secret) };
    },

    /** The digest to compare a presented secret against what was stored. */
    hash: digest,

    /**
     * Constant-time comparison of two digests.
     *
     * Both are fixed-length hex from `digest`, so a length mismatch means the stored value was
     * not written by this module — which is a refusal, not a comparison.
     */
    matches(presentedHash, storedHash) {
      const a = Buffer.from(String(presentedHash ?? ''), 'utf8');
      const b = Buffer.from(String(storedHash ?? ''), 'utf8');
      return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
    },

    ttlSeconds,
  };
}
