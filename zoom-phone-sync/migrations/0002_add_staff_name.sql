-- The staff party's display name, for the timeline entry ("Call with …", "On Ann Staff's line").
-- A staff member's name only: the external party's name is never stored (the entry uses the
-- People item's own name).
ALTER TABLE phone_events ADD COLUMN staff_name TEXT;
