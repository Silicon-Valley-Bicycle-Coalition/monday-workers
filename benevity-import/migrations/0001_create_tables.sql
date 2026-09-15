CREATE TABLE uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monday_asset_id TEXT NOT NULL UNIQUE,
  uploaded_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'parsing',
  block_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE disbursements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  upload_id INTEGER NOT NULL REFERENCES uploads(id),
  disbursement_id TEXT NOT NULL,
  period_ending TEXT NOT NULL,
  currency TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  reported_gross_total REAL NOT NULL DEFAULT 0,
  reported_net_total REAL NOT NULL DEFAULT 0,
  needs_review INTEGER NOT NULL DEFAULT 0,
  review_reason TEXT
);
CREATE INDEX idx_disbursements_upload ON disbursements (upload_id);

-- Transaction ID is the true idempotency key: global, not scoped to one file or block, so the
-- same gift arriving in two overlapping uploads is still one row (spec: Idempotency).
CREATE TABLE rows (
  transaction_id TEXT PRIMARY KEY,
  disbursement_id INTEGER NOT NULL REFERENCES disbursements(id),
  status TEXT NOT NULL DEFAULT 'ingested',
  monday_employee_item_id TEXT,
  monday_match_item_id TEXT,
  raw_row TEXT NOT NULL,
  error TEXT,
  ingested_at TEXT NOT NULL,
  written_at TEXT
);
CREATE INDEX idx_rows_disbursement ON rows (disbursement_id);

-- Learned Company-string -> Organizations-item-id aliases, appended to whenever staff resolve a
-- worklist item by hand (spec: Resolution, Company -> Organizations item).
CREATE TABLE aliases (
  raw_company_name TEXT PRIMARY KEY,
  organization_item_id TEXT NOT NULL,
  learned_at TEXT NOT NULL
);
