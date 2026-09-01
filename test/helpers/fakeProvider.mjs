/**
 * A stand-in OpenID Connect provider, on a real port, with a real RSA key.
 *
 * IT IS NOT A STUB OF THE VERIFICATION, WHICH IS THE POINT. It publishes a JWKS, signs real
 * RS256 ID tokens with the matching private key, and its token endpoint checks the client
 * secret and recomputes the PKCE challenge exactly as Google's does. So a test that signs
 * somebody in exercises the actual signature check, the actual issuer and audience checks, and
 * the actual PKCE round trip — and a test that tampers with any of them fails for the real
 * reason rather than because a mock was told to say no.
 *
 * `grant()` mints an authorization code and remembers what the ID token for it should claim.
 * Every claim is overridable, which is how the negative tests forge a wrong issuer, a stale
 * expiry, a mismatched nonce or a signature from the wrong key.
 */
import http from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, sign as signBuffer } from 'node:crypto';

const b64url = (value) =>
  Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8').toString('base64url');

/** Compact JWS, RS256. `header` is merged last so a test can break `alg` or `kid` on purpose. */
export function signJwt(payload, { privateKey, kid, header = {} }) {
  const head = b64url({ alg: 'RS256', typ: 'JWT', kid, ...header });
  const body = b64url(payload);
  const input = `${head}.${body}`;
  const signature = signBuffer('RSA-SHA256', Buffer.from(input, 'utf8'), privateKey).toString('base64url');
  return `${input}.${signature}`;
}

export function newKeyPair() {
  return generateKeyPairSync('rsa', { modulusLength: 2048 });
}

/**
 * Start a fake provider. Returns `{ origin, endpoints, grant, keys, close, tokenRequests }`.
 *
 * `clientId` / `clientSecret` are what it will accept at the token endpoint; anything else is
 * refused with a 401, so a test can prove the secret is actually being sent.
 */
export async function startFakeProvider({
  clientId = 'nova-help-test.apps.googleusercontent.com',
  clientSecret = 'test-client-secret',
  issuerName,
} = {}) {
  const { publicKey, privateKey } = newKeyPair();
  const kid = randomBytes(8).toString('hex');

  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' };

  const codes = new Map(); // code -> { claims, challenge, signWith, header }
  const tokenRequests = [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');

    if (req.method === 'GET' && url.pathname === '/certs') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/token') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      tokenRequests.push(Object.fromEntries(form));

      const fail = (status, error) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error }));
      };

      if (form.get('client_id') !== clientId || form.get('client_secret') !== clientSecret) {
        return fail(401, 'invalid_client');
      }
      if (form.get('grant_type') !== 'authorization_code') return fail(400, 'unsupported_grant_type');

      const grant = codes.get(form.get('code'));
      if (!grant) return fail(400, 'invalid_grant');
      // An authorization code is single use, here as at Google.
      codes.delete(form.get('code'));

      /* PKCE, checked for real: S256 of the verifier must equal the challenge sent at the
         start of the flow. A test that breaks the verifier fails here, not in an assertion. */
      const verifier = form.get('code_verifier') ?? '';
      const computed = createHash('sha256').update(verifier, 'ascii').digest('base64url');
      if (!grant.challenge || computed !== grant.challenge) return fail(400, 'invalid_grant');

      const idToken = signJwt(grant.claims, {
        privateKey: grant.signWith ?? privateKey,
        kid,
        header: grant.header,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'fake-access-token', token_type: 'Bearer', id_token: idToken }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const issuer = issuerName ?? origin;

  return {
    origin,
    issuer,
    clientId,
    clientSecret,
    keys: { publicKey, privateKey, kid, jwk },
    tokenRequests,

    endpoints: {
      issuer,
      authorizationEndpoint: `${origin}/authorize`,
      tokenEndpoint: `${origin}/token`,
      jwksUri: `${origin}/certs`,
    },

    /**
     * Mint an authorization code.
     *
     * `claims` overrides anything in the default ID token, so a test can forge `iss`, `aud`,
     * `exp`, `nonce` or `email_verified`. `signWith` swaps in another private key to produce a
     * token whose signature cannot verify; `header` breaks the JOSE header.
     */
    grant({ sub = 'google-subject-1', email = 'person@example.com', emailVerified = true, name = null, nonce, challenge, claims = {}, signWith, header } = {}) {
      const code = randomBytes(12).toString('base64url');
      const seconds = Math.floor(Date.now() / 1000);
      codes.set(code, {
        challenge,
        signWith,
        header,
        claims: {
          iss: issuer,
          aud: clientId,
          sub,
          email,
          email_verified: emailVerified,
          ...(name ? { name } : {}),
          nonce,
          iat: seconds,
          exp: seconds + 3600,
          ...claims,
        },
      });
      return code;
    },

    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
