-- Nova Accounts schema for D1.
--
-- THIS FILE BELONGS TO NOVA ACCOUNTS, NOT TO NOVA.HELP. There is no ticket in it and no column
-- that assumes a support portal, because the whole point of server/accounts/ is that it lifts
-- out as a package when a second Nova product needs to sign somebody in. A product appears
-- here only as a row in `account_products` -- a name and a date -- so adding the Launcher is an
-- INSERT and not a migration.
--
-- THE TWO UNIQUENESS INVARIANTS ARE CONSTRAINTS HERE, NOT CONVENTIONS.
--
-- In the JSON store, "one address, one account" and "one provider identity, one account" were
-- upheld by two in-memory Maps rebuilt at boot and a lock taken around the check. That model
-- cannot survive a Worker: there is no single process to hold the Map and no boot at which to
-- build it. As UNIQUE indexes the same rules are enforced by the database for every writer at
-- once, which is strictly stronger than what the locks achieved -- and it is why the
-- check-then-act in `create` and `claimIdentity` becomes an INSERT that either lands or
-- reports a conflict.

CREATE TABLE IF NOT EXISTS accounts (
  id               TEXT PRIMARY KEY,

  -- Guards the DECIDABLE state below: password, status, address, verification. Sessions and
  -- products are rows and are written without it; see the store for why that distinction is
  -- what keeps two devices signing in at once from starving each other.
  version          INTEGER NOT NULL DEFAULT 1,
  schema_version   INTEGER NOT NULL,

  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL,

  -- What they typed, kept for display and for sending to.
  email            TEXT    NOT NULL,
  -- What uniqueness is decided on. ONE ADDRESS, ONE ACCOUNT.
  email_normalized TEXT    NOT NULL UNIQUE,
  -- Whether WE have verified it. A provider asserting an address does not set this; see the
  -- linking rules in service.mjs for why that distinction is the whole security of OAuth here.
  email_verified   INTEGER NOT NULL DEFAULT 0,

  display_name     TEXT,
  -- A self-describing hash record, or NULL for an account that has only ever used a provider.
  -- NULL is meaningful: signIn refuses it, and must refuse it indistinguishably from a wrong
  -- password.
  password         TEXT,

  status           TEXT    NOT NULL DEFAULT 'active'
);

-- The authoritative list of live sessions. A session token is only honoured while its id is
-- still here, which is what makes signing out mean something a signed claim never could.
CREATE TABLE IF NOT EXISTS account_sessions (
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  id          TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  -- Which Nova product opened it. For a device session this is load-bearing: the product
  -- token names a product, and resolveProductToken refuses a token whose product does not
  -- match the row -- so a token minted for Open Cut cannot be presented as Atlas's.
  product     TEXT,

  -- 'web' for a browser cookie, 'device' for a product token held by an installed app.
  -- DEFAULT 'web' is what lets every session written before the device grant existed keep
  -- meaning exactly what it meant: resolveProductToken refuses anything that is not 'device'.
  kind        TEXT NOT NULL DEFAULT 'web',

  -- Space-separated, and the AUTHORITY on what this session may do. The token carries a copy
  -- so a scope check costs no I/O; the two are intersected on every request and the narrower
  -- wins, which is what makes a scope removed here take effect immediately. NULL for 'web',
  -- whose reach is decided by the route rather than by a grant.
  scopes      TEXT,

  -- What the person will see in "signed in on" -- a machine name the app offered. Shown to
  -- its owner and nobody else, and never trusted for anything.
  label       TEXT,

  PRIMARY KEY (account_id, id)
);

-- Lets a lapsed-session sweep find its work without scanning every account.
CREATE INDEX IF NOT EXISTS account_sessions_by_expiry ON account_sessions (expires_at);

CREATE TABLE IF NOT EXISTS account_identities (
  account_id     TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  provider       TEXT NOT NULL,
  -- The provider's own stable id for the person. THIS is the identity; the address below is
  -- an attribute of it and is never what grants access.
  subject        TEXT NOT NULL,

  email          TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  linked_at      TEXT NOT NULL,
  last_used_at   TEXT,

  -- ONE PROVIDER IDENTITY, ONE ACCOUNT.
  PRIMARY KEY (provider, subject),
  -- ...and one identity per provider per account, so "connect Google" replaces rather than
  -- accumulates, which is what the service already assumes.
  UNIQUE (account_id, provider)
);

