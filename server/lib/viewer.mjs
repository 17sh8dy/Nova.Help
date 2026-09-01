/**
 * Who is making this request, and what they may open.
 *
 * NOVA.HELP HAS TWO KINDS OF PROOF, AND THEY DO NOT MIX. This module is where that is
 * enforced, so that no route has to remember the rule:
 *
 * 1. A GUEST PASS (`nh_pass`, lib/access.mjs) is proof of one ticket. You get it by filing a
 *    ticket, or by presenting that ticket's id and the address it was filed with. It opens
 *    that ticket and nothing else, and it says nothing about who you are.
 *
 * 2. A NOVA ACCOUNT SESSION (`nova_session`, server/accounts/) is proof of an identity. It
 *    opens every ticket whose `accountId` is that account's id, and no others.
 *
 * THE RULE THAT MATTERS MOST IS THE ONE THAT IS NOT HERE. An account does NOT get access to a
 * ticket merely because the ticket's requester address equals the account's address. Nothing
 * in Nova.Help sends mail, so nothing verifies that the person who registered `you@example.com`
 * is you; if an address granted access, anyone could register a stranger's address and read
 * every guest ticket ever filed with it. Access follows the account id that was written onto
 * the ticket when it was filed, and only that. The reasoning, and what has to be true before
 * this can change, is in docs/NOVA-ACCOUNTS.md.
 *
 * `current()` is called on nearly every request, so it resolves at most one session and caches
 * the answer on the request object.
 */
import { SESSION_COOKIE } from '../accounts/index.mjs';
import { PASS_COOKIE } from './access.mjs';
import { clearCookie, cookie, parseCookies } from './http.mjs';

const CACHE = Symbol('nova.viewer');

export function createViewer({ accounts, access, config }) {
  return {
    /**
     * The signed-in account for this request, or null.
     *
     * Returns the public view of the account — never the stored document, so a password hash
     * cannot reach a page even by accident.
     */
    async current(req) {
      if (Object.hasOwn(req, CACHE)) return req[CACHE];

      const token = parseCookies(req)[SESSION_COOKIE];
      const resolved = token ? await accounts.resolveSession(token) : null;
      req[CACHE] = resolved?.account ?? null;
      return req[CACHE];
    },

    /** The raw session token, for the one route that needs to revoke it. */
    token: (req) => parseCookies(req)[SESSION_COOKIE],

    /**
     * May this request open this ticket?
     *
     * Two independent grants, checked in the order that costs least. Returns
     * `{ ok, via: 'pass' | 'account' }` so a caller can tell the two apart when it matters.
     */
    async mayOpen(req, ticket) {
      if (!ticket) return { ok: false, via: null };

      if (access.grants(parseCookies(req)[PASS_COOKIE], ticket.id)) return { ok: true, via: 'pass' };

      const account = await this.current(req);
      if (account && ticket.accountId && ticket.accountId === account.id) {
        return { ok: true, via: 'account' };
      }

      return { ok: false, via: null };
    },

    /** The Set-Cookie that starts a session. */
    sessionCookie: (token, { maxAge }) =>
      cookie(SESSION_COOKIE, token, { maxAge, secure: config.secureCookies }),

    /** The Set-Cookie that ends one in the browser. The server-side session is revoked too. */
    clearSessionCookie: () => clearCookie(SESSION_COOKIE, { secure: config.secureCookies }),
  };
}

/**
 * Sanitise a `next=` destination.
 *
 * Sign-in and sign-up carry the page you came from so you land back on it. A redirect target
 * that came from a query string is an open redirect waiting to happen, so only a single-slash
 * absolute path on this site survives: no scheme, no host, no protocol-relative `//evil`, and
 * no backslash, which some browsers normalise into a slash.
 */
export function safeNext(value, fallback = '/account') {
  const raw = String(value ?? '');
  if (!raw.startsWith('/')) return fallback;
  if (raw.startsWith('//') || raw.startsWith('/\\')) return fallback;
  if (raw.includes('\\') || /[\r\n]/.test(raw)) return fallback;
  return raw;
}
