# Volunteers board as the single record of volunteering (Eventbrite-fed, grouped by event)

Status: draft for approval. Date: 2026-11-11.

## Why

Staff open the Volunteers board to answer "who volunteered at this event?" and to run reports on
volunteer activity. Today the board is a frozen import of 2014–2020 Salesforce shifts
(`Historical` always checked, one row per shift, no event). Volunteering since 2020 is on Eventbrite:
opportunities are posted there, people sign up there, and the sign-ups land on **Event Registrations**
with `Role = Volunteer`. Staff don't look there, and a registration list isn't grouped the way they
think (by day/event).

Goal: the **Volunteers board is the only place volunteer participation lives** (old and new).
Eventbrite sign-ups on volunteer listings create and update Volunteers items, and a default view shows
recent events with their volunteers under each.

## Goals

- Eventbrite volunteer sign-ups become real Volunteers items; status follows Eventbrite
  (Registered / checked in / canceled) with staff-set No-Show preserved.
- Default view: last quarter of events, one group per event, newest first, volunteers listed under each.
- Single source of truth: volunteer registrations stop being written to Event Registrations, and the
  existing ones are moved (backfilled) to the Volunteers board.
- Everything that read volunteer registrations from Event Registrations reads the Volunteers board
  instead.
- Reports can count shifts and attendance by person, event and period.

## Non-goals

- Hours. Staff count shifts and attendance; Eventbrite has no hours. Historical hours stay as imported.
- Changing the 2014–2020 Salesforce rows (they keep their Job/Hours/Date/Status and stay Historical).
- Automatically deciding which attendee event a volunteer listing belongs to when it's ambiguous.
- Non-Eventbrite volunteer intake (the separate Volunteer registration management board).

## Anti-goals

- The same volunteer recorded on two boards that can drift apart.
- Breaking volunteer-event emails (reminder/thank-you) or membership-activity counting while moving.
- Sync overwriting an Event link staff chose by hand.
- Thousands of Monday groups (grouping is a saved view on a link column, not one group per event).

## Facts the design rests on (verified 2026-11-11)

- Production Volunteers board: `18437909797` (workspace Donors & Contacts, 3,936 items, latest Date
  2020-11-29). Sandbox v3 copy is `18431577321`; sandbox v4 `18437342662`. Docs that link `18431577321`
  point at the sandbox.
- Events board `18437909790`: one item per Eventbrite event. Volunteer listings come from the
  Eventbrite "(volunteering)" organizer, `Program = Volunteering`, config
  `eventbrite-sync` `attendeeSync.volunteerPrograms`.
- Eventbrite-sync maps attendance Registered/Attended/Canceled (`mapping/attendee.ts`), with
  `mergeAttendance` keeping staff-set No Show/Canceled and never un-attending a check-in.
- Readers of volunteer registrations on Event Registrations:
  - `eventbrite-sync/src/classEmails/*`: volunteer events email their volunteers (needs name + email).
  - `donation-rollups` `volunteerBoards` (Event Registrations, Role = Volunteer, counted label
    `Attended`) feeding the membership activity rule.
- `donation-rollups` already reads the Volunteers board via `historicalVolunteerBoards` (counts status
  `Completed`, uses the Date column). `member-portal` reads the Volunteers board (job, date, hours,
  status) for a donor's volunteer history.
- In real data most volunteer listings **stand alone** (stadium/airport/Viva Calle bike parking, library
  repair days). Some pair with an attendee event (e.g. "Volunteer: 2026 Silicon Valley Bike Summit"
  with "16th Silicon Valley Bike Summit", same date, different Eventbrite organizer). Name+date
  pairing is ambiguous when several events share a date (the Summit day has four). Several same-named
  volunteer listings can share a date (multiple bike-parking shifts).

## Decided with the owner

1. Volunteer sign-ups become real items on the Volunteers board; the status flows from Eventbrite.
2. Single source of truth: not written to both boards.
3. Counting shifts and attendance is enough; no hours.
4. The grouping event is the real-world event: usually named "Volunteer…" on the same date as the
   attendee event, under a different Eventbrite organizer. Pairing is done **by hand by staff**.
