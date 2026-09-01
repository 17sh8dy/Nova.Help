/**
 * Application assembly.
 *
 * Everything is constructed here and passed down; nothing reaches for a global. That is what
 * makes the test suite able to stand a whole portal up against a temporary directory in three
 * lines, and what makes swapping the file store for a database a change to one call.
 *
 * The request handler is the only place that catches: a route that throws produces a logged
 * error and a 500 page, never a hung connection or a stack trace on screen.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertValid } from './core/catalog.mjs';
import { createTicketService } from './core/tickets.mjs';
import { createAttachmentStore } from './core/attachments.mjs';
import { createFileStore } from './store/fileStore.mjs';
import { createAccess, loadSecret } from './lib/access.mjs';
import { createAccounts, createLogMailer } from '@nova/accounts';
import { createGoogleProvider } from '@nova/accounts/providers/google';
import { createViewer } from './lib/viewer.mjs';
import { createRateLimiter } from './lib/rateLimit.mjs';
import { createRouter } from './lib/router.mjs';
import { createStaticHandler } from './lib/static.mjs';
import { baseHeaders, sendHtml, sendJson } from './lib/http.mjs';
import { registerRoutes } from './routes.mjs';
import { registerAccountRoutes } from './accountRoutes.mjs';
import { registerApi } from './api/index.mjs';
import { errorPage, notFoundPage } from './views/pages/status.mjs';

/**
 * Where the repository is, for the default data and asset directories.
 *
 * Guarded because a bundled Worker has no `import.meta.url` to resolve and no filesystem for
 * the answer to point at. On Cloudflare both defaults are overridden — stores are injected and
 * assets come from a binding — so the value is never used there; it only has to not throw
 * while the module is being evaluated.
 */
const repoRoot = import.meta.url ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') : '/';

