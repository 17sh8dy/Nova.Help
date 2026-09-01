# Nova.Help on Cloudflare

D1 for the documents, R2 for the bytes, a Durable Object per key for the throttles, and the
Node implementation still in place and still the default. **Nothing is deployed.**
`wrangler.jsonc` has no route and no custom domain; adding one is the deliberate act that puts
this on the internet, and the `database_id` is still a placeholder. The remaining items are
under *Still open* — none of them now blocks a deploy, but the scrypt measurement should be
taken on a real Worker before this carries real traffic.

## Where things are

| | Node (default) | Cloudflare |
|---|---|---|
| Tickets | `server/store/fileStore.mjs` | `server/store/d1Store.mjs` |
| Accounts | `server/accounts/store.mjs` | `server/accounts/d1Store.mjs` |
| Attachments | `server/core/attachments.mjs` | `server/store/r2Attachments.mjs` |
| Rate limiting | `server/lib/rateLimit.mjs` | `server/lib/doRateLimit.mjs` + `server/rateLimiterObject.mjs` |
| Entry point | `server/index.mjs` | `server/worker.mjs` |
| Schema | — | `server/store/schema.sql`, `server/accounts/schema.sql` |

`npm start` and `npm test` are unchanged and still run on JSON files. The Cloudflare stores are
selected by passing `stores` to `createApp`, which only `server/worker.mjs` and the D1 tests do.

Two local drivers make the Cloudflare code runnable and testable here, and they are not equally
strong:

- **`server/store/sqliteD1.mjs`** wraps `node:sqlite`, the same engine D1 is built on, in D1's
  interface. SQL proven against it is proven. No dependency; Node 22.5+ ships it.
- **`server/store/localR2.mjs`** reimplements R2's shape over the filesystem. It can only show
  the adapter *calls* R2 correctly. `wrangler dev` runs the real thing.

## Running it locally

```sh
npx wrangler d1 execute nova-help --local --file server/store/schema.sql
npx wrangler d1 execute nova-help --local --file server/accounts/schema.sql
echo 'NOVA_HELP_SECRET=a-local-development-secret-of-sufficient-length' > .dev.vars
npx wrangler dev
```

`.dev.vars` and `.wrangler/` are gitignored. The `database_id` in `wrangler.jsonc` is a
placeholder — `wrangler dev` refuses to start without one — and must be replaced with the id
`wrangler d1 create nova-help` prints before anything real happens.

## The design, in one page

**Optimistic concurrency, because D1 leaves no alternative.** D1 is auto-commit and has no
interactive transaction: `batch()` takes a list of statements decided in advance, so there is
no way to hold `BEGIN`, run a caller's mutator, and `COMMIT`. A read-modify-write with
arbitrary JavaScript in the middle cannot be made atomic by a transaction. Hence `version`.

**The mutator contract that comes with it.** A mutator may run more than once, so it must be a
pure function of its document. Assigning to a variable in an enclosing scope is fine — a re-run
overwrites it, which is what `setStatus` and `signOut` already do. Appending to one is not.

**Facts are not guarded; decisions are.** This is the part that matters most.

- A **fact** is a row appearing or disappearing on its own terms: a reply, an internal note, a
  session opening or closing, a product being recorded. It cannot be invalidated by whatever
  else committed meanwhile. It is written without the version, never bumps it, and can never
  lose a race or be retried.
- A **decision** is a change made on the strength of what was read: a guarded status
  transition, an assignment, a password change. It carries the version and fails if it moved.

Without that split, twelve concurrent replies to one ticket exhausted five retries and threw.
With it they are twelve inserts that do not contend. `addReply` retries only when it *also*
moves the status, which is the one part of it that is genuinely a decision.

**Event positions are allocated by the database.** `seq` comes from
`COALESCE(MAX(seq), -1) + 1` inside the insert, not from `events.length` in JavaScript. Two
writers that each read "the history is four long" would both write event four and one would
lose to the primary key.

**History is append-only, and enforced.** `seq` is part of the primary key, and `update()`
compares every prior event and throws if one was edited or dropped — otherwise the edit would
be silently ignored while the returned document showed it as applied.

**Uniqueness is a constraint now, not a lock.** `accounts.email_normalized` is `UNIQUE`, and
`account_identities` is keyed on `(provider, subject)` with `UNIQUE (account_id, provider)`.
The in-memory `Map`s could not survive a Worker — no single process to hold them, no boot at
which to build them — and the constraints are strictly stronger than the locks were.

**Addresses are indexed by digest.** `requester_email_hash` is the SHA-256 of the normalised
address, which keeps what the old constant-time comparison protected while gaining an index.
`requester_email` still holds what the reporter typed, for display.

