-- The Journey send log (src/journeyLog, spec 2026-11-18-mailchimp-journey-send-log-design.md).
-- One row per Customer Journey email sent to one contact, read from the email's sent-to report.
-- Keyed on the Mailchimp subscriber hash, never the address. A row is `pending` until its timeline
-- entry exists on Monday, then `logged`; `unmatched` / `ambiguous` when no People item, or more
-- than one, holds the address; `failed` after JOURNEY_LOG_MAX_ATTEMPTS failed tries; `dropped`
-- when it was read with writes off, and is never logged.
CREATE TABLE journey_sends (
  campaign_id TEXT NOT NULL,
  email_id TEXT NOT NULL,
  journey_id INTEGER NOT NULL,
  step_id INTEGER NOT NULL,
  delivery TEXT NOT NULL,      -- sent | hard | soft (sent-to's status)
  status TEXT NOT NULL,        -- pending | logged | unmatched | ambiguous | failed | dropped
  people_item_id TEXT,
  first_seen_at TEXT NOT NULL,
  sent_at TEXT,                -- the member /activity send time, else first_seen_at
  logged_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (campaign_id, email_id)
);
CREATE INDEX journey_sends_pending ON journey_sends (status, first_seen_at);

-- How many sent-to rows each Journey email had at the last full read. An email whose emails_sent
-- still equals this is skipped; the mark only moves after every row read is in journey_sends.
CREATE TABLE journey_email_counts (
  campaign_id TEXT PRIMARY KEY,
  sent_to_count INTEGER NOT NULL,
  read_at TEXT NOT NULL
);
