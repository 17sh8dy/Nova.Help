/**
 * Device-authorization codes — the encoding and the cryptography, and nothing else.
 *
 * A device grant has TWO codes and they are not the same kind of thing:
 *
 *   device_code  32 bytes from the CSPRNG. The app keeps it and polls with it. It is the
 *                SECRET half, so what is stored is `sha256(...)` and never the code — a copy
 *                of the database must not be a set of pending sign-ins, for the same reason
 *                it must not be a set of working reset links (see resetTokens.mjs).
 *
 *   user_code    eight characters a person reads off one screen and types into another.
 *                It is stored in the clear because it has to be LOOKED UP by what was typed,
 *                and no digest is a lookup key you can be typed into.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THE USER CODE IS LOW ENTROPY ON PURPOSE, SO EVERYTHING ELSE HAS TO CARRY IT.
 *
 * Eight Crockford characters is ~40 bits, which is plenty against a stopwatch and nothing at
 * all against a script. Four things keep that safe, and removing any one of them breaks it:
 *
 *   1. It expires in ten minutes.
 *   2. Entering one is rate limited, per source, on the route.
 *   3. Guessing it wins nothing on its own — approving is an action a SIGNED-IN person takes,
 *      and what comes back to the guesser is a page, not a token. The token only ever goes to
 *      whoever holds the `device_code`, which they cannot guess.
 *   4. It authorises exactly one grant, once, and is gone.
 *
 * So the worst outcome of a guessed user code is that an attacker sees which product is
 * asking. The thing worth protecting — the token — is behind the 32-byte half.
 *
 * WHY I, L, O AND U ARE ABSENT. This is the one identifier in Nova a human retypes from a
 * screen, so it uses the same Crockford alphabet as an account id and a ticket id, and
 * `normalizeUserCode` folds the confusable characters people type anyway: O to 0, I and L to
 * 1. Somebody squinting at `KDMX-7QRT` must not be defeated by their own eyesight.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';

/** Long enough to walk to another device and type; short enough that a shoulder-surfed code dies. */
export const DEVICE_CODE_TTL_SECONDS = 10 * 60;

/** What a well-behaved client waits between polls. Sent to the client; enforced on the route. */
export const DEVICE_POLL_INTERVAL_SECONDS = 5;

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const digest = (code) => createHash('sha256').update(`nova.device.v1|${code}`).digest('hex');

/**
 * Fold what a person typed into what was minted.
 *
 * Case, spaces and the dash are noise. `O`→`0` and `I`/`L`→`1` are the Crockford confusions;
 * the alphabet has no O, I or L, so folding them can never collide with a real character.
 */
export function normalizeUserCode(value) {
  return String(value ?? '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

/** `KDMX-7QRT` — grouped for reading aloud, normalized back to eight characters for lookup. */
export function newUserCode() {
  const pick = (n) => Array.from({ length: n }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `${pick(4)}-${pick(4)}`;
}

/** True when a string could be a user code at all. Cheap guard before a store lookup. */
export const isUserCode = (value) => /^[0-9A-Z]{8}$/.test(normalizeUserCode(value));

/**
 * Mint a device code.
 *
 * Returns the code to hand to the app and the digest to store — two values, deliberately, so
 * that storing the secret by accident is not possible: the caller has to reach for `hash`.
 */
export function newDeviceCode() {
  const code = randomBytes(32).toString('base64url');
  return { code, hash: digest(code) };
}

/** The digest of a presented device code, for comparison against what was stored. */
export const hashDeviceCode = digest;
