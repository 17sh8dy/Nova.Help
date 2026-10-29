/**
 * The cryptography around two-step verification: how a secret is kept, how recovery codes are
 * made and checked, and the short-lived ticket that carries a half-finished sign-in.
 *
 * Three jobs, each with one rule that matters:
 *
 *   SECRETS ARE ENCRYPTED AT REST. A TOTP secret has to be recoverable (the server recomputes
 *   the code from it), so it cannot be hashed the way a password is. It is sealed with
 *   AES-256-GCM under a key derived from the application secret, with the account id bound in as
 *   associated data - so a database dump alone yields nothing, and a sealed secret copied onto a
 *   different account's row will not open. The derived key is domain-separated from the session,
 *   product and OAuth keys, so none of them can stand in for it.
 *
 *   RECOVERY CODES ARE HASHED. They are only ever compared, never shown again, so they are stored
 *   as keyed HMAC-SHA256 digests. Fifty bits of randomness each makes a slow hash unnecessary;
 *   the key makes a leaked database unusable for an offline guess. Each works once.
 *
 *   THE SIGN-IN TICKET IS SIGNED, SHORT, AND WORTH NOTHING ALONE. After a correct password the
 *   second step needs to remember who is half signed in without opening a session. The ticket is
 *   `accountId.expiry.HMAC`, five minutes, under yet another derived key. Holding it proves only
 *   that the password was right a moment ago - the code is still required, and the attempts at
 *   that code are counted on the account, not on the ticket, so a fresh ticket resets nothing.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const MFA_TICKET_TTL_SECONDS = 5 * 60;
export const RECOVERY_CODE_COUNT = 10;

const derive = (secret, purpose) => createHmac('sha256', String(secret)).update(purpose).digest();

const equal = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createMfaVault({ secret }) {
  if (!secret || String(secret).length < 16) {
    throw new Error('Two-step verification needs an application secret of at least 16 characters.');
  }
  const sealKey = derive(secret, 'nova.accounts.mfa-seal.v1');
  const recoveryKey = derive(secret, 'nova.accounts.mfa-recovery.v1');
  const ticketKey = derive(secret, 'nova.accounts.mfa-ticket.v1');

  /* ── Secrets ─────────────────────────────────────────────────────────────────────────────── */

  /** Seal raw secret bytes for one account. Output is `v1.iv.ciphertext.tag`, all base64url. */
  function seal(accountId, bytes) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', sealKey, iv);
    cipher.setAAD(Buffer.from(`nova.mfa|${accountId}`));
    const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return ['v1', iv.toString('base64url'), body.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
  }

  /** Open a sealed secret for one account, or null if it is malformed, tampered with, or someone else's. */
  function open(accountId, sealed) {
    try {
      const [version, iv, body, tag] = String(sealed).split('.');
      if (version !== 'v1' || !iv || !body || !tag) return null;
      const decipher = createDecipheriv('aes-256-gcm', sealKey, Buffer.from(iv, 'base64url'));
      decipher.setAAD(Buffer.from(`nova.mfa|${accountId}`));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]);
    } catch {
      return null;
    }
  }

  /* ── Recovery codes ──────────────────────────────────────────────────────────────────────── */

  /* Crockford base32 without the letters that read as numbers. Ten characters, shown as 5-5. */
  const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

  /** Ten fresh codes, as `XXXXX-XXXXX`. These are the only time the plaintext exists. */
  function newRecoveryCodes(count = RECOVERY_CODE_COUNT) {
    return Array.from({ length: count }, () => {
      const raw = randomBytes(10);
      const chars = Array.from(raw, (byte) => CODE_ALPHABET[byte & 31]).join('');
      return `${chars.slice(0, 5)}-${chars.slice(5)}`;
    });
  }

  /** What a typed recovery code is reduced to before hashing: case, dashes, spaces and O/I/L slips forgiven. */
  const normaliseRecovery = (code) =>
    String(code ?? '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');

  const isRecoveryShape = (code) => /^[0-9A-Z]{10}$/.test(normaliseRecovery(code));

  const hashRecovery = (code) => createHmac('sha256', recoveryKey).update(normaliseRecovery(code)).digest('base64url');

  /** Index of the stored hash a typed code matches, or -1. Compares against all of them. */
  function matchRecovery(hashes, code) {
    if (!isRecoveryShape(code)) return -1;
    const candidate = hashRecovery(code);
    let found = -1;
    (hashes ?? []).forEach((hash, index) => {
      if (equal(hash, candidate) && found === -1) found = index;
    });
    return found;
  }

  /* ── The half-finished sign-in ───────────────────────────────────────────────────────────── */

  const signTicket = (payload) => createHmac('sha256', ticketKey).update(payload).digest('base64url');

  /** A ticket saying "this account just proved its password". */
  function issueTicket(accountId, { now = Date.now(), ttlSeconds = MFA_TICKET_TTL_SECONDS } = {}) {
    const payload = `${accountId}.${Math.floor(now / 1000) + ttlSeconds}`;
    return `${payload}.${signTicket(payload)}`;
  }

  /** The account id inside a ticket if it is genuine and unexpired, else null. */
  function readTicket(ticket, { now = Date.now() } = {}) {
    const parts = String(ticket ?? '').split('.');
    if (parts.length !== 3) return null;
    const [accountId, expiry, signature] = parts;
    if (!equal(signature, signTicket(`${accountId}.${expiry}`))) return null;
    if (!(Number(expiry) > Math.floor(now / 1000))) return null;
    return accountId;
  }

  return { seal, open, newRecoveryCodes, matchRecovery, hashRecovery, isRecoveryShape, issueTicket, readTicket };
}
