CREATE TABLE magic_link_tokens (
  token_hash TEXT PRIMARY KEY,
  donor_item_ids TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE sessions (
  session_hash TEXT PRIMARY KEY,
  donor_item_ids TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  attempted_at TEXT NOT NULL
);

CREATE INDEX idx_login_attempts_email_time ON login_attempts (email, attempted_at);
