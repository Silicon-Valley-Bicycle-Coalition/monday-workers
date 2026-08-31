-- Keyed on the Donation item that changed, not the donor — the webhook handler can
-- dedupe cheaply this way with no Monday API call. The consumer resolves which
-- donor/org owns it and does the actual recompute, same division of labor as
-- funraise-sync's events table.
CREATE TABLE pending_recomputes (
  donation_item_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received', -- received -> queued -> written | failed
  owner_item_id TEXT,
  owner_board TEXT, -- the numeric Monday board id the owner item lives on (see types.ts PendingRow.ownerBoard)
  error TEXT,
  received_at TEXT NOT NULL,
  written_at TEXT
);
