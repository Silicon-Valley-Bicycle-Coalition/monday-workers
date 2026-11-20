-- Employer answers read from members' Mailchimp profiles and handed to impact-attribution
-- (src/employerAnswers, GitHub #7). Keyed on `<member hash>:<answer hash>`, never the address or
-- the answer text, so a changed answer is a new row. outcome is impact-attribution's result
-- (recorded | invalid | non-answer | closed), which is final, or unmatched | ambiguous when no single
-- People item holds the address, which is checked again a day after checked_at.
CREATE TABLE employer_answers_sent (
  source_id TEXT PRIMARY KEY,
  outcome TEXT NOT NULL,
  person_item_id TEXT,
  checked_at TEXT NOT NULL
);
