/**
 * The device grant, over HTTP — both halves of it.
 *
 * This is how a Nova product that is NOT a website signs somebody in: Open Cut, Online Earth,
 * Replay.GG and Atlas. The flow and the reasoning behind choosing it are in
 * packages/nova-accounts/deviceService.mjs; this file is the transport.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THE TWO HALVES, AND WHY THEY ARE IN ONE FILE.
 *
 *   /api/device/*   the app talks to these. JSON, no cookie, and no session is ever consulted
 *                   — a cookie arriving here would be a browser doing something odd, and is
 *                   ignored rather than honoured.
 *   /account/device the person talks to these. HTML, session required, POST to decide.
 *
 * They are one feature and they fail as one, so they are read as one. What they must never do
 * is borrow each other's proof, and that is the rule below.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THE RULES THAT CARRY THE SECURITY.
 *
 * A. THE APP ENDPOINTS NEVER READ A COOKIE, AND THE PAGES NEVER READ A BEARER TOKEN. Two
 *    kinds of proof, no bridge between them — the same discipline lib/viewer.mjs applies to
 *    guest passes and account sessions, for the same reason.
 *
 * B. APPROVAL IS A POST BY A SIGNED-IN PERSON. `GET /account/device?code=` may DESCRIBE a
 *    pending grant, because RFC 8628 expects a link that carries the code and describing one
 *    changes nothing. Deciding it is POST-only, so `SameSite=Lax` plus a POST is what stops
 *    another site approving a device on somebody's behalf — the same CSRF posture as every
 *    other state change in this codebase.
 *
 * C. THE ACCOUNT COMES FROM THE SESSION. Never from the form, never from the query string.
 *
 * D. `Cache-Control: no-store` ON EVERY JSON RESPONSE HERE. One of them contains a bearer
 *    token, and the difference between the one that does and the ones that do not is not a
 *    thing to leave to a shared proxy's judgement.
 *
 * E. THE POLL LIMIT IS GENEROUS ON PURPOSE and the pacing is done by `slow_down`. A grant
 *    lives ten minutes and a well-behaved client polls every five seconds, which is 120
 *    requests — so a limiter tight enough to be a defence would break the happy path. The
 *    real pacing is per-grant and lives in the store; this limiter only stops a flood.
 *
 * F. THE APP ENDPOINTS ARE CORS-OPEN, AND THAT IS SAFE ONLY BECAUSE OF RULE A.
 *
 *    Online Earth is a web page. It runs on a `file://` origin in the desktop shell and on
 *    its own origin in a browser, so every call it makes here is cross-origin and a browser
 *    will not even show it the response without `Access-Control-Allow-Origin`. Without this
 *    block, Online Earth could never sign in at all.
 *
 *    `*`, and **NEVER `Access-Control-Allow-Credentials`**. That is the whole safety
 *    argument, and it is worth stating as a rule rather than leaving implicit: these routes
 *    authenticate with a Bearer token that the caller had to already possess, and they ignore
 *    cookies entirely (rule A). A browser will not attach `nova_session` to a request from
 *    another origin unless credentials are allowed, so no site can use a visitor's ambient
 *    cookie here — it would have to steal the token, and if it has the token it did not need
 *    a browser. Adding `Allow-Credentials: true` would turn every one of these into a
 *    cross-site request forgery; it must not be added, and `*` is what makes it impossible.
 *
 *    The page routes under /account get none of this and stay same-origin, cookie-only.
 */
import { bearerToken, DEVICE_POLL_INTERVAL_SECONDS, SYNC_DOCUMENT_LIMIT } from '@nova/accounts';
import { parseBody, readBody } from './lib/body.mjs';
import { clientIp, redirect, sendHtml, sendJson } from './lib/http.mjs';
import { deviceApprovePage, deviceCodePage } from './views/pages/device.mjs';
import { tooManyPage } from './views/pages/status.mjs';

/** A start or a poll is a handful of fields. A sync document has its own, larger, limit. */
const BODY_LIMIT = 8 * 1024;

