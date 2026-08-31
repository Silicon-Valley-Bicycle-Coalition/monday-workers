-- Ledger v2 (docs/20 §5.1 in the private planning repo): D1 becomes the authoritative record
-- of gift history, not just a reverse index. Monday stays the working surface — staff edits
-- flow back in via webhooks within seconds — but every Monday-side artifact (rollup columns,
-- future gift-history projections, annual summaries) is a projection, rebuildable from here.
-- Rows arrive three ways: the artifacts bootstrap (source 'import'), webhook-driven recompute
-- refreshes (source 'webhook' — every recompute re-asserts the facts of every gift it read,
-- so the ledger self-heals), and manual fixes (source 'manual-fix').
CREATE TABLE gifts (
  monday_item_id TEXT PRIMARY KEY,   -- stable once created; survives archiving
  owner_item_id TEXT NOT NULL,
  owner_board_id TEXT NOT NULL,      -- resolves the per-board owner column namespaces
  amount_cents INTEGER NOT NULL,
  gift_date TEXT NOT NULL,           -- ISO date; '' when the source row had none
  fiscal_year INTEGER NOT NULL,      -- July–June; 0 when undated
  status TEXT NOT NULL,              -- 'Received' | 'Received (Historical)' | 'Failed' | 'Pending'
  gift_type TEXT,
  funraise_id TEXT,
  sf_id TEXT,                        -- provenance; survives Salesforce retirement
  archived_at TEXT,                  -- null = active on the board
  source TEXT NOT NULL,              -- 'import' | 'webhook' | 'manual-fix'
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_gifts_owner ON gifts (owner_item_id);
CREATE INDEX idx_gifts_fy ON gifts (fiscal_year);

-- One row per closed fiscal year — the org/annual view's durable record, changed only by the
-- custodian's year-end run or an audit restatement (docs/20 §5.4). monday_item_id points at
-- the summary item on the Annual Giving Summary board once that board exists.
CREATE TABLE annual_summaries (
  fiscal_year INTEGER PRIMARY KEY,
  total_cents INTEGER NOT NULL,
  gift_count INTEGER NOT NULL,
  by_type_json TEXT NOT NULL,
  monday_item_id TEXT,
  restated_at TEXT,
  updated_at TEXT NOT NULL
);

-- Custodian duty log — the runbook surface (docs/20 §5.3): every scheduled or manually
-- triggered duty records what it did, so "is the custodian healthy?" is one query, not a
-- log dive.
CREATE TABLE custodian_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  duty TEXT NOT NULL,                -- 'archive' | 'capacity' | 'sweep' | 'reconcile'
  ran_at TEXT NOT NULL,
  ok INTEGER NOT NULL,               -- 1 = clean, 0 = attention needed (see report)
  report_json TEXT NOT NULL
);
CREATE INDEX idx_custodian_runs_duty ON custodian_runs (duty, ran_at);
