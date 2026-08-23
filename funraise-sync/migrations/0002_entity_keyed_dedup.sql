-- Dedup key moves from the delivery's event_id to the entity itself, so a second
-- event for the same Transaction/Subscription/Pledge/Registration updates the
-- Monday item instead of being dropped as a duplicate.
ALTER TABLE events ADD COLUMN entity_id TEXT;
UPDATE events SET entity_id = event_id;
CREATE UNIQUE INDEX idx_events_entity ON events (entity_type, entity_id);