/**
 * How a refusal reaches the app.
 *
 * RFC 8628's vocabulary, and RFC 6749's status codes, because a client that already speaks
 * the device grant should not need a Nova-specific dialect to run it. `slow_down` and
 * `authorization_pending` are 400s in the spec and are NOT errors in any useful sense — they
 * are the two normal answers to a poll — so they are logged nowhere and mean nothing is wrong.
 */
const OAUTH_STATUS = {
  authorization_pending: 400,
  slow_down: 400,
  expired_token: 400,
  access_denied: 403,
  invalid_grant: 400,
  invalid_request: 400,
  unauthorized_client: 400,
  server_error: 500,
};

const oauthError = (res, error, description) =>
  sendJson(
    res,
    { error, error_description: description },
    { status: OAUTH_STATUS[error] ?? 400, headers: { 'cache-control': 'no-store', ...CORS } },
  );

/**
 * The headers that make an app endpoint reachable from another origin.
 *
 * `*` and no credentials — see rule F. `Vary: Origin` is not needed because the answer does
 * not depend on the origin; it is the same `*` for everyone.
 */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
  'access-control-max-age': '86400',
};

const ok = (res, data, status = 200) =>
  sendJson(res, data, { status, headers: { 'cache-control': 'no-store', ...CORS } });

const tooLarge = (res) =>
  sendJson(
    res,
    {
      error: 'too-large',
      error_description: `A sync document may be at most ${SYNC_DOCUMENT_LIMIT} bytes.`,
    },
    { status: 413, headers: { 'cache-control': 'no-store', ...CORS } },
  );

