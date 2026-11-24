# Education Tracker totals and grant report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put zip, county and grant on Event Registrations, and keep each class's three totals on the Education Tracker without overwriting a person's numbers.

**Architecture:** Release 1 and 3 extend the existing attendee mapping. Release 2 is an hourly cron job that reads the tracker, its linked Events items and their registrations, plans every change with pure functions, and only then writes. Two D1 tables remember what the Worker wrote, which is how it tells its own values from a person's.

**Tech Stack:** Cloudflare Workers, D1, TypeScript, vitest; `src/monday/graphql.ts` transport (a copy: never edit it).

**Spec:** `docs/superpowers/specs/2026-11-04-event-counts-design.md`

## Global Constraints

- Run from `eventbrite-sync/`. Type-check with `npm run typecheck`, never bare `tsc`. Run `npm test` with the command sandbox off (it binds a port).
- Logs carry ids and error classes only. `node ../scripts/check-log-safety.mjs` stays clean.
- D1 stores ids, numbers, and Grant labels only.
- SVBC ids and labels live in `config/*.json`. Both configs must validate, and `config/split.test.ts` must pass.
- Read status cells with `statusText`, never their text.
- No answer but a validated zip (and the existing phone and employer features) is read.
- Conventional commits; the message ends with the session's attribution line.
- **Operator steps (Tasks 2, 8 and 10) change production. Ask David before each one, and never run them as part of a code task.**
- Each release is its own PR. Open one, or merge, only on David's say-so.

## Review Focus

1. A blank Funder, which Monday shows as the text `Other` (label id 5): it doesn't vote on Grant (Task 4).
2. Monday returns no tracker rows, or omits a linked event: nothing is cleared (Task 7).
3. A row relinked to a class whose feed isn't settled: the old class's numbers go, the new ones wait (Task 5).
4. Staff type `0`: that's a person's number, not a blank (Task 5).
5. The 00:00 UTC run, still the previous day in Pacific time: the 30-day freeze goes by the Pacific day (Task 3).

## Files

| File | Responsibility |
|---|---|
| `src/mapping/homeZip.ts`, `src/mapping/homeCounty.ts` | zip answer; zip to county |
| `src/tracker/types.ts`, `qualify.ts`, `grants.ts`, `totals.ts` | shapes and pure planning, no I/O |
| `src/tracker/sweep.ts` | reads, plans, writes, summary |
| `src/db/tracker.ts`, `migrations/0004_tracker.sql` | what the Worker last wrote |
| `src/monday/client.ts`, `src/config.ts`, `src/types.ts`, `src/index.ts` | one read, config, wiring |

---

## Release 1: zip and the grant report

### Task 1: Spanish-only zip wording

**Files:** Modify `src/mapping/homeZip.ts`; test `src/mapping/homeZip.test.ts`

- [ ] **Step 1: Failing tests**

```ts
it.each([
  '¿Cuál es el código postal de tu domicilio?',
  'CODIGO POSTAL',
  '¿Cuál es el código postal de tu domicilio?'.normalize('NFD'),
])('reads the Spanish question "%s"', (w) => {
  expect(homeZipFromAnswers([zip(w, '95112')])).toBe('95112');
});
it('still rejects a typed note under the Spanish question', () => {
  expect(homeZipFromAnswers([zip('código postal', '95112 llámame')])).toBeNull();
});
```

- [ ] **Step 2:** `npm test -- src/mapping/homeZip.test.ts`. Expected: the three Spanish cases FAIL.
- [ ] **Step 3: Implement.** `ZIP_QUESTION` also matches `c[oó]digo\s+postal`; NFC-normalize the question before testing it. The value rule doesn't change.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5:** Note the wording in README "Grant report"; commit `feat(eventbrite-sync): read the Spanish zip question`.

### Task 2: Turn it on in production (operator, with David)