export async function createApp({
  dataDir = path.join(repoRoot, 'var'),
  publicDir = path.join(repoRoot, 'public'),
  dev = false,
  trustProxy = false,
  secureCookies = !dev,
  logger = console,
  /* The scrypt setting for new passwords. Overridden only by the test suite, which would
     otherwise spend most of its runtime deliberately burning CPU. */
  passwordCost,
  /**
   * The public origin, used to build OAuth redirect URIs. When unset, each request infers one
   * from its own Host header — fine in development, and harmless in production because a
   * spoofed Host produces a redirect_uri the provider has not been told to accept, so the
   * flow fails at the provider instead of going anywhere unexpected. Set it anyway.
   */
  origin = null,
  /**
   * Federated sign-in, e.g. `{ google: { clientId, clientSecret } }`. Omit it and Nova.Help
   * runs exactly as before with email and password only — no buttons, no routes taking effect.
   */
  oauth = {},
  /**
   * Where things are stored. Omitted, Nova.Help runs on JSON files under `dataDir` exactly as
   * it always has — that is still the default, and it is what `npm start` and the test suite
   * use.
   *
   * Passing `{ tickets, attachments, accounts }` swaps in another set of stores; on Cloudflare
   * that is D1 and R2, built by the Worker entry point from its bindings. The choice is made
   * by the caller rather than by a flag read in here, so this function has no branch on which
   * infrastructure it is running against and the two paths cannot drift apart behind one.
   */
  stores = null,
  /**
   * The application signing key. Left unset, it is read from NOVA_HELP_SECRET or from
   * var/secret exactly as before; the Worker supplies it directly because it has neither a
   * file to read nor a process lifetime in which generating one would mean anything.
   */
  signingSecret = null,
  /**
   * `(req, res, pathname) => boolean` — serve a static asset, or answer false to let the
   * router have the request. Omitted, files are read from `publicDir` as they always were.
   */
  staticHandler = null,
  /**
   * How to build one rate limiter: `({ name, windowMs, max }) => ({ hit, clear })`.
   *
   * Omitted, it is the in-memory limiter this has always used — which is honest for one Node
   * process and useless in a Worker, where "in memory" means per isolate and a limit of ten
   * becomes ten per isolate. The Worker passes a factory backed by a Durable Object per key.
   *
   * Only the IMPLEMENTATION is injected; the windows and maximums stay below, so there is one
   * table of limits for every deployment.
   */
  createLimiter = ({ windowMs, max }) => createRateLimiter({ windowMs, max }),
  /**
   * How password-reset mail leaves the building: `{ send({ to, subject, text }) }`.
   *
   * Omitted in development, the log transport prints the message — including the reset link —
   * so the flow can be walked on a machine with no mail. Omitted in production there is NO
   * transport, and the reset flow accepts requests and sends nothing; that is announced at
   * boot rather than discovered later. See server/accounts/mail.mjs.
   */
  mailer = null,
  /**
   * The Domain to scope the session cookie to, e.g. `.nova.xyz`.
   *
   * This is the whole of single-sign-on across the Nova ecosystem: with every product on one
   * registrable domain, a session opened at nova.xyz is presented to help.nova.xyz too, and
   * one Nova Account means one sign-in. Unset — the default — the cookie is host-only and
   * each front door keeps its own session against the same shared account.
   *
   * It cannot bridge nova.help and nova.xyz: a browser refuses a Domain its host is not under.
   */
  cookieDomain = null,
} = {}) {
  // A broken catalog must stop the process, not produce a portal with missing categories.
  assertValid();

  const store = stores?.tickets ?? createFileStore({ dir: dataDir });
  const loaded = await store.init();

  const attachments = stores?.attachments ?? createAttachmentStore({ dir: dataDir });
  const tickets = createTicketService({ store, attachments });

  /* On Cloudflare there is no filesystem to keep a key in and no process to generate one for,
     so the Worker passes its secret binding straight in. Everywhere else this is unchanged. */
  const { secret, generated } = signingSecret
    ? { secret: signingSecret, generated: false }
    : loadSecret({ dir: dataDir });
  if (generated) {
    logger.warn?.(
      '[nova.help] Generated a signing key in var/secret. Set NOVA_HELP_SECRET before running more than one process.',
    );
  }
  const access = createAccess({ secret });

  /* Nova Accounts. The session key is derived from the same application secret, so a
     deployment still configures exactly one. See server/accounts/index.mjs. */
  /* A provider is built only when it is fully configured. Half a client credential is a
     misconfiguration, and a sign-in button that leads to an error page is worse than no
     button, so it is logged loudly and then ignored. */
  const providers = [];
  for (const [id, factory] of [['google', createGoogleProvider]]) {
    const settings = oauth?.[id];
    if (!settings) continue;
    if (!settings.clientId || !settings.clientSecret) {
      logger.warn?.(`[nova.help] ${id} sign-in is half-configured (needs a client id AND secret). Ignoring it.`);
      continue;
    }
    providers.push(factory(settings));
  }

  /* Password reset needs a way to send mail, and this deployment may not have one.
     ⚠ WITHOUT A TRANSPORT THE RESET FLOW CANNOT COMPLETE. It fails safely — every page says
     the same neutral thing it says for an address with no account, so nothing is disclosed —
     but no link reaches anybody. That is worth one loud line at boot rather than a support
     ticket about support. In development the log transport prints the link to the console,
     which is the only way to walk the flow on a machine with no mail; it is refused in
     production, where printing reset links into a log file is its own incident. */
  const transport = mailer ?? (dev ? createLogMailer({ logger }) : null);
  if (!transport) {
    logger.warn?.(
      '[nova.help] No mail transport configured: password reset will accept requests and send nothing. ' +
        'See docs/PASSWORD-RESET.md.',
    );
  }

  const accounts = await createAccounts({
    dir: dataDir,
    secret,
    product: 'nova.help',
    productName: 'Nova',
    supportUrl: origin ? `${origin.replace(/\/+$/, '')}/` : null,
    providers,
    logger,
    ...(transport ? { mailer: transport } : {}),
    ...(stores?.accounts ? { store: stores.accounts } : {}),
    ...(passwordCost ? { cost: passwordCost } : {}),
  });

  /* THE LIMITS LIVE HERE AND NOWHERE ELSE, whichever limiter is enforcing them. `createLimiter`
     swaps the implementation — a Map in this process, or a Durable Object per key on
     Cloudflare — and is handed the same window and maximum either way, so there is never a
     second table of numbers to keep in step with this one. */
  const limiter = (name, windowMs, max) => createLimiter({ name, windowMs, max });

  const limiters = {
    // Enough for a person having a bad day; not enough to flood a queue.
    create: limiter('create', 60 * 60 * 1000, 10),
    // A ticket id is unguessable; this stops an address being tested against many ids.
    lookup: limiter('lookup', 15 * 60 * 1000, 12),
    reply: limiter('reply', 10 * 60 * 1000, 20),
    // Password guessing is the attack these two exist for. Sign-in is counted per address as
    // well as per source, so one address cannot be pounded from many places, and a shared
    // office address is not locked out by one person's typo.
    signIn: limiter('signIn', 15 * 60 * 1000, 10),
    signInEmail: limiter('signInEmail', 15 * 60 * 1000, 10),
    register: limiter('register', 60 * 60 * 1000, 5),
    /* Forgotten passwords, counted per source and per address. Tighter than sign-in because a
       request costs us an outbound mail and costs the person named in it an interruption —
       this is as much a limit on using the form to pester somebody as on guessing. */
    passwordReset: limiter('passwordReset', 60 * 60 * 1000, 6),
    passwordResetEmail: limiter('passwordResetEmail', 60 * 60 * 1000, 4),
    /* Starting a federated flow is cheap for us and costs the provider a request, so this is
       a courtesy limit rather than a defence; the callback is the one that matters, and it is
       already gated by a state cookie this server had to have set. */
    oauth: limiter('oauth', 15 * 60 * 1000, 30),
  };

  const config = { dev, trustProxy, secureCookies, origin, cookieDomain };
  const viewer = createViewer({ accounts, access, config });
  const ctx = { tickets, attachments, store, access, accounts, viewer, limiters, config, logger };

  const router = createRouter();
  registerRoutes(router, ctx);
  registerAccountRoutes(router, ctx);
  registerApi(router, ctx);

  /* On Cloudflare the assets are served by a binding before a request ever reaches the router,
     and there is no filesystem for the default handler to read from. Passing one in is how the
     Worker replaces it; everywhere else this is the same handler it has always been. */
  const serveStatic = staticHandler ?? createStaticHandler({ root: path.resolve(publicDir), cache: !dev });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const isApi = pathname.startsWith('/api/');

    try {
      if ((req.method === 'GET' || req.method === 'HEAD') && (await serveStatic(req, res, pathname))) return;

      const match = router.match(req.method === 'HEAD' ? 'GET' : req.method, pathname);

      if (!match) {
        return isApi
          ? sendJson(res, { error: 'Not found.' }, { status: 404 })
          : sendHtml(res, notFoundPage(), { status: 404 });
      }
      if (!match.handler) {
        const headers = { allow: match.allowed.join(', ') };
        return isApi
          ? sendJson(res, { error: 'Method not allowed.' }, { status: 405, headers })
          : sendHtml(res, notFoundPage({ what: 'That address' }), { status: 405, headers });
      }

      req.params = match.params;
      await match.handler(req, res);
    } catch (error) {
      // The reference is logged next to the stack and shown to the reporter, so a support
      // ticket about this page can be tied to the exact failure.
      const reference = randomUUID().slice(0, 8);
      logger.error?.(`[nova.help] ${reference} ${req.method} ${pathname}`, error);

      if (res.headersSent) {
        res.destroy();
        return;
      }
      return isApi
        ? sendJson(res, { error: 'Internal error.', reference }, { status: 500 })
        : sendHtml(res, errorPage({ reference }), { status: 500 });
    }
  }

  return { handle, ctx, loaded, accounts: accounts.loaded, baseHeaders };
}
