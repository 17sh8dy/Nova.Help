/**
 * Time-based one-time passwords (RFC 6238) - the six digits an authenticator app shows.
 *
 * This file is the arithmetic and nothing else. It does not know about accounts, storage or
 * secrets at rest; `mfa.mjs` decides how a secret is kept and `service.mjs` decides what a right
 * code lets somebody do. Keeping it pure means it can be tested against the RFC's own vectors.
 *
 * THE PARAMETERS ARE THE ONES EVERY AUTHENTICATOR APP ASSUMES: HMAC-SHA1, six digits, thirty
 * seconds. They are not a security choice to "improve". Google Authenticator, Apple Passwords,
 * Microsoft Authenticator and the rest read `algorithm`/`digits`/`period` from the setup URI
 * unevenly, and several ignore them; anything but the defaults would enrol fine and then show
 * the wrong digits. (SHA-1 is safe here - HMAC does not depend on SHA-1's collision resistance.)
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOTP_DIGITS = 6;
export const TOTP_PERIOD = 30;
/** Bytes of secret. 160 bits is RFC 4226's recommendation and what authenticator apps expect. */
export const TOTP_SECRET_BYTES = 20;
/** Steps either side of "now" that are accepted, to absorb a phone clock that is a little off. */
export const TOTP_WINDOW = 1;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, upper case, no padding - the form authenticator apps take. */
export function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** The inverse. Tolerates spaces, dashes, lower case and `=` padding; returns null on anything else. */
export function base32Decode(text) {
  const clean = String(text ?? '').toUpperCase().replace(/[\s=-]/g, '');
  if (!clean) return null;
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh random secret, as raw bytes. */
export const newTotpSecret = () => randomBytes(TOTP_SECRET_BYTES);

/** HOTP (RFC 4226) for one counter value. */
export function hotp(secret, counter, { digits = TOTP_DIGITS } = {}) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(message).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** Which thirty-second step a moment falls in. */
export const stepAt = (now = Date.now(), period = TOTP_PERIOD) => Math.floor(now / 1000 / period);

/** The code an authenticator would show at `now`. */
export const totpAt = (secret, now = Date.now()) => hotp(secret, stepAt(now));

const sameCode = (a, b) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Check a typed code.
 *
 * Returns `{ ok: true, step }` with the step the code belongs to, or `{ ok: false }`. The CALLER
 * records `step` and refuses anything at or before it next time: without that a code that has
 * been seen once (shoulder-surfed, or typed into a phishing page) stays good for up to ninety
 * seconds. All candidate steps are compared, not stopped at the first, so timing does not say
 * which one matched.
 */
export function verifyTotp(secret, code, { now = Date.now(), window = TOTP_WINDOW, notAfter = -1 } = {}) {
  const typed = String(code ?? '').replace(/[\s-]/g, '');
  if (!/^\d{6}$/.test(typed)) return { ok: false };

  const current = stepAt(now);
  let matched = null;
  for (let offset = -window; offset <= window; offset += 1) {
    const step = current + offset;
    if (step < 0) continue;
    if (sameCode(hotp(secret, step), typed) && step > notAfter && (matched === null || step > matched)) {
      matched = step;
    }
  }
  return matched === null ? { ok: false } : { ok: true, step: matched };
}

/**
 * The `otpauth://` URI an authenticator app scans. The label is `Issuer:account` and the issuer
 * is repeated as a parameter, which is what makes every app group and name the entry the same.
 */
export function otpauthUri({ secret, account, issuer = 'Nova' }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** A secret grouped in fours for typing by hand, for an app that cannot scan. */
export const groupedSecret = (secret) => base32Encode(secret).replace(/(.{4})(?=.)/g, '$1 ');
