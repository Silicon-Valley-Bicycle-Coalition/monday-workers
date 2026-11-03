-- Sync watermark and other small key/value state (e.g. the last successful pull).
CREATE TABLE sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Every DTD donation record this Worker has seen, keyed by DTD's donation_identifier.
-- unmatched = 1 while no Monday Donations item exists for the record (retried next run).
CREATE TABLE dtd_records (
  donation_identifier TEXT PRIMARY KEY,
  monday_item_id TEXT,
  source TEXT,
  status TEXT,
  matching_gift_status TEXT,
  employer_status TEXT,
  company_id TEXT,
  company_name TEXT,
  matched_amount REAL,
  donation_datetime TEXT,
  updated_seen_at TEXT NOT NULL,
  unmatched INTEGER NOT NULL DEFAULT 0
);

-- Push ledger: a Monday item is registered with DTD at most once.
CREATE TABLE pushes (
  monday_item_id TEXT PRIMARY KEY,
  dtd_identifier TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sent_at TEXT
);
