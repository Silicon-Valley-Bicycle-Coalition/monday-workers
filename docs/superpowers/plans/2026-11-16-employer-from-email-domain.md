# Employer Proposals from Email Domains Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Superseded in part (2026-11-17):** Task 1 (`benevity-import`) shipped as written. Tasks 2–8
> were built as a standalone Worker, then folded into [GL#125](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/125)'s `impact-attribution` Worker as a second
> job; see the design doc's "Folded into [GL#125](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/125)'s Worker" section for what changed. The standalone
> build is on the local branch `backup/124-standalone`.

**Goal:** A daily cron in a new `impact-attribution` Worker proposes `Draft` employer affiliations
from company email domains, and `benevity-import` stops treating unconfirmed affiliations as
evidence.

**Architecture:** Cron-only Worker modelled on `contact-roles` (title-resolved columns, write
switch, `SyncToken`), plus a D1 database (`email_index`, `employer_proposals`) modelled on
`people-reclassification`. Pure modules for the domain map and proposal selection; one Monday
client; one D1 store; one run orchestrator.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, Vitest with `@cloudflare/vitest-plugin`,
Monday GraphQL via the copied `graphql.ts` transport.

**Spec:** `docs/superpowers/specs/2026-11-16-employer-from-email-domain-design.md`

## Global Constraints

- Worker name `impact-attribution`; deployed names `svbc-impact-attribution` /
  `svbc-impact-attribution-sandbox`; write switch key `impact-attribution:writes`.
- Affiliations status labels: `Current`, `Draft`, `Former` (config, not code).
- Proposal item name: `<Person> @ <Organization>`.
- New column `Proposed from` (text) on Affiliations; Work Email is never set on a proposal.
- `maxProposalsPerRun` default `25`.
- Order: Last Gift Date newest first, then people with no gift by item id ascending.
- A Draft must have no effect anywhere until staff set it `Current`.
- `src/flags.ts`, `src/monday/graphql.ts` are byte-identical copies of the canonical files
  (`member-portal/src/flags.ts`, `monday-backup/src/monday/graphql.ts`); never edit the copy.
- Columns found by title through `bareTitle` (`scripts/lib/column-titles.mjs`), never `===`.
- No email address or person name in any `console.*` call (`node scripts/check-log-safety.mjs`).
- Type-check with `npm run typecheck`, never bare `tsc`.
- Never create Cloudflare resources (D1 databases) or Monday columns without asking the user
  first; those are operator steps in Task 8.

## Review Focus

1. **Address formatting:** `" Jane@Google.COM "` must map like `jane@google.com`; an address with
   no `@`, an empty domain or a trailing dot maps to nothing (Task 3 test).
2. **Website column format:** a Monday link column's `text` is not a bare URL; the domain must
   come from the value JSON's `url`, so `https://www.Google.com/about` → `google.com` (Task 5
   test).
3. **Affiliation with an empty Person or Organization link** (half-entered by staff) is ignored
   for the domain map and for skip rules, not a crash (Task 4 test).
4. **Partial failure:** the create succeeds but the D1 ledger write fails. The next run must not
   make a second Draft — the person now has a Draft, so the `hasCurrentOrDraft` rule skips them
   (Task 7 test).
5. **Historical People:** a person on People (Historical) gets a proposal whose Person link
   points at the Historical item, and their Affiliations count for the skip rules (Task 4 and
   Task 5 tests).

---

### Task 1: `benevity-import` counts `Current` affiliations only

**Files:**
- Modify: `benevity-import/src/monday/client.ts` (interface + `HttpMondayClient`)
- Modify: `benevity-import/src/matching/people.ts:41-90`
- Modify: `benevity-import/src/config.ts` (`REQUIRED_AFFILIATIONS_COLUMNS`, new label field)
- Modify: `benevity-import/src/types.ts`, `benevity-import/config/svbc.json`, `benevity-import/config/sandbox.json`
- Test: `benevity-import/src/matching/people.test.ts`, `benevity-import/src/config.test.ts`, `benevity-import/src/monday/client.test.ts` if present

