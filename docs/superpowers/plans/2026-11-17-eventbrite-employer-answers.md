# Eventbrite Employer Answers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Eventbrite attendee's answer to "Where do you work?" becomes a Draft employer affiliation, proposed by `impact-attribution`'s nightly run for staff to confirm.

**Architecture:** `eventbrite-sync` detects the employer answer, looks the attendee up on People by email (never creating), and hands (person, answer) to `impact-attribution` over an optional service binding (`EMPLOYER_ANSWERS` → `EmployerAnswers` entrypoint). `impact-attribution` stores answers in D1, and each night resolves them to Organizations, keeps the latest per person, and proposes them alongside matching-gift candidates under the one cap and ledger.

**Tech Stack:** TypeScript on Cloudflare Workers (`WorkerEntrypoint` RPC, D1, Queues), Vitest, Monday GraphQL.

**Spec:** `docs/superpowers/specs/2026-11-17-eventbrite-employer-answers-design.md`

## Global Constraints

- Answer text is never logged, in either Worker. Logs carry ids, counts, states and reasons only.
- `eventbrite-sync` never creates a People item for this feature, and never writes a People link it doesn't write today.
- Answer text is stored trimmed and truncated to 200 characters.
- `employerAnswers.maxAgeDays` default 365. Answer-only Drafts are Proposed status **Current**.
- A pair with both match and answer evidence is **Current** if either source says Current.
- Latest answer per person wins: same person → keep the pending answer(s) with the latest `answered_at` (ties: latest `received_at`) and the same `answer_normalized`. All others → `superseded`.
- Answer states: `pending` / `proposed` / `skipped` / `expired` / `superseded`. Only `pending` rows are updated by a later call.
- RPC contract: return `{ recorded: true }` or `{ recorded: false, reason }` for anything deterministic; throw only on transient failures (D1, unreachable).
- Production `eventbrite-sync/wrangler.jsonc` gets **no** `EMPLOYER_ANSWERS` binding in this work. Sandbox does. A missing binding = feature off.
- Copied modules stay byte-identical and strip-only TypeScript (no enums, namespaces, parameter properties).
- Type-check with `npm run typecheck`, never bare `tsc`. Run Worker tests with the sandbox disabled.
- Commits: conventional, ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, referencing `(GL#127)`.

## Review Focus

1. **An answer that is an email address, a URL or a long paragraph.** Expect it stored truncated, never logged, and resolved to nothing (stays pending, then expires). Test in Task 2 (RPC truncation) and Task 6 (no answer text in any `console.*` call).
2. **Two answers from one person on the same day naming different employers.** Expect a deterministic winner (latest `received_at`), not two Drafts. Test in Task 3.
3. **An answer that resolves to an excluded payer, or to a pair that already has any affiliation.** Expect `skipped`, never retried. Test in Task 4.
4. **A placeholder `Info Requested` attendee, or a canceled/refunded one.** Expect no lookup and no RPC call. Test in Task 6.
5. **An answer that is a non-answer once normalised** ("N/A", "Self-Employed", "retired."). Expect `{ recorded: false, reason: 'non-answer' }`. Test in Task 2.

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `member-portal/src/changeRequests/employerName.ts` | create (canonical) | `normalizeEmployerName`, `organizationNameVariants`, `pickOrganization`, `OrganizationCandidate` |
| `member-portal/src/changeRequests/employer.ts` | modify | imports the above; keeps affiliation planning |
| `impact-attribution/src/employerName.ts` | create (byte-identical copy) | — |
| `.gitlab-ci.yml` | modify | `employer-name-copies` job |
| `impact-attribution/migrations/0003_employer_answers.sql` | create | `employer_answers` table; `proposals.sources` |
| `impact-attribution/src/answers/store.ts` | create | answer D1 reads/writes |
| `impact-attribution/src/answers/entrypoint.ts` | create | `EmployerAnswers` `WorkerEntrypoint`, validation |
| `impact-attribution/src/answers/rule.ts` | create | expire, supersede, merge into candidates (pure) |
| `impact-attribution/src/rule.ts`, `evidence.ts`, `run.ts`, `store.ts`, `config.ts`, `index.ts`, `monday/client.ts` | modify | integrate answers |
| `eventbrite-sync/src/mapping/employer.ts` | create | detect the employer answer (pure) |
| `eventbrite-sync/src/consumer/employerAnswer.ts` | create | lookup + RPC call + result handling |
| `eventbrite-sync/src/mapping/pledge.ts`, `types.ts`, `config.ts`, consumers, `writeSwitch.ts`, `wrangler.jsonc`, `scripts/pledge-event-config-lib.mjs` | modify | wire it in |

