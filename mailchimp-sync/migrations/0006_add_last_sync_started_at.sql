-- When the last sync that ran to completion (written or skipped) began. The outbound consumer
-- acks a queued message without work if that start is later than the message's enqueue time:
-- that sync read Monday after the change, so it already carried it (#97). Left alone by
-- upsertPending, so a new webhook delivery doesn't erase it.
ALTER TABLE pending_outbound_syncs ADD COLUMN last_sync_started_at TEXT;
