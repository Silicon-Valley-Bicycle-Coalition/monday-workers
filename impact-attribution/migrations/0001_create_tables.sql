-- Every employer matching gift the Worker has seen: bootstrapped once from salesforce-import's
-- artifacts (archived gifts read empty on Monday) and refreshed nightly from the active board.
CREATE TABLE matches (
  donation_item_id TEXT PRIMARY KEY,
  person_item_id   TEXT NOT NULL,
  org_item_id      TEXT NOT NULL,
  match_date       TEXT NOT NULL,      -- YYYY-MM-DD
  amount_cents     INTEGER,            -- null when Amount is blank
  source           TEXT NOT NULL CHECK (source IN ('bootstrap', 'board')),
  seen_at          TEXT NOT NULL
);
CREATE INDEX matches_pair ON matches (person_item_id, org_item_id);

-- Every Draft Affiliation the Worker has created. A pair is never proposed twice, so a Draft
-- staff deleted stays gone.
CREATE TABLE proposals (
  person_item_id      TEXT NOT NULL,
  org_item_id         TEXT NOT NULL,
  affiliation_item_id TEXT NOT NULL,
  proposed_status     TEXT NOT NULL CHECK (proposed_status IN ('Current', 'Former')),
  match_count         INTEGER NOT NULL,
  proposed_at         TEXT NOT NULL,
  PRIMARY KEY (person_item_id, org_item_id)
);
