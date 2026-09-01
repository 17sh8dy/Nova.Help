/**
 * Just enough JWS to verify an OpenID Connect ID token, with no dependencies.
 *
 * Node can already do every piece of this: `createPublicKey` imports a JWK directly, and
 * `verify` checks an RS256 signature. What is missing is the glue, and the glue is where the
 * mistakes live — so the rules are stated here rather than assumed:
 *
 * 1. THE ALGORITHM COMES FROM US, NOT FROM THE TOKEN. A verifier that reads `alg` out of the
 *    header it is checking will happily accept `alg: "none"`, or accept an HMAC signed with
 *    the public key it was supposed to verify against. The caller passes the algorithms it
 *    will accept; anything else is refused before a key is even looked up.
 *
 * 2. THE SIGNATURE IS CHECKED BEFORE THE CLAIMS ARE BELIEVED. `decode()` exists for error
 *    messages and tests; nothing in the sign-in path may use its output to make a decision.
 *
 * 3. AN UNKNOWN `kid` IS A CACHE MISS, NOT A FAILURE — providers rotate keys — but refetching
 *    is rate-limited so a stream of tokens with invented key ids cannot be turned into a
 *    stream of outbound requests.
 */
import { createPublicKey, verify as verifySignature } from 'node:crypto';

const NODE_ALG = { RS256: 'RSA-SHA256', RS384: 'RSA-SHA384', RS512: 'RSA-SHA512' };

const b64urlToBuffer = (value) => Buffer.from(String(value), 'base64url');

const parseJson = (buffer) => {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
};

/** Split a compact JWS without checking anything. NEVER trust what this returns. */
export function decode(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;
  const header = parseJson(b64urlToBuffer(parts[0]));
  const payload = parseJson(b64urlToBuffer(parts[1]));
  if (!header || !payload) return null;
  return { header, payload, signature: parts[2], signingInput: `${parts[0]}.${parts[1]}` };
}

/**
 * A JWKS reader that caches keys and refetches at most once a minute.
 *
 * `fetchImpl` is injectable so the test suite can stand up a real key set on a real port
 * rather than stubbing the verification it is trying to test.
 */
export function createJwks({ url, fetchImpl = fetch, minRefetchMs = 60_000, now = Date.now }) {
  let keys = new Map(); // kid -> KeyObject
  let lastFetch = 0;
  let inFlight = null;

  async function refresh() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const response = await fetchImpl(url, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`Could not read the key set (${response.status}).`);
      const body = await response.json();

      const next = new Map();
      for (const jwk of body?.keys ?? []) {
        if (jwk.kty !== 'RSA' || !jwk.kid) continue;
        // `use`/`key_ops`, when present, must say this key is for verifying signatures.
        if (jwk.use && jwk.use !== 'sig') continue;
        try {
          next.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
        } catch {
          // A key we cannot import is one we cannot verify with. Skip it rather than throw:
          // one malformed entry must not disable every other key in the set.
        }
      }
      keys = next;
      lastFetch = now();
      return keys;
    })();

    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  return {
    async get(kid) {
      if (keys.has(kid)) return keys.get(kid);
      if (now() - lastFetch < minRefetchMs && keys.size > 0) return null;
      await refresh();
      return keys.get(kid) ?? null;
    },
    get size() {
      return keys.size;
    },
  };
}

/**
 * Verify an ID token and return its claims.
 *
 * Throws with a short, non-leaking message on any failure; the caller turns that into one
 * generic page. Every check the OpenID Connect spec calls for on a code-flow ID token is here:
 * signature, issuer, audience, expiry, issued-at skew, and the nonce that ties the token to
 * the request that started the flow.
 */
export async function verifyIdToken(token, { jwks, issuer, audience, nonce, algorithms = ['RS256'], now = Date.now, clockSkewSeconds = 120 }) {
  const parts = decode(token);
  if (!parts) throw new Error('The identity token was malformed.');

  const { header, payload, signature, signingInput } = parts;

  if (!algorithms.includes(header.alg)) throw new Error(`Unsupported token algorithm.`);
  if (!header.kid) throw new Error('The identity token named no signing key.');

  const key = await jwks.get(header.kid);
  if (!key) throw new Error('The identity token was signed with an unknown key.');

  const ok = verifySignature(
    NODE_ALG[header.alg],
    Buffer.from(signingInput, 'utf8'),
    key,
    b64urlToBuffer(signature),
  );
  if (!ok) throw new Error('The identity token signature did not verify.');

  /* Only now are the claims worth reading. */
  const issuers = [].concat(issuer);
  if (!issuers.includes(payload.iss)) throw new Error('The identity token came from the wrong issuer.');

  const audiences = [].concat(payload.aud ?? []);
  if (!audiences.includes(audience)) throw new Error('The identity token was issued for another application.');
  // `azp` matters when a token carries several audiences: it names the one it was minted for.
  if (audiences.length > 1 && payload.azp && payload.azp !== audience) {
    throw new Error('The identity token was issued for another application.');
  }

  const seconds = Math.floor(now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp + clockSkewSeconds < seconds) {
    throw new Error('The identity token has expired.');
  }
  if (typeof payload.iat === 'number' && payload.iat - clockSkewSeconds > seconds) {
    throw new Error('The identity token is not valid yet.');
  }

  if (nonce !== undefined && payload.nonce !== nonce) {
    throw new Error('The identity token did not match this sign-in attempt.');
  }

  if (!payload.sub) throw new Error('The identity token identified nobody.');

  return payload;
}
