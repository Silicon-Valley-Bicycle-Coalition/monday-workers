-- Sponsorship audit history: two per-gift facts read from the Donations board.
-- NULL = not read yet (the sponsorship backfill fills it); '' / 0 = read, and the cell was blank.
ALTER TABLE gifts ADD COLUMN sponsorship_event TEXT;
ALTER TABLE gifts ADD COLUMN in_kind_value_cents INTEGER;
