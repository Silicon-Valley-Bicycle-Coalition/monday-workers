-- Lookups for the create-loop guards (#33). qb_events.pending_monday_item_id identifies a Monday
-- item created from QuickBooks before its qb_monday_map row exists; monday_events.qb_id
-- identifies a QuickBooks Customer created from Monday before its mapping exists. Both are
-- queried by the consumer on every cross-direction create. Additive.
CREATE INDEX qb_events_pending_monday_item_idx ON qb_events (entity_type, pending_monday_item_id)
  WHERE pending_monday_item_id IS NOT NULL;
CREATE INDEX monday_events_qb_id_idx ON monday_events (qb_id) WHERE qb_id IS NOT NULL;
