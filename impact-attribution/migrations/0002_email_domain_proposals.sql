-- Email-domain employer proposals (#124) share the proposals ledger with matching-gift ones, so a
-- pair either job proposed is never proposed again by the other. `evidence` says which job made
-- the Draft; `domain` is the email domain behind an email_domain proposal. An email_domain
-- proposal stores match_count 0 (no matching gifts behind it) and proposed_status 'Current'.
ALTER TABLE proposals ADD COLUMN evidence TEXT NOT NULL DEFAULT 'matches' CHECK (evidence IN ('matches', 'email_domain'));
ALTER TABLE proposals ADD COLUMN domain TEXT;

-- The resolver's email index (2026-09-08 person/org/email model): one row per address on People
-- (Personal, Household) or Affiliations (Work Email), rebuilt in full each run.
CREATE TABLE email_index (
  address             TEXT PRIMARY KEY,   -- lower-cased
  kind                TEXT NOT NULL CHECK (kind IN ('personal', 'household', 'work')),
  person_item_ids     TEXT NOT NULL,      -- JSON array of People item ids
  affiliation_item_id TEXT                -- the Affiliation holding a work address
);
