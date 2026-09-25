-- One row per address this Worker unsubscribed (or found already unsubscribed/cleaned) because
-- a reviewed Do Not Solicit was set on Monday. Keyed on the normalized email: the audit trail of
-- who was unsubscribed, from which item, and when — and the guard that keeps later column changes
-- from calling Mailchimp again. Rows are never updated or deleted.
CREATE TABLE dns_unsubscribes (
  email TEXT PRIMARY KEY,
  donor_item_id TEXT NOT NULL,
  result TEXT NOT NULL, -- unsubscribed | already-unsubscribed
  unsubscribed_at TEXT NOT NULL
);
