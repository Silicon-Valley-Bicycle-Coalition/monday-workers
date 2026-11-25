# Class totals on the Education Tracker, and the grant report

**Status:** design, rewritten 2026-11-24 after Cherie Barnett's request; David chose class totals, written by
the Worker, and approved this version the same day. Plan: [`2026-11-24-education-tracker-totals.md`](../plans/2026-11-24-education-tracker-totals.md). The 2026-11-04 version (git history) also had count columns on Events
and a restricted SMCTA answers board. Both are dropped; see "Approaches". Release 1's zip code was designed in
[`2026-11-04-eventbrite-grant-report-design.md`](2026-11-04-eventbrite-grant-report-design.md) and is built; where
the two differ, this document wins.

## Why

Cherie asked for Eventbrite's Custom Questions reports to reach Monday on their own, so funder reports come
from data held in one place. Today staff export one report per class (Deanna's protocol: every attendee status,
name, email, ticket type, date attending, order and fee columns, all custom answers) and paste it into two
workbooks, one for VTA and one for SMCTA. They look up a county per zip and build the quarter's charts. They
also type Registered, Checked in and No-shows into the
[Bike Education Lifecycle Tracker](https://bikesiliconvalley.monday.com/boards/18433254640).

What the workbooks chart from registrations is attendance (checked in, no show, canceled), registrations per class and home
county. Staff said on 2026-11-04 that funders need, per person: name, email, date attending, zip, checked in,
no show, canceled. Event Registrations already holds all of that except zip.

The numbers feed funder reports, so **a wrong number costs more than a blank one**. That decides most of what follows.

## Goals

* Each tracker row linked to an Eventbrite class gets its three totals after the class, with no typing.
* A person can correct them, and the Worker then leaves that row's totals alone.
* A funder's per-person list, with zip and county, is one filtered view on Event Registrations, and the charts read the same rows.
* Nobody enters the grant twice: the tracker's Funder is the source.

## Non-goals

* Person rows, or any name, email or zip, on the tracker: it is a Main board, and its subitems are the task checklist.
* Any custom answer other than zip. Fees, ticket types and order numbers stay in Eventbrite too. (Phone and
  employer answers are separate features with their own designs.)
* The post-class survey, already a Monday form.
* Classes before November 2026. Staff's data is complete through October.
* Linking a tracker row to its class. A person picks **CRM Event**, as today (19 of 27 rows on 2026-11-24).
* Count columns on Events, and one-off boards.

## Failed if

* A health, emergency-contact or waiver answer, or free text typed into a zip question, reaches Monday, D1 or a log.
* A Worker number replaces a person's.
* A row shows another class's numbers because of a wrong link.
* Everyone reads as a no-show before the class has happened, or when nobody took attendance.
* A failure here blocks or delays a registration write.

## Approaches

**What goes on the tracker.** Class totals (David, 2026-11-24), over a row per registrant, which would put
personal data on a board all staff read and mix it into the checklists.

**How totals get there.**

| | Trade-off |
|---|---|
| **The Worker writes the existing columns** (David's choice, 2026-11-24) | Most code; corrections stay, formulas keep working |
| Mirrors of counts on Events | Less code; nobody can correct a mirror, and formulas and typed history would need rebuilding |
| Fill each blank cell once | Simplest; a late check-in never reaches the report |

**Dropped.** The restricted SMCTA answers board, because staff moved those questions to the post-class survey
(2026-11-04). Counts on Events, which only served one-off boards nobody has asked for since.

## Evidence (2026-11-24, read from the live boards)

Six classes and rides since 2026-11-09 have a linked Eventbrite event and totals typed on the tracker.
Numbers are registered / checked in / no-shows; "feed" uses the rule below.

| Class | Tracker | Feed | |
|---|---|---|---|
| 11-09 Lyft Bike Basics | 16 / 6 / 10 | 17 / 7 / 9 | one late cancellation and one check-in apart; which side is right is unknown |
| 11-12 Active 101 ride | 10 / 8 / 2 | 10 / 8 / 1 | tracker counted the cancellation as a no-show |
| 11-14 E-Bike Basics | 11 / 7 / 4 | same | |
| 11-16 Smart Cycling 1 | 11 / 7 / 4 | same | |
| 11-18 Winter Biking | 6 / 4 / 2 | same | |
| 11-21 Smart Cycling 2 | 4 / 2 / 2 | same | |

So check-ins do reach Attendance, which was the 11-04 design's prerequisite. The 11-14 Sunnyvale repair clinic
(36 checked in, typed) is linked to its *volunteer* listing, whose sign-ups go to the Volunteers board; walk-ins
aren't in Eventbrite.

## Release 1: zip and the grant report

1. **Spanish wording.** `homeZip.ts` also accepts a `text` question containing `código postal` (accented or
   not), any case. Every zip wording on the 2026 sheets already matches except SMCTA's 2026-09-20
   `¿Cuál es el código postal de tu domicilio?`. The value rule is unchanged: five digits or ZIP+4, else discarded.
2. **Production Monday setup**, as the grant report design lists it:
   * **Home Zip**, text, on Event Registrations; its id goes in `homeZipColumn` (still the placeholder); lock it.
   * **Grant**, a dropdown on Events, labels VTA and SMCTA, with a mirror on Event Registrations through **Event**.
   * The **Grant report** view, to the sandbox copy's settings (291176794).
3. **Backfill** every November 2026 VTA and SMCTA class with `scripts/backfill-attendees.mjs`. Until release 2, a
   person sets Grant on those.
4. **Dashboard** on Event Registrations: Attendance, registrations per Event, and Home Zip, filterable by Grant
   and Class Date. Built by hand in Monday: connector-made private dashboards lock out their owner and drop widget filters.
   Grant there is a mirror, proven as a table-view filter but not a dashboard one. If it doesn't filter, use chart views on the
   board, which take the board's own filters. If neither works, stop and come back: the Worker would have to copy Grant onto registrations.

A past class's `Registered` row is a no-show in these reports, as Eventbrite's `Attending` is in the workbooks today.
Staff may still set No Show. The view's description says so.

## Release 2: totals and grant, from the tracker

An hourly job in the existing cron, shaped like the send-link sweep (`src/sendLinks/sweep.ts`): it reads and writes Monday
directly, needs no queue message, and has no cursor, so a failed run is redone the next hour.

```
hourly cron → read tracker rows (Date, Status, Funder, CRM Event, three counts)
            → read the linked Events items (Date, End, Event Status, Program, Eventbrite ID, Grant)
            → guards → Grant onto Events → count registrations → write or clear the tracker's Worker-owned rows
```

**Guards, for both Grant and totals.** A row *qualifies* when all hold:

* its Status is not in `skipStatusLabels` (`Cancelled`), and its Date is on or after the start date (`grantStartDate` for Grant,
  `startDate` for totals);
* it links to exactly one Events item, which is active and has an Eventbrite ID;
* that event's Program is not in `attendeeSync.volunteerPrograms`;
* the row's Date falls on the event's Pacific days, start through end.

A row fails a guard only on data that was read. A failed or partial Monday read fails the run, and changes nothing.
That includes a column missing from what Monday returned, which is how a deleted or retyped column reads (checked 2026-11-24).

**Totals** also need Event Status `Completed` (the ended-event sweep keeps that current) and at least one Attended. All three
are then written together:

| Total | Is |
|---|---|
| Registered | every active registration linked by **Event**, canceled included |
| Checked in | Attendance = Attended |
| No-shows | Attendance = Registered, No Show or blank |

Canceled registrations count only in Registered, so the tracker's `Canceled or Refunded` formula (Registered − Checked in −
No-shows) comes out right. With **nobody Attended** no total is written, Registered included: attendance probably wasn't taken,
and the formula treats blanks as 0 (checked 2026-11-24), so Registered alone would show everyone as canceled. Attendance is
read with `statusText`, never `text`.

**Feed not settled.** If any D1 `attendees` row for the event isn't `written`, its totals are *held*: nothing written, nothing
cleared. A blank sends staff to look; a short count doesn't. D1 can't show a delivery that never came, which the parallel run is for.

**Whose row it is.** D1 table `tracker_counts` (migration `0004`): tracker item id, event item id, the row's Date, the last three values written,
written at. Ids, dates and numbers only.

* A row is **a person's** when any of its three cells holds a number that isn't what the Worker last wrote there. The Worker leaves all
  three alone, because the formula mixes them: correcting one while the others moved would make it wrong. Clearing that cell hands the row back.
* Otherwise the Worker writes the totals where they differ. A number on a row it never wrote is a person's, so today's typed totals stay.
* **A row that stops having totals** (unlinked, relinked, Cancelled, date moved, event reopened, nobody Attended any more) has its
  Worker-written cells cleared and its record deleted, unless it's a person's. A relinked row then gets the new event's totals if it
  qualifies. This is the only clearing the job does, and it's what stops one class's numbers staying on another's row.
* **30 days after its Date, a row is frozen**: neither written nor cleared, so a closed quarter's numbers don't move. A Date
  edited to fall outside the window freezes it too, and so does the Date the numbers were written under, so blanking or moving Date
  can't reopen a closed class. Once someone empties the row it starts over.

Monday is written before D1. If the D1 write is lost, the row reads as a person's until cleared, which is the safe side.

Walk-ins: staff type all three numbers, and the row is theirs from then on.

**A mistaken check-in stays counted.** `mergeAttendance` never moves Attended back (it also decides who gets class emails), and this
design leaves it alone. Staff fix Attendance on Event Registrations, and the total follows within the hour. The same goes for a reinstated order.

**Grant.** Funder `VTA` → `VTA`, `SMC` → `SMCTA`, any other Funder → no grant (`grantByFunder` in config). Per event, over its qualifying rows:

* A blank Funder doesn't vote. If the rest agree, that's the event's Grant; if they disagree, nothing is written and it warns.
* The Worker writes a Grant that differs, including one a person set. Finding the same value already there, it records it as its own.
* D1 table `event_grants` (event item id, Grant, tracker item id) is what the Worker wrote or adopted, and the row behind it. When an event ends up with no grant, or no qualifying
  row, its Grant is cleared only if it still equals that record and that row is still on the board (archiving finished rows clears nothing). So a mis-link, once fixed, doesn't leave a class in VTA's
  report. A Grant on an event no row ever linked is never touched.
* There is no 30-day limit: a Funder correction reaches old registrations too.

The column becomes `🔒 Grant` at this release (`MARKED_COLUMNS`). `grantStartDate` is 2026-11-01; `startDate` is the day release 2 goes live.
Two rows may link to one event, and then both show its totals.

**Added after the code review (2026-11-24).** A run that would clear more than five things (rows and Grants) clears none of them and
logs an error, so a renamed Funder label or a mass edit can't empty a funder's report. Each row is read again just before it's
written, and left alone if its numbers or link changed. A write Monday refuses on its content doesn't count toward the three-failure stop.

**How staff see a gap. Worker warnings (date mismatch, double link, Grant conflict, feed not settled) go to the log once a day, at
the check hour, with item ids only. Staff don't read logs, so the tracker gets a **Totals missing** view: Date before today, Registered empty, Status not Cancelled.

**Config** `attendeeSync.tracker`, `null` turns the whole job off (how it ships): board id 18433254640, `crmEventColumn` `board_relation_mm8r7g27`,
`registeredColumn` `numeric_mm7p1y4p`, `checkedInColumn` `numeric_mm7na1kk`, `noShowColumn` `numeric_mm7p9znq`,
`dateColumn` `date_mm7q7jqv`, `statusColumn` `status`, `funderColumn` `color_mm7nbsn0`, plus the values above and
`attendeeSync.events.grantColumn`.

**Failures.** The tracker is staff's board and its columns can change. A refusal is logged with the item and column ids,
the next row goes on, and the job stops after three failures in a row. It shares nothing with registration writes.

**Write switch.** As the send-link sweep: `off` counts what it would write and writes neither Monday nor D1; `hold`/`unknown` skips.

**Sandbox.** A scratch tracker board in the sandbox workspace, its ids in `config/sandbox.json`, the new keys in
`split.test.ts`. Sandbox crons are off, so the handler is run by hand.

## Release 3: county

`🔒 Home County`, text, on Event Registrations, written with Home Zip (`registrations.homeCountyColumn`, placeholder = off).

The Worker already has a zip table: `pledge.zipCounty`, with San Mateo and Santa Clara zips (it puts 94022, Los Altos, in Santa Clara, where the VTA
sheet says San Mateo). Use it, and don't change it, because Pledge to Ride's results depend on it. On top, a new
`attendeeSync.zipCounty` holds (a) lists for Alameda, San Francisco, Contra Costa, Marin, Napa, Solano, Sonoma, San Benito, Monterey and Santa Cruz,
from Census data, and (b) overrides, which win: `94303` → `SMC or SCC`, as the Q3 VTA report has it. Any other zip that crosses a county line
takes the county holding most of its people. A zip in no list leaves county blank; when a person's zip changes to one, county is
cleared, so the pair never disagrees. **Staff approve the added lists and 94303 first.** Then re-drive the November classes and
add county to the view and dashboard.

## Rollout

1. Release 1. Staff compare one November class's export against the view.
2. Before release 2, prove the integration user can write the tracker. The scope script only reads, so it can't show this. With David's
   go-ahead, set and clear Registered on a Cancelled row with the integration's token. Staff link the 12-03 and 12-08 rows, whose events already exist on Events.
3. Release 2, then a parallel run: for the first three classes staff pull Eventbrite's numbers, and any difference is
   explained before they stop. Include a class with a cancellation.
4. Release 3 after the table review.
5. Each release updates `eventbrite-sync/README.md`, `docs/uat/eventbrite-sync.md`, the staff guide and the root status table.

## Testing

Unit: the count rule (cancellations, nobody attended, none registered); each guard; row ownership (blank, Worker's,
person's in one cell, handed back, unlinked, relinked, frozen, held); Grant mapping, blank and conflicting Funder, adopted, cleared after a mis-link; zip wordings, English, bilingual and Spanish-only; county
lookup, unknown and changed zip; `off` writes nothing. No-leak: an attendee with health and emergency answers leaves
no trace in a write or log. A failed read clears nothing. Sandbox: one class through all three releases.

## For staff (none blocks release 1)

1. Are the added county lists right, and is `SMC or SCC` right for 94303? Pledge to Ride counts it as San Mateo. (Blocks release 3.)
2. Who adds walk-ins, and where?
3. When is the next report due?

## Left to the builder

Query shape and paging; where the county table file lives; log wording; how the Worker tells a column refusal from an outage.

## My calls, for David to check

* The job runs in the cron rather than through the queue, unlike the 11-04 design.
* Counts on Events are dropped.
* A person's number in one cell makes the whole row theirs, not only that cell.
* The Worker clears its own totals and Grant when a link turns out wrong. It overwrites a Grant set by hand on an event the tracker knows.
* The 30-day freeze on totals but not on Grant; the 2026-11-01 Grant start.
* A class with any unfinished registration in D1 gets no new totals.
* Mistaken check-ins stay counted until staff fix Attendance.
* Volunteer-program events are skipped, so the repair clinic stays typed.
* A class with nobody checked in gets no totals at all, Registered included.
* County builds on Pledge to Ride's table and leaves that table as it is.
* Skipped rows show up in a view, with no message to staff.
* Three classes of parallel run.
