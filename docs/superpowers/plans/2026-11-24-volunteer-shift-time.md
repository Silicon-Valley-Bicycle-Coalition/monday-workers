# Volunteer Shift Time Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Eventbrite sign-up on the Volunteers board shows its listing's start and end time.

**Architecture:** A pure formatter turns the listing's start and end into text; `mapVolunteer` writes it to an optional text column. The placeholder writes nothing, so the code ships before the column exists.

**Tech Stack:** TypeScript on Workers, vitest, the existing Volunteers setup script.

**Spec:** `docs/superpowers/specs/2026-11-24-volunteer-shift-time-design.md`

## Global Constraints

- Column title `Shift Time` (🔒 added by `mark-read-only-columns.mjs`), type text; config key `attendeeSync.volunteers.shiftTimeColumn`.
- Pacific time (`America/Los_Angeles`). Values: `8:00 AM–12:00 PM` (en dash, no spaces); longer than 24 hours `Oct 3, 8:00 AM–Oct 4, 12:00 PM`; no end, or an end at or before the start, `8:00 AM`; no start, not written.
- Always the row's own listing. Never writes Event, Shift Lead or a status it didn't write before.
- `REPLACE_WITH_COLUMN_ID` writes nothing and does not change `volunteerBoardMode`.
- Both configs ship the placeholder until Task 3's rollout. No Monday change, deploy or replay without the operator's go-ahead.

## Review Focus

1. `Intl` puts a narrow no-break space (U+202F) before AM/PM: the stored text has an ordinary space, so staff can search and filter it (Task 1).
2. A shift across the daylight-saving change shows local clock times (Task 1).
3. A shift ending exactly at midnight, or 24 hours long, shows times only (Task 1).
4. An unparseable or missing Eventbrite time leaves the column out rather than writing `Invalid Date` (Task 1).
5. An existing row whose listing loses its start keeps its earlier value (Task 2).

---

### Task 1: The formatter

**Files:** Create `eventbrite-sync/src/mapping/shiftTime.ts`, `shiftTime.test.ts`

**Interfaces — Produces:** `export function shiftTime(startsAt: string | null, endsAt: string | null): string | null` (ISO instants in, as `mapEvent` returns them)

- [ ] **Step 1: Write the failing tests**

```ts
it.each([
  ['2026-06-13T15:00:00Z', '2026-06-13T19:00:00Z', '8:00 AM–12:00 PM'],
  ['2026-10-11T03:30:00Z', '2026-10-11T07:30:00Z', '8:30 PM–12:30 AM'],           // past midnight
  ['2026-10-11T03:00:00Z', '2026-10-11T07:00:00Z', '8:00 PM–12:00 AM'],           // ends at midnight
  ['2026-06-13T15:00:00Z', '2026-06-14T15:00:00Z', '8:00 AM–8:00 AM'],            // exactly 24 hours
  ['2026-10-03T15:00:00Z', '2026-10-04T19:00:00Z', 'Oct 3, 8:00 AM–Oct 4, 12:00 PM'],
  ['2026-11-01T08:30:00Z', '2026-11-01T11:00:00Z', '1:30 AM–3:00 AM'],            // clocks go back at 2 AM
  ['2026-06-13T15:00:00Z', null, '8:00 AM'],
  ['2026-06-13T15:00:00Z', '2026-06-13T15:00:00Z', '8:00 AM'],
  ['2026-06-13T15:00:00Z', '2026-06-13T14:00:00Z', '8:00 AM'],
  ['2026-06-13T15:00:00Z', 'soon', '8:00 AM'],
])('%s to %s is %s', (start, end, text) => expect(shiftTime(start, end)).toBe(text));
it.each([null, 'soon', ''])('no usable start (%j) is null', (start) => expect(shiftTime(start, '2026-06-13T19:00:00Z')).toBeNull());
it('uses ordinary spaces', () => expect(shiftTime('2026-06-13T15:00:00Z', '2026-06-13T19:00:00Z')).not.toMatch(/[   ]/));
```

