-- Nova.Help ticket schema for D1.
--
-- THE SHAPE IS THE DOCUMENT IN core/tickets.mjs, NORMALISED. Everything the portal filters,
-- sorts or counts on is its own column with an index behind it; everything else is a column
-- too. Nothing is a JSON blob that the database cannot see into, because the two operations
-- that made the in-memory store untenable -- `list` and `counts` -- are exactly the ones a
-- blob would force back into application memory.
--
-- WHY events IS ITS OWN TABLE, which is the load-bearing decision here. In the JSON store an
-- event was appended by rewriting the whole ticket, so every reply was a read-modify-write and
-- needed a lock. As a row, a reply is a single INSERT that cannot collide with anything: a
-- reply is a FACT and is always recorded. Only a status transition is a DECISION, and only
-- that needs the version check. That is what turns "every write needs a lock" into "one write
-- in four needs a retry".
--
-- APPEND-ONLY IS ENFORCED, not merely documented: `seq` is part of the primary key, so a
-- second attempt to write event 4 of a ticket is a constraint violation rather than a silent
-- rewrite of history.

CREATE TABLE IF NOT EXISTS tickets (
  id                    TEXT PRIMARY KEY,

  -- The optimistic-concurrency guard. Every write that depends on what it read carries the
  -- version it read and fails, rather than clobbers, when someone else got there first.
  version               INTEGER NOT NULL DEFAULT 1,
  schema_version        INTEGER NOT NULL,

  created_at            TEXT    NOT NULL,
  updated_at            TEXT    NOT NULL,

  project               TEXT    NOT NULL,
  category              TEXT    NOT NULL,
  issue_type            TEXT    NOT NULL,

  subject               TEXT    NOT NULL,
  description           TEXT    NOT NULL,
  priority              TEXT    NOT NULL,
  status                TEXT    NOT NULL,

  requester_name        TEXT,
  requester_email       TEXT    NOT NULL,
  -- The lookup key for "my tickets by address". Filtering on a digest rather than on the
  -- address keeps the property the JSON store got from a constant-time compare: the index is
  -- probed with something the enquirer already knows, and holds nothing legible if read.
  requester_email_hash  TEXT    NOT NULL,

  -- The Nova Account that filed it, or NULL for a guest ticket. The ONLY thing that grants an
  -- account access; a matching address deliberately does not. See docs/NOVA-ACCOUNTS.md.
  account_id            TEXT,

  platform              TEXT,
  app_version           TEXT,

  assignee              TEXT,
  tags                  TEXT    NOT NULL DEFAULT '[]',

  routing_human_only    INTEGER NOT NULL DEFAULT 0,
  routing_reason        TEXT,

  source_channel        TEXT    NOT NULL,
  source_ip             TEXT
);

-- Every list the portal offers, in index form. `created_at DESC, id DESC` is repeated in each
-- one because every list is newest-first and paged, and an index that stops short of the sort
-- leaves D1 sorting the whole match in memory to serve page one.
CREATE INDEX IF NOT EXISTS tickets_by_account ON tickets (account_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS tickets_by_email   ON tickets (requester_email_hash, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS tickets_by_status  ON tickets (status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS tickets_by_project ON tickets (project, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS tickets_by_recent  ON tickets (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS ticket_events (
  ticket_id   TEXT    NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  -- Position in the ticket's history, from 0. Part of the key, so history cannot be rewritten.
  seq         INTEGER NOT NULL,

  id          TEXT    NOT NULL,
  at          TEXT    NOT NULL,
  type        TEXT    NOT NULL,
  actor_kind  TEXT    NOT NULL,
  actor_name  TEXT,
  -- 'public' | 'internal'. The ticket page filters on this; it is why an internal note can sit
  -- in the same history the reporter's page renders from.
  visibility  TEXT    NOT NULL,
  body        TEXT,
  meta        TEXT,

  PRIMARY KEY (ticket_id, seq)
);

CREATE TABLE IF NOT EXISTS ticket_attachments (
  ticket_id     TEXT    NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  id            TEXT    NOT NULL,
  position      INTEGER NOT NULL,
  filename      TEXT    NOT NULL,
  -- What the browser claimed. Recorded for support to read, NEVER used to decide how the file
  -- is served back; core/attachments.mjs decides that from the extension alone.
  declared_type TEXT,
  size          INTEGER NOT NULL,
  uploaded_at   TEXT    NOT NULL,

  PRIMARY KEY (ticket_id, id)
);
