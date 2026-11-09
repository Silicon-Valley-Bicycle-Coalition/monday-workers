# Pledge to Ride on Monday — Design

**Date:** 2026-11-05
**Status:** Proposed. Not built.
**Worker:** `eventbrite-sync` (extends the attendee feed from
`2026-10-26-eventbrite-attendees-class-emails-design.md`).
**Deadline:** the 2027 pledge is due to publish on Eventbrite on 2027-01-15. This has to be live, and
rehearsed in the sandbox, before then.

## Why

Pledge to Ride is the sign-up campaign for Bike to Wherever Days: a free Eventbrite event that runs
for months and collects about 3,000 pledges a year, with a few questions on each. Every year staff
export it from Eventbrite and work the numbers by hand in spreadsheets, for a regional summary report
to MTC due in early June and a metrics workbook that goes back to 2017. Staff asked whether the pledge
should move to Monday forms, or whether its data could flow to a board they can visualize.

## Decision

Keep the pledge on Eventbrite. Send each pledge, with its answers, to a new private **Pledge to Ride**
board, and put a Monday dashboard on that board.

Monday forms were the other option. Rejected, because the 2027 project plan relies on what Eventbrite
does: confirmation emails with sponsor logos and resource links, Eventbrite follower promotion, and
targeted email from Eventbrite. A move would also split the history. Whether Monday forms could
replace those was not tested.

## What the data showed (read 2026-11-05, counts only)

**What the report uses.** The 2026 report and metrics workbook give total pledges, change from the
prior year, and pledges by county: Santa Clara 1,720, San Mateo 563, Outside 623, total **2,906**.
That total is exactly Eventbrite's non-canceled attendee count. The other questions (days pledged,
rider type, how they heard) don't appear in the 2026 report's figures.

**352 of those 2,906 are placeholders.** Their attendee name and email are the literal text
`Info Requested` and all 8 answers are empty. They span 285 orders, all `placed`, and all 285 orders
carry a real buyer address. 2025 has the same thing: 340 of 3,272. Eventbrite doesn't document it;
forum reports point to a checkout variant and to additional ticket holders, and most of these orders
hold a single ticket, so the second reason doesn't explain it alone. They stay counted as pledges,
because that is what has been reported to MTC.

**"Outside" has mostly meant "unknown".** A staff workbook for 2025 has a line "Unknown County (Blank
or Incorrect Zip)" of 513 inside its 787 Outside. Applying a zip list to 2026 gives:

| | Zip list, 2026 | Reported |
|---|---|---|
| Santa Clara | 1,705 | 1,720 |
| San Mateo | 514 | 563 |
| Zip 94303 (straddles both) | 56 | split above |
| Outside the two counties | 274 | |
| No zip | 352 | |
| Malformed zip | 5 | |
| Outside + no zip + malformed | 631 | 623 |

The two don't match exactly (staff's lookup isn't recorded), but about 57% of the reported Outside is
placeholders. Actual pledges from outside the two counties are about 270, not 623.

**The board's own count differs.** Event Registrations holds 2,557 rows linked to the 2026 event,
none named `Info Requested`, so the Salesforce import carried essentially the answered ones. That is
where the README's "2,557 registrations" comes from. It isn't the reported figure.

**Questions change every year.** 2025 asked about age, ethnicity and gender and used "Mailing Zip
Code"; 2026 dropped those and used "Home Zip Code". The project plan also adds a question mid-campaign
(a referral question on 2027-03-01). Question ids are per event.

**Reported totals don't all come from Eventbrite.** 2025 reports 3,758 and Eventbrite has 3,272; a
separate staff sheet carries lower totals including a second Gilroy event. Only 2026 lines up.

**The feed drops the answers.** `EventbriteAttendee` doesn't read `answers`, and Event Registrations
has no columns for them. The Eventbrite attendee object does carry them (`question`, `question_id`,
`type`, `answer`; `answer` is absent when blank, multi-select values joined by ` | `), as seen on the
attendee list endpoint. The single-attendee GET the consumer uses is expected to match; confirm that
first.

## Goals

1. Every pledge reaches the board without an export, within minutes of Eventbrite delivering it.
2. Staff can see the report's figures (total, change from last year, by county) on a dashboard at any
   point in the campaign.
3. The dashboard's total matches Eventbrite's non-canceled count exactly. 2026 is the test: 2,906.
4. A new year's pledge takes one short operator step, not code.

## Non-goals

