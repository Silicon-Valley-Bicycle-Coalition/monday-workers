-- Create-loop guard (#33). A QuickBooks-originated Customer is created on Monday before its
-- qb_monday_map row exists, and Monday's create_pulse webhook for that new item can arrive in
-- between, miss the mapping, and turn the item back into a second QuickBooks Customer. The
-- consumer now stamps monday_create_started_at before calling Monday's create_item; the
-- Monday -> QuickBooks path defers while any such claim is unresolved (no item id recorded yet),
-- and adopts the item when its id matches a row's pending_monday_item_id. Additive.
ALTER TABLE qb_events ADD COLUMN monday_create_started_at TEXT;
CREATE INDEX qb_events_pending_monday_item_idx ON qb_events (entity_type, pending_monday_item_id)
  WHERE pending_monday_item_id IS NOT NULL;
CREATE INDEX qb_events_monday_create_started_idx ON qb_events (entity_type, monday_create_started_at)
  WHERE monday_create_started_at IS NOT NULL;
