-- Post-gift email ledger (src/jobs/prompt.ts): a gift is emailed about at most once. A row is
-- claimed before the send, so a `pending` row may have been sent and is never retried.
CREATE TABLE prompts (
  monday_item_id TEXT PRIMARY KEY,
  donor_item_id TEXT NOT NULL,
  variant TEXT NOT NULL CHECK (variant IN ('known','ask')),
  state TEXT NOT NULL CHECK (state IN ('pending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 1,
  gift_date TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  sent_at TEXT,
  monday_written_at TEXT,
  last_error TEXT
);
CREATE INDEX prompts_donor ON prompts (donor_item_id, claimed_at);
