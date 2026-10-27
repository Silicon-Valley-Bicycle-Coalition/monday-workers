-- migrations/0003_usage_alert_state.sql
-- Account-wide Monday API daily usage check (src/usage.ts), run by the hourly watchdog cron.
-- Alerts once per threshold (50%, 80%) per UTC day.
--
-- last_usage_alert_day: the UTC day (YYYY-MM-DD) of the most recent usage alert.
-- last_usage_alert_level: the threshold that alert reported, so a later, higher one still fires
-- the same day and a repeat of the same one doesn't.
ALTER TABLE run_alert_state ADD COLUMN last_usage_alert_day TEXT;
ALTER TABLE run_alert_state ADD COLUMN last_usage_alert_level INTEGER;
