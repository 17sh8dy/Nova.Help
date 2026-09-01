/**
 * The provider registry, and the state that keeps an OAuth round trip honest.
 *
 * An OAuth redirect leaves this site, spends time somewhere we do not control, and comes back
 * as a plain GET that anybody on the internet can also make. Everything that makes that safe
 * is in this file.
 *
 * THE ENVELOPE. Starting a flow mints four values and puts them in one signed, short-lived,
 * HttpOnly cookie:
 *
 *   state         a random value ALSO sent to the provider, and required to come back
 *   nonce         a random value bound into the ID token by the provider
 *   codeVerifier  the PKCE secret, which never leaves this server
 *   mode + next   what we were doing, and where to go afterwards
 *
 * WHY THE COOKIE IS THE AUTHORITY AND THE QUERY STRING IS NOT. The callback URL is attacker-
 * reachable: anyone can send a browser to it carrying a code they obtained themselves. That is
 * login CSRF, and it ends with the victim signed into the attacker's account, or the
 * attacker's Google identity welded onto the victim's Nova Account. It is defeated by
 * requiring a `state` in the URL that matches a `state` in a cookie THIS SERVER set in THAT
 * browser when the flow began — which an attacker cannot cause, because they cannot write a
 * cookie on our origin. So: no cookie, no sign-in. A mismatch, no sign-in.
 *
 * SINGLE USE. The cookie is cleared the moment the callback reads it, before any code is
 * exchanged, so a callback URL that leaks (a shared screen, a referrer header, shell history)
 * cannot be replayed.
 *
 * SameSite=Lax IS DELIBERATE AND IS THE STRICTEST SETTING THAT WORKS. The callback arrives as
 * a top-level navigation from the provider; `Strict` would withhold the cookie on exactly that
 * request and every sign-in would fail. `Lax` withholds it from cross-site POSTs and subresource
 * requests, which is the part that matters.
 *
 * THE MODE IS DECIDED BY THE SESSION, NOT BY THE REQUEST. "Sign me in" and "link this to my
 * account" are different operations with different consequences, and which one is happening is
 * read from whether the browser holds a Nova session — never from a parameter a caller could
 * set. It is written into the sealed envelope at the start and re-checked at the end.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { newCodeVerifier, newOpaqueValue } from './oidc.mjs';

export const OAUTH_COOKIE = 'nova_oauth';

/** Long enough to sign in with a password prompt and a 2FA code; short enough to be useless later. */
export const OAUTH_TTL_SECONDS = 15 * 60;

const equal = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};

/** Domain-separated from session tokens, so neither key can ever stand in for the other. */
export const deriveOauthSecret = (secret) =>
  createHmac('sha256', String(secret)).update('nova.accounts.oauth.v1').digest('hex');

export function createProviderRegistry({ providers = [], secret, ttlSeconds = OAUTH_TTL_SECONDS, now = Date.now } = {}) {
  if (providers.length && (!secret || String(secret).length < 16)) {
    throw new Error('Sign-in providers need a signing secret of at least 16 characters.');
  }

  const key = providers.length ? deriveOauthSecret(secret) : null;
  const byId = new Map(providers.map((p) => [p.id, p]));

  const sign = (payload) => createHmac('sha256', key).update(`nova.oauth.v1|${payload}`).digest('base64url');

  return {
    /** What the sign-in page should offer. Empty when nothing is configured. */
    list: () => providers.map((p) => ({ id: p.id, label: p.label })),

    has: (id) => byId.has(id),
    get: (id) => byId.get(id),
    get enabled() {
      return providers.length > 0;
    },

    /**
     * Begin a flow. Returns the provider URL to send the browser to, and the sealed envelope
     * to set as a cookie. The caller does both or neither.
     */
    begin({ provider: providerId, mode, next = '/account', redirectUri }) {
      const provider = byId.get(providerId);
      if (!provider) return null;

      const state = newOpaqueValue();
      const nonce = newOpaqueValue();
      const codeVerifier = newCodeVerifier();

      const body = {
        p: provider.id,
        s: state,
        n: nonce,
        v: codeVerifier,
        m: mode,
        x: next,
        e: Math.floor(now() / 1000) + ttlSeconds,
        /* A per-flow id, so two tabs mid-sign-in produce visibly different envelopes rather
           than one silently overwriting the other with an identical-looking value. */
        j: randomBytes(8).toString('base64url'),
      };

      const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');

      return {
        cookie: `${encoded}.${sign(encoded)}`,
        url: provider.authorizationUrl({ state, nonce, codeVerifier, redirectUri }),
        state,
      };
    },

    /**
     * Open a returning envelope and check it against the callback.
     *
     * Returns `{ ok: true, flow }` or `{ ok: false, reason }`. Every failure reason is for the
     * server log; the page shows one message for all of them, because the difference between
     * "expired" and "forged" is information the forger supplied and does not need back.
     */
    consume(cookieValue, { state, provider: providerId }) {
      if (!cookieValue) return { ok: false, reason: 'no-cookie' };

      const cut = String(cookieValue).lastIndexOf('.');
      if (cut < 1) return { ok: false, reason: 'malformed' };

      const encoded = cookieValue.slice(0, cut);
      const signature = cookieValue.slice(cut + 1);
      if (!equal(signature, sign(encoded))) return { ok: false, reason: 'bad-signature' };

      let body;
      try {
        body = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
      } catch {
        return { ok: false, reason: 'malformed' };
      }

      if (typeof body?.e !== 'number' || body.e < Math.floor(now() / 1000)) {
        return { ok: false, reason: 'expired' };
      }
      /* The callback must be for the provider the flow was started with, or a person could be
         bounced from one provider's flow into another's callback. */
      if (body.p !== providerId) return { ok: false, reason: 'provider-mismatch' };
      if (!byId.has(body.p)) return { ok: false, reason: 'unknown-provider' };
      if (!state || !equal(state, body.s)) return { ok: false, reason: 'state-mismatch' };

      return {
        ok: true,
        flow: {
          provider: byId.get(body.p),
          nonce: body.n,
          codeVerifier: body.v,
          mode: body.m,
          next: body.x,
        },
      };
    },

    ttlSeconds,
  };
}

export { createGoogleProvider } from './google.mjs';
export { createOidcProvider } from './oidc.mjs';
