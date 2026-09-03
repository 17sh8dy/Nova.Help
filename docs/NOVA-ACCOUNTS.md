# Nova Accounts

**One Nova Account, for the whole Nova ecosystem.**

Status as of 2026-09-01: the foundation is built and **six products use it** — Nova and
Nova.Help at their own origins, and Open Cut, Online Earth, Replay.GG and Atlas through the
device authorization grant.

> **⚠ The wire protocol below is no longer open. It was decided and built on 2026-09-01 —
> see [NOVA-PRODUCTS.md](./NOVA-PRODUCTS.md), which supersedes §1's "deliberately NOT decided"
> list on that point.** Everything else in this document — the account model, passwords,
> sessions, the linking rules, and §4 — is unchanged and still governs.

---

## 1. The decision

Nova is becoming a group of products rather than one program. Nova.Help, the Launcher, the
Store, Online Earth, Atlas, Open Cut, Nova Engine and Replay.GG are all going to want to know
who somebody is, sooner or later.

There are two ways that goes:

- **Eight logins.** Each product grows its own when it needs one. Eight password stores, eight
  session formats, eight sets of security decisions, and a person who has to make an account
  for every Nova thing they touch. Merging them afterwards is a migration per product plus a
  reconciliation nobody can do correctly, because there is no way to prove that
  `you@example.com` in Open Cut is the same person as `you@example.com` in the Store.
- **One account.** One identity system, and every product is a client of it.

**Nova has chosen one account.** This document is the record of that decision and the rules
that keep it true.

### The rules

1. **Nova Account is the shared identity system for the Nova ecosystem.** One account, one
   password, one set of security decisions, used by every Nova product that needs to know who
   somebody is.
2. **Nova.Help is the first product to integrate it.** It is deliberately first: it is small,
   it is public-facing, and it has a real reason to want an identity (support history) without
   needing anything complicated (no purchases, no entitlements, no devices).
3. **Other Nova products should eventually use this same system.** Not a copy of it, not one
   inspired by it — this one.
4. **Do not create a separate authentication system for an individual Nova product.** If a
   product needs sign-in, it gets it from Nova Accounts. If Nova Accounts cannot yet do what
   the product needs, the answer is to extend Nova Accounts, not to route around it.
5. **Future integrations use the centralised system.** New product, same account.
6. **Nova Launcher will eventually matter most here.** The Launcher is the one place that sits
   in front of games, purchases, updates, support and the rest at once, so it is the natural
   holder of account context for the desktop: sign in to the Launcher, and everything it
   launches or links to already knows who you are. That makes the Launcher the integration
   that most repays doing properly, and the one most worth designing the eventual token
   exchange around.

### What is deliberately NOT decided yet

Nothing about this is a licence to build the whole ecosystem's identity layer now. The
following are open, and should stay open until a second product actually needs them:

- ~~The wire protocol between products and the account service.~~ **DECIDED 2026-09-01:** the
  OAuth 2.0 Device Authorization Grant (RFC 8628) for installed products, plus a scoped,
  revocable product token signed under a key that is not the session key. It was decided the
  way this section asked for — with four real products in front of it, which between them ruled
  out every alternative. See [NOVA-PRODUCTS.md](./NOVA-PRODUCTS.md).
- Whether the account service is a separate deployment or a library other Node products embed.
  Still open, and now cheaper to change: an installed product already talks to it over HTTP.
- Entitlements, purchases, and licence checks — those belong to the Store and the Launcher,
  and they are a different system that *uses* identity rather than part of identity.
- Profiles, avatars, friends, anything social.
- Refresh tokens. A product token lasts 180 days and re-authorising is the flow again.

Guessing at the rest now means being stuck with the guess.

---

## 2. Where the code is

⚠ The paths in this block are pre-2026-08-31. `server/accounts/` is now the workspace package
`packages/nova-accounts` (see [NOVA-IDENTITY.md](./NOVA-IDENTITY.md)), and it has since gained
`products.mjs`, `productTokens.mjs`, `deviceCodes.mjs`, `deviceService.mjs` and
`syncDocuments.mjs`. The rule below — that nothing inside may import from outside — is what
made that move a rename rather than a rewrite, and it still holds.

