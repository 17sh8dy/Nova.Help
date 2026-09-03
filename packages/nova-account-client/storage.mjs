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
export function browserStorage(key = 'nova.account') {
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
export function asyncStorage({ get, set, remove }, { key = 'nova.account' } = {}) {
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
