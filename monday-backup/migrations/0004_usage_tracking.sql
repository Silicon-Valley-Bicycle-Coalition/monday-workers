-- migrations/0004_usage_tracking.sql
-- Who used today's Monday API calls (src/usage.ts). Monday reports per-user usage only as totals
-- over its whole reporting window, so the hourly check keeps the last totals and adds up each
-- user's growth for the UTC day. JSON: { day, since, totals, today }, keyed by user name.
ALTER TABLE run_alert_state ADD COLUMN usage_tracking_json TEXT;
