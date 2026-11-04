-- Issue #62: login_attempts held every submitted email address in plain text, and recorded denied
-- requests too. It now holds a SHA-256 of the lowercased address, and only requests the
-- per-address limiter let through (src/db/loginAttempts.ts). The old rows are rate-limit state
-- for at most rateLimit.attemptRetentionHours, so they're dropped rather than converted — the
-- worst case is one fresh budget per address right after the migration.
--
-- Apply immediately before deploying the build that reads email_hash: the running build's
-- INSERT/SELECT on `email` fails in between, and the login route swallows that failure (same
-- generic page, no email sent) until the new build is live.
DROP TABLE login_attempts;

CREATE TABLE login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_hash TEXT NOT NULL,
  attempted_at TEXT NOT NULL
);

CREATE INDEX idx_login_attempts_email_hash_time ON login_attempts (email_hash, attempted_at);
CREATE INDEX idx_login_attempts_attempted_at ON login_attempts (attempted_at);
