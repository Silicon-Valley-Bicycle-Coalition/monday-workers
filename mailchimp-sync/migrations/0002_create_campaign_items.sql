-- Keyed on Mailchimp's stable interest_id, not name — names can be edited in
-- Mailchimp without changing identity. archived_at is set (not the row deleted) when
-- an interest disappears from Mailchimp, so a donor's historical connection to it is
-- never lost.
CREATE TABLE campaign_items (
  interest_id TEXT PRIMARY KEY,
  monday_item_id TEXT NOT NULL,
  name TEXT NOT NULL,
  archived_at TEXT
);