**Interfaces:**
- Produces: `MondayClient.getStatusLabels(itemIds: string[], columnId: string): Promise<Map<string, string | null>>`
  (batched 100 ids per `items(ids:)` call, `limit: 100`, reading `... on StatusValue { label }`
  — follow `getLinkedItemIds`).
- Config: `benevityImport.affiliationsColumns.status` (production `color_mm8na4wv`, sandbox
  `color_mm8h68bj`) and `benevityImport.affiliationsCurrentLabel: "Current"` (required, non-empty).

- [ ] **Step 1: Write the failing tests** in `people.test.ts` (extend `fakeMondayClient` with
  `getStatusLabels: vi.fn().mockResolvedValue(new Map())`, and `fakeConfig` with the two new fields):
  - `ignores a Draft affiliation's Work Email`: `findItemsByColumnValue` returns affiliation
    `a1` for `work_email`, `getStatusLabels` → `{a1: 'Draft'}`, `getLinkedItemIds` → `['p1']`;
    expect `getLinkedItemIds` called with `[]` (or not called) and the result not `resolved` to `p1`.
  - `ignores a Former affiliation's Work Email`: same with `'Former'`.
  - `still resolves on a Current affiliation's Work Email`: `'Current'` → `{ status: 'resolved', personItemId: 'p1' }`.
  - `a Draft affiliation at the organization does not confirm a name match`: name match `p1`,
    affiliation at org `a2` with `'Draft'` → not `resolved` via the affiliation path.
  - In `config.test.ts`: missing `affiliationsColumns.status` or empty `affiliationsCurrentLabel` throws.
