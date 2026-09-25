-- Create-claims for Recurring Gifts items (#25). The hourly poll and the queue consumer (an
-- installment for a never-seen subscription) both run upsertSubscription; on a ledger miss both
-- could look the board up, find nothing, and each create an item (it happened on 2026-09-19,
-- local bootstrap walk vs. the 02:00 cron, subscription 197170). A writer must now claim the
-- subscription here before adopting or creating; the INSERT is atomic in D1, so exactly one
-- writer wins. A claim older than its TTL (a writer that died mid-create) can be taken over.
CREATE TABLE subscription_claims (
  funraise_id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  claimed_at TEXT NOT NULL
);
