-- Keyed on the contact's email — Mailchimp's webhook payloads identify a contact by
-- email, not a stable internal id, in the classic Marketing webhook format.
CREATE TABLE pending_inbound_syncs (
  email TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'received', -- received -> queued -> written | failed
  error TEXT,
  received_at TEXT NOT NULL,
  written_at TEXT
);