```
server/accounts/          ← the module. Portable by design.
  index.mjs               createAccounts() — the one entry point
  service.mjs             register / signIn / sessions / revocation. No HTTP anywhere in it.
  store.mjs               one JSON document per account under var/accounts/. THE SEAM.
  passwords.mjs           scrypt hashing, verification, and cost upgrades
  sessions.mjs            the signed session-token envelope
  validation.mjs          what an address and a password may be
  ids.mjs                 NA-XXXX-XXXX-XXXX
  providers/              federated sign-in; see 3a. Optional, off by default.

server/lib/viewer.mjs     ← Nova.Help's adapter: who is this request, and what may they open
server/accountRoutes.mjs  ← Nova.Help's account pages
server/views/pages/account.mjs
```

### The one discipline that makes this liftable

> **Nothing under `server/accounts/` may import from anywhere else in this repository.**

It has no idea what a ticket is. It does not know Nova.Help exists. That is what makes "move
Nova Accounts behind a service" a deployment change rather than a rewrite: `store.mjs` becomes
a database, `createAccounts` becomes a network client, and every caller keeps using the same
five methods. One import of a Nova.Help type in there would quietly convert that move into a
rewrite, which is precisely how shared identity systems fail to happen.

Both directions of the seam already exist:

- **Storage seam** — `store.mjs` has seven methods. Postgres later is a new file, not a
  refactor.
- **Product seam** — every account document carries `products: { 'nova.help': { firstSeenAt } }`,
  and every session records which product opened it. When the Launcher signs somebody in, that
  is one more key. It costs nothing today and means the ecosystem view exists from day one.

---

## 3. How it works

### An account

```jsonc
{
  "id": "NA-4T7K-9QW2-H30X",   // random, Crockford base32, recognisably an account not a ticket
  "schemaVersion": 1,
  "email": "ann@example.com",   // normalised lower case; unique across all accounts
  "emailVerified": false,       // ← load-bearing. See §4. True only when a provider vouched.
  "displayName": "Ann",
  "password": "scrypt$N=131072,r=8,p=1$<salt>$<hash>",   // null for a provider-only account
  "status": "active",           // 'disabled' cannot sign in, and looks identical to a wrong password
  "sessions": [ { "id": "…", "createdAt": "…", "expiresAt": "…", "product": "nova.help" } ],
  "identities": [              // federated sign-ins. `subject` is the ONLY thing matched on.
    { "provider": "google", "subject": "…", "email": "…", "emailVerified": true, "linkedAt": "…" }
  ],
  "products": { "nova.help": { "firstSeenAt": "…" } }
}
```

### Passwords

scrypt at **N=2^17, r=8, p=1** — the setting OWASP publishes as a minimum — with a random
per-password salt, `maxmem` raised to match, and constant-time comparison. The encoded record
carries its own parameters, so the cost can be raised later without a flag day: `verify()`
reads the parameters out of the stored string, and a correct sign-in against a weaker hash
re-hashes it at the current cost, in the one moment the plaintext is in hand.

A sign-in against an address with **no** account still pays for a full scrypt derivation
(`verifyDummy`), so "no such account" and "wrong password" cannot be told apart with a
stopwatch any more than they can be told apart by reading the page.

### Sessions

`accountId.sessionId.expiry.HMAC(...)` in an HttpOnly, SameSite=Lax cookie (`nova_session`),
30 days, Secure in production. The signing key is **derived** from the application secret
(`HMAC(secret, "nova.accounts.session.v1")`) rather than being it, so a Nova.Help ticket pass
and a Nova Account session are signed under different keys while a deployment still configures
only one.

**Sessions are stored, not merely signed, and that is the point.** A valid signature is not
enough: the `sessionId` inside the token must still be listed on the account. Signing out
removes it; signing out everywhere removes all of them; a future password change will do the
same. That is what makes signing out mean something — the alternative (a purely stateless
token) can only delete the cookie in front of you, leaving a copy taken beforehand working
until it expires.

### Rate limiting

| Route | Limit |
|---|---|
| `POST /account/sign-in` | 10 per 15 min **per source** *and* 10 per 15 min **per address tried** |
| `POST /account/new` | 5 per hour per source |
| `GET\|POST /account/auth/:provider` | 30 per 15 min per source — a courtesy to the provider; the callback's real gate is the state cookie |

