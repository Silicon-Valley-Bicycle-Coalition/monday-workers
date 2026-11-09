# Pledge to Ride Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send every Pledge to Ride registration, with its answers, from Eventbrite to a private Monday board with a dashboard showing the MTC report's figures.

**Architecture:** `processAttendee` branches first for an event listed in `config.pledge.events` to a new `processPledge`, which fetches the attendee (and the order, for a placeholder), maps it with a pure `mapPledge`, and adopts or creates an item on the new board. Everything upstream (webhook, ledger, queue, write switch) is unchanged. Two scripts provision the board and generate a year's config; a daily check compares Eventbrite's total with the ledger.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers + D1 + Queues, Vitest, Monday GraphQL, Eventbrite API v3, Node `.mjs` scripts.

**Spec:** `docs/superpowers/specs/2026-11-05-pledge-to-ride-board-design.md`

## Global Constraints

- Run commands from `eventbrite-sync/`. Tests need the sandbox disabled (workerd binds a port). Type-check only with `npm run typecheck`, never a bare `tsc`.
- A config with no `pledge` block behaves exactly as today.
- Answers and email addresses never reach `console.*` or the D1 ledger. `node ../scripts/check-log-safety.mjs eventbrite-sync/src` stays clean (run from `eventbrite-sync/` as written in its README).
- This repo is public: no real names, addresses or free-text answers in tests, fixtures or config. Question ids, choice text and zip codes are fine.
- Keep SVBC-specific values in `config/*.json`. Find Monday columns by title only through `bareTitle` from `scripts/lib/column-titles.mjs`.
- Duplicates stay counted; placeholders count as pledges. Never fold `Unknown` into `Outside`. Never infer consent.
- Column labels exactly: Status `Pledged`, `Canceled`. Details `Complete`, `Buyer only`. County `Santa Clara`, `San Mateo`, `Outside`, `Unknown`.
- Tasks 9 and 10 touch live systems. Each step there marked **(operator)** waits for David's go-ahead in chat; an agent does not run it unasked.

## Review Focus

1. A choice containing `/` or a comma (`Banner/Flyer/Poster/Letrero/folleto`): multi-select answers split only on ` | `, so the choice stays whole. Test in Task 3.
2. A placeholder whose order 404s or also holds a placeholder: the pledge is still written, named `Pledge <id>`, with no email and `Buyer only`, not failed. Test in Task 4.
3. A long or multi-line free-text answer: text columns get whitespace collapsed to single spaces, Other Answers and text columns are cut to 2,000 characters, and the item name to 255. Test in Task 3.
4. A pledge delivered while the write switch is `off`: nothing is written to the new board and no ledger row changes, which needs the board known to the dry-run client. Test in Task 4.
5. A registration still in the queue when the daily check runs: a small difference is logged with wording that says it may be in flight and to look again tomorrow. Test in Task 6.

---

### Task 1: Placeholder text is blank on every event

Independent of the rest, and can ship first. Includes committing the spec and this plan.

**Files:**
- Create: `eventbrite-sync/src/eventbrite/placeholder.ts`, `eventbrite-sync/src/eventbrite/placeholder.test.ts`
- Modify: `eventbrite-sync/src/mapping/attendee.ts:37-39`
- Test: `eventbrite-sync/src/mapping/attendee.test.ts`

**Interfaces:**
- Produces: `realEmail(value: unknown): string | null`, `realName(value: unknown): string | null`, `isPlaceholderAttendee(profile: { email?: string | null } | null | undefined): boolean` in `placeholder.ts`.

- [ ] **Step 1: Write failing tests**

