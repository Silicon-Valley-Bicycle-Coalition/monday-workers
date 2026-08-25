-- Discovered against the real CRM Sandbox 2026-08-24: Donations aren't one board, they're
-- split across several era boards (a "live" one plus dated historical ones) with
-- independent column-id namespaces. Resolving a donation's Donor link needs to know
-- which board's column ids to use.
ALTER TABLE pending_recomputes ADD COLUMN donation_board_id TEXT NOT NULL DEFAULT '';