- Not a move off Eventbrite, and no change to its emails or the sign-up experience.
- Pledgers do not become People, and the board has no People link. People is for real relationships,
  a pledge is a light sign-up, and consent is unknown for placeholders. If staff later want to find
  pledgers who are already People, a script can match on the Email column, with no replay.
- No emailing or Mailchimp from this board.
- No reconciling past reported totals, and no years before 2025.
- Energizer counts, Strava figures, nominations and the rest of the metrics workbook stay where they
  are. The report is still written by a person.

## Anti-goals

- A dashboard total that disagrees with Eventbrite, or that silently redefines what a "pledge" is.
  Duplicates (155 addresses appear more than once) stay counted, as they always have been.
- Pledge answers, or any email address, in logs or in the D1 ledger.
- Pledge answers on a board everyone can read. See "Privacy".

## Design

### Flow

```
Eventbrite attendee.updated (the webhook already registered, no change)
  ▼
route → D1 attendees row → queue            (unchanged)
  ▼
processAttendee
  │  eventId in config.pledge.events?  ── no ──▶ Event Registrations, as today
  ▼ yes
processPledge
  │  1. GET attendee  2. if placeholder: GET its order, for the buyer
  │  3. map answers by that event's config  4. adopt by attendee id, else create
  ▼
Pledge to Ride board ──▶ Monday dashboard
```

The branch goes first in `processAttendee`, before the Events-item wait: a pledge has no Event link,
so it doesn't need the event written, and it skips the per-attendee `getEvent` (a real saving across
3,000 attendees). The event's own item on Events is still written by `processEvent`, unchanged.

**Pledges from a configured event go to the new board only**, not also to Event Registrations: those
rows would add a second copy of the data with no use, since nothing links them to People or sends them
class email. The 2,557 existing 2026 rows stay where they are.

Everything else stays as the Worker already does it: the delivery is a pointer and data comes from the
Worker's own fetch; retries, DLQ and terminal errors; the write switch (`off` dry-runs through the same
recording deps, `hold` waits); `attendees` holds ids and status only. `mondayItemId` on a pledge's row
is a Pledge to Ride item. A deleted or archived item is marked failed and not recreated, as today.

### The board

Private (`board_kind: private`), in the Donors & Contacts workspace, created by an idempotent script
beside the other setup scripts, for both environments. Column lookups go through `bareTitle`. Every
column the Worker writes is added to `MARKED_COLUMNS` with 🔒. The integration user must be subscribed
to the board or it can't write. `monday-backup` never lists a private board its user isn't subscribed
to, so subscribe that user too and add the board to `requiredBoardIds` in `monday-backup/config/backup.json`.

One item per Eventbrite attendee, one board across years.

| Column | Type | Source | Notes |
|---|---|---|---|
| Name | name | attendee name, else buyer's name, else `Pledge <attendee id>` | Never `Info Requested Info Requested` |
| Eventbrite Attendee ID | text | `id` | Idempotency key |
| Year | status | `pledge.events[id].year` | Dashboard filter |
| Status | status | `Pledged`, or `Canceled` when `cancelled` or `refunded` | The dashboard counts Pledged. Kept on cancel, so a re-pledge history survives |
| Pledge Date | date | Pacific day of `created` | Sign-ups over time |
| Email | email | attendee email, else order's buyer email | |
| Details | status | `Complete`, or `Buyer only` for a placeholder | Makes the 352 visible and filterable |
| Zip | text | zip answer, trimmed, cut to 5 digits when it starts with 5 digits | Malformed kept as typed |
| County | status | `pledge.zipCounty` | `Santa Clara`, `San Mateo`, `Outside`, `Unknown` (blank or malformed) |
| Days Pledged | status | mapped choice | 1 day, Multiple days, All month |
| Rider Type | dropdown | mapped choices | Multi-select |
| Heard About It | dropdown | mapped choices | Multi-select |
| Who Asked | text | answer | Free text; the referral contest |
| Contact Consent | checkbox | consent answer | Blank on a placeholder: their consent isn't known |
| Other Answers | long text | any answered question not mapped | So a question added mid-campaign isn't lost |

**County.** `Unknown` is never folded into `Outside`. The dashboard shows them apart, and whoever writes
the report decides how to present them. Zip 94303 (Palo Alto and East Palo Alto) can only go one way;
it goes to San Mateo, since staff's own 2026 figures land closer that way. It is a config value.

### Config

In `config/svbc.json` and `config/sandbox.json`, validated at startup. A config with no `pledge` block
behaves exactly as today.

