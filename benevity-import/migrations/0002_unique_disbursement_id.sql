-- One disbursements row per Benevity Disbursement ID (#34). Before this, nothing was unique on
-- disbursement_id, so re-uploading the same report as a new Monday asset (a fresh asset id, so
-- the uploads redelivery check doesn't catch it) inserted a second disbursements row and, for a
-- needs-review block, posted a second worklist item. The route now looks a block up — by its
-- (upload, block position) for a resumed attempt, then by Benevity id for a re-upload — before
-- inserting, and these indexes make a lost race fail closed instead of duplicating.
--
-- Safe on a database that already holds duplicates: every rows.disbursement_id pointing at a
-- later duplicate is repointed to the earliest disbursements row with the same Benevity id, and
-- the later duplicates are deleted, before the unique index is created. Blocks whose header
-- failed to parse can have an empty disbursement_id; those stay one-per-block (the index is
-- partial) and are found again by (upload_id, block_index).
--
-- Pre-check (optional — the statements below dedupe regardless), run before applying:
--   wrangler d1 execute <db> --remote --command \
--     "SELECT disbursement_id, COUNT(*) AS n, GROUP_CONCAT(id) AS ids FROM disbursements
--      WHERE disbursement_id != '' GROUP BY disbursement_id HAVING n > 1"
-- Any row it returns had its later duplicate(s) merged; if one of those was a needs-review
-- block, its duplicate worklist item on the Benevity Uploads board can be deleted by hand.

ALTER TABLE disbursements ADD COLUMN block_index INTEGER;

-- Backfill each existing row's position within its upload (blocks were always created by one
-- sequential loop, so id order within an upload is block order). Done before the dedupe so a
-- surviving row keeps its original position.
UPDATE disbursements
SET block_index = (
  SELECT COUNT(*) FROM disbursements AS earlier
  WHERE earlier.upload_id = disbursements.upload_id AND earlier.id < disbursements.id
);

UPDATE rows
SET disbursement_id = (
  SELECT MIN(keep.id) FROM disbursements AS dup
  JOIN disbursements AS keep ON keep.disbursement_id = dup.disbursement_id
  WHERE dup.id = rows.disbursement_id
)
WHERE disbursement_id IN (
  SELECT dup.id FROM disbursements AS dup
  WHERE dup.disbursement_id != ''
    AND dup.id > (SELECT MIN(first.id) FROM disbursements AS first WHERE first.disbursement_id = dup.disbursement_id)
);

DELETE FROM disbursements
WHERE disbursement_id != ''
  AND id > (SELECT MIN(first.id) FROM disbursements AS first WHERE first.disbursement_id = disbursements.disbursement_id);

CREATE UNIQUE INDEX idx_disbursements_benevity_id ON disbursements (disbursement_id) WHERE disbursement_id != '';
CREATE UNIQUE INDEX idx_disbursements_upload_block ON disbursements (upload_id, block_index) WHERE block_index IS NOT NULL;