```ts
expect(realEmail('Info Requested')).toBeNull();
expect(realEmail('  pat@example.org ')).toBe('pat@example.org');
expect(realEmail('')).toBeNull();
expect(realName('Info Requested Info Requested')).toBeNull();
expect(realName('Info Requested')).toBeNull();
expect(realName('Pat Rider')).toBe('Pat Rider');
expect(isPlaceholderAttendee({ email: 'Info Requested' })).toBe(true);
expect(isPlaceholderAttendee({ email: 'pat@example.org' })).toBe(false);
// attendee.test.ts: 'maps a placeholder attendee with no name or email columns'
const m = mapAttendee(attendee({ id: 'a9', profile: { name: 'Info Requested Info Requested', first_name: 'Info Requested', email: 'Info Requested' } }), facts, config, 'Registered');
expect(m.itemName).toBe('Eventbrite attendee a9');
expect(m.columnValues).not.toHaveProperty(cols.attendeeEmailColumn);
expect(m.columnValues).not.toHaveProperty(cols.attendeeNameColumn);
expect(m.columnValues).not.toHaveProperty(cols.firstNameColumn);
```

- [ ] **Step 2: Run to verify failure:** `npm test -- src/eventbrite/placeholder.test.ts src/mapping/attendee.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement.** `realEmail` trims and requires an `@`. `realName` trims and returns null for blank or a value made only of repeated `Info Requested`. In `mapAttendee`, replace `nonEmpty` on name, first name and email with these (drop `nonEmpty` once unused).

- [ ] **Step 4: Run to verify pass:** the same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ../docs/superpowers/specs/2026-11-05-pledge-to-ride-board-design.md ../docs/superpowers/plans/2026-11-05-pledge-to-ride-board.md src/eventbrite/placeholder.ts src/eventbrite/placeholder.test.ts src/mapping/attendee.ts src/mapping/attendee.test.ts
git commit -m "fix(eventbrite-sync): treat Eventbrite's Info Requested placeholder as blank"
```

### Task 2: Pledge config

**Files:**
- Modify: `eventbrite-sync/src/types.ts:72` (`EventbriteSyncConfig`), `eventbrite-sync/src/config.ts`, `eventbrite-sync/src/test/testConfig.ts`
- Test: `eventbrite-sync/src/config.test.ts`

**Interfaces:**
- Produces, in `types.ts`:

```ts
export type PledgeField = 'zip' | 'daysPledged' | 'riderType' | 'heardAbout' | 'whoAsked' | 'consent';
export interface PledgeEventConfig {
  year: number;
  questions: Record<string, PledgeField>; // Eventbrite question id → field
  ignoreQuestions: string[];              // question ids
  choices: Record<string, string>;        // Eventbrite's exact answer text → label
  consentValues: string[];
}
export interface PledgeConfig {
  nameMatch: string;
  columns: {
    attendeeIdColumn: string; yearColumn: string; statusColumn: string; dateColumn: string; emailColumn: string;
    detailsColumn: string; zipColumn: string; countyColumn: string; daysPledgedColumn: string; riderTypeColumn: string;
    heardAboutColumn: string; whoAskedColumn: string; consentColumn: string; otherAnswersColumn: string;
  };
  zipCounty: Record<string, string[]>; // county label → 5-digit zips
  events: Record<string, PledgeEventConfig>; // Eventbrite event id → its setup
}
```

`EventbriteSyncConfig` gains `pledge?: PledgeConfig`. The board id lives in `monday.boards['pledge-to-ride']` (optional, `number | null`), not in `pledge`, because the dry-run client (`src/writeSwitch.ts`) resolves sinks from `monday.boards`.

- [ ] **Step 1: Write failing tests** in `config.test.ts`: a config with no `pledge` passes; `pledge` with a non-numeric event id, a `questions` value outside `PledgeField`, a zip that isn't 5 digits, a zip under two counties, a blank column id, an empty `nameMatch`, or no `monday.boards['pledge-to-ride']` each throw, with the message naming the key (`config: "pledge.events.123.questions.456" ...`).

- [ ] **Step 2: Run to verify failure:** `npm test -- src/config.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `validatePledge(raw: unknown, boards: Record<string, unknown>): void` in `config.ts`**, called from `validateConfig` only when `cfg.pledge !== undefined`. Follow `validateAttendeeSync`'s style; reuse `requireColumns`. Add a `pledge` factory to `testConfig.ts` as an exported `withPledge(config)` helper so other suites stay unchanged.

- [ ] **Step 4: Run to verify pass:** `npm test -- src/config.test.ts && npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit** with message `feat(eventbrite-sync): validate the pledge config`.

