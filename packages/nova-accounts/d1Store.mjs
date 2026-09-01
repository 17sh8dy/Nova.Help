/**
 * The account store on Cloudflare D1 — the same methods as accounts/store.mjs.
 *
 * NOTHING HERE IMPORTS FROM OUTSIDE server/accounts/. That is the rule at the top of
 * index.mjs and it is why this file re-states a little D1 plumbing that server/store/ also
 * has: the day Nova Accounts moves out as a package, this directory has to leave whole. A
 * shared helper twenty lines long is not worth turning that move into a rewrite. The database
 * itself arrives as a binding from the caller, so this file never knows whose D1 it is.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHAT REPLACED THE LOCKS.
 *
 * The JSON store upheld one address per account and one provider identity per account with
 * two in-memory Maps and a lock around the check. On Workers there is no single process to
 * hold a Map and no boot at which to build one, so both are UNIQUE indexes now and the
 * check-then-act is gone: `create` and `claimIdentity` INSERT, and a conflict is the
 * database's answer rather than a race this file has to win. That is stronger than the locks
 * were, and it is what fixes the interleaving that used to lose a Google link.
 *
 * WHAT IS GUARDED AND WHAT IS NOT — the same distinction the ticket store draws.
 *
 *   DECISIONS carry `version`: the password, the status, the address, verification. Each is
 *   changed on the strength of what was read, so it must fail rather than apply on top of
 *   state it never saw.
 *
 *   FACTS do not: opening a session, closing one, recording that a product was used. Each is
 *   a row appearing or disappearing on its own terms. Two devices signing in at the same
 *   instant are not in conflict — they are two sessions — and making them retry against each
 *   other is how one of them ends up holding a token for a session that was never recorded.
 *
 * `updated_at` is excluded from the comparison, because every write touches it and guarding on
 * it would make every write a decision.
 *
 * THE MUTATOR CONTRACT: `update()` may run its mutator more than once, so a mutator must be a
 * pure function of the document. Assigning to a variable in the enclosing scope is fine, since
 * a re-run overwrites it; appending to one is not.
 */

/** Matches accounts/validation.mjs. Restated rather than imported, per the rule above. */
const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase();

const isUniqueViolation = (error) => /UNIQUE constraint failed/i.test(String(error?.message ?? ''));

/** Which column a uniqueness failure was about, so a caller gets the reason it expects. */
const conflictReason = (error) => {
  const message = String(error?.message ?? '');
  if (/email_normalized/.test(message)) return 'email-taken';
  if (/account_identities/.test(message)) return 'identity-taken';
  if (/accounts\.id/.test(message)) return 'id-taken';
  return 'conflict';
};

const ACCOUNT_COLUMNS = `
  id, version, schema_version, created_at, updated_at, email, email_normalized,
  email_verified, display_name, password, status`;

const accountValues = (account, version) => [
  account.id,
  version,
  account.schemaVersion ?? 1,
  account.createdAt,
  account.updatedAt,
  account.email,
  normalizeEmail(account.email),
  account.emailVerified ? 1 : 0,
  account.displayName ?? null,
  account.password ?? null,
  account.status ?? 'active',
];

function toDocument(row, sessionRows, identityRows, productRows, resetRow = null) {
  const products = {};
  for (const product of productRows) products[product.product] = { firstSeenAt: product.first_seen_at };

  return {
    /* Present only when there IS an outstanding reset, so an account with none has no key at
       all — which is what the JSON store's document looks like, and the contract compares the
       two documents field for field. */
    ...(resetRow
      ? {
          passwordReset: {
            tokenHash: resetRow.token_hash,
            requestedAt: resetRow.requested_at,
            expiresAt: resetRow.expires_at,
          },
        }
      : {}),
    id: row.id,
    schemaVersion: row.schema_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    email: row.email,
    emailVerified: Boolean(row.email_verified),
    displayName: row.display_name,
    password: row.password,
    status: row.status,
    sessions: sessionRows.map((s) => ({
      id: s.id,
      createdAt: s.created_at,
      expiresAt: s.expires_at,
      product: s.product,
    })),
    identities: identityRows.map((i) => ({
      provider: i.provider,
      subject: i.subject,
      email: i.email,
      emailVerified: Boolean(i.email_verified),
      linkedAt: i.linked_at,
      /* Present only when it has been set, so a document written without it round-trips
         unchanged rather than growing a null the JSON store never had. */
      ...(i.last_used_at === null || i.last_used_at === undefined ? {} : { lastUsedAt: i.last_used_at }),
    })),
    products,
  };
}