---

### Task 1: Share employer-name matching

**Files:**
- Create: `member-portal/src/changeRequests/employerName.ts`, `impact-attribution/src/employerName.ts`, `impact-attribution/src/employerName.test.ts`
- Modify: `member-portal/src/changeRequests/employer.ts`, `member-portal/src/changeRequests/applyEmployer.ts` (imports), `member-portal/src/changeRequests/employer.test.ts` (imports), `.gitlab-ci.yml`

**Interfaces:**
- Produces (both copies): `interface OrganizationCandidate { id: string; name: string }`, `normalizeEmployerName(name: string): string`, `organizationNameVariants(typed: string): string[]`, `pickOrganization(typed: string, candidates: OrganizationCandidate[]): { kind: 'one'; organization } | { kind: 'none' } | { kind: 'several'; organizations }` — moved verbatim from `employer.ts`, with `SUFFIX_WORDS`, `TRAILING_SUFFIX`, `SUFFIX_SPELLINGS`, `stemOf`.

- [ ] **Step 1: Move** the four exports and their private helpers from `employer.ts` into `employerName.ts`, with a header comment naming it canonical and pointing at the copy and the CI job. `employer.ts` imports `OrganizationCandidate` (for its own types) and re-exports nothing; update imports in `applyEmployer.ts` and tests.
- [ ] **Step 2: Run** `cd member-portal && npm test && npm run typecheck`. Expected: all pass, unchanged count.
- [ ] **Step 3: Copy** to `impact-attribution/src/employerName.ts` (`cp`). Add `employerName.test.ts` there: `normalizeEmployerName('AT & T, Inc.') === 'att'`, `organizationNameVariants('Google')` contains `'Google, LLC'`, `pickOrganization('google', [{id:'1',name:'Google, LLC'},{id:'2',name:'Googleplex'}])` is `{ kind: 'one', organization: {id:'1',…} }`.
- [ ] **Step 4: Add the CI job** `employer-name-copies` on the `monday-graphql-copies` model: rules on `"*/src/**/employerName.ts"` and `.gitlab-ci.yml`; `cmp member-portal/src/changeRequests/employerName.ts impact-attribution/src/employerName.ts`; `node --input-type=module -e "await import('./member-portal/src/changeRequests/employerName.ts')"`. Add a one-line comment above it like the other copy jobs.
- [ ] **Step 5: Verify** `cmp` passes locally and `cd impact-attribution && npm test && npm run typecheck` passes.
- [ ] **Step 6: Commit** `refactor(member-portal,impact-attribution): share employer-name matching (GL#127)`.

### Task 2: Answer storage and the `EmployerAnswers` RPC

**Files:**
- Create: `impact-attribution/migrations/0003_employer_answers.sql`, `src/answers/store.ts`, `src/answers/store.test.ts`, `src/answers/entrypoint.ts`, `src/answers/entrypoint.test.ts`
- Modify: `src/config.ts`, `src/config.test.ts`, `config/sandbox.json`, `config/svbc.json`, `src/index.ts`, `src/types.ts`

