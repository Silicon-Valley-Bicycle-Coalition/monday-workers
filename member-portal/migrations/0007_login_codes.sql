-- A one-time login code in the login email, checked only from the browser that asked for it
-- (src/auth/loginCode.ts). The code and the link share one row, so using either burns both.
-- request_hash binds checks to that browser's request id; code_hash is hashLoginCode(requestId,
-- code); code_attempts counts checks against the request, capped at LOGIN_CODE_MAX_ATTEMPTS
-- across all of its rows (a new row starts at the request's current count); email_hash ties the
-- row to one address, so a request holds one address's codes at a time; locale is the language
-- the login was asked for in. Letter-ready rows leave them null and never match a code.
-- login_code_checks records each code check per address (email_hash as in login_attempts) for
-- the LOGIN_CODE_DAILY_MAX per-24-hours cap; the retention purge deletes it by checked_at.
-- Additive only.
ALTER TABLE magic_link_tokens ADD COLUMN request_hash TEXT;
ALTER TABLE magic_link_tokens ADD COLUMN code_hash TEXT;
ALTER TABLE magic_link_tokens ADD COLUMN code_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE magic_link_tokens ADD COLUMN locale TEXT;
ALTER TABLE magic_link_tokens ADD COLUMN email_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_magic_link_tokens_request_hash ON magic_link_tokens (request_hash);

CREATE TABLE login_code_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_hash TEXT NOT NULL,
  checked_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_code_checks_email_time ON login_code_checks (email_hash, checked_at);
CREATE INDEX IF NOT EXISTS idx_login_code_checks_checked_at ON login_code_checks (checked_at);
