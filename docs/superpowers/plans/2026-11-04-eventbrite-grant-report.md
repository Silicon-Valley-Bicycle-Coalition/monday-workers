# Eventbrite Grant Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff can pull a funder's per-person list from one Monday view, by adding a validated Home Zip to Event Registrations and a Grant on Events.

**Architecture:** The existing attendee consumer reads the attendee's answers, keeps only a valid zip, and writes it with the rest of the registration. Grant, its mirror and the report view are Monday-side setup with no Worker code.

**Tech Stack:** TypeScript, Cloudflare Workers, Queues, Vitest, Monday GraphQL, Eventbrite API v3.

**Spec:** `docs/superpowers/specs/2026-11-04-eventbrite-grant-report-design.md`

## Global Constraints

- All commands run from `eventbrite-sync/`. Type-check with `npm run typecheck`, never bare `tsc`.
- A zip reaches Monday only if it matches `^\d{5}(-\d{4})?$` after trimming, and only its first 5 digits are written. Any other text is discarded.
- No answer value, zip included, reaches D1 or `console.*`.
- `src/flags.ts` and `src/monday/graphql.ts` are byte-identical copies: do not edit them here.
- `node scripts/check-log-safety.mjs`, run from the repo root, stays clean.

## Review Focus

Each line's test lives in Task 2.

1. **A zip field holding anything but a zip** ("95112 please call me"): no write, and the text appears in no column value or log line.
2. **A later invalid edit to a good zip:** the column key is absent from the write, so the good value stays.
3. **Debug logging under `off`:** the skip line carries no zip. A `text_` column id is already cut to its length by `FREE_TEXT_KEYS`, so `piiKeysFor` protects any other id, and the test uses one that neither default list matches.
4. **An attendee with no `answers` key at all** (older record, or an API shape change): registration still writes, with no zip and no throw.
5. **A question whose wording only contains "zip" inside a word** ("Do you use Zipcar?"): its text answer is never written.

---

### Task 1: Check what the design assumes (throwaway, needs David)

Nothing from this task is committed except findings in the spec. **Stop and report before Task 2** if a finding contradicts the plan.

- [x] **Step 1: Run the read-only script.** Scratchpad `check-eb-answers.mjs`, through David's hidden token prompt. It prints shapes and tallies only.
- [x] **Step 2: Check the mirror.** On the sandbox boards, add Grant to Events and its mirror to Event Registrations, then filter a board view on the mirror.
- [x] **Step 3: Record findings.** Replace "To confirm before building" in the spec with what was seen, and adjust Task 2's `getAttendee` URL and types to match.
- [x] **Step 4: Commit.**

```bash
git add ../docs/superpowers/specs/2026-11-04-eventbrite-grant-report-design.md ../docs/superpowers/plans/2026-11-04-eventbrite-grant-report.md
git commit -m "docs(eventbrite-sync): grant report design, plan and API findings"
```

### Task 2: Home Zip from the attendee feed

**Files:**
- Create: `src/mapping/homeZip.ts`, `src/mapping/homeZip.test.ts`
- Modify: `src/eventbrite/client.ts`, `src/eventbrite/client.test.ts`, `src/mapping/attendee.ts`, `src/mapping/attendee.test.ts`, `src/types.ts`, `src/config.ts`, `src/config.test.ts`, `src/writeSwitch.ts`, `src/test/testConfig.ts`, `config/svbc.json`, `config/sandbox.json`, `config/split.test.ts`, `../scripts/mark-read-only-columns.mjs`, and the writeSwitch tests

**Interfaces:**
- Produces, in `src/eventbrite/client.ts`, on `EventbriteAttendee`:
  ```ts
  answers?: { question?: string | null; question_id?: string | null; type?: string | null; answer?: unknown }[] | null;
  ```
- Produces, in `src/mapping/homeZip.ts`:
  ```ts
  export function homeZipFromAnswers(answers: EventbriteAttendee['answers']): string | null
  ```
- Config: `attendeeSync.zipPrograms: string[]`, `attendeeSync.registrations.homeZipColumn: string`. Both configs ship `"zipPrograms": ["Public", "Group Rides"]` and `"homeZipColumn": "REPLACE_WITH_COLUMN_ID"`.

- [ ] **Step 1: Write the failing tests**