- [ ] **Step 1:** On production Event Registrations create **Home Zip** (text). On Events create **Grant** (dropdown, labels `VTA`, `SMCTA`), then a mirror of it on Event Registrations through **Event** (`board_relation_mm8n8a86`).
- [ ] **Step 2:** Put Home Zip's id in `config/svbc.json` `homeZipColumn`; commit, deploy, then run `scripts/mark-read-only-columns.mjs` to lock it.
- [ ] **Step 3:** Build the **Grant report** view to the settings of sandbox view 291176794: Name, Attendee Email, Event, Class Date, Home Zip, Attendance, Grant; Grant not empty; grouped by Grant; Class Date newest first. Its description says a past class's `Registered` is a no-show.
- [ ] **Step 4:** Set Grant on each November VTA and SMCTA class, then run `backfill-attendees.mjs` per event, `--dry-run` first.
- [ ] **Step 5:** Build the dashboard by hand and check that Grant filters it. If not, use board chart views. If neither filters, stop and tell David.
- [ ] **Step 6:** Read the new columns back in the Monday UI, not only the API. Update README, `docs/uat/eventbrite-sync.md`, `docs/manual/workers/eventbrite-sync.md` and the root status table.

**Passes when** staff's export of one November class matches the view row for row on name, email, date, zip and status.

---

## Release 2: totals and grant

### Task 3: Shapes, config and which rows qualify

**Files:** Create `src/tracker/types.ts`, `src/tracker/qualify.ts` and its test. Modify `src/types.ts`, `src/config.ts`, `src/test/testConfig.ts`, both configs, `config/split.test.ts`; test `src/config.test.ts`

**Interfaces — produces:**

```ts
// src/types.ts: attendeeSync.events gains grantColumn: string;
// attendeeSync.tracker: TrackerConfig | null
interface TrackerConfig {
  boardId: number;
  crmEventColumn: string; registeredColumn: string; checkedInColumn: string; noShowColumn: string;
  dateColumn: string; statusColumn: string; funderColumn: string;
  skipStatusLabels: string[]; grantByFunder: Record<string, string>;
  startDate: string; grantStartDate: string; // YYYY-MM-DD
}
// src/tracker/types.ts
interface Totals { registered: number; checkedIn: number; noShows: number }
interface TrackerRow { itemId: string; date: string; status: string; funder: string; eventItemIds: string[];
  cells: { registered: number | null; checkedIn: number | null; noShows: number | null } }
interface TrackerEvent { itemId: string; active: boolean; eventbriteId: string; program: string; status: string;
  date: string; end: string; grant: string } // dates are 'YYYY-MM-DD' or ''
type Verdict = { kind: 'ok'; event: TrackerEvent } | { kind: 'no'; reason: string } | { kind: 'unknown' }
// src/tracker/qualify.ts
qualify(row, events: Map<string, TrackerEvent>, startDate: string, cfg: { skipStatusLabels: string[]; volunteerPrograms: string[] }): Verdict
isFrozen(date: string, now: Date): boolean
```

`unknown` means the row's one linked event wasn't in the read: neither write nor clear. Events `Date` and `End` are already Pacific calendar dates, so compare strings.

- [ ] **Step 1: Failing tests** for `qualify`: ok on the start day; ok on the last day of a multi-day event; with no End, only the start day; and `no` for each of: status `Cancelled`, blank date, date before `startDate`, no link, two links, inactive event, blank Eventbrite ID, program `Volunteering`, date a day after End. `unknown` when the linked id isn't in the map. For `isFrozen`:

```ts
// 2026-12-15T00:00Z is still 2026-12-14 in Pacific time.
expect(isFrozen('2026-11-14', new Date('2026-12-15T00:00:00Z'))).toBe(false); // exactly 30 days
expect(isFrozen('2026-11-13', new Date('2026-12-15T00:00:00Z'))).toBe(true);
expect(isFrozen('', new Date('2026-12-15T00:00:00Z'))).toBe(false);
```