- [ ] **Step 2: Run** `cd benevity-import && npm test -- src/matching/people.test.ts src/config.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** Add a private `currentOnly(monday, ids, config): Promise<string[]>`
  in `people.ts` that keeps ids whose label equals `affiliationsCurrentLabel`; apply it to
  `workEmailAffiliations` and `affiliationsAtOrg` before `getLinkedItemIds`. Add
  `getStatusLabels` to the client, the config validation and both JSON files. Update the
  README's person-resolution section (around line 199) to say Current only.
- [ ] **Step 4: Run** `npm test && npm run typecheck` in `benevity-import` — expect PASS.
- [ ] **Step 5: Commit** `fix(benevity-import): count Current affiliations only (GL#124)`.

### Task 2: Scaffold the `impact-attribution` Worker

**Files:**
- Create: `impact-attribution/{package.json,tsconfig.json,vitest.config.ts,wrangler.jsonc}`
- Create: `impact-attribution/src/{index.ts,types.ts,environment.ts,flags.ts,config.ts}`
- Create: `impact-attribution/src/monday/graphql.ts` (copy)
- Create: `impact-attribution/config/{svbc.json,sandbox.json,split.test.ts}`
- Create: `impact-attribution/migrations/0001_create_tables.sql`, `impact-attribution/test/{apply-migrations.ts,env.d.ts}`
- Create: `impact-attribution/src/config.test.ts`
- Modify: `.gitlab-ci.yml` (graphql copy roster line 88; a `.worker_job` and a `deploy-sandbox:` job with `scripts/lib/**/*` in `changes`, as `contact-roles`)
- Modify: `scripts/check-worker-flags.mjs` (`IN_SCOPE`), `scripts/check-monday-auth-bindings.mjs` (`'impact-attribution': 'SyncToken'`)

**Interfaces:**
- Produces (`src/config.ts`):
  ```ts
  export interface PeopleBoardConfig { name: string; boardId: string }
  export interface ImpactAttributionConfig {
    monday: { apiUrl: string };
    peopleBoards: PeopleBoardConfig[];            // live, then Historical
    peopleColumns: { personalEmail: string; householdEmail: string; employerName: string; lastGiftDate: string };
    organizations: { boardId: string; websiteColumn: string };
    affiliations: { boardId: string; personColumn: string; organizationColumn: string; statusColumn: string;
                    workEmailColumn: string; proposedFromColumn: string;
                    labels: { current: string; draft: string; former: string } };
    employerProposals: { consumerDomains: string[]; excludedDomains: string[];
                         domainOverrides: Record<string, string>; maxProposalsPerRun: number };
  }
  export function validateConfig(raw: unknown): ImpactAttributionConfig;
  export const configFor: (env: EnvironmentBindings) => ImpactAttributionConfig;
  ```
  Column values are **bare titles**: `Personal Email`, `Household Email`, `Employer Name`,
  `Last Gift Date`, `Website`, `Person`, `Organization`, `Status`, `Work Email`, `Proposed from`.
  Domains in config are lower-cased by `validateConfig`; `maxProposalsPerRun` a positive integer.
- Board ids — production: People `18437909781`, People (Historical) `18437909784`, Organizations
  `18437909779`, Affiliations `18437909787`. Sandbox v4: `18437342592`, `18437342607`,
  `18437342579`, `18437342615`.
- `consumerDomains` seeded with `DEFAULT_CONSUMER_DOMAINS` from
  `salesforce-import/src/transform/emailKind.ts`; `excludedDomains: []`; `domainOverrides: {}`.
- `src/types.ts`: `interface Env { FLAGS: KVNamespace; DB: D1Database; MONDAY_AUTH: Fetcher-with-SyncToken (as contact-roles); ENVIRONMENT?: string }`.
- Migration `0001_create_tables.sql`:
  ```sql
  CREATE TABLE email_index (
    address TEXT PRIMARY KEY,           -- lower-cased
    kind TEXT NOT NULL CHECK (kind IN ('personal','household','work')),
    person_item_ids TEXT NOT NULL,      -- JSON array
    affiliation_item_id TEXT            -- set for kind = 'work'
  );
  CREATE TABLE employer_proposals (
    person_item_id TEXT NOT NULL,
    organization_item_id TEXT NOT NULL,
    affiliation_item_id TEXT NOT NULL,
    domain TEXT NOT NULL,
    proposed_at TEXT NOT NULL,          -- ISO
    PRIMARY KEY (person_item_id, organization_item_id)
  );
  ```
- `wrangler.jsonc`: copy `contact-roles`' shape (FLAGS ids, `SyncToken` service, sandbox env)
  plus `d1_databases` binding `DB` (`svbc-impact-attribution` / `-sandbox`, `migrations_dir:
  "migrations"`, `database_id` placeholder `"TODO-create-in-task-8"`), `limits.cpu_ms: 30000`,
  cron `"0 13 * * *"` in both envs. Copy `vitest.config.ts` and `test/apply-migrations.ts` from
  `people-reclassification`.
- `src/index.ts` for now: `fetch` → 404, `scheduled` → no-op (Task 7 fills it).

- [ ] **Step 1: Write failing tests**: `config.test.ts` — both JSON files validate; a missing
  column title, an empty `labels.draft`, `maxProposalsPerRun: 0` each throw; domains come back
  lower-cased. `config/split.test.ts` — no board id shared between production and sandbox;
  production Affiliations is `18437909787`, sandbox `18437342615`.
- [ ] **Step 2: Run** `cd impact-attribution && npm install && npm test` — expect FAIL.
- [ ] **Step 3: Implement** the files above; copy `flags.ts`, `graphql.ts`, `environment.ts`
  byte-for-byte (`cp`, not retyping).
- [ ] **Step 4: Run** `npm test && npm run typecheck`, then from the repo root
  `node scripts/check-worker-flags.mjs --strict && node scripts/check-monday-auth-bindings.mjs && node scripts/check-rate-limit-namespaces.mjs`,
  and `diff monday-backup/src/monday/graphql.ts impact-attribution/src/monday/graphql.ts` — all clean.
- [ ] **Step 5: Commit** `feat(impact-attribution): scaffold cron Worker with config and D1 schema (GL#124)`.

### Task 3: Domain map

**Files:**
- Create: `impact-attribution/src/employers/domains.ts`, `impact-attribution/src/employers/domains.test.ts`

**Interfaces:**
- Consumes: `OrganizationRecord`, `AffiliationRecord` (defined here, re-used by Tasks 4–5):
  ```ts
  export interface OrganizationRecord { itemId: string; name: string; websiteUrl: string | null }
  export interface AffiliationRecord { itemId: string; personIds: string[]; organizationIds: string[];
                                       status: string | null; workEmail: string | null }
  ```
- Produces:
  ```ts
  export type MapSource = 'override' | 'Work Email match' | 'Website match';
  export interface DomainMap { mapped: Map<string, { organizationId: string; source: MapSource }>; ambiguous: Set<string> }
  export function emailDomain(address: string | null): string | null;
  export function websiteDomain(url: string | null): string | null;   // copy of salesforce-import's
  export function buildDomainMap(orgs: OrganizationRecord[], affiliations: AffiliationRecord[],
    opts: { currentLabel: string; overrides: Record<string, string> }): DomainMap;
  export type DomainLookup = { kind: 'mapped'; domain: string; organizationId: string; source: MapSource }
                           | { kind: 'ambiguous' } | { kind: 'none' };
  export function lookupDomain(map: DomainMap, domain: string | null,
    blocked: ReadonlySet<string> /* consumer ∪ excluded */): DomainLookup;
  ```
- `lookupDomain` walks from the full domain up one label at a time (`a.cs.stanford.edu`,
  `cs.stanford.edu`, `stanford.edu`; stop before a single label). At each candidate, in order:
  in `blocked` → `none`; in `mapped` → `mapped` (with that candidate as `domain`); in
  `ambiguous` → `ambiguous`. First hit wins; nothing hit → `none`.
- `buildDomainMap`: Work Emails only from affiliations whose status is `currentLabel` and that
  link exactly one organization; Website domains from every organization. A domain whose sources
  name more than one organization (within or across sources) is `ambiguous`; one that both
  sources agree on gets `'Work Email match'`. Overrides are applied last and win over both
  (removing the domain from `ambiguous`).

- [ ] **Step 1: Write failing tests** (one `it` each):
  - `emailDomain(' Jane@Google.COM ')` → `'google.com'`; `'nobody'`, `'a@'`, `'a@google.com.'` → `null`.
  - `websiteDomain('https://www.Google.com/about')` → `'google.com'`; `null`/`''` → `null`.
  - Work-Email source: Current affiliation `jo@acme.example` → org `o1` maps `acme.example` with `'Work Email match'`; the same at status `Draft` contributes nothing.
  - Website source maps with `'Website match'`.
  - Two orgs with the same website → `ambiguous`; Work Email says `o1`, website says `o2` → `ambiguous`.
  - Override `{ 'acme.example': 'o3' }` beats an ambiguous domain → mapped `o3`, `'override'`.
  - Affiliation with empty `organizationIds` or two orgs is ignored.
  - `lookupDomain`: `cs.stanford.edu` → mapped via `stanford.edu`; `alumni.stanford.edu` with it in `blocked` → `none` while `cs.stanford.edu` still maps; `gmail.com` in `blocked` → `none` even if mapped.
- [ ] **Step 2: Run** `npm test -- src/employers/domains.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** per the interfaces above.
- [ ] **Step 4: Run** the same command — expect PASS.
- [ ] **Step 5: Commit** `feat(impact-attribution): build the domain → organization map (GL#124)`.

### Task 4: Proposal selection

**Files:**
- Create: `impact-attribution/src/employers/proposals.ts`, `impact-attribution/src/employers/proposals.test.ts`

**Interfaces:**
- Consumes: Task 3's types and `lookupDomain`.
- Produces:
  ```ts
  export interface PersonRecord { itemId: string; boardId: string; name: string;
    personalEmail: string | null; householdEmail: string | null;
    employerName: string | null; lastGiftDate: string | null /* YYYY-MM-DD */ }
  export interface Proposal { person: PersonRecord; organizationId: string; organizationName: string;
    domain: string; proposedFrom: string }
  export type SkipReason = 'hasCurrentOrDraft' | 'formerAtOrg' | 'alreadyProposed' | 'twoEmployers' | 'ambiguousDomain';
  export interface Selection { proposals: Proposal[]; deferred: number; skipped: Record<SkipReason, number> }
  export function pairKey(personId: string, organizationId: string): string;   // `${p}:${o}`
  export function selectProposals(input: {
    people: PersonRecord[]; affiliations: AffiliationRecord[]; organizations: OrganizationRecord[];
    domainMap: DomainMap; blocked: ReadonlySet<string>; proposedPairs: ReadonlySet<string>;
    labels: { current: string; draft: string; former: string }; cap: number;
  }): Selection;
  ```
- Per person: look up both addresses. Both `none` → not counted. Any `ambiguous` and no
  `mapped` → `ambiguousDomain`. Two `mapped` to different orgs → `twoEmployers`. Then, in this
  order: any affiliation linking the person with status `current` or `draft` →
  `hasCurrentOrDraft`; a `former` affiliation at that org → `formerAtOrg`; pair in
  `proposedPairs` → `alreadyProposed`. Otherwise eligible.
- Sort eligible by `lastGiftDate` descending, `null` last, ties and nulls by numeric `itemId`
  ascending; take `cap`; `deferred` = the rest.
- `proposedFrom` exact format:
  `Email domain <domain> (<Personal Email|Household Email>; <source>).` followed, when
  `employerName` is non-empty, by ` Salesforce employer: <employerName>.`
  (when both addresses map to the same org, name `Personal Email`).

- [ ] **Step 1: Write failing tests:**
  - Happy path: one person `jo@acme.example`, no affiliations → one proposal for `o1` with
    `proposedFrom === 'Email domain acme.example (Personal Email; Website match).'`.
  - Employer Name `'Acme Inc'` appends ` Salesforce employer: Acme Inc.`.
  - Each skip reason, one test each, asserting `skipped[reason] === 1` and no proposal; the
    `hasCurrentOrDraft` test uses a Draft whose organization is a *different* org.
  - Affiliation with empty `personIds` doesn't count for anyone.
  - Person on the Historical board (`boardId: '18437909784'`) is proposed, with `person.boardId` kept.
  - Household Email only → `(Household Email; …)`.
  - Order and cap: 30 eligible people, gift dates on 25 of them, cap 25 → the 25 dated people in
    newest-first order; `deferred === 5`.
- [ ] **Step 2: Run** `npm test -- src/employers/proposals.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(impact-attribution): select employer proposals (GL#124)`.

### Task 5: Monday client

**Files:**
- Create: `impact-attribution/src/monday/client.ts`, `impact-attribution/src/monday/client.test.ts`, `impact-attribution/test/fakeMonday.ts` (start from `contact-roles/test/fakeMonday.ts`)

**Interfaces:**
- Consumes: config (Task 2), records (Tasks 3–4).
- Produces:
  ```ts
  export interface AttributionMondayClient {
    listPeople(board: PeopleBoardConfig, cols: ImpactAttributionConfig['peopleColumns']): Promise<PersonRecord[]>;
    listOrganizations(cfg: ImpactAttributionConfig['organizations']): Promise<OrganizationRecord[]>;
    listAffiliations(cfg: ImpactAttributionConfig['affiliations']): Promise<AffiliationRecord[]>;
    createAffiliation(cfg: ImpactAttributionConfig['affiliations'], p: {
      name: string; personId: string; organizationId: string; proposedFrom: string }): Promise<string>; // new item id
  }
  export class HttpMondayClient implements AttributionMondayClient { constructor(apiUrl: string, token: TokenProvider, fetchFn?: typeof fetch) }
  ```
- Follow `contact-roles/src/monday/client.ts`: resolve titles once per board via `bareTitle`
  (throw a `ColumnLookupError` naming the board and title when missing), page with
  `items_page(limit: 500)` / `next_items_page`. Email columns: the value's `email`, lower-cased.
  Website: the link value JSON's `url`. Date: the value's `date`. Status: `label`. Board
  relations: `linked_item_ids`. `createAffiliation` sets Person and Organization links, Status
  by label (`{ label: draft }`), and `Proposed from` text; Work Email is left untouched.
  Transport options as `contact-roles` (cron Worker).

- [ ] **Step 1: Write failing tests** against `FakeMonday`:
  - `listPeople` returns lower-cased emails, `lastGiftDate`, `employerName`, and the board id.
  - `listOrganizations` turns a link value `{"url":"https://www.Google.com/about","text":"Google"}` into `websiteUrl` `https://www.Google.com/about` (the raw url, not the text).
  - Titles marked `🔒 Proposed from` / `📜 Work Email` resolve; a missing title throws naming it.
  - `createAffiliation` sends exactly Person, Organization, Status `Draft`, Proposed from, and no Work Email key; it accepts a Historical People item id.
  - Paging: 1,200 items across three pages all come back.
- [ ] **Step 2: Run** `npm test -- src/monday/client.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(impact-attribution): Monday client for People, Organizations, Affiliations (GL#124)`.

### Task 6: D1 store

**Files:**
- Create: `impact-attribution/src/store.ts`, `impact-attribution/src/store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface EmailIndexRow { address: string; kind: 'personal' | 'household' | 'work';
                                   personItemIds: string[]; affiliationItemId: string | null }
  export function emailIndexRows(people: PersonRecord[], affiliations: AffiliationRecord[]): EmailIndexRow[];
  export async function rebuildEmailIndex(db: D1Database, rows: EmailIndexRow[]): Promise<void>;
  export async function readProposedPairs(db: D1Database): Promise<Set<string>>;  // pairKey values
  export async function recordProposal(db: D1Database, row: { personItemId: string; organizationItemId: string;
    affiliationItemId: string; domain: string; proposedAt: string }): Promise<void>;
  ```
- `emailIndexRows`: personal and household rows from People (an address on several people →
  one row listing all of them; an address that is both someone's personal and another's
  household → `personal`), work rows from every affiliation with a Work Email (work wins over
  personal/household for the same address). `rebuildEmailIndex` runs `DELETE FROM email_index`
  and the inserts in one `db.batch`, inserting multi-row statements of at most 25 rows (D1's
  100-bound-parameter limit ÷ 4 columns).
- `recordProposal` uses `INSERT OR IGNORE`.

- [ ] **Step 1: Write failing tests** (D1 via `cloudflare:workers` `env.DB`):
  - A household address on two people → one row, `personItemIds` both.
  - A work address → `kind: 'work'` with its affiliation id.
  - Rebuild replaces: rows from a first rebuild absent from the second are gone.
  - 1,000 rows rebuild without error.
  - `recordProposal` then `readProposedPairs` contains `pairKey(p, o)`; recording twice doesn't throw.
- [ ] **Step 2: Run** `npm test -- src/store.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(impact-attribution): D1 email index and proposal ledger (GL#124)`.

### Task 7: The daily run

**Files:**
- Create: `impact-attribution/src/employers/run.ts`, `impact-attribution/src/employers/run.test.ts`
- Modify: `impact-attribution/src/index.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  ```ts
  export interface RunSummary { mode: 'on' | 'off'; people: number; proposalsCreated: number; wouldCreate: number;
    createFailures: number; deferred: number; skipped: Record<SkipReason, number>; ambiguousDomains: number }
  export async function runEmployerProposals(deps: { monday: AttributionMondayClient; db: D1Database;
    config: ImpactAttributionConfig; now: () => Date; environment: Environment }, mode: 'on' | 'off'): Promise<RunSummary>;
  ```
- Steps: read all boards (people from each `peopleBoards` entry); if total people is 0 or
  organizations is 0, throw `Error('read returned no People/Organizations; aborting')` before
  any write. Rebuild `email_index` (in both modes — it's SVBC-internal state, not a Monday
  write). Build the map, `readProposedPairs`, `selectProposals`. Mode `off`: create nothing,
  record nothing, `wouldCreate = proposals.length`. Mode `on`: for each proposal, create
  (name `${person.name} @ ${organizationName}`), then `recordProposal`; a create that throws is
  counted in `createFailures` and not recorded; a `recordProposal` that throws is logged and the
  run continues. Log one JSON summary line (counts only, no names or addresses).
- `index.ts` `scheduled`: same shape as `contact-roles` (`readWriteMode`, `runDisposition`, skip
  log), `WORKER = 'impact-attribution'`, `HttpMondayClient` with `tokenProviderFor(env)`.

- [ ] **Step 1: Write failing tests** with a fake `AttributionMondayClient`:
  - `on`: two eligible people → two `createAffiliation` calls named `Jo Doe @ Acme`, two ledger rows; a second run with the same data creates nothing (ledger + Draft).
  - `off`: `wouldCreate === 2`, no creates, no ledger rows; `email_index` populated.
  - A failing create: not in the ledger, `createFailures === 1`; next run (Draft not on the board) proposes it again.
  - Ledger write fails after a successful create: next run, with the new Draft on the board, creates nothing (Review Focus 4).
  - Zero People read → throws, no creates, `email_index` untouched.
  - A deleted Draft (ledger row present, item gone) is not re-proposed; one set to `Former` is not either.
  - Log safety: spy on `console.log`; no logged string contains `@`.
- [ ] **Step 2: Run** `npm test -- src/employers/run.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** `run.ts` and wire `index.ts`.
- [ ] **Step 4: Run** `npm test && npm run typecheck` and from the root `node scripts/check-log-safety.mjs` — expect PASS.
- [ ] **Step 5: Commit** `feat(impact-attribution): daily employer proposal run (GL#124)`.

### Task 8: Docs, read-only marker and operator runbook

**Files:**
- Create: `impact-attribution/README.md`, `docs/runbooks/employer-proposals.md`
- Modify: `scripts/mark-read-only-columns.mjs` (`MARKED_COLUMNS`: Affiliations `Proposed from`, 🔒) and its test
- Modify: root `README.md` (Status at a glance row), `CLAUDE.md` if it enumerates Workers by name
- Modify: `docs/superpowers/specs/2026-09-08-person-org-email-model-design.md` (one line under the resolver: "first slice built: 2026-11-16 employer proposals spec")

- [ ] **Step 1:** Add `Proposed from` to `MARKED_COLUMNS`; extend its test; run `node --test scripts/mark-read-only-columns.test.mjs` — PASS.
- [ ] **Step 2:** Write the Worker README (ask, data flow, Monday targets, config, write switch behavior under on/off/hold, D1 tables) and the runbook, in this order:
  1. Deploy `benevity-import` (Task 1) and confirm a Benevity upload still resolves.
  2. Create D1 databases `svbc-impact-attribution` and `-sandbox` (`npx wrangler d1 create …`), put their ids in `wrangler.jsonc`, apply migrations (`npx wrangler d1 migrations apply … --remote`).
  3. Create the `Proposed from` text column on both Affiliations boards; run `scripts/mark-read-only-columns.mjs`; add the column to the **Drafts to confirm** view; hide it on any Affiliations form.
  4. `node scripts/flags.mjs impact-attribution writes off --env sandbox`, deploy sandbox, read one run's summary; then `on` and check a Draft appears and confirming it sets Employer Name.
  5. Production: `writes off` first, deploy, read the summary (eligible count, `deferred`, ambiguous domains → overrides/exclusions), then `writes on`.
- [ ] **Step 3:** Run every Worker test touched (`benevity-import`, `impact-attribution`) and the root `node scripts/check-*.mjs` checks — all PASS.
- [ ] **Step 4: Commit** `docs(impact-attribution): README, runbook, read-only marker (GL#124)`.
- [ ] **Step 5: Ask the user** before steps 2–5 of the runbook (they create Cloudflare and Monday resources); do not run them unasked.
