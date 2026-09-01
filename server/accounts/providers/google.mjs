/**
 * Google, as a Nova Account sign-in provider.
 *
 * There is almost nothing here, and that is the point: Google is an ordinary OpenID Connect
 * provider, so it is `createOidcProvider` plus four constants. Apple is the same file with
 * Apple's constants (and `response_mode=form_post`); Discord, which is OAuth 2 without an ID
 * token, is a hand-written object implementing the same two methods. None of them require a
 * change to Nova Accounts itself.
 *
 * `endpoints` is overridable so the test suite can point the whole flow at a local server that
 * mints real RSA-signed tokens — the tests then exercise the actual verification code rather
 * than a stub of it.
 */
import { createOidcProvider } from './oidc.mjs';

export const GOOGLE_ENDPOINTS = {
  issuer: ['https://accounts.google.com', 'accounts.google.com'],
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
};

export function createGoogleProvider({ clientId, clientSecret, endpoints = {}, fetchImpl, now } = {}) {
  return createOidcProvider({
    id: 'google',
    label: 'Google',
    clientId,
    clientSecret,
    scope: 'openid email profile',
    /* `prompt=select_account` so somebody signed into several Google accounts is asked which
       one they mean, instead of being silently handed whichever was last used. On a page that
       decides which Nova Account you get, guessing is the wrong default. */
    authorizationParams: { prompt: 'select_account' },
    ...GOOGLE_ENDPOINTS,
    ...endpoints,
    fetchImpl,
    now,
  });
}
