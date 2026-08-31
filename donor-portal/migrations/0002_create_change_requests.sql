CREATE TABLE change_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  donor_item_id TEXT NOT NULL,
  donor_name TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT NOT NULL,
  new_value TEXT NOT NULL,
  dedupe_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at TEXT NOT NULL,
  written_at TEXT
);

CREATE INDEX idx_change_requests_dedupe ON change_requests (dedupe_hash, created_at);
