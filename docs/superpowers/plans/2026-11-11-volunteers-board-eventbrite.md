# Volunteers board fed by Eventbrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Volunteers board the only record of volunteering: Eventbrite volunteer sign-ups become Volunteers items grouped by event, and everything that read volunteer registrations from Event Registrations reads the Volunteers board.

**Architecture:** `eventbrite-sync` gets a volunteer branch in `processAttendee` that upserts a Volunteers item (keyed by Eventbrite attendee id) instead of an Event Registrations row. Class-email roster loading and `donation-rollups` switch their volunteer source to the Volunteers board. A one-time, ledgered backfill script moves existing `Role = Volunteer` registrations and remaps the D1 ids that point at them.

**Tech Stack:** Cloudflare Workers (Hono, D1, Queues), TypeScript strip-only-compatible where noted, Vitest, Node `.mjs` operator scripts, Monday GraphQL via the Worker's own `src/monday/graphql.ts` copy.

**Spec:** `docs/superpowers/specs/2026-11-11-volunteers-board-eventbrite-design.md`

## Global Constraints

- Run Worker tests with the sandbox disabled (`cd eventbrite-sync && npm test -- <file>`); type-check with `npm run typecheck`, never bare `tsc`.
- Never edit `src/flags.ts` or `src/monday/graphql.ts` in any Worker (byte-identical copies, CI-checked). Scripts import `../src/monday/graphql.ts`, so no constructor parameter properties, enums or namespaces in it.
- No `console.*()` call may log an email address (`node scripts/check-log-safety.mjs` runs in the pre-commit hook).
- SVBC-specific ids live in `config/*.json`, validated at startup; no hardcoded board or column ids in source. Placeholder column id is `REPLACE_WITH_COLUMN_ID` (`PLACEHOLDER_COLUMN_ID`).
- Column titles are matched with `bareTitle` (`scripts/lib/column-titles.mjs`); new Worker-written columns go in `MARKED_COLUMNS` in `scripts/mark-read-only-columns.mjs` and the script is re-run.
- Sandbox first, production second. Production Volunteers board is `18437909797`; sandbox boards are `18431577321` (v3) and `18437342662` (v4): take the id the sandbox config already uses for its neighbours. Any production write or deploy needs the operator's go-ahead at that step.
- Write switch is per Worker: `hold` `eventbrite-sync` during cutover (`scripts/flags.mjs eventbrite-sync writes hold`), set `on` before deploying a build that must write.
- Status label mapping (exact spelling): Registered→`RSVP`, Attended→`Completed`, Canceled→`Canceled`, staff `No Show`↔`No-Show`. The Volunteers board has no `Registered`/`No Show` labels.
- Commits are conventional (`feat(eventbrite-sync): …`), ending with the `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` line.

## Review Focus

1. **Past emails resent after backfill** — class-email ledger rows (`class_email_recipients.registration_item_id`) and `attendees.monday_item_id` still name the old registration ids; unremapped, a past event's thank-you could be sent again. Owned by Task 6.
2. **Staff re-pointed `Event` overwritten** — a later check-in update must not reset `Event` to the listing. Task 3.
3. **Cancel with no item** — creates nothing (no stray `Canceled` row). Task 3.
4. **Downgrades** — `Registered` never overwrites staff `No-Show`/`Canceled`; a check-in always wins; a cancel never un-completes. Task 2.
5. **Volunteers board unconfigured** — a volunteer-event attendee must fail/retry, never silently fall back to writing an Event Registrations row. Task 3.
6. **No-email / placeholder-name attendees** — item still created, name falls back to `Eventbrite attendee <id>`, email column omitted, excluded from email recipients. Tasks 2 and 4.

---

### Task 1: Spike — can a view group by the Event relation?

**Files:**
- Create: `docs/superpowers/specs/2026-11-11-volunteers-board-eventbrite-design.md` addendum under "Resolved after the builder check" (edit)

**Interfaces:**
- Produces: a recorded yes/no, and for yes the exact API call shape used in Task 5.

