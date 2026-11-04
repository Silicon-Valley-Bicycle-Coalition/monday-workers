-- Ownership check for pulled DTD records (the plugin key is public, so a record can be forged):
-- a retried record is re-verified against its item's donor without keeping the raw email.
-- donor_email_hash = SHA-256 hex of the trimmed, lowercased DTD donor email; donation_amount = DTD's amount.
ALTER TABLE dtd_records ADD COLUMN donor_email_hash TEXT;
ALTER TABLE dtd_records ADD COLUMN donation_amount REAL;
