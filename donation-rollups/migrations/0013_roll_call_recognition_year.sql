-- Donor roll call amendments (spec 2026-11-02 §10). recognition_fiscal_year: the staff-set
-- Recognition Fiscal Year on Donations, the year the roll call credits the gift to instead of its
-- own; NULL = its own year. Kept, like every column here, once the gift archives.
-- amount_cents now holds the In-Kind Value when Amount is blank (§10.3); no schema change for that.
ALTER TABLE roll_call_credits ADD COLUMN recognition_fiscal_year INTEGER;
