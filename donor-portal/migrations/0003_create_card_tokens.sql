CREATE TABLE card_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  donor_item_id TEXT NOT NULL,
  token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX idx_card_tokens_token ON card_tokens (token);
CREATE INDEX idx_card_tokens_donor ON card_tokens (donor_item_id);