Sign-in counts on both axes so neither one attacker against many addresses nor many sources
against one account gets unlimited guesses. A correct password clears both counters.

---

## 3a. Federated sign-in (Google, and whatever comes next)

Optional and off by default. Set `NOVA_GOOGLE_CLIENT_ID` and `NOVA_GOOGLE_SECRET` and a
"Continue with Google" button appears; leave them unset and Nova.Help is exactly the
email-and-password portal it was, with `/account/auth/*` answering 404. A half-set pair is
logged loudly and ignored, because a sign-in button that leads to an error page is worse than
no button.

```
server/accounts/providers/
  index.mjs   the registry, and the signed single-use state envelope
  oidc.mjs    a generic OpenID Connect client: authorization code + PKCE
  google.mjs  Google = createOidcProvider(...) plus four constants
  jwt.mjs     JWS/JWKS verification, zero dependencies
```

### Adding Apple or Discord later

That is the shape this is built for, and it does not touch Nova Accounts:

- **Apple** (OpenID Connect): a file like `google.mjs` with Apple's endpoints and
  `response_mode=form_post`.
- **Discord** (OAuth 2, no ID token): a hand-written object with the same two methods —
  `authorizationUrl()` and `identify()` — where `identify` calls the userinfo endpoint instead
  of verifying a token. Nothing above `providers/` can tell the difference.

The whole contract is:

```js
{ id, label,
  authorizationUrl({ state, nonce, codeVerifier, redirectUri }) -> string,
  identify({ code, codeVerifier, nonce, redirectUri })          -> { provider, subject, email, emailVerified, displayName } }
```

Push it into `createApp({ oauth })`, and the account model, the store, the service and the
routes are all unchanged. There is a test that stands up a second provider end to end purely
to keep that true.

### What the round trip actually does

**Start** (`GET|POST /account/auth/:provider`) mints `state`, `nonce` and a PKCE verifier,
seals all four plus the mode and the return path into one signed HttpOnly cookie
(`nova_oauth`, 15 minutes), and redirects.

**Callback** (`GET /account/auth/:provider/callback`) opens the envelope, checks the signature,
the expiry, the provider and that the URL's `state` matches the cookie's — then **clears the
cookie before exchanging anything**, so a leaked callback URL cannot be replayed even once. The
code is exchanged server-to-server with the client secret and the PKCE verifier, and the ID
token is verified in full: RS256 signature against Google's JWKS, `iss`, `aud`/`azp`, `exp`,
`iat` skew, and the `nonce` from the envelope.

**The mode is read from the session, never from a parameter.** Signed out, the flow signs you
in or creates an account; signed in, it links. That decision is sealed into the envelope at the
start and re-checked at the end.

Three details worth not undoing:

- **`SameSite=Lax`, not `Strict`.** The callback is a top-level navigation from the provider;
  `Strict` withholds the cookie on exactly that request and every sign-in fails.
- **The algorithm comes from us, not from the token.** A verifier that reads `alg` out of the
  header it is checking accepts `alg: "none"`.
- **The Google logo is drawn as inline SVG.** The CSP allows no third-party origins, and a
  favicon fetched from Google would also tell Google who is reading the page before anyone has
  chosen to sign in.

### The linking rules

| Signed in? | Identity known? | Outcome |
|---|---|---|
| yes | no | **link** to the current account |
| yes | yes, this account | already linked, nothing to do |
| yes | yes, another account | **refuse** |
| no | yes | **sign in** to the account holding it |
| no | no, address free | **create** an account (no password) and link |
| no | no, address taken | **refuse** — never auto-link |

Matching is on the provider's `subject`, never on an email address. Disconnecting is refused
when it would leave no way in (no password, last identity). A federated account has no password
and cannot be signed into with one — and that fact is not measurable, because the sign-in path
still burns a full scrypt derivation before refusing.

## 4. The security rule that is easiest to get wrong

> **An account does NOT get access to a ticket because the ticket's email address matches the
> account's email address. Access follows the `accountId` written onto the ticket when it was
> filed, and only that.**

