# Event counts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `eventbrite-sync` keeps Registered, Checked in and No-shows on each CRM Events item, and fills the Lifecycle Tracker's three count cells without overwriting a person's correction.

**Architecture:** The existing hourly cron queues one `counts` message per event in a window. A new consumer recounts from Event Registrations on Monday, writes the Events item, then (after the event ends, and only when configured) the linked tracker rows. D1 remembers what was last written to each tracker row, which is how a correction is told apart from the Worker's own number.

**Tech Stack:** Cloudflare Workers, Hono, D1, Queues, TypeScript, vitest; `src/monday/graphql.ts` transport (don't edit; canonical copy lives in `monday-backup`).

**Spec:** `docs/superpowers/specs/2026-11-04-event-counts-design.md`

**Gate:** Staff approval first. Tasks 1–4 can start once Cherie approves. Task 5's tracker switch-on waits for her answers to spec questions 2, 3 and 4. Production counts wait for a real check-in (2026-11-08/09 at the earliest). Tasks 7–9 (custom-question answers) are independent of Tasks 1–6 and don't wait for a check-in; Task 8's board waits for spec questions 6 and 8, and Task 9's county table for question 7.

## Global Constraints

- Type-check with `npm run typecheck`, never bare `tsc`. Run from `eventbrite-sync/`.
- Logs carry ids and error classes only, never names or addresses; `node ../scripts/check-log-safety.mjs eventbrite-sync/src` stays clean.
- D1 stores ids and numbers only.
- SVBC-specific ids live in `config/*.json`, not source.
- Compare column titles through `bareTitle` if any script looks a column up by title.
- All Monday writes and `tracker_counts` writes go through the write switch.
- Read status cells with `statusText`, never `text` (an empty status shows label 5's text).
- Numbers: Registered = all active registrations; Checked in = Attended; No-shows = Registered, No Show or blank Attendance.
- Answers: only questions named in config are read. Answer text and question wording never reach D1 or a log. A row on the restricted board never carries a name, email, phone, zip or attendee id; its item name is `Response`.

## Review Focus

1. A class nobody checked in to, one hour after it ends: Checked in and No-shows stay blank on Events and tracker; Registered is still written (Task 1, Task 4).
2. Someone types over a Worker number on the tracker, and the next hourly run happens: the typed number stays, and clearing the cell hands it back (Task 4).
3. A tracker row whose CRM Event points at a class on another date: nothing written, one warning (Task 4).
4. Staff rename or delete a tracker column: a logged failure, with the Events counts already written (Task 3, Task 4).
5. A switch flipped to `off` with counts messages on the queue: no write and no `tracker_counts` change (Task 5).
6. An attendee who answered the health question, and an event whose question is reworded to contain an allowed phrase: neither answer reaches any Monday payload or log (Task 7).

---

### Task 1: The count rule

**Files:**
- Create: `eventbrite-sync/src/eventCounts/count.ts`, `count.test.ts`

**Interfaces:**
- Produces: `computeCounts(attendance: string[], ended: boolean): EventCounts`, where `EventCounts = { registered: number; checkedIn: number | null; noShows: number | null }`; `eventHasEnded(row: EventRow, now: Date): boolean` (end, else start, is past).

- [ ] **Step 1: Write failing tests** named `counts every registration, canceled included` (`['Attended','Registered','Canceled','No Show','']`, ended → `{registered:5, checkedIn:1, noShows:3}`); `leaves check-in and no-shows blank before the end` (→ `{registered:5, checkedIn:null, noShows:null}`); `leaves them blank when nobody attended` (`['Registered','Canceled']`, ended → `{registered:2, checkedIn:null, noShows:null}`); `zero registrations` (`[]`, ended → `{registered:0, checkedIn:null, noShows:null}`).
- [ ] **Step 2: Run** `npm test -- src/eventCounts/count.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement both functions.**
- [ ] **Step 4: Run again.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(eventbrite-sync): the rule for event counts`.

### Task 2: Reading registrations, config and the window

**Files:**
- Modify: `src/monday/client.ts`, `src/config.ts`, `src/types.ts`, `src/db/events.ts`, `src/test/testConfig.ts`, `config/svbc.json`, `config/sandbox.json`, `config/split.test.ts`, `../scripts/mark-read-only-columns.mjs`
- Test: `src/config.test.ts`, `src/db/events.test.ts`, the client's existing test file

**Interfaces:**
- Produces: `MondayClient.listItemsByLink(boardId: number, linkColumn: string, linkedItemId: string, columnIds: string[]): Promise<MondayItemColumns[]>` (`items_page` with an `any_of` rule, following the cursor, 500 a page, active items only); `EventStore.listForCounts(fromIso: string, toIso: string): Promise<EventRow[]>`.
- Config: `attendeeSync.events.registeredCountColumn`, `checkedInCountColumn`, `noShowCountColumn`; `attendeeSync.eventCounts: { startDate: string | null; windowDays: 30 }` (`null` = feature off); `attendeeSync.tracker: null | { boardId, crmEventColumn, registeredColumn, checkedInColumn, noShowColumn, dateColumn, statusColumn, skipStatusLabels }`. Production tracker ids are in the spec. It ships `null` in both configs.

- [ ] **Step 1: Write failing tests:** `listItemsByLink follows the cursor across pages` and `sends the link rule`; `validates tracker config only when not null`; `rejects a malformed eventCounts.startDate`; `listForCounts returns written events ending in the range, and undated ones by start` and `excludes canceled, unwritten, and no Monday item`.
- [ ] **Step 2: Run** the three test files. Expected: FAIL.
- [ ] **Step 3: Implement.** In `listForCounts` use `COALESCE(ends_at, starts_at)`, `status = 'written'`, `monday_item_id IS NOT NULL`, and `eventbrite_status` not `canceled`. No upper bound beyond `toIso`, which the sweep passes as far future.
- [ ] **Step 4: Create the three `🔒` number columns** on sandbox Events, put the ids in `config/sandbox.json`, and add them to `MARKED_COLUMNS.Events` as `Registered`, `Checked In`, `No-shows`. Production ids stay `REPLACE_WITH_COLUMN_ID` until Task 6, so add the keys to `split.test.ts` `COLUMN_KEYS` then.
- [ ] **Step 5: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(eventbrite-sync): config and reads for event counts`.

### Task 3: Sweep and the Events write

**Files:**
- Create: `src/eventCounts/sweep.ts`, `sweep.test.ts`, `src/consumer/processCounts.ts`, `processCounts.test.ts`
- Modify: `src/consumer/processBatch.ts`, `src/consumer/messages.ts`, `src/consumer/processDeadLetters.ts`, `src/writeSwitch.ts`, `src/index.ts`

**Interfaces:**
- Consumes: Task 1, Task 2.
- Produces: `CountsQueueMessage = { kind: 'counts'; eventId: string } & WriteStamp`, a member of `WriteQueueMessage`; `sweepEventCounts(now: Date, deps): Promise<{ queued: number }>`; `processCounts(message, deps): Promise<void>`.

- [ ] **Step 1: Write failing tests:**
  `sweep queues upcoming and recently ended events only`;
  `sweep does nothing when startDate is null`;
  `sweep ignores events before startDate`;
  `processCounts writes the three columns`;
  `processCounts skips the write when nothing changed`;
  `processCounts sends blank for a null count on the Events item` (a count that was set then goes null, such as a check-in undone by hand, must not stay stale there);
  `a failed counts message is logged and acked, and no events row changes`;
  `a dead-lettered counts message touches no row`;
  `off dry-runs: no Monday write`;
  `hold retries`.
- [ ] **Step 2: Run** the new files. Expected: FAIL.
- [ ] **Step 3: Implement the sweep**, sending with `sendInBatches`, wired into `src/index.ts`'s scheduled run beside `sweepEndedEvents` under the same disposition, with its own `.catch` so one sweep failing can't stop the other. Add a dry-run deps helper like `dryRunEndedEventDeps`.
- [ ] **Step 4: Implement `processCounts`** up to the Events write: read the row, `listItemsByLink` on `registrations.eventLinkColumn`, `computeCounts`, read the current cells with `getItems`, write if different. Use `numbers` values as strings, and `""` to clear.
- [ ] **Step 5: Add the `counts` branch** to `processOrderQueueBatch`: on error, `console.error` with the event id and ack, without calling any store's `updateStatus`. Extend `describeMessage`, `messageDeliveryId`, and the dead-letter consumer.
- [ ] **Step 6: Run** `npm test && npm run typecheck && node ../scripts/check-log-safety.mjs eventbrite-sync/src`. Expected: PASS and clean.
- [ ] **Step 7: Commit** `feat(eventbrite-sync): keep event counts on the Events board`.

### Task 4: The tracker step

**Files:**
- Create: `migrations/0004_tracker_counts.sql`, `src/db/trackerCounts.ts`, `trackerCounts.test.ts`, `src/eventCounts/tracker.ts`, `tracker.test.ts`, a sandbox scratch tracker board
- Modify: `src/consumer/processCounts.ts`, `src/consumer/processBatch.ts` (deps), `src/writeSwitch.ts`, `src/test/fakeStores.ts`, `config/sandbox.json`

**Interfaces:**
- Consumes: Task 1, Task 3.
- Produces: table `tracker_counts(tracker_item_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, last_registered INTEGER, last_checked_in INTEGER, last_no_shows INTEGER, written_at TEXT NOT NULL)`; `TrackerCountsStore { get(itemId): Promise<TrackerCountsRow | null>; record(row): Promise<void> }`; `planTrackerCells(counts: EventCounts, cells: { registered: string; checkedIn: string; noShows: string }, last: TrackerCountsRow | null): Partial<Record<'registered'|'checkedIn'|'noShows', number>>`; `trackerDateMatches(trackerDate: string, row: EventRow): boolean`.

- [ ] **Step 1: Write failing tests for `planTrackerCells`:** `fills a blank cell`; `updates a cell still holding what the Worker last wrote`; `leaves a typed-over cell alone`; `treats a number on a never-written row as a person's`; `refills a cell someone cleared`; `never writes a null count, so it can't clear a cell`; `compares numerically, so "7" and "7.0" are the same`.
- [ ] **Step 2: Write failing tests for `trackerDateMatches`:** same Pacific day passes; an evening class whose UTC date is the next day passes; another date fails; a day inside a multi-day event passes.
- [ ] **Step 3: Write failing tests for `processCounts`:** `doesn't touch the tracker when config is null`; `doesn't write a row before the event ends`; `writes a linked row after the end and records it`; `skips a Cancelled row`; `skips a row on the wrong date with one warning`; `skips a row linked to two events with one warning`; `a relinked row's old Worker value is replaced`; `a Monday rejection on the tracker is logged and the Events write stands`; `records only cells it wrote, keeping the last value of a corrected cell`; `off changes neither the board nor tracker_counts`.
- [ ] **Step 4: Run.** Expected: FAIL.
- [ ] **Step 5: Implement** the migration, store, dry-run store, and the step in `processCounts`, after the Events write. Find rows with `listItemsByLink` on `tracker.crmEventColumn`. On a corrected cell keep its stored last value unchanged. Add the tracker board to `MondayBoards`/`SINK_NAMES` so skip lines name it.
- [ ] **Step 6: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 7: Commit** `feat(eventbrite-sync): fill the Lifecycle Tracker's counts`.

### Task 5: Sandbox rehearsal and docs

**Files:**
- Modify: `eventbrite-sync/README.md`, `docs/uat/eventbrite-sync.md`, root `README.md` status row; in `monday-migration`, `docs/06-staff-process-guide.md` §4

- [ ] **Step 1: Apply and deploy to sandbox:** `npx wrangler d1 migrations apply svbc-eventbrite-sync-sandbox --remote --env sandbox`, then `npm run deploy:sandbox`, with `eventCounts.startDate` set and the scratch tracker configured.
- [ ] **Step 2: Rehearse and record:** a sign-up raises Registered on Events within the hour; a check-in fills Checked in and No-shows after the end; a zero check-in class stays blank; a typed-over tracker cell survives the next run; a cleared one refills; `writes off` changes nothing.
- [ ] **Step 3: Write the docs:** README section on counts and corrections, UAT steps, one-off board how-to (connect column plus mirror) in the staff guide, and how to fix a number.
- [ ] **Step 4: Commit** `docs(eventbrite-sync): event counts`.

### Task 6: Production, after the gates

No code. Each step needs David's go-ahead at the time.

- [ ] **Step 1: Confirm a real check-in reached Attendance** on Event Registrations; record which action name arrived.
- [ ] **Step 2: Create the production columns,** fill their ids, tighten `split.test.ts`, run `node scripts/mark-read-only-columns.mjs`, update the `Tickets Sold` column description.
- [ ] **Step 3: Apply the migration, deploy, set `startDate`** to the first class with a proven check-in. The tracker stays `null`. Check the numbers on Events after a class.
- [ ] **Step 4: After staff answer questions 2, 3 and 4:** run `node scripts/check-monday-token-scope.mjs --workspace 12570563`, then set `attendeeSync.tracker` and deploy. If reports turn out to come from the Google Sheet, stop here and revisit.
- [ ] **Step 5: Parallel run** for three classes or a month, whichever is longer: staff still pull the Eventbrite numbers and compare. Explain any difference.
- [ ] **Step 6: Staff stop the manual step;** update the guide to say so.

### Task 7: Allowlisted answers, zip and county

**Files:**
- Create: `eventbrite-sync/src/answers/allowlist.ts`, `allowlist.test.ts`, `eventbrite-sync/scripts/list-event-questions.mjs`
- Modify: `src/eventbrite/client.ts`, `src/config.ts`, `src/mapping/attendee.ts`, its test, `src/consumer/processAttendee.ts`, its test, `src/test/testConfig.ts`, `config/svbc.json`, `config/sandbox.json`, `config/split.test.ts`, `../scripts/mark-read-only-columns.mjs`

**Interfaces:**
- Produces: `EventbriteAttendee.answers?: EventbriteAnswer[] | null`, with `EventbriteAnswer = { question_id?: string | null; question?: string | null; type?: string | null; answer?: string | null }`; `type AnswerKey = 'homeZip' | 'howHeard' | 'whySignedUp' | 'rideFrequency' | 'comfortStreet' | 'comfortEveryday' | 'liveWorkSanMateo' | 'city' | 'gender' | 'age' | 'ethnicity'`; `pickAnswers(answers: EventbriteAnswer[] | null | undefined, questions: Record<AnswerKey, string[]>): Partial<Record<AnswerKey, string>>`; `normalizeZip(raw: string): string | null`; `countyForZip(zip: string, table: Record<string, string>): string | null`.
- Config: `attendeeSync.answers: { startDate: string | null; questions: Record<AnswerKey, string[]>; zipCounties: Record<string, string>; homeZipColumn: string; homeCountyColumn: string; surveyBoard: null | SurveyBoardConfig }`. `startDate: null` = feature off. Task 8 defines `SurveyBoardConfig`.

- [ ] **Step 1: Do the one real read.** Write `list-event-questions.mjs`: for an event id, print each distinct `question_id` and `question` from its attendees, never `answer` or `profile`. Run it against two production events. Record in the spec whether `answers` needs an `expand` and whether question ids differ by event. If either memory is wrong, correct the spec before Step 2. Fill `questions` from this output and the wordings in the spec. It's read-only, but ask David first since it uses the production token.
- [ ] **Step 2: Write failing tests:** `picks an allowed question`; `matches after trimming and lowercasing`; `matches all three zip wordings`; `ignores a question not on the list`; `ignores a question that only contains an allowed phrase`; `returns nothing for null answers`; `drops a blank answer`. `normalizeZip`: `95014` → `95014`; `95014-1234` → `95014`; ` 95014 ` → `95014`; `9501` → null; `I live in San Jose` → null. `countyForZip`: listed → county; unlisted → null.
- [ ] **Step 3: Run** `npm test -- src/answers/allowlist.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** the module and the `EventbriteAttendee` field.
- [ ] **Step 5: Write failing tests for `mapAttendee` and `processAttendee`:** `writes zip and county`; `writes zip with blank county for an unlisted zip`; `omits both for an invalid zip, leaving the cell alone`; `omits both before answers.startDate`; `an attendee's health answer appears in no column value and no log` (spy `console.*`, assert the fixture's sentinel strings are absent); `logs ids only when answers exist but no zip matched`; `off writes nothing`.
- [ ] **Step 6: Implement.** Take `startDate` against the event's start, not the registration date. Create the `🔒 Home Zip` and `🔒 Home County` text columns on sandbox Event Registrations and add them to `MARKED_COLUMNS`. Add the keys to `split.test.ts`. `zipCounties` stays `{}` in `svbc.json` until Task 9.
- [ ] **Step 7: Run** `npm test && npm run typecheck && node ../scripts/check-log-safety.mjs eventbrite-sync/src`. Expected: PASS and clean.
- [ ] **Step 8: Commit** `feat(eventbrite-sync): home zip and county on registrations`.

### Task 8: The restricted survey board

**Files:**
- Create: `migrations/0005_answer_rows.sql` (the next free number if Task 4 hasn't landed), `src/db/answerRows.ts`, `answerRows.test.ts`, `src/answers/surveyRow.ts`, `surveyRow.test.ts`, `eventbrite-sync/scripts/backfill-survey-answers.mjs`
- Modify: `src/consumer/processAttendee.ts`, its test, `src/consumer/processBatch.ts` (deps), `src/writeSwitch.ts`, `src/test/fakeStores.ts`, `src/config.ts`, `config/svbc.json`, `config/sandbox.json`, `config/split.test.ts`, `../monday-backup/config/*.json` (exclude the board)

**Interfaces:**
- Consumes: Task 7's `pickAnswers` and `AnswerKey`.
- Produces: table `answer_rows(attendee_id TEXT PRIMARY KEY, monday_item_id TEXT NOT NULL, written_at TEXT NOT NULL)`; `AnswerRowStore { get(attendeeId): Promise<string | null>; record(attendeeId, itemId): Promise<void> }`; `SurveyBoardConfig = { boardId: number; eventNameColumn: string; classDateColumn: string; canceledColumn: string; columns: Partial<Record<Exclude<AnswerKey, 'homeZip'>, string>> }`; `surveyRowValues(answers, eventFacts, canceled: boolean, board: SurveyBoardConfig): Record<string, unknown> | null` (null when no survey answer is present).

- [ ] **Step 1: Write failing tests for `surveyRowValues`:** `maps each answer to its column`; `returns null with only a zip`; `never includes zip`; `sets Canceled when cancelled or refunded`; and `the payload holds none of the fixture's name, email or attendee id`, serializing the whole result.
- [ ] **Step 2: Write failing tests for `processAttendee`:** `creates a Response row and records it`; `updates the same row on a later change`; `does nothing when surveyBoard is null`; `a Monday failure logs and leaves the registration written`; `off changes neither the board nor answer_rows`; `a dropped-stamped message stays a dry run`.
- [ ] **Step 3: Run** both files. Expected: FAIL.
- [ ] **Step 4: Implement** the migration, store, dry-run store and the step, after the registration write and registrants link, wrapped like `linkRegistrant`. The item name is always `Response`. Add the board to `MondayBoards`/`SINK_NAMES`.
- [ ] **Step 5: Implement the backfill script:** for an event id, re-queue that event's attendees through the normal consumer, with `--dry-run`. It prints counts only.
- [ ] **Step 6: Create a private scratch board in the sandbox workspace,** with the integration user subscribed, and put its ids in `config/sandbox.json`. `surveyBoard` stays `null` in `svbc.json`.
- [ ] **Step 7: Run** `npm test && npm run typecheck && node ../scripts/check-log-safety.mjs eventbrite-sync/src`, and the same two test commands in `monday-backup`. Expected: PASS and clean.
- [ ] **Step 8: Commit** `feat(eventbrite-sync): restricted board for SMCTA answers`.

### Task 9: Answers rehearsal, docs and production

Docs go in the same files as Task 5. Each production step needs David's go-ahead at the time.

- [ ] **Step 1: Rehearse in sandbox and record:** an answered registration writes zip and county; a survey row has no identifying column; an updated answer changes the same row; a health answer appears nowhere; `writes off` changes nothing.
- [ ] **Step 2: Write the docs:** README section on the allowlist and how to add a wording; staff guide note on what each destination holds and what the board's privacy does and doesn't cover.
- [ ] **Step 3: Commit** `docs(eventbrite-sync): custom-question answers`.
- [ ] **Step 4: Fill `zipCounties`** from the table staff reviewed (spec question 7), and add a test that `svbc.json`'s keys are all five digits. Commit.
- [ ] **Step 5: Create the production zip and county columns,** run `node scripts/mark-read-only-columns.mjs`, apply nothing new yet, deploy, and set `answers.startDate`.
- [ ] **Step 6: If staff confirm SMCTA still needs them,** create the private board with the subscribers staff named, exclude it from `monday-backup` and deploy that first, then apply the migration, set `surveyBoard` and deploy. Check who the board's subscribers are after creation.
- [ ] **Step 7: Compare one quarter** of Monday numbers with the Eventbrite export before staff retire the export. Explain any difference.