```jsonc
"pledge": {
  // The board id goes in monday.boards["pledge-to-ride"], where the write switch's dry run finds it.
  "nameMatch": "Pledge to Ride",
  "columns": { /* the table above */ },
  "zipCounty": { "Santa Clara": ["95014", "..."], "San Mateo": ["94002", "..."] },  // listed below
  "events": {
    "1977741403778": {
      "year": 2026,
      "questions": { "319665204": "zip", "319665211": "daysPledged", "319665210": "riderType",
                     "319665213": "heardAbout", "320892542": "whoAsked", "319953628": "consent" },
      "ignoreQuestions": [],
      "choices": { "Multiple days/Varios días ": "Multiple days" },
      "consentValues": ["Yes/Si"]
    }
  }
}
```

- `zipCounty` starts from the list that produced the figures above (written from memory of USPS zips,
  not from a published crosswalk; replace it if a better one turns up, and re-run the acceptance count).
  A well-formed zip on neither list is `Outside`.
  - **Santa Clara:** 94022–94024, 94035, 94039–94043, 94085–94089, 94301, 94302, 94304–94306, 94309,
    95002, 95008, 95009, 95011, 95013–95015, 95020, 95021, 95026, 95030–95032, 95035–95038, 95042,
    95044, 95046, 95050–95056, 95070, 95071, 95101–95103, 95106, 95108–95141, 95148, 95150–95161,
    95164, 95170, 95172, 95173, 95190–95194, 95196.
  - **San Mateo:** 94002, 94005, 94010, 94011, 94014–94021, 94025–94028, 94030, 94037, 94038, 94044,
    94060–94066, 94070, 94074, 94080, 94083, 94128, 94303, 94401–94404, 94497.
- `consentValues` lists the exact answers that tick Contact Consent. Anything else, or no answer, leaves
  it blank; never infer consent. 2026's question is required with one choice, `Yes/Si`, answered by all
  2,554 non-placeholders. 2025 has no consent question, so it stays blank.

- `choices` maps Eventbrite's exact text to the English label. It can't be derived: answers are
  bilingual, and splitting at `/` breaks `Banner/Flyer/Poster/Letrero/folleto`. An unmapped choice is
  written as it arrives, with a warning that gives the question id and not the answer.
- `ignoreQuestions` drops a question entirely, so it is neither mapped nor put in Other Answers.
- An event can be added to `events` for a second campaign, such as the Gilroy pledge.
- The split test (`config/split.test.ts`) gets the new ids.

### A new year's pledge

1. Staff create the event as a **draft** on Eventbrite, with its questions.
2. An operator runs a new script with the event id. It reads the event's questions and prints the
   `pledge.events` block for review, with choices filled in. Deploy it **before the event is published**.
3. Update the dashboard's Year filter.

**If step 2 gets missed**, pledges would quietly go to Event Registrations. So `processEvent` logs one
`console.error` (which Workers Issues raises) when an event's name contains `pledge.nameMatch`
(`"Pledge to Ride"`) and its id isn't in `pledge.events`. Recovery, in order: add the config; clear that
event's ledger ids (`update attendees set monday_item_id = null where event_id = ?`), since a stored id
points at Event Registrations and would otherwise be written to or marked gone; replay with the
backfill; delete the stray rows by hand. Run the same check before backfilling 2025 and 2026: if the
ledger holds rows with item ids for those events, clear them first.

### Keeping the count honest