Nothing in Nova.Help sends mail, so `emailVerified` is `false` on every account and **anybody
can register any address**. If a matching address granted access, the attack is one step:
register `victim@example.com`, and read every guest ticket ever filed with it.

So Nova.Help has two kinds of proof and they do not mix (`server/lib/viewer.mjs`):

| Proof | How you get it | What it opens |
|---|---|---|
| **Guest pass** (`nh_pass`) | Filing a ticket, or presenting its ID + the filing address | That one ticket, for 14 days |
| **Account session** (`nova_session`) | Signing in | Every ticket whose `accountId` is yours |

Consequences, all of them deliberate:

- A guest ticket filed with `ann@example.com` is **not** listed on Ann's account and does not
  become hers when she registers. The account page says so in plain words.
- A ticket filed **while signed in** does **not** also mint a guest pass, and the ID-and-address
  lookup form refuses it (403, with "sign in instead"). Otherwise the weaker proof would
  quietly be a way around the stronger one.
- The JSON API applies exactly the same rules through the same `viewer.mayOpen` call, so there
  is one answer to "may this request open this ticket" in the whole codebase.
- A refusal is the same 403 whether the ticket belongs to somebody else or does not exist, so
  the ticket URL is not a way to discover which IDs are real.

**Before this rule may be relaxed**, all of these have to be true: mail actually sends; sign-up
verifies the address; and claiming a past guest ticket is an explicit, per-ticket action by a
verified account, ideally still requiring the ticket ID. Until then, the rule stands.

### The same rule, applied to Google

Federated sign-in is the second place an address could have been mistaken for proof, and it is
refused there too — `withProviderIdentity` never links on an email match. The attack works in
both directions:

- **Attacker first.** Nothing verifies the address on a password account, so an attacker
  registers `you@gmail.com`. You later click "Continue with Google" as the real owner. If
  matching addresses were enough you would be signed into *their* account, handing them every
  ticket you file afterwards.
- **Attacker second.** You have a Nova Account; an attacker arrives with a provider identity
  asserting your address. Requiring `email_verified` from the provider raises that bar but does
  not set it — a provider added later might assert addresses it never checked, and then one
  sloppy provider is a skeleton key for every account.

So the refusal explains the way through instead of dead-ending: sign in with your password,
then connect Google from the account page. It is a real inconvenience for somebody who forgot
they had a password account, and it is the correct trade.

### Other deliberate choices

- **A taken address is reported plainly** on sign-up ("An account already uses that address").
  It is a narrow enumeration disclosure, taken knowingly: with no mail transport there is no
  "we have sent you a link" to hide behind, and a form that refuses without saying why strands
  the person who simply forgot they had an account. The 5-per-hour limiter is what stops the
  form being walked through an address list. When mail exists, this should become the silent
  "check your inbox" flow.
- **CSRF protection is `SameSite=Lax` plus POST-only state changes**, which is what the ticket
  routes already relied on. A token scheme is the right next step if a route ever needs to
  accept a cross-site POST; nothing does today.
- **No password reset yet**, and the sign-in page says so instead of offering a link that goes
  nowhere. It needs mail. See §6.

---

## 5. What Nova.Help looks like now

Nothing was taken away. **The guest path is unchanged and complete.**

```
Nova.Help  →  What do you need help with?  →  product  →  area  →  issue  →  ticket form
                                                                                  │
                                              ┌───────────────────────────────────┴──────┐
                                              │  How would you like to continue?         │
                                              │                                          │
                                              │  [ Sign in or create a Nova Account ]    │
                                              │                   or                     │
                                              │  [ Continue with your email ]            │
                                              └──────────────────────────────────────────┘
```

- The choice sits at the **top** of the form, above the summary and description, because
  following the sign-in link leaves the page and nobody should lose six paragraphs to a link
  they met at the bottom. `next=` brings them straight back to the same form.
- Both options are the same size in the same box. The moment one reads as small print, the
  form has started asking people to register before it will help them.
- **Signed in:** the contact fieldset disappears entirely — no name, no email. The address comes
  off the session on the server, and a submitted `email` or `accountId` field is *ignored*, not
  merely defaulted. That is the speed win, and it is also the security property.