**Interfaces:**
- Produces:
  - Config: `employerAnswers?: { maxAgeDays: number; ignore: string[] }` (absent → feature off). Organizations board is the existing `organizationsBoardId`.
  - `interface EmployerAnswerInput { source: 'eventbrite'; sourceId: string; personItemId: string; answer: string; answeredAt: string /* YYYY-MM-DD */; context: string }`
  - `type EmployerAnswerResult = { recorded: true } | { recorded: false; reason: 'disabled' | 'invalid' | 'non-answer' | 'closed' }`
  - `interface AnswerRow { source: string; sourceId: string; personItemId: string; answer: string; answerNormalized: string; answeredAt: string; context: string; state: AnswerState; orgItemId: string | null; receivedAt: string }`, `type AnswerState = 'pending' | 'proposed' | 'skipped' | 'expired' | 'superseded'`
  - store: `upsertAnswer(db, row: Omit<AnswerRow, 'state' | 'orgItemId'>): Promise<'inserted' | 'updated' | 'closed'>`, `pendingAnswers(db): Promise<AnswerRow[]>`, `setAnswerStates(db, updates: { source: string; sourceId: string; state: AnswerState; orgItemId?: string | null }[], now: string): Promise<void>` (one `db.batch`), `touchPending(db, keys: {source; sourceId}[], now): Promise<void>` (sets `last_tried_at`).
  - `export class EmployerAnswers extends WorkerEntrypoint<Env> { recordEmployerAnswer(input: EmployerAnswerInput): Promise<EmployerAnswerResult> }`, exported from `src/index.ts`.

- [ ] **Step 1: Write the migration.** `employer_answers` columns exactly as the spec's "Storing it" (primary key `(source, source_id)`, `state` CHECK over the five states, index on `(person_item_id)` and on `(state)`). Plus `ALTER TABLE proposals ADD COLUMN sources TEXT NOT NULL DEFAULT 'matches' CHECK (sources IN ('matches','answers','both'))`.
- [ ] **Step 2: Write failing store tests** (miniflare D1, as `store.test.ts` does): insert then `pendingAnswers` returns it; a second upsert with new text while pending → `'updated'` and new text; after `setAnswerStates(... 'proposed')` an upsert → `'closed'` and text unchanged; `setAnswerStates` writes `org_item_id`.
- [ ] **Step 3: Write failing entrypoint tests** calling the method's logic through an exported pure-ish function `handleRecord(env, config, input, now)` (so tests needn't construct a `WorkerEntrypoint`):
  - config without `employerAnswers` → `{ recorded: false, reason: 'disabled' }`;
  - non-numeric `personItemId`, empty `sourceId`, bad `answeredAt` → `'invalid'`;
  - `answer: '  N/A '` with `ignore: ['n/a']` (compared via `normalizeEmployerName`) → `'non-answer'`; also an answer that normalises to `''`;
  - a 500-char answer is stored as its first 200 characters (trimmed);
  - stored `answer_normalized === normalizeEmployerName(answer)`;
  - a closed row → `'closed'`;
  - a D1 failure (stub `db.prepare` throwing) → the call **throws**.
- [ ] **Step 4: Run** `npm test -- src/answers`. Expected: FAIL (module not found).
- [ ] **Step 5: Implement** config validation (`maxAgeDays` positive int, `ignore` list of strings), the store, `handleRecord`, and `EmployerAnswers` (reads `configFor(this.env)`, calls `handleRecord` with `new Date().toISOString()`). Logs: one line per call with `source`, `sourceId`, `personItemId`, result — never the answer. Add `employerAnswers` to both config files (`maxAgeDays: 365`, `ignore`: `n/a`, `na`, `none`, `no`, `retired`, `self`, `self employed`, `selfemployed`, `unemployed`, `student`, `homemaker`, `not employed`, `-`).
- [ ] **Step 6: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 7: Commit** `feat(impact-attribution): store employer answers through an EmployerAnswers RPC (GL#127)`.

### Task 3: Answer rule (pure)

