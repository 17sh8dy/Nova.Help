/**
 * The Nova Account client, as a classic script. GENERATED — DO NOT EDIT.
 *
 * Run `node packages/nova-account-client/build-global.mjs` to regenerate, and see that file
 * for why this exists: Online Earth runs on a file:// origin, where Chromium will not load a
 * module script, so it cannot import the ESM entry point that Open Cut, Replay.GG and Atlas
 * use. This is the same code, mechanically derived, and a test fails if the two drift.
 *
 * Usage:
 *
 *     <script src="nova-account/global.js"></script>
 *     const client = NovaAccountClient.createNovaAccountClient({ product: 'online-earth', ... });
 */

/* eslint-disable */
(function (root) {
  'use strict';

/**
 * The Nova Account client — the ~200 lines every Nova app needs, written once.
 *
 * Open Cut, Online Earth, Replay.GG and Atlas all have to do the same four things: start a
 * device authorization, poll for a token, keep that token somewhere, and hand it back as a
 * Bearer header. This is that, and it is a separate package from `@nova/accounts` because the
 * two have opposite jobs: that one decides who somebody is, this one only ever asks.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THE RULES IT IS BUILT AROUND — the same ones the products themselves are held to.
 *
 * 1. IT IS INERT UNTIL SOMEBODY ASKS FOR IT. Constructing a client makes no network call and
 *    reads nothing. An app that never signs in never touches this beyond `isSignedIn()`
 *    returning false, which is what lets accounts be genuinely optional rather than optional
 *    on paper.
 *
 * 2. NOTHING IS STORED THAT DOES NOT HAVE TO BE. One token, one product, one expiry. No
 *    password — the flow is built so this code never sees one — and no email address unless
 *    the product was granted `email` and asked.
 *
 * 3. STORAGE IS INJECTED. `localStorage` in a browser, a JSON file in Electron, the Tauri
 *    store in Atlas. This module has no idea and must not grow one: guessing would make it
 *    unusable in exactly one of those four, and there is no environment check that stays
 *    right. See `memoryStorage` for the shape — three methods.
 *
 * 4. A SIGN-OUT IS LOCAL EVEN IF THE SERVER CANNOT BE REACHED. Telling the server first is
 *    better, because that is what actually revokes; but an app that refuses to forget a token
 *    because the network is down is an app somebody cannot sign out of on a plane.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * USING IT
 *
 *     const nova = createNovaAccountClient({
 *       product: 'open-cut',
 *       scopes: ['sync'],
 *       storage: fileStorage(app.getPath('userData')),
 *     });
 *
 *     const flow = await nova.beginSignIn({ deviceName: os.hostname() });
 *     // show flow.userCode, open flow.verificationUriComplete in a browser
 *     const account = await flow.wait();          // resolves when they approve
 *
 * `beginSignIn` never blocks and `wait()` is cancellable, because the UI has to be able to
 * show the code and a Cancel button the moment the flow starts.
 */

/** Where the account service lives. Overridable, because it is not the same in development. */
const NOVA_ACCOUNTS_ORIGIN = 'https://nova.help';

/** Reasons a sign-in ends without a token, as an app should present them. */
const SIGN_IN_FAILURES = Object.freeze({
  expired: 'The code expired before it was approved.',
  denied: 'The request was refused.',
  cancelled: 'Sign-in was cancelled.',
  unavailable: 'Could not reach Nova Accounts.',
  refused: 'Nova Accounts refused this app.',
});

/**
 * A storage that forgets everything when the process ends.
 *
 * The DEFAULT, deliberately. A client whose storage was not configured should sign somebody
 * out at the end of the session rather than silently write a bearer token wherever this
 * module guessed — a token in an unexpected file is worse than a sign-in that did not stick.
 */
function memoryStorage() {
  let held = null;
  return {
    read: () => held,
    write: (value) => {
      held = value;
    },
    clear: () => {
      held = null;
    },
  };
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

function createNovaAccountClient({
  product,
  scopes = [],
  origin = NOVA_ACCOUNTS_ORIGIN,
  storage = memoryStorage(),
  /** Injected so a test can drive this without a socket, and Electron can use its own. */
  fetch: fetchImpl = globalThis.fetch,
  /** Injected so a test does not have to wait five real seconds per poll. */
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!product) throw new Error('A Nova Account client needs to know which product it is.');

  const base = String(origin).replace(/\/+$/, '');
  const url = (path) => `${base}${path}`;

  /** What is on disk, or null. A malformed record reads as "signed out", never as a throw. */
  function stored() {
    try {
      const raw = storage.read();
      const record = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!record?.token || record.product !== product) return null;
      /* An expiry in the past is not a session. Checked here as well as on the server so an
         offline app can say "signed out" honestly instead of only finding out on its next
         request — which for an app that starts offline is never. */
      if (record.expiresAt && record.expiresAt <= nowSeconds()) return null;
      return record;
    } catch {
      return null;
    }
  }

  function keep(record) {
    storage.write(JSON.stringify(record));
  }

  async function call(path, { method = 'GET', body, token } = {}) {
    let response;
    try {
      response = await fetchImpl(url(path), {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      /* Offline, DNS, a firewall, a captive portal. One reason, because there is exactly one
         thing an app can do about any of them, and it is not to show a stack trace. */
      return { ok: false, offline: true, status: 0, data: null, cause };
    }

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    return { ok: response.ok, offline: false, status: response.status, data };
  }

  return {
    product,

    /** True when a token is held. NO NETWORK CALL — this is asked on every render. */
    isSignedIn: () => stored() !== null,

    /**
     * Who is signed in, from the last response — no network call.
     *
     * Enough to put a name in a corner. `refresh()` is what asks the server, and an app should
     * call it at startup and then leave it alone.
     */
    account: () => stored()?.account ?? null,

    /** The scopes this token actually carries, which may be narrower than what was asked. */
    scopes: () => stored()?.scopes ?? [],

    /**
     * Check the stored token against the server, and update what is known about the account.
     *
     * Three outcomes, and the middle one is the one that is usually got wrong:
     *   `signed-in`   the token works.
     *   `offline`     no answer. THE TOKEN IS KEPT — a network failure is not a sign-out, and
     *                 an app that forgets its session on a flaky connection signs people out
     *                 for no reason.
     *   `signed-out`  the server said no. The token is dropped, because it has been revoked,
     *                 has expired, or the account is gone.
     */
    async refresh() {
      const record = stored();
      if (!record) return { state: 'signed-out' };

      const response = await call('/api/account', { token: record.token });
      if (response.offline) return { state: 'offline', account: record.account };
      if (!response.ok) {
        storage.clear();
        return { state: 'signed-out' };
      }

      keep({
        ...record,
        account: response.data.account,
        scopes: String(response.data.scope ?? '').split(' ').filter(Boolean),
      });
      return { state: 'signed-in', account: response.data.account };
    },

    /**
     * Start a sign-in. Returns immediately with the code to put on screen.
     *
     * The returned object carries `wait()`, which polls until the person approves it, and
     * `cancel()`, which stops polling. Nothing is stored until `wait()` resolves with a token,
     * so an abandoned flow leaves no trace on the machine.
     */
    async beginSignIn({ deviceName = null } = {}) {
      const started = await call('/api/device/code', {
        method: 'POST',
        body: { product, scope: scopes.join(' '), device_name: deviceName },
      });

      if (started.offline) return { ok: false, reason: 'unavailable' };
      if (!started.ok) return { ok: false, reason: started.status === 400 ? 'refused' : 'unavailable' };

      const data = started.data;
      let cancelled = false;

      return {
        ok: true,
        /** Show this. It is the whole of what a person has to carry to the other screen. */
        userCode: data.user_code,
        /** Tell them to go here. */
        verificationUri: data.verification_uri,
        /** Or open this for them, which is the same page with the code already filled in. */
        verificationUriComplete: data.verification_uri_complete,
        expiresAt: nowSeconds() + Number(data.expires_in ?? 0),
        scopes: String(data.scope ?? '').split(' ').filter(Boolean),

        cancel() {
          cancelled = true;
        },

        /**
         * Poll until it is approved, refused, or runs out.
         *
         * The interval comes from the SERVER and is doubled whenever it says `slow_down`,
         * which is what RFC 8628 asks of a client and is also just good manners: the server
         * knows how often it wants to be asked and this is how it says so.
         */
        async wait() {
          let interval = Math.max(1, Number(data.interval ?? 5)) * 1000;
          const deadline = Date.now() + Math.max(0, Number(data.expires_in ?? 600)) * 1000;

          while (!cancelled && Date.now() < deadline) {
            await sleep(interval);
            if (cancelled) break;

            const polled = await call('/api/device/token', {
              method: 'POST',
              body: {
                grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                device_code: data.device_code,
              },
            });

            /* Offline mid-flow is not a failure: the code is still valid on the server and
               the person may simply not have reconnected yet. Keep waiting until it expires. */
            if (polled.offline) continue;

            if (polled.ok) {
              const record = {
                product,
                token: polled.data.access_token,
                expiresAt: nowSeconds() + Number(polled.data.expires_in ?? 0),
                scopes: String(polled.data.scope ?? '').split(' ').filter(Boolean),
                account: polled.data.account,
              };
              keep(record);
              return { ok: true, account: record.account, scopes: record.scopes };
            }

            const error = polled.data?.error;
            if (error === 'slow_down') {
              interval *= 2;
              continue;
            }
            if (error === 'authorization_pending') continue;
            if (error === 'access_denied') return { ok: false, reason: 'denied' };
            return { ok: false, reason: 'expired' };
          }

          return { ok: false, reason: cancelled ? 'cancelled' : 'expired' };
        },
      };
    },

    /**
     * Sign out.
     *
     * The server is told first, because that is what actually revokes the session — but the
     * local token is dropped either way. An app that refuses to forget a token because the
     * network is down is an app somebody cannot sign out of on a plane.
     */
    async signOut() {
      const record = stored();
      if (record) await call('/api/device/sign-out', { method: 'POST', token: record.token });
      storage.clear();
      return { ok: true };
    },

    /* ── Sync ──────────────────────────────────────────────────────────────────────────── */

    /**
     * Read this product's document from the account.
     *
     * `{ version: 0, data: null }` means "nothing saved yet", which is the normal first
     * answer and not an error. `{ offline: true }` means the question could not be asked —
     * distinct from "there is nothing", because a caller must not treat unreachable as empty
     * and helpfully upload over it.
     */
    async pull() {
      const record = stored();
      if (!record) return { ok: false, reason: 'signed-out' };
      if (!record.scopes?.includes('sync')) return { ok: false, reason: 'no-scope' };

      const response = await call('/api/sync', { token: record.token });
      if (response.offline) return { ok: false, reason: 'offline', offline: true };
      if (!response.ok) return { ok: false, reason: 'signed-out' };
      return { ok: true, version: response.data.version, data: response.data.data, updatedAt: response.data.updatedAt };
    },

    /**
     * Write this product's document, IF `baseVersion` is still what the server holds.
     *
     * A CONFLICT IS NOT AN ERROR TO RETRY HARDER. It comes back with the server's document
     * attached, and the caller is expected to look at it — merge, or ask the person — and
     * push again against the version it just learned. There is deliberately no `force`: the
     * whole reason this API is shaped like this is that nothing may be overwritten unseen.
     */
    async push({ baseVersion, data }) {
      const record = stored();
      if (!record) return { ok: false, reason: 'signed-out' };
      if (!record.scopes?.includes('sync')) return { ok: false, reason: 'no-scope' };

      const response = await call('/api/sync', {
        method: 'PUT',
        token: record.token,
        body: { baseVersion, data },
      });

      if (response.offline) return { ok: false, reason: 'offline', offline: true };
      if (response.ok) return { ok: true, version: response.data.version, updatedAt: response.data.updatedAt };
      if (response.status === 409) {
        return { ok: false, reason: 'conflict', current: response.data.current };
      }
      if (response.status === 413) return { ok: false, reason: 'too-large' };
      if (response.status === 403) return { ok: false, reason: 'no-scope' };
      return { ok: false, reason: 'signed-out' };
    },
  };
}


/**
 * Somewhere to keep one token — the implementations that run in a BROWSER.
 *
 * They are HERE rather than in index.mjs because the client must not know which environment
 * it is in. There is no `typeof window` check that stays right across a browser page, an
 * Electron renderer, an Electron main process and a Tauri webview, and the failure mode of
 * guessing wrong is a bearer token written somewhere nobody expected.
 *
 * ⚠ NOTHING IN THIS FILE MAY IMPORT A NODE BUILTIN, and that is not a style preference — it
 * is why `fileStorage` lives in ./nodeStorage.mjs instead of here.
 *
 * Open Cut, Replay.GG and Atlas all bundle their renderer with Rollup, and a bundler pulls in
 * a whole module for one named export. One `import 'node:fs'` at the top of this file failed
 * Open Cut's production build outright — `"mkdirSync" is not exported by "node:fs"` — for a
 * function the renderer never calls. Splitting the entry points is what makes "the browser one
 * is browser-safe" a fact about the file rather than a thing to remember.
 *
 * Each one is the same three methods: `read()`, `write(string)`, `clear()`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHAT IS AND IS NOT PROTECTED HERE, said plainly rather than implied.
 *
 * A product token is a bearer credential. Anything that can read the file or the origin's
 * storage can use it until it is revoked. That is true of every desktop app's stored session,
 * and the mitigations that matter are the ones already built: the token is SCOPED (it is not
 * a password and not a web session — it cannot sign into nova.help in a browser), it is
 * REVOCABLE from the account page, and it expires.
 *
 * What would be genuinely better is the OS keychain — Credential Manager, Keychain,
 * libsecret. That is a real improvement and a real dependency in each of four different
 * runtimes, and it is deliberately not attempted here: this seam is exactly the place to add
 * it later, one product at a time, with no change to anything above.
 */

/**
 * `localStorage`, for a page.
 *
 * EVERY CALL IS GUARDED. Storage throws rather than returning null in a handful of real
 * situations — Safari's private mode, a browser set to block site data, an iframe with
 * third-party storage blocked — and a page that cannot store a token must still render. So a
 * failure here degrades to "signed out", never to a broken screen.
 */
function browserStorage(key = 'nova.account') {
  return {
    read() {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    write(value) {
      try {
        localStorage.setItem(key, value);
      } catch {
        /* Storage is full or blocked. The sign-in still worked for this session; it simply
           will not be remembered next time, which is a far better outcome than a thrown
           error out of a click handler. */
      }
    },
    clear() {
      try {
        localStorage.removeItem(key);
      } catch {
        // Nothing to be done, and nothing that a person needs to be told.
      }
    },
  };
}

/**
 * Anything with a get/set/remove pair of async functions — the Tauri store plugin, or an
 * Electron renderer talking to its main process over IPC.
 *
 * The client's storage contract is synchronous, so this keeps a cached copy in memory and
 * writes THROUGH to the real store. `prime()` is what fills the cache at startup; until it
 * has run the app is simply signed out, which is the correct thing for an app that has not
 * yet finished starting to believe.
 */
function asyncStorage({ get, set, remove }, { key = 'nova.account' } = {}) {
  let cached = null;

  return {
    /** Load the persisted value into the cache. Call once, before the first render. */
    async prime() {
      try {
        cached = (await get(key)) ?? null;
      } catch {
        cached = null;
      }
      return cached;
    },
    read: () => cached,
    write(value) {
      cached = value;
      Promise.resolve(set(key, value)).catch(() => {
        /* The token is live in this session either way. A failure to persist means signing in
           again next launch, which is worth no interruption now. */
      });
    },
    clear() {
      cached = null;
      Promise.resolve(remove(key)).catch(() => {});
    },
  };
}


  root.NovaAccountClient = { createNovaAccountClient, memoryStorage, browserStorage, asyncStorage, NOVA_ACCOUNTS_ORIGIN, SIGN_IN_FAILURES };
})(typeof window !== 'undefined' ? window : globalThis);