const sessionValues = (accountId, session) => [
  accountId,
  session.id,
  session.createdAt ?? new Date().toISOString(),
  session.expiresAt,
  session.product ?? null,
];

const identityValues = (accountId, identity) => [
  accountId,
  identity.provider,
  identity.subject,
  identity.email ?? null,
  identity.emailVerified ? 1 : 0,
  identity.linkedAt,
  identity.lastUsedAt ?? null,
];

const INSERT_IDENTITY = `
  INSERT INTO account_identities
    (account_id, provider, subject, email, email_verified, linked_at, last_used_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)`;

const INSERT_SESSION = `
  INSERT INTO account_sessions (account_id, id, created_at, expires_at, product)
  VALUES (?, ?, ?, ?, ?)`;

export function createD1AccountStore({ db, retries = 5 }) {
  const readStatements = (id) => [
    db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ?`).bind(id),
    db.prepare('SELECT * FROM account_sessions WHERE account_id = ? ORDER BY created_at ASC, id ASC').bind(id),
    db.prepare('SELECT * FROM account_identities WHERE account_id = ? ORDER BY provider ASC').bind(id),
    db.prepare('SELECT * FROM account_products WHERE account_id = ? ORDER BY product ASC').bind(id),
    db.prepare('SELECT * FROM account_password_resets WHERE account_id = ?').bind(id),
  ];

  async function readWithVersion(id) {
    if (!id) return null;
    const [account, sessions, identities, products, resets] = await db.batch(readStatements(id));
    const row = account.results[0];
    if (!row) return null;
    return {
      version: row.version,
      doc: toDocument(row, sessions.results, identities.results, products.results, resets.results[0] ?? null),
    };
  }

  const idFor = async (sql, ...values) => db.prepare(sql).bind(...values).first('account_id');

  return {
    /**
     * There is nothing to load. The count is read so the boot line can still say how many
     * accounts exist; `broken` is always 0, because an unparseable document is a JSON-file
     * failure mode and this store has none.
     */
    async init() {
      const loaded = await db.prepare('SELECT COUNT(*) AS n FROM accounts').first('n');
      return { loaded: Number(loaded ?? 0), broken: 0 };
    },

    async get(id) {
      const found = await readWithVersion(id);
      return found ? found.doc : null;
    },

    async getByEmail(email) {
      const id = await idFor(
        'SELECT id AS account_id FROM accounts WHERE email_normalized = ?',
        normalizeEmail(email),
      );
      return id ? this.get(id) : null;
    },

    async emailTaken(email) {
      return Boolean(
        await db
          .prepare('SELECT 1 AS ok FROM accounts WHERE email_normalized = ?')
          .bind(normalizeEmail(email))
          .first('ok'),
      );
    },

    /**
     * The account a provider identity belongs to, or null.
     *
     * The ONLY lookup that answers "who is this person" for a federated sign-in. An email
     * address from a provider is an attribute, not an identity.
     */
    async getByIdentity(provider, subject) {
      const id = await idFor(
        'SELECT account_id FROM account_identities WHERE provider = ? AND subject = ?',
        provider,
        subject,
      );
      return id ? this.get(id) : null;
    },

    async identityTaken(provider, subject) {
      return Boolean(
        await db
          .prepare('SELECT 1 AS ok FROM account_identities WHERE provider = ? AND subject = ?')
          .bind(provider, subject)
          .first('ok'),
      );
    },

    /**
     * Attach a provider identity, refusing if another account already holds it.
     *
     * There is no check-then-act here any more: the INSERT either lands or the primary key on
     * (provider, subject) refuses it. Two accounts racing for one Google subject cannot both
     * win, and this file does not have to be the thing that ensures it.
     */
    async claimIdentity(accountId, identity) {
      const account = await readWithVersion(accountId);
      if (!account) return { ok: false, reason: 'no-such-account' };

      const holder = await idFor(
        'SELECT account_id FROM account_identities WHERE provider = ? AND subject = ?',
        identity.provider,
        identity.subject,
      );
      if (holder && holder !== accountId) return { ok: false, reason: 'identity-taken' };
      if (holder === accountId) return { ok: true, account: account.doc };

      try {
        await db.batch([
          /* "Connect Google" replaces whatever Google identity this account had, which is what
             the UNIQUE (account_id, provider) index means. */
          db
            .prepare('DELETE FROM account_identities WHERE account_id = ? AND provider = ?')
            .bind(accountId, identity.provider),
          db.prepare(INSERT_IDENTITY).bind(...identityValues(accountId, identity)),
          db.prepare('UPDATE accounts SET updated_at = ? WHERE id = ?').bind(new Date().toISOString(), accountId),
        ]);
      } catch (error) {
        // Lost the race to another account between the read above and this write.
        if (isUniqueViolation(error)) return { ok: false, reason: 'identity-taken' };
        throw error;
      }

      const after = await readWithVersion(accountId);
      return after ? { ok: true, account: after.doc } : { ok: false, reason: 'no-such-account' };
    },

    /**
     * Detach a provider identity. Returns `{ ok: true, account }` or `{ ok: false, reason }`.
     *
     * `requireAnotherWayIn` makes the removal CONDITIONAL, and the condition is written into
     * the DELETE rather than checked before it. That is the fix for a real race: the service
     * used to read the account, satisfy itself that another way in would remain, and then ask
     * for the removal. Two unlinks of two DIFFERENT providers could interleave in that gap —
     * each reading two identities, each concluding one would survive — and both would proceed,
     * leaving a passwordless account with nothing to sign in with and no reset flow to rescue
     * it.
     *
     * There is no lock to take here and no transaction to hold across a decision, so the
     * counting has to happen inside the statement that does the removing. A single SQL
     * statement is evaluated atomically, so the second of two concurrent deletes sees the
     * count the first one left behind: one identity, no password, condition false, nothing
     * removed. The `changes` count is then the answer to "did it happen", which is why this
     * is one statement rather than a batch.
     */
    async releaseIdentity(accountId, provider, { requireAnotherWayIn = false } = {}) {
      /* Guarded on the account still having a password, or an identity other than this one.
         `COUNT(*) > 1` is that second half: this identity plus at least one more. */
      const guard = requireAnotherWayIn
        ? `AND (
             EXISTS (SELECT 1 FROM accounts WHERE id = ? AND password IS NOT NULL AND password <> '')
             OR (SELECT COUNT(*) FROM account_identities WHERE account_id = ?) > 1
           )`
        : '';

      const removal = await db
        .prepare(`DELETE FROM account_identities WHERE account_id = ? AND provider = ? ${guard}`)
        .bind(accountId, provider, ...(requireAnotherWayIn ? [accountId, accountId] : []))
        .run();

      if (removal.meta.changes === 1) {
        await db
          .prepare('UPDATE accounts SET updated_at = ? WHERE id = ?')
          .bind(new Date().toISOString(), accountId)
          .run();
        const after = await readWithVersion(accountId);
        return after ? { ok: true, account: after.doc } : { ok: false, reason: 'no-such-account' };
      }

      /* Nothing was removed. Which of the three reasons it was does not affect the invariant —
         that is already safe — so this read is only to say something true to the person who
         pressed the button. */
      const after = await readWithVersion(accountId);
      if (!after) return { ok: false, reason: 'no-such-account' };
      if (!(after.doc.identities ?? []).some((i) => i.provider === provider)) {
        return { ok: false, reason: 'not-linked' };
      }
      return { ok: false, reason: 'last-way-in' };
    },

    /**
     * Insert a new account, refusing an address that already has one.
     *
     * Returns `{ ok: true, account }` or `{ ok: false, reason }`. A taken address is an
     * expected outcome of a public form, not an exception — and it is now decided by a UNIQUE
     * index rather than by a lock, so two simultaneous sign-ups cannot both be told they won.
     */
    async create(account) {
      const holes = accountValues(account, 1).map(() => '?').join(', ');
      try {
        await db.batch([
          db.prepare(`INSERT INTO accounts (${ACCOUNT_COLUMNS}) VALUES (${holes})`).bind(...accountValues(account, 1)),
          ...(account.sessions ?? []).map((session) =>
            db.prepare(INSERT_SESSION).bind(...sessionValues(account.id, session)),
          ),
          ...(account.identities ?? []).map((identity) =>
            db.prepare(INSERT_IDENTITY).bind(...identityValues(account.id, identity)),
          ),
          ...Object.entries(account.products ?? {}).map(([product, value]) =>
            db
              .prepare('INSERT INTO account_products (account_id, product, first_seen_at) VALUES (?, ?, ?)')
              .bind(account.id, product, value?.firstSeenAt ?? account.createdAt),
          ),
          ...(account.passwordReset
            ? [
                db
                  .prepare(
                    `INSERT INTO account_password_resets (account_id, token_hash, requested_at, expires_at)
                     VALUES (?, ?, ?, ?)`,
                  )
                  .bind(
                    account.id,
                    account.passwordReset.tokenHash,
                    account.passwordReset.requestedAt,
                    account.passwordReset.expiresAt,
                  ),
              ]
            : []),
        ]);
      } catch (error) {
        if (isUniqueViolation(error)) return { ok: false, reason: conflictReason(error) };
        throw error;
      }

      const created = await readWithVersion(account.id);
      return { ok: true, account: created.doc };
    },

    /**
     * Read-modify-write, checked rather than locked. See the header for what is guarded.
     *
     * Sessions and products are written as the rows they are — added and removed on their own
     * terms, without the version — so the common writes (signing in, signing out, recording a
     * product) never contend and never retry. Only a change to the account's own decidable
     * state carries the version and can be made to try again.
     */
    async update(id, mutate) {
      for (let attempt = 0; attempt < retries; attempt += 1) {
        const found = await readWithVersion(id);
        if (!found) return null;

        const { version, doc } = found;
        const next = await mutate(structuredClone(doc));
        if (!next) return null;

        const statements = [];

        /* ── Sessions: facts ─────────────────────────────────────────────────────────────
         * Emptying the list entirely is "sign out everywhere", and it has to mean everywhere:
         * a targeted diff would spare a session opened while this one was being decided, which
         * is precisely the session such a person is trying to kill. */
        const had = new Map((doc.sessions ?? []).map((s) => [s.id, s]));
        const has = new Map((next.sessions ?? []).map((s) => [s.id, s]));

        if (!has.size) {
          /* Not `had.size && !has.size`: the mutator asserted that no session should exist,
             and that has to hold against rows this call never read, not merely against the
             ones it did. */
          statements.push(db.prepare('DELETE FROM account_sessions WHERE account_id = ?').bind(id));
        } else {
          const gone = [...had.keys()].filter((sessionId) => !has.has(sessionId));
          if (gone.length) {
            statements.push(
              db
                .prepare(
                  `DELETE FROM account_sessions WHERE account_id = ? AND id IN (${gone.map(() => '?').join(', ')})`,
                )
                .bind(id, ...gone),
            );
          }
          for (const [sessionId, session] of has) {
            if (!had.has(sessionId)) {
              statements.push(db.prepare(INSERT_SESSION).bind(...sessionValues(id, session)));
            }
          }
        }

        /* ── Products: facts, and additive only ──────────────────────────────────────────
         * The service never removes one -- `touchProduct` is `??=`, so a first-seen date is
         * written once and then left alone -- and neither does this. The upsert persists
         * exactly what the mutator returned rather than second-guessing it: keeping the
         * earliest date is the service's rule to hold, not the store's to impose. */
        for (const [product, value] of Object.entries(next.products ?? {})) {
          const before = doc.products?.[product];
          if (before && before.firstSeenAt === value?.firstSeenAt) continue;
          statements.push(
            db
              .prepare(
                `INSERT INTO account_products (account_id, product, first_seen_at) VALUES (?, ?, ?)
                 ON CONFLICT (account_id, product) DO UPDATE SET first_seen_at = excluded.first_seen_at`,
              )
              .bind(id, product, value?.firstSeenAt ?? new Date().toISOString()),
          );
        }

        /* ── Identities: refreshed in place ──────────────────────────────────────────────
         * `update` may refresh what an identity says about itself — the address it asserts,
         * when it was last used. CLAIMING one is claimIdentity's job, because that is the
         * write the uniqueness index has to arbitrate. Dropping one is releaseIdentity's. */
        const identitiesBefore = new Map((doc.identities ?? []).map((i) => [`${i.provider}:${i.subject}`, i]));
        for (const identity of next.identities ?? []) {
          const key = `${identity.provider}:${identity.subject}`;
          const before = identitiesBefore.get(key);
          if (!before) {
            throw new Error(
              `update(${id}) added identity ${key}; use claimIdentity(), which the uniqueness index arbitrates.`,
            );
          }
          if (JSON.stringify(identityValues(id, before)) === JSON.stringify(identityValues(id, identity))) continue;
          statements.push(
            db
              .prepare(
                `UPDATE account_identities
                 SET email = ?, email_verified = ?, linked_at = ?, last_used_at = ?
                 WHERE provider = ? AND subject = ?`,
              )
              .bind(
                identity.email ?? null,
                identity.emailVerified ? 1 : 0,
                identity.linkedAt,
                identity.lastUsedAt ?? null,
                identity.provider,
                identity.subject,
              ),
          );
        }
        for (const key of identitiesBefore.keys()) {
          const stillThere = (next.identities ?? []).some((i) => `${i.provider}:${i.subject}` === key);
          if (!stillThere) {
            throw new Error(`update(${id}) removed identity ${key}; use releaseIdentity().`);
          }
        }

        /* ── An outstanding reset is not this method's to move ───────────────────────────
         * It lives in its own table with its own atomic redemption, and a mutator that
         * changed it here would be writing to a column this statement does not touch — the
         * change would vanish while the returned document showed it applied. */
        if (JSON.stringify(next.passwordReset ?? null) !== JSON.stringify(doc.passwordReset ?? null)) {
          throw new Error(
            `update(${id}) changed passwordReset; use issuePasswordReset(), redeemPasswordReset() or clearPasswordReset().`,
          );
        }

        /* ── The account row: a decision, if anything but the timestamp moved ────────────── */
        const columns = (which) => JSON.stringify(accountValues(which, 0).filter((_, i) => i !== 4));
        const decided = columns(next) !== columns(doc);

        if (!decided) {
          statements.push(
            db
              .prepare('UPDATE accounts SET updated_at = ? WHERE id = ?')
              .bind(next.updatedAt ?? new Date().toISOString(), id),
          );
          if (statements.length) await db.batch(statements);
          return next;
        }

        statements.push(
          db
            .prepare(
              `UPDATE accounts SET
                 version = version + 1,
                 schema_version = ?, created_at = ?, updated_at = ?,
                 email = ?, email_normalized = ?, email_verified = ?,
                 display_name = ?, password = ?, status = ?
               WHERE id = ? AND version = ?`,
            )
            /* `slice(2)` drops `id` and `version`: one is the key, the other is bumped here. */
            .bind(...accountValues(next, 0).slice(2), id, version),
        );

        let results;
        try {
          results = await db.batch(statements);
        } catch (error) {
          /* Changing an address onto one somebody else holds. The service checks first, so
             this is the race rather than the ordinary path, and it must not read as success. */
          if (isUniqueViolation(error)) throw new Error(`update(${id}) failed: ${conflictReason(error)}`);
          throw error;
        }

        if (results.at(-1).meta.changes === 1) return next;
      }

      throw new Error(
        `update(${id}) could not commit after ${retries} attempts; the account is being written to concurrently.`,
      );
    },

    /* ── Password reset ─────────────────────────────────────────────────────────────────
     *
     * One outstanding reset per account — the primary key is the account id — so asking again
     * REPLACES it and an older link sitting in an inbox is already dead. What is stored is a
     * digest; a copy of this table is not a set of working links.
     */

    /** Record a reset request, replacing any outstanding one. */
    async issuePasswordReset(accountId, record) {
      if (!(await this.has(accountId))) return { ok: false, reason: 'no-such-account' };

      await db
        .prepare(
          `INSERT INTO account_password_resets (account_id, token_hash, requested_at, expires_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (account_id) DO UPDATE SET
             token_hash = excluded.token_hash,
             requested_at = excluded.requested_at,
             expires_at = excluded.expires_at`,
        )
        .bind(accountId, record.tokenHash, record.requestedAt, record.expiresAt)
        .run();

      return { ok: true };
    },

    /**
     * Spend a reset token and set the new password, or refuse — as ONE operation.
     *
     * SINGLE USE IS WHAT THIS METHOD IS FOR, and it is why the check is not done in the service
     * and handed down as a decision. Two requests carrying the same link, arriving together,
     * must not both find it valid; checking first and writing second is exactly the shape that
     * made `unlinkProvider` unsafe.
     *
     * There is no lock to take and no transaction to hold across a decision, so every statement
     * carries the SAME guard — the reset row still exists, still matches, has not expired — and
     * the row itself is deleted LAST. A batch is one transaction, so either all four statements
     * commit or none do; the second redemption finds no row and changes nothing. `meta.changes`
     * on the account update is the answer to "did it happen".
     *
     * The digest is compared in SQL by equality rather than by `matches`, because a database
     * comparison is not a timing side channel a caller can observe: the row is found by account
     * id, and a mismatch and a match cost the same lookup. The constant-time comparison still
     * governs everywhere the JSON store does it.
     */
    async redeemPasswordReset(accountId, { tokenHash, password, now = new Date() } = {}) {
      const at = now.toISOString();
      /* Bound to every statement below. `expires_at > ?` is the expiry check and
         `token_hash = ?` is the match; both are part of the guard so a partial redemption is
         not expressible. */
      const guard = [accountId, tokenHash, at];

      const results = await db.batch([
        db
          .prepare(
            `UPDATE accounts SET
               password = ?,
               /* WE sent mail to this address and somebody proved they read it — the flag was
                  reserved for exactly this. It changes no access decision today; federated
                  linking still matches on the provider's subject and never on an address. */
               email_verified = 1,
               updated_at = ?,
               version = version + 1
             WHERE id = ? AND status = 'active'
               AND EXISTS (SELECT 1 FROM account_password_resets
                            WHERE account_id = ? AND token_hash = ? AND expires_at > ?)`,
          )
          .bind(password, at, accountId, ...guard),

        // A password change ends every session, everywhere. Same guard, so it cannot run alone.
        db
          .prepare(
            `DELETE FROM account_sessions
              WHERE account_id = ?
                AND EXISTS (SELECT 1 FROM account_password_resets
                             WHERE account_id = ? AND token_hash = ? AND expires_at > ?)`,
          )
          .bind(accountId, ...guard),

        /* The row goes LAST: the two statements above test for it, and deleting it first would
           make both of their guards false. */
        db
          .prepare(
            `DELETE FROM account_password_resets
              WHERE account_id = ? AND token_hash = ? AND expires_at > ?`,
          )
          .bind(...guard),
      ]);

      if (results[0].meta.changes === 1) {
        const after = await readWithVersion(accountId);
        return after ? { ok: true, account: after.doc } : { ok: false, reason: 'no-such-account' };
      }

      /* Nothing happened. Which of the reasons it was does not affect safety — the token was
         not spent and no password changed — so this read only exists to say something true. */
      const after = await readWithVersion(accountId);
      if (!after) return { ok: false, reason: 'no-such-account' };
      if (after.doc.status !== 'active') return { ok: false, reason: 'not-active' };

      const reset = after.doc.passwordReset;
      if (!reset) return { ok: false, reason: 'no-reset' };
      if (new Date(reset.expiresAt).getTime() <= now.getTime()) return { ok: false, reason: 'expired' };
      return { ok: false, reason: 'token-mismatch' };
    },

    /** Drop any outstanding reset — what a successful ordinary sign-in does. */
    async clearPasswordReset(accountId) {
      const removal = await db
        .prepare('DELETE FROM account_password_resets WHERE account_id = ?')
        .bind(accountId)
        .run();
      return removal.meta.changes === 1 ? { ok: true } : { ok: false, reason: 'no-reset' };
    },

    async has(id) {
      return Boolean(await db.prepare('SELECT 1 AS ok FROM accounts WHERE id = ?').bind(id).first('ok'));
    },

    /** For an operational counter. No addresses, no ids. */
    async count() {
      return Number(await db.prepare('SELECT COUNT(*) AS n FROM accounts').first('n'));
    },
  };
}