5. Existing data is **backfilled**.

## Design (parts, with my calls marked)

**Columns added to the Volunteers board** (all new, bare titles in config; 🔒 = Worker-written):

- `Event` (board relation → Events, staff-editable): the event the volunteer is grouped under.
- `🔒 Eventbrite Listing` (board relation → Events): the volunteer listing the person signed up on.
- `🔒 Eventbrite Attendee ID` (text): idempotency key; a re-sync updates the item.
- `🔒 Attendee Name`, `🔒 Attendee Email` (text/email): needed by class emails for people not linked to
  People, matching today's Registrations columns. *My call.*
- Existing columns reused: `Job` (listing name), `Date` (listing start date), `Status`,
  `Volunteer` (→ People / People (Historical)), `Historical` (unchecked on new items).
- Add the new columns to `scripts/mark-read-only-columns.mjs` `MARKED_COLUMNS`.

**Status mapping** (reusing existing labels): Registered → `RSVP`; Attended (checked in) → `Completed`;
Canceled → `Canceled`; staff-set `No-Show` is preserved by the same merge rule as today. *My call:
`Confirmed`/`Prospect` stay unused by the sync.*

**Default `Event`:** on create, the sync sets `Event` = the listing's own Events item, so stand-alone
volunteer events group correctly with no staff action. After creation the sync **never writes `Event`
again**; staff re-point it to the paired attendee event (or to one listing when several shift listings
share a day). *My call.*

**View:** a saved board view "Recent events" grouped by `Event`, filtered to Date within the last
quarter, sorted newest first. Created by script (not hand-built), idempotent. To verify in planning:
Monday can group a view by a board-relation column through the API; if not, fall back to a mirror/text
column set by the sync and grouped on.

**Sync changes (`eventbrite-sync`):** for an attendee on a `volunteerPrograms` event, upsert a Volunteers
item (keyed by `Eventbrite Attendee ID`) instead of an Event Registrations row. Person linking reuses
the existing email-matching to People. The write switch, dry-run (`dropped`) and outage-retry behavior
apply unchanged. `Role` on Event Registrations remains for non-volunteer rows (Participant) and is
no longer set to Volunteer by the sync.

**Readers moved:**

- Class emails: the volunteer-event audience, recipients and attendance counts come from the Volunteers
  board (listing link = this event). Same refusals, same at-most-once ledger.
- `donation-rollups`: drop the Event Registrations `volunteerBoards` entry (config requires the key,
  may be `[]`); the Volunteers board is counted through `historicalVolunteerBoards` (`Completed`, `Date`).
  New items must therefore carry `Date`, and the "volunteer data loaded before the sweep" behavior must
  keep working. The rollup webhook/board filters need the Volunteers board's changes to trigger a recompute,
  as Event Registrations changes do today (verify in planning).
- `member-portal`: reads the Volunteers board already; confirm new items (empty Job hours) render.

**Backfill (one-time, resumable, ledgered):**

1. For every Event Registrations item with `Role = Volunteer`: create the Volunteers item (attendee link →
   `Volunteer`, listing link, `Event` = listing, Date from the listing, Status mapped from Attendance,
   attendee id/name/email). Idempotent on attendee id.
2. Verify counts per event match, and that no reader still points at those rows.
3. Remove the originals from Event Registrations only after verification (archive first, delete later).
   *My call: archive, not delete.*
4. Run against sandbox first (the CRM Sandbox workspace has its own boards), then production, under the
   write-switch conventions. A production run needs the operator's go-ahead.
5. Pre-fill nothing beyond the listing-as-event default; staff pair the rest by hand.

**Rollout order:** sandbox columns + view → sync change behind the write switch → backfill sandbox →
move readers → production columns → production backfill → remove Registrations volunteer rows. Set
`<worker>:writes` per the repo's switch rules before deploying builds that read it.