- [ ] **Step 2:** `npm test -- src/mapping/shiftTime.test.ts` → FAIL, cannot find module.
- [ ] **Step 3:** Implement with two module-level `Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', … })` formatters; replace U+202F with a space.
- [ ] **Step 4:** Same command → PASS. Commit `feat(eventbrite-sync): format a listing's shift time`.

### Task 2: Write it

**Files:** Modify `src/types.ts`, `src/config.ts`, `src/config.test.ts`, `src/mapping/volunteer.ts`, `volunteer.test.ts`, `src/test/testConfig.ts` (`shiftTimeColumn: 'vol_time_col'`), `config/svbc.json`, `config/sandbox.json` (placeholder), `config/split.test.ts` if it lists optional volunteer columns

**Interfaces:** Consumes `shiftTime` (Task 1). `mapVolunteer`'s `facts` becomes `EventFacts & { startsAt: string | null; endsAt: string | null }`, which `mapEvent` already returns, so `processVolunteer.ts` doesn't change.

- [ ] **Step 1: Failing tests.** `volunteer.test.ts`: with `startsAt: '2026-06-13T15:00:00Z', endsAt: '2026-06-13T19:00:00Z'`, `columnValues.vol_time_col` is `'8:00 AM–12:00 PM'`; with the placeholder id no key holds it; with `startsAt: null` `vol_time_col` is absent. `config.test.ts`: copy the two `attendeePhoneColumn` tests (required string; placeholder still `ready`) for `shiftTimeColumn`.
- [ ] **Step 2:** Run both files → FAIL. **Step 3:** Implement: add the key to `VOLUNTEER_COLUMN_KEYS` (not `NEW_VOLUNTEER_COLUMN_KEYS`) and write it beside `ticketTypeColumn`.
- [ ] **Step 4:** `npm test && npm run typecheck` pass; commit `feat(eventbrite-sync): write volunteers' shift time`.

### Task 3: Setup script, marker and docs

**Files:** Modify `scripts/setup-volunteers-board-lib.mjs` + test, `scripts/setup-volunteers-board.mjs`, `scripts/mark-read-only-columns.mjs` (+ its test and the one at `setup-volunteers-board-lib.test.mjs:195`), `eventbrite-sync/README.md`, `docs/manual/workers/eventbrite-sync.md`, `docs/runbooks/volunteers-board-cutover.md`

- [ ] **Step 1: Failing tests:** `VOLUNTEER_COLUMN_SPECS` ends with `{ key: 'shiftTimeColumn', title: 'Shift Time', type: 'text' }`; `columnConfig` returns the key; `MARKED_COLUMNS['Volunteers'].locked` includes `Shift Time`; a new Upcoming by event's column order has Shift Time right after Shift.
- [ ] **Step 2–3:** FAIL, then implement. To test the order, move the `shown` list into `export function upcomingColumnOrder(volunteersColumns, sendLinkId)` in the lib.
- [ ] **Step 4: Docs.** README: the column, the optional key, the text-sort limit, replay to fill old rows. Manual: the Volunteers row of the board table. Runbook "For staff": what Shift Time shows, and that it is the listing's, not the re-pointed Event's.
- [ ] **Step 5:** In `eventbrite-sync`: `npm test && npm run typecheck`; from the root: `node --test scripts/*.test.mjs`, `check-log-safety`, `check-manual`, `check-worker-flags --strict` pass. Commit `feat(eventbrite-sync): Shift Time in the Volunteers setup`.

## Rollout (operator, after merge; each step on the operator's go-ahead)

1. Sandbox: dry-run then `--apply` `setup-volunteers-board.mjs`, put the id in `sandbox.json`, deploy, replay one listing pair, check the view.
2. Production: the same script, id in `svbc.json` by pull request, deploy, `mark-read-only-columns.mjs`.
3. Add the column to Upcoming by event, Completed by event and Recent events by hand.
4. Replay upcoming listings and the 54 listings in the 27 pairs with `backfill-attendees.mjs`, 2 s apart; spot-check both 2026-06-13 FIFA listings.
