CREATE TABLE logged_messages (
  message_id_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('bcc', 'forward')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'logged', 'failed')),
  activity_item_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  logged_at TEXT
);
CREATE TABLE alerts (
  kind TEXT PRIMARY KEY,           -- 'capacity' | 'board-full' | 'dead-letter'
  last_at TEXT NOT NULL,
  item_id TEXT
);
