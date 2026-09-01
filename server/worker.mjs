/**
 * The Cloudflare entry point: bindings in, a Response out.
 *
 * This is the counterpart of server/index.mjs, which binds a port. Everything between the two
 * is shared — the same router, the same services, the same pages — because the only things
 * that genuinely differ between a Node process and a Worker are where the bytes are kept and
 * what a request object looks like. Both are handled here and nowhere else.
 *
 *   env.DB                D1 database (tickets, events, accounts, sessions, identities)
 *   env.ATTACHMENTS       R2 bucket (the uploaded bytes)
 *   env.ASSETS            static assets from public/
 *   env.RATE_LIMITER      Durable Object namespace, one object per limiter per key
 *   env.NOVA_HELP_SECRET  the application signing key — a secret, not a var
 *   env.NOVA_HELP_ORIGIN  public origin, for building OAuth redirect URIs
 *   env.NOVA_GOOGLE_CLIENT_ID / env.NOVA_GOOGLE_SECRET   optional; both or neither
 *
 * WHY THE APP IS BUILT PER ISOLATE AND NOT PER REQUEST. Constructing it validates the catalog
 * and builds the router, which is work that does not depend on the request. It is cached in a
 * module-scope promise, so the first request in an isolate pays for it and the rest do not.
 * Nothing about a REQUEST is cached — the stores hold no documents and there is no index in
 * memory to go stale, which is exactly what made the JSON stores unable to run here.
 *
 * PASSWORD HASHING WORKS HERE, WHICH WAS NOT THE EXPECTATION. `node:crypto`'s scrypt is
 * available under nodejs_compat, and registration and sign-in were both driven end to end
 * against `wrangler dev` at the full production cost — the stored records say
 * `scrypt$N=131072,r=8,p=1`, a wrong password is refused, and no PBKDF2 fallback was needed.
 * It is worth being precise about what that does and does not establish: N=2^17, r=8 needs
 * 128 MiB, which IS an isolate's entire memory limit, and a derivation costs roughly a fifth
 * of a second of CPU. Local workerd does not enforce the CPU and memory ceilings the way the
 * deployed platform does, so this has to be measured again on a real Worker before it serves
 * anybody. It is a thing to verify, not a thing to fix.
 *
 * RATE LIMITING IS DONE, and is a Durable Object rather than the Cloudflare rate-limiting
 * binding. The binding cannot express these windows at all — `simple.period` must be 10 or 60
 * seconds and every window here is between ten minutes and an hour — and it returns only
 * `{ success }`, with no retry-after and no way to reset a key. Both were confirmed by running
 * it, not by reading about it. The full reasoning is at the top of rateLimiterObject.mjs.
 */
import { createApp } from './app.mjs';
import { createD1TicketStore } from './store/d1Store.mjs';
import { createD1AccountStore } from '@nova/accounts/d1Store';
import { createR2AttachmentStore } from './store/r2Attachments.mjs';
import { createDurableRateLimiter } from './lib/doRateLimit.mjs';

/* Wrangler needs the Durable Object class exported from the entry point to bind it. */
export { RateLimiterObject } from './rateLimiterObject.mjs';

/**
 * A Fetch Request, wearing enough of Node's IncomingMessage for the router to read it.
 *
 * lib/body.mjs listens for 'data', 'end', 'aborted' and 'error' and may call `destroy()` to
 * cut off an oversized upload mid-flight; lib/http.mjs reads `headers`, and `socket` for the
 * client address. That is the whole surface, which is why this adapter is short enough to
 * trust rather than a shim with its own behaviour.
 */
function toNodeRequest(request, url) {
  const headers = {};
  for (const [name, value] of request.headers) headers[name.toLowerCase()] = value;

  const listeners = new Map();
  const emit = (event, value) => {
    for (const listener of listeners.get(event) ?? []) listener(value);
  };

  let cancelled = false;
  let flowing = false;

  /**
   * Read the body and emit it.
   *
   * NOT STARTED UNTIL SOMEBODY IS LISTENING, which is the whole subtlety of this adapter. A
   * Node request is a paused stream: it buffers until a handler attaches, and attaching late
   * costs nothing. An emitter is the opposite — anything emitted before `on('data')` is simply
   * gone, and lib/body.mjs would then wait for an 'end' that had already happened and the
   * request would hang until the runtime killed it.
   *
   * Pumping eagerly happened to work while requests arrived one at a time, because the reader's
   * first `read()` yielded for long enough that the route attached first. Under concurrency
   * that ordering stops holding, and it fails for five requests out of six. Starting on demand
   * removes the race rather than widening the window.
   */
  const start = () => {
    if (flowing) return;
    flowing = true;

    /* A microtask later, so every `on()` in the caller's synchronous run has landed — body.mjs
       registers 'data' first and 'end' immediately after, and both must be in place. */
    queueMicrotask(async () => {
      if (!request.body) {
        emit('end');
        return;
      }
      const reader = request.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (cancelled) {
            await reader.cancel().catch(() => {});
            emit('aborted');
            return;
          }
          emit('data', Buffer.from(value));
        }
        if (!cancelled) emit('end');
      } catch (error) {
        emit('error', error);
      }
    });
  };

  const req = {
    method: request.method,
    url: url.pathname + url.search,
    headers,
    /* Cloudflare puts the real client address here; `trustProxy` decides whether the app reads
       x-forwarded-for instead, and on Workers that header is set by the edge, not the client. */
    socket: { remoteAddress: request.headers.get('cf-connecting-ip') ?? null },

    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(listener);
      // Attaching a body listener is what puts the stream into flowing mode, as it is in Node.
      if (event === 'data' || event === 'end') start();
      return req;
    },

    /** Stop reading. The body cap in lib/body.mjs calls this on an oversized upload. */
    destroy() {
      cancelled = true;
    },
  };

  return req;
}

