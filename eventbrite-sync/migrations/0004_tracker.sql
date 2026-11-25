-- What the Worker last wrote to the Education Tracker and as an event's Grant, which is how it tells
-- its own values from a person's (docs/superpowers/specs/2026-11-04-event-counts-design.md). Monday
-- item ids, numbers and Grant labels only: nothing personal.
CREATE TABLE tracker_counts (
  tracker_item_id TEXT PRIMARY KEY,
  event_item_id TEXT NOT NULL,
  row_date TEXT NOT NULL,
  registered INTEGER NOT NULL,
  checked_in INTEGER NOT NULL,
  no_shows INTEGER NOT NULL,
  written_at TEXT NOT NULL
);

CREATE TABLE event_grants (
  event_item_id TEXT PRIMARY KEY,
  grant_label TEXT NOT NULL,
  tracker_item_id TEXT NOT NULL,
  written_at TEXT NOT NULL
);
