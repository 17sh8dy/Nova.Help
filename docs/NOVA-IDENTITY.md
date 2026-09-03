# One Nova Account, many front doors

```
                            Nova Account
                     (@nova/accounts + one D1 database)
                                  │
        ┌─────────────────────────┴─────────────────────────┐
        │  same process, same database                       │  over HTTP, device grant
        │                                                    │  (@nova/account-client)
   ┌────┴────┬───────────┐              ┌──────────┬─────────┴──┬───────────┐
   Nova      Nova.Help                  Open Cut   Online Earth  Replay.GG  Atlas
 (Pages+Fns)  (Worker)                  (Electron) (web+Electron)(Electron) (Tauri)
   cookie      cookie                        scoped product token, revocable
```

The left half is this document. The right half — how an *installed* product signs somebody in,
and why it is the device grant — is [NOVA-PRODUCTS.md](./NOVA-PRODUCTS.md).

There is **one** account system. It lives in `packages/nova-accounts`, it is the code Nova.Help
has been running and testing, and both front doors bind the **same D1 database**. The Nova site
is not a second account system; it is another door onto the same identity.

## What changed, and what deliberately did not

**Nothing about how identity works changed.** Passwords, sessions, reset tokens, provider
linking, the account document, the atomic redemption, the rate-limit windows, the enumeration
resistance — all of it is the same code in the same place, now consumed by two apps instead of
one. Nova.Help's 519 tests pass unchanged.

The only structural change is that `server/accounts/` became `packages/nova-accounts` — a
workspace package with a `package.json` and no dependencies. Nova.Help imports it in-process
exactly as before; only the specifier moved (`./accounts/index.mjs` → `@nova/accounts`).

That was possible because the module was already built for it. Its own header has said from the
start that nothing inside may import from outside, *"so that when Nova Accounts becomes a
service other products call, this directory moves out as a package."* This is that move.

## Why a shared package and not a service

A service would put an HTTP hop and a second trust boundary between a front door and the thing
that checks a password, and — the deciding factor — it would mean converting Nova.Help from
in-process calls to an HTTP client. That is a rewrite of the system that was just secured and
tested, to make a different site work. A shared package gets one implementation and one database
with no rewrite at all.

The service option is still open: a package that runs in-process today can be wrapped in a Worker
tomorrow without changing its callers' semantics. Nothing here forecloses it.

## The rule that keeps it shared rather than copied

`test/accountStore.test.mjs` enforces it mechanically:

- **No relative import may leave the package.** One would break the Nova site's build.
- **The only bare specifiers allowed are `node:` builtins.** A dependency would have to be
  installed by every consumer.

That test is the difference between "shared" and "copied and drifting."

## One identity, proven

`Nova/test/account.test.mjs` stands both front doors up over one database and checks the thing
that actually matters:

| Test | What it shows |
|---|---|
| Account created on Nova → sign in via Nova.Help | Same password, other door |
| Account created on Nova.Help → sign in via Nova | No separate Nova account needed |
| Nova.Help cannot register an address Nova already has | `email-taken` — **one row, not one per product** |
| Using both records `['nova', 'nova.help']` on one account | The `products {}` ecosystem seam |
| Reset started on Nova kills the old password for Nova.Help | One credential |
| Session opened by Nova.Help is accepted by Nova | The token is already portable |
| Sign out on Nova revokes Nova.Help's session | One session store |

## Sessions across domains — the honest position

A session token is signed with a key derived from the shared secret and checked against the
shared session list, so **a token minted by either front door verifies at the other.** That is
tested.

What does not yet cross is the **cookie**. `nova-780.pages.dev` and `nova.help` are different
registrable domains, and a browser will not send one site's cookie to the other. So today: one
account and one password, but you sign in at each site.

The fix is a domain decision, not a code one, and the code is ready for it:

- `createApp({ cookieDomain })` in Nova.Help
- `NOVA_COOKIE_DOMAIN` on the Nova site

Set both to `.nova.xyz` once Nova and Nova.Help are on one registrable domain and one sign-in
covers the ecosystem — no OAuth, no redirect flow, no second protocol. Until then, leave them
unset; a browser rejects a `Domain` its host is not under.

## Configuration that must match

| | Nova site | Nova.Help | Why |
|---|---|---|---|
| D1 database | `DB` → `nova-help` | `DB` → `nova-help` | **The same database, or there are two account systems** |
| Signing secret | `NOVA_SECRET` | `NOVA_HELP_SECRET` | **Must be equal**, or a session minted by one will not verify at the other |
| Cookie domain | `NOVA_COOKIE_DOMAIN` | `cookieDomain` | Both set, or neither |
| Rate limiter | `RATE_LIMITER` → `nova-help` | `RATE_LIMITER` | Bound to Nova.Help's Durable Object, so counters are shared |

## Google

**Not implemented on the Nova site, deliberately.** Both Nova forms show a disabled "Continue with Google —
Coming soon" control. It is a `<button disabled>`, not a link and not a form target, there is no
route behind it, and tests assert that `/account/auth/google` is a 404 and that no `href` or
`action` mentions Google. No credentials exist anywhere.

The architecture is ready: the provider system in the shared package already implements the flow
for Nova.Help, so enabling Google is configuration plus a route, not a model change.

**The linking rule is untouched and must stay so.** A provider identity is matched on the
provider's `subject`, never on an email address, and an address that already has an account is
*refused* rather than linked. A test in the Nova suite asserts this still holds now that there is
a second front door — that is exactly the place such a rule gets quietly relaxed.

## Before deployment

1. **The Nova site's package dependency is `file:../NovaHelp/packages/nova-accounts`.** That
   works locally and for tests; a Cloudflare Pages build cannot reach outside its own repo. The
   two repos need to become one workspace, or the package needs publishing, before the Nova site
   deploys with Functions. **This is the one open structural item.**
2. Create the real D1 database and put its id in both `wrangler.jsonc` files (both are the
   all-zeros placeholder today).
3. Set `NOVA_SECRET` on Nova equal to `NOVA_HELP_SECRET` on Nova.Help.
4. Choose a mail transport — still none, on either site.
5. Deploy Nova.Help first: the Nova site's rate-limiter binding points at its Durable Object.
6. Re-read the legal pages. `privacy.html` has been updated to describe accounts accurately;
   `terms-of-use.html` and `terms-of-service.html` were **not** reviewed for account language.
