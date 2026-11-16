# Organization Contact Roles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show, on each opportunity board, a read-only `Contacts` column listing every current contact at the item's organization whose confirmed role matches the board, kept current by a new `contact-roles` Worker.

**Architecture:** A stateless, cron-polled Worker (no D1, no queue). Each run reads the confirmed roles from Affiliations, reads each configured board's items, computes the desired people per item, and writes only the items whose `Contacts` differ (idempotent, so a missed run self-heals). Roles are a dropdown on Affiliations; a one-time backfill script proposes roles into a separate `Proposed Roles` column for staff to confirm.

**Tech Stack:** TypeScript (strip-only), Cloudflare Workers + Wrangler, Vitest, the shared Monday `graphql.ts` transport, the `monday-auth` broker (`SyncToken`), `.mjs` operator scripts with `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-11-organization-contact-roles-design.md`

## Global Constraints

- Worker dir `contact-roles/`, deployed name `svbc-contact-roles`, sandbox `svbc-contact-roles-sandbox`, write switch `contact-roles:writes` in the `FLAGS` KV (`sandbox-FLAGS` in sandbox).
- `contact-roles/src/flags.ts` is a byte-identical copy of `member-portal/src/flags.ts`; `contact-roles/src/monday/graphql.ts` a byte-identical copy of `monday-backup/src/monday/graphql.ts`. Never edit a copy. Both stay strip-only TypeScript.
- Monday access only via the `MONDAY_AUTH` service binding, entrypoint `SyncToken` (`svbc-monday-auth`; sandbox `svbc-monday-auth-sandbox`). No `MONDAY_API_TOKEN` secret.
- Board ids, column titles and role names live in `config/svbc.json` and `config/sandbox.json`, validated at startup; no SVBC ids in source. A `config/split.test.ts` fails if the two configs share an id.
- Column titles are matched with `bareTitle` from `scripts/lib/column-titles.mjs`, never `===`. The new `Contacts` column is added to `MARKED_COLUMNS` as locked (🔒).
- No `console.*` that could log an email address (`scripts/check-log-safety.mjs`). Log ids and counts only.
- Write modes: `on` writes; `off` computes and logs but writes nothing; `hold`/`unknown` skip the run. Read the mode once per run.
- Production Affiliations `18437909787`, People `18437909781`, Organizations `18437909779`. Sandbox v4: Affiliations `18437342615`, People `18437342592`, Organizations `18437342579`. Sandbox first; nothing runs against production in this plan's tasks 1-6.
- Seed roles: `Sponsorship`, `Grants`, `Bike Parking`, `Donation Matching`, `Classes`. Affiliations `Status` labels: `Current`, `Former`, `Draft`. Only `Current` counts.
- No real PII committed; fixtures use fake ids.

## Review Focus

- A person with a `Proposed Roles` label but no confirmed `SVBC Roles` label must never appear in `Contacts`.
- A `Former` or `Draft` affiliation holding the role must never appear in `Contacts`.
- An item with an empty organization link gets an empty `Contacts` (not an error, and no write if already empty).
- A board configured with a role label that is missing from the dropdown is skipped loudly and its `Contacts` is left untouched (never blanked).
- A Leads item whose Type has no mapped role (e.g. "contract") gets an empty `Contacts`; a missing Type likewise.
- Re-running with no change makes zero writes; a person holding two roles at one organization appears once; person order is stable so reruns do not churn.
- A staff-added dropdown label that no board uses changes nothing and breaks nothing.

---

### Task 1: Scaffold the Worker and register it in the shared checks

**Files:**
- Create: `contact-roles/package.json`, `contact-roles/tsconfig.json`, `contact-roles/vitest.config.ts`, `contact-roles/wrangler.jsonc`, `contact-roles/src/index.ts`, `contact-roles/src/types.ts`, `contact-roles/src/environment.ts`, `contact-roles/src/flags.ts`, `contact-roles/src/monday/graphql.ts`, `contact-roles/test/env.d.ts`
- Modify: `scripts/check-worker-flags.mjs` (`IN_SCOPE`), `scripts/check-monday-auth-bindings.mjs` (mapping, add `'contact-roles': 'SyncToken'`), `scripts/flags.mjs` (`QUEUES`, add `'contact-roles': []`), `.gitlab-ci.yml` (the `for copy in …` graphql roster; add a `contact-roles` job and a `deploy-sandbox:contact-roles` job modelled on `people-reclassification`, with `scripts/lib/**/*` in the rules)

