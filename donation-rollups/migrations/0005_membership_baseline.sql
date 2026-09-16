-- Membership renewal write path (docs/superpowers/specs/2026-09-15-membership-renewal-write-path-design.md,
-- "Baseline"). One row per owner: the membership state the board held BEFORE this Worker's
-- first membership write to that owner — captured lazily on that first recompute, never
-- updated afterward. Membership Type (New / Renewal / Reacquire) for each post-cutover gift is
-- derived from this row plus earlier gifts, so re-running a recompute yields identical types.
-- To re-seed an owner after a staff correction to migrated history: DELETE the row; the next
-- recompute recaptures it from the board.
CREATE TABLE membership_baseline (
  owner_item_id TEXT PRIMARY KEY,
  owner_board_id TEXT NOT NULL,
  since TEXT,            -- ISO date or NULL
  until TEXT,            -- ISO date or NULL (NULL for Lifetime and for never-members)
  tier TEXT,             -- 'member' | 'lifetime' | NULL — canonical keys, not board labels
  captured_at TEXT NOT NULL
);