### Task 3: Map a pledge

**Files:**
- Create: `eventbrite-sync/src/mapping/pledge.ts`, `eventbrite-sync/src/mapping/pledge.test.ts`
- Modify: `eventbrite-sync/src/eventbrite/client.ts:65-74` (`EventbriteAttendee`)

**Interfaces:**
- Consumes: `realEmail`, `realName`, `isPlaceholderAttendee` (Task 1); `PledgeConfig`, `PledgeEventConfig` (Task 2); `toISODate` from `src/util/isoDate.ts`.
- Produces: `countyForZip(zip: string | null, zipCounty: Record<string, string[]>): 'Outside' | 'Unknown' | string`, and

```ts
export function mapPledge(
  attendee: EventbriteAttendee,
  buyer: { name?: string | null; email?: string | null } | null,
  event: PledgeEventConfig,
  pledge: PledgeConfig
): { itemName: string; columnValues: Record<string, unknown> };
```

- `EventbriteAttendee` gains `created?: string | null`, `order_id?: string | null`, `answers?: EventbriteAnswer[] | null`, where `EventbriteAnswer = { question_id?: string | null; question?: string | null; type?: string | null; answer?: string | null }`.

- [ ] **Step 1: Write failing tests** with fake ids and made-up names. Column value shapes follow the Worker's existing writes: status as a plain label string, email `{ email, text }`, date `{ date }`; dropdown `{ labels: [...] }`, checkbox `{ checked: 'true' }`, long text `{ text }`.

```ts
// countyForZip
expect(countyForZip('95014', zc)).toBe('Santa Clara');
expect(countyForZip('94303', zc)).toBe('San Mateo');
expect(countyForZip('10001', zc)).toBe('Outside');
expect(countyForZip(null, zc)).toBe('Unknown');
expect(countyForZip('n/a', zc)).toBe('Unknown');
// 'writes a complete pledge': name, year '2026', status 'Pledged', details 'Complete',
// date in the Pacific day (created '2026-05-01T03:00:00Z' → '2026-04-30'), email, zip, county.
// 'cuts zip+4 and trims': answer ' 95014-1234 ' → zip '95014', county 'Santa Clara'.
// 'keeps a malformed zip as typed': answer 'abc' → zip 'abc', county 'Unknown'.
// 'maps single and multi choices': answer 'Multiple days/Varios días ' → 'Multiple days';
//   answer 'Banner/Flyer/Poster/Letrero/folleto | Friend/ Amigos' → { labels: ['Flyer', 'Friend'] } given choices.
// 'writes an unmapped choice as it arrives, and warns without the answer':
//   the label is the trimmed answer; console.warn's text contains the question id and not the answer.
// 'consent only from consentValues': 'Yes/Si' → { checked: 'true' }; 'No' or absent → key not present.
// 'unmapped answered question goes to Other Answers': { text: 'I see myself as: cyclist' };
//   an id in ignoreQuestions does not appear; an unanswered question does not appear.
// 'placeholder uses the buyer': name and email from buyer, details 'Buyer only', county 'Unknown',
//   no consent key, no Other Answers key.
// 'placeholder with no usable buyer': buyer null → itemName 'Pledge a1', no email key, details 'Buyer only'.
// 'canceled and refunded': status 'Canceled'.
// 'collapses whitespace and cuts free text': a 3,000-character answer with newlines in Who Asked →
//   single spaces, length 2000; same limit on Other Answers; a 300-character name → itemName length 255.
```

- [ ] **Step 2: Run to verify failure:** `npm test -- src/mapping/pledge.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement `mapPledge` and `countyForZip`.** Identify answers by `question_id` against `event.questions`. Split multi-select on ` | ` only. A zip counts as well formed when the trimmed answer starts with 5 digits. Omit a key rather than writing blank. Item name order: `realName(attendee.profile?.name)`, then `realName(buyer?.name)`, then `Pledge <id>`.

- [ ] **Step 4: Run to verify pass:** `npm test -- src/mapping/pledge.test.ts && npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit** with message `feat(eventbrite-sync): map a pledge and its answers to board columns`.