- [ ] **Step 1:** On the sandbox Volunteers board (not production), add a throwaway board-relation column to Events and try to create/update a table view grouped by it, filtered to Date within the last 90 days, sorted by Date desc, via the `create_view_table`/`update_view_table` tools or the `views` GraphQL API (`get_column_type_info`/`get_graphql_schema` show the shape).
- [ ] **Step 2:** Record the result and working request body in the spec addendum. Delete the throwaway column. If grouping by a relation column is **not** possible, stop and report to the owner (spec: no mirror-column fallback without their say-so).
- [ ] **Step 3:** Commit `docs(volunteers): record view-grouping spike result`.

### Task 2: Volunteer status mapping and item mapper

**Files:**
- Create: `eventbrite-sync/src/mapping/volunteer.ts`
- Test: `eventbrite-sync/src/mapping/volunteer.test.ts`
- Modify: `eventbrite-sync/src/mapping/attendee.ts` (export `Incoming`, `mergeAttendance` are reused, not changed)

**Interfaces:**
- Consumes: `attendanceFromEventbrite`, `mergeAttendance`, `Incoming`, `EventFacts` from `mapping/attendee.ts`; `realName`, `realEmail` from `eventbrite/placeholder`.
- Produces:
  - `toVolunteerStatus(attendance: string): 'RSVP' | 'Completed' | 'Canceled' | 'No-Show'`
  - `toAttendance(status: string): string | null` (reverse; `Prospect`/`Confirmed`/unknown → `null`)
  - `mapVolunteer(a: EventbriteAttendee, facts: EventFacts, config: EventbriteSyncConfig, attendance: string): { itemName: string; columnValues: Record<string, unknown> }` writing, from `config.attendeeSync.volunteers`: attendee id, status (via `toVolunteerStatus`), job (listing name — `facts` gains `eventName: string`), date (`{ date: facts.classDate }` when non-null), `Historical` unchecked, attendee name/email when real. Item name is the attendee's real name, else `Eventbrite attendee ${a.id}`. It never sets `Event`, `Eventbrite Listing` or `Volunteer` (the consumer owns those).

- [ ] **Step 1: Write failing tests** in `volunteer.test.ts`: the four-way status mapping both directions (`toAttendance('No-Show') === 'No Show'`, `toAttendance('Prospect') === null`); `mergeAttendance(toAttendance('No-Show'), 'Registered')` stays `No Show` (Review Focus 4); `mapVolunteer` with a placeholder name/blank email omits the email key and names the item `Eventbrite attendee <id>` (Review Focus 6); `Date` omitted when `classDate` is null.
- [ ] **Step 2:** Run `npm test -- src/mapping/volunteer.test.ts`; expected FAIL (module missing).
- [ ] **Step 3:** Implement the module; add `eventName` to `EventFacts` and populate it where `mapEvent` builds facts (`src/mapping/event.ts`), updating its test.
- [ ] **Step 4:** Run the two test files; expected PASS. `npm run typecheck` clean.
- [ ] **Step 5:** Commit `feat(eventbrite-sync): map Eventbrite attendees to Volunteers items`.

### Task 3: Config and the volunteer branch of processAttendee

**Files:**
- Modify: `eventbrite-sync/src/types.ts` (add `monday.boards.volunteers: number | null` and `attendeeSync.volunteers`), `eventbrite-sync/src/config.ts` (require the new board key; validate columns), `eventbrite-sync/src/test/testConfig.ts`, `eventbrite-sync/config/svbc.json`, `eventbrite-sync/config/sandbox.json`
- Create: `eventbrite-sync/src/consumer/processVolunteer.ts`
- Modify: `eventbrite-sync/src/consumer/processAttendee.ts` (dispatch)
- Test: `eventbrite-sync/src/config.test.ts`, `eventbrite-sync/src/consumer/processVolunteer.test.ts`

**Interfaces:**
- Consumes: Task 2's `mapVolunteer`, `toAttendance`, `toVolunteerStatus`; `MondayClient`; `ProcessBatchDeps`; `matchPerson`; `linkedItemId`.
- Produces: `attendeeSync.volunteers: { attendeeIdColumn; attendeeNameColumn; attendeeEmailColumn; jobColumn; dateColumn; statusColumn; historicalColumn; volunteerLinkColumn; eventColumn; listingColumn }` (all column-id strings, placeholders allowed until Task 5 creates them); `processVolunteer(message: AttendeeQueueMessage, ctx: { row; attendee; event; eventRow }, deps: ProcessBatchDeps): Promise<void>`.
- In `processAttendee`, after the pledge check and after the Events-item wait and Eventbrite fetches, if `mapEvent(...).program` is in `volunteerPrograms`, delegate to `processVolunteer` and return — before any Event Registrations column is read.

