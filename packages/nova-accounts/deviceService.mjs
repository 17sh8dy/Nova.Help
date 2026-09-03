/**
 * The device authorization grant — how a Nova app that is not a website signs somebody in.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS FLOW AND NOT ANOTHER.
 *
 * docs/NOVA-ACCOUNTS.md left the wire protocol open on purpose, to be decided "with a real
 * second product's needs in front of you." There are now four: Open Cut and Replay.GG
 * (Electron), Online Earth (a website that also ships in an Electron shell), and Atlas
 * (Tauri). They have one shape in common and it decides the answer:
 *
 *   - None of them can keep a client secret. They are installed on other people's machines,
 *     so anything compiled in is public. That rules out any flow with a confidential client.
 *   - None of them should ever see the password. A desktop app with a password box trains
 *     people to type their Nova password into desktop apps, which is the phishing lesson you
 *     least want to teach.
 *   - A loopback redirect (RFC 8252) would work for the three Electron apps, require Rust
 *     changes and a bound port for Atlas, and be impossible for Online Earth running as a
 *     plain web page, which cannot listen on a socket.
 *
 * The device grant (RFC 8628) is the one flow that is identical in all four, plus a browser,
 * plus whatever arrives next, and needs no listener, no redirect URI registration and no
 * secret. The app shows a code; the person approves it in a browser where they are already
 * signed in; the app polls and receives a token. Nova.Help is the authorization server
 * because it is the front door that already holds the account UI.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHAT AN APP GETS, AND WHAT IT DOES NOT.
 *
 * It gets a PRODUCT TOKEN — scoped, revocable, signed under a key that is not the session
 * key (productTokens.mjs). It does not get the session cookie, the password, the address
 * unless `email` was granted, or the ability to act as another product: the token names its
 * product, and every scope check runs against the registry entry for THAT product.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THE THREE REFUSALS THAT MATTER, none of which may be relaxed for convenience:
 *
 * 1. APPROVAL IS AN ACT BY A SIGNED-IN PERSON, ON A PAGE THAT NAMES THE PRODUCT AND THE
 *    SCOPES. Never a GET, never automatic, never inferred from having the code.
 * 2. A GRANT IS REDEEMED ONCE. `redeemDeviceAuthorization` is atomic in the store, exactly
 *    like `redeemPasswordReset`, so two polls arriving together cannot both come back with a
 *    token — which would mean two devices holding credentials for one approval.
 * 3. THE DEVICE CODE IS COMPARED AS A DIGEST, IN CONSTANT TIME, and a grant that is pending,
 *    denied, expired or already spent is refused by the store rather than by a caller that
 *    read it a moment ago.
 */
import { randomUUID } from 'node:crypto';

import {
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_POLL_INTERVAL_SECONDS,
  hashDeviceCode,
  isUserCode,
  newDeviceCode,
  newUserCode,
  normalizeUserCode,
} from './deviceCodes.mjs';
import { getProduct, grantableScopes } from './products.mjs';
import { publicView } from './service.mjs';

/**
 * An account, narrowed to the scopes a product token actually carries.
 *
 * BUILT UP FROM NOTHING rather than deleted down from `publicView`, for the same reason
 * `publicView` is built up from the document: a field added to the account later cannot leak
 * through here by being forgotten, because nothing arrives unless it is named.
 */
export function scopedView(account, scopes = []) {
  if (!account) return null;
  const full = publicView(account);
  const has = new Set(scopes);

  const view = {
    id: full.id,
    displayName: full.displayName,
    /* Not behind a scope: this is the list of Nova products the account has been used with —
       the ecosystem seam. It names no addresses, no devices and no sessions. */
    products: full.products,
  };

  if (has.has('email')) {
    view.email = full.email;
    view.emailVerified = full.emailVerified;
  }

  return view;
}

export { DEVICE_CODE_TTL_SECONDS, DEVICE_POLL_INTERVAL_SECONDS };

