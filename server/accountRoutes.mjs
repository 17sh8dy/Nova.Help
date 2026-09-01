/**
 * The Nova Account routes.
 *
 * They sit in their own file rather than in routes.mjs for the same reason server/accounts/
 * sits in its own directory: identity is a thing Nova.Help USES, not a thing Nova.Help IS, and
 * when it moves behind a service the diff should be readable.
 *
 * The conventions from routes.mjs hold here too — a route decides and renders, every POST ends
 * in a redirect on success — plus two that are specific to authentication:
 *
 * A. THE SESSION COOKIE IS THE ONLY THING THAT SAYS WHO YOU ARE. No hidden field, no query
 *    parameter and no header is ever trusted for identity. `next=` is a destination and is
 *    sanitised as one.
 *
 * B. EVERY FAILURE OF SIGN-IN LOOKS THE SAME. One message, one status, whether the address is
 *    unknown, the password is wrong, or the account is disabled.
 *
 * RATE LIMITING IS ON BOTH AXES. Sign-in counts against the source address AND against the
 * email address being tried, so neither a single attacker with one address nor a distributed
 * attempt at one account gets an unlimited number of guesses. Sign-up counts against the
 * source only, because the address being registered is by definition not yet an account.
 *
 * C. FEDERATED SIGN-IN DECIDES ITS MODE FROM THE SESSION. `/account/auth/google` signs you in
 *    when you are signed out and links when you are signed in, and which of those is happening
 *    is read from the session cookie, never from a parameter. The mode is sealed into the
 *    state envelope at the start and re-checked at the end, so a flow begun as a sign-in
 *    cannot come back as a link against an account that appeared in between.
 */
import { OAUTH_COOKIE, OAUTH_TTL_SECONDS } from './accounts/index.mjs';
import { summarize } from './core/tickets.mjs';
import { parseBody } from './lib/body.mjs';
import { clearCookie, clientIp, cookie, parseCookies, redirect, sendHtml, withCookie } from './lib/http.mjs';
import { safeNext } from './lib/viewer.mjs';
import { accountPage, createAccountPage, signInPage } from './views/pages/account.mjs';
import { forgotPasswordPage, resetPasswordPage, resetRequestedPage } from './views/pages/passwordReset.mjs';
import { tooManyPage } from './views/pages/status.mjs';

/** Sign-in and sign-up bodies are small; anything larger is not a form. */
const BODY_LIMIT = 16 * 1024;