**Attachments go to R2, keyed `tickets/<ticketId>/<attachmentId>`,** stored as
`application/octet-stream` so that even a direct bucket link could not render an uploaded
`.html`. What the browser claimed is metadata; what it is served as is still decided from the
extension by `serveTypeFor`. Ordering is unchanged: R2 first, D1 second, `discard` on failure.

## Verified

451 tests pass. Both ticket stores, both account stores and both rate limiters are held to the
*same* contract suites (`test/helpers/*Contract.mjs`), so "the Cloudflare one does what the
Node one does" is asserted rather than assumed. `test/d1App.test.mjs` drives the whole portal
on D1 + R2; `test/rateLimitRoutes.test.mjs` stands the app up twice, once per limiter, and runs
identical assertions through the real routes.

Driven by hand against `wrangler dev` on the real Workers runtime, with real local D1 and R2:
filing a ticket, the pass-gated ticket page (403 without it), lookup, ten concurrent replies
(all landed, `seq` 0–11 contiguous), a multipart upload round-tripping through R2 with the
right download headers, sign-up, sign-in, a wrong password refused, a duplicate address refused
by the unique index, sign-out revoking the session so the old cookie stops working, and
`/api/stats` counting from SQL.

Rate limiting was driven against the real Durable Object too:

- Five sign-ups allowed, the sixth refused **429 with `Retry-After: 3597`** — the hour window
  less the seconds elapsed, which is exactly the number the native binding cannot produce.
- **Twenty genuinely concurrent ticket creations against a limit of ten: exactly ten allowed,
  ten refused.** This is the one that matters — it is input gates working on the real platform,
  and the case an in-memory limiter fails outright across isolates.
- Nine wrong passwords, then the right one, then nine more wrong: **no 429**, because success
  cleared both counters. Eighteen failures inside a window of ten.
- With `register` spent at 429, sign-in still answered 401 and lookup 404 — separate limiters
  do not spend each other's budget.
- Seven distinct Durable Object instances on disk, one per (limiter, key) pair actually used —
  one object per key, not a shared singleton.

**Password hashing works, which was not the expectation.** `node:crypto`'s scrypt runs under
`nodejs_compat` at the full production cost — stored records read `scrypt$N=131072,r=8,p=1`.
But N=2¹⁷ needs 128 MiB, which *is* an isolate's entire memory limit, and a derivation costs
roughly 0.2s of CPU. Local `workerd` does not enforce the deployed platform's CPU and memory
ceilings, so **this must be measured again on a real Worker.** It is a thing to verify, not
currently a thing to fix.

## Rate limiting

In-memory counters mean *per isolate* in a Worker, so a limit of ten becomes ten per isolate —
which is to say no limit at all. The Node implementation is untouched and still the default;
Cloudflare gets a Durable Object per limiter per key.

### Why not the Cloudflare rate-limiting binding

It was the first choice, and it was measured before being rejected. It cannot express what this
site already does, on five counts:

1. **`simple.period` must be 10 or 60 seconds.** Every window here is longer — ten minutes for
   replies, fifteen for sign-in and lookup, an hour for registration and ticket creation.
   Wrangler refuses the config outright: `"ratelimits[0]" bindings "simple.period" must be
   either 10 or 60 but got 900`. On its own this ends the question.
2. **`limit()` returns `{ success }` and nothing else.** Confirmed by running it. There is no
   retry-after, so the `Retry-After` header and the "try again in N minutes" line on the 429
   page would both have to be invented, and an invented number is worse than none.
3. **No way to reset a key.** A correct password clears the counters here, so one forgotten
   password does not cost the afternoon. That cannot be written against the binding at all.
4. **Counters are per Cloudflare location.** An attacker spread across points of presence gets
   the limit multiplied by the number of them — the wrong property for the thing standing in
   front of a login form.
5. **It is explicitly best-effort** — the docs say it is "intentionally designed to not be used
   as an accurate accounting system."

Points 1 and 2 were confirmed against a running Worker, not read and believed.

### The Durable Object

One object per **limiter and key** — `signIn` and this address, `register` and that IP. One
object per *limiter* holding a map of keys would be a global bottleneck: every sign-in on the
site, worldwide, serialised through a single object in a single location. Per key they are
independent, each holds one counter, and each hibernates when its window ends.

- **The key is hashed into the instance name.** Names appear in Cloudflare's dashboards and
  metrics, and these keys are email addresses and client IPs. A digest counts just as well —
  the same reasoning that made the ticket store index addresses by digest.
- **The limits are not in the object.** `hit` is told the window and maximum by its caller, so
  every limit stays written down together in `app.mjs`, exactly where it was before.
- **State is persisted, not held in memory.** An evicted object that came back at zero would
  hand an attacker a fresh allowance for the price of a pause.
- **An alarm at the window's end deletes the state,** replacing the in-memory limiter's sweep.
  An object with no storage costs nothing.
- **No lock, transaction or `blockConcurrencyWhile`.** Every await in the counter is a storage
  operation, so the runtime's *input gates* already make read-modify-write atomic.