**Files:**
- Create: `impact-attribution/src/answers/rule.ts`, `src/answers/rule.test.ts`
- Modify: `src/rule.ts` (Candidate), `src/rule.test.ts`, `src/evidence.ts`, `src/evidence.test.ts`

**Interfaces:**
- Consumes: `AnswerRow` (Task 2), `Candidate`, `pairKey` (`src/rule.ts`).
- Produces:
  - `Candidate` gains `answers: AnswerRow[]` (newest first) and renames `latestMatch` → `latestEvidence` (latest of match and answer dates). Update `qualifyingPairs` (answers `[]`) and `selectCandidates`' sort.
  - `expireAndSupersede(rows: AnswerRow[], today: string, maxAgeDays: number): { live: AnswerRow[]; expired: AnswerRow[]; superseded: AnswerRow[] }`
  - `answerCandidates(resolved: { row: AnswerRow; orgItemId: string }[]): Candidate[]` — grouped by pair, `proposedStatus: 'Current'`, `matches: []`.
  - `mergeCandidates(fromMatches: Candidate[], fromAnswers: Candidate[]): Candidate[]` — same pair → one candidate, both evidence lists, Current if either is Current, `latestEvidence` the max.
  - `evidenceComment(orgName: string, matches: MatchRow[], answers?: AnswerRow[]): string`

- [ ] **Step 1: Write failing tests**:
  - `expireAndSupersede`: a row answered 366 days before `today` → expired (365 kept); person P with `Google` 2026-03-01 and `Apple` 2027-02-01 → live is Apple only, Google superseded; two rows same day, different text → the later `receivedAt` wins; two rows for P both normalising to `google` → both live; rows for different people are independent.
  - `answerCandidates`: two answers from P resolving to org 9 → one candidate with both answers, Current, `latestEvidence` the later date.
  - `mergeCandidates`: match candidate (P, 9) Former + answer candidate (P, 9) → one, Current, matches and answers kept; non-overlapping lists concatenated.
  - `evidenceComment`: answer-only → `Proposed from an Eventbrite answer: "Google" (Pledge to Ride 2027, 2027-01-20)`, one line per answer; mixed → match lines first, then answer lines; matches-only output unchanged from today's tests.
- [ ] **Step 2: Run** `npm test -- src/answers/rule.test.ts src/rule.test.ts src/evidence.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Answer lines in the comment use the stored (truncated) text in double quotes; at most 10 answer lines, like matches.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(impact-attribution): expire, supersede and merge employer answers (GL#127)`.

### Task 4: Nightly run proposes from answers