/** A Node-ish ServerResponse that resolves to a Response instead of writing to a socket. */
function createNodeResponse() {
  let resolve;
  const finished = new Promise((r) => {
    resolve = r;
  });

  const chunks = [];
  let status = 200;
  const headers = new Headers();

  const res = {
    headersSent: false,

    writeHead(code, raw = {}) {
      status = code;
      for (const [name, value] of Object.entries(raw)) {
        if (value === undefined || value === null) continue;
        /* set-cookie is the one header that legitimately repeats, and Headers.set would
           collapse two cookies into one. The app sets at most one per response today; append
           keeps that from becoming a silent limit. */
        if (Array.isArray(value)) for (const item of value) headers.append(name, String(item));
        else if (name.toLowerCase() === 'set-cookie') headers.append(name, String(value));
        else headers.set(name, String(value));
      }
      res.headersSent = true;
      return res;
    },

    write(chunk) {
      if (chunk) chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
      return true;
    },

    end(chunk) {
      if (chunk) res.write(chunk);
      const total = chunks.reduce((sum, part) => sum + part.length, 0);
      const body = new Uint8Array(total);
      let at = 0;
      for (const part of chunks) {
        body.set(part, at);
        at += part.length;
      }
      /* 204 and 304 must not carry a body, and constructing a Response with one throws. */
      const bodyless = status === 204 || status === 304;
      resolve(new Response(bodyless || !total ? null : body, { status, headers }));
      return res;
    },

    /* The app destroys a response only when a failure arrives after headers have gone out. On
       a socket that truncates the stream; here the honest equivalent is what has been written
       so far, which the client will find short against its content-length. */
    destroy() {
      res.end();
    },
  };

  return { res, finished };
}

let cached = null;

function build(env) {
  if (cached) return cached;

  if (!env.NOVA_HELP_SECRET || String(env.NOVA_HELP_SECRET).length < 16) {
    throw new Error('NOVA_HELP_SECRET must be set to at least 16 characters. Use `wrangler secret put`.');
  }

  cached = createApp({
    dev: false,
    /* Cloudflare terminates TLS and sets cf-connecting-ip itself, so the forwarded headers on
       a request that reached a Worker are the edge's, not a client's. */
    trustProxy: true,
    secureCookies: true,
    origin: env.NOVA_HELP_ORIGIN ?? null,
    signingSecret: env.NOVA_HELP_SECRET,
    stores: {
      tickets: createD1TicketStore({ db: env.DB }),
      accounts: createD1AccountStore({ db: env.DB }),
      attachments: createR2AttachmentStore({ bucket: env.ATTACHMENTS }),
    },
    /* Assets are answered before the router by `fetch` below, so by the time a request gets
       here it is not one. Returning false hands every path to the router. */
    staticHandler: async () => false,
    /* One Durable Object per limiter per key. The in-memory limiter would count per isolate
       here, which is to say not at all; see rateLimiterObject.mjs for why the Cloudflare
       rate-limiting binding could not do this job. The limits themselves stay in app.mjs. */
    createLimiter: ({ name, windowMs, max }) =>
      createDurableRateLimiter({ namespace: env.RATE_LIMITER, name, windowMs, max }),
    oauth:
      env.NOVA_GOOGLE_CLIENT_ID && env.NOVA_GOOGLE_SECRET
        ? { google: { clientId: env.NOVA_GOOGLE_CLIENT_ID, clientSecret: env.NOVA_GOOGLE_SECRET } }
        : {},
  }).catch((error) => {
    // A build that failed must not be cached, or every later request inherits the failure.
    cached = null;
    throw error;
  });

  return cached;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    /* Static first, and only for safe methods, so a POST to an asset path reaches the router
       and gets the 405 the router would give it rather than a silent 200. */
    if (env.ASSETS && (request.method === 'GET' || request.method === 'HEAD')) {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) return asset;
    }

    const app = await build(env);
    const req = toNodeRequest(request, url);
    const { res, finished } = createNodeResponse();

    /* No pump to kick off here: the request starts reading itself when a handler listens. */
    app.handle(req, res).catch((error) => {
      console.error('[nova.help] unhandled', error);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Internal error');
    });

    return finished;
  },
};
