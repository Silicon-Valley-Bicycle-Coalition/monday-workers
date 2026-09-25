-- migrations/0002_watchdog_state.sql
-- Staleness watchdog (issue #29). A run the runtime kills (CPU or 15-minute wall-time limit)
-- never reaches runBackup's catch, so its row stays 'running' forever and nothing alerts. The
-- hourly watchdog cron marks such rows 'abandoned' and alerts when no snapshot has succeeded in
-- 36 hours.
--
-- watchdog_armed_at: when the watchdog first ran. Stands in for "last success" on a fresh
-- deploy, so a backup cron that never fires at all still trips the 36h alarm.
-- last_stale_alert_at: throttles the "no success in 36h" alert to once a day.
ALTER TABLE run_alert_state ADD COLUMN watchdog_armed_at TEXT;
ALTER TABLE run_alert_state ADD COLUMN last_stale_alert_at TEXT;
