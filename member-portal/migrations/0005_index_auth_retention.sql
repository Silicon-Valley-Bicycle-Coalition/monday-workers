-- Supports the daily retention purge in scheduled() (src/db/authRetention.ts, issue #31): each
-- deletes by a time-range scan on one column, which the existing indexes don't cover
-- (idx_login_attempts_email_time leads with email). Additive only.
CREATE INDEX IF NOT EXISTS idx_login_attempts_attempted_at ON login_attempts (attempted_at);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);
CREATE INDEX IF NOT EXISTS idx_magic_link_tokens_expires_at ON magic_link_tokens (expires_at);
