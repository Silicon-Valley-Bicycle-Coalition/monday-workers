CREATE TABLE result_rows (board_id TEXT NOT NULL, contact_id TEXT NOT NULL, result_item_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (board_id, contact_id));
CREATE TABLE searches (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL, label TEXT NOT NULL, query TEXT NOT NULL, miles REAL NOT NULL, matched INTEGER NOT NULL, queued INTEGER NOT NULL, confirmed_by TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE geocode_misses (item_id TEXT PRIMARY KEY, address_hash TEXT NOT NULL, attempted_at TEXT NOT NULL);
