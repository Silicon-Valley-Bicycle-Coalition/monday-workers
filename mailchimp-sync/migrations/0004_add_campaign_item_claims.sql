-- A reconcile run claims an interest_id (monday_item_id = '' plus claimed_at) before
-- creating its Monday item, so concurrent runs — the daily cron and any number of inbound
-- consumers meeting a new interest — create one item, not one each (issue #28). A claim
-- whose claimant crashed before creating goes stale and can be reclaimed.
ALTER TABLE campaign_items ADD COLUMN claimed_at TEXT;