Nothing today notices a registration the webhook never delivered, and the MTC report will rest on this
number. So the daily check at 15:00 UTC (`src/missedOrders/check.ts`'s slot) also compares, for each
event in `pledge.events` whose end date is within the last 30 days or still ahead, Eventbrite's attendee
total (`pagination.object_count` from one read of the attendee list) with the event's `attendees`
ledger rows. A difference gets one `console.error` with the two counts. Recovery is the backfill. It
reads and logs only, so it follows the missed-order check under the write switch.

### The placeholder fix for every event

The `Info Requested` text isn't specific to pledges. Today `mapAttendee` would send it as a name and as
an email address for any event, and Monday may refuse that as an invalid email. Treat a value with no
`@` as blank in `mapAttendee`, and `Info Requested` as a blank name, with tests. This is independent of
the rest and can land first.

Before that fix, check production for damage (a person with production access; ids and errors only):

```sh
npx wrangler d1 execute svbc-eventbrite-sync --remote --command \
  "select substr(error,1,120) e, count(*) n from attendees where error is not null group by 1 order by n desc"
```

### Backfill

Reuse `scripts/backfill-attendees.mjs`, which replays through the live route. Run 2026 and then 2025.
That is about 6,200 attendees. Each costs one Eventbrite read, plus one for a placeholder. Eventbrite's
published limit is 2,000 calls an hour, so set `--pause-ms` to stay under it and confirm the limit
first; the Worker's other traffic shares the token.

2025 needs its own config block. Map Zip, Days Pledged and Heard About It where its questions fit.
**Put its age, ethnicity and gender questions in `ignoreQuestions`**: nobody asked for them on a board,
and they remain in Eventbrite.

2025's dashboard total will be 3,272 against 3,758 reported. Say so on the dashboard, in a text widget.

### The dashboard

A Monday dashboard, on the Pledge to Ride board.

- **Headline:** total pledges this year; change from last year.
- **By county:** Santa Clara, San Mateo, Outside, Unknown, this year and last.
- **Over time:** pledges by week, this year against last. May brought 62% of 2026's sign-ups, so this
  is what staff will watch.
- **Campaign:** Days Pledged, Rider Type, Heard About It.
- **Text note:** what "Unknown" and "Buyer only" mean, and why 2025 differs from the report.

Whether a widget can do year-over-year as a single chart is for the builder to find out. Two side-by-side
widgets, each filtered to a year, are acceptable.

### Privacy

The board holds names, email addresses, home zip codes and free text. Any team member can read every
Main board in an open workspace, hence private. A dashboard viewer needs access to the board, so access
is a list of people, set up with the BTWD team. Answers and addresses never reach `console.*`;
`check-log-safety` covers this. This repo is public, so no real data goes in tests or fixtures.

## Testing

**Unit:** answer mapping (each answer type, absent `answer`, unmapped question, unmapped choice), county
(5-digit, zip+4, blank, malformed, 94303), placeholder detection and buyer fallback, cancel and refund,
config validation, and the branch in `processAttendee`, including that a non-pledge event is unchanged.

**Sandbox rehearsal, before 2027-01-15.** There is one Eventbrite organization, and production's webhook
covers all its events, so **a new test event would also write to the production boards**. So don't create
one, and don't register the sandbox webhook on the whole organization. Instead, run the sandbox Worker
with the real 2026 event in its config, and replay part of that event with `backfill-attendees.mjs --env
sandbox`: redeliver (no second item), `off` and `hold` on the write switch, and a redelivered canceled
attendee from the 5 in 2026. Real pledges land on the sandbox board, so make that board private too, and
delete it afterward. The unconfigured-event alarm is a unit test.

**First live check, at the 2027 publish:** the people publishing the event make one test pledge, see the
item appear, cancel it, and see it flip to `Canceled`. Whether a cancellation sends `attendee.updated`
hasn't been observed; if not, the daily count check won't catch it either (the total includes canceled),
so the fix is a re-run of the backfill before reading the report figures.

**Acceptance, in production after the 2026 backfill:**
- Pledged count on the board for 2026 is exactly 2,906.
- County is about Santa Clara 1,705, San Mateo 570, Outside 274, Unknown 357. It won't equal the
  reported figures, and the difference is explained above.
- `Buyer only` is 352.

**Staff check:** the BTWD lead compares the dashboard with last year's workbook before relying on it.

Update `eventbrite-sync/README.md` (including its 2,557 figure), `docs/uat/eventbrite-sync.md`, and the
root status table.

## Calls made without staff input

To check when reading:

1. Pledges go to the new board only, from 2027 on, not to Event Registrations as well.
2. `Unknown` stays separate from `Outside`.
3. Zip 94303 counts as San Mateo.
4. Placeholders count as pledges, with the buyer's address and no recorded consent.
5. 2025's age, ethnicity and gender aren't copied. Backfill stops at 2025.
6. No city breakdown. The Zip column keeps it possible; the 2025 workbook had one, the report doesn't.
7. The dashboard's match with Eventbrite is watched daily by a count check, not just tested once.
8. Rehearsal replays the real 2026 event in the sandbox rather than creating a test event, which would
   write to production.

## Open, for the BTWD team

- Who needs access to the board and dashboard.
- Whether MTC should now see `Unknown` separately from `Outside`, since the 2027 report would show
  outside-area pledges dropping sharply on paper from a change in counting alone.
- Whether Eventbrite's support can explain the placeholders and whether a setting prevents them. If
  fixed, `Buyer only` falls to zero and nothing here changes.