export function registerDeviceRoutes(router, ctx) {
  const { accounts, viewer, limiters, config, logger } = ctx;
  const ip = (req) => clientIp(req, { trustProxy: config.trustProxy });

  const tooMany = (res, retryAfter) =>
    sendHtml(res, tooManyPage({ retryAfter }), {
      status: 429,
      headers: { 'retry-after': String(retryAfter) },
    });

  /**
   * Who is this app, from its Authorization header — and nothing else.
   *
   * Returns null for no token, a bad token, a revoked session or a lapsed one, and the caller
   * turns that into one 401. It deliberately does NOT fall back to a cookie: an endpoint that
   * accepts either proof is an endpoint where a stolen cookie is a product token.
   */
  const asApp = async (req) => {
    const token = bearerToken(req.headers.authorization);
    return token ? accounts.resolveProductToken(token) : null;
  };

  /** A scope check, written once so no route does it by eye. */
  const holds = (app, scope) => Boolean(app && app.scopes.includes(scope));

  /* ── The app's endpoints ───────────────────────────────────────────────────────────────
   *
   * Preflight first. A browser sends OPTIONS before any of these because they carry an
   * `Authorization` header and a JSON content type, and a preflight that 405s means the real
   * request is never sent — which looks to a person like "could not reach Nova Accounts".
   */
  for (const path of ['/api/device/code', '/api/device/token', '/api/device/sign-out', '/api/account', '/api/sync']) {
    router.options(path, async (_req, res) => {
      res.writeHead(204, { ...CORS, 'content-length': '0' });
      res.end();
    });
  }


  /**
   * Start a device authorization. RFC 8628 §3.1/§3.2.
   *
   * The BODY names the product and the scopes it wants, and neither is taken at face value:
   * an unregistered product is refused, a web product is refused, and the scopes are
   * intersected with what the registry allows that product — so an app asking for `email`
   * that may not have it gets a token without it rather than a token with it.
   */
  router.post('/api/device/code', async (req, res) => {
    const gate = await limiters.deviceStart.hit(ip(req) ?? 'unknown');
    if (!gate.ok) {
      return sendJson(
        res,
        { error: 'slow_down', error_description: 'Too many sign-in attempts from here. Try again shortly.' },
        { status: 429, headers: { 'retry-after': String(gate.retryAfter), 'cache-control': 'no-store', ...CORS } },
      );
    }

    const body = await parseBody(req, { limit: BODY_LIMIT });
    const fields = body.fields ?? {};
    const started = await accounts.startDeviceAuthorization({
      product: fields.product ?? fields.client_id,
      scopes: fields.scope ?? fields.scopes ?? [],
      deviceName: fields.device_name ?? fields.deviceName ?? null,
    });

    if (!started.ok) {
      /* `unauthorized_client` for both "no such product" and "that product is a website", and
         deliberately without saying which: the list of Nova products is public, but which
         string this server accepts is not a thing an unregistered caller needs enumerated. */
      if (started.reason === 'unknown-product' || started.reason === 'product-not-device') {
        return oauthError(res, 'unauthorized_client', 'That product may not sign in this way.');
      }
      logger?.error?.('[nova.help] device authorization could not start', started.reason);
      return oauthError(res, 'server_error', 'Could not start a sign-in just now.');
    }

    const base = config.origin ?? `http://${req.headers.host ?? '127.0.0.1'}`;
    const verificationUri = `${base.replace(/\/+$/, '')}/account/device`;

    return ok(
      res,
      {
        device_code: started.deviceCode,
        user_code: started.userCode,
        verification_uri: verificationUri,
        /* The one-click form of the same URL. Offered because an app that can open a browser
           should not make somebody retype eight characters — and it still only DESCRIBES the
           grant; the approval on the other end is a POST either way. */
        verification_uri_complete: `${verificationUri}?code=${encodeURIComponent(started.userCode)}`,
        expires_in: Math.max(0, Math.round((new Date(started.expiresAt) - Date.now()) / 1000)),
        interval: started.interval,
        product: started.product,
        product_name: started.productName,
        scope: started.scopes.join(' '),
      },
      201,
    );
  });

  /**
   * Poll for the token. RFC 8628 §3.4/§3.5.
   *
   * Every answer other than success is one of the spec's five, and the two that mean "keep
   * waiting" are indistinguishable from the two that mean "this was never real" unless the
   * caller holds the device code — which is the property that keeps polling from being a way
   * to find out which codes exist.
   */
  router.post('/api/device/token', async (req, res) => {
    const gate = await limiters.devicePoll.hit(ip(req) ?? 'unknown');
    if (!gate.ok) {
      return sendJson(
        res,
        { error: 'slow_down', error_description: 'Slow down.' },
        { status: 429, headers: { 'retry-after': String(gate.retryAfter), 'cache-control': 'no-store', ...CORS } },
      );
    }

    const body = await parseBody(req, { limit: BODY_LIMIT });
    const fields = body.fields ?? {};

    /* The grant type is checked because this endpoint will grow others (a refresh, one day),
       and the failure for "you asked for the wrong thing" should not be the failure for "your
       code is wrong". */
    const grantType = fields.grant_type ?? 'urn:ietf:params:oauth:grant-type:device_code';
    if (grantType !== 'urn:ietf:params:oauth:grant-type:device_code') {
      return oauthError(res, 'invalid_request', 'Unsupported grant_type.');
    }

    const redeemed = await accounts.redeemDeviceAuthorization(fields.device_code ?? fields.deviceCode);
    if (!redeemed.ok) {
      const description = {
        authorization_pending: 'Waiting for the code to be approved.',
        slow_down: `Poll no more often than every ${DEVICE_POLL_INTERVAL_SECONDS} seconds.`,
        expired_token: 'That code has expired. Start again.',
        access_denied: 'The request was refused.',
      };
      return oauthError(res, redeemed.reason, description[redeemed.reason] ?? 'That code cannot be used.');
    }

    return ok(res, {
      access_token: redeemed.token,
      token_type: 'Bearer',
      expires_in: Math.max(0, Math.round((new Date(redeemed.expiresAt) - Date.now()) / 1000)),
      scope: redeemed.scopes.join(' '),
      product: redeemed.product,
      /* The scoped view, so the app can put a name on screen without a second round trip —
         and so that what it may see is decided once, by the scopes, in one place. */
      account: redeemed.account,
    });
  });

  /**
   * Who am I? The endpoint an app calls at startup to find out whether its stored token still
   * works — which is also how it learns that it was signed out from the account page.
   */
  router.get('/api/account', async (req, res) => {
    const app = await asApp(req);
    if (!app) return oauthError(res, 'invalid_grant', 'Not signed in.');
    return ok(res, { account: app.account, product: app.product, scope: app.scopes.join(' ') });
  });

  /**
   * Sign this app out — the app's own copy of the button on the account page.
   *
   * It revokes only its own session, because that is the only session it can name: the id
   * comes out of the token it presented and not from anything in the request.
   */
  router.post('/api/device/sign-out', async (req, res) => {
    const app = await asApp(req);
    if (!app) return oauthError(res, 'invalid_grant', 'Not signed in.');
    await accounts.revokeDevice(app.accountId, app.session.id);
    return ok(res, { ok: true });
  });

  /* ── Sync ────────────────────────────────────────────────────────────────────────────── */

  /**
   * THE PRODUCT COMES FROM THE TOKEN, NEVER FROM THE REQUEST.
   *
   * That one line is what makes "each product only sees what it needs" true for stored data:
   * Open Cut's token can only ever address Open Cut's document, so there is no parameter to
   * tamper with and no path where one product reads another's.
   */
  router.get('/api/sync', async (req, res) => {
    const app = await asApp(req);
    if (!app) return oauthError(res, 'invalid_grant', 'Not signed in.');
    if (!holds(app, 'sync')) return oauthError(res, 'access_denied', 'This app may not use sync.');

    const doc = await accounts.readSyncDocument({ accountId: app.accountId, product: app.product });
    return ok(res, { version: doc.version, updatedAt: doc.updatedAt, data: doc.data });
  });

  /**
   * Store a document, IF the client's `baseVersion` is still current.
   *
   * A CONFLICT IS A 409 CARRYING THE SERVER'S DOCUMENT, not a failure to be retried harder.
   * The client is meant to look at what it lost the race to and decide — which is the whole
   * reason there is no unconditional write here. See syncDocuments.mjs.
   */
  router.put('/api/sync', async (req, res) => {
    const app = await asApp(req);
    if (!app) return oauthError(res, 'invalid_grant', 'Not signed in.');
    if (!holds(app, 'sync')) return oauthError(res, 'access_denied', 'This app may not use sync.');

    /**
     * OVERSIZED IS ANSWERED, NOT HUNG UP ON.
     *
     * `readBody` defends the process by destroying the socket once a body passes its limit,
     * which is right for a form post from a browser and wrong here: a client that gets a
     * dropped connection cannot tell "your document is too big" from "the network died", so
     * it retries forever and never learns the one thing it needed to know. Checking the
     * declared length first turns the common case — a client that knows its own size — into a
     * real 413 with a real reason. The reader's limit stays as the backstop for a chunked
     * body that declares nothing, and for a client that lies about it.
     */
    const declared = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(declared) && declared > SYNC_DOCUMENT_LIMIT) return tooLarge(res);

    const raw = await readBody(req, { limit: SYNC_DOCUMENT_LIMIT + 4096 });
    if (!raw.ok) return tooLarge(res);

    let payload;
    try {
      payload = JSON.parse(raw.buffer.toString('utf8') || '{}');
    } catch {
      return oauthError(res, 'invalid_request', 'Expected a JSON body.');
    }

    const written = await accounts.writeSyncDocument({
      accountId: app.accountId,
      product: app.product,
      baseVersion: payload.baseVersion,
      data: payload.data ?? null,
    });

    if (written.ok) return ok(res, { ok: true, version: written.version, updatedAt: written.updatedAt });

    if (written.reason === 'conflict') {
      return sendJson(
        res,
        {
          error: 'conflict',
          error_description:
            'This account has been updated since you last synced. Nothing was overwritten.',
          current: {
            version: written.current?.version ?? 0,
            updatedAt: written.current?.updatedAt ?? null,
            data: written.current?.data ?? null,
          },
        },
        { status: 409, headers: { 'cache-control': 'no-store', ...CORS } },
      );
    }

    const status = written.reason === 'too-large' ? 413 : written.reason === 'no-such-account' ? 401 : 400;
    return sendJson(
      res,
      { error: written.reason, error_description: 'That document was not stored.' },
      { status, headers: { 'cache-control': 'no-store', ...CORS } },
    );
  });

  /* ── The person's pages ──────────────────────────────────────────────────────────────── */

  const codeFrom = (value) => String(value ?? '').trim();

  /** Where an unsigned-in visitor is sent, and back to, carrying the code they arrived with. */
  const signInFirst = (code) => {
    const next = code ? `/account/device?code=${encodeURIComponent(code)}` : '/account/device';
    return `/account/sign-in?next=${encodeURIComponent(next)}`;
  };

  /**
   * The code form, and — when a code is present and real — the confirmation.
   *
   * A GET may describe a grant because describing one changes nothing and RFC 8628 expects a
   * link that carries the code. Deciding is POST-only, below.
   */
  router.get('/account/device', async (req, res) => {
    const params = new URL(req.url, 'http://local').searchParams;
    const code = codeFrom(params.get('code'));
    const done = ['approved', 'denied'].includes(params.get('done')) ? params.get('done') : null;
    const account = await viewer.current(req);

    if (!account) {
      /* Signed out with a code in hand, send them to sign in and bring them back to it. With
         no code, still render the form — the page explains itself before asking for anything,
         which is the difference between an invitation and a wall. */
      if (code) return redirect(res, signInFirst(code));
      return sendHtml(res, deviceCodePage({ done }));
    }

    if (!code) return sendHtml(res, deviceCodePage({ account, done }));

    const described = await accounts.describeDeviceAuthorization(code);
    if (!described.ok) {
      return sendHtml(res, deviceCodePage({ account, code, error: describeProblem(described.reason) }), {
        status: 404,
      });
    }

    return sendHtml(res, deviceApprovePage({ grant: described.grant, code, account }));
  });

  /**
   * Look a code up. A POST because it is a form submission, and it redirects to the GET that
   * renders the confirmation — so the confirmation screen has a URL somebody can reload.
   */
  router.post('/account/device/check', async (req, res) => {
    const gate = await limiters.deviceVerify.hit(ip(req) ?? 'unknown');
    if (!gate.ok) return tooMany(res, gate.retryAfter);

    const body = await parseBody(req, { limit: BODY_LIMIT });
    const code = codeFrom(body.fields?.code);
    const account = await viewer.current(req);
    if (!account) return redirect(res, signInFirst(code));

    return redirect(res, `/account/device?code=${encodeURIComponent(code)}`);
  });

  /**
   * Approve or refuse. The one state change, and the reason everything above is careful.
   *
   * The account is `account.id` from the session and nothing else. The rate limiter is on this
   * route rather than only on the lookup because this is the one that can be walked: eight
   * Crockford characters is roughly forty bits, and forty bits is a lot to a person and not
   * much to a script.
   */
  router.post('/account/device', async (req, res) => {
    const gate = await limiters.deviceVerify.hit(ip(req) ?? 'unknown');
    if (!gate.ok) return tooMany(res, gate.retryAfter);

    const body = await parseBody(req, { limit: BODY_LIMIT });
    const code = codeFrom(body.fields?.code);
    const approve = body.fields?.action === 'approve';

    const account = await viewer.current(req);
    if (!account) return redirect(res, signInFirst(code));

    const decided = await accounts.decideDeviceAuthorization(code, { accountId: account.id, approve });
    if (!decided.ok) {
      return sendHtml(res, deviceCodePage({ account, code, error: describeProblem(decided.reason) }), {
        status: 404,
      });
    }

    return redirect(res, `/account/device?done=${approve ? 'approved' : 'denied'}`);
  });

  /**
   * Sign one connected app out, from the account page.
   *
   * The session id names a device session belonging to THIS account; `revokeDevice` refuses
   * anything else, so a stray id cannot end somebody's browser session or reach another
   * account's device.
   */
  router.post('/account/devices/revoke', async (req, res) => {
    const account = await viewer.current(req);
    if (!account) return redirect(res, '/account/sign-in?next=%2Faccount');

    const body = await parseBody(req, { limit: BODY_LIMIT });
    const removed = await accounts.revokeDevice(account.id, String(body.fields?.session ?? ''));
    return redirect(res, removed ? '/account?welcome=device-signed-out' : '/account');
  });
}

/** One sentence per refusal, and never one that says whether a code exists. */
function describeProblem(reason) {
  if (reason === 'expired') return 'That code has expired.';
  if (reason === 'already-decided') return 'That code has already been used.';
  return "We could not find that code. Check the app and type it again.";
}
