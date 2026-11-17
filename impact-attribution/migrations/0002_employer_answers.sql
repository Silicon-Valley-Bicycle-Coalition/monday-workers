-- Employer answers handed over by other Workers (Eventbrite's "where do you work" question).
-- Answer text is stored here and written into Monday comments; it is never logged.
CREATE TABLE employer_answers (
  source            TEXT NOT NULL,
  source_id         TEXT NOT NULL,
  person_item_id    TEXT NOT NULL,
  answer            TEXT NOT NULL,      -- trimmed, at most 200 characters
  answer_normalized TEXT NOT NULL,
  answered_at       TEXT NOT NULL,      -- YYYY-MM-DD
  context           TEXT NOT NULL,
  state             TEXT NOT NULL DEFAULT 'pending'
                    CHECK (state IN ('pending', 'proposed', 'skipped', 'expired', 'superseded')),
  org_item_id       TEXT,
  received_at       TEXT NOT NULL,
  last_tried_at     TEXT,
  PRIMARY KEY (source, source_id)
);
CREATE INDEX employer_answers_person ON employer_answers (person_item_id);
CREATE INDEX employer_answers_state ON employer_answers (state);

-- Which evidence produced a Draft: matching gifts, employer answers, or both.
ALTER TABLE proposals ADD COLUMN sources TEXT NOT NULL DEFAULT 'matches' CHECK (sources IN ('matches', 'answers', 'both'));
