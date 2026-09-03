# One Nova Account, in every Nova product

**Status: the wire protocol is decided and built.** Nova and Nova.Help sign in with a cookie at
their own origin; Open Cut, Online Earth, Replay.GG and Atlas sign in with the **device
authorization grant** and hold a scoped product token.

`docs/NOVA-ACCOUNTS.md` §1 listed the wire protocol as deliberately undecided, to be settled
"with a real second product's needs in front of you." There are now four. This document is that
decision and the reasoning behind it.

---

## 1. The decision

> **Installed Nova products sign in with the OAuth 2.0 Device Authorization Grant (RFC 8628)
> against Nova.Help, and receive a scoped, revocable product token. They never see a password
> and never receive a session cookie.**

### Why this flow

The four products that needed it have one shape in common, and it decides the answer:

| | Open Cut | Online Earth | Replay.GG | Atlas |
|---|---|---|---|---|
| Runtime | Electron | website **and** Electron | Electron | Tauri 2 |
| Can keep a client secret? | no | no | no | no |
| Can bind a loopback port? | yes | **no** (it is a web page) | yes | only via Rust |
| Renderer may reach the network? | yes | yes | **no** (CSP) | only via CSP allow-list |

- **No confidential client.** They are installed on other people's machines, so anything
  compiled in is public. That rules out every flow with a client secret.
- **No password box in a desktop app.** Teaching people to type their Nova password into
  desktop applications is teaching them the exact habit that gets them phished.
- **A loopback redirect (RFC 8252)** works for the three Electron apps, needs Rust work and a
  bound port for Atlas, and is *impossible* for Online Earth as a plain web page.

The device grant is the only flow that is identical in all four — plus a browser, plus whatever
arrives next — and needs no listener, no registered redirect URI and no secret.

### What is still deliberately not decided

- **Refresh tokens.** A product token lasts 180 days and re-authorising is the device flow
  again. A refresh endpoint is a small addition when something needs it.
- **A separate account service.** Nova Accounts is still a package two front doors embed. A
  desktop product talks to Nova.Help over HTTP, which is exactly the shape a standalone service
  would have — so that move stays a deployment change.
- **Entitlements and purchases.** Still the Store's and the Launcher's problem, and still a
  different system that *uses* identity rather than being part of it.

---

## 2. The shape of it

```
  Open Cut · Online Earth · Replay.GG · Atlas          a browser
              │                                            │
              │ 1. POST /api/device/code                    │
              │    { product, scope }                       │
              │ ← user_code KDMX-7QRT                       │
              │                                             │
              │         "go to nova.help/account/device"    │
              │         ──────────────────────────────────► │
              │                                    2. signs in,
              │                                       types the code,
              │                                       reads what the app
              │                                       will be able to do,
              │                                       presses Connect
              │ 3. POST /api/device/token                   │
              │    { device_code }                          │
              │ ← access_token (scoped, revocable)          │
              ▼
      Authorization: Bearer …    →   GET /api/account
                                     GET|PUT /api/sync
```

**The app never touches step 2**, which is the entire point. The password, the second factor
when there is one, and the decision all happen in a browser at nova.help.

### Endpoints

| Route | |
|---|---|
| `POST /api/device/code` | start a flow. Returns `user_code`, `device_code`, `verification_uri`, `interval` |
| `POST /api/device/token` | poll. `authorization_pending` / `slow_down` / `expired_token` / `access_denied`, or a token |
| `GET /api/account` | who am I — the scoped view. Also how an app learns it was signed out |
| `POST /api/device/sign-out` | the app revokes its own session |
| `GET /api/sync` | this product's document for this account |
| `PUT /api/sync` | store it, if `baseVersion` is current. **409 with the server's copy otherwise** |
| `GET/POST /account/device` | the human half: enter a code, read what it grants, approve or refuse |
| `POST /account/devices/revoke` | sign one connected app out, from the account page |

---

## 3. Scopes — "only what it needs", made enforceable

`packages/nova-accounts/products.mjs` is the registry. A product may not request a scope it is
not registered for; the request is **intersected** with the registry rather than rejected, so a
product whose author got the list slightly wrong is still usable and still cannot exceed it.

