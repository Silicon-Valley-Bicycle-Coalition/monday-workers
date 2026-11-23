-- One row per cron event the Worker has started (src/db/cronRuns.ts). The platform occasionally
-- delivers the same scheduled event twice, ~15 minutes apart (4 of 134 hourly events, 2026-11-18
-- to 11-23); the second delivery finds its row and skips. scheduled_time is the event's
-- scheduledTime in ms; rows older than a week are pruned as new ones are claimed.
CREATE TABLE cron_runs (
  cron TEXT NOT NULL,
  scheduled_time INTEGER NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (cron, scheduled_time)
);
