/**
 * Sync documents — the one thing a Nova Account actually gives a product.
 *
 * A sync document is one JSON blob per (account, product): Open Cut's preferences, Atlas's
 * pinned skills, Online Earth's saved places. Nova Accounts stores it and versions it and has
 * no idea what is inside, which is deliberate — the moment this module knows what a saved
 * place is, every product's schema becomes an identity-service migration.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THE RULE THIS MODULE EXISTS TO ENFORCE: NOTHING IS EVER SILENTLY OVERWRITTEN.
 *
 * The failure mode of every naive sync is the same: you sign in on a second machine, the empty
 * client pushes, and a year of settings is gone. So a write is CONDITIONAL. The client sends
 * the version it based its edit on; if the server has moved on, the write is refused and the
 * server's current document comes back with the refusal, so the client can merge and try
 * again. There is no unconditional write in this API and adding one would remove the only
 * protection local data has.
 *
 *   client                                   server
 *   ──────                                   ──────
 *   GET  → { version: 4, data }
 *   ...edits...
 *   PUT  { baseVersion: 4, data } →          version is 4 → stored as 5 → { ok, version: 5 }
 *   PUT  { baseVersion: 4, data } →          version is 7 → { ok: false, reason: 'conflict',
 *                                                              current: { version: 7, data } }
 *
 * `baseVersion: 0` means "I have never synced". It is NOT a wildcard: it succeeds only when
 * the server genuinely has nothing, so a fresh install cannot flatten an existing document by
 * claiming ignorance. A client that finds a conflict at version 0 has discovered exactly the
 * situation a person needs to be asked about — "this account already has settings; keep the
 * ones on this machine, or take the ones from your account?" — which is a question for the
 * product's UI, not a decision for this file.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHAT IS DELIBERATELY NOT HERE.
 *
 * No merge, no CRDT, no field-level history. This is the smallest thing that cannot lose data,
 * and the products that use it today sync preference blobs a person edits on one machine at a
 * time. When something needs a real merge it should get one — built on top of this, with the
 * conflict that this API already reports as its input.
 */

/**
 * A cap on one document, so an account cannot become a free object store.
 *
 * Preferences are kilobytes. A product that needs megabytes is not syncing preferences and
 * should be asking a different question.
 */
export const SYNC_DOCUMENT_LIMIT = 256 * 1024;

/** Reasons a write can be refused, as a client sees them. */
export const SYNC_REFUSALS = Object.freeze(['conflict', 'too-large', 'not-json', 'no-such-account']);

/**
 * Check a document before it is stored.
 *
 * Returns `{ ok: true, encoded }` — the exact bytes to store, encoded ONCE here so that the
 * size that was checked is the size that is written. Encoding again downstream would be a
 * second chance to exceed the limit.
 */
export function encodeSyncDocument(data) {
  let encoded;
  try {
    encoded = JSON.stringify(data ?? null);
  } catch {
    // Cycles, BigInts, and anything else that is not a JSON value.
    return { ok: false, reason: 'not-json' };
  }
  if (typeof encoded !== 'string') return { ok: false, reason: 'not-json' };
  if (Buffer.byteLength(encoded, 'utf8') > SYNC_DOCUMENT_LIMIT) return { ok: false, reason: 'too-large' };
  return { ok: true, encoded };
}

/** Read stored bytes back. A document that will not parse reads as nothing, never as a throw. */
export function decodeSyncDocument(encoded) {
  if (typeof encoded !== 'string') return null;
  try {
    return JSON.parse(encoded);
  } catch {
    return null;
  }
}

/**
 * The sync half of the account service.
 *
 * Split out of deviceService.mjs because it answers a different question — that one is "who is
 * this", this one is "what have they saved" — and because a product may hold a token with
 * `identity` and no `sync` at all, in which case none of this is reachable for it.
 */
export function createSyncService({ store }) {
  return {
    /**
     * This product's document for this account.
     *
     * An account that has never synced reads as `{ version: 0, data: null }` rather than as an
     * error: "nothing saved yet" is the normal first answer, not a failure, and a client that
     * has to distinguish 404-from-empty is a client that will get it wrong.
     */
    async readSyncDocument({ accountId, product }) {
      const found = await store.getSyncDocument(accountId, product);
      if (!found) return { ok: true, version: 0, data: null, updatedAt: null };
      return {
        ok: true,
        version: found.version,
        data: decodeSyncDocument(found.document),
        updatedAt: found.updatedAt,
      };
    },

    /**
     * Store a document, IF the client's base version is still current.
     *
     * On refusal the caller gets the server's document back alongside the reason, because the
     * only useful thing a client can do with a conflict is look at what it lost the race to.
     */
    async writeSyncDocument({ accountId, product, baseVersion, data, now = new Date() }) {
      const encoded = encodeSyncDocument(data);
      if (!encoded.ok) return encoded;

      const base = Number.isInteger(baseVersion) ? baseVersion : Number.NaN;
      if (!Number.isInteger(base) || base < 0) return { ok: false, reason: 'conflict', ...(await this.readSyncDocument({ accountId, product })) };

      const written = await store.putSyncDocument(accountId, product, {
        baseVersion: base,
        document: encoded.encoded,
        now,
      });
      if (written.ok) return { ok: true, version: written.version, updatedAt: written.updatedAt };

      if (written.reason === 'conflict') {
        const current = await this.readSyncDocument({ accountId, product });
        return { ok: false, reason: 'conflict', current };
      }
      return written;
    },

    /**
     * Delete this product's document.
     *
     * NOT part of sign-out, and not part of revoking a device: signing an app out must not
     * reach across and delete what is stored for it, or "sign out" becomes a data-loss button.
     * This is only ever called because somebody asked for it in as many words.
     */
    async deleteSyncDocument({ accountId, product }) {
      return store.deleteSyncDocument(accountId, product);
    },
  };
}