### Task 4: Write pledges to the board

**Files:**
- Create: `eventbrite-sync/src/consumer/processPledge.ts`, `eventbrite-sync/src/consumer/processPledge.test.ts`
- Modify: `eventbrite-sync/src/consumer/processAttendee.ts:15-22`, `eventbrite-sync/src/monday/client.ts:7-10,96-122`, `eventbrite-sync/src/writeSwitch.ts:83-84`

**Interfaces:**
- Consumes: `mapPledge` (Task 3); `withPledge` (Task 2); `isPlaceholderAttendee` (Task 1).
- Produces: `processPledge(message: AttendeeQueueMessage, row: AttendeeRow, event: PledgeEventConfig, deps: ProcessBatchDeps): Promise<void>`.
- `MondayClient.createItem` and `changeColumnValues` gain an optional last parameter `options?: { createLabelsIfMissing?: boolean }`, sent as Monday's `create_labels_if_missing`. A new year's choice labels then appear without a setup run. Other callers don't pass it and send what they send today.

- [ ] **Step 1: Confirm the single-attendee GET returns answers.** The spec requires this first. Run from `eventbrite-sync/` with the token in the shell, printing keys only:

```bash
curl -s -H "Authorization: Bearer $EVENTBRITE_PRIVATE_TOKEN" "https://www.eventbriteapi.com/v3/events/1977741403778/attendees/?page=1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).attendees[0].id))' | xargs -I{} curl -s -H "Authorization: Bearer $EVENTBRITE_PRIVATE_TOKEN" "https://www.eventbriteapi.com/v3/events/1977741403778/attendees/{}/" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);console.log(Object.keys(a).includes("answers"),Object.keys(a.answers?.[0]??{}))})'
```

Expected: `true [ 'answer', 'question', 'question_id', 'type' ]` or similar. If `answers` is absent, add `?expand=answers` or the documented equivalent to `getAttendee` for pledges, and note it here before continuing.

- [ ] **Step 2: Write failing tests**, following `processAttendee.test.ts`'s fakes.

```ts
// 'a pledge event creates on the pledge board, not Event Registrations, with no event wait'
//   eventRow null; createItem called with the pledge board id and { createLabelsIfMissing: true };
//   getEvent and eventStore.recordDelivery not called; row marked 'written' with the item id.
// 'a non-pledge event is unchanged': no pledge config or another event id → Event Registrations.
// 'adopts by attendee id': findItemByColumnValue hit → changeColumnValues, no createItem.
// 'a ledger item id skips the lookup': row.mondayItemId set → getItems then changeColumnValues.
// 'a redelivery writes no second item'.
// 'a placeholder fetches its order': getOrder called once, its name and email on the item.
// 'a complete pledge does not fetch its order': getOrder not called.
// 'an order 404 still writes': getOrder → null; created, named 'Pledge a1', 'written'.
// 'attendee 404': marked failed 'attendee not found in Eventbrite (HTTP 404)', no write.
// 'a deleted item': isActive false → failed with 'deleted or archived', not recreated.
// 'off writes nothing': consumeWriteBatch with mode 'off' → real createItem not called, ledger unchanged.
```