export function registerAccountRoutes(router, ctx) {
  const { accounts, tickets, viewer, limiters, config, logger } = ctx;
  const ip = (req) => clientIp(req, { trustProxy: config.trustProxy });
  const providers = accounts.providers;

  /** What the sign-in and account pages should offer. Empty when nothing is configured. */
  const offered = () => providers.list();

  /**
   * Where the provider sends the browser back to.
   *
   * Configured origin wins. Falling back to the request's own Host header is a development
   * convenience and is not a hole: a provider only redirects to a URI that was registered with
   * it in advance, so a spoofed Host produces a mismatch the provider refuses, not a redirect
   * somewhere unexpected.
   */
  const redirectUriFor = (req, providerId) => {
    const base = config.origin ?? `http://${req.headers.host ?? '127.0.0.1'}`;
    return `${base.replace(/\/+$/, '')}/account/auth/${encodeURIComponent(providerId)}/callback`;
  };

  const oauthCookie = (value) =>
    cookie(OAUTH_COOKIE, value, { maxAge: OAUTH_TTL_SECONDS, secure: config.secureCookies });
  const clearOauthCookie = () => clearCookie(OAUTH_COOKIE, { secure: config.secureCookies });
  const oauthEnvelope = (req) => parseCookies(req)[OAUTH_COOKIE];

  const queryNext = (req) => safeNext(new URL(req.url, 'http://local').searchParams.get('next'));

  const tooMany = (res, retryAfter) =>
    sendHtml(res, tooManyPage({ retryAfter }), {
      status: 429,
      headers: { 'retry-after': String(retryAfter) },
    });

  /** Start a session and send the person on to wherever they were going. */
  async function openSession(res, accountId, destination, { banner } = {}) {
    const started = await accounts.startSession(accountId, { ttlSeconds: accounts.ttlSeconds });
    if (!started.ok) {
      // The account vanished between the password check and here. Vanishingly unlikely, and
      // still better handled than assumed away.
      return sendHtml(res, signInPage({ failed: true, providers: offered() }), { status: 403 });
    }

    const target = destination === '/account' && banner ? `/account?welcome=${banner}` : destination;
    return redirect(res, target, {
      headers: { 'set-cookie': viewer.sessionCookie(started.token, { maxAge: accounts.ttlSeconds }) },
    });
  }

  /* ── Sign in ─────────────────────────────────────────────────────────────────────────── */

  router.get('/account/sign-in', async (req, res) => {
    // Already signed in? The sign-in form is not the page you wanted.
    if (await viewer.current(req)) return redirect(res, queryNext(req));
    return sendHtml(res, signInPage({ next: queryNext(req), providers: offered(), notice: signInNotice(req) }));
  });

  router.post('/account/sign-in', async (req, res) => {
    const body = await parseBody(req, { limit: BODY_LIMIT });
    const next = safeNext(body.fields?.next);

    const bySource = await limiters.signIn.hit(ip(req) ?? 'unknown');
    if (!bySource.ok) return tooMany(res, bySource.retryAfter);

    const email = accounts.normalizeEmail(body.fields?.email);
    const byEmail = email ? await limiters.signInEmail.hit(`email:${email}`) : { ok: true, retryAfter: 0 };
    if (!byEmail.ok) return tooMany(res, byEmail.retryAfter);

    const attempt = await accounts.signIn(body.fields ?? {});

    if (!attempt.ok) {
      /* A missing field gets its own per-field message because that is a typo, not an attack.
         Everything else gets the one generic failure. */
      const rendered =
        attempt.reason === 'incomplete'
          ? signInPage({ values: attempt.values, errors: attempt.errors, next, providers: offered() })
          : signInPage({ values: attempt.values, failed: true, next, providers: offered() });
      return sendHtml(res, rendered, { status: attempt.reason === 'incomplete' ? 422 : 401 });
    }

    // A correct password clears the counters, so one forgotten password does not cost the
    // rest of the afternoon.
    await limiters.signIn.clear(ip(req) ?? 'unknown');
    await limiters.signInEmail.clear(`email:${email}`);

    return openSession(res, attempt.account.id, next, { banner: 'signed-in' });
  });

  /* ── Create an account ───────────────────────────────────────────────────────────────── */

  router.get('/account/new', async (req, res) => {
    if (await viewer.current(req)) return redirect(res, queryNext(req));
    return sendHtml(res, createAccountPage({ next: queryNext(req), providers: offered() }));
  });

  router.post('/account/new', async (req, res) => {
    const gate = await limiters.register.hit(ip(req) ?? 'unknown');
    if (!gate.ok) return tooMany(res, gate.retryAfter);

    const body = await parseBody(req, { limit: BODY_LIMIT });
    const next = safeNext(body.fields?.next);

    const created = await accounts.register(body.fields ?? {});
    if (!created.ok) {
      return sendHtml(res, createAccountPage({ values: created.values, errors: created.errors, next, providers: offered() }), {
        status: 422,
      });
    }

    return openSession(res, created.account.id, next, { banner: 'created' });
  });

  /* ── The account ─────────────────────────────────────────────────────────────────────── */

  router.get('/account', async (req, res) => {
    const account = await viewer.current(req);
    if (!account) return redirect(res, '/account/sign-in?next=%2Faccount');

    const mine = await tickets.listForAccount(account.id, { limit: 50 });
    const params = new URL(req.url, 'http://local').searchParams;
    const welcome = params.get('welcome');
    const banner = ['created', 'signed-in', 'signed-out-everywhere', 'linked', 'unlinked', 'password-reset'].includes(welcome)
      ? welcome
      : null;
    /* A closed set, so nothing a caller invents is reflected back into the page. */
    const problem = ['last-way-in', 'identity-taken', 'not-linked', 'failed'].includes(params.get('oauth'))
      ? params.get('oauth')
      : null;

    return sendHtml(
      res,
      accountPage({
        account,
        tickets: mine.tickets.map(summarize),
        total: mine.total,
        banner,
        problem,
        providers: offered(),
      }),
    );
  });

  /**
   * Sign out.
   *
   * The session is revoked on the server BEFORE the cookie is cleared, so a copy of the token
   * taken from the browser beforehand is already dead by the time the response lands. Clearing
   * the cookie alone would leave that copy working until it expired.
   *
   * POST only, and the cookie is SameSite=Lax, so another site cannot sign you out.
   */
  router.post('/account/sign-out', async (req, res) => {
    const token = viewer.token(req);
    if (token) await accounts.signOut(token);
    return redirect(res, '/', { headers: { 'set-cookie': viewer.clearSessionCookie() } });
  });

  /* ── Forgotten passwords ─────────────────────────────────────────────────────────────────
   *
   * FOUR ROUTES, AND THE SAME DISCIPLINE AS SIGN-IN: nothing any of them renders tells a
   * stranger whether an address has an account. The POST to /account/forgot answers with the
   * identical page for an address that has one and one that does not, on the same status, and
   * whether or not mail was actually sent — including when the transport is missing or broken,
   * because a 500 for one address and a confirmation for another is the same disclosure by
   * another route.
   *
   * THE LINK IS SPENT BY THE STORE, NOT HERE. `resetPassword` hands the token to an atomic
   * redemption, so two requests carrying the same link cannot both succeed. The GET's check is
   * a courtesy that spends nothing.
   */

  /** Where a reset link points. Built like the OAuth redirect, for the same reasons. */
  const resetLinkFor = (req) => (token) => {
    const base = config.origin ?? `http://${req.headers.host ?? '127.0.0.1'}`;
    return `${base.replace(/\/+$/, '')}/account/reset?token=${encodeURIComponent(token)}`;
  };

  router.get('/account/forgot', async (req, res) => {
    // Somebody already signed in does not need this; send them where they were going.
    if (await viewer.current(req)) return redirect(res, queryNext(req));
    return sendHtml(res, forgotPasswordPage());
  });

  router.post('/account/forgot', async (req, res) => {
    /* Counted per source AND per address, like sign-in. Per source stops one machine walking a
       list; per address stops a distributed attempt at filling one person's inbox. */
    const bySource = await limiters.passwordReset.hit(ip(req) ?? 'unknown');
    if (!bySource.ok) {
      return sendHtml(res, forgotPasswordPage({ rateLimited: bySource.retryAfter }), { status: 429 });
    }

    const body = await parseBody(req, { limit: BODY_LIMIT });
    const email = accounts.normalizeEmail(body.fields?.email);

    if (email) {
      const byEmail = await limiters.passwordResetEmail.hit(`email:${email}`);
      /* Answered with the neutral confirmation rather than a 429, deliberately: a different
         response for an address that has been asked about a lot is itself a signal about that
         address. The request is simply not acted on. */
      if (!byEmail.ok) return sendHtml(res, resetRequestedPage({ email }));
    }

    const requested = await accounts.requestPasswordReset(body.fields ?? {}, { link: resetLinkFor(req) });

    // A malformed address is a typo, not an attack, and saying so reveals nothing.
    if (!requested.ok) {
      return sendHtml(res, forgotPasswordPage({ values: requested.values, errors: requested.errors }), {
        status: 422,
      });
    }

    /* One line for the operator, never for the page. `sent: false` means either no such account
       or a transport that failed, and that difference matters to a log and to nobody else. */
    if (!requested.sent) logger?.info?.('[nova.help] password reset requested; no mail sent');

    return sendHtml(res, resetRequestedPage({ email: requested.values.email }));
  });

  router.get('/account/reset', async (req, res) => {
    const token = new URL(req.url, 'http://local').searchParams.get('token') ?? '';
    const checked = await accounts.checkResetToken(token);

    if (!checked.ok) {
      return sendHtml(res, resetPasswordPage({ invalid: checked.reason === 'expired' ? 'expired' : 'invalid' }), {
        status: 400,
      });
    }
    return sendHtml(res, resetPasswordPage({ token, email: checked.email }));
  });

  router.post('/account/reset', async (req, res) => {
    const gate = await limiters.passwordReset.hit(ip(req) ?? 'unknown');
    if (!gate.ok) return tooMany(res, gate.retryAfter);

    const body = await parseBody(req, { limit: BODY_LIMIT });
    const token = String(body.fields?.token ?? '');
    const result = await accounts.resetPassword(token, body.fields ?? {});

    if (!result.ok) {
      /* A password that fails the rules keeps the form, token and all, so it can be corrected:
         validation happens before redemption, so the link has NOT been spent. A bad link gets
         no form at all. */
      if (result.reason === 'invalid-password') {
        const checked = await accounts.checkResetToken(token);
        if (!checked.ok) return sendHtml(res, resetPasswordPage({ invalid: 'invalid' }), { status: 400 });
        return sendHtml(res, resetPasswordPage({ token, email: checked.email, errors: result.errors }), {
          status: 422,
        });
      }
      return sendHtml(res, resetPasswordPage({ invalid: result.reason === 'expired' ? 'expired' : 'invalid' }), {
        status: 400,
      });
    }

    /* Every session ended when the password changed — including this browser's, if it had one.
       Opening a fresh one leaves the person who just proved they own the address signed in and
       everybody else out, which is the intent of both halves. */
    return openSession(res, result.account.id, '/account', { banner: 'password-reset' });
  });

  /* ── Federated sign-in ───────────────────────────────────────────────────────────────── */

  /**
   * Read a one-shot message the callback left in the query string.
   *
   * The callback cannot render a page of its own without losing the redirect that clears the
   * authorization code out of the address bar, so it redirects here with a short code and this
   * turns the code back into words. The set is closed, so nothing a caller invents is echoed.
   */
  function signInNotice(req) {
    const code = new URL(req.url, 'http://local').searchParams.get('oauth');
    return ['failed', 'email-has-account', 'unverified', 'identity-taken', 'cancelled'].includes(code)
      ? code
      : null;
  }

  /** Begin a flow. Signed out it signs you in; signed in it links. Nothing else decides that. */
  async function beginFlow(req, res, { next }) {
    const providerId = req.params.provider;
    if (!providers.has(providerId)) return notFoundAuth(res);

    const gate = await limiters.oauth.hit(ip(req) ?? 'unknown');
    if (!gate.ok) return tooMany(res, gate.retryAfter);

    const account = await viewer.current(req);
    const started = providers.begin({
      provider: providerId,
      mode: account ? 'link' : 'signin',
      next,
      redirectUri: redirectUriFor(req, providerId),
    });
    if (!started) return notFoundAuth(res);

    return redirect(res, started.url, { headers: { 'set-cookie': oauthCookie(started.cookie) } });
  }

  const notFoundAuth = (res) =>
    sendHtml(res, signInPage({ failed: true, providers: offered() }), { status: 404 });

  router.get('/account/auth/:provider', (req, res) => beginFlow(req, res, { next: queryNext(req) }));

  router.post('/account/auth/:provider', async (req, res) => {
    const body = await parseBody(req, { limit: BODY_LIMIT });
    return beginFlow(req, res, { next: safeNext(body.fields?.next) });
  });

  /**
   * Finish a flow.
   *
   * ORDER MATTERS HERE. The state envelope is opened and CLEARED before the authorization code
   * is exchanged, so a callback URL that leaks — a shared screen, a referrer, shell history —
   * cannot be replayed even once. Everything after that point is on a request we can prove
   * this browser started.
   */
  router.get('/account/auth/:provider/callback', async (req, res) => {
    const providerId = req.params.provider;
    const params = new URL(req.url, 'http://local').searchParams;

    /* Whatever happens, the envelope is spent. Every response below carries this. */
    const spent = { 'set-cookie': clearOauthCookie() };

    /* Resolved up front so a failure lands somewhere useful: somebody already signed in who
       hits a stale or replayed callback wants their account page, not a sign-in form. */
    const account = await viewer.current(req);
    const home = account ? '/account' : '/account/sign-in';
    const back = (code, next = home) =>
      redirect(res, `${next}${next.includes('?') ? '&' : '?'}oauth=${code}`, { headers: spent });

    if (!providers.has(providerId)) return back('failed');

    /* The person pressed "cancel" on the provider's own screen. Not an error. */
    if (params.get('error')) {
      logger.warn?.(`[nova.help] ${providerId} returned ${params.get('error')}`);
      return back(params.get('error') === 'access_denied' ? 'cancelled' : 'failed');
    }

    const opened = providers.consume(oauthEnvelope(req), {
      state: params.get('state'),
      provider: providerId,
    });
    if (!opened.ok) {
      /* The reason is for us. The page says one thing for all of them, because the difference
         between "expired" and "forged" is information the forger supplied. */
      logger.warn?.(`[nova.help] ${providerId} callback rejected: ${opened.reason}`);
      return back('failed');
    }

    const { flow } = opened;
    const code = params.get('code');
    if (!code) return back('failed');

    let identity;
    try {
      identity = await flow.provider.identify({
        code,
        codeVerifier: flow.codeVerifier,
        nonce: flow.nonce,
        redirectUri: redirectUriFor(req, providerId),
      });
    } catch (error) {
      logger.warn?.(`[nova.help] ${providerId} identity check failed: ${error.message}`);
      return back('failed');
    }

    /* The mode was sealed in at the start and must still agree with reality: a flow begun
       signed out must not complete as a link, and a link must belong to a live session. */
    if (flow.mode === 'link' && !account) return back('failed');
    if (flow.mode === 'signin' && account) return redirect(res, '/account', { headers: spent });

    const result = await accounts.withProviderIdentity(identity, {
      currentAccountId: flow.mode === 'link' ? account.id : null,
    });

    if (!result.ok) {
      logger.warn?.(`[nova.help] ${providerId} sign-in refused: ${result.reason}`);
      if (flow.mode === 'link') {
        return back(result.reason === 'identity-on-another-account' ? 'identity-taken' : 'failed', '/account');
      }
      if (result.reason === 'email-has-account') return back('email-has-account');
      if (result.reason === 'provider-email-unverified') return back('unverified');
      return back('failed');
    }

    if (flow.mode === 'link') {
      return redirect(res, '/account?welcome=linked', { headers: spent });
    }

    /* A fresh session for the account the identity resolved to. The spent envelope and the new
       session cookie go out together. */
    const started = await accounts.startSession(result.account.id, { ttlSeconds: accounts.ttlSeconds });
    if (!started.ok) return back('failed');

    const destination = flow.next && flow.next !== '/account'
      ? flow.next
      : `/account?welcome=${result.outcome === 'created' ? 'created' : 'signed-in'}`;

    return redirect(res, destination, {
      headers: withCookie(spent, viewer.sessionCookie(started.token, { maxAge: accounts.ttlSeconds })),
    });
  });

  /**
   * Disconnect a provider.
   *
   * The service refuses when it would leave no way in; this route only has to report that,
   * because a check that lives in a template is not a check.
   */
  router.post('/account/unlink/:provider', async (req, res) => {
    const account = await viewer.current(req);
    if (!account) return redirect(res, '/account/sign-in?next=%2Faccount');

    const result = await accounts.unlinkProvider(account.id, req.params.provider);
    return redirect(res, result.ok ? '/account?welcome=unlinked' : `/account?oauth=${result.reason}`);
  });

  /** End every session on the account, then open a fresh one here so the page still works. */
  router.post('/account/sign-out-everywhere', async (req, res) => {
    const account = await viewer.current(req);
    if (!account) return redirect(res, '/account/sign-in?next=%2Faccount');

    await accounts.signOutEverywhere(account.id);
    return openSession(res, account.id, '/account', { banner: 'signed-out-everywhere' });
  });
}