```ts
// homeZip.test.ts
const zip = (question, answer, type = 'text') => ({ question, question_id: '1', type, answer });
it.each(['What is your home ZIP code?', 'Home Zip Code', 'Mailing Zip Code', 'Your zipcode'])('reads "%s"', (w) => {
  expect(homeZipFromAnswers([zip(w, '95112')])).toBe('95112');
});
it('does not read a word containing zip', () => { expect(homeZipFromAnswers([zip('Do you use Zipcar?', '95112')])).toBeNull(); });
it('ignores a non-text question', () => { expect(homeZipFromAnswers([zip('Zip code', '95112', 'dropdown')])).toBeNull(); });
it('trims and reduces ZIP+4', () => { expect(homeZipFromAnswers([zip('Zip', ' 95112-1234 ')])).toBe('95112'); });
it.each(['95112 please call me', 'Zip: 95112', '9511', '951123', 'ABCDE', '', 95112, null, undefined])('treats %s as no answer', (v) => {
  expect(homeZipFromAnswers([zip('Zip', v)])).toBeNull();
});
it('takes the first valid answer', () => { expect(homeZipFromAnswers([zip('Home Zip', 'unknown'), zip('Mailing Zip', '94301')])).toBe('94301'); });
it.each([undefined, null, []])('copes with answers %s', (a) => { expect(homeZipFromAnswers(a)).toBeNull(); });

// attendee.test.ts
it('writes Home Zip for a program in zipPrograms', () => { /* columnValues[homeZipColumn] === '95112' */ });
it('leaves Home Zip out for an invalid answer, so a good value stays', () => { /* key absent; JSON of columnValues has no typed text */ });
it('leaves Home Zip out outside zipPrograms and when program is null', ...);
it('leaves Home Zip out while the column is the placeholder', ...);
it('carries no other answer into the write', () => {
  // attendee also answers emergency contact, a conditions question and free text with fixture values
  // assert: JSON.stringify(mapping) contains none of them
});

// client.test.ts
it('getAttendee keeps answers from the response, with its URL unchanged', ...); // the plain fetch already returns answers

// writeSwitch tests
it('a debug skip line for a registration carries no zip', () => { /* log debug, capture console; fixture zip absent */ });

// config.test.ts
it('requires homeZipColumn and rejects a non-array zipPrograms', ...);
// split.test.ts
it('production and sandbox share no Home Zip column id once both are set', ...);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- src/mapping/homeZip.test.ts src/mapping/attendee.test.ts`
Expected: FAIL, module or key not found.

- [ ] **Step 3: Implement `homeZipFromAnswers`**

Wording matches `/\bzip(\s?code)?\b/i`. Only string answers are considered. `typeof` guards, not `String(raw)`, so a number can't slip through.

- [ ] **Step 4: Wire it**

In `mapAttendee`, add the column only if the program is in `zipPrograms`, the column isn't `PLACEHOLDER_COLUMN_ID`, and the zip isn't null. Add `homeZipColumn` to `ATTENDEE_REGISTRATION_COLUMN_KEYS`, validate `zipPrograms`, and add both to the types and `testConfig`. Add `homeZipColumn`, lowercased, to `piiKeysFor`, unless it's the placeholder. Add `'Home Zip'` to `Event Registrations` `locked` in `MARKED_COLUMNS`.

- [ ] **Step 5: Run all tests, typecheck and log safety**

Run: `npm test && npm run typecheck && (cd .. && node scripts/check-log-safety.mjs && node --test scripts/mark-read-only-columns.test.mjs)`
Expected: PASS and clean.

- [ ] **Step 6: Commit**

```bash
git add src config ../scripts/mark-read-only-columns.mjs
git commit -m "feat(eventbrite-sync): write a validated Home Zip on registrations"
```

### Task 3: Docs, sandbox acceptance and rollout (needs David)

Steps touching live systems are for David to approve one at a time. Production waits for the sandbox check.

**Files:** `README.md`, `../docs/uat/eventbrite-sync.md`, `../README.md`, `config/sandbox.json`, `config/svbc.json`

- [ ] **Step 1: Write the docs.** In `README.md`'s attendee section: Home Zip's rules, the `zipPrograms` scope, Monday-side setup for Grant, its mirror and the Grant report view, and `backfill-attendees.mjs` for classes already written. Add a UAT scenario and the root README's status row. Commit.

```bash
git add README.md ../docs/uat/eventbrite-sync.md ../README.md
git commit -m "docs(eventbrite-sync): grant report"
```

- [ ] **Step 2: Sandbox.** Create Home Zip on the sandbox Event Registrations board, set its id in `config/sandbox.json`, run `npm run deploy:sandbox`, and mark columns with `node ../scripts/mark-read-only-columns.mjs --workspace <sandbox id> --suffix " (Sandbox)" --apply`.
- [ ] **Step 3: Accept.** A test registration with a valid zip writes it; an invalid edit leaves it; `backfill-attendees.mjs --env sandbox` fills an earlier registration; the Grant report view shows the funder's fields, and exports.
- [ ] **Step 4: Production.** With David's go-ahead: create Home Zip, Grant and its mirror, set the id in `config/svbc.json`, `npm test`, commit, merge, deploy, mark columns, build the Grant report view and the dashboard, then `backfill-attendees.mjs` for classes since November 1 once staff have set Grant.