- [ ] **Step 1: Write failing tests.** `config.test.ts`: missing `monday.boards.volunteers` key and a non-string `volunteers.statusColumn` throw naming the path. `processVolunteer.test.ts` (fake `MondayClient`, fake stores, as `processAttendee.test.ts` does): (a) first sign-up creates one item with `Event` and `Eventbrite Listing` both = the listing's Events item id, status `RSVP`, ledger `written` with that item id; (b) second delivery adopts by attendee id and updates, and when the item's `Event` already differs from the listing the update payload has no `Event` key (Review Focus 2); (c) checked-in → `Completed` and, with no `Volunteer` link, matches People and links; (d) item whose status is `No-Show` stays when incoming is Registered; (e) canceled attendee with no existing item creates nothing and marks the ledger `skipped`-style `written` without an item id — use the same status the orders path uses for "skipped" (`attendeeStore.updateStatus(id, 'skipped', …)`; add the status to `AttendeeStatus` if absent) (Review Focus 3); (f) `boards.volunteers === null` or a placeholder `attendeeIdColumn` throws before any write and does not call `createItem` on the registrations board (Review Focus 5); (g) archived/deleted item → ledger `failed`, nothing written (same rule as registrations).
- [ ] **Step 2:** Run both files; expected FAIL.
- [ ] **Step 3:** Implement config/types/validation; implement `processVolunteer` mirroring the adopt-before-create, `isActive`, `mergeAttendance` (via `toAttendance`/`toVolunteerStatus`), person-link-on-Attended and `isItemGone` handling already in `processAttendee`; no registrants-link write. Fill `config/sandbox.json` with the sandbox column ids once Task 5 has run, else `REPLACE_WITH_COLUMN_ID` and `volunteers: null` board in `svbc.json`.
- [ ] **Step 4:** Run `npm test` (whole Worker) and `npm run typecheck`; expected PASS.
- [ ] **Step 5:** Commit `feat(eventbrite-sync): write volunteer sign-ups to the Volunteers board`.

### Task 4: Class emails read the Volunteers board for volunteer events

