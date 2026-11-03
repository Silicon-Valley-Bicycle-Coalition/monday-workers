-- Which registrations have been sent which class email, so a second click, a second tab or a second
-- staff member can't email the same person twice. Ids and statuses only: the page that sends the
-- email re-reads names and addresses from Monday, so nothing personal is stored here.
-- status: claimed (a send is in flight or was interrupted), sent, failed.
CREATE TABLE class_email_recipients (
  event_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  registration_item_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'claimed',
  claimed_at TEXT NOT NULL,
  resolved_at TEXT,
  PRIMARY KEY (event_id, kind, registration_item_id)
);
