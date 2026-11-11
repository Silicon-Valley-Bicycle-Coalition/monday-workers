-- monday_item_id: push's hasDtdRecordForItem and pairing's companyForItem look records up by item.
CREATE INDEX idx_dtd_records_monday_item_id ON dtd_records (monday_item_id);
-- listUnmatched: WHERE unmatched = 1 ORDER BY updated_seen_at, donation_identifier.
CREATE INDEX idx_dtd_records_unmatched ON dtd_records (unmatched, updated_seen_at, donation_identifier);
