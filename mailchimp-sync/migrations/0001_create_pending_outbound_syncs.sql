-- Keyed on the Donor item id — a redelivery for the same item replaces the row and
-- resets to 'received' rather than queuing a duplicate sync.
CREATE TABLE pending_outbound_syncs (
  donor_item_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'received', -- received -> queued -> written | failed
  error TEXT,
  received_at TEXT NOT NULL,
  written_at TEXT
);
