-- Membership activity rule (docs/superpowers/specs/2026-10-09-membership-activity-rule-design.md).
-- One row per Event Registrations item (or 2014-2020 Volunteers item) this Worker has read.
-- qualifies = 1 when Role, Attendance, Hours and the Attendee link all pass the rule; the
-- consumer folds qualifying rows into the owner's membership runs alongside their gifts.
CREATE TABLE volunteer_activity (
  registration_item_id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  owner_item_id TEXT,                -- Attendee / Volunteer link; NULL = unlinked, never qualifies
  owner_board_id TEXT,
  activity_date TEXT,                -- ISO date: the Event's Start, or the Volunteers row's Date; NULL = unknown
  hours REAL,                        -- NULL = blank = counts as 1 hour
  qualifies INTEGER NOT NULL,        -- 0 | 1
  source TEXT NOT NULL,              -- 'webhook' | 'sweep' | 'historical'
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_volunteer_activity_owner ON volunteer_activity (owner_item_id);

-- Migrated Term Start, read from the Donations board. NULL = not read yet (the membership
-- duty's backfill fills it); '' = read, and the gift has no term. Only consulted for gifts
-- dated before membership.fromISO — later gifts are stamped by this Worker itself.
ALTER TABLE gifts ADD COLUMN term_start TEXT;

-- What kind of item a pending row's id names: a Donations item, or an Event Registrations item.
ALTER TABLE pending_recomputes ADD COLUMN kind TEXT NOT NULL DEFAULT 'donation';