export function createDeviceService({
  store,
  productTokens,
  ttlSeconds = DEVICE_CODE_TTL_SECONDS,
  tokenTtlSeconds,
  /** Where a person is told to go and type the code. Injected: the module has no idea. */
  verificationUri = null,
  logger = console,
}) {
  const prune = (sessions = []) => {
    const now = Date.now();
    return sessions.filter((session) => new Date(session.expiresAt).getTime() > now);
  };

  return {
    /**
     * Step one: an app asks to be signed in.
     *
     * Returns the pair of codes and everything a well-behaved client needs to run the flow.
     * `deviceCode` is returned ONCE and never again — the store holds only its digest.
     */
    async startDeviceAuthorization({ product, scopes = [], deviceName = null, now = new Date() } = {}) {
      const entry = getProduct(product);
      if (!entry) return { ok: false, reason: 'unknown-product' };
      /* A web product signs in with a cookie at its own origin. Letting one run the device
         flow would mean a page could mint itself a bearer token that outlives its session. */
      if (entry.kind !== 'device') return { ok: false, reason: 'product-not-device' };

      const granted = grantableScopes(entry.id, scopes);
      const { code, hash } = newDeviceCode();
      const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();

      /* Retried because a user code is only eight characters: a collision with a LIVE grant is
         unlikely and not impossible, and two grants sharing one code would be approvable into
         each other. The store decides it, under the uniqueness of the code itself. */
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const userCode = newUserCode();
        const created = await store.createDeviceAuthorization({
          id: randomUUID(),
          deviceCodeHash: hash,
          userCode: normalizeUserCode(userCode),
          product: entry.id,
          scopes: granted,
          deviceName: deviceName ? String(deviceName).slice(0, 60) : null,
          status: 'pending',
          accountId: null,
          createdAt: now.toISOString(),
          expiresAt,
          lastPolledAt: null,
        });
        if (created.ok) {
          return {
            ok: true,
            deviceCode: code,
            userCode,
            expiresAt,
            interval: DEVICE_POLL_INTERVAL_SECONDS,
            verificationUri,
            product: entry.id,
            productName: entry.name,
            scopes: granted,
          };
        }
        if (created.reason !== 'user-code-taken') return { ok: false, reason: created.reason };
      }

      logger?.error?.('[nova-accounts] could not allocate a free device user code');
      return { ok: false, reason: 'no-code-available' };
    },

    /**
     * What the approval page shows: which product is asking, and for what.
     *
     * Deliberately returns nothing secret and nothing about any account — at this point
     * nobody has approved anything, and the person reading it may not be the person who
     * started the flow.
     */
    async describeDeviceAuthorization(userCode, { now = new Date() } = {}) {
      if (!isUserCode(userCode)) return { ok: false, reason: 'not-found' };
      const grant = await store.getDeviceAuthorizationByUserCode(normalizeUserCode(userCode));
      /* A code that never existed and a code that has lapsed are the same answer, so the form
         is not a way to learn which codes are live. */
      if (!grant) return { ok: false, reason: 'not-found' };
      if (new Date(grant.expiresAt).getTime() <= now.getTime()) return { ok: false, reason: 'expired' };
      if (grant.status !== 'pending') return { ok: false, reason: 'already-decided' };

      const entry = getProduct(grant.product);
      return {
        ok: true,
        grant: {
          product: grant.product,
          productName: entry?.name ?? grant.product,
          productSummary: entry?.summary ?? null,
          deviceName: grant.deviceName,
          scopes: grant.scopes,
          expiresAt: grant.expiresAt,
        },
      };
    },

    /**
     * Step two: a signed-in person says yes (or no).
     *
     * `accountId` comes from the SESSION on the approving request and never from the form — a
     * hidden field naming the account would be a way to approve a device onto somebody else's
     * account by handing them a doctored link.
     */
    async decideDeviceAuthorization(userCode, { accountId, approve, now = new Date() } = {}) {
      if (!isUserCode(userCode)) return { ok: false, reason: 'not-found' };
      if (!accountId) return { ok: false, reason: 'not-signed-in' };

      return store.decideDeviceAuthorization(normalizeUserCode(userCode), {
        accountId,
        status: approve ? 'approved' : 'denied',
        now,
      });
    },

    /**
     * Step three: the app polls, and eventually gets a token.
     *
     * The `reason` strings are RFC 8628's, because a client that already speaks the device
     * grant should not need a Nova-specific vocabulary to run it.
     */
    async redeemDeviceAuthorization(deviceCode, { now = new Date() } = {}) {
      if (typeof deviceCode !== 'string' || !deviceCode) return { ok: false, reason: 'invalid_grant' };

      const claimed = await store.redeemDeviceAuthorization({
        deviceCodeHash: hashDeviceCode(deviceCode),
        minIntervalSeconds: DEVICE_POLL_INTERVAL_SECONDS,
        now,
      });
      if (!claimed.ok) return claimed;

      const grant = claimed.grant;
      /* Re-intersected at issue time rather than trusted from the stored row. A product whose
         registry entry lost a scope between approval and this moment must not be handed the
         scope it used to have. */
      const scopes = grantableScopes(grant.product, grant.scopes);
      const ttl = tokenTtlSeconds ?? productTokens.ttlSeconds;
      const session = {
        id: randomUUID(),
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
        product: grant.product,
        kind: 'device',
        scopes,
        label: grant.deviceName ?? null,
      };

      const updated = await store.update(grant.accountId, (doc) => {
        if (doc.status !== 'active') return null;
        doc.sessions = [...prune(doc.sessions), session];
        doc.products ??= {};
        doc.products[grant.product] ??= { firstSeenAt: now.toISOString() };
        doc.updatedAt = now.toISOString();
        return doc;
      });
      /* The grant is already spent, so a disabled account cannot retry — which is correct: the
         answer to "this account may not sign in" should not depend on how fast you ask. */
      if (!updated) return { ok: false, reason: 'access_denied' };

      return {
        ok: true,
        token: productTokens.issue({
          accountId: grant.accountId,
          sessionId: session.id,
          product: grant.product,
          scopes,
          expiresAt: session.expiresAt,
        }),
        expiresAt: session.expiresAt,
        product: grant.product,
        scopes,
        account: scopedView(updated, scopes),
      };
    },

    /**
     * Who is making this request, for a Bearer product token.
     *
     * THREE THINGS MUST HOLD, and the third is the one that is easy to leave out: the
     * signature verifies, the session id is still listed on the account, AND the session
     * recorded there is the same product and no wider in scope than the token claims. The
     * narrower of the two scope lists wins, so a grant revoked down to nothing stops opening
     * things immediately rather than at expiry.
     */
    async resolveProductToken(token) {
      const claim = productTokens.verify(token);
      if (!claim) return null;

      const account = await store.get(claim.accountId);
      if (!account || account.status !== 'active') return null;

      const session = (account.sessions ?? []).find((entry) => entry.id === claim.sessionId);
      if (!session) return null;
      if (new Date(session.expiresAt).getTime() <= Date.now()) return null;
      /* A web session's id presented in a product token, or the other way round. The key split
         already makes this unreachable; it is checked anyway, because "unreachable" is a
         property of today's key derivation and this is a property of the record. */
      if (session.kind !== 'device') return null;
      if (session.product !== claim.product) return null;

      const stored = new Set(session.scopes ?? []);
      const scopes = claim.scopes.filter((scope) => stored.has(scope));
      if (!scopes.includes('identity')) return null;

      return {
        account: scopedView(account, scopes),
        session,
        product: claim.product,
        scopes,
        accountId: account.id,
      };
    },

    /** Every device signed in to this account, for the account page. Never any token. */
    async listDevices(accountId) {
      const account = await store.get(accountId);
      if (!account) return [];
      return prune(account.sessions)
        .filter((session) => session.kind === 'device')
        .map((session) => ({
          id: session.id,
          product: session.product,
          productName: getProduct(session.product)?.name ?? session.product,
          label: session.label ?? null,
          scopes: session.scopes ?? [],
          createdAt: session.createdAt,
          expiresAt: session.expiresAt,
        }))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    },

    /**
     * Sign one device out, from the account page or from the app itself.
     *
     * Only device sessions are removable this way: passing a browser session's id must not be
     * a way for a product token to end somebody's web session.
     */
    async revokeDevice(accountId, sessionId) {
      let removed = false;
      await store.update(accountId, (doc) => {
        const before = (doc.sessions ?? []).length;
        doc.sessions = prune(doc.sessions).filter(
          (entry) => !(entry.id === sessionId && entry.kind === 'device'),
        );
        removed = doc.sessions.length !== before;
        doc.updatedAt = new Date().toISOString();
        return doc;
      });
      return removed;
    },
  };
}
