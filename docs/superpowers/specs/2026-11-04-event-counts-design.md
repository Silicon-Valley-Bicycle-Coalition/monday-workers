# Event counts on the Events board and the Lifecycle Tracker

**Status:** design, 2026-11-04; custom-question answers added 2026-11-05. Waiting on staff approval (see
"Questions for staff"). Nothing built.

## Why

Cherie Barnett asked whether Eventbrite could fill in Monday automatically. Registrations already
reach the CRM **Events** and **Event Registrations** boards (`eventbrite-sync`, live since
2026-11-03). What staff still do by hand, after each class, is look up the numbers and type
**Registered**, **Checked in Attendees** and **No-shows** into the staff-built
[Bike Education Lifecycle Tracker](https://bikesiliconvalley.monday.com/boards/18433254640). The
activity log shows Cherie doing this for the 2026-10-10 repair clinic. The tracker calculates
student-hours and canceled-or-refunded from those three cells.

Other events have one-off boards, each with its own shape. So the counts should live in one place,
not be synced to each board.

The numbers mostly feed **funder reports** (David, 2026-11-04). So a wrong number costs more than a
blank one, and that decides most of what follows.

## Goals

* `eventbrite-sync` keeps three counts on each CRM Events item, for events from a start date onward.
* A tracker row linked to its CRM event gets those numbers in its existing three columns, so its
  formulas keep working and nobody retypes them.
* A person can correct a tracker number, and the Worker leaves that correction alone.
* A one-off board can show the counts with no code, using a connect column and a mirror.
* Home zip and county reach Event Registrations, and the answers SMCTA reports use reach a separate
  restricted board with no names. See "Custom-question answers".

## Non-goals

* Backfilling past classes. Numbers already on the tracker stay, because past reports may have used
  them, and classes before the start date stay manual.
* Linking tracker rows to CRM events automatically. A person picks **CRM Event**, as today (18 of 26
  rows are linked).
* Writing to one-off boards.
* Counting Funraise events (no attendee feed; they load once a year by CSV).
* Ticket type, phone numbers, or any custom-question answer outside the allowlist below. Health,
  emergency-contact, height and waiver answers stay in Eventbrite.

## Anti-goals: this has failed if

* A health, emergency-contact or waiver answer reaches Monday, D1 or a log.
* A survey row on the restricted board carries a name, email, phone or attendee id.

* A funder report carries a number the Worker wrote over a person's correction.
* A tracker row shows another class's numbers because of a wrong link.
* Everyone reads as a no-show before the class has happened.
* A failed count blocks or delays a registration write.

## The rule for the numbers

Counted over the event's active items on Event Registrations (by the **Event** column, not the
Registrants link, which leaves out very large events). All roles are counted, because an event's Role
comes from its organizer account, so an event doesn't mix them.

| Count | Is | When |
|---|---|---|
| Registered | every registration, canceled ones included | always |
| Checked in | Attendance = Attended | once the event has ended, and at least one person is Attended |
| No-shows | Attendance = Registered, No Show, or blank | same as Checked in |

Registered includes cancellations because the tracker's `Canceled or Refunded` formula is
Registered − Checked in − No-shows.

**Zero check-ins reads as "not done", not "nobody came".** When nobody is Attended, Checked in and
No-shows stay blank, on the Events item and the tracker alike, because one-off boards mirror Events. The
class emails treat "nobody checked in" the same way. A class where truly nobody came stays blank for a
person to fill in. Partial check-in can't be detected, so someone not checked in counts as a no-show; the
parallel run is how that gets noticed. There's no grace period: a late check-in corrects itself on the
next hourly run, because the cell still holds the Worker's value.

**An undone check-in stays counted.** `mergeAttendance` never moves Attended backward, and this design
leaves attendee processing alone, since that rule also decides who gets class emails. To fix a mistaken
check-in, edit Attendance on Event Registrations; the count follows within the hour.

**Evidence.** Compared on 2026-11-04 against the 8 finished classes with both tracker counts and a
CRM Event link, all from before the feed: 3 match exactly; 3 are off by one check-in; 1 looks like
check-ins and no-shows were swapped on the tracker (14/11/2 against 14/2/11); and the 2026-10-10
repair clinic is far apart (26/26/0 against 14/8/5), possibly walk-ins. Registered matches on 6 of
the 8. It isn't known which side is right in the mismatches.

## How it works