**Interfaces:**
- Produces: `Env` in `src/types.ts` (`DB` absent) with `FLAGS: KVNamespace`, `MONDAY_AUTH: Fetcher`, `ENVIRONMENT?: string`; `environmentOf` / `createConfigSelector` copied from `people-reclassification/src/environment.ts`; default export `{ fetch, scheduled }`.

- [ ] **Step 1: Write the failing check.** Run `node scripts/check-worker-flags.mjs --strict` and `node scripts/check-monday-auth-bindings.mjs` after adding `contact-roles` to the two rosters (before creating the files) and confirm both FAIL naming `contact-roles`.
- [ ] **Step 2: Create the Worker skeleton by copying the reference.** Copy `people-reclassification/{package.json,tsconfig.json,vitest.config.ts,test/env.d.ts,src/environment.ts}`; rename to `contact-roles`. Copy `member-portal/src/flags.ts` → `contact-roles/src/flags.ts` and `monday-backup/src/monday/graphql.ts` → `contact-roles/src/monday/graphql.ts` verbatim (`cp`). `wrangler.jsonc`: name `svbc-contact-roles`, FLAGS KV id `1dec1f10ebcc41e7a464179ba2b37628` (prod) / `a80c21a348064e07bb9c1bff16bee1a4` (sandbox), cron `*/10 * * * *`, `limits.cpu_ms` 1000, `MONDAY_AUTH` service with entrypoint `SyncToken`, an `env.sandbox` block restating everything non-inheritable (name, vars `ENVIRONMENT=sandbox`, KV, cron, limits, services); no `routes`, no `ratelimits` (no HTTP surface). `index.ts` exports `fetch` returning 404 and a `scheduled` that logs and returns (real body in Task 5).
- [ ] **Step 3: Run the checks.** `node scripts/check-worker-flags.mjs --strict`, `node scripts/check-monday-auth-bindings.mjs`, and the CI copy loop's `cmp` for the two new copies. Expected: all PASS.
- [ ] **Step 4: Typecheck.** `cd contact-roles && npm install && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(contact-roles): scaffold Worker and register in shared checks`.

### Task 2: Config and its validation

**Files:**
- Create: `contact-roles/config/svbc.json`, `contact-roles/config/sandbox.json`, `contact-roles/config/split.test.ts`, `contact-roles/src/config.ts`, `contact-roles/src/config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface BoardRule {
    name: string;                 // for logs only, e.g. 'Sponsorships'
    boardId: string;
    orgColumn: string;            // bare title of the organization link, e.g. 'Organization'
    contactsColumn: string;       // bare title, 'Contacts'
    role?: string;                // fixed role label; absent when typeColumn is used
    typeColumn?: string;          // Leads: bare title of the Type column
    typeRoles?: Record<string, string>; // Type label -> role label
    enabled: boolean;
  }
  export interface ContactRolesConfig {
    monday: { apiUrl: string };
    affiliations: { boardId: string; rolesColumn: string; statusColumn: string; personColumn: string; orgColumn: string; currentLabel: string };
    boards: BoardRule[];
  }
  export function validateConfig(raw: unknown): ContactRolesConfig;
  ```
- Consumes: `createConfigSelector` from Task 1.

- [ ] **Step 1: Write failing tests** in `src/config.test.ts`: `validateConfig` throws on each of: missing `boards`; a rule with neither `role` nor `typeColumn+typeRoles`; a rule with both; duplicate `boardId`; empty `affiliations.boardId`. It accepts both real config files. `split.test.ts` asserts no board id, affiliations id appears in both files (model on `people-reclassification/config/split.test.ts`).
- [ ] **Step 2: Run** `cd contact-roles && npm test -- src/config.test.ts config/split.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `validateConfig` in `src/config.ts` (hand-written checks like the reference's `config.ts`). Fill `svbc.json` per the spec's mapping table: Sponsorships `18391037433`/`Organization`/`Sponsorship`; Grants & Contracts `7896177072`/`Funder`/`Grants`; BP Request Form `18395469629`/`Host Organization`/`Bike Parking`; Donations (board id looked up from the production workspace; org column `Matched By`)/`Donation Matching`; Bike Education Lifecycle Tracker `18433254640`/(its organization link, found by reading the board)/`Classes`; Leads `8531259839` with `enabled: false`, `typeColumn: "Type"`, `typeRoles: {"Sponsorship":"Sponsorship","Grant":"Grants"}`. `sandbox.json` mirrors it with the CRM Sandbox v4 board ids (read from `monday-migration/config` or the sandbox workspace); every board starts `enabled: true` except Leads.
- [ ] **Step 4: Run the same tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(contact-roles): add validated per-environment config`.