## Resolved after the builder check

Answered by the code:

- **Rollups on non-Historical items.** `pageHistoricalShifts` (`donation-rollups/src/monday/client.ts`)
  pages the whole board and reads only Volunteer link, Date, Hours and Status. It never filters on
  `Historical`, so new items are counted by `Completed` + `Date` with no config beyond removing the
  old `volunteerBoards` entry. It runs in the custodian sweep, not per-webhook, so a Volunteers change
  is picked up at the next sweep (as the historical rows are today). Builder: confirm the per-day
  counting in `custodian/membership.ts` is acceptable for several same-day shifts.
- **Status labels.** Production Volunteers Status has `Completed`, `Canceled`, `RSVP`, `No-Show`,
  `Prospect`, `Confirmed`. The sync's attendance vocabulary says "No Show" (Event Registrations), so
  the mapping translates `No Show` ↔ `No-Show`; no label is created.

My calls (mark these when reviewing):

- **Cutover order.** The write switch is per Worker, so hold the whole `eventbrite-sync` Worker
  (`flags.mjs eventbrite-sync writes hold`) until the readers (class emails, rollups) are deployed and
  the backfill has run, then flip it to `on` in the same session. `hold` keeps
  queued sign-ups, and leaving `hold` with `on` processes them, so none are lost and nothing is
  double-counted.
- **Unmatched people.** A volunteer with no People match still gets an item, with `Volunteer` blank and
  name/email filled; the backfill report lists them. They earn no membership activity credit, as today
  (an unlinked registration doesn't count now either).
- **Cancellations.** A cancel for a sign-up with no existing item creates nothing. A cancel for an
  existing item sets `Canceled`.
- **Backfill keys.** Registrations with `Role = Volunteer` but no attendee id, or whose listing isn't a
  `Volunteering` event, are skipped and listed in the report, not guessed at.
- **View fallback.** If grouping a view by the Event relation isn't possible through the API, the
  builder stops and brings that back rather than adding a mirror column that goes stale when staff
  re-point `Event`.

**View-grouping spike (2026-11-11): YES.** On the sandbox Volunteers board (18431577321) a table view
grouped by a `board_relation` column, filtered to Date within the last 90 days and sorted Date desc,
was created in one `create_view_table` call and read back intact (`get_board_info`, view `settings`
and `filter`/`sort`). No mirror column is needed. Working call (the board's own `Event` column id
replaces the throwaway `<EVENT_RELATION_COLUMN_ID>`; Date is `date_mm79agc0` on the sandbox board):

```json
{
  "tool": "create_view_table",
  "boardId": "18431577321",
  "name": "Recent events",
  "filter": { "operator": "and", "rules": [
    { "column_id": "date_mm79agc0", "operator": "within_the_last", "compare_value": ["DAYS", 90] } ] },
  "sort": [ { "column_id": "date_mm79agc0", "direction": "DESC" } ],
  "settings": { "group_by": { "conditions": [ { "columnId": "<EVENT_RELATION_COLUMN_ID>" } ], "hideEmptyGroups": true } }
}
```

Gotchas: sort `direction` must be uppercase `DESC`; lowercase `desc` (as the tool docs show) was stored as
ASC. `update_view_table` takes the same `filter`/`sort`/`settings` shape plus `viewId`. The stored
filter operator reads back as `WITHIN_THE_LAST`. The throwaway column and both test views were deleted.
Not checked: how the grouped view renders in the UI (group order, empty-relation group).

## Left to the builder

Exact column ids/titles, board-relation vs mirror choice for grouping (see View), test layout, the
backfill script's CLI shape, how the sandbox/production configs split.

## Open risks

- Backfilling thousands of Event Registrations rows (including Pledge-to-Ride-sized volumes) must not
  touch non-volunteer rows.
- The membership activity rule double-counting during the cutover window if both boards briefly carry
  the same volunteer (do the reader switch and backfill in one coordinated step).