- [ ] **Step 3: Run to verify failure:** `npm test -- src/consumer/processPledge.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 4: Implement.** At the top of `processAttendee`, after reading the row: `const pledgeEvent = config.pledge?.events[eventId]; if (pledgeEvent) return processPledge(message, row, pledgeEvent, deps);`. `processPledge` mirrors the existing adopt, gone and write sequence using `markGone` semantics; extract no shared helper unless it stays smaller. In `writeSwitch.ts`, forward the new options argument. Confirm `dryRunMondayClient` records writes for `monday.boards['pledge-to-ride']`, and map a label for it if it keys sinks by name.

- [ ] **Step 5: Run to verify pass:** `npm test && npm run typecheck && node ../scripts/check-log-safety.mjs src`. Expected: all PASS, no log-safety findings.

- [ ] **Step 6: Commit** with message `feat(eventbrite-sync): send pledge registrations to the Pledge to Ride board`.

### Task 5: Alarm for an unconfigured pledge event

**Files:**
- Modify: `eventbrite-sync/src/consumer/processEvent.ts:33-38`
- Test: `eventbrite-sync/src/consumer/processEvent.test.ts`

**Interfaces:**
- Consumes: `PledgeConfig.nameMatch`, `PledgeConfig.events` (Task 2).

- [ ] **Step 1: Write failing tests.** Event name `Pledge to Ride: Bike to Wherever Days 2027`, id not in `events`: `console.error` called once, its text has the event id and `pledge.events`, and the Events write still happens. Same name with the id in `events`: no error. Lower-case name `pledge to ride 2027`: error. No `pledge` config: no error. Name `Learn to Ride`: no error.

- [ ] **Step 2: Run to verify failure:** `npm test -- src/consumer/processEvent.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** after the `event === null` return, a case-insensitive `includes` on `event.name?.text`. Log the id and the fix: add it to `pledge.events` (`scripts/pledge-event-config.mjs`), clear its ledger ids, replay.

- [ ] **Step 4: Run to verify pass:** the same command. Expected: PASS.

- [ ] **Step 5: Commit** with message `feat(eventbrite-sync): alarm on a pledge event missing from config`.

### Task 6: Daily count check

**Files:**
- Create: `eventbrite-sync/src/pledgeCounts/check.ts`, `eventbrite-sync/src/pledgeCounts/check.test.ts`
- Modify: `eventbrite-sync/src/eventbrite/client.ts`, `eventbrite-sync/src/db/attendees.ts:17-23`, `eventbrite-sync/src/test/fakeStores.ts`, `eventbrite-sync/src/index.ts:125-175`
- Test: `eventbrite-sync/src/db/attendees.test.ts`, the scheduled tests in `eventbrite-sync/src/index.test.ts`

**Interfaces:**
- Produces:

```ts
// client.ts, kept off EventbriteClient like EventbriteOrderLister, so consumer fakes don't change
export interface EventbriteAttendeeCounter { countAttendees(eventId: string): Promise<number>; }
// attendees.ts
countByEvent(eventId: string): Promise<number>;
// check.ts
export interface PledgeCountDeps {
  counter: EventbriteAttendeeCounter;
  ledger: { countByEvent(eventId: string): Promise<number> };
  events: { getEvent(eventId: string): Promise<{ endsAt: string | null } | null> };
  eventIds: string[];
}
export interface PledgeCountResult { eventId: string; eventbrite: number; ledger: number; }
export function checkPledgeCounts(now: Date, deps: PledgeCountDeps): Promise<PledgeCountResult[]>;
export function logPledgeCounts(results: PledgeCountResult[]): void;
```

- [ ] **Step 1: Write failing tests.**

```ts
// checkPledgeCounts
// 'checks an event still ahead, or with no end date yet'; 'checks one ended 29 days ago';
// 'skips one ended 31 days ago, reading nothing from Eventbrite'; returns both counts per event.
// logPledgeCounts
// equal counts → console.log only.
// differing → one console.error containing the event id, both counts, 'backfill-attendees.mjs',
//   and 'may still be in flight' (a registration on the queue during the check).
// countAttendees reads pagination.object_count from one GET of /events/{id}/attendees/ and
//   throws on a non-numeric id or a missing object_count.
// index.test: under hold, the scheduled run skips it; with no pledge config, countAttendees is never called.
```

