-- Per-owner recompute coalescing (README "operational findings, 2026-09-17", fix 3). One row per
-- owner: when this Worker last read that owner's donations from Monday (fetched_at) and when the
-- resulting write landed (written_at). Written once per SUCCESSFUL recompute. The consumer skips
-- a queued donation whose owner was fetched at/after the donation's webhook arrived AND whose
-- link already existed unchanged before that fetch — so a bulk edit touching 3,700 donations
-- costs ~one recompute per owner instead of one per donation (the 09-03 flood recomputed big
-- owners dozens of times each and pushed D1 past the Free-tier daily row-write cap).
CREATE TABLE owner_recomputes (
  owner_item_id TEXT PRIMARY KEY,
  owner_board_id TEXT NOT NULL,
  fetched_at TEXT NOT NULL,   -- ISO; taken immediately before the Monday donations fetch
  written_at TEXT NOT NULL    -- ISO; after the owner column write succeeded
);
