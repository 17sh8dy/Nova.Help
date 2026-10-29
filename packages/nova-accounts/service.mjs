/**
 * The Nova Account service — every rule about what an account is and how it may be used.
 *
 * This is the layer Nova.Help talks to, and the layer that will one day sit behind an HTTP
 * boundary when other Nova products sign people in. Nothing in this file knows about HTTP,
 * cookies, or Nova.Help: no request, no response, no ticket. Keeping that true is what makes
 * "move Nova Accounts into its own service" a deployment change rather than a rewrite.
 *
 * THE DOCUMENT SHAPE, because it is what a real identity store, a second product, and an
 * eventual migration all have to live with:
 *
 *   id, schemaVersion, createdAt, updatedAt
 *   email                  — normalized, lower case; the address the account is reached at
 *   emailVerified          — false everywhere today. See the note below; it is load-bearing.
 *   displayName            — optional, for greeting a person by name
 *   password               — the encoded scrypt record from passwords.mjs, or NULL for an
 *                            account that was created by signing in with a provider and has
 *                            never set one. Never a plaintext, never reversible, and never
 *                            included in anything this file returns to a caller.
 *   identities []          — { provider, subject, email, emailVerified, linkedAt }. The
 *                            federated sign-ins attached to this account. `subject` is the
 *                            provider's stable id for the person and is the ONLY thing a
 *                            federated sign-in is matched on.
 *   status                 — 'active' | 'disabled'. A disabled account cannot sign in.
 *   sessions []            — { id, createdAt, expiresAt, product }. The authoritative list;
 *                            a token whose id is not here is dead.
 *   products {}            — { 'nova.help': { firstSeenAt } }. Which Nova products this
 *                            account has been used with. It is the ecosystem seam: when the
 *                            Launcher or the Store signs someone in, this is where that fact
 *                            is recorded, and it costs one line today to have it.
 *
 * EMAIL IS NOT VERIFIED YET, AND THAT LIMITS WHAT AN ACCOUNT MAY BE TRUSTED WITH. Nothing in
 * Nova.Help sends mail, so anybody can register any address. It therefore follows that owning
 * an account with an address must NOT grant access to anything that was filed with that
 * address before the account existed — the caller enforces that, and the reasoning is written
 * down in docs/NOVA-ACCOUNTS.md so it cannot be quietly dropped when mail is added.
 */
import { hashPassword, needsRehash, verifyDummy, verifyPassword, DEFAULT_COST } from './passwords.mjs';
import { normalizeEmail as normalize, validateEmailChange, validateProfile } from './validation.mjs';
import { AVATAR_TYPES, isAvatarKeyFor } from './avatars.mjs';
import { newAccountId, newSessionId } from './ids.mjs';
import {
  normalizeEmail,
  validatePasswordReset,
  validateRegistration,
  validateResetRequest,
  validateSignIn,
} from './validation.mjs';
import { SESSION_TTL_SECONDS } from './sessions.mjs';
import { groupedSecret, newTotpSecret, otpauthUri, verifyTotp } from './totp.mjs';
import {
  accountDeletedMessage,
  emailChangedMessage,
  mfaChangedMessage,
  passwordChangedMessage,
  passwordResetMessage,
} from './mail.mjs';

const SCHEMA_VERSION = 1;

/* Two-step verification limits. The counters live on the account, not on the sign-in ticket or the
   caller's address, so a fresh ticket, a fresh IP or a fresh session resets nothing. */
const MFA_MAX_FAILURES = 5;
const MFA_LOCK_MS = 15 * 60 * 1000;
const MFA_PENDING_TTL_MS = 15 * 60 * 1000;

/** A bound on the session list, so a document cannot grow without limit. Oldest go first. */
const MAX_SESSIONS = 20;

/**
 * Everything about an account that is safe to hand to a page, a log line, or another product.
 * The password record and the session list are absent BY CONSTRUCTION rather than by deletion,
 * so a field added to the document later cannot leak by being forgotten here.
 */
export const publicView = (account) =>
  account
    ? {
        id: account.id,
        email: account.email,
        displayName: account.displayName ?? null,
        emailVerified: Boolean(account.emailVerified),
        createdAt: account.createdAt,
        products: Object.keys(account.products ?? {}),
        /* Whether a password exists, never anything about it. The account page needs this to
           know if disconnecting a provider would lock the person out. */
        hasPassword: typeof account.password === 'string' && account.password.length > 0,
        /* The provider's `subject` is deliberately not here. A page never needs it, and an
           external identifier that never reaches a template can never leak from one. */
        identities: (account.identities ?? []).map((identity) => ({
          provider: identity.provider,
          email: identity.email ?? null,
          linkedAt: identity.linkedAt,
        })),
      }
    : null;

