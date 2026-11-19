-- Sign-in codes, Household Email sign-in and verified addresses. magic_link_tokens gains the
-- columns a 6-digit code needs: request_hash groups the rows one request created, code_hash is a
-- hash of the code, email_hash is the hash of the lowercased address the code was sent to, and
-- failed_code_attempts counts wrong guesses against the row. verified_emails records which
-- addresses a person has proved they control. code_failures holds wrong guesses per address; it
-- replaces counting over magic_link_tokens, because those rows are purged once expired (15
-- minutes in), which would reset a 24-hour count.
--
-- Apply before deploying the build that reads it. Every new token column is nullable or
-- defaulted, so letter rows and rows written before the deploy keep working.
ALTER TABLE magic_link_tokens ADD COLUMN request_hash TEXT;
ALTER TABLE magic_link_tokens ADD COLUMN code_hash TEXT;
ALTER TABLE magic_link_tokens ADD COLUMN email_hash TEXT;
ALTER TABLE magic_link_tokens ADD COLUMN failed_code_attempts INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_magic_link_tokens_request_hash ON magic_link_tokens (request_hash);

CREATE TABLE verified_emails (
  email_hash TEXT NOT NULL,
  person_item_id TEXT NOT NULL,
  first_verified_at TEXT NOT NULL,
  last_verified_at TEXT NOT NULL,
  PRIMARY KEY (email_hash, person_item_id)
);

CREATE TABLE code_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_hash TEXT NOT NULL,
  failed_at TEXT NOT NULL
);
CREATE INDEX idx_code_failures_email_hash_time ON code_failures (email_hash, failed_at);
CREATE INDEX idx_code_failures_failed_at ON code_failures (failed_at);
