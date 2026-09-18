-- Affiliation model (spec 2026-09-08, Plan 2): a gift the Primary Contact drove for an
-- organization carries the Affiliation item it was attributed to (the Donation's "Acting for"
-- connect column). Nullable: most gifts are personal. Archived items' board_relation reads
-- empty, so the recompute path preserves this value for archived gifts (db/gifts.ts).
ALTER TABLE gifts ADD COLUMN acting_for_item_id TEXT;
CREATE INDEX idx_gifts_acting_for ON gifts (acting_for_item_id);

-- Affiliation item -> the Person it belongs to, so Organizational Giving (sum over a person's
-- affiliations) can be computed from D1. Refreshed from Monday on every affiliation recompute;
-- bootstrapped from salesforce-import's artifacts. Not authoritative for the link itself.
CREATE TABLE affiliations (
  affiliation_item_id TEXT PRIMARY KEY,
  person_item_id TEXT NOT NULL,
  person_board_id TEXT NOT NULL,
  name TEXT NOT NULL,                -- "<Person> @ <Organization>", for the gift-history markdown
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_affiliations_person ON affiliations (person_item_id);