CREATE INDEX IF NOT EXISTS account_identities_by_account ON account_identities (account_id);

-- An outstanding password reset. At most ONE per account: the primary key is the account, so
-- asking again replaces the previous request and an older link sitting in an inbox is already
-- dead. The row is deleted the moment a token is spent, which is what makes it single-use.
--
-- WHAT IS STORED IS A DIGEST, never the token. A copy of this table must not be a set of
-- working reset links, for the same reason `accounts.password` is a scrypt record.
CREATE TABLE IF NOT EXISTS account_password_resets (
  account_id   TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);

-- Lets an expiry sweep find dead requests without scanning every account.
CREATE INDEX IF NOT EXISTS account_password_resets_by_expiry ON account_password_resets (expires_at);

-- Which Nova products this account has been used with. Additive, never removed.
CREATE TABLE IF NOT EXISTS account_products (
  account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  product       TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,

  PRIMARY KEY (account_id, product)
);

-- A device authorization in flight: RFC 8628, for the Nova products that are installed
-- rather than visited. See deviceService.mjs for why that is the flow.
--
-- THIS TABLE IS SHORT-LIVED BY CONSTRUCTION. A row lives ten minutes and authorises one
-- sign-in; what survives is the session it produces, over in account_sessions. The JSON store
-- keeps the equivalent in memory for exactly that reason -- a Worker has no memory between
-- requests, which is the whole reason this is a table and that is a Map.
--
-- WHAT IS STORED IS A DIGEST OF THE DEVICE CODE, never the code. A copy of this table must not
-- be a set of sign-ins somebody can complete, for the same reason account_password_resets
-- holds a digest. The USER code is stored in the clear because it is a lookup key: it is what
-- a person types, and no digest can be typed into.
CREATE TABLE IF NOT EXISTS device_authorizations (
  id               TEXT PRIMARY KEY,

  -- sha256 of the secret half. UNIQUE so that redemption can be a single guarded UPDATE
  -- rather than a read followed by a write two pollers can interleave into.
  device_code_hash TEXT NOT NULL UNIQUE,
  -- The eight characters a person reads off one screen and types into another, normalized.
  -- UNIQUE, so two live grants can never share one and be approved into each other.
  user_code        TEXT NOT NULL UNIQUE,

  product          TEXT NOT NULL,
  scopes           TEXT NOT NULL,
  device_name      TEXT,

  -- 'pending' -> 'approved' | 'denied'. A row is DELETED when it is spent, which is what
  -- makes a grant single-use; there is no 'redeemed' state to be found lying around.
  status           TEXT NOT NULL DEFAULT 'pending',
  -- Written only by an approval, and only from the approving request's own session.
  account_id       TEXT REFERENCES accounts(id) ON DELETE CASCADE,

  created_at       TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  decided_at       TEXT,
  -- Last poll, so a client asking faster than the interval it was given gets `slow_down`.
  last_polled_at   TEXT
);

-- Lets the expiry sweep find dead grants without scanning the table.
CREATE INDEX IF NOT EXISTS device_authorizations_by_expiry ON device_authorizations (expires_at);

-- What a product has saved for an account: one JSON blob per (account, product).
--
-- NOVA ACCOUNTS DOES NOT KNOW WHAT IS IN IT, and that is the point -- the moment this table
-- has a column for a saved place, every product's schema becomes an identity-service
-- migration. It is a document, a version and a date.
--
-- `version` IS THE ONLY THING PROTECTING SOMEBODY'S LOCAL DATA. A write names the version it
-- was based on and lands only if that is still current, so a freshly installed client with an
-- empty document cannot flatten a year of settings by pushing first. See syncDocuments.mjs.
CREATE TABLE IF NOT EXISTS account_sync_documents (
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- A registered product id. One document each: Open Cut cannot read Atlas's, because the
  -- product half of the key comes from the TOKEN and never from the request body.
  product     TEXT NOT NULL,

  version     INTEGER NOT NULL DEFAULT 1,
  document    TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,

  PRIMARY KEY (account_id, product)
);