| Scope | What it opens |
|---|---|
| `identity` | account id and display name. Always granted — a token that cannot name its owner is not an identity |
| `email` | the address on the account |
| `support` | file and follow Nova.Help tickets as this account |
| `sync` | read and write **this product's** sync document, and no other's |

| Product | Kind | Registered for |
|---|---|---|
| Nova | web | `email` |
| Nova.Help | web | `email`, `support` |
| Open Cut | device | `support`, `sync` |
| Online Earth | device | `support`, `sync` |
| Replay.GG | device | `support` |
| Atlas | device | `support`, `sync` |

**No installed product is registered for `email`.** None of them needs an address to put a name
in a corner, so none of them gets one. Adding a product is one entry in that file.

`kind` is load-bearing: a `web` product is **refused** by `startDeviceAuthorization`, so a page
cannot mint itself a bearer token that outlives its own session.

---

## 4. The security properties, and why each one is there

**The product token is signed under a different key than a web session.**
`HMAC(secret, "nova.accounts.product.v1")` versus `…session.v1`. So a token that leaks out of a
desktop app's config file **cannot be pasted into a browser cookie and used to log in as that
person**, and a stolen browser cookie cannot be replayed as a Bearer token. Without this split
the two are the same string and every scope restriction below it is decoration. Both directions
are tested.

**Device sessions live in the same session list as browser sessions.** So "sign out
everywhere" reaches installed apps, and a password reset does too. That is what makes "I lost
my laptop" answerable, and it comes free rather than needing a second revocation path to
remember about.

**Approval is an act, on a page that names the product and the scopes in sentences.** Never a
GET, never automatic, never inferred from holding the code. The account for the approval comes
from the *session*, never from the form — a hidden field naming an account would be a way to
aim somebody else's approval.

**A grant is redeemed exactly once, atomically.** Two pollers arriving together cannot both
walk away with a token for one approval. Enforced in the store (a guarded `DELETE` on D1, a
lock on the JSON store), not by a caller that read the row a moment ago.

**The user code is low entropy and everything else carries it.** Eight Crockford characters is
plenty against a person and nothing against a script, so: ten-minute expiry, a rate limiter on
every code *typed* (15 per 15 minutes per source — the tightest of the three), single use, and
— the one that matters — **guessing a code wins nothing**, because approving is an action a
signed-in person takes and what comes back to the guesser is a page, not a token. The token only
ever reaches whoever holds the 32-byte `device_code`.

**Unknown and expired are the same answer.** Polling with a device code nobody minted returns
`expired_token`, exactly like a lapsed one, so polling is not a way to enumerate live codes.

**`Cache-Control: no-store` on every JSON response.** One of them contains a bearer token, and
which one is not a thing to leave to a shared proxy's judgement.

**What is NOT protected:** a product token is a bearer credential in a file on the user's
machine. Anything that can read that file can use it until it is revoked. The mitigations are
that it is *scoped*, *revocable from the account page*, and *not a password*. The OS keychain
would be genuinely better and is a real dependency in each of four runtimes;
`@nova/account-client/storage` is the seam to add it behind, one product at a time.

---

## 5. Sync, and the rule that protects local data

`PUT /api/sync` is **conditional**. The client sends the version it based its edit on; if the
server has moved on, the write is **refused** and the server's document comes back with the
refusal so the client can merge. There is deliberately no unconditional write and no `force`.

`baseVersion: 0` means "I have never synced" and is **not a wildcard** — it succeeds only when
the server genuinely has nothing. That single rule is what stops a freshly installed second
machine from flattening a year of settings by pushing first, and it is the assertion in the
suite that must never be softened.

**Nothing syncs automatically anywhere.** Every product treats it as a button:

| Product | Sync today |
|---|---|
| Open Cut | scope granted; the pane says plainly that automatic sync is not implemented |
| Online Earth | **implemented as explicit Back up / Restore.** Restore *merges* by default; replacing is a separate action behind a confirmation |
| Replay.GG | not requested. Recordings are files on a disk and nothing uploads them |
| Atlas | scope granted, **deliberately unused** — an assistant's memory is not something to start uploading because the plumbing exists |

