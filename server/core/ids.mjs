/**
 * Identifiers.
 *
 * A ticket id is read aloud on a phone call, typed off a screenshot, and pasted into a search
 * box, so it uses Crockford base32 (no I, L, O or U — nothing that can be confused with 1 or
 * 0) in two short groups: NH-4T7K-9QW2.
 *
 * It is random, not sequential. A sequential id leaks how many tickets exist and lets anyone
 * with one id guess the next; 40 bits of randomness makes guessing another reporter's ticket
 * impractical, which matters because the ticket page is reachable with the id and an email
 * address rather than a login.
 */
import { randomInt, randomUUID } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const group = (n) => Array.from({ length: n }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');

/** A fresh ticket id, e.g. `NH-4T7K-9QW2`. Uniqueness is confirmed by the store, not assumed. */
export const newTicketId = () => `NH-${group(4)}-${group(4)}`;

/** Canonical form for anything a person typed: upper case, and punctuation restored. */
export function normalizeTicketId(input) {
  const raw = String(input ?? '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '');
  const body = raw.startsWith('NH') ? raw.slice(2) : raw;
  if (body.length !== 8) return null;
  if (![...body].every((ch) => ALPHABET.includes(ch))) return null;
  return `NH-${body.slice(0, 4)}-${body.slice(4)}`;
}

export const isTicketId = (input) => normalizeTicketId(input) !== null;

/** Ids for events and attachments — never shown to a person, so opaque is fine. */
export const newEventId = () => randomUUID();
export const newAttachmentId = () => randomUUID();
