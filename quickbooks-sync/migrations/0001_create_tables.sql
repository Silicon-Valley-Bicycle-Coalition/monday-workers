CREATE TABLE qb_oauth_tokens (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  realm_id TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  access_token_expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE qb_monday_map (
  entity_type TEXT NOT NULL,
  qb_id TEXT NOT NULL,
  monday_item_id TEXT NOT NULL,
  monday_board_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (entity_type, qb_id)
);

CREATE UNIQUE INDEX qb_monday_map_monday_item_idx ON qb_monday_map (entity_type, monday_item_id);

CREATE TABLE qb_events (
  event_id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  qb_id TEXT NOT NULL,
  fetched_payload TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  error TEXT,
  received_at TEXT NOT NULL,
  written_at TEXT
);

CREATE TABLE monday_events (
  event_id TEXT PRIMARY KEY,
  monday_item_id TEXT NOT NULL,
  raw_payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received',
  qb_id TEXT,
  error TEXT,
  received_at TEXT NOT NULL,
  written_at TEXT
);
