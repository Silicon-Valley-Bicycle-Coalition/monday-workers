-- One row per reclassification pass (cron or HTTP), dry-run or live. A pass is the unit of
-- idempotence: the cron derives its run_id from the date and the trigger, so a double-fired
-- trigger finds the finished row and does nothing.
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL,            -- 'quarterly' | 'threshold' | 'continuation' | 'http'
  dry_run INTEGER NOT NULL,         -- 1 = planned only, no Monday writes
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,             -- 'running' | 'ok' | 'failed'
  summary_json TEXT                 -- the PassReport, for /reclassify/status and the next cron
);

-- One row per item a pass decided to move. status advances to 'moved' only after Monday confirmed
-- the move (never before — the cron-Worker invariant in ../CLAUDE.md), so a crash mid-run leaves
-- 'planned' rows the next pass settles by re-reading which board the item is on.
CREATE TABLE moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  item_id TEXT NOT NULL,
  from_board_id TEXT NOT NULL,
  to_board_id TEXT NOT NULL,
  direction TEXT NOT NULL,          -- 'to-historical' | 'to-live'
  latest_activity TEXT,             -- YYYY-MM-DD the decision rested on; null = perpetual rule
  reason TEXT NOT NULL,             -- short machine label, see src/classify.ts
  status TEXT NOT NULL,             -- 'dry-run' | 'planned' | 'moved' | 'failed' | 'ambiguous'
  error TEXT,
  planned_at TEXT NOT NULL,
  moved_at TEXT,
  UNIQUE (run_id, item_id)
);
CREATE INDEX moves_item ON moves (item_id, planned_at);
CREATE INDEX moves_status ON moves (status);

-- Capacity alerts raised on the IT Requests board, so one warning per board per cooldown.
CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id TEXT NOT NULL,
  kind TEXT NOT NULL,               -- 'historical-capacity'
  created_at TEXT NOT NULL,
  alert_item_id TEXT                -- the IT Requests item, null when log-only
);
CREATE INDEX alerts_board ON alerts (board_id, kind, created_at);