That last point is the whole design, so it is worth being blunt about the trap: `hitWindow` is
**not** race-safe on its own — ten concurrent calls against a maximum of four let all ten
through and leave the count at one, which was measured, not assumed. It is correct only because
the caller serialises it. The local stub in `lib/localDurableObjects.mjs` therefore models the
input gate explicitly; without that, the burst test passed on the timing of a hash rather than
on the limiter being right.

Routes now `await` `hit` and `clear`. That costs the in-memory limiter nothing — awaiting a
plain object resolves to that object — so `server/lib/rateLimit.mjs` is byte-for-byte unchanged
and no route branches on which limiter it is talking to.

## Also fixed along the way

Four bugs, all pre-existing in the Node code and none introduced by this work.

1. **The account store held three disjoint locks over one document.** `create` locked
   `email:`, `claimIdentity` locked `identity:`, `update` locked `id:` — so a Google link and a
   concurrent sign-in could each read the same document and the loser's change vanished, while
   `byIdentity` went on insisting the link existed until a restart rebuilt the index from disk
   and it was simply gone. Every write now holds `id:<accountId>` as well as any uniqueness
   key, taken in sorted order so two writers cannot deadlock.
2. **A replaced provider identity was never retired from the index.** `index()` only ever
   added, so reconnecting Google with a different account left the old subject resolving to the
   account for good — meaning somebody signing in with the Google account that had been
   *disconnected* would still be let in.
3. **Both stores wrote through a temp path named for the pid,** so two writers to one id shared
   a scratch file. Now a random suffix, in both.
4. **Multipart uploads were broken in Chrome, Safari and Edge.** `parseBody` lowercased the
   whole `Content-Type` header and then read the boundary out of the lowercased copy. A
   boundary is a literal matched byte for byte against the body, so any client sending one with
   a capital letter — `----WebKitFormBoundary...`, which is all three of those browsers —
   parsed to no fields at all and got "your ticket was not sent" with every field blank.
   Firefox sends digits and worked. The suite passed because undici's `FormData` also picks a
   lowercase boundary. Found by driving a real upload with curl; `test/body.test.mjs` now pins
   hand-written boundaries from each browser.

5. **Disconnecting two providers at once could empty a passwordless account.**
   `unlinkProvider` read the account, satisfied itself that another way in would remain, and
   then asked the store to remove the identity. Nothing held the account still in between: two
   unlinks of two *different* providers arriving together on an account with no password and
   exactly two identities each saw two, each concluded one would survive, and both proceeded.
   The account came out with no password, no identity, and no way back in — permanently, since
   there is no password-reset flow. A double-click on a slow connection is enough.

   The fix passes the requirement down instead of pre-checking it:
   `releaseIdentity(accountId, provider, { requireAnotherWayIn: true })`. *Whether* to require
   it is still the service's decision — it is the layer that knows there is no reset flow —
   but *where* it is enforced has to be the store, because only the store can make the counting
   and the removal one operation. In the JSON store that is the check moved inside the
   `id:<accountId>` lock every writer already takes. In D1 there is no lock to take, so the
   condition is written into the DELETE itself:

   ```sql
   DELETE FROM account_identities
    WHERE account_id = ? AND provider = ?
      AND ( EXISTS (SELECT 1 FROM accounts WHERE id = ? AND password IS NOT NULL AND password <> '')
            OR (SELECT COUNT(*) FROM account_identities WHERE account_id = ?) > 1 )
   ```

   A single statement is evaluated atomically, so the second of two concurrent deletes sees the
   count the first left behind — one identity, no password, condition false, nothing removed —
   and `meta.changes` is the answer to "did it happen". Verified against real D1: with two
   identities the first delete removes one and the second removes nothing; set a password and
   the last one is allowed to go.

   `test/unlinkRace.test.mjs` covers it at the service level for both backends, and the store
   contract covers it a layer down. The six concurrency tests were confirmed to **fail against
   the old implementation** and the fourteen behaviour tests to **pass** against it — which is
   the signature of a bug that was only ever wrong under concurrency.

`fileStore.list()` also gained an id tiebreaker, so tickets filed in the same millisecond page
deterministically instead of in whatever order `readdir` returned at boot.

## Still open

- ~~`unlinkProvider` checks then acts~~ — **fixed**; see *Also fixed along the way*, item 5.
- Sessions are pruned only when an account is written. A lapsed-session sweep would need an
  alarm or a cron trigger; `account_sessions_by_expiry` is indexed for it.
- No read replication. Turning it on without threading Sessions API bookmarks would make every
  guarded write read a stale version and retry until replication caught up. Leave it off.
- `/api/stats` is unauthenticated and does a `GROUP BY` over the whole table, which is billed
  as rows read. Cache it or gate it before it is public.
