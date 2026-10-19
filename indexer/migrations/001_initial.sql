-- Migration 001: Initial schema
-- Creates the baseline tables and indexes for the indexer.
-- This mirrors the original hardcoded schema previously embedded in src/db.ts.

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  ledger INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_events_ledger ON events (ledger);
CREATE INDEX IF NOT EXISTS idx_events_event_type ON events (event_type);
CREATE INDEX IF NOT EXISTS idx_events_contract ON events (contract_id);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events (timestamp);

CREATE TABLE IF NOT EXISTS indexer_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- ---------------------------------------------------------------------------
-- Reorg detection support (issue #720)
--
-- The events table gains a nullable ledger_hash column so that each stored
-- event can be tied to the hash of the ledger it was emitted in. This allows
-- the poller to detect a hash mismatch (fork / rollback) and purge orphaned
-- events from invalidated ledgers.
--
-- The indexer_state table additionally uses the following keys for reorg
-- detection and rollback recovery:
--
--   last_ledger_hash      - hash of the most recently ingested ledger (N).
--   last_verified_ledger  - sequence of the last ledger whose hash chain was
--                           verified against its parent (the common ancestor
--                           to which the poller rewinds on a reorg).
--
-- These keys are stored as TEXT values in indexer_state; no schema change is
-- required for them beyond the existing key/value table.
-- ---------------------------------------------------------------------------

ALTER TABLE events ADD COLUMN ledger_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_events_ledger_hash ON events (ledger);

-- Down (rollback) section:
--   DROP INDEX IF EXISTS idx_events_ledger_hash;
--   ALTER TABLE events DROP COLUMN ledger_hash;