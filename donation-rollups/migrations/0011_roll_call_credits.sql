-- The donor roll call's credit ledger (nightly "rollcall" duty): one row per gift counted toward a
-- fiscal year's roll call, so the duty can diff tonight's credits against last night's and write
-- only the Monday items that changed. credit is the donor item the gift is credited to; NULL
-- means "the ledger's own owner is credited" and the row exists only to carry unmatched_match
-- (an employer match with no Matched By but a Donor).
CREATE TABLE roll_call_credits (
  gift_item_id TEXT PRIMARY KEY,
  fiscal_year INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  gift_type TEXT,
  credit TEXT,
  unmatched_match INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_roll_call_credits_fy ON roll_call_credits (fiscal_year);