- **Guest:** exactly the form that was there before, and the ID + address route back in.
- Header: an account chip at the right of the masthead beside "Check a ticket" — "Sign in" when
  signed out, the person's name when signed in.
- `/account`: their tickets, their details, sign out, sign out everywhere else.

### Routes added

| Route | |
|---|---|
| `GET/POST /account/sign-in` | sign in; `next=` sanitised against open redirects |
| `GET/POST /account/new` | create an account |
| `GET /account` | the account and its tickets |
| `POST /account/sign-out` | revokes the session server-side, then clears the cookie |
| `POST /account/sign-out-everywhere` | revokes all sessions, opens a fresh one here |
| `GET/POST /account/auth/:provider` | begin a federated flow (sign in, or link when signed in) |
| `GET /account/auth/:provider/callback` | finish one |
| `POST /account/unlink/:provider` | disconnect, unless it is the last way in |

### The ticket schema

`schemaVersion` 1 → **2**, adding one field:

```jsonc
"accountId": "NA-4T7K-9QW2-H30X" | null
```

Additive and read as `?? null`, so a version 1 document on disk is still a valid guest ticket.
**No migration is needed and none was run.**

---

## 6. What comes next, roughly in order

1. **Email delivery**, then **address verification**. It unblocks password reset, the silent
   sign-up flow, and eventually claiming past guest tickets.
2. **Password change and reset.** Both call `signOutEverywhere` — the machinery is already there.
3. **A staff console**, which needs roles on the account (`role: 'user' | 'staff'`) and real
   authorisation, not just authentication.
4. ~~**The second product.**~~ **DONE.** Four of them, and the protocol they settled is in
   [NOVA-PRODUCTS.md](./NOVA-PRODUCTS.md). The Launcher, when it arrives, is one entry in
   `products.mjs` and needs no change to any of this.
5. **More providers**, when somebody asks for them. Apple and Discord are a file each (§3a).
5. **Postgres**, whenever the JSON files stop being obviously fine. One new file implementing
   `store.mjs`'s seven methods.

---

## 7. Tests

`npm test` — 179 tests.

- `test/accounts.test.mjs` (33) — hashing, the cost-upgrade path, hostile stored records,
  session tokens, key derivation, the store's uniqueness and durability, and the service:
  generic sign-in failure, disabled accounts, revocation, the product seam, and that **nothing
  the service returns ever carries a password hash or a session list**.
- `test/accountHttp.test.mjs` (30) — the whole thing driven as a browser: sign up, sign in,
  sign out, rate limits, the guest path end to end, and the refusals — cross-account access,
  a stranger with the ID, the ID+address form against an account ticket, and registering
  somebody else's address to try to claim their guest tickets.
- `test/googleAuth.test.mjs` (34) — the whole OAuth round trip against a **real** OpenID
  Connect provider on a real port (`test/helpers/fakeProvider.mjs`), which holds an RSA key,
  publishes a JWKS, signs real ID tokens and checks PKCE and the client secret. So the happy
  paths exercise the actual signature verification, and the negative ones — wrong key, wrong
  issuer, wrong audience, expired, wrong nonce, unknown `kid`, `alg: none`, broken PKCE, no
  state cookie, mismatched state, forged envelope, replayed envelope — fail for the real
  reason. Plus the takeover cases in both directions, and a second provider stood up end to
  end to prove the architecture is extensible.
- `test/somethingElse.test.mjs` (13) — the escape hatch on every step-three screen.
- `test/core.test.mjs` + `test/http.test.mjs` (68) — the pre-existing suite, unchanged and
  still passing.

**The refusals were checked by mutation, not by assertion alone.** Each of these was applied to
the source and made the suite fail: linking on an email match; skipping the `state` comparison;
skipping the ID-token signature check; skipping the `nonce` check; allowing a disconnect that
would lock the account out; and removing BOTH the service and store guards against moving a
linked identity. Two single-layer mutations survived on their own — the service-level identity
guard and the passwordless-sign-in guard — because a second layer catches each; removing both
layers is caught, and the passwordless guard is covered by a timing test, since without it the
sign-in form becomes a stopwatch oracle for which addresses are Google-only.
