-- migrations/0001_create_snapshot_runs.sql
CREATE TABLE snapshot_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running', -- running | success | partial | failure
  board_count INTEGER,
  doc_count INTEGER,
  error_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

-- Singleton row tracking consecutive total-run failures, for alert-threshold logic
-- (mirrors committee-calendars' source_status.consecutive_failures — one row instead of
-- one per source, since a backup run is a single all-boards operation, not per-source).
CREATE TABLE run_alert_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);
INSERT INTO run_alert_state (id, consecutive_failures) VALUES (1, 0);