- [ ] **Step 2: Run to verify failure:** `npm test -- src/pledgeCounts/check.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement.** Window is 30 days after `endsAt`. In `runScheduled`, in the check-hour branch after the missed-order check, run only when `config.pledge` has events, with its own `ctx.waitUntil(...).then(logPledgeCounts).catch(...)` so a failure logs and can't affect the missed-order check. A read-only job, so it follows that check under the switch; update the skip message and comment there.

- [ ] **Step 4: Run to verify pass:** `npm test && npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit** with message `feat(eventbrite-sync): check pledge counts against Eventbrite daily`.

### Task 7: Provision the board

**Files:**
- Create: `eventbrite-sync/scripts/setup-pledge-board.mjs`, `eventbrite-sync/scripts/setup-pledge-board.test.mjs`
- Modify: `scripts/mark-read-only-columns.mjs:63` (`MARKED_COLUMNS`), `.gitlab-ci.yml` (`eventbrite-sync` job rules: add `scripts/lib/**/*`), and its vitest include if `*.test.mjs` under `scripts/` isn't already matched

**Interfaces:**
- Consumes: `bareTitle` from `scripts/lib/column-titles.mjs`. Model on `dtd-sync/scripts/setup-columns.mjs`, including `labelIds` skipping reserved id 5.
- Produces: exported `PLEDGE_COLUMN_SPECS` (`{ key, title, type, labels? }`, `key` matching `PledgeConfig.columns`), `missingColumns(existing: {id,title}[], specs): spec[]`, `columnConfig(existing, specs): PledgeConfig['columns']`.
- CLI: `MONDAY_API_TOKEN=... node scripts/setup-pledge-board.mjs --workspace <id> [--board <id>] [--subscribe <userId>]... [--apply]`, dry run by default. Prints the board id and a config-ready `columns` JSON block.

Column titles and types, from the spec: Eventbrite Attendee ID (text), Year (status), Status (status, labels above), Pledge Date (date), Email (email), Details (status), Zip (text), County (status), Days Pledged (status), Rider Type (dropdown), Heard About It (dropdown), Who Asked (text), Contact Consent (checkbox), Other Answers (long_text). Board name `Pledge to Ride`, `board_kind: private`.

- [ ] **Step 1: Write failing tests.** `missingColumns` treats a title marked 🔒 as present (no duplicate); `columnConfig` returns the id for every key and throws naming the title when one is absent; no spec's status labels occupy id 5; `MARKED_COLUMNS['Pledge to Ride'].locked` contains every spec title.

- [ ] **Step 2: Run to verify failure:** `npm test -- scripts/setup-pledge-board.test.mjs`, and `node --test ../scripts/mark-read-only-columns.test.mjs` if that's its runner. Expected: FAIL.

- [ ] **Step 3: Implement the script and add `'Pledge to Ride': { locked: [...titles], history: [] }`** to `MARKED_COLUMNS`. With `--board` absent, look up the board by name in the workspace before creating, so a re-run never makes a second one. Without `--apply`, make no writes. Name in the output anything the token can't see, since a private board is invisible to a non-subscribed user.

- [ ] **Step 4: Run to verify pass:** the same commands. Expected: PASS.

- [ ] **Step 5: Commit** with message `feat(eventbrite-sync): add the Pledge to Ride board setup script`.

### Task 8: Generate a year's config

**Files:**
- Create: `eventbrite-sync/scripts/pledge-event-config.mjs`, `eventbrite-sync/scripts/pledge-event-config-lib.mjs`, `eventbrite-sync/scripts/pledge-event-config-lib.test.mjs`

**Interfaces:**
- Produces: `buildEventConfig(questions: object[], year: number): { config: PledgeEventConfig; notes: string[] }`. `questions` is the `questions` array from `GET /events/{id}/questions/`.
- CLI: `EVENTBRITE_PRIVATE_TOKEN=... node scripts/pledge-event-config.mjs --event-id <id> --year <n>`. Prints the JSON block and the notes; writes nothing; reads no attendees.

Field rules on the English question text, case-insensitive:

| Field | Matches |
|---|---|
| `zip` | `zip code` |
| `daysPledged` | `i pledge to ride`, `pledge to ride at least` |
| `riderType` | `check a box for whichever`, `i consider myself` |
| `heardAbout` | `how did you hear` |
| `whoAsked` | `who asked you` |
| `consent` | `authorize` |
| ignored | `^age$`, `^ethnicity`, `^gender` go to `ignoreQuestions` |