**Files:**
- Modify: `impact-attribution/src/run.ts`, `src/run.test.ts`, `src/monday/client.ts`, `src/monday/client.test.ts` (if present; else extend `run.test.ts` fakes), `src/store.ts` (`recordProposal` takes `sources`)

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `ImpactMondayClient.findOrganizationsByNames(boardId: string, names: string[]): Promise<OrganizationCandidate[]>` (one `items_page_by_column_values` on `name` with `any_of`, chunks of 100, as `member-portal`'s client does); `recordProposal(db, { …, sources: 'matches' | 'answers' | 'both' }, now)`; `RunSummary.answers: { pending: number; expired: number; superseded: number; resolved: number; unresolved: number; skipped: number; proposed: number }`.

- [ ] **Step 1: Write failing `run.test.ts` cases** (existing fake-client style):
  - config without `employerAnswers` → the answer step doesn't run (no `findOrganizationsByNames` call), summary `answers` all zero;
  - pending "Google" for person P, Organizations returns `Google, LLC` → Draft created with Proposed status Current, `recordProposal` with `sources: 'answers'`, `matchCount: 0`, the answer row `proposed` with `orgItemId`, comment contains the answer line;
  - pending "Acme" with no Organization → no Draft, row stays `pending`, `last_tried_at` set; next run with Organizations now returning `Acme` → Draft;
  - two Organizations normalising equal → stays `pending`;
  - resolved pair in `excludedPayers`, in existing affiliation pairs, or in the ledger → row `skipped`, no Draft;
  - resolved answer whose person item is gone → `skipped` (doesn't use a slot);
  - (P, 9) qualifies from matches as Former and has an answer → one Draft, Current, `sources: 'both'`, both kinds of comment lines, answer row `proposed`;
  - cap: `maxProposalsPerRun: 1` with one answer candidate and one Former match candidate → the Current one is proposed, the other deferred, its answer still `pending`;
  - `mode 'off'`: no Monday writes, no `proposals` rows; answer rows still expired/superseded/skipped and `last_tried_at` set; would-propose list includes answer candidates; logs contain no answer text (spy on `console.log` and assert the answer string is absent).
- [ ] **Step 2: Run** `npm test -- src/run.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** in `runProposals`, after the match refresh and before `selectCandidates`: load pending → `expireAndSupersede` → write expired/superseded states → `findOrganizationsByNames` over the union of `organizationNameVariants` of each distinct live answer → `pickOrganization` per answer (`one` → resolved; else `touchPending`) → `answerCandidates` → `mergeCandidates` with `qualifyingPairs` output → existing `selectCandidates` and liveness walk. Answers on a candidate dropped by `selectCandidates`' skips or the liveness check are marked `skipped`; on a created Draft `proposed`; deferred stay `pending`. `sources` from which evidence lists are non-empty.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(impact-attribution): propose Draft affiliations from employer answers (GL#127)`.

### Task 5: Detect the employer answer in `eventbrite-sync`

**Files:**
- Create: `eventbrite-sync/src/mapping/employer.ts`, `src/mapping/employer.test.ts`
- Modify: `src/types.ts` (`PledgeField` adds `'employer'`), `src/mapping/pledge.ts`, `src/mapping/pledge.test.ts`, `scripts/pledge-event-config-lib.mjs` and its test

**Interfaces:**
- Produces: `employerAnswerFrom(attendee: EventbriteAttendee, pledgeEvent: PledgeEventConfig | null): string | null` — with a pledge event, the answer to the question mapped to `employer`; otherwise the first non-blank answer to a `text` question whose wording matches `EMPLOYER_QUESTION`. Trimmed; `null` when none. `export const EMPLOYER_QUESTION = /employer|where do you work|company you work|empleador|d[oó]nde trabajas/i`.

- [ ] **Step 1: Write failing tests**: matches "Employer", "Where do you work?", "¿Dónde trabajas?", "Name of the company you work for"; not "Do you use Zipcar?", "Company name for invoice" (builder: decide and pin whichever you choose), a `multiple_choice` question; blank answer → null; pledge event with `questions: { '123': 'employer' }` uses question 123 even if its wording doesn't match. `mapPledge` with an `employer`-mapped question puts the answer in Other Answers **and** writes no other column for it. `buildEventConfig` maps a question worded "Where do you work?" to `employer`.
- [ ] **Step 2: Run** `npm test -- src/mapping`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `mapPledge`, `employer` is the one field that falls through to `other.push`. Add `[/where do you work|employer/i, 'employer']` to the lib's pattern list.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(eventbrite-sync): recognise the employer question (GL#127)`.

### Task 6: Record answers from the consumers

**Files:**
- Create: `eventbrite-sync/src/consumer/employerAnswer.ts`, `src/consumer/employerAnswer.test.ts`
- Modify: `src/types.ts` (`Env.EMPLOYER_ANSWERS?`), `src/config.ts` + test (`employerAnswers: { enabled: boolean }`, both config files `false`), `src/consumer/processBatch.ts` (`ProcessBatchDeps.employerAnswers: EmployerAnswerSink | null`), `src/index.ts` (wire the binding), `src/writeSwitch.ts` (dry-run proxy for the sink), `src/consumer/processPledge.ts`, `processVolunteer.ts`, `processAttendee.ts` and their tests, `wrangler.jsonc` (sandbox `services` only)

**Interfaces:**
- Consumes: `employerAnswerFrom` (Task 5); the RPC shape from Task 2, declared structurally here: `interface EmployerAnswerSink { recordEmployerAnswer(input: EmployerAnswerInput): Promise<EmployerAnswerResult> }` with the same `EmployerAnswerInput`/`EmployerAnswerResult` field names.
- Produces: `recordEmployerAnswer(attendee: EventbriteAttendee, pledgeEvent: PledgeEventConfig | null, context: string, deps: ProcessBatchDeps): Promise<void>`.

- [ ] **Step 1: Write failing tests** for `recordEmployerAnswer`:
  - `deps.employerAnswers === null` or `config.employerAnswers.enabled === false` → no People lookup, no call;
  - `attendee.cancelled` or `attendee.refunded` → no call; placeholder `Info Requested` email → no call; no answer → no lookup;
  - People lookup uses `mondayClient.findItemByColumnValue(peopleBoardId, config.attendeeSync.peopleEmailColumn, email)` and **never** `createItem`; miss → no call;
  - hit → call with `{ source: 'eventbrite', sourceId: attendee.id, personItemId, answer, answeredAt: attendee.created.slice(0,10), context }`;
  - `{ recorded: false, reason }` → resolves (logs `attendee <id> employer answer not recorded: <reason>`); a thrown error → rethrows;
  - no `console.*` argument contains the answer text.
- [ ] **Step 2: Write failing consumer tests**: in each of the three consumers, on both the create and update paths, `recordEmployerAnswer` runs after the Monday write and before `updateStatus('written')`; when it throws, the status isn't `written` and the error propagates (message retries); on retry the existing item is adopted (no second `createItem`). Under the dry-run deps the sink is a recording proxy: nothing is sent.
- [ ] **Step 3: Run** `npm test -- src/consumer`. Expected: FAIL.
- [ ] **Step 4: Implement.** `index.ts` builds `employerAnswers: env.EMPLOYER_ANSWERS ?? null`. Context: the event's name from the events ledger row or the cached Eventbrite event read (builder's choice; pledge may use `Pledge to Ride <year>`). `wrangler.jsonc` `env.sandbox.services` adds `{ "binding": "EMPLOYER_ANSWERS", "service": "svbc-impact-attribution-sandbox", "entrypoint": "EmployerAnswers" }`; production unchanged, with a comment saying why (spec "The binding is optional").
- [ ] **Step 5: Extend `eventbrite-sync/config/split.test.ts`:** sandbox's `EMPLOYER_ANSWERS` service ends in `-sandbox`, and production declares no `EMPLOYER_ANSWERS` binding.
- [ ] **Step 6: Run** `npm test && npm run typecheck`, then from the repo root `node scripts/check-log-safety.mjs` and `node scripts/check-monday-auth-bindings.mjs`. Expected: all pass.
- [ ] **Step 7: Commit** `feat(eventbrite-sync): hand employer answers to impact-attribution (GL#127)`.

### Task 7: Docs

**Files:** `eventbrite-sync/README.md` (new "Employer answers" section; Pledge to Ride "A new year's pledge" step on the employer question), `impact-attribution/README.md` (second evidence source, `employer_answers`, RPC, states, `off` behaviour, rollout order), root `README.md` status rows for both Workers, `CLAUDE.md` (one line: `employerName.ts` copy roster, `employer-name-copies` job).

- [ ] **Step 1: Write** from the spec and this plan only. Include the operator steps: `wrangler d1 migrations apply` for `impact-attribution` (sandbox, then production at its rollout), and deploy `impact-attribution` sandbox **before** `eventbrite-sync` sandbox so the binding resolves. State that production `eventbrite-sync` has no binding until `impact-attribution` is in production, and the three rollout steps verbatim from the spec.
- [ ] **Step 2: Commit** `docs(eventbrite-sync,impact-attribution): document employer answers (GL#127)`.