### Task 3: The pure role-matching core

**Files:**
- Create: `contact-roles/src/contacts.ts`, `contact-roles/src/contacts.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Affiliation { id: string; personId: string; orgId: string; status: string; roles: string[] }
  export type AffiliationIndex = Map<string, Affiliation[]>; // orgId -> affiliations
  export interface BoardItem { id: string; orgIds: string[]; typeLabel: string | null; currentPersonIds: string[] }
  export function buildIndex(affiliations: Affiliation[], currentLabel: string): AffiliationIndex; // keeps only status === currentLabel
  export function roleFor(rule: BoardRule, item: BoardItem): string | null; // fixed role, or typeRoles[typeLabel], else null
  export function contactsFor(rule: BoardRule, item: BoardItem, index: AffiliationIndex): string[]; // unique person ids, sorted
  export interface ContactUpdate { itemId: string; personIds: string[] }
  export function planBoard(rule: BoardRule, items: BoardItem[], index: AffiliationIndex): ContactUpdate[]; // only items whose sorted currentPersonIds differ
  ```
- Consumes: `BoardRule` from Task 2.

- [ ] **Step 1: Write failing tests** (one `it` each, fake ids, in `contacts.test.ts`): (a) `buildIndex` drops `Former` and `Draft` affiliations; (b) `contactsFor` returns only people whose `roles` include the board role at the item's org(s); (c) a person with two roles at one org appears once; (d) result is sorted and stable across input order; (e) empty `orgIds` → `[]`; (f) Leads rule: `typeLabel:'Grant'` → Grants contacts, `'Contract'` and `null` → `[]`; (g) `planBoard` returns no update when `currentPersonIds` already equals the desired set in any order; (h) an item at two organizations unions both orgs' contacts.
- [ ] **Step 2: Run** `npm test -- src/contacts.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the five functions in `src/contacts.ts`. Pure; no I/O.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(contact-roles): add role-matching core`.

### Task 4: Monday client (read affiliations and items, write contacts)

**Files:**
- Create: `contact-roles/src/monday/client.ts`, `contact-roles/src/monday/client.test.ts`, `contact-roles/test/fakeMonday.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ContactRolesMondayClient {
    roleLabels(cfg: ContactRolesConfig['affiliations']): Promise<string[]>;          // SVBC Roles dropdown labels
    listAffiliations(cfg: ContactRolesConfig['affiliations']): Promise<Affiliation[]>; // only items with non-empty SVBC Roles
    listBoardItems(rule: BoardRule): Promise<BoardItem[]>;                           // paged; for the Donations rule, only items with `Matched By` set (step 3)
    setContacts(rule: BoardRule, itemId: string, personIds: string[]): Promise<void>; // change_multiple_column_values on the resolved Contacts column
  }
  export class HttpMondayClient implements ContactRolesMondayClient {
    constructor(apiUrl: string, token: TokenProvider);
  }
  ```
- Consumes: `MondayGraphQL` and `tokenProviderFor` from `src/monday/graphql.ts` (use as `people-reclassification/src/monday/client.ts` does), `bareTitle` for every title lookup, types from Tasks 2-3.

- [ ] **Step 1: Write failing tests** against `test/fakeMonday.ts` (an in-memory GraphQL responder in the style of `people-reclassification/test/fakeMonday.ts`): `listAffiliations` maps a board-relation `Person`/`Organization` value to ids and a dropdown `SVBC Roles` value to label strings; it finds columns when titles carry 🔒/📜 markers; `listBoardItems` pages through a cursor; `setContacts` sends the connect-boards value `{"item_ids":[…]}` for the resolved column id.
- [ ] **Step 2: Run** `npm test -- src/monday/client.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `HttpMondayClient`.** Resolve column ids once per board by `bareTitle` (throw a typed `ColumnLookupError` naming the title and board if missing, as `people-reclassification/src/columns.ts` does). For the Donations rule, filter the page query to items whose `Matched By` is not empty (`query_params` rules) so a reconcile does not read the whole board; other boards read all items. Verify first that `Matched By` is a board relation (design's "Calls made"); if it is not, stop and report rather than name-matching.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(contact-roles): add Monday client for affiliations, boards and contacts`.

