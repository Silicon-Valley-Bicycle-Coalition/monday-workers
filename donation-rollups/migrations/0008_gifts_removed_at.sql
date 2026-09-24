-- A gift that no longer belongs to any owner — deleted on Monday, or an active item whose Donor
-- link staff cleared (issue #26). Soft, not a DELETE: the row keeps its bootstrap-only provenance
-- (gift_type / funraise_id / sf_id), and a restore or re-link clears removed_at on the next
-- recompute (refreshFacts). Every total and projection reads only rows where this is NULL.
ALTER TABLE gifts ADD COLUMN removed_at TEXT;
