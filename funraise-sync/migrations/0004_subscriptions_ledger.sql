-- Subscriptions poller ledger (spec 2026-09-18-funraise-subscriptions-poller-design.md).
-- One row per Funraise subscription this Worker has written to the Recurring Gifts board:
-- the Monday item it maps to (created here, or adopted from the board by Funraise ID when the
-- importer created it), the donor it was linked to, and the Funraise updtime of the row last
-- written so a re-read of the same row is a no-op. updtime is NULL only when Funraise sent
-- none; a NULL never blocks an update.
CREATE TABLE subscriptions (
  funraise_id TEXT PRIMARY KEY,
  monday_item_id TEXT NOT NULL,
  donor_item_id TEXT,
  status TEXT NOT NULL,
  updtime INTEGER,
  written_at TEXT NOT NULL
);

-- Named poll cursors. The subscriptions poll stores the max updtime of the last page it fully
-- wrote; it only advances after every row on the page landed in Monday and the ledger.
CREATE TABLE poll_cursors (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