### Task 5: The reconcile run and the scheduled handler

**Files:**
- Create: `contact-roles/src/reconcile.ts`, `contact-roles/src/reconcile.test.ts`
- Modify: `contact-roles/src/index.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RunDeps { monday: ContactRolesMondayClient; config: ContactRolesConfig }
  export interface RunSummary { mode: 'on' | 'off'; boards: { name: string; skipped?: 'disabled' | 'unknown-role'; items: number; updates: number; written: number }[] }
  export async function runReconcile(deps: RunDeps, mode: 'on' | 'off'): Promise<RunSummary>;
  ```
- Consumes: `planBoard`, `buildIndex`, `roleFor` (Task 3); client (Task 4); `readWriteMode`, `runDisposition`, `readLogLevel` from `src/flags.ts`.

- [ ] **Step 1: Write failing tests** with `fakeMonday`: (a) mode `on` writes each planned update once and a second run writes nothing; (b) mode `off` writes nothing but reports `updates` > 0; (c) a board whose role is absent from `roleLabels()` is `skipped: 'unknown-role'`, logs, and none of its items are written; (d) a disabled board is `skipped: 'disabled'`; (e) a Former affiliation or a Proposed-only person is never written; (f) one board's Monday error does not stop the other boards (the failed board is logged and the run continues); (g) a new dropdown label no board uses changes nothing.
- [ ] **Step 2: Run** `npm test -- src/reconcile.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `runReconcile`** (read `roleLabels` and `listAffiliations` once, `buildIndex`, then per enabled board `listBoardItems` → `planBoard` → `setContacts` per update when `mode === 'on'`; log counts only). In `index.ts` `scheduled()`: `readWriteMode(env, 'contact-roles')`, `runDisposition`, skip on `hold`/`unknown` with the same log shape as `people-reclassification/src/index.ts`, otherwise `runReconcile(deps, disposition === 'run' ? 'on' : 'off')`.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(contact-roles): reconcile Contacts on a cron under the write switch`.

### Task 6: Provision the columns and mark them read-only

**Files:**
- Create: `contact-roles/scripts/provision-contact-roles.mjs`, `contact-roles/scripts/provision-contact-roles.test.mjs`
- Modify: `scripts/mark-read-only-columns.mjs` (add `Contacts` as locked on Sponsorships, Grants & Contracts, BP Request Form, Donations, Bike Education Lifecycle Tracker, Leads), `scripts/mark-read-only-columns.test.mjs`

**Interfaces:**
- Produces: `planProvision(boards: { id: string; name: string; columns: {id:string;title:string;type:string}[] }[], spec): { creates: { boardId: string; title: string; type: 'dropdown' | 'board_relation'; settings: object }[]; skipped: string[] }`, pure and tested; the CLI wraps it with dry-run default and `--execute`, `--env sandbox|production`.

