-- Organization reps. magic_link_tokens and sessions gain org_grants, a JSON array of the
-- organizations the sign-in address may act for (NULL reads as none: letter links, donors, and
-- rows written before this migration). org_statement_sends records each organization statement
-- email queued per Affiliation and year, so a rerun never sends one twice.
--
-- Apply to both D1 databases before merging the code that reads it (same reason as 0007/0008: the
-- deploy-sandbox job never applies migrations, and getSession selects the new column). Both new
-- columns are nullable, so code that predates them is unaffected.
ALTER TABLE magic_link_tokens ADD COLUMN org_grants TEXT;
ALTER TABLE sessions ADD COLUMN org_grants TEXT;

CREATE TABLE org_statement_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_item_id TEXT NOT NULL,
  affiliation_item_id TEXT NOT NULL,
  year INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE UNIQUE INDEX idx_org_statement_sends_key ON org_statement_sends (org_item_id, affiliation_item_id, year);