- [ ] **Step 1: Write failing tests**, using 2026's real question text and ids from the spec, and these 2025 titles: `Mailing Zip Code`, `Age`, `Ethnicity`, `Gender`, `During May, I pledge to ride at least...`.

```ts
const { config, notes } = buildEventConfig(questions2026, 2026);
expect(config.questions['319665204']).toBe('zip');
expect(config.questions['319665211']).toBe('daysPledged');
expect(config.questions['319953628']).toBe('consent');
expect(config.consentValues).toEqual(['Yes/Si']);
expect(config.choices['Multiple days/Varios días ']).toBe('Multiple days');
// An ambiguous choice is kept whole and flagged for a person, never guessed:
expect(config.choices['Banner/Flyer/Poster/Letrero/folleto']).toBe('Banner/Flyer/Poster/Letrero/folleto');
expect(notes.join('\n')).toContain('Banner/Flyer/Poster/Letrero/folleto');
// An unmatched question stays out, and a note says it goes to Other Answers:
expect(config.questions['319848568']).toBeUndefined();
expect(notes.join('\n')).toContain('319848568');
// 2025
expect(buildEventConfig(questions2025, 2025).config.ignoreQuestions).toEqual(expect.arrayContaining(['<age id>', '<ethnicity id>', '<gender id>']));
expect(buildEventConfig(questions2025, 2025).config.consentValues).toEqual([]);
```

- [ ] **Step 2: Run to verify failure:** `npm test -- scripts/pledge-event-config-lib.test.mjs`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement.** A choice's label is the text before its only `/`, trimmed; a choice with more than one `/` keeps its full text and gets a note. Use `listAttendeesUrl`-style digit checks on the id.

- [ ] **Step 4: Run to verify pass:** the same command. Expected: PASS.

- [ ] **Step 5: Commit** with message `feat(eventbrite-sync): generate a pledge event's config from its questions`.

### Task 9: Sandbox config, rehearsal and docs

**Files:**
- Modify: `eventbrite-sync/config/sandbox.json`, `eventbrite-sync/config/split.test.ts`, `eventbrite-sync/README.md`, `docs/uat/eventbrite-sync.md`, `README.md:138`

- [ ] **Step 1: (operator) Create the sandbox board:** `node scripts/setup-pledge-board.mjs --workspace <sandbox workspace> --subscribe <Sandbox Integration user id> --apply`. Paste the output into `config/sandbox.json`, and the board id into `monday.boards['pledge-to-ride']`.

- [ ] **Step 2: Fill the `pledge` block in `config/sandbox.json`:** `nameMatch: "Pledge to Ride"`, `zipCounty` from the spec's two lists with ranges expanded, and event `1977741403778` from `pledge-event-config.mjs`. Review its notes by hand, including setting `Banner/Flyer/Poster/Letrero/folleto` to `Flyer`.

- [ ] **Step 3: Write failing split-test cases:** add `pledge.columns.*` and `monday.boards.pledge-to-ride` to the lists that must differ between configs (latent until production has ids), and a new test that both configs' `pledge.zipCounty` are identical when both exist.

- [ ] **Step 4: Check the zip list reproduces the spec.** Add a test in `src/mapping/pledge.test.ts` reading `config/sandbox.json`: `countyForZip('94303', zc)` is `San Mateo`, `95014` is `Santa Clara`, `94002` is `San Mateo`, `94612` is `Outside`, and no zip is in both lists.

- [ ] **Step 5: Run:** `npm test && npm run typecheck`. Expected: PASS.

- [ ] **Step 6: Write the docs.** In `eventbrite-sync/README.md`: a Pledge to Ride section (flow, board, new-year steps from the spec, the recovery order, the count check), and correct the "2,557 registrations" text with what the spec found. Add the UAT steps; update the root status row. In the README's new section, state the new-year step: draft the event, generate config, deploy before publishing.

