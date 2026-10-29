-- Migration 0002: two-step verification (authenticator app + recovery codes).
--
-- ADDITIVE ONLY. One new table; no existing table or row is altered, so it is safe to apply to
-- the live shared `nova-help` database while Nova.Help is running. Re-running is a no-op. Code
-- that predates it never reads this table, and the stores treat "no such table" as "nobody has
-- enrolled", so deploying code first and applying this afterwards is also safe - enrolling just
-- fails loudly until it exists.
--
-- The secret is stored SEALED, never in the clear, and recovery codes only as keyed digests;
-- see mfa.mjs. `data` is JSON, `version` is the compare-and-swap counter.
--
-- ON DELETE CASCADE: deleting an account removes its row.
--
-- Apply (when a deployment is approved, not before):
--   npx wrangler d1 execute nova-help --remote --file packages/nova-accounts/migrations/0002_account_mfa.sql
-- Roll back (this signs nobody out; anyone enrolled simply stops being asked for a code):
--   DROP TABLE account_mfa;

-- Two-step verification: the whole record as JSON - a SEALED (AES-256-GCM) TOTP secret, hashed
-- recovery codes, and the attempt counters. Added by migrations/0002_account_mfa.sql, which is
-- the same statement for a live database. `version` makes every write a compare-and-swap.
CREATE TABLE IF NOT EXISTS account_mfa (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL DEFAULT 1,
  data       TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);