- [ ] **Step 1: Write failing tests:** `planProvision` creates `SVBC Roles` and `Proposed Roles` dropdowns (labels = the five seed roles) on Affiliations; creates a one-way `Contacts` connect column to People on each configured board, matching existing columns by `bareTitle` so a marked `🔒 Contacts` is not duplicated; is idempotent (second plan is empty). The marker test asserts `Contacts` is in the locked list for the six boards.
- [ ] **Step 2: Run** `node --test contact-roles/scripts/provision-contact-roles.test.mjs scripts/mark-read-only-columns.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** `planProvision` and the CLI (use the Worker's own `src/monday/graphql.ts` import per `CLAUDE.md`; read the token from the operator's shell like `check-donation-form.mjs`). The CLI prints UI-only steps it cannot do: create the `Roles to confirm` view (filter `Proposed Roles` is not empty) on Affiliations, and hide `Contacts` on the staff "Enter a gift" form followed by `node scripts/check-donation-form.mjs --form <token>`.
- [ ] **Step 4: Run** the tests. Expected: PASS. Then run the CLI against sandbox (`--env sandbox`, dry run), review the plan, run `--execute`, run `node scripts/mark-read-only-columns.mjs` for the marker, and confirm a second dry run is empty.
- [ ] **Step 5: Commit** `feat(contact-roles): provision role columns and mark Contacts read-only`.

### Task 7: Backfill proposed roles from existing data

**Files:**
- Create: `contact-roles/scripts/backfill-proposed-roles.mjs`, `contact-roles/scripts/backfill-lib.mjs`, `contact-roles/scripts/backfill-lib.test.mjs`

**Interfaces:**
- Produces: `planProposals({ affiliations: Affiliation[], sources: { role: string; orgId: string; personId: string; from: string }[] }): { proposals: { affiliationId: string; role: string; from: string }[]; reported: { reason: 'no-affiliation' | 'draft-or-former' | 'no-person-link'; role: string; from: string }[] }`; CLI default dry run, `--execute` writes `Proposed Roles` only, `--env`.
- Consumes: `Affiliation` shape from Task 3 (re-declared in JS via JSDoc or imported through type stripping).

- [ ] **Step 1: Write failing tests** for `planProposals`: a `Sponsor Contact`-checked affiliation proposes `Sponsorship`; a source person with a `Current` affiliation at the organization proposes the role on that affiliation; a person whose only affiliation there is Draft or Former is `reported: 'draft-or-former'`; a person with none is `reported: 'no-affiliation'`; a source with no People link (text-only contact) is `reported: 'no-person-link'`; an already-proposed or already-confirmed role is not proposed again; the function never emits anything for `SVBC Roles`.
- [ ] **Step 2: Run** `node --test contact-roles/scripts/backfill-lib.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** `planProposals` and the CLI. Sources, read from the live boards: Affiliations `Sponsor Contact` checkbox → `Sponsorship`; BP Request Form `Contact (People)` at `Host Organization` → `Bike Parking`; Grants & Contracts `Funder Contact` at `Funder` → `Grants`; Sponsorships `Primary Contact` → `Sponsorship` only if it is a People link (it is plain text today, so expect `no-person-link` reports; do not name-match). Print a summary and write the report to a gitignored file, never into the repo.
- [ ] **Step 4: Run** the tests, then a sandbox dry run and review the report with the user before `--execute`. Expected: PASS; report numbers look plausible against Affiliations' 8,004 items.
- [ ] **Step 5: Commit** `feat(contact-roles): backfill proposed roles from existing data`.

### Task 8: Docs, UAT and rollout notes

**Files:**
- Create: `contact-roles/README.md`, `docs/uat/contact-roles.md`
- Modify: root `README.md` (Status-at-a-glance row), `docs/runbooks/migration-hold.md` (add `contact-roles` behavior under `hold`: cron skips, no catch-up needed), `CLAUDE.md` (add the Worker to the cron-polled list and `Contacts` to the form-hiding note only if the builder judges it durable)

- [ ] **Step 1: Write the README** as the Worker's spec: ask, data flow, config shape, columns, write modes, deploy order (set `contact-roles:writes on` before deploying a build that reads it, per `CLAUDE.md`), and the Leads switch-on condition.
- [ ] **Step 2: Write the UAT script** (non-technical): add a role to an affiliation, confirm a proposed one, see `Contacts` update within about ten minutes on a sandbox opportunity, and check a Former contact and a Proposed-only contact do not appear.
- [ ] **Step 3: Verify** `node scripts/check-log-safety.mjs`, `node scripts/check-worker-flags.mjs --strict`, `node scripts/check-monday-auth-bindings.mjs`, `cd contact-roles && npm test && npm run typecheck`. Expected: all PASS.
- [ ] **Step 4: Commit** `docs(contact-roles): README, UAT script and rollout notes`.

---

## Rollout (after the tasks; each needs the user's go-ahead)

1. Sandbox: run provision, deploy `npm run deploy:sandbox`, set `contact-roles:writes on --env sandbox`, run the backfill, have staff confirm a few roles, watch one reconcile.
2. Production: provision, set `contact-roles:writes on`, deploy, backfill, staff confirm.
3. Switch Leads on (`enabled: true`) once the Leads redesign adds its Organization link and final Type values.
4. Later, separate step: retire the `Sponsor Contact` checkbox after staff confirm the backfill.
