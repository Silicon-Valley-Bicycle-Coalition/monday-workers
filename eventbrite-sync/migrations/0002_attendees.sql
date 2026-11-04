-- Ledgers for the Eventbrite attendee/event feed, keyed on the Eventbrite ids — the idempotency
-- keys (docs/superpowers/specs/2026-10-26-eventbrite-attendees-class-emails-design.md). Like
-- `orders`, nothing personal is stored: the consumer re-fetches each event and attendee.
CREATE TABLE events (
  event_id TEXT PRIMARY KEY,
  monday_item_id TEXT,
  starts_at TEXT,
  ends_at TEXT,
  location_key TEXT,
  eventbrite_status TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  last_action TEXT NOT NULL,
  error TEXT,
  deliveries INTEGER NOT NULL DEFAULT 1,
  received_at TEXT NOT NULL,
  written_at TEXT
);

CREATE INDEX events_ends_at ON events (ends_at);

CREATE TABLE attendees (
  attendee_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  monday_item_id TEXT,
  matched_person_item_id TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  last_action TEXT NOT NULL,
  error TEXT,
  deliveries INTEGER NOT NULL DEFAULT 1,
  received_at TEXT NOT NULL,
  written_at TEXT
);

CREATE INDEX attendees_event_id ON attendees (event_id);
