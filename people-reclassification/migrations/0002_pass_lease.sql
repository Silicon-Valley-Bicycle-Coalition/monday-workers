-- One pass at a time (#64). The cron and POST /reclassify/run call the same pass, and nothing
-- stopped them overlapping: two passes would read the same boards, plan the same moves, and one's
-- settle step could mark the other's in-flight 'planned' rows failed. A pass now takes this lease
-- before it starts its run row and releases it when it finishes; a pass that finds it held is
-- skipped. expires_at bounds a lease whose holder died mid-pass. Same shape as donation-rollups'
-- owner_leases, with a single row.
CREATE TABLE pass_lease (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  holder TEXT NOT NULL,       -- run_id of the pass holding it
  expires_at TEXT NOT NULL    -- ISO; after this any pass may take the lease
);
