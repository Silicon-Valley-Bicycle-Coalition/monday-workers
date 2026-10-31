-- Refresh-failure state for alerting (final review I-1). No error text is stored, only times, so
-- nothing here can hold a token or secret echoed back by Monday.
--   refresh_failing_since   start of the current run of failed refreshes (NULL when healthy)
--   last_refresh_error_at   the most recent failed refresh, shown in /health
--   refresh_error_alerted_at set when this run of failures was alerted on, so the cron alerts
--                            once per state change rather than every 30 minutes
-- All three are cleared by a successful refresh (saveRefreshed) or a new consent (save).
ALTER TABLE oauth_tokens ADD COLUMN refresh_failing_since TEXT;
ALTER TABLE oauth_tokens ADD COLUMN last_refresh_error_at TEXT;
ALTER TABLE oauth_tokens ADD COLUMN refresh_error_alerted_at TEXT;
