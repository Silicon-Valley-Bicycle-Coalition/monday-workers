CREATE TABLE card_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  donor_item_id TEXT NOT NULL,
  token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX idx_card_tokens_token ON card_tokens (token);
CREATE INDEX idx_card_tokens_donor ON card_tokens (donor_item_id);

-- Enforces "one active token per donor" at the schema level: a second INSERT for a donor that
-- already has a non-revoked token throws a UNIQUE constraint violation. This closes a race where
-- two near-simultaneous first-visits both see no active token (read-then-write, no atomicity)
-- and both attempt to mint one.
CREATE UNIQUE INDEX idx_card_tokens_one_active ON card_tokens (donor_item_id) WHERE revoked_at IS NULL;
