CREATE TABLE letter_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  donor_item_id TEXT NOT NULL,
  year INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE UNIQUE INDEX idx_letter_sends_donor_year ON letter_sends (donor_item_id, year);
