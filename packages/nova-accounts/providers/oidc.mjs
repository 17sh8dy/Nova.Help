/**
 * A generic OpenID Connect client: authorization code + PKCE.
 *
 * THIS IS THE FILE THAT MAKES "ADD APPLE LATER" A CONFIG CHANGE. Google is not special; it is
 * `createOidcProvider` called with Google's three URLs and its issuer. Apple, or any other
 * OIDC provider, is the same call with different constants. A provider that is NOT OpenID
 * Connect — Discord, say, which returns an access token and expects you to call a userinfo
 * endpoint — implements the same four-method shape by hand and drops into the same registry;
 * nothing above this layer knows the difference.
 *
 * THE PROVIDER CONTRACT, which is all the rest of Nova Accounts depends on:
 *
 *   id            'google'                     — stable, stored on the identity record
 *   label         'Google'                     — what the button says
 *   authorizationUrl({ state, nonce, codeVerifier, redirectUri })  -> string
 *   identify({ code, codeVerifier, nonce, redirectUri })           -> ProviderIdentity
 *
 *   ProviderIdentity = { provider, subject, email, emailVerified, displayName }
 *
 * `subject` IS THE IDENTITY. It is the provider's stable id for the person and it is the only
 * thing Nova Accounts matches on. An email address is a mutable attribute that the provider
 * may not even have verified; see the linking rules in service.mjs.
 *
 * PKCE IS USED EVEN THOUGH THIS IS A CONFIDENTIAL CLIENT WITH A SECRET. It costs one hash and
 * removes a whole class of code-interception bug, and it is what the current OAuth 2.1 drafts
 * require of everyone rather than of public clients only.
 */
import { createHash, randomBytes } from 'node:crypto';

import { createJwks, verifyIdToken } from './jwt.mjs';

/** A PKCE verifier: 43-128 chars from the unreserved set. 32 random bytes, base64url. */
export const newCodeVerifier = () => randomBytes(32).toString('base64url');

export const codeChallengeFor = (verifier) =>
  createHash('sha256').update(verifier, 'ascii').digest('base64url');

/** State and nonce are opaque, single-use, and only ever compared for equality. */
export const newOpaqueValue = () => randomBytes(32).toString('base64url');

export function createOidcProvider({
  id,
  label,
  clientId,
  clientSecret,
  issuer,
  authorizationEndpoint,
  tokenEndpoint,
  jwksUri,
  scope = 'openid email profile',
  authorizationParams = {},
  fetchImpl = fetch,
  now = Date.now,
}) {
  if (!id || !clientId || !clientSecret) {
    throw new Error(`OIDC provider "${id}" needs an id, a client id and a client secret.`);
  }

  const jwks = createJwks({ url: jwksUri, fetchImpl, now });

  return {
    id,
    label,

    authorizationUrl({ state, nonce, codeVerifier, redirectUri }) {
      const url = new URL(authorizationEndpoint);
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', scope);
      url.searchParams.set('state', state);
      url.searchParams.set('nonce', nonce);
      url.searchParams.set('code_challenge', codeChallengeFor(codeVerifier));
      url.searchParams.set('code_challenge_method', 'S256');
      for (const [key, value] of Object.entries(authorizationParams)) url.searchParams.set(key, value);
      return url.toString();
    },

    /**
     * Swap the code for an ID token and read the person out of it.
     *
     * The exchange is a direct, server-to-server call carrying the client secret; the code
     * and the PKCE verifier are never in a URL a browser saw. The token that comes back is
     * still verified in full — the direct TLS channel is a reason to trust the transport, not
     * a reason to skip checking what arrived over it.
     */
    async identify({ code, codeVerifier, nonce, redirectUri }) {
      const response = await fetchImpl(tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          client_secret: clientSecret,
          code_verifier: codeVerifier,
        }).toString(),
      });

      if (!response.ok) {
        // The provider's error body can contain the code and other request detail; it belongs
        // in a server log, never in a page or an exception that reaches one.
        throw new Error(`${label} refused the sign-in (${response.status}).`);
      }

      const body = await response.json().catch(() => null);
      if (!body?.id_token) throw new Error(`${label} returned no identity token.`);

      const claims = await verifyIdToken(body.id_token, {
        jwks,
        issuer,
        audience: clientId,
        nonce,
        now,
      });

      return {
        provider: id,
        subject: String(claims.sub),
        email: typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : null,
        /* Google sends this as a boolean; some providers send the string "true". Anything
           that is not unambiguously true is treated as not verified. */
        emailVerified: claims.email_verified === true || claims.email_verified === 'true',
        displayName: typeof claims.name === 'string' ? claims.name.trim() : null,
      };
    },
  };
}
