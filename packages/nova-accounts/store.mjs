/**
 * The account store — one JSON document per account under var/accounts/.
 *
 * THIS IS THE SEAM, in the same sense that server/store/fileStore.mjs is the seam for tickets:
 * the account service above it uses the seven methods at the bottom of this file and knows
 * nothing else about storage. When Nova Accounts becomes a service with a real database
 * behind it, this file is what gets replaced, and nothing above it changes.
 *
 * Three properties are load-bearing:
 *
 * 1. WRITES ARE ATOMIC AND PRIVATE. Every save goes to a temp file and is renamed over the
 *    target, so a crash mid-write leaves the previous document rather than a truncated one.
 *    Each temp file carries a random suffix, so two writers to one id can never share a
 *    scratch path and interleave into it. Account files hold password hashes, so they are
 *    written 0600 inside a 0700 directory. (On Windows those modes are advisory; the
 *    atomicity is not.)
 *
 * 2. ONE ADDRESS, ONE ACCOUNT — AND ONE PROVIDER IDENTITY, ONE ACCOUNT. Both indexes are
 *    maintained in memory and both uniqueness checks run inside a lock keyed on the value
 *    being claimed, so two simultaneous sign-ups with the same address, or two attempts to
 *    attach the same Google identity to different accounts, cannot both win. The identity
 *    index is keyed on `provider:subject` — the provider's own stable id for the person —
 *    and never on an email address; see the linking rules in service.mjs for why.
 *
 * 3. EVERY WRITE TO A DOCUMENT HOLDS THAT DOCUMENT'S OWN LOCK, whatever else it holds.
 *
 *    This is property 2's sharp edge, and it was got wrong once, so it is spelled out. A
 *    uniqueness lock keyed on an address or an identity does NOT exclude a writer that came
 *    in through the account id, because they are different keys. When `claimIdentity` held
 *    only `identity:google:123` while `update` held only `id:acct_x`, both could read the
 *    same document, both could await their write, and the loser's change vanished — taking
 *    the Google link with it, while `byIdentity` went on insisting the link existed until a
 *    restart rebuilt the index from disk and it was simply gone.
 *
 *    So a uniqueness key is acquired IN ADDITION to `id:<accountId>`, never instead of it,
 *    and a writer that needs several keys takes them in sorted order, so two writers reaching
 *    for the same pair from opposite ends cannot deadlock.
 *
 * 4. NOTHING LEAVES HERE BY REFERENCE. Reads return deep copies, so no caller can mutate a
 *    stored password hash or session list by accident.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';

import { normalizeEmail } from './validation.mjs';

export function createAccountStore({ dir }) {
  const accountsDir = path.join(dir, 'accounts');
  const accounts = new Map(); // id -> account document
  const byEmail = new Map(); // normalized email -> id
  const byIdentity = new Map(); // "provider:subject" -> id
  const locks = new Map(); // key -> promise chain tail
  let ready = null;

  const fileFor = (id) => path.join(accountsDir, `${id}.json`);

  async function persist(account) {
    const target = fileFor(account.id);
    /* A random suffix, not the pid: two writers inside one process would otherwise share this
       path and interleave their bytes into it before either rename. */
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(account, null, 2), { encoding: 'utf8', mode: 0o600 });
    try {
      await rename(temp, target);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
  }

  /**
   * Take one key. Resolves to the function that gives it back.
   *
   * The map holds a promise that settles when the current holder releases; a newcomer chains
   * onto it. `finally`-style cleanup keeps the map from growing a permanent entry per address
   * ever seen, which on a public sign-up form is not a theoretical concern.
   */
  function acquire(key) {
    const previous = locks.get(key) ?? Promise.resolve();
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const tail = previous.then(
      () => held,
      () => held,
    );
    locks.set(key, tail);
    tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key);
    });
    return previous.then(
      () => release,
      () => release,
    );
  }

  /**
   * Run `fn` holding every one of `keys`. Returns whatever `fn` returns.
   *
   * Keys are sorted before they are taken, so every caller acquires any given pair in the same
   * order and two writers cannot each hold the key the other is waiting for. Releases happen
   * in a `finally`, so a mutator that throws does not strand the account it was writing to.
   */
  async function withLocks(keys, fn) {
    const ordered = [...new Set(keys)].sort();
    const releases = [];
    try {
      for (const key of ordered) releases.push(await acquire(key));
      return await fn();
    } finally {
      for (const release of releases.reverse()) release();
    }
  }

  /** The common case: one key. */
  const withLock = (key, fn) => withLocks([key], fn);

  const identityKey = (provider, subject) => `${provider}:${subject}`;

  const index = (account) => {
    accounts.set(account.id, account);
    byEmail.set(normalizeEmail(account.email), account.id);
    for (const identity of account.identities ?? []) {
      byIdentity.set(identityKey(identity.provider, identity.subject), account.id);
    }
  };

  async function load() {
    await mkdir(accountsDir, { recursive: true, mode: 0o700 });
    const entries = await readdir(accountsDir);
    let broken = 0;
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      try {
        const doc = JSON.parse(await readFile(path.join(accountsDir, entry), 'utf8'));
        if (doc?.id && doc?.email) index(doc);
        else broken += 1;
      } catch {
        // One unreadable account must not stop the portal opening; it stays on disk for
        // recovery by hand. The person it belongs to sees "wrong password", which is wrong
        // but safe — the alternative is a site that will not start.
        broken += 1;
      }
    }
    return { loaded: accounts.size, broken };
  }

  return {
    /** Read every document into memory. Safe to call more than once. */
    async init() {
      if (!ready) ready = load();
      return ready;
    },

    /** An account by id, or null. */
    async get(id) {
      const found = accounts.get(id);
      return found ? structuredClone(found) : null;
    },

    /** An account by address, or null. The address is normalized for you. */
    async getByEmail(email) {
      const id = byEmail.get(normalizeEmail(email));
      return id ? this.get(id) : null;
    },

    /** True when an address is already taken. */
    async emailTaken(email) {
      return byEmail.has(normalizeEmail(email));
    },

    /**
     * The account a provider identity belongs to, or null.
     *
     * This is the ONLY lookup that answers "who is this person" for a federated sign-in. An
     * email address from a provider is an attribute, not an identity.
     */
    async getByIdentity(provider, subject) {
      const id = byIdentity.get(identityKey(provider, subject));
      return id ? this.get(id) : null;
    },

    /** True when this provider identity is already attached to some account. */
    async identityTaken(provider, subject) {
      return byIdentity.has(identityKey(provider, subject));
    },

    /**
     * Attach a provider identity to an account, refusing if another account already holds it.
     *
     * The check and the write happen under one lock keyed on the identity, so two accounts
     * cannot claim the same Google subject by racing. Returns
     * `{ ok: true, account }` or `{ ok: false, reason }`.
     */
    async claimIdentity(accountId, identity) {
      const key = identityKey(identity.provider, identity.subject);
      /* Connecting a provider REPLACES whatever that provider had on this account, so the
         subject being displaced is claimed here too — read before the lock and re-read inside
         it, the same way releaseIdentity does. */
      const displaced = (accounts.get(accountId)?.identities ?? [])
        .filter((i) => i.provider === identity.provider)
        .map((i) => `identity:${identityKey(i.provider, i.subject)}`);

      /* The identity key makes the claim exclusive; the account key makes the WRITE exclusive.
         Holding only the first is what used to lose the link to a concurrent session write. */
      return withLocks([`identity:${key}`, `id:${accountId}`, ...displaced], async () => {
        const heldBy = byIdentity.get(key);
        if (heldBy && heldBy !== accountId) return { ok: false, reason: 'identity-taken' };

        const current = accounts.get(accountId);
        if (!current) return { ok: false, reason: 'no-such-account' };

        const next = structuredClone(current);
        const removed = (next.identities ?? []).filter(
          (i) => i.provider === identity.provider && identityKey(i.provider, i.subject) !== key,
        );
        next.identities = [...(next.identities ?? []).filter((i) => i.provider !== identity.provider), identity];
        next.updatedAt = new Date().toISOString();

        await persist(next);
        /* `index` only ever ADDS, so a subject this call displaced has to be retired by hand.
           Left in place it goes on resolving to this account for good — meaning somebody
           signing in with the Google account that was DISCONNECTED would still be let in. */
        for (const gone of removed) byIdentity.delete(identityKey(gone.provider, gone.subject));
        index(next);
        return { ok: true, account: structuredClone(next) };
      });
    },

    /**
     * Detach a provider identity. Returns `{ ok: true, account }` or `{ ok: false, reason }`.
     *
     * `requireAnotherWayIn` makes the removal CONDITIONAL: it happens only if the account will
     * still have a password or another identity once it is gone.
     *
     * WHETHER to require that is still service.mjs's decision — it is the layer that knows
     * there is no password-reset flow to rescue somebody who is locked out. WHERE it is
     * enforced has to be here, and that is the whole point of this parameter. The service used
     * to read the account, decide it was safe, and then call this; two unlinks of two
     * DIFFERENT providers could interleave between the reading and the calling, each see two
     * identities, each conclude one would remain, and both proceed — leaving an account with
     * no password, no identities, and no way back in. Only the store can make the counting and
     * the removal one operation, so only the store can close that window.
     */
    async releaseIdentity(accountId, provider, { requireAnotherWayIn = false } = {}) {
      /* Which identity keys are about to be freed is read before the lock and re-read inside
         it. A stale guess only ever costs an extra key held for a moment; the release itself
         is decided from `current`, under the lock. */
      const guess = (accounts.get(accountId)?.identities ?? [])
        .filter((i) => i.provider === provider)
        .map((i) => `identity:${identityKey(i.provider, i.subject)}`);

      return withLocks([`id:${accountId}`, ...guess], async () => {
        const current = accounts.get(accountId);
        if (!current) return { ok: false, reason: 'no-such-account' };

        const identities = current.identities ?? [];
        if (!identities.some((i) => i.provider === provider)) return { ok: false, reason: 'not-linked' };

        /* Counted from `current`, INSIDE the lock, so it is the account as it is now rather
           than as some earlier caller found it. Every other writer of this document holds
           `id:<accountId>` too, so nothing can slip between this count and the write below. */
        if (requireAnotherWayIn) {
          const hasPassword = typeof current.password === 'string' && current.password.length > 0;
          if (!hasPassword && identities.length <= 1) return { ok: false, reason: 'last-way-in' };
        }

        const next = structuredClone(current);
        const removed = (next.identities ?? []).filter((i) => i.provider === provider);
        next.identities = (next.identities ?? []).filter((i) => i.provider !== provider);
        next.updatedAt = new Date().toISOString();

        await persist(next);
        for (const identity of removed) byIdentity.delete(identityKey(identity.provider, identity.subject));
        index(next);
        return { ok: true, account: structuredClone(next) };
      });
    },

    /**
     * Insert a new account, refusing an address that already has one.
     *
     * Returns `{ ok: true, account }` or `{ ok: false, reason: 'email-taken' }`. A taken
     * address is an expected outcome of a public form, not an exception.
     */
    async create(account) {
      /* Every value this document is about to claim, plus the document itself. A sign-up that
         arrives carrying identities claims those too, in one acquisition. */
      const keys = [
        `email:${normalizeEmail(account.email)}`,
        `id:${account.id}`,
        ...(account.identities ?? []).map((i) => `identity:${identityKey(i.provider, i.subject)}`),
      ];
      return withLocks(keys, async () => {
        if (byEmail.has(normalizeEmail(account.email))) return { ok: false, reason: 'email-taken' };
        if (accounts.has(account.id)) return { ok: false, reason: 'id-taken' };
        for (const identity of account.identities ?? []) {
          if (byIdentity.has(identityKey(identity.provider, identity.subject))) {
            return { ok: false, reason: 'identity-taken' };
          }
        }
        await persist(account);
        index(account);
        return { ok: true, account: structuredClone(account) };
      });
    },

    /**
     * Read-modify-write under a per-account lock. `mutate` receives a copy and returns the
     * new document; a falsy return aborts the update and leaves the store untouched.
     *
     * The account's CURRENT address and identities are locked alongside its id, because this
     * method maintains both uniqueness indexes below and a concurrent `create` or
     * `claimIdentity` for one of those values would otherwise be indexing the same key at the
     * same moment. Which keys those are is read before the lock, so it is re-checked after —
     * if another writer moved them in between, the whole acquisition is retried against the
     * new set rather than proceeding while holding the wrong ones.
     */
    async update(id, mutate) {
      const keysFor = (doc) => [
        `id:${id}`,
        `email:${normalizeEmail(doc.email)}`,
        ...(doc.identities ?? []).map((i) => `identity:${identityKey(i.provider, i.subject)}`),
      ];

      for (let attempt = 0; attempt < 8; attempt += 1) {
        const before = accounts.get(id);
        if (!before) return null;

        const result = await withLocks(keysFor(before), async () => {
          const current = accounts.get(id);
          if (!current) return { done: true, value: null };
          /* Someone changed an indexed value while we were queuing, so the keys we are holding
             are not the ones this document needs. Drop them and take the right ones. */
          const held = new Set(keysFor(before));
          if (keysFor(current).some((key) => !held.has(key))) return { done: false };

          const next = await mutate(structuredClone(current));
          if (!next) return { done: true, value: null };

          /* A mutation that claims an address or identity this call is not holding cannot be
             indexed safely here — the uniqueness check belongs to `create`/`claimIdentity`,
             which take those keys. Refusing loudly beats corrupting an index quietly. */
          const claimed = keysFor(next).filter((key) => !held.has(key));
          if (claimed.length) {
            throw new Error(
              `update() may not claim a new indexed value (${claimed.join(', ')}); ` +
                'use create() or claimIdentity(), which lock it.',
            );
          }

          await persist(next);
          // An address change has to move the index entry, or the old address keeps resolving.
          const previousEmail = normalizeEmail(current.email);
          if (previousEmail !== normalizeEmail(next.email)) byEmail.delete(previousEmail);
          // Likewise for an identity that this update dropped.
          const kept = new Set((next.identities ?? []).map((i) => identityKey(i.provider, i.subject)));
          for (const identity of current.identities ?? []) {
            const key = identityKey(identity.provider, identity.subject);
            if (!kept.has(key)) byIdentity.delete(key);
          }
          index(next);
          return { done: true, value: structuredClone(next) };
        });

        if (result.done) return result.value;
      }

      /* Eight acquisitions in a row all found the indexed values moved under them. That is not
         contention on a real deployment; it is a bug, and looping forever would hide it. */
      throw new Error(`update(${id}) could not obtain a stable set of index locks.`);
    },

    /* ── Password reset ─────────────────────────────────────────────────────────────────
     *
     * One outstanding reset per account, held on the document as `passwordReset`. Asking again
     * REPLACES it, so the newest link is the only one that works and an older mail sitting in
     * an inbox is already dead.
     */

    /** Record a reset request, replacing any outstanding one. */
    async issuePasswordReset(accountId, record) {
      return withLock(`id:${accountId}`, async () => {
        const current = accounts.get(accountId);
        if (!current) return { ok: false, reason: 'no-such-account' };

        const next = structuredClone(current);
        next.passwordReset = { ...record };
        next.updatedAt = new Date().toISOString();

        await persist(next);
        index(next);
        return { ok: true };
      });
    },

    /**
     * Spend a reset token and set the new password, or refuse — as ONE operation.
     *
     * ATOMICITY IS THE POINT OF THIS METHOD EXISTING. Checking a token in the service and then
     * asking the store to write is the shape that made `unlinkProvider` unsafe: two requests
     * carrying the same link, arriving together, would both find it valid and both spend it.
     * Everything here happens under the account's own lock, which every other writer of this
     * document also takes, so the second of two redemptions finds the token gone.
     *
     * `matches` is passed in rather than the digest compared here, so the constant-time
     * comparison stays in resetTokens.mjs where the rest of the token handling lives.
     *
     * Returns `{ ok: true, account }` or `{ ok: false, reason }` where reason is
     * 'no-such-account' | 'no-reset' | 'expired' | 'token-mismatch' | 'not-active'.
     */
    async redeemPasswordReset(accountId, { tokenHash, password, matches, now = new Date() } = {}) {
      return withLock(`id:${accountId}`, async () => {
        const current = accounts.get(accountId);
        if (!current) return { ok: false, reason: 'no-such-account' };
        if (current.status !== 'active') return { ok: false, reason: 'not-active' };

        const reset = current.passwordReset;
        if (!reset?.tokenHash) return { ok: false, reason: 'no-reset' };
        if (new Date(reset.expiresAt).getTime() <= now.getTime()) return { ok: false, reason: 'expired' };
        if (!matches(tokenHash, reset.tokenHash)) return { ok: false, reason: 'token-mismatch' };

        const next = structuredClone(current);
        next.password = password;
        /* WE sent mail to this address and somebody proved they read it. That is exactly what
           this flag was reserved for. It changes no access decision today — federated linking
           still matches on the provider's subject and never on an address; see the rules in
           service.mjs, which are deliberately untouched. */
        next.emailVerified = true;
        // A password change ends every session, everywhere. That is not optional.
        next.sessions = [];
        /* Single use: the token is gone whether or not anyone still holds a copy of the link.
           Deleted rather than nulled, so a document with no outstanding reset has no key at all
           and round-trips identically through the D1 store, which has no row to read. */
        delete next.passwordReset;
        next.updatedAt = now.toISOString();

        await persist(next);
        index(next);
        return { ok: true, account: structuredClone(next) };
      });
    },

    /** Drop any outstanding reset — what a successful ordinary sign-in does. */
    async clearPasswordReset(accountId) {
      return withLock(`id:${accountId}`, async () => {
        const current = accounts.get(accountId);
        if (!current?.passwordReset) return { ok: false, reason: 'no-reset' };

        const next = structuredClone(current);
        delete next.passwordReset;
        next.updatedAt = new Date().toISOString();

        await persist(next);
        index(next);
        return { ok: true };
      });
    },

    /** True when this id exists. Used by id generation. */
    async has(id) {
      return accounts.has(id);
    },

    /** How many accounts exist. No addresses, no ids — safe for an operational counter. */
    async count() {
      return accounts.size;
    },
  };
}