```
Hourly cron (already exists)
  │  sweepEventCounts: one { kind: 'counts', eventId } queue message per event in the window
  ▼
Same write queue → consumer, processCounts
  │  1. read the event's registrations from Monday (Attendance only), paging
  │  2. compute the three counts
  │  3. Events item: write the counts if they differ from what's there
  │  4. tracker rows whose CRM Event is this item: apply the correction rule, write what changed
  ▼
Events board → one-off boards, by mirror
Lifecycle Tracker
```

**Hourly, not per registration.** Staff edit Attendance on the board (No Show, and the send page sets
it too), and no webhook tells the Worker. Recounting from Monday on a timer catches those edits and
makes the count match the board staff look at. An hour's delay doesn't matter for a report written
after the class. It also keeps registration writes untouched, so a count failure can't affect them.

**The window.** Ledger events (`events` table) with a Monday item and status `written`, whose end (else
start) is on or after `eventCounts.startDate`, and not more than 30 days past. So upcoming events and
the last 30 days of ended ones are recounted. Later edits aren't picked up after 30 days, which also
stops the Worker touching a closed quarter's numbers. A canceled event (ledger `eventbrite_status`
`canceled`) is skipped.

**Failures.** A failed counts message is logged with `console.error` (Workers Issues raises it) and
acked, not retried. The next hourly run does the same work, so a retry only adds load. It changes no
ledger status, because the `events` row's status belongs to the event write and the ended-event sweep
reads it. Under `hold` it retries like any message, as the switch requires. It never reaches the
dead-letter consumer in normal use; if it does, that consumer logs it and touches no row.

### The Events board

Three new number columns: `🔒 Registered`, `🔒 Checked In`, `🔒 No-shows`, added to `MARKED_COLUMNS`
in `scripts/mark-read-only-columns.mjs` under `Events`. Ids in `attendeeSync.events` config.
`📜 Tickets Sold` stays as the history it is. Its board description says it isn't maintained until the
integration runs, so update that to point at the new columns.

### The Lifecycle Tracker

Config `attendeeSync.tracker`, `null` to turn the whole step off: board id, `crmEventColumn`
(`board_relation_mm8r7g27`), `registeredColumn` (`numeric_mm7p1y4p`), `checkedInColumn`
(`numeric_mm7na1kk`), `noShowColumn` (`numeric_mm7p9znq`), `dateColumn` (`date_mm7q7jqv`), `statusColumn`
(`status`), `skipStatusLabels` (`["Cancelled"]`).

**Tracker rows are written only once the event has ended.** Before that, Registered alone would make the
tracker's `Canceled or Refunded` formula show everyone as canceled, and rewrite a staff board every hour.
The Events item is written throughout, so live numbers are on the event.

**Built last, off by default.** The tracker step ships behind `attendeeSync.tracker: null` and is turned
on only after staff answer questions 2, 3 and 4 below. If reports come from the Google Sheet instead, the
tracker step may never turn on, and the Events counts still stand on their own.

**Why write the numbers rather than mirror them.** A mirror can't be corrected by hand, and corrections
are a goal. Writing also leaves the existing formulas alone.

**Correction rule, per cell.** D1 remembers what the Worker last wrote to each tracker row (new table,
migration `0004`: `tracker_counts`: tracker item id, event id, last registered, last checked in, last
no-shows, written at; ids and numbers only). The Worker writes a cell only when it's blank or still
holds the value the Worker last wrote. Anything else is a person's number and stays. Clearing a cell
hands it back to the Worker. A hand-entered number on a row the Worker has never written counts as a
person's number. A blank count (no-shows before the end) is never written, so it can't clear a cell.