**Files:**
- Modify: `eventbrite-sync/src/classEmails/roster.ts`, `eventbrite-sync/src/classEmails/routes.ts` (pass the event's audience to `loadRoster`)
- Test: `eventbrite-sync/src/classEmails/roster.test.ts`, `eventbrite-sync/src/classEmails/routes.test.ts`

**Interfaces:**
- Consumes: `config.attendeeSync.volunteers`, `config.monday.boards.volunteers`.
- Produces: `loadRoster(eventId: string, deps: RosterDeps, audience: AudienceRole = 'Participant'): Promise<RosterEntry[]>`. For `'Volunteer'` it reads the Volunteers board and returns entries with `role: 'Volunteer'`, `attendance` from `toAttendance(status)` (so `plan.ts` is unchanged), `email`/`name` from the attendee columns, `firstName` the first word of the name, `registrationId` the Volunteers item id. For `'Participant'` behavior is unchanged.

- [ ] **Step 1: Write failing tests:** roster for a volunteer event returns Volunteers-board items with `role 'Volunteer'` and mapped attendance; a `Canceled`/`RSVP` mix feeds `planKind` the same recipients as the equivalent registration roster would; unconfigured volunteers board throws a clear error; `routes.test.ts`: `GET /class-emails/:id` on a `Volunteering` event loads the roster with audience `'Volunteer'`.
- [ ] **Step 2:** Run those files; expected FAIL.
- [ ] **Step 3:** Implement. `routes.ts` already computes `audienceOf(item)`; thread it into every `loadRoster` call (GET, claim, result, release).
- [ ] **Step 4:** `npm test` and `npm run typecheck` pass.
- [ ] **Step 5:** Commit `feat(eventbrite-sync): volunteer-event emails read the Volunteers board`.

### Task 5: Volunteers board setup script, read-only markers, and the Recent events view

**Files:**
- Create: `eventbrite-sync/scripts/setup-volunteers-board.mjs`, `eventbrite-sync/scripts/setup-volunteers-board-lib.mjs`
- Test: `eventbrite-sync/scripts/setup-volunteers-board-lib.test.mjs`
- Modify: `scripts/mark-read-only-columns.mjs` (`MARKED_COLUMNS['Volunteers']`: locked `Eventbrite Listing`, `Eventbrite Attendee ID`, `Attendee Name`, `Attendee Email`; history = the existing 📜 columns already marked), re-run it

**Interfaces:**
- Produces (lib): `planVolunteersBoard(existingColumns: {id,title,type}[]): { toCreate: ColumnSpec[] }` — idempotent, matching with `bareTitle`; creates `Event` (board_relation → Events board, editable), `Eventbrite Listing` (board_relation → Events), `Eventbrite Attendee ID` (text), `Attendee Name` (text), `Attendee Email` (email). Script flags: `--board <id>`, `--events-board <id>`, `--apply` (default dry run), prints the created column ids to paste into config. Also creates the view per Task 1's recorded call shape: name `Recent events`, grouped by `Event`, Date within last 90 days, Date desc; skip if a view of that name exists.

- [ ] **Step 1: Write failing lib tests:** empty board → five columns planned; board that already has `🔒 Eventbrite Attendee ID` → not planned again (bareTitle); dry run issues no writes.
- [ ] **Step 2:** Run `node --test scripts/setup-volunteers-board-lib.test.mjs`; expected FAIL.
- [ ] **Step 3:** Implement lib and script (model on `setup-pledge-board.mjs` for argument handling and transport use).
- [ ] **Step 4:** Tests pass. Run against the **sandbox** board with `--apply`; verify with `get_board_info` that columns and view exist; paste ids into `config/sandbox.json`.
- [ ] **Step 5:** Re-run `node scripts/mark-read-only-columns.mjs` on the sandbox, then commit `feat(eventbrite-sync): set up the Volunteers board columns and Recent events view`.

### Task 6: Backfill existing volunteer registrations

**Files:**
- Create: `eventbrite-sync/scripts/backfill-volunteers.mjs`, `eventbrite-sync/scripts/backfill-volunteers-lib.mjs`
- Test: `eventbrite-sync/scripts/backfill-volunteers-lib.test.mjs`

**Interfaces:**
- Consumes: sandbox/production config JSON, `MondayGraphQL` from `../src/monday/graphql.ts`.
- Produces (lib):
  - `planBackfill(registrations: Reg[], listings: Map<string, ListingFacts>, existingVolunteerAttendeeIds: Set<string>): { create: VolunteerItemPlan[]; skipped: { itemId: string; reason: 'no-attendee-id' | 'not-a-volunteering-event' | 'already-moved' }[] }` — pure.
  - `remapSql(moves: { attendeeId: string; oldItemId: string; newItemId: string }[]): string` — emits `UPDATE attendees SET monday_item_id = … WHERE attendee_id = …;` and `UPDATE class_email_recipients SET registration_item_id = … WHERE registration_item_id = …;` per move, SQL-escaped.
- CLI: dry-run by default; `--apply` creates items, resumable through a gitignored ledger under `eventbrite-sync/data/` (never commit); `--archive` archives the originals only after a count check passes (volunteers created == eligible registrations); `--remap-out <file>` writes the SQL for `wrangler d1 execute <db> --remote --file`. Prints a report: created, skipped by reason, volunteers with no People link.

- [ ] **Step 1: Write failing lib tests:** registration without attendee id → skipped `no-attendee-id`; registration whose event isn't `Volunteering` → skipped; already-moved attendee id → skipped `already-moved` (idempotent re-run); Attendance maps through `toVolunteerStatus` with `No Show`→`No-Show`; each plan has `Event` = `Eventbrite Listing` = the registration's Events item; `remapSql` for one move contains both UPDATEs with the exact old/new ids and escapes a quote; **after remap, `planKind('thank-you', …)` for a roster rebuilt from the new ids and a ledger row for the old id as remapped does not re-offer an already-sent address** (Review Focus 1 — put this in `roster.test.ts` of Task 4's files if it needs the TS planner, importing both).
- [ ] **Step 2:** Run; expected FAIL.
- [ ] **Step 3:** Implement lib and CLI.
- [ ] **Step 4:** Tests pass. Dry-run then `--apply` on the sandbox; check Volunteers item count per event against the registrations count for the same events; run the remap SQL against the sandbox D1; confirm a sandbox volunteer event's `GET /class-emails/:id` roster and sent-counts are unchanged.
- [ ] **Step 5:** Commit `feat(eventbrite-sync): backfill volunteer registrations onto the Volunteers board`.

### Task 7: donation-rollups reads volunteers only from the Volunteers board

**Files:**
- Modify: `donation-rollups/config/svbc.json`, `donation-rollups/config/sandbox.json` (`volunteerBoards: []`; `historicalVolunteerBoards` already names the Volunteers board, check sandbox ids), `donation-rollups/README.md`
- Test: `donation-rollups/src/custodian/membership.test.ts` (or the file that covers `pageHistoricalShifts` use)

**Interfaces:**
- Consumes: existing `HistoricalVolunteerBoardConfig` (volunteer link, date, hours, status; counted label `Completed`).

- [ ] **Step 1: Write failing test:** with `volunteerBoards: []` and two non-Historical Volunteers items (`Completed`, dates 2026-09-01 and 2026-09-01) for one person, membership activity credits that person once for that date (read `custodian/membership.ts` to confirm the per-day rule; if several same-day shifts instead count more than once, stop and raise it with the owner — spec risk), and a `Canceled` item adds nothing.
- [ ] **Step 2:** Run `cd donation-rollups && npm test -- src/custodian`; expected FAIL or PASS-by-config; if it already passes, keep it as a regression test.
- [ ] **Step 3:** Change the two config files; `config.test.ts` still validates (`volunteerBoards` may be `[]`).
- [ ] **Step 4:** `npm test` and `npm run typecheck` pass. Note in the README that new volunteering counts through the Volunteers board's `Completed` rows at the next custodian sweep.
- [ ] **Step 5:** Commit `feat(donation-rollups): count volunteer activity from the Volunteers board`.

### Task 8: Docs and runbook

**Files:**
- Modify: `eventbrite-sync/README.md` (volunteer path replaces "Role = Volunteer on Event Registrations"), root `README.md` status line if it mentions it, `docs/uat/eventbrite-sync.md`
- Create: `docs/runbooks/volunteers-board-cutover.md` (the exact production order below, with commands and rollback)

- [ ] **Step 1:** Write the runbook with these steps verbatim: (1) production Volunteers columns + view via `setup-volunteers-board.mjs --apply`, then `mark-read-only-columns.mjs`; (2) put production ids in `config/svbc.json`; (3) `flags.mjs eventbrite-sync writes hold`; (4) deploy `eventbrite-sync` and `donation-rollups`; (5) `backfill-volunteers.mjs --apply --remap-out …`, run the remap on production D1; (6) spot-check three events (counts, class-email roster, sent counts); (7) `flags.mjs eventbrite-sync writes on`; (8) `backfill-volunteers.mjs --archive` after the count check; (9) next custodian sweep: spot-check a volunteer's membership activity. Rollback: leave the switch on `hold`, redeploy the previous build; archived registrations can be unarchived.
- [ ] **Step 2:** Update READMEs and UAT checklist (staff view: Recent events grouped; how to re-point `Event`).
- [ ] **Step 3:** Commit `docs(volunteers): document the Volunteers board feed and cutover`.

### Task 9: Production cutover (operator-gated)

**Files:** none (runs the runbook).

- [ ] **Step 1:** Show the operator the dry-run report from the production backfill and get an explicit go-ahead before step 3 of the runbook.
- [ ] **Step 2:** Execute the runbook; paste each verification result into the session.
- [ ] **Step 3:** Open the MR (bind it with the ccd_pr tools) with the spec, plan, and cutover results.

## Self-Review

- **Spec coverage:** columns/view (T1, T5), status mapping and no-downgrade (T2), sync write path, Event default and never-overwritten, cancel rule (T3), class emails (T4), rollups (T7), backfill with remap and archive (T6), cutover order and hold (T8–T9), docs (T8). Non-goals (hours, Salesforce rows, auto-pairing) have no task, by design.
- **Type consistency:** `toVolunteerStatus`/`toAttendance`/`mapVolunteer` (T2) are the names T3, T4 and T6 use; `attendeeSync.volunteers` keys (T3) are the ones T4 and T5 read and write; `loadRoster`'s third parameter (T4) is what `routes.ts` passes.
- **Proportion:** tasks give signatures and test assertions; bodies are left to the implementer.
