-- Issue #90: the two nightly scans that had no supporting index, so each read the whole table.
-- The requeue duty's listStuck (status IN ('received', 'queued') AND received_at < cutoff, oldest
-- first); its pruneFinished uses the same index.
CREATE INDEX idx_pending_recomputes_stuck ON pending_recomputes (status, received_at);
-- The sponsorships duty's backfill: only gifts still missing a fact, which is almost none once
-- the backfill has run, so a partial index stays tiny.
CREATE INDEX idx_gifts_missing_sponsorship ON gifts (gift_type, monday_item_id)
  WHERE (sponsorship_event IS NULL OR in_kind_value_cents IS NULL) AND removed_at IS NULL;