export function createAccountService({
  store,
  tokens,
  cost = DEFAULT_COST,
  product = 'nova.help',
  /* Password reset needs three things this service cannot invent: a way to mint tokens, a way
     to send mail, and a name to put in it. All three are passed in — the transport especially,
     because which one a deployment has is not this module's business. */
  resetTokens,
  /* The two-step vault from mfa.mjs: seals secrets, hashes recovery codes, signs sign-in tickets.
     Required, because a service without it would sign people in past a second factor. */
  mfa,
  mailer,
  productName = 'Nova',
  supportUrl = null,
  logger = console,
}) {
  async function allocateId() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = newAccountId();
      if (!(await store.has(id))) return id;
    }
    throw new Error('Could not allocate a unique account id.');
  }

  /** Best-effort notice to the address on the account. A down transport undoes nothing. */
  async function notifyMfa(account, change, now) {
    try {
      await mailer.send(
        mfaChangedMessage({ to: account.email, change, at: new Date(now).toISOString(), productName, supportUrl }),
      );
    } catch (error) {
      logger.error?.('[nova.accounts] two-step notification failed', error);
    }
  }

  /**
   * Check a code against an enrolled account, counting the miss. ALL the decisions - locked?
   * replayed? right? - are made inside one atomic update of the record, so two guesses arriving
   * together cannot both read "four failures" and both be allowed a fifth.
   *
   * Returns `{ ok: true, via: 'totp' | 'recovery' }` or `{ ok: false, reason, retryAfter? }`.
   */
  async function checkSecondFactor(accountId, code, { now = Date.now() } = {}) {
    let outcome = { ok: false, reason: 'invalid' };
    await store.updateMfa(accountId, (current) => {
      if (!current?.enabledAt) {
        outcome = { ok: false, reason: 'invalid' };
        return undefined;
      }
      if (current.lockedUntil && current.lockedUntil > now) {
        outcome = { ok: false, reason: 'locked', retryAfter: Math.ceil((current.lockedUntil - now) / 1000) };
        return undefined;
      }

      const next = { ...current };
      delete next.lockedUntil;

      const secret = mfa.open(accountId, current.sealed);
      const totp = secret ? verifyTotp(secret, code, { now, notAfter: current.lastStep ?? -1 }) : { ok: false };
      if (totp.ok) {
        outcome = { ok: true, via: 'totp' };
        return { ...next, lastStep: totp.step, failures: 0 };
      }

      const index = mfa.matchRecovery(current.recovery, code);
      if (index !== -1) {
        outcome = { ok: true, via: 'recovery' };
        return { ...next, recovery: current.recovery.filter((_, i) => i !== index), failures: 0 };
      }

      const failures = (current.failures ?? 0) + 1;
      if (failures >= MFA_MAX_FAILURES) {
        outcome = { ok: false, reason: 'locked', retryAfter: Math.ceil(MFA_LOCK_MS / 1000) };
        return { ...next, failures: 0, lockedUntil: now + MFA_LOCK_MS };
      }
      outcome = { ok: false, reason: 'invalid' };
      return { ...next, failures };
    });
    return outcome;
  }

  /** Password AND a current code: the proof asked for before weakening two-step. */
  async function freshSecondFactor(accountId, input, now) {
    const account = await store.get(accountId);
    if (!account || account.status !== 'active') return { ok: false, reason: 'no-such-account' };
    if (typeof account.password !== 'string' || !account.password) return { ok: false, reason: 'no-password' };
    const status = await store.getMfa(accountId);
    if (!status?.enabledAt) return { ok: false, reason: 'not-enabled' };
    if (!(await passwordIsRight(account, input.currentPassword))) return wrongPassword;

    const checked = await checkSecondFactor(accountId, input.code, { now });
    if (!checked.ok) {
      return {
        ok: false,
        reason: checked.reason === 'locked' ? 'locked' : 'wrong-code',
        retryAfter: checked.retryAfter,
        errors: {
          code:
            checked.reason === 'locked'
              ? 'Too many wrong codes. Try again in a few minutes.'
              : 'That code is not right. Use the current one from your app, or a recovery code.',
        },
      };
    }
    return { ok: true, account };
  }

  /** True only for a real, present password that matches. A missing one is the same as a wrong one. */
  const passwordIsRight = async (account, password) =>
    typeof account?.password === 'string' &&
    account.password.length > 0 &&
    typeof password === 'string' &&
    password.length > 0 &&
    verifyPassword(password, account.password);

  const wrongPassword = {
    ok: false,
    reason: 'wrong-password',
    errors: { currentPassword: 'That is not your current password.' },
  };

  /** Drop lapsed sessions and keep the newest few. Called on every write that touches them. */
  const prune = (sessions = []) => {
    const now = Date.now();
    return sessions
      .filter((session) => new Date(session.expiresAt).getTime() > now)
      .slice(-MAX_SESSIONS);
  };

  /** Record that this account has been used with a Nova product. Additive, never removed. */
  function touchProduct(account, name) {
    account.products ??= {};
    account.products[name] ??= { firstSeenAt: new Date().toISOString() };
    return account;
  }

  return {
    /**
     * Create an account.
     *
     * Returns `{ ok: true, account }` (a public view) or `{ ok: false, errors, values }`.
     * Never throws for bad input.
     *
     * A TAKEN ADDRESS IS REPORTED PLAINLY, and that is a deliberate, narrow disclosure: with
     * no mail transport there is no "we have sent you a link" to hide behind, and a sign-up
     * form that refuses without saying why strands the person who simply forgot they had an
     * account. The rate limiter on the route is what stops the form being walked through an
     * address list.
     */
    async register(input = {}, { product: usedIn = product } = {}) {
      const validated = validateRegistration(input);
      if (!validated.ok) return { ok: false, errors: validated.errors, values: validated.values };

      const { values, password } = validated;

      if (await store.emailTaken(values.email)) {
        return {
          ok: false,
          values,
          errors: { email: 'An account already uses that address. Sign in instead.' },
          reason: 'email-taken',
        };
      }

      const now = new Date().toISOString();
      const account = {
        id: await allocateId(),
        schemaVersion: SCHEMA_VERSION,
        createdAt: now,
        updatedAt: now,
        email: values.email,
        emailVerified: false,
        displayName: values.displayName || null,
        password: await hashPassword(password, { cost }),
        status: 'active',
        sessions: [],
        identities: [],
        products: { [usedIn]: { firstSeenAt: now } },
      };

      const created = await store.create(account);
      if (!created.ok) {
        // Lost the race against a simultaneous sign-up with the same address.
        return {
          ok: false,
          values,
          errors: { email: 'An account already uses that address. Sign in instead.' },
          reason: 'email-taken',
        };
      }

      return { ok: true, account: publicView(created.account) };
    },

    /**
     * Check an address and password.
     *
     * Returns `{ ok: true, account }` or `{ ok: false, reason }` with a single generic reason
     * for every failure mode a stranger could probe: unknown address, wrong password, and
     * disabled account are all `'invalid'`, and an unknown address still pays for a full
     * scrypt derivation so the three cannot be told apart with a stopwatch either.
     */
    async signIn(input = {}) {
      const validated = validateSignIn(input);
      if (!validated.ok) {
        return { ok: false, reason: 'incomplete', errors: validated.errors, values: validated.values };
      }

      const { values, password } = validated;
      const account = await store.getByEmail(values.email);

      if (!account) {
        await verifyDummy(password, { cost });
        return { ok: false, reason: 'invalid', values };
      }

      /* An account created by signing in with Google has no password. It must not be possible
         to sign into it with one — and "no password set" must be indistinguishable from "wrong
         password", in wording and in time, or the sign-in form becomes a way to ask which
         addresses are Google-only. */
      if (typeof account.password !== 'string' || !account.password) {
        await verifyDummy(password, { cost });
        return { ok: false, reason: 'invalid', values };
      }

      const correct = await verifyPassword(password, account.password);
      if (!correct || account.status !== 'active') return { ok: false, reason: 'invalid', values };

      // The one moment we hold the plaintext is the only moment we can raise its cost.
      if (needsRehash(account.password, { cost })) {
        const rehashed = await hashPassword(password, { cost });
        await store.update(account.id, (doc) => {
          doc.password = rehashed;
          doc.updatedAt = new Date().toISOString();
          return doc;
        });
      }

      /* Signing in with the password proves the person never needed the reset link they asked
         for, so it stops working. Somebody who requests a reset, remembers their password and
         signs in should not be leaving a live link in their inbox. */
      if (account.passwordReset) await store.clearPasswordReset(account.id).catch(() => {});

      /* A CORRECT PASSWORD IS NOT ENOUGH WHEN TWO-STEP VERIFICATION IS ON, and this is the one
         place that is decided. `signIn` never returns `ok: true` for such an account - it hands
         back a short-lived ticket instead - so a caller written before two-step existed, which
         opens a session on `ok`, fails closed (it shows "that did not sign you in") rather than
         signing the person in without the code. `completeMfaSignIn` is the only way through. */
      const enrolled = await store.getMfa(account.id);
      if (enrolled?.enabledAt) {
        return { ok: false, reason: 'mfa-required', ticket: mfa.issueTicket(account.id), values };
      }

      return { ok: true, account: publicView(account) };
    },

    /**
     * Open a session and mint its token. The session id is recorded on the account first, so a
     * token can never be live before the record that authorises it exists.
     */
    async startSession(accountId, { ttlSeconds = SESSION_TTL_SECONDS, product: usedIn = product } = {}) {
      const now = new Date();
      const session = {
        id: newSessionId(),
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
        product: usedIn,
      };

      const updated = await store.update(accountId, (doc) => {
        if (doc.status !== 'active') return null;
        doc.sessions = [...prune(doc.sessions), session];
        touchProduct(doc, usedIn);
        doc.updatedAt = now.toISOString();
        return doc;
      });
      if (!updated) return { ok: false, reason: 'no-such-account' };

      return {
        ok: true,
        token: tokens.issue({ accountId, sessionId: session.id, expiresAt: session.expiresAt }),
        expiresAt: session.expiresAt,
        account: publicView(updated),
      };
    },

    /**
     * Who is making this request.
     *
     * BOTH HALVES MUST HOLD: the token's signature has to verify, AND the session id inside it
     * has to still be on the account. That second check is the whole reason sessions are
     * stored rather than merely signed — it is what makes signing out mean something.
     *
     * Returns `{ account, session }` (account is a public view) or null.
     */
    async resolveSession(token) {
      const claim = tokens.verify(token);
      if (!claim) return null;

      const account = await store.get(claim.accountId);
      if (!account || account.status !== 'active') return null;

      const session = (account.sessions ?? []).find((entry) => entry.id === claim.sessionId);
      if (!session) return null;
      if (new Date(session.expiresAt).getTime() <= Date.now()) return null;

      return { account: publicView(account), session };
    },

    /** End one session. Returns true when a live session was actually removed. */
    async signOut(token) {
      const claim = tokens.verify(token);
      if (!claim) return false;

      let removed = false;
      await store.update(claim.accountId, (doc) => {
        const before = (doc.sessions ?? []).length;
        doc.sessions = prune(doc.sessions).filter((entry) => entry.id !== claim.sessionId);
        removed = doc.sessions.length !== before;
        doc.updatedAt = new Date().toISOString();
        return doc;
      });
      return removed;
    },

    /**
     * End every session on an account — the "that was not me" button, and what a password
     * change will call when there is one.
     */
    async signOutEverywhere(accountId) {
      const updated = await store.update(accountId, (doc) => {
        doc.sessions = [];
        doc.updatedAt = new Date().toISOString();
        return doc;
      });
      return Boolean(updated);
    },

    /**
     * Sign in, create, or link - from a provider identity that has ALREADY been verified.
     *
     * `identity` is `{ provider, subject, email, emailVerified, displayName }` as returned by a
     * provider in server/accounts/providers/. This function assumes the cryptography was done
     * and decides only one thing: which Nova Account, if any, this person is.
     *
     * ─────────────────────────────────────────────────────────────────────────────────────
     * THE DECISION TABLE. This is the security of the whole feature.
     *
     *   signed in?  identity known?              outcome
     *   ──────────  ───────────────────────────  ──────────────────────────────────────────
     *   yes         no                           LINK it to the current account
     *   yes         yes, this account            already linked; nothing to do
     *   yes         yes, another account         REFUSE
     *   no          yes                          SIGN IN to the account that holds it
     *   no          no, address is free          CREATE an account and link it
     *   no          no, address has an account   REFUSE - never auto-link
     *
     * ─────────────────────────────────────────────────────────────────────────────────────
     * WHY THE LAST ROW REFUSES INSTEAD OF LINKING, which is the point of this function:
     *
     * Linking a provider identity to an existing account because the EMAIL ADDRESSES MATCH is
     * the classic account-takeover bug, and it works in both directions.
     *
     *   Attacker first. Nova.Help sends no mail, so nothing proves the address on a password
     *   account. An attacker registers `you@gmail.com` with a password. You later click
     *   "Continue with Google" as the real owner of that address. If matching addresses were
     *   enough, you would be signed into THE ATTACKER'S account - handing them every support
     *   ticket you file from then on, and showing you theirs.
     *
     *   Attacker second. You have a Nova Account. An attacker arrives with a provider identity
     *   asserting your address. If matching addresses were enough, they are now you. Demanding
     *   `emailVerified` from the provider raises that bar but does not set it: a provider added
     *   later may assert addresses it never checked, and then one sloppy provider silently
     *   becomes a skeleton key for every account on the system.
     *
     * So an address is never proof of anything here. Access is granted by `subject` - a stable
     * id the provider vouches for - or by a password, and joining the two requires holding
     * BOTH at once: sign in with the password, then link. That is a real inconvenience for
     * somebody who forgot they had a password account, and it is the correct trade; the
     * refusal page says so and offers the way through.
     *
     * WHAT WOULD CHANGE THIS. Nothing about a provider. Verifying OUR OWN addresses would:
     * once a Nova Account's email is confirmed by us sending mail to it, an address match is
     * evidence about the same human, and automatic linking between two independently verified
     * addresses becomes defensible. Until then this rule holds.
     *
     * Returns `{ ok: true, outcome, account }` with outcome one of 'signed-in' | 'created' |
     * 'linked' | 'already-linked', or `{ ok: false, reason, email? }`.
     */
    async withProviderIdentity(identity, { currentAccountId = null, product: usedIn = product } = {}) {
      if (!identity?.provider || !identity?.subject) {
        return { ok: false, reason: 'incomplete-identity' };
      }

      /* An address the provider has not verified tells us nothing, so it is not used to create
         an account, not compared against anything, and not stored as though it meant something.
         Google sets this true for every ordinary account; refusing is safer than guessing. */
      if (!identity.email || !identity.emailVerified) {
        return { ok: false, reason: 'provider-email-unverified' };
      }

      const email = normalize(identity.email);
      const existing = await store.getByIdentity(identity.provider, identity.subject);

      const record = () => ({
        provider: identity.provider,
        subject: identity.subject,
        email,
        emailVerified: true,
        linkedAt: new Date().toISOString(),
      });

      /* Signed in: this is a link, not a sign-in. */
      if (currentAccountId) {
        const current = await store.get(currentAccountId);
        if (!current || current.status !== 'active') return { ok: false, reason: 'no-such-account' };

        if (existing) {
          if (existing.id === currentAccountId) {
            return { ok: true, outcome: 'already-linked', account: publicView(existing) };
          }
          /* One provider identity, one Nova Account. Moving it silently would detach it from
             an account somebody may still be relying on to get in. */
          return { ok: false, reason: 'identity-on-another-account' };
        }

        if ((current.identities ?? []).some((i) => i.provider === identity.provider)) {
          return { ok: false, reason: 'provider-already-linked' };
        }

        const claimed = await store.claimIdentity(currentAccountId, record());
        if (!claimed.ok) return { ok: false, reason: claimed.reason };

        await store.update(currentAccountId, (doc) => touchProduct(doc, usedIn));
        return { ok: true, outcome: 'linked', account: publicView(claimed.account) };
      }

      /* Not signed in: sign in, or create. */
      if (existing) {
        if (existing.status !== 'active') return { ok: false, reason: 'no-such-account' };

        /* Keep the address held for this identity current - people do change the address on a
           Google account - but only on the identity record. The Nova Account's own email is
           never rewritten from a provider: it is the unique key every other account is checked
           against, and a provider must not be able to move it. */
        const updated = await store.update(existing.id, (doc) => {
          doc.identities = (doc.identities ?? []).map((i) =>
            i.provider === identity.provider && i.subject === identity.subject
              ? { ...i, email, lastUsedAt: new Date().toISOString() }
              : i,
          );
          touchProduct(doc, usedIn);
          doc.updatedAt = new Date().toISOString();
          return doc;
        });

        /* TWO-STEP PROTECTS THE ACCOUNT, NOT ONE WAY IN. Google proving who somebody is does not
           mean they passed Nova's second factor, and a person who turned it on expects it to
           cover every sign-in method. So an enrolled account gets a ticket here, exactly as
           `signIn` gives one, and `completeMfaSignIn` is again the only way through. */
        if ((await store.getMfa(existing.id))?.enabledAt) {
          return { ok: false, reason: 'mfa-required', ticket: mfa.issueTicket(existing.id) };
        }

        return { ok: true, outcome: 'signed-in', account: publicView(updated ?? existing) };
      }

      /* A new provider identity whose address already belongs to somebody. See above. */
      if (await store.emailTaken(email)) {
        return { ok: false, reason: 'email-has-account', email };
      }

      const now = new Date().toISOString();
      const account = {
        id: await allocateId(),
        schemaVersion: SCHEMA_VERSION,
        createdAt: now,
        updatedAt: now,
        email,
        /* The provider checked this address, and recording that is accurate. It still does not
           enable automatic linking - that rule is about OUR addresses, and this flag is what a
           future "we sent you a link" flow will set for those. */
        emailVerified: true,
        displayName: identity.displayName || null,
        /* No password. `signIn` refuses an account in this state, so the only way in is the
           provider - which is exactly what the person chose. */
        password: null,
        status: 'active',
        sessions: [],
        identities: [record()],
        products: { [usedIn]: { firstSeenAt: now } },
      };

      const created = await store.create(account);
      if (!created.ok) {
        /* Lost a race with another sign-up for the same address or the same identity. */
        return {
          ok: false,
          reason: created.reason === 'identity-taken' ? 'identity-on-another-account' : 'email-has-account',
          email,
        };
      }

      return { ok: true, outcome: 'created', account: publicView(created.account) };
    },

    /**
     * Detach a provider from an account.
     *
     * REFUSED WHEN IT WOULD LOCK THE PERSON OUT. An account with no password whose only
     * identity is the one being removed has no way back in, and there is no password-reset
     * flow to rescue it. The button is not offered in that state, and the rule is enforced
     * here as well, because a page is not a security boundary.
     *
     * THE RULE IS DECIDED HERE AND APPLIED BY THE STORE, which is the shape it has to have.
     * This function used to read the account, check that another way in would remain, and then
     * call `releaseIdentity`. Nothing held the account still across those two steps: two
     * unlinks of two DIFFERENT providers, arriving together on an account with a password of
     * none and exactly two identities, would each see two, each conclude that one would
     * survive, and both go ahead. The account came out the other side with nothing to sign in
     * with. Passing the requirement down means the counting and the removal are one operation
     * — under a lock in the JSON store, inside the DELETE statement in D1 — and the second of
     * the two is refused against the state the first one left.
     */
    async unlinkProvider(accountId, provider) {
      const released = await store.releaseIdentity(accountId, provider, { requireAnotherWayIn: true });
      return released.ok
        ? { ok: true, account: publicView(released.account) }
        : { ok: false, reason: released.reason };
    },

    /* ── Forgotten passwords ─────────────────────────────────────────────────────────────
     *
     * THE WHOLE FLOW IS ARRANGED SO THAT NEITHER STEP ANSWERS A QUESTION ABOUT WHO HAS AN
     * ACCOUNT. `requestPasswordReset` returns the same thing for an address that has one and
     * an address that does not, and the route renders the same page for both. The only place
     * the difference is observable is the inbox of whoever owns the address.
     */

    /**
     * Ask for a reset link.
     *
     * ALWAYS RETURNS `{ ok: true, sent: <boolean> }`. `sent` is for the caller's logs and for
     * tests; a route that renders it, or branches on it in a way a stranger can see, has
     * reintroduced the enumeration hole this is shaped to avoid.
     *
     * An account created through a provider and holding no password may still reset: what
     * comes back is not "recover your password" but "set one", which is a legitimate thing to
     * want and the only route to it that does not require already being signed in. It cannot
     * be used to take an account over — completing it requires reading mail sent to the
     * address on the account.
     *
     * A DISABLED ACCOUNT GETS NOTHING, silently. There is no sense minting a way into an
     * account that `signIn` refuses anyway, and saying so would answer the question this
     * function exists not to answer.
     */
    async requestPasswordReset(input = {}, { link, now = new Date() } = {}) {
      const validated = validateResetRequest(input);
      if (!validated.ok) return { ok: false, errors: validated.errors, values: validated.values };

      const { values } = validated;
      const account = await store.getByEmail(values.email);

      if (!account || account.status !== 'active') {
        /* Nothing to do, and deliberately nothing to time: there is no password hash to derive
           and no mail to send either way, so the two paths already cost the same. */
        return { ok: true, sent: false, values };
      }

      const { token, record } = resetTokens.issue(account.id, { now });
      const issued = await store.issuePasswordReset(account.id, record);
      if (!issued.ok) return { ok: true, sent: false, values };

      const message = passwordResetMessage({
        to: account.email,
        link: link(token),
        ttlMinutes: Math.round(resetTokens.ttlSeconds / 60),
        productName,
      });

      /* A transport that fails must not change what the visitor is told. The failure is the
         deployment's problem and is logged as one; surfacing it here would say "we tried to
         send to this address", which is the disclosure the flow is built to prevent. */
      try {
        const delivery = await mailer.send(message);
        return { ok: true, sent: delivery?.ok !== false, values };
      } catch (error) {
        logger.error?.('[nova.accounts] password reset mail failed', error);
        return { ok: true, sent: false, values };
      }
    },

    /**
     * Is this link still worth showing a form for?
     *
     * Used by the GET, so somebody arriving with an expired or spent link is told so before
     * they type a new password rather than after. It is a courtesy and NOT a security check —
     * it spends nothing and proves nothing, and `resetPassword` re-checks everything under the
     * atomic redemption regardless of what this said.
     */
    async checkResetToken(token, { now = new Date() } = {}) {
      const parsed = resetTokens.parse(token);
      if (!parsed) return { ok: false, reason: 'malformed' };

      const account = await store.get(parsed.accountId);
      if (!account || account.status !== 'active') return { ok: false, reason: 'invalid' };

      const reset = account.passwordReset;
      if (!reset?.tokenHash) return { ok: false, reason: 'invalid' };
      if (!resetTokens.matches(parsed.tokenHash, reset.tokenHash)) return { ok: false, reason: 'invalid' };
      if (new Date(reset.expiresAt).getTime() <= now.getTime()) return { ok: false, reason: 'expired' };

      return { ok: true, email: account.email, expiresAt: reset.expiresAt };
    },

    /**
     * Spend a link and set the new password.
     *
     * THE TOKEN IS CHECKED AND SPENT BY THE STORE, IN ONE OPERATION. Verifying here and writing
     * afterwards is the shape that made `unlinkProvider` unsafe: two requests carrying the same
     * link, arriving together, would both find it valid. `redeemPasswordReset` is atomic in
     * both stores — under the account lock in one, inside a guarded batch in the other — so the
     * second finds the link already spent.
     *
     * EVERY SESSION ENDS. Whoever reset the password may or may not be the person who was
     * signed in on some other device, and the only safe reading is that they are not. The store
     * clears the session list as part of the same redemption, so there is no window in which
     * the password is new and an old session is still live.
     *
     * Returns `{ ok: true, account }` or `{ ok: false, reason, errors? }`.
     */
    async resetPassword(token, input = {}, { now = new Date() } = {}) {
      const parsed = resetTokens.parse(token);
      if (!parsed) return { ok: false, reason: 'invalid' };

      /* Read only to learn the address, so the password rules can refuse a password that IS
         the address. Nothing here decides whether the link is good. */
      const account = await store.get(parsed.accountId);
      const validated = validatePasswordReset(input, { email: account?.email ?? '' });
      if (!validated.ok) return { ok: false, reason: 'invalid-password', errors: validated.errors };

      const hashed = await hashPassword(validated.password, { cost });
      const redeemed = await store.redeemPasswordReset(parsed.accountId, {
        tokenHash: parsed.tokenHash,
        password: hashed,
        matches: resetTokens.matches,
        now,
      });

      if (!redeemed.ok) {
        // 'expired' is worth saying; everything else collapses to one answer.
        return { ok: false, reason: redeemed.reason === 'expired' ? 'expired' : 'invalid' };
      }

      /* Told after the fact, on purpose: this is the message that reaches somebody whose
         address has been taken over, and it must not be sent for an attempt that failed. A
         transport that is down does not undo a password that has already changed. */
      try {
        await mailer.send(
          passwordChangedMessage({ to: redeemed.account.email, at: now.toISOString(), productName, supportUrl }),
        );
      } catch (error) {
        logger.error?.('[nova.accounts] password changed notification failed', error);
      }

      return { ok: true, account: publicView(redeemed.account) };
    },

    /* ── Managing an account ────────────────────────────────────────────────────────────
     *
     * These are what the Nova site's account pages call. The rules that hold for all of them:
     *
     *   - THE CALLER SAYS WHO. Every method takes an account id the route got from the session
     *     cookie; nothing here reads an identity out of the request body.
     *   - A CHANGE THAT COULD LOCK THE OWNER OUT OR HAND THE ACCOUNT TO SOMEBODY ELSE ASKS FOR
     *     THE CURRENT PASSWORD AGAIN. A stolen session cookie alone is not enough to change the
     *     address, the password, or to delete the account. An account with no password (one made
     *     by a provider) cannot use these; it has to set one through the reset flow first.
     *   - FAILURES ARE SPECIFIC ONLY WHERE THE CALLER IS ALREADY AUTHENTICATED. A wrong current
     *     password here says so, because the person has proved who they are by session; the
     *     one-answer rule is for sign-in, where they have not.
     *   - THE OTHER PARTIES ARE TOLD. An address change mails the OLD address; a password change
     *     and a deletion mail the address on the account. Best-effort: a mail transport that is
     *     down does not undo a change that has happened.
     */

    /** Change the display name. */
    async updateProfile(accountId, input = {}) {
      const validated = validateProfile(input);
      if (!validated.ok) return { ok: false, reason: 'invalid', errors: validated.errors, values: validated.values };

      const updated = await store.update(accountId, (doc) => {
        doc.displayName = validated.values.displayName || null;
        doc.updatedAt = new Date().toISOString();
        return doc;
      });
      if (!updated) return { ok: false, reason: 'no-such-account' };
      return { ok: true, account: publicView(updated) };
    },

    /**
     * Change the password. Needs the current one. Every other session -- web, and every product
     * that signed in by device -- is signed out, and the kept session is the one that asked.
     */
    async changePassword(accountId, input = {}, { keepToken = null, now = new Date() } = {}) {
      const account = await store.get(accountId);
      if (!account || account.status !== 'active') return { ok: false, reason: 'no-such-account' };
      if (typeof account.password !== 'string' || !account.password) return { ok: false, reason: 'no-password' };

      if (!(await passwordIsRight(account, input.currentPassword))) return wrongPassword;

      const validated = validatePasswordReset(input, { email: account.email });
      if (!validated.ok) return { ok: false, reason: 'invalid', errors: validated.errors };
      if (validated.password === input.currentPassword) {
        return { ok: false, reason: 'invalid', errors: { password: 'Choose a password you are not already using.' } };
      }

      const hashed = await hashPassword(validated.password, { cost });
      const keepId = keepToken ? tokens.verify(keepToken)?.sessionId : null;
      await store.update(accountId, (doc) => {
        doc.password = hashed;
        doc.sessions = prune(doc.sessions).filter((session) => keepId && session.id === keepId);
        doc.updatedAt = now.toISOString();
        return doc;
      });
      // A reset link somebody was sent for the OLD password must not outlive it.
      await store.clearPasswordReset(accountId).catch(() => {});

      try {
        await mailer.send(passwordChangedMessage({ to: account.email, at: now.toISOString(), productName, supportUrl }));
      } catch (error) {
        logger.error?.('[nova.accounts] password changed notification failed', error);
      }
      return { ok: true };
    },

    /** Change the address. Needs the current password. The new address starts unverified. */
    async changeEmail(accountId, input = {}, { now = new Date() } = {}) {
      const account = await store.get(accountId);
      if (!account || account.status !== 'active') return { ok: false, reason: 'no-such-account' };
      if (typeof account.password !== 'string' || !account.password) return { ok: false, reason: 'no-password' };

      if (!(await passwordIsRight(account, input.currentPassword))) return wrongPassword;
      const validated = validateEmailChange(input, { currentEmail: account.email });
      if (!validated.ok) return { ok: false, reason: 'invalid', errors: validated.errors, values: validated.values };

      const taken = {
        ok: false,
        reason: 'email-taken',
        errors: { newEmail: 'That address is already used by another Nova Account.' },
        values: validated.values,
      };
      if (await store.emailTaken(validated.values.newEmail)) return taken;

      const changed = await store.changeEmail(accountId, validated.values.newEmail, { now });
      if (!changed.ok) return changed.reason === 'email-taken' ? taken : { ok: false, reason: changed.reason };

      try {
        await mailer.send(
          emailChangedMessage({
            to: account.email,
            newEmail: validated.values.newEmail,
            at: now.toISOString(),
            productName,
            supportUrl,
          }),
        );
      } catch (error) {
        logger.error?.('[nova.accounts] email changed notification failed', error);
      }
      return { ok: true, account: publicView(changed.account) };
    },

    /**
     * The sign-ins on an account, for a security page: when, for which product, and whether it
     * is the one asking. Never a token; the session id is only ever compared, not a credential.
     */
    async listSessions(accountId, { currentToken = null } = {}) {
      const account = await store.get(accountId);
      if (!account) return [];
      const currentId = currentToken ? tokens.verify(currentToken)?.sessionId : null;
      return prune(account.sessions).map((session) => ({
        id: session.id,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        product: session.product ?? null,
        kind: session.kind ?? 'web',
        label: session.label ?? null,
        current: session.id === currentId,
      }));
    },

    /** Sign out everything except the session that asked. Returns how many were ended. */
    async signOutOthers(accountId, { keepToken = null } = {}) {
      const keepId = keepToken ? tokens.verify(keepToken)?.sessionId : null;
      let ended = 0;
      await store.update(accountId, (doc) => {
        const live = prune(doc.sessions);
        doc.sessions = live.filter((session) => keepId && session.id === keepId);
        ended = live.length - doc.sessions.length;
        doc.updatedAt = new Date().toISOString();
        return doc;
      });
      return ended;
    },

    /** End one named session, but never the one asking (that is `signOut`). */
    async revokeSession(accountId, sessionId, { keepToken = null } = {}) {
      const keepId = keepToken ? tokens.verify(keepToken)?.sessionId : null;
      if (!sessionId || sessionId === keepId) return false;
      let removed = false;
      await store.update(accountId, (doc) => {
        const before = prune(doc.sessions);
        doc.sessions = before.filter((session) => session.id !== sessionId);
        removed = doc.sessions.length < before.length;
        doc.updatedAt = new Date().toISOString();
        return doc;
      });
      return removed;
    },

    /**
     * Delete the account. IRREVERSIBLE, so it asks for the current password AND the address typed
     * out. Returns the picture reference (if any) so the caller can delete the object; the row
     * itself goes with the account.
     *
     * `beforeDelete(db)` is handed to the store and runs in the same transaction; see the D1
     * store. It is how Nova.Help's tickets are anonymised atomically with the account going.
     */
    async deleteAccount(accountId, input = {}, { beforeDelete = null, now = new Date() } = {}) {
      const account = await store.get(accountId);
      if (!account || account.status !== 'active') return { ok: false, reason: 'no-such-account' };
      if (typeof account.password !== 'string' || !account.password) return { ok: false, reason: 'no-password' };

      if (!(await passwordIsRight(account, input.currentPassword))) return wrongPassword;
      if (normalize(input.confirmEmail) !== normalize(account.email)) {
        return {
          ok: false,
          reason: 'not-confirmed',
          errors: { confirmEmail: 'Type the email address on this account exactly, to confirm.' },
        };
      }

      const avatar = await store.getAvatar(accountId);
      const gone = await store.deleteAccount(accountId, { beforeDelete });
      if (!gone) return { ok: false, reason: 'no-such-account' };

      try {
        await mailer.send(accountDeletedMessage({ to: account.email, at: now.toISOString(), productName, supportUrl }));
      } catch (error) {
        logger.error?.('[nova.accounts] account deleted notification failed', error);
      }
      return { ok: true, avatar };
    },

    /* ── Two-step verification ──────────────────────────────────────────────────────────────
     *
     * An authenticator app (TOTP) plus ten recovery codes. The rules that make it worth having:
     *
     *   - IT IS NOT ON UNTIL A CODE HAS BEEN PROVEN. Starting setup only stores a PENDING
     *     secret; `confirmMfaEnrollment` switches it on when the first code from the person's
     *     app is right. Switching it on at the QR code would lock out anybody whose app
     *     scanned wrongly.
     *   - THE SECOND STEP CANNOT BE SKIPPED. `signIn` returns a ticket instead of success for an
     *     enrolled account; only `completeMfaSignIn` turns that into one.
     *   - GUESSING IS COUNTED ON THE ACCOUNT. Five wrong codes lock the second step for fifteen
     *     minutes, however many tickets, sessions or addresses they came from.
     *   - A CODE WORKS ONCE. The step of the last accepted code is kept and anything at or before
     *     it is refused, so a code that was seen cannot be replayed inside its window.
     *   - TURNING IT OFF, OR REPLACING THE RECOVERY CODES, ASKS AGAIN: the password AND a current
     *     code. A stolen session cookie must not be able to remove the protection.
     *   - EVERY CHANGE IS MAILED to the address on the account.
     */

    /** Whether two-step is on, and how many recovery codes are left. Never the secret or the hashes. */
    async mfaStatus(accountId, { now = Date.now() } = {}) {
      const record = await store.getMfa(accountId);
      const pending = record?.pending && now - new Date(record.pending.createdAt).getTime() < MFA_PENDING_TTL_MS;
      return {
        enabled: Boolean(record?.enabledAt),
        enabledAt: record?.enabledAt ?? null,
        recoveryRemaining: record?.enabledAt ? (record.recovery ?? []).length : 0,
        pending: Boolean(pending),
        lockedUntil: record?.lockedUntil && record.lockedUntil > now ? record.lockedUntil : null,
      };
    },

    /**
     * Begin setup: make a secret and keep it PENDING. Needs the current password. Returns nothing
     * secret - the page asks `pendingMfaSetup` for what to draw.
     */
    async beginMfaEnrollment(accountId, input = {}, { now = Date.now() } = {}) {
      const account = await store.get(accountId);
      if (!account || account.status !== 'active') return { ok: false, reason: 'no-such-account' };
      if (typeof account.password !== 'string' || !account.password) return { ok: false, reason: 'no-password' };
      if (!(await passwordIsRight(account, input.currentPassword))) return wrongPassword;

      const sealed = mfa.seal(accountId, newTotpSecret());
      let already = false;
      const saved = await store.updateMfa(accountId, (current) => {
        if (current?.enabledAt) {
          already = true;
          return undefined;
        }
        return { pending: { sealed, createdAt: new Date(now).toISOString(), failures: 0 } };
      });
      if (!saved.ok) return { ok: false, reason: 'no-such-account' };
      return already ? { ok: false, reason: 'already-enabled' } : { ok: true };
    },

    /** What to show during setup: the `otpauth://` URI for the QR code and the secret for typing. */
    async pendingMfaSetup(accountId, { now = Date.now() } = {}) {
      const account = await store.get(accountId);
      const record = await store.getMfa(accountId);
      if (!account || !record?.pending || record.enabledAt) return null;
      if (now - new Date(record.pending.createdAt).getTime() >= MFA_PENDING_TTL_MS) return null;
      const secret = mfa.open(accountId, record.pending.sealed);
      if (!secret) return null;
      return {
        uri: otpauthUri({ secret, account: account.email, issuer: productName }),
        secret: groupedSecret(secret),
      };
    },

    /** Abandon setup. Harmless if there is nothing pending; never touches an enabled record. */
    async cancelMfaEnrollment(accountId) {
      await store.updateMfa(accountId, (current) => (current?.enabledAt || !current ? undefined : null));
      return { ok: true };
    },

    /**
     * Finish setup with the first code from the person's app. Switches two-step ON and returns
     * the recovery codes - the ONLY time they exist in the clear.
     */
    async confirmMfaEnrollment(accountId, code, { now = Date.now() } = {}) {
      const account = await store.get(accountId);
      if (!account || account.status !== 'active') return { ok: false, reason: 'no-such-account' };

      const recoveryCodes = mfa.newRecoveryCodes();
      let outcome = 'no-setup';
      await store.updateMfa(accountId, (current) => {
        if (!current?.pending || current.enabledAt) return undefined;
        if (now - new Date(current.pending.createdAt).getTime() >= MFA_PENDING_TTL_MS) {
          outcome = 'no-setup';
          return null;
        }
        const secret = mfa.open(accountId, current.pending.sealed);
        const checked = secret ? verifyTotp(secret, code, { now }) : { ok: false };
        if (!checked.ok) {
          const failures = (current.pending.failures ?? 0) + 1;
          if (failures >= MFA_MAX_FAILURES) {
            /* Too many wrong guesses at an unproven secret: throw it away and make them start
               again, rather than leaving a pending record to be ground down. */
            outcome = 'start-over';
            return null;
          }
          outcome = 'wrong-code';
          return { ...current, pending: { ...current.pending, failures } };
        }
        outcome = 'ok';
        return {
          enabledAt: new Date(now).toISOString(),
          sealed: current.pending.sealed,
          lastStep: checked.step,
          recovery: recoveryCodes.map((c) => mfa.hashRecovery(c)),
          failures: 0,
        };
      });

      if (outcome !== 'ok') {
        return {
          ok: false,
          reason: outcome,
          errors: {
            code:
              outcome === 'wrong-code'
                ? 'That code is not right. Check the app and try the new one.'
                : 'Start again from the beginning.',
          },
        };
      }
      await notifyMfa(account, 'enabled', now);
      return { ok: true, recoveryCodes };
    },

    /**
     * The second half of signing in. `ticket` is what `signIn` returned; `code` is six digits from
     * the app or a recovery code. Returns `{ ok: true, account, via }` or a failure that says only
     * what a person with the password may be told: wrong code, locked, or the ticket lapsed.
     */
    async completeMfaSignIn({ ticket, code } = {}, { now = Date.now() } = {}) {
      const accountId = mfa.readTicket(ticket, { now });
      if (!accountId) return { ok: false, reason: 'expired' };

      const account = await store.get(accountId);
      if (!account || account.status !== 'active') return { ok: false, reason: 'expired' };

      const checked = await checkSecondFactor(accountId, code, { now });
      if (!checked.ok) return checked;
      if (checked.via === 'recovery') await notifyMfa(account, 'recovery-used', now);
      return { ok: true, account: publicView(account), via: checked.via };
    },

    /** Turn two-step off. Needs the password AND a current code (or a recovery code). */
    async disableMfa(accountId, input = {}, { now = Date.now() } = {}) {
      const gate = await freshSecondFactor(accountId, input, now);
      if (!gate.ok) return gate;
      await store.updateMfa(accountId, () => null);
      await notifyMfa(gate.account, 'disabled', now);
      return { ok: true };
    },

    /** Replace the recovery codes. Same two proofs as turning it off. Returns the new codes once. */
    async regenerateRecoveryCodes(accountId, input = {}, { now = Date.now() } = {}) {
      const gate = await freshSecondFactor(accountId, input, now);
      if (!gate.ok) return gate;
      const recoveryCodes = mfa.newRecoveryCodes();
      await store.updateMfa(accountId, (current) =>
        current?.enabledAt ? { ...current, recovery: recoveryCodes.map((c) => mfa.hashRecovery(c)) } : undefined,
      );
      await notifyMfa(gate.account, 'recovery', now);
      return { ok: true, recoveryCodes };
    },

    /** The reference to the picture, or null. */
    async getAvatar(accountId) {
      return store.getAvatar(accountId);
    },

    /**
     * Record a new picture and return the reference it replaced (so the caller can delete that
     * object). Refuses a reference this package did not make for this account.
     */
    async setAvatar(accountId, { objectKey, contentType, size }, { now = new Date() } = {}) {
      if (!isAvatarKeyFor(accountId, objectKey) || !Object.values(AVATAR_TYPES).includes(contentType)) {
        return { ok: false, reason: 'invalid' };
      }
      if (!(await store.has(accountId))) return { ok: false, reason: 'no-such-account' };
      const previous = await store.putAvatar(accountId, { objectKey, contentType, size, updatedAt: now.toISOString() });
      return { ok: true, previous };
    },

    /** Remove the picture reference. Returns the reference removed, for the caller to delete. */
    async clearAvatar(accountId) {
      return store.deleteAvatar(accountId);
    },

    /** A public view by id, or null. Nothing here ever returns the stored document. */
    async get(accountId) {
      return publicView(await store.get(accountId));
    },

    /** For an operational counter. No addresses, no ids. */
    count: () => store.count(),

    /** Exposed so a caller can normalize an address the same way the store does. */
    normalizeEmail,
  };
}
