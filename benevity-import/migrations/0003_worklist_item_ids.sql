-- The Benevity Uploads worklist item each needs-review row or block was given (#34). Recorded so
-- a retried queue message or webhook redelivery reuses the item instead of posting another, and
-- so a staff "Retry" on a worklist item (a Monday webhook carrying only the item id) can find
-- the row or block it stands for. Additive only: existing rows read NULL, which the code treats
-- as "no worklist item recorded yet".
ALTER TABLE rows ADD COLUMN worklist_item_id TEXT;
ALTER TABLE disbursements ADD COLUMN worklist_item_id TEXT;
CREATE INDEX idx_rows_worklist_item ON rows (worklist_item_id) WHERE worklist_item_id IS NOT NULL;
CREATE INDEX idx_disbursements_worklist_item ON disbursements (worklist_item_id) WHERE worklist_item_id IS NOT NULL;
