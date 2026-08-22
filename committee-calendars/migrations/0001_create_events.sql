-- migrations/0001_create_events.sql
CREATE TABLE events (
  id TEXT PRIMARY KEY,              -- source_id || ':' || external_id
  source_id TEXT NOT NULL,
  title TEXT NOT NULL,
  committee_name TEXT NOT NULL,
  start_utc TEXT NOT NULL,
  end_utc TEXT,
  location TEXT,
  url TEXT,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE source_status (
  source_id TEXT PRIMARY KEY,
  last_success_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
