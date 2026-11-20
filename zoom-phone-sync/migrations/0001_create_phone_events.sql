-- zoom-phone-sync state (design: docs/superpowers/specs/2026-11-19-zoom-phone-sync-design.md, State).
-- No message text is ever stored: ingest drops the SMS `message` field before anything here sees it.

-- One row per Zoom call element or SMS message that passed the ingest filter.
CREATE TABLE phone_events (
  event_id      TEXT PRIMARY KEY,               -- call_element_id or message_id (the dedupe key)
  kind          TEXT NOT NULL,                  -- call | text
  call_id       TEXT,                           -- calls only: Zoom's call_id, shared by every element of one call
  occurred_at   TEXT NOT NULL,                  -- call start_time or text date_time (ISO 8601)
  zoom_user_id  TEXT NOT NULL,                  -- the staff party
  external_e164 TEXT,                           -- cleared once logged, or when an unmatched row expires
  direction     TEXT NOT NULL,                  -- inbound | outbound (from the staff line's side)
  result        TEXT,                           -- calls only
  talk_seconds  INTEGER,                        -- calls only
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | logged | unmatched | failed | dropped
  received_at   TEXT NOT NULL,
  -- Set once the queue accepted the message. A redelivery of a row still NULL here (the send
  -- failed, or the isolate died between insert and send) re-enqueues it instead of deduping.
  enqueued_at   TEXT,
  logged_at     TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX phone_events_status ON phone_events (status, occurred_at);

-- One row per People item an event is logged on (a shared number logs on each).
CREATE TABLE phone_event_items (
  event_id    TEXT NOT NULL,
  item_id     TEXT NOT NULL,
  timeline_id TEXT,                             -- set once Monday confirms the create
  PRIMARY KEY (event_id, item_id)
);

-- People's Phone column, normalized to E.164, rebuilt nightly.
CREATE TABLE phone_index (
  e164    TEXT NOT NULL,
  item_id TEXT NOT NULL,
  PRIMARY KEY (e164, item_id)
);
