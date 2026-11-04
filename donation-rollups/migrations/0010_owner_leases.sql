-- Per-owner recompute lease (2026-10-28 review, finding 2). With max_concurrency > 1, two
-- recomputes of one owner could interleave: the one that read Monday first could write last and
-- overwrite fresher totals, and nothing would repair it. A recompute now takes this lease before
-- it reads and releases it after it writes; a second recompute of the same owner retries the
-- message shortly and re-reads. expires_at bounds a lease whose holder died mid-recompute.
CREATE TABLE owner_leases (
  owner_item_id TEXT PRIMARY KEY,
  holder TEXT NOT NULL,       -- random id of the recompute holding it
  expires_at TEXT NOT NULL    -- ISO; after this any recompute may take the lease
);
