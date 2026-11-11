-- Skip unchanged writes (issue #89). The last values written to an owner's rollup columns and to
-- its description, as SHA-256 hex. A recompute whose output hashes the same writes nothing — this
-- Worker's own gift-term stamps come back as webhooks and trigger a recompute that rewrites
-- identical rollups; the custodian sweep still forces the write, so a hand edit is repaired there.
-- NULL (every existing row, and a description that failed to write) means "write".
ALTER TABLE owner_recomputes ADD COLUMN values_hash TEXT;
ALTER TABLE owner_recomputes ADD COLUMN description_hash TEXT;