**Wrong-link guard.** The row's Date must fall on the event's Pacific start date, or between its start
and end for a multi-day event. Otherwise nothing is written to that row and one warning is logged with
the item ids. A blank cell is visible; a wrong number isn't. A row whose status is in `skipStatusLabels`
is skipped too. If two rows link to one event, each is checked on its own. A row linked to more than one
event is skipped with a warning (the column allows only one, so this shouldn't arise).

**Relinks.** `tracker_counts` is keyed on the row alone, so a relinked row's old value still reads as the
Worker's and gets replaced. A row that is unlinked, or relinked to an event outside the window, keeps its
numbers: the Worker no longer visits it, and it never clears a cell. Clearing or correcting it is a
person's job.

**The tracker is staff's board.** Its columns can be renamed or removed, so a Monday rejection there
(`not retried`-class errors) is logged by column and must not stop the Events write, which comes first.

### One-off boards

No code. A how-to in the staff guide: add a connect column to the CRM Events board, pick the event, add
a mirror of the three count columns. Events is a private board in the CRM workspace; every staff member
has a CRM seat (decided 2026-11-03), and the tracker's CRM Event column already connects to it.

### Write switch and sandbox

`eventbrite-sync:writes` covers all of it. The sweep follows the ended-event sweep (`off`: each send a
`Write queue` skip line; `hold`/`unknown`: skipped). The consumer runs through `dryRunConsumerDeps`, with
a dry-run `tracker_counts` store and the tracker board added to `dryRunMondayClient`'s board labels. A
message stamped `dropped` stays a dry run.

Sandbox: a small scratch tracker board in the sandbox workspace with the same column types, its id in
`config/sandbox.json`. `config/split.test.ts` gains the new keys. The `Staff Boards (sandbox)` workspace
is empty, so there's no copy to use.

## Custom-question answers

**Why.** Funder reports are built from Eventbrite exports. David confirmed on 2026-11-05 that the waiver
sign-off isn't a funder requirement, and chose to bring over home zip and the SMCTA answers. The same
exports hold health and emergency-contact answers that no funder report reads, so this is an allowlist:
a question not named in config is never read past matching, wherever it appears.

| Answers | Used for | Goes to |
|---|---|---|
| Home zip, and county worked out from it | VTA home county | Event Registrations, `🔒 Home Zip` and `🔒 Home County` |
| How heard, why signed up, riding frequency, street and everyday comfort, live or work in San Mateo County, city, gender, age, ethnicity | SMCTA | New restricted board, one row per registration, no names |
| Mental or physical conditions, "please describe", emergency contact, height, release of liability, order and fee columns | No funder report | Nowhere: stay in Eventbrite |

**Reading them.** The consumer already fetches the attendee on every update; from memory, not yet verified,
that object carries `answers` (`question_id`, `question`, `type`, `answer`). One real read confirms the
field and whether it needs an `expand`, before anything is built on it. A pure function picks the allowed
answers, so it can't make a registration write fail.

**Matching on wording.** From memory, question ids are per event, so a list of ids wouldn't carry to the next
class; the real read confirms this. Config lists each allowed question's exact wordings, compared after
trimming and lowercasing. The 2026 VTA report uses three for zip: `What is your home zip code?` (22 sheets),
`Home zip code` (7) and `¿Cuál es el código postal de su domicilio?/What is your home zip code?` (1). A new
wording stays blank until someone adds it, which fails safe: a reworded question can't let the wrong answer
through. Substring matching isn't allowed, because "please describe" style follow-ups can sit beside any
question. An attendee with answers but no zip match logs its event and question ids at info level, never the
wording or the answer.

**Zip and county.** The zip is written only if the answer starts with five digits, keeping those five, so free
text can't land in the column. County comes from a config table seeded from the report's `Zip Codes - Counties`
sheet; an unlisted zip leaves county blank. That sheet needs staff review first (question 7): it has 39 zips,
none for most of San Jose; it lists 94022 (Los Altos) as San Mateo County, which looks wrong; and it lists
94303 as Santa Clara County while the Q3 report treats it as either. A blank is visible, and a report can count them.

**The restricted board.** A private board in the CRM workspace, with Cherie and whoever she names as
subscribers, plus the integration user, which has to write to it. One row per registration, from the
answers start date onward, only when at least one SMCTA answer is present. Each row holds the event name, class date,
the answers, and `🔒 Canceled` (Eventbrite's cancelled or refunded state). The item name is the fixed word `Response`.
No name, email, phone, zip, attendee id, or link to People or Event Registrations. City stays because SMCTA uses it.

D1 keeps `answer_rows` (attendee id, Monday item id, written at) so an updated answer changes the same row.
This table holds no answers, but it does make the rows **pseudonymous, not anonymous**, and:

* **The privacy here is limited, so say so to staff.** Anyone who can read this Worker's D1 can re-link a row
  to a person, and a small class's age, gender and city can identify someone without it. Free-text answers can
  name people. Rows created in order can line up with registration times.
* **A private board isn't a wall against the Workers.** One integration user backs all three OAuth apps, so the
  internet-facing `member-portal`'s read-only token can read this board too ([GL#18](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/18), accepted; see the root README).
  Having no names on the board is what limits the damage, so that rule is the real control.
* **Backups.** `monday-backup` snapshots every board the integration user can see, so this board goes in its
  `excludeBoardIds`. The answers can be rebuilt from Eventbrite, so nothing is lost for good.
* **Ages.** The SMCTA report's age question includes under 13. Eventbrite already holds this, but the board is a second copy.

**Failures.** Zip and county are part of the registration write, as ordinary columns, and written only when
non-blank so they can't clear a cell. The survey row is its own later write, like the registrants link: a failure
logs and never fails the registration, and a small backfill script re-runs an event. A new row only ever comes from
the attendee's own webhook, so the script is how a missed one is recovered. Under the write switch both follow
`eventbrite-sync:writes`, and logs carry ids only, never question text or answers.

**Start and order.** Separate from the counts, with its own `answers.startDate`, and it doesn't wait for a real check-in.
Past classes stay as exports. `surveyBoard: null` keeps the board step off if staff say SMCTA no longer needs it.
The parallel run covers these too: compare one quarter's Monday numbers against the export before retiring it.

## Rollout

1. **Prerequisite:** see a real check-in reach Attendance. None has yet; the first events in the feed run
   2026-11-08 and 09. Don't turn counts on before this, because a funder number would rest on it.
2. Check the integration user can write to the tracker
   (`node scripts/check-monday-token-scope.mjs --workspace 12570563`).
3. Sandbox rehearsal, then production with `eventCounts.startDate` set to the first class with a proven
   check-in.
4. **Parallel run:** for the first three classes or a month, whichever is longer, staff keep pulling the
   Eventbrite numbers and compare. Any difference gets explained before the manual step stops.
5. Update the staff guide (§4), the README, the UAT script and the root status table.

## Questions for staff

These change what gets built. They go to Cherie with the plan.

1. **Is the Registered / Checked in / No-shows count the information being pulled,** along with the answers
   listed under "Custom-question answers"? Or is there more?
2. **Walk-ins.** There's a `Walk-in registration.docx` in the same folder. Do walk-ins get added to
   Eventbrite? If not, the count will be low for those events and someone corrects it by hand. Does that
   explain the repair clinic's 26?
3. **Which tracker is live?** A Google Sheet named `Bike Education Lifecycle Tracker` in that folder was
   modified 2026-11-02. Are reports built from the Monday board or the Sheet?
4. **Is check-in always done in Eventbrite?** If some classes take attendance on paper, or check in only
   some people, the numbers will be blank or low for those.
5. **Which one-off boards take these numbers,** and is a mirror enough there?
6. **Does SMCTA still need these answers in 2026, for which classes, and from registrants or only attendees?**
   The file we have is from 2025. Rows cover registrations, with canceled ones marked; if reports count only
   attendees, the board needs Attendance, which brings it closer to a person's record.
7. **Is the zip-to-county table right?** See "Zip and county". Which county should 94303 count as?
8. **Who should see the restricted board?** And how do instructors get health and accommodation answers now?
   Those stay in Eventbrite, so whatever they use today has to keep working.
9. **The Q3 report shows two sets of numbers:** the attendance chart has 66 / 138 / 44 and the class table
   49 / 105 / 41, and the 56% sent to VTA comes from the chart. Which is right? The parallel run needs to know.

## Left to the builder

Query shape and paging for reading registrations; how the tracker rows are found (per event, or one read
per sweep); column creation (API or UI); batching the sweep's sends; message and log wording. Watch the
Worker's 100 ms CPU limit on a large event such as Pledge to Ride's 2,557 registrations; if a window ever
includes one, exclude it by config, as `registrantsLinkExcludedEventIds` does.

## Calls made in this design (David to check)

* Hourly recount from Monday, not event-driven or from the D1 ledger.
* Failed counts are logged and left for the next hour, not retried.
* The 30-day window, and leaving canceled events and Cancelled tracker rows alone.
* The date check that leaves a row blank on a mismatch.
* Blank Checked in and No-shows when nobody is Attended, and tracker writes only after the event ends.
* Leaving undone check-ins counted until someone edits Attendance.
* Building the tracker step last, off until staff answer.
* Column names, and writing tracker numbers instead of mirroring them.
* The parallel run's length.
* Exact-wording matching, and leaving a new wording blank instead of guessing.
* Keeping zip off the restricted board, and city on it.
* Rows for all registrations with a Canceled mark, until staff answer question 6.
* Leaving the restricted board out of Monday backups.
* Text event name and date on the restricted board, not a connect column to Events.
