-- Issue #88: hashes of the last column values and description a recompute wrote to Monday, so
-- the next recompute skips an unchanged mutation (a sweep otherwise costs ~5 Monday calls per
-- owner against a 10,000/day account cap). NULL = unknown/never written: write.
ALTER TABLE owner_recomputes ADD COLUMN values_hash TEXT;
ALTER TABLE owner_recomputes ADD COLUMN description_hash TEXT;
