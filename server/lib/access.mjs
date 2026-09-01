/**
 * Access to a ticket, without accounts.
 *
 * Nova.Help has no sign-in yet, and inventing one for a first version would be the wrong
 * order of work. What it has instead is proof of two things at once: the ticket id (which is
 * random and unguessable) and the email address the ticket was filed with. Present both and
 * you get a signed pass, in an HttpOnly cookie, for that one ticket.
 *
 * The pass is an HMAC over `ticketId.expiry` — the server keeps no session table, and a
 * tampered or expired pass simply fails to verify. It grants exactly one ticket; holding a
 * pass for one gives no access to another.
 *
 * THE SIGNING KEY. Taken from NOVA_HELP_SECRET when set. Otherwise one is generated on first
 * run and written to var/secret so that restarting the server does not sign every reporter
 * out. A deployment behind more than one process must set the variable, or two processes will
 * refuse each other's passes — the boot log says so when it generates a key.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const PASS_COOKIE = 'nh_pass';
export const PASS_TTL_SECONDS = 60 * 60 * 24 * 14; // two weeks

export function loadSecret({ dir }) {
  const fromEnv = process.env.NOVA_HELP_SECRET;
  if (fromEnv && fromEnv.length >= 16) return { secret: fromEnv, generated: false };

  const file = path.join(dir, 'secret');
  if (existsSync(file)) {
    const stored = readFileSync(file, 'utf8').trim();
    if (stored.length >= 16) return { secret: stored, generated: false };
  }

  mkdirSync(dir, { recursive: true });
  const secret = randomBytes(32).toString('hex');
  writeFileSync(file, secret, { mode: 0o600 });
  return { secret, generated: true };
}

const sign = (secret, payload) => createHmac('sha256', secret).update(payload).digest('base64url');

const equal = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};

export function createAccess({ secret, ttlSeconds = PASS_TTL_SECONDS }) {
  return {
    /** A pass for one ticket, valid until it expires. */
    issue(ticketId) {
      const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
      const payload = `${ticketId}.${expires}`;
      return `${payload}.${sign(secret, payload)}`;
    },

    /** The ticket id a pass is good for, or null when it is absent, altered or expired. */
    verify(token) {
      if (typeof token !== 'string') return null;
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const [ticketId, expires, signature] = parts;
      if (!equal(signature, sign(secret, `${ticketId}.${expires}`))) return null;
      if (!/^\d+$/.test(expires) || Number(expires) < Math.floor(Date.now() / 1000)) return null;
      return ticketId;
    },

    /** True when this pass is for this ticket. The check every ticket route makes. */
    grants(token, ticketId) {
      const granted = this.verify(token);
      return granted !== null && granted === ticketId;
    },

    ttlSeconds,
  };
}