- [ ] **Step 2: Failing config tests:** `tracker: null` validates; a missing `funderColumn`, a non-integer `boardId`, or a `startDate` of `soon` throws naming its key; a tracker with `grantColumn` still the placeholder throws `attendeeSync.events.grantColumn`.
- [ ] **Step 3:** `npm test -- src/tracker src/config.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement.** Ship `tracker: null` and `grantColumn: "REPLACE_WITH_COLUMN_ID"` in both configs (sandbox Grant is `dropdown_mm8t5b6g`; set it there). In `split.test.ts` add `grantColumn` to `COLUMN_KEYS`, exempt it from the "production fills" test as `homeZipColumn` is, and assert the two `tracker.boardId`s differ when both are set.
- [ ] **Step 5:** Run `npm test` and `npm run typecheck`. Expected: PASS. Commit `feat(eventbrite-sync): tracker config and row guards`.

### Task 4: Planning Grant

**Files:** Create `src/tracker/grants.ts`, `grants.test.ts`

**Interfaces — consumes** `TrackerEvent`. **Produces:**

```ts
planGrants(input: {
  votes: { eventItemId: string; funder: string }[];      // qualifying rows only
  events: Map<string, TrackerEvent>;
  records: Map<string, string>;                          // event_grants
  untouchable: Set<string>;                              // events of rows whose verdict was unknown
  grantByFunder: Record<string, string>;
}): { writes: { eventItemId: string; grant: string | null }[]; // null clears
      remember: { eventItemId: string; grant: string }[];      // adopted: D1 only
      forget: string[];                                        // D1 only, no write
      conflicts: string[] }
```

After a write lands the sweep remembers it, or forgets it when `grant` is null.

- [ ] **Step 1: Failing tests** (`{ VTA: 'VTA', SMC: 'SMCTA' }`):
  - `SMC`, Grant blank → write `SMCTA`; `VTA`, Grant `SMCTA` with no record → write `VTA`.
  - `VTA`, Grant already `VTA`, no record → remember, no write; with the same record → nothing.
  - blank + `VTA` → `VTA`; `VTA` + `SMC` → conflict, no write; `VTA` + `Lyft` → conflict.
  - only `Lyft`, or only blanks: Grant equals its record → write null; no record → nothing; differs from its record → forget.
  - record with no votes left: Grant equals it → write null; event untouchable or missing from `events` → nothing.
- [ ] **Step 2:** `npm test -- src/tracker/grants.test.ts`. Expected: FAIL. **Step 3: Implement. Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(eventbrite-sync): plan the Grant copy from Funder`.

### Task 5: Planning totals

**Files:** Create `src/tracker/totals.ts`, `totals.test.ts`

**Interfaces — produces:**

```ts
computeTotals(attendance: string[]): Totals | null   // null when nobody is Attended
type Desired = { kind: 'totals'; eventItemId: string; totals: Totals } | { kind: 'none' }
             | { kind: 'hold'; eventItemId: string } | { kind: 'unknown' }
interface TrackerRecord { trackerItemId: string; eventItemId: string; totals: Totals }
type RowAction = { kind: 'nothing' } | { kind: 'write'; eventItemId: string; totals: Totals }
               | { kind: 'remember'; eventItemId: string; totals: Totals } | { kind: 'clear' }
planRow(cells: TrackerRow['cells'], record: TrackerRecord | null, desired: Desired, frozen: boolean): RowAction
```

- [ ] **Step 1: Failing tests.** `computeTotals(['Attended','Registered','Canceled','No Show',''])` → `{ registered: 5, checkedIn: 1, noShows: 3 }`; `['Registered','Canceled']` and `[]` → null. Then `planRow`:

| Cells | Record | Desired | Frozen | Action |
|---|---|---|---|---|
| blank | none | totals | no | write |
| equal the record | A 5/1/3 | A 5/2/2 | no | write |
| equal the record | A 5/1/3 | A 5/1/3 | no | nothing |
| equal the record | A 5/1/3 | B 5/1/3 | no | remember B |
| one cell blank, others equal | A | A same | no | write |
| one cell differs | A | A new | no | nothing |
| `0` in one cell, others blank | none | totals | no | nothing |
| typed | none | totals equal to them | no | nothing |
| equal the record | A | none | no | clear |
| one cell differs | A | none | no | nothing |
| all blank | A | none | no | clear |
| blank | none | none | no | nothing |
| equal the record | A | hold A | no | nothing |
| equal the record | A | hold B | no | clear |
| equal the record | A | unknown | no | nothing |
| equal the record | A | none | yes | nothing |
| blank | none | totals | yes | nothing |

