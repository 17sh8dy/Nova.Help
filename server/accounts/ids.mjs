/**
 * Nova Account identifiers.
 *
 * An account id is `NA-XXXX-XXXX-XXXX` in Crockford base32 (no I, L, O or U). It follows the
 * same house style as a ticket id so that an id seen in a log is instantly recognisable as an
 * account rather than a ticket, and it is random rather than sequential so it leaks neither
 * how many accounts exist nor the order they were made in.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM server/core/ids.mjs. Everything under server/accounts/
 * is written to be lifted out of Nova.Help unchanged when Nova Accounts becomes a service the
 * whole ecosystem talks to. That means it may not import from server/core — the twelve lines
 * duplicated here are the price of the module being portable, and they are the cheap half of
 * the trade.
 */
import { randomInt, randomUUID } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const group = (n) => Array.from({ length: n }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');

/** A fresh account id, e.g. `NA-4T7K-9QW2-H30X`. 60 bits of randomness. */
export const newAccountId = () => `NA-${group(4)}-${group(4)}-${group(4)}`;

/** True when a string is shaped like an account id. Cheap guard before a store lookup. */
export const isAccountId = (value) => /^NA-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(String(value ?? ''));

/** Session ids are never read by a person, so opaque is the right shape. */
export const newSessionId = () => randomUUID();