---

## 6. The client — one implementation, two builds

`packages/nova-account-client` is what all four products use. Zero dependencies, and it holds
the behaviours that are easy to get wrong once per product:

- **Offline is not a sign-out.** A failed request keeps the token. An app that forgets its
  session on a flaky connection signs people out on trains for no reason.
- **Offline is distinguishable from empty.** `pull()` returns `offline`, never "nothing saved",
  so no client concludes the account is blank and helpfully uploads over a real backup.
- **A sign-out is local even when the server cannot be told**, so nobody is stuck signed in on
  a plane.
- **Constructing a client makes no network call and reads nothing.** That is what lets accounts
  be genuinely optional rather than optional on paper.

It ships two builds from one source:

| | Used by | Why |
|---|---|---|
| `index.mjs` (ESM) | Open Cut, Replay.GG, Atlas | bundled normally |
| `global.js` (classic script) | Online Earth | its shell opens the page with `loadFile`, and Chromium will not load `<script type="module">` from a `file://` origin |

`global.js` is **generated** by `build-global.mjs` and `test/accountClientGlobal.test.mjs`
regenerates it and fails if the checked-in copy differs by a byte. That is the difference
between "derived" and "copied and drifting."

`storage.mjs` (browser) and `nodeStorage.mjs` (Node) are separate entry points because they must
be: one `import 'node:fs'` beside `browserStorage` failed Open Cut's production build outright,
for a function its renderer never calls.

---

## 7. Integrating the next product

1. **Add it to `packages/nova-accounts/products.mjs`** — id, name, `kind: 'device'`, and the
   shortest scope list that does the job. Ask for less than you are allowed; asking for more is
   refused anyway.
2. **Add it to `data/ecosystem.js`** so it appears in Nova.Help's footer directory, and give it
   a support catalog in `data/projects/` if it does not have one. `npm run check` fails if the
   two do not line up.
3. **Depend on `@nova/account-client`** and pick a storage: `browserStorage` in a renderer,
   `fileStorage` in a Node/Electron main process, `asyncStorage` over an async store like
   Tauri's.
4. **Put the surface somewhere optional.** Every existing integration puts it at the *bottom* of
   a settings list, never the top, and every one leads with the sentence that the product works
   without it. That is not decoration; it is the difference between an optional layer and a gate.
5. **Do not gate anything on it.** If you are here to make a feature require sign-in, the answer
   is no — extend what an account *adds*.

### The cross-repository dependency

The three desktop products depend on the client by path
(`file:../NovaHelp/packages/nova-account-client`). That is fine for them — they build locally —
but it is the same open structural item `docs/NOVA-IDENTITY.md` records for the Nova site,
whose Cloudflare Pages build cannot reach outside its own repository. **Publishing both packages,
or making the repos one workspace, closes it for everybody at once.**

---

## 8. Tests

`npm test` in `D:\Dev\NovaHelp` — **624**, up from 519.

- `test/helpers/accountStoreContract.mjs` (+30 per store, ×2) — the device-grant state machine
  and the sync-document version check, run against **both** the JSON store and D1, because the
  two implementations share nothing but this contract.
- `test/deviceGrant.test.mjs` (27) — the whole flow driven for real, with an app client that
  never holds a cookie and a browser client that never holds a token. Including: a product token
  refused as a cookie, a cookie refused as a product token, a web product refused the flow, one
  product unable to read another's sync document, and a fresh install unable to flatten an
  existing backup.
- `test/accountClient.test.mjs` (15) — the shared client against a running server, including
  offline-is-not-a-sign-out and the conflict-then-merge path.
- `test/accountClientGlobal.test.mjs` (4) — the classic build is byte-identical to what the
  generator produces, and behaves the same against a real server.
- `test/ecosystem.test.mjs` (9) — every directory entry links somewhere that resolves, no URL is
  invented, and the Discord link is on every page.

`D:\Dev\Nova` — **36**, up from 31, adding the site's outbound links and the corrected footer
note.
