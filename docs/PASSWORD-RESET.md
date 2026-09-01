# Password reset

`/account/forgot` → a link by email → `/account/reset` → a new password, every session ended.

> ⚠ **It needs a mail transport, and there is not one configured.** Everything below works and
> is tested; on a deployment with no transport the flow accepts requests, says the same neutral
> thing it always says, and sends nothing. That is announced loudly at boot and on every
> request. See **Configuring mail** at the bottom — it is the one remaining step.

## The pieces

| File | What it is |
|---|---|
| `server/accounts/resetTokens.mjs` | Minting, parsing, hashing. No storage, no policy. |
| `server/accounts/mail.mjs` | The transport seam, plus the two messages. |
| `server/accounts/store.mjs` · `d1Store.mjs` | `issuePasswordReset`, `redeemPasswordReset`, `clearPasswordReset` |
| `server/accounts/service.mjs` | `requestPasswordReset`, `checkResetToken`, `resetPassword` |
| `server/accountRoutes.mjs` | The four routes |
| `server/views/pages/passwordReset.mjs` | The three pages |

## The security properties, and where each one lives

**Tokens are 32 bytes from the system CSPRNG.** A token is `accountId.secret`. The account id is
not a secret and grants nothing alone — session tokens already carry one — and having it makes
the lookup a read of one known row rather than a scan for a matching digest, which is what keeps
the JSON store from needing a fourth in-memory index. Two of the three bugs previously found in
that module were an index that had drifted.

**What is stored is `sha256(secret)`, never the token.** A copy of the database is not a set of
working links, for the same reason `accounts.password` is a scrypt record.

**Single use is enforced by the store, atomically.** This is the important one.
`redeemPasswordReset` verifies the token, sets the password, clears every session and deletes
the token as *one operation* — under the account lock in the JSON store, and in D1 as a batch
where every statement carries the same guard and the reset row is deleted last. Checking in the
service and writing afterwards is exactly the shape that made `unlinkProvider` unsafe; two
requests carrying the same link would both find it valid. Tested by racing two redemptions in
both stores and through HTTP.

**One hour, and one outstanding link per account.** Asking again replaces the previous request,
so an older mail sitting in an inbox is already dead. A successful ordinary sign-in also retires
an outstanding link — somebody who asks for a reset and then remembers their password should not
be leaving a live link behind.

**Nothing tells a stranger who has an account.** `/account/forgot` renders the identical page,
on the same status, for an address with an account and one without — including when the account
is disabled, and including when the mail transport is *down*, because a 500 for one address and
a confirmation for another is the same disclosure by another route. The test asserts the two
responses are byte-identical once the typed address is masked, rather than checking for a
phrase; a difference in status, length or a single word is the leak.

**Rate limited on both axes.** 6/hour per source and 4/hour per address, tighter than sign-in
because each request costs an outbound mail and costs the person named in it an interruption —
this limits using the form to pester somebody as much as it limits guessing. Exceeding the
*per-address* limit renders the ordinary neutral confirmation rather than a 429, since a
different response for a much-asked-about address is itself a signal.

**Every session ends.** Whoever reset the password may not be the person signed in on another
device, and the only safe reading is that they are not. The session list is cleared inside the
same redemption, so there is no window where the password is new and an old session is live. The
browser that completed the reset is given a fresh session, so it stays signed in.

**A notification follows.** Sent *after* the change lands, never for a failed attempt. It is the
message that reaches somebody whose mailbox has been taken over, so it says what happened, when,
that everything was signed out, and what to do if it was not them.

**A validation failure does not spend the link.** Validation runs before redemption, so a
too-short or mismatched password re-renders the form with the token intact.

**Provider-only accounts can use it to set a first password.** An account created with Google
has no password; this is the only route to setting one without already being signed in. It
cannot be used to take an account over — completing it requires reading mail sent to the address
on the account.

## Two decisions worth knowing about

**A completed reset sets `emailVerified: true`.** The flag was reserved for exactly this — "once
a Nova Account's email is confirmed by us sending mail to it" — and somebody has now proved they
read mail we sent. **It changes no access decision today.** In particular the federated-linking
rule in `service.mjs` is *unchanged*: a provider identity is still matched on the provider's
`subject` and never on an address, and an address match still never auto-links. That comment
describes automatic linking between two independently verified addresses as something that
*becomes defensible* later; it has not been implemented and should not be treated as done.

**The account id is visible in the reset link.** Judged acceptable: it is already in every
session token, it grants nothing without the secret half, and the alternative costs an index in
the JSON store whose drift has caused real bugs here before.

## Configuring mail

The transport is `{ send({ to, subject, text }) }`, injected — never imported — so
`server/accounts/` stays liftable.

- **Development**: `createApp` uses `createLogMailer` automatically when `dev` is true, which
  prints the whole message including the link to the console. That is how to walk the flow on a
  machine with no mail, and it is refused in production, where printing reset links into a log
  file is its own incident.
- **Tests**: `createMemoryMailer()` keeps messages in an array.
- **Production**: pass `mailer` to `createApp`. On Cloudflare that means adding it in
  `server/worker.mjs`, where the natural fit is Cloudflare Email Sending — it needs a verified
  domain, which `getnovasupport@gmail.com` is not, so sending from a Nova domain (or a
  provider like Resend/Postmark) is the decision to make. Whatever it is, it only has to
  implement `send`.

## Verified

40 tests in `test/passwordReset.test.mjs`, run against **both** stores — the redemption is
implemented completely differently in each and both must mean the same thing — plus 16 in the
store contract. Covered: the happy path, single use, two redemptions racing, sessions ending,
the notification, enumeration resistance (including with a broken transport), expiry, replaced
links, sign-in retiring a link, weak passwords, both rate limits, and a provider-only account
setting its first password.

Driven by hand end to end on the Node server: link received, opened, password set, link refused
on reuse (400), old password rejected (401), new password accepted (303), notification sent. On
the real Worker with D1, the reset row lands as a digest with a one-hour expiry and the missing
transport is reported loudly while the page still gives nothing away.