- [ ] **Step 2:** `npm test -- src/tracker/totals.test.ts`. Expected: FAIL. **Step 3: Implement. Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(eventbrite-sync): plan tracker totals by who owns the row`.

### Task 6: Remembering and reading

**Files:** Create `migrations/0004_tracker.sql`, `src/db/tracker.ts` and test. Modify `src/monday/client.ts`; test `src/monday/client.test.ts`

**Interfaces — produces:**

```ts
interface TrackerStore {
  listCounts(): Promise<Map<string, TrackerRecord>>;      // by trackerItemId
  saveCounts(record: TrackerRecord, writtenAt: string): Promise<void>;
  deleteCounts(trackerItemId: string): Promise<void>;
  listGrants(): Promise<Map<string, string>>;
  saveGrant(eventItemId: string, grant: string, writtenAt: string): Promise<void>;
  deleteGrant(eventItemId: string): Promise<void>;
}
// HttpMondayClient, beside listBoardItems
listItemsLinkedTo(boardId: number, linkColumn: string, linkedItemId: string, columnIds: string[]): Promise<MondayItemColumns[]>
```

Tables: `tracker_counts(tracker_item_id TEXT PRIMARY KEY, event_item_id TEXT NOT NULL, registered, checked_in, no_shows INTEGER NOT NULL, written_at TEXT NOT NULL)` and `event_grants(event_item_id TEXT PRIMARY KEY, grant_label TEXT NOT NULL, written_at TEXT NOT NULL)`.

- [ ] **Step 1: Failing tests.** Store: save, overwrite, list and delete for each table. Client: `listBoardItems` returns a connect column's `linked_item_ids` comma-joined, as `getItems` does (it doesn't today); `listItemsLinkedTo` sends `query_params` with one `any_of` rule on the column, follows the cursor across two pages, and throws when Monday returns no board.
- [ ] **Step 2:** Run both test files. Expected: FAIL. **Step 3: Implement**, sharing the paging code. **Step 4:** PASS, with the send-link sweep's tests still green.
- [ ] **Step 5:** Commit `feat(eventbrite-sync): store tracker writes and read linked registrations`.

### Task 7: The hourly sweep

**Files:** Create `src/tracker/sweep.ts`, `sweep.test.ts`. Modify `src/index.ts`; test `src/index.test.ts`

**Interfaces — consumes** Tasks 3–6 and `AttendeeStore.listByEvent`. **Produces:**

```ts
interface TrackerSweepDeps {
  monday: Pick<HttpMondayClient, 'listBoardItems' | 'getItems' | 'listItemsLinkedTo' | 'changeColumnValues'>;
  store: TrackerStore;
  attendees: Pick<AttendeeStore, 'listByEvent'>;
  config: EventbriteSyncConfig;
  dryRun: boolean;
}
interface TrackerSweepResult { grants: number; rows: number; cleared: number; failed: string[]; warnings: string[]; dryRun: boolean }
sweepTracker(now: Date, deps: TrackerSweepDeps): Promise<TrackerSweepResult>
logTrackerSummary(result: TrackerSweepResult, logWarnings: boolean): void
```

Order: tracker rows; records; events (linked ones plus those in `event_grants`); registrations and ledger for rows that qualify, are not frozen, and whose event is `Completed`; then plan; then write Grants, then rows. No write happens before the last read. Writes are sequential, Monday then D1; three failures in a row stop the job. `hold` applies when any `listByEvent` row isn't `written`, or when the ledger has rows and Monday returned none. Desired is `none` for a `no` verdict, for an event not `Completed`, and when `computeTotals` is null. Number cells are parsed from text; blank is null. Clear a number with `''` and Grant with `null`; write Grant as `{ labels: ['VTA'] }`.

- [ ] **Step 1: Failing tests** with fake deps:
  - a Completed class with a blank row: writes the three cells in one call, then saves the record.
  - an Upcoming class: Grant written, no totals.
  - an `archived` event with a record: cleared.
  - a `queued` ledger row: nothing written, warning names the ids; a `failed` one: the same.
  - the tracker read returns `[]`: throws; nothing written or deleted.
  - `getItems` omits a linked event: that row and that event's Grant are left alone.
  - a registrations read throws: no write of any kind, earlier rows included.
  - a write refused on one row: the next is still written; after three in a row it stops; a refused write saves no record.
  - an empty Funder cell whose text reads `Other` (value null): Grant not written.
  - `dryRun`: counts only; no Monday or D1 write.
  - the summary line and warnings contain no item names; warnings are logged only with `logWarnings`.
- [ ] **Step 2: Failing wiring tests** in `index.test.ts`: `runScheduled` calls it hourly with `on`, passes `dryRun` under `off`, skips it under `hold` and `unknown`, skips it when `tracker` is null, and still runs the other jobs when it rejects.
- [ ] **Step 3:** Run both. Expected: FAIL. **Step 4: Implement** (`sweepTracker` is a defaulted last parameter of `runScheduled`, as `sendLinks` is). **Step 5:** `npm test`, `npm run typecheck`, `node ../scripts/check-log-safety.mjs`. Expected: PASS.
- [ ] **Step 6:** Add `Grant` to `Events` in `MARKED_COLUMNS` (`../scripts/mark-read-only-columns.mjs`) and its test. Write README "Class totals on the tracker", and update the UAT script and `docs/manual/workers/eventbrite-sync.md`. Commit `feat(eventbrite-sync): class totals and grant on the Education Tracker`.

### Task 8: Rehearse, then turn on (operator, with David)

- [ ] **Step 1: Sandbox.** Create a scratch tracker board with the same column types, set its ids in `config/sandbox.json`, apply `0004`, deploy, set the switch on and run the handler by hand. Walk: totals written; a typed number kept; clearing it hands back; unlink clears; relink replaces; Grant set, changed and cleared. Confirm `''` and `null` really clear a number and a dropdown.
- [ ] **Step 2:** With David's go-ahead, set and clear Registered on the Cancelled row 13177175043 with the integration's token, and read it back blank. Staff link the 12-03 and 12-08 rows.
- [ ] **Step 3:** Apply `0004` to production D1. Set `tracker` in `config/svbc.json` to the spec's ids, with `skipStatusLabels: ["Cancelled"]`, `grantByFunder: { "VTA": "VTA", "SMC": "SMCTA" }`, `grantStartDate: "2026-11-01"` and `startDate` the go-live day, plus `events.grantColumn`. Deploy; run the marker script.
- [ ] **Step 4:** Add the tracker's **Totals missing** view: Date before today, Registered empty, Status not Cancelled. Check it in the UI.
- [ ] **Step 5:** Parallel run over three classes, one with a cancellation. Explain every difference before staff stop typing. Update the root status table.

---

## Release 3: county

### Task 9: Home County

**Files:** Create `src/mapping/homeCounty.ts` and test, `scripts/build-zip-counties.mjs` and test. Modify `src/mapping/attendee.ts`, `src/types.ts`, `src/config.ts`, `testConfig.ts`, both configs, `split.test.ts`, `MARKED_COLUMNS`; test `attendee.test.ts`

**Interfaces — produces** `homeCounty(zip: string, config: EventbriteSyncConfig): string | null`; config `attendeeSync.zipCounty: { lists: Record<string, string[]>; overrides: Record<string, string> }` and `registrations.homeCountyColumn` (placeholder = off).

- [ ] **Step 1: Failing tests.** `94303` → `SMC or SCC` (override beats `pledge.zipCounty`); `94022` → `Santa Clara` (from `pledge.zipCounty`); `94601` → `Alameda` (from `lists`); `10001` → null; works with no `pledge`. In `mapAttendee`: zip and county written together; zip with no county writes county `''`; no zip writes neither; placeholder column writes no county. Config: a zip under two counties in `lists`, or not five digits, throws.
- [ ] **Step 2:** Run. Expected: FAIL. **Step 3: Implement. Step 4:** PASS.
- [ ] **Step 5:** `build-zip-counties.mjs --census <path>` reads the Census 2010 ZCTA-to-county relationship file (it has `POPPT`, people per part; the 2020 file doesn't), gives each zip to the county with most people, and prints lists for Alameda, San Francisco, Contra Costa, Marin, Napa, Solano, Sonoma, San Benito, Monterey and Santa Cruz, leaving out zips already in `pledge.zipCounty`. Test on a five-line fixture with one split zip. Ask David before downloading the file; paste the output into both configs, which must agree (assert it in `split.test.ts`).
- [ ] **Step 6:** Full checks as in Task 7. Commit `feat(eventbrite-sync): home county from zip`.

### Task 10: Turn county on (operator, with David)

- [ ] **Step 1:** Staff approve the lists and `94303`.
- [ ] **Step 2:** Create **Home County** (text) on Event Registrations, set its id, deploy, lock it, add it to the Grant report view and the dashboard.
- [ ] **Step 3:** Re-drive the November classes. Read ten rows in the UI. Update the docs and the root status table.
