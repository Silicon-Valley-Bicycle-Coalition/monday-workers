-- Reverse index: donation item -> owner item. Needed because Monday's API has no
-- supported filter for board_relation columns (confirmed 2026-08-24 against the real
-- CRM Sandbox: items_page_by_column_values rejects board-relation outright, and the
-- only working alternative filters by the linked item's rendered display *name* --
-- unsafe here since this data has confirmed donor name collisions). Bootstrapped once
-- from every existing Donation's Donor link (scripts/bootstrap-links.mjs), then kept
-- current incrementally as this Worker processes each webhook.
CREATE TABLE donation_links (
  donation_item_id TEXT PRIMARY KEY,
  donation_board_id TEXT NOT NULL,
  owner_item_id TEXT NOT NULL,
  owner_board_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_donation_links_owner ON donation_links (owner_item_id);
