# Employer Affiliation Proposals (`impact-attribution`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new cron-only `impact-attribution` Worker that proposes Draft Affiliations (Current or Former) when the same company has matched a person at least twice within 365 days.

**Architecture:** Nightly cron. A D1 `matches` table holds every Matching Donation ever seen (bootstrapped once from the import artifacts, refreshed nightly from the active Donations board); a pure rule turns it into candidate (person, org) pairs; existing Affiliations and a D1 `proposals` ledger filter them; up to `maxProposalsPerRun` Drafts are created on Affiliations with an evidence comment. Shape copied from `contact-roles` (cron, write switch, config split) plus D1 like `dtd-sync`.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, Workers KV (FLAGS), vitest + `@cloudflare/vitest-plugin`, Node `node:test` for `.mjs` scripts.

**Spec:** `docs/superpowers/specs/2026-11-16-employer-affiliation-proposals-design.md`

## Global Constraints

- Worker directory `impact-attribution/`; Wrangler name `svbc-impact-attribution`, sandbox `svbc-impact-attribution-sandbox`; flag key `impact-attribution:writes`.
- Copy byte-identical, never edit: `member-portal/src/flags.ts` → `src/flags.ts`; `monday-backup/src/monday/graphql.ts` → `src/monday/graphql.ts`. Copy `contact-roles/src/environment.ts` as-is.
- Monday access only via `MONDAY_AUTH` service binding to `svbc-monday-auth` / `svbc-monday-auth-sandbox`, entrypoint `SyncToken`. No `MONDAY_API_TOKEN`.
- Columns found by bare title through `bareTitle` from `scripts/lib/column-titles.mjs`; never `c.title === title`.
- Logs carry item ids and counts only — never a person's name or email (`node scripts/check-log-safety.mjs` must pass). Organization names may be logged in the payer summary.
- Gift Type label `Matching Donation`. Rule: `windowDays` 365 (inclusive), `minMatches` 2, `currentWithinDays` 365 measured from the pair's latest match to the run date. `maxProposalsPerRun` default 25.
- Draft item name `<Person name> @ <Organization name>`; Status `Draft`; Proposed status `Current`/`Former`; Start/End/Role/Work Email/Primary/SVBC Roles blank.
- Write switch: `on` writes; `off` refreshes `matches`, writes nothing to Monday or `proposals`, logs the plan and payer summary; `hold`/`unknown` skip the run with no reads.
- Ledger row is written only after Monday confirms `create_item`; a failed comment after a created item still records the row.
- Typecheck with `npm run typecheck`, never bare `tsc`.
- Production board ids: Donations `18437909794`, Affiliations `18437909787`, People `18437909781`, People (Historical) `18437909784`, Organizations `18437909779`. Sandbox v4: Donations `18437342657`, Affiliations `18437342615`, Organizations `18437342579`, People `18437342592`, People (Historical) `18437342607` (confirm these two against `donation-rollups/config/sandbox.json`'s owner boards before committing).

## Review Focus

1. **A Donor linked to Organizations or to nothing, or a Matched By with 0 or ≥2 links** — the match is not stored; nothing crashes. Test in Task 4 (`parseMatchItem`).
2. **A match item that was in `matches` and is now on the board with Gift Type changed or Donor cleared** — the row is deleted; a row simply absent from the board is kept (archived). Test in Task 3 (`refreshMatches`).
3. **A candidate whose person or org item was deleted/merged after import** — skipped and counted, no `create_item` attempt. Test in Task 5.
4. **`create_item` succeeds, `create_update` throws** — ledger row still written, run continues to next candidate. Test in Task 5.
5. **Two matches on the same date, and two exactly 365 days apart** — both qualify; 366 days apart does not. Test in Task 2.

Sizing note (from the production import artifacts, 2026-11-16): 3,067 Matching Donations, 831 with an Organization Donor, 424 person–company pairs, 133 qualifying (56 Current) before removing pairs that already have an Affiliation. At 25/night the backlog drains in about six nights.

---

### Task 1: Scaffold the Worker and register it everywhere

**Files:**
- Create: `impact-attribution/package.json`, `wrangler.jsonc`, `tsconfig.json`, `vitest.config.ts`, `test/apply-migrations.ts`, `test/env.d.ts`, `migrations/0001_create_tables.sql`, `src/types.ts`, `src/index.ts`, `src/environment.ts`, `src/flags.ts`, `src/monday/graphql.ts`, `.gitignore`
- Modify: `.gitlab-ci.yml` (worker job + `deploy-sandbox:impact-attribution`, mirror `contact-roles`; add path to the `monday-graphql-copies` `for copy in` list), `scripts/check-worker-flags.mjs` (`IN_SCOPE`, alphabetical), `scripts/check-monday-auth-bindings.mjs` (`'impact-attribution': 'SyncToken'`), `monday-auth/README.md` (SyncToken row)
- Test: `impact-attribution/test/schema.test.ts`

**Interfaces:**
- Produces: `Env { DB: D1Database; FLAGS: KVNamespace; MONDAY_AUTH: MondayTokenSource; ENVIRONMENT?: string }` in `src/types.ts`; D1 tables below; `WORKER = 'impact-attribution'` in `src/index.ts`.

- [ ] **Step 1: Copy scaffolding.** `package.json`, `tsconfig.json` from `contact-roles` (rename, add `"test:scripts": "node --test scripts/*.test.mjs"`). `vitest.config.ts`, `test/apply-migrations.ts`, `test/env.d.ts` from `dtd-sync` (D1 migrations applied in setup; scripts excluded). `wrangler.jsonc` from `contact-roles` plus a `d1_databases` block (binding `DB`, `database_name` `svbc-impact-attribution` / `svbc-impact-attribution-sandbox`, `migrations_dir: "migrations"`, `database_id` `"REPLACE_WITH_D1_ID"` until the operator creates them in Task 8), cron `"0 11 * * *"` in both envs, `cpu_ms` 30000. Copy `environment.ts`, `flags.ts`, `graphql.ts` per Global Constraints.

- [ ] **Step 2: Write the failing schema test** `test/schema.test.ts`: inserts and reads back one `matches` row and one `proposals` row via `env.DB`; asserts `INSERT` of a duplicate `(person_item_id, org_item_id)` into `proposals` fails, and `INSERT OR IGNORE` of a duplicate `donation_item_id` into `matches` leaves one row.

- [ ] **Step 3: Run** `cd impact-attribution && npm install && npm test` — Expected: FAIL (no tables).

- [ ] **Step 4: Write `migrations/0001_create_tables.sql`:**

```sql
CREATE TABLE matches (
  donation_item_id TEXT PRIMARY KEY,
  person_item_id   TEXT NOT NULL,
  org_item_id      TEXT NOT NULL,
  match_date       TEXT NOT NULL,      -- YYYY-MM-DD
  amount_cents     INTEGER,            -- null when Amount is blank
  source           TEXT NOT NULL CHECK (source IN ('bootstrap', 'board')),
  seen_at          TEXT NOT NULL
);
CREATE INDEX matches_pair ON matches (person_item_id, org_item_id);
CREATE TABLE proposals (
  person_item_id      TEXT NOT NULL,
  org_item_id         TEXT NOT NULL,
  affiliation_item_id TEXT NOT NULL,
  proposed_status     TEXT NOT NULL CHECK (proposed_status IN ('Current', 'Former')),
  match_count         INTEGER NOT NULL,
  proposed_at         TEXT NOT NULL,
  PRIMARY KEY (person_item_id, org_item_id)
);
```

- [ ] **Step 5: `src/index.ts`** — `fetch` returns 404; `scheduled` reads write mode, logs and returns on `skip` exactly as `contact-roles/src/index.ts`, otherwise calls `runProposals` (Task 5; stub it to a no-op for now with a TODO-free comment "wired in Task 5").

- [ ] **Step 6: Register.** Edit the four roster files listed above.

- [ ] **Step 7: Verify.** `npm test` PASS; `npm run typecheck` PASS; from repo root `node scripts/check-worker-flags.mjs --strict` (expect only the D1/KV-id note if any, no drift), `node scripts/check-monday-auth-bindings.mjs`, `node scripts/check-log-safety.mjs` PASS; `cmp monday-backup/src/monday/graphql.ts impact-attribution/src/monday/graphql.ts` silent.

- [ ] **Step 8: Commit** `feat(impact-attribution): scaffold cron Worker with D1 schema`.

### Task 2: Config and the pairing rule

**Files:**
- Create: `impact-attribution/src/config.ts`, `config/svbc.json`, `config/sandbox.json`, `config/split.test.ts`, `src/config.test.ts`, `src/rule.ts`, `src/rule.test.ts`

**Interfaces:**
- Produces (`src/config.ts`):
  ```ts
  export interface ImpactAttributionConfig {
    monday: { apiUrl: string };
    donations: { boardId: string; giftType: string; matchedBy: string; donor: string; date: string; amount: string; matchingGiftLabel: string };
    affiliations: { boardId: string; person: string; organization: string; status: string; proposedStatus: string; labels: { draft: string; current: string; former: string } };
    peopleBoardIds: string[];
    organizationsBoardId: string;
    rule: { windowDays: number; minMatches: number; currentWithinDays: number };
    excludedPayers: { id: string; note: string }[];
    maxProposalsPerRun: number;
  }
  export function validateConfig(raw: unknown): ImpactAttributionConfig;
  export const configFor: (env: EnvironmentBindings) => ImpactAttributionConfig;
  ```
- Produces (`src/rule.ts`):
  ```ts
  export interface MatchRow { donationItemId: string; personItemId: string; orgItemId: string; matchDate: string; amountCents: number | null }
  export interface Candidate { personItemId: string; orgItemId: string; proposedStatus: 'Current' | 'Former'; latestMatch: string; matches: MatchRow[] } // matches newest first
  export function qualifyingPairs(matches: MatchRow[], rule: ImpactAttributionConfig['rule'], today: string): Candidate[];
  export function selectCandidates(all: Candidate[], skip: { excludedOrgIds: Set<string>; existingPairs: Set<string>; proposedPairs: Set<string> }, max: number): { chosen: Candidate[]; skipped: { excluded: number; existing: number; proposed: number }; deferred: number };
  export const pairKey: (personItemId: string, orgItemId: string) => string; // `${person}:${org}`
  ```

- [ ] **Step 1: Failing tests** in `src/rule.test.ts`:
  - `two matches 365 days apart qualify; 366 do not` (`2024-01-01`/`2024-12-31` qualifies — leap year, 365 days; `2023-01-01`/`2024-01-02` does not).
  - `two matches on the same date qualify`.
  - `one match never qualifies`.
  - `qualifies on any adjacent pair, not just the latest` (dates `2015-03-01`, `2015-09-01`, `2019-01-01` → qualifies).
  - `Current when latest match within 365 days of today, else Former` (today `2026-11-16`: latest `2025-11-16` → Current; `2025-11-15` → Former), and latest is the overall latest even if the qualifying pair is older.
  - `selectCandidates orders Current first then latestMatch desc, caps at max, counts deferred` and drops excluded / existing / proposed with the right `skipped` counts.
  - `config.test.ts`: rejects missing `excludedPayers`, non-integer `maxProposalsPerRun`, empty `peopleBoardIds`; accepts both shipped configs.
  - `split.test.ts`: no board id shared between `svbc.json` and `sandbox.json`; asserts the production ids in Global Constraints.

- [ ] **Step 2: Run** `npm test` — FAIL.

- [ ] **Step 3: Implement** `config.ts` (validation style of `contact-roles/src/config.ts`; `configFor = createConfigSelector({...})`) and the two JSON files (bare titles: `Gift Type`, `Matched By`, `Donor`, `Date`, `Amount`; `Person`, `Organization`, `Status`, `Proposed status`; `excludedPayers: []` in both — filled at the production gate). Implement `rule.ts`: group by pair, sort dates, qualify if any adjacent gap ≤ `windowDays` (day difference via `Date.UTC`), `minMatches` 2 is the only supported value — validate `minMatches === 2` in config rather than generalising.

- [ ] **Step 4: Run** `npm test && npm run typecheck` — PASS.

- [ ] **Step 5: Commit** `feat(impact-attribution): config and pairing rule`.

### Task 3: D1 store

**Files:**
- Create: `impact-attribution/src/store.ts`, `src/store.test.ts`

**Interfaces:**
- Consumes: `MatchRow`, `pairKey` (Task 2).
- Produces:
  ```ts
  export interface BoardMatchRead { stored: MatchRow[]; rejectedIds: string[] } // rejectedIds: active items on the board that no longer qualify as matches
  export function refreshMatches(db: D1Database, read: BoardMatchRead, now: string): Promise<{ upserted: number; deleted: number }>;
  export function allMatches(db: D1Database): Promise<MatchRow[]>;
  export function proposedPairs(db: D1Database): Promise<Set<string>>;
  export function recordProposal(db: D1Database, p: { personItemId: string; orgItemId: string; affiliationItemId: string; proposedStatus: 'Current' | 'Former'; matchCount: number }, now: string): Promise<void>;
  ```

- [ ] **Step 1: Failing tests:**
  - `refreshMatches upserts board rows with source 'board', overwriting person/org/date/amount of an existing row` (bootstrap row for item `1` replaced by board values; `source` becomes `board`).
  - `refreshMatches deletes rejectedIds and keeps rows absent from the read` (rows `1`,`2` present; read stores `1`, rejects `3`, omits `2` → `2` kept, `3` deleted if present).
  - `recordProposal then proposedPairs returns the key`.
  - Batches D1 statements with `db.batch` in chunks of 100 (test 250 rows round-trip).

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** with `INSERT … ON CONFLICT(donation_item_id) DO UPDATE`. **Step 4: Run** — PASS.

- [ ] **Step 5: Commit** `feat(impact-attribution): D1 match history and proposal ledger`.

### Task 4: Monday client

**Files:**
- Create: `impact-attribution/src/monday/client.ts`, `src/monday/client.test.ts`

**Interfaces:**
- Consumes: config types (Task 2), `MatchRow`, `BoardMatchRead` (Tasks 2–3).
- Produces:
  ```ts
  export interface RawMatchItem { id: string; giftType: string | null; matchedBy: { id: string; boardId: string }[]; donor: { id: string; boardId: string }[]; date: string | null; amount: string | null }
  export function parseMatchItem(item: RawMatchItem, cfg: ImpactAttributionConfig): MatchRow | null; // null = not a storable match
  export interface ImpactMondayClient {
    readActiveMatches(cfg: ImpactAttributionConfig): Promise<BoardMatchRead>;
    existingAffiliationPairs(cfg: ImpactAttributionConfig['affiliations']): Promise<Set<string>>; // pairKey for every item, any status
    activeItems(ids: string[]): Promise<Map<string, string>>; // id -> name, only items whose state is 'active'
    createDraft(cfg: ImpactAttributionConfig['affiliations'], d: { name: string; personItemId: string; orgItemId: string; proposedStatus: 'Current' | 'Former' }): Promise<string>;
    postUpdate(itemId: string, body: string): Promise<void>;
  }
  export class HttpMondayClient implements ImpactMondayClient { constructor(apiUrl: string, token: string | TokenProvider, options?: MondayGraphQLOptions) }
  ```

- [ ] **Step 1: Failing tests** (`parseMatchItem` pure; client with a fake `fetch` as in `contact-roles/src/monday/client.test.ts`):
  - `parseMatchItem` returns null for: Gift Type ≠ `Matching Donation`; 0 or 2 Matched By; Donor on the Organizations board; no Donor; no Date; a Matched By not on `organizationsBoardId`. Returns `amountCents` 12345 for `"123.45"`, null for blank.
  - `readActiveMatches` sends `query_params` with Matched By `is_not_empty`, pages via `next_items_page`, puts parsed rows in `stored` and non-null-Matched-By items that parse to null in `rejectedIds`.
  - Linked items read with `... on BoardRelationValue { linked_items { id board { id } } }` (the board id is what classifies Donor).
  - `createDraft` sends Status `{label: 'Draft'}`, Proposed status `{label}`, Person/Organization `{item_ids: [...]}`, and resolves column ids by bare title (a `🔒 Proposed status` column is found).
  - `postUpdate` is sent non-idempotent; `createDraft` too.
  - `activeItems` batches ids in chunks of 100 and drops items with `state` ≠ `active` or missing.

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement**, modeled on `contact-roles/src/monday/client.ts` (`columnByTitle` with type assertion: `board_relation` for links, `status` for statuses, `date`, `numbers`). Transport options `{ maxAttempts: 3, requestTimeoutMs: 30_000 }`. **Step 4: Run** — PASS + typecheck.

- [ ] **Step 5: Commit** `feat(impact-attribution): Monday client for matches and drafts`.

### Task 5: The nightly run

**Files:**
- Create: `impact-attribution/src/run.ts`, `src/run.test.ts`, `src/evidence.ts`, `src/evidence.test.ts`
- Modify: `impact-attribution/src/index.ts` (call `runProposals`)

**Interfaces:**
- Consumes: everything above.
- Produces:
  ```ts
  export function evidenceComment(orgName: string, matches: MatchRow[]): string; // newest first, ≤10 lines, then "and K more"
  export interface RunSummary { matchesRead: number; upserted: number; deleted: number; qualifying: number; skipped: { excluded: number; existing: number; proposed: number; missingItem: number }; proposed: number; failed: number; deferred: number }
  export function runProposals(deps: { monday: ImpactMondayClient; db: D1Database; config: ImpactAttributionConfig; environment: Environment; today: string; now: string }, mode: 'on' | 'off'): Promise<RunSummary>;
  ```

- [ ] **Step 1: Failing tests** (fake `ImpactMondayClient`, real test D1):
  - `evidenceComment` exact text: `Proposed from 3 matching gifts by Acme Corp:\n2026-05-01 $500.00\n2025-11-01 $250.00\n2025-06-01 (no amount)`; 12 matches → 10 lines + `and 2 more`.
  - `on: creates a Draft named "<person> @ <org>", records the proposal, posts the comment`.
  - `on: skips a pair that already has an Affiliation, and one already in proposals`.
  - `on: skips a candidate whose person or org is not active` → `skipped.missingItem` 1, no `createDraft` call. *(Review Focus 3)*
  - `on: createDraft throws → no ledger row, failed 1, next candidate still proposed`.
  - `on: postUpdate throws → ledger row written, run continues`. *(Review Focus 4)*
  - `off: refreshes matches but calls neither createDraft nor postUpdate and writes no proposals`; the logged summary includes a `payers` array of `{ orgItemId, orgName, wouldPropose }`.
  - Log lines contain no person names: assert the fake person name never appears in captured `console.log` output.

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement.** Order: `readActiveMatches` → `refreshMatches` → `allMatches` → `qualifyingPairs` → `existingAffiliationPairs` + `proposedPairs` → `selectCandidates` → `activeItems` for chosen persons+orgs (names come from here) → per candidate (on) create/record/comment, each wrapped in try/catch logging `impact-attribution: proposal <person>/<org> failed: <message>`. Excluded ids from `config.excludedPayers`. One JSON summary line at the end (`{ worker, environment, mode, ...RunSummary }`); under `off` add `payers`. Wire `index.ts`: `today`/`now` from `new Date()`.

- [ ] **Step 4: Run** `npm test && npm run typecheck`, and root `node scripts/check-log-safety.mjs` — PASS.

- [ ] **Step 5: Commit** `feat(impact-attribution): nightly proposal run`.

### Task 6: Bootstrap script from import artifacts

**Files:**
- Create: `impact-attribution/scripts/bootstrap-matches.mjs`, `scripts/bootstrap-matches.test.mjs`, `scripts/fixtures/` (tiny payloads/ledger/boards files)

**Interfaces:**
- Produces: CLI `node scripts/bootstrap-matches.mjs --payloads <payloads.ndjson> --ledger <ledger.ndjson> --boards <boards.json> [--out bootstrap.sql]`; exported `buildRows({ payloads, ledger, boards }) -> { rows, counts }` for the test.

- [ ] **Step 1: Failing `node:test` tests** on fixtures:
  - A `Matching Donation` payload with `Donor` → people-live sfId and `Matched By` → organizations sfId becomes one row with ledger item ids, `match_date` from `columns.Date.date`, `amount_cents` from `columns.Amount` (blank → null).
  - Skipped and counted: non-matching Gift Type; Donor on `organizations`; no Donor; no Matched By; sfId missing from the ledger; no Date.
  - Ledger replay: a later `success` for the same sfId wins.
  - Emitted SQL uses `INSERT OR IGNORE INTO matches … 'bootstrap'` in batches of 500 and contains no names or emails.

- [ ] **Step 2: Run** `npm run test:scripts` — FAIL. **Step 3: Implement**, following `donation-rollups/scripts/bootstrap-links-from-artifacts.mjs`; print counts to stdout. **Step 4: Run** — PASS.

- [ ] **Step 5: Dry check against the real artifacts** (read-only, output to the scratchpad, not the repo): `node scripts/bootstrap-matches.mjs --payloads ../../../../monday-migration/backup/salesforce-import-data-2026-10-31/transform/payloads.ndjson --ledger …/load/ledger.ndjson --boards …/load/boards.json --out <scratchpad>/bootstrap.sql` — Expected: about 2,200 rows (3,067 matching − 831 organization donors − a few unresolved), no error. Do not run it against D1.

- [ ] **Step 6: Commit** `feat(impact-attribution): bootstrap match history from import artifacts`.

### Task 7: The Proposed status column

**Files:**
- Create: `impact-attribution/scripts/add-proposed-status.mjs`, `scripts/add-proposed-status.test.mjs`
- Modify: `scripts/mark-read-only-columns.mjs` (`MARKED_COLUMNS['Affiliations'].locked` gains `'Proposed status'`), `scripts/mark-read-only-columns.test.mjs` if it pins the list, `salesforce-import/src/configure/spec.ts:657` ("Drafts to confirm" columns gain `'Proposed status'` after `'Organization'`)

**Interfaces:**
- Produces: CLI `node scripts/add-proposed-status.mjs --board <affiliations board id> [--apply]` reading `MONDAY_API_TOKEN` from the operator's shell; exported `planColumn(columns) -> { action: 'create' | 'exists' | 'conflict' }`.

- [ ] **Step 1: Failing tests:** `planColumn` returns `exists` for a status column titled `🔒 Proposed status`, `create` when absent, `conflict` when a non-status column has that bare title.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement**: dry run by default; `--apply` creates a `status` column titled `Proposed status` with labels `Current`, `Former` (`defaults` JSON). Import `MondayGraphQL` from `../src/monday/graphql.ts` (strip-only Node). **Step 4: Run** `npm run test:scripts` and the `salesforce-import` + root script tests that cover the edited files — PASS.
- [ ] **Step 5: Commit** `feat(impact-attribution): Proposed status column on Affiliations`.

### Task 8: Docs and operator steps

**Files:**
- Create: `impact-attribution/README.md`
- Modify: root `README.md` ("Status at a glance" row: built, not deployed, ships off), `docs/superpowers/specs/2026-09-08-person-org-email-model-design.md` (one line under the `impact-attribution` heading pointing at the new spec), `benevity-import/README.md:212` (the employer paragraph now points at `impact-attribution`)

- [ ] **Step 1: Write `impact-attribution/README.md`** in the repo's per-Worker shape: The ask, Data flow, the rule, D1 tables, Config, write-switch behaviour, and an **Operator setup** checklist:
  1. `npx wrangler d1 create svbc-impact-attribution` and `…-sandbox`; put the ids in `wrangler.jsonc`.
  2. `npx wrangler d1 migrations apply … --remote` (both).
  3. `node scripts/add-proposed-status.mjs --board 18437342615 --apply` (sandbox), then `18437909787`; then `node scripts/mark-read-only-columns.mjs` for both workspaces; re-run `salesforce-import` configure for the view.
  4. Bootstrap: run the script against the artifacts, `wrangler d1 execute … --remote --file`.
  5. `flags.mjs impact-attribution writes off`, deploy, read the dry-run log.
  6. **Gate:** David reviews the payer summary; fill `excludedPayers`; deploy; one more dry run.
  7. `flags.mjs impact-attribution writes on`.
- [ ] **Step 2: Verify** all tests, typecheck, and root checks (`check-log-safety`, `check-worker-flags --strict`, `check-monday-auth-bindings`, `check-rate-limit-namespaces`) pass.
- [ ] **Step 3: Commit** `docs(impact-attribution): README, status row, cross-links`.
