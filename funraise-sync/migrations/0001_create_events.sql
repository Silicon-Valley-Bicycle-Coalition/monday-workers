CREATE TABLE events (
  event_id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  raw_payload TEXT NOT NULL,
  matched_donor_item_id TEXT,
  monday_item_id TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  error TEXT,
  received_at TEXT NOT NULL,
  written_at TEXT
);
