/**
 * Password hashing.
 *
 * scrypt from node:crypto, with a per-password random salt, encoded into one self-describing
 * string. Nothing else in this codebase ever sees a plaintext password, and nothing anywhere
 * stores one.
 *
 * THE ENCODED FORM CARRIES ITS OWN PARAMETERS:
 *
 *   scrypt$N=131072,r=8,p=1$<salt base64url>$<hash base64url>
 *
 * That is what makes the cost raisable later without a flag day. `verify()` reads the
 * parameters out of the stored string rather than assuming today's defaults, so an account
 * hashed at N=2^17 still opens after the default moves to 2^18, and `needsRehash()` says which
 * stored hashes are behind — the caller re-hashes on the next successful sign-in, when it is
 * holding the only plaintext it will ever hold.
 *
 * WHY THESE NUMBERS. N=2^17, r=8, p=1 is the scrypt setting OWASP publishes as a minimum; it
 * costs about 128MB and a fifth of a second per attempt on the machine this was written on,
 * which is unnoticeable on a sign-in form and expensive in bulk. `maxmem` is raised to match,
 * because Node's 32MB default refuses this N outright.
 *
 * VERIFICATION IS CONSTANT-TIME, and `verifyDummy()` exists so that a sign-in against an
 * address with no account costs the same wall-clock time as one against an address with an
 * account. Without it, the sign-in form is a membership oracle with a stopwatch.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** The cost of a new hash. Raise `N` here; stored hashes carry their own and keep working. */
export const DEFAULT_COST = Object.freeze({ N: 131072, r: 8, p: 1 });

const KEY_BYTES = 64;
const SALT_BYTES = 16;

/** scrypt's memory need is 128 * r * N bytes; Node's default maxmem is far below ours. */
const maxmemFor = ({ N, r }) => Math.max(64 * 1024 * 1024, 256 * r * N);

const derive = (password, salt, cost) =>
  new Promise((resolve, reject) => {
    scrypt(
      Buffer.from(String(password), 'utf8'),
      salt,
      KEY_BYTES,
      { ...cost, maxmem: maxmemFor(cost) },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });

const encodeCost = ({ N, r, p }) => `N=${N},r=${r},p=${p}`;

function decodeCost(text) {
  const out = {};
  for (const pair of String(text).split(',')) {
    const [key, value] = pair.split('=');
    if (!/^\d+$/.test(String(value))) return null;
    out[key] = Number(value);
  }
  if (!Number.isInteger(out.N) || !Number.isInteger(out.r) || !Number.isInteger(out.p)) return null;
  // A stored record must never be able to talk us into an unbounded allocation.
  if (out.N < 1024 || out.N > 1 << 22 || out.r < 1 || out.r > 32 || out.p < 1 || out.p > 16) return null;
  return { N: out.N, r: out.r, p: out.p };
}

/** Hash a password for storage. Returns the encoded string; never the plaintext. */
export async function hashPassword(password, { cost = DEFAULT_COST } = {}) {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, cost);
  return `scrypt$${encodeCost(cost)}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/**
 * Check a password against a stored hash.
 *
 * Returns false for a malformed or unknown-algorithm record rather than throwing, so a
 * corrupted account document fails closed at the sign-in form instead of 500-ing the site.
 */
export async function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;

  const cost = decodeCost(parts[1]);
  if (!cost) return false;

  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[2], 'base64url');
    expected = Buffer.from(parts[3], 'base64url');
  } catch {
    return false;
  }
  if (!salt.length || !expected.length) return false;

  let actual;
  try {
    actual = await derive(password, salt, { ...cost, N: cost.N });
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * Burn the same work a real verification would, and return false.
 *
 * Called when no account exists for the address being tried, so that "no such account" and
 * "wrong password" are indistinguishable from the outside in time as well as in wording.
 */
export async function verifyDummy(password, { cost = DEFAULT_COST } = {}) {
  await derive(password, dummySalt(), cost);
  return false;
}

/**
 * The salt the dummy verification burns time against, generated on first use.
 *
 * NOT at module scope, which is where it used to be. A Workers isolate refuses to generate
 * random values while a module is evaluating — the whole point of the restriction is that a
 * value produced there could be baked into a snapshot and shared by every request the isolate
 * ever serves. Nothing about this salt needs to be secret or unpredictable, but the runtime
 * cannot know that, and the module would fail to load at all.
 *
 * One per isolate is still exactly what it needs to be: it is never compared against anything,
 * only fed to scrypt so that an unknown address costs the same wall-clock time as a known one.
 */
let cachedDummySalt = null;
const dummySalt = () => (cachedDummySalt ??= randomBytes(SALT_BYTES));

/** True when a stored hash was made with weaker parameters than today's default. */
export function needsRehash(stored, { cost = DEFAULT_COST } = {}) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return true;
  const current = decodeCost(parts[1]);
  if (!current) return true;
  return current.N < cost.N || current.r < cost.r || current.p < cost.p;
}