- [ ] **Step 7: Commit** with message `feat(eventbrite-sync): configure pledges in the sandbox and document them`.

- [ ] **Step 8: (operator) Deploy and rehearse.** `npm run deploy:sandbox`, then replay a slice. Don't create a test event and don't register an organization-wide sandbox webhook (the spec explains why).

```bash
EVENTBRITE_PRIVATE_TOKEN=... EVENTBRITE_WEBHOOK_SECRET=... node scripts/backfill-attendees.mjs --event-id 1977741403778 --env sandbox --worker-url <sandbox worker url> --pause-ms 2000
```

Stop it after about 50 deliveries. Expected on the board: complete pledges, `Buyer only` rows if the slice has any, correct county. Re-run the same slice: item count unchanged. Set the switch `off`, replay: nothing new; `hold`: messages wait; back to `on`.

- [ ] **Step 9: (operator) Replay a canceled attendee and delete the sandbox board's real data afterward.** Expected: its Status reads `Canceled`.

### Task 10: Production rollout

No code. Every step is **(operator)**. Must finish before the 2027 publish on 2027-01-15.

**Files:**
- Modify: `eventbrite-sync/config/svbc.json`, `monday-backup/config/backup.json` (`requiredBoardIds`)

- [ ] **Step 1: Check production for placeholder damage and ledger rows for the two backfill events:**

```bash
npx wrangler d1 execute svbc-eventbrite-sync --remote --command "select substr(error,1,120) e, count(*) n from attendees where error is not null group by 1 order by n desc"
```

```bash
npx wrangler d1 execute svbc-eventbrite-sync --remote --command "select event_id, count(*) n, sum(monday_item_id is not null) with_item from attendees where event_id in ('1977741403778','1119156359799') group by 1"
```

Expected: both events absent or `with_item` 0. If not, clear those ids first, as the spec's recovery section says. Any `Info Requested` failures on class events get replayed with the backfill after Task 1 deploys.

- [ ] **Step 2: Create the board** with `--subscribe` for the SVBC Integration user and the backup user. Fill `config/svbc.json`, including 2026 and 2025 events; generate 2025's block and map its fields. Add the board to `requiredBoardIds`. Run `node ../scripts/mark-read-only-columns.mjs` as its header says. Then `npm test` (the split test now has real ids).

- [ ] **Step 3: Confirm the access list** with the BTWD team, and subscribe those people.

- [ ] **Step 4: Deploy, then backfill.** Check Eventbrite's rate limit first; 2 s between deliveries is under the 2,000 calls an hour the spec cites, even with placeholders. 2026 first:

```bash
EVENTBRITE_PRIVATE_TOKEN=... EVENTBRITE_WEBHOOK_SECRET=... node scripts/backfill-attendees.mjs --event-id 1977741403778 --worker-url <production worker url> --pause-ms 2000
```

Expected on the board for Year 2026: Status `Pledged` = **2,906**, Details `Buyer only` = **352**, County about Santa Clara 1,705, San Mateo 570, Outside 274, Unknown 357. If the Pledged total isn't exact, stop and find out why before 2025. Then event `1119156359799`: Pledged = 3,272.

- [ ] **Step 5: Build the dashboard** on the board, per the spec's list: headline total and change; by county this year and last; pledges by week, this year and last; Days Pledged, Rider Type, Heard About It; the text note on `Unknown`, `Buyer only` and 2025's difference from the report. Record in the README whether year-over-year took one widget or two.

- [ ] **Step 6: Staff check.** The BTWD lead compares the dashboard with last year's workbook and answers the spec's open questions.

- [ ] **Step 7: At the 2027 draft:** run `pledge-event-config.mjs` on the draft event id, review, deploy before publish, and update the dashboard's Year filter. After publishing, make one test pledge, see the item appear, cancel it, see `Canceled`; if it doesn't flip, record that the backfill must re-run before reading report figures.

- [ ] **Step 8: Commit** with message `feat(eventbrite-sync): turn on pledges in production`.
