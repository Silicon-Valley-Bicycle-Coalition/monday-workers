-- Sessions remember which sign-in address opened them. email_hash is the hash of the lowercased
-- address the sign-in code or link was sent to; NULL for letter-ready links (no address) and for
-- sessions created before this migration.
--
-- Apply to both D1 databases before merging the code that reads it (same reason as 0007: the
-- deploy-sandbox job never applies migrations, and getSession selects this column). The column is
-- nullable, so code that predates it is unaffected.
ALTER TABLE sessions ADD COLUMN email_hash TEXT;
