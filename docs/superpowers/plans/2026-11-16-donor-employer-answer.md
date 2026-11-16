# Donor-Supplied Employer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in donor can name their employer on the member portal. An exact (normalised) Organization match becomes their Current, Primary affiliation through the writer; anything else reaches staff as a change request.

**Architecture:** The portal adds `employer` as a change-request field (same D1 row, dedupe and queue). `svbc-member-portal-writer`'s `processOne` branches on that field: it resolves the name to one Organization, moves Primary onto that person's affiliation (creating it if needed), never changes another affiliation's Status, and always logs a Change Requests item. Pure matching and planning logic lives in `src/changeRequests/employer.ts`; the Monday calls are new `MondayClient` methods.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers + D1 + Queues, vitest, Monday GraphQL (via the copied `src/monday/graphql.ts` transport, which is not edited).

**Spec:** `docs/superpowers/specs/2026-11-16-donor-employer-answer-design.md`

## Global Constraints

- All commands run from `member-portal/`. Type-check with `npm run typecheck`, never bare `tsc`.
- Do not edit `src/flags.ts` or `src/monday/graphql.ts` (byte-identical copies, CI-enforced).
- The portal Worker never writes Monday; only the writer's queue consumer does.
- The matching-gifts page renders zero donor PII. It may link to the employer form, never show a value.
- Never write donor text to People → Employer Name. `donation-rollups`' `employerSync` writes it.
- Never change Status on an affiliation other than the matched one. Moving Primary off is the only change to others.
- Staff-facing labels are English constants: `Employer`, `Employer (applied)`, `Employer (no change)`, `Employer (needs an Organization)`.
- Log item name stays `` `${FIELD_LABELS[row.field]} change — ${row.donorName} (#${row.id})` `` (`Employer change — …`) so a retry adopts it.
- Every user-sourced value travels as a GraphQL variable. No donor email or employer text in `console.*` (`node ../scripts/check-log-safety.mjs`).
- Every new i18n key is added to all ten locale files (`Record<TranslationKey, string>` enforces it).
- Config ids (from `donation-rollups/config/*.json`):
  - sandbox: affiliations board `18437342615`, personLink `board_relation_mm8hvr9x`, organizationLink `board_relation_mm8h730r`, status `color_mm8h68bj`, primary `boolean_mm8hz6xj`; People employer `text_mm8hdpm`, People affiliations link `board_relation_mm8hk2s1`.
  - production: affiliations board `18437909787`, personLink `board_relation_mm8nb95b`, organizationLink `board_relation_mm8nsa59`, status `color_mm8na4wv`, primary `boolean_mm8nyg8y`; People employer `text_mm8nny92`, People affiliations link `board_relation_mm8nj561`.
  - `local.json`: `"employer": null`, `donorEmployer` placeholder.

## Review Focus

1. **A name that is only a suffix or punctuation** ("Inc.", "—"): the normalised stem is empty. Expect no Monday query with an empty string and a `needs an Organization` item. (Task 1 test `empty stem yields no variants`; Task 4 test `unmatchable name goes to staff without a lookup`.)
2. **Ampersands and hyphens** ("AT&T", "Hewlett-Packard"): both sides normalise the same way, so an Organization named "AT&T Inc." matches a donor's "AT&T". (Task 1 test `punctuation normalises identically on both sides`.)
3. **An affiliation with no Organization linked** that is Primary: Primary is still moved off it, and the log says `(previous Primary: (no Organization), still Current)`. (Task 1 test in `planAffiliationChange`.)
4. **Retry after an ambiguous `createAffiliation`:** the second pass finds the affiliation already Current and Primary, makes no affiliation write, and logs `Employer (no change)`. (Task 4 test `retry after partial apply`.)
5. **Several existing affiliations to the matched Organization** (say one Former, one Current): the Current one is reused, and no duplicate is created. (Task 1 test.)

---

### Task 1: Pure matching and planning (`employer.ts`)

**Files:**
- Create: `src/changeRequests/employer.ts`
- Test: `src/changeRequests/employer.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface OrganizationCandidate { id: string; name: string }
  export interface AffiliationRecord {
    id: string; organizationId: string | null; organizationName: string | null;
    statusLabel: string | null; primary: boolean;
  }
  export function normalizeEmployerName(name: string): string
  export function organizationNameVariants(typed: string): string[]   // [] when stem empty
  export function pickOrganization(typed: string, candidates: OrganizationCandidate[]):
    | { kind: 'one'; organization: OrganizationCandidate }
    | { kind: 'none' }
    | { kind: 'several'; organizations: OrganizationCandidate[] }
  export type AffiliationPlan =
    | { kind: 'noChange' }
    | { kind: 'apply'; reuseAffiliationId: string | null; clearPrimaryOn: AffiliationRecord[] }
  export function planAffiliationChange(
    affiliations: AffiliationRecord[], organizationId: string, currentStatusLabel: string): AffiliationPlan
  export function previousPrimaryNote(clearPrimaryOn: AffiliationRecord[]): string  // '' when none
  ```

- [ ] **Step 1: Write the failing tests** in `employer.test.ts`:
  - `normalizeEmployerName`: `'  Google, LLC '` → `'google'`; `'Acme Corporation'` → `'acme'`; `'Acme Co.'` → `'acme'`; `'AT&T Inc.'` → `'att'`; `'Hewlett-Packard'` → `'hewlettpackard'`. Rule: lower case; strip every character that is not a letter, digit or space (Unicode letters kept); collapse spaces; drop one trailing word in `inc|incorporated|llc|ltd|corp|corporation|co|company`; then remove spaces.
  - `punctuation normalises identically on both sides`: `normalizeEmployerName('AT&T') === normalizeEmployerName('AT & T, Inc.')`.
  - `organizationNameVariants('Google')` contains `'Google'`, `'Google, LLC'`, `'Google LLC'`, `'Google, Inc.'`, `'Google Inc.'`, `'Google Inc'`, `'Google, Inc'`, `'Google Corp'`, `'Google Corporation'`, `'Google Ltd'`, `'Google Co'`, with no duplicates. `organizationNameVariants('Google LLC')` contains `'Google LLC'` and `'Google'`. The stem is the typed name, trimmed, with the trailing suffix word and its preceding comma removed, original case kept.
  - `empty stem yields no variants`: `organizationNameVariants('Inc.')` and `organizationNameVariants('  — ')` both return `[]`.
  - `pickOrganization`: one equal-normalised candidate → `one`; candidates with no normalised match → `none`; two normalised matches → `several` with both; an empty `typed` → `none`.
  - `planAffiliationChange` (label `'Current'`, org `'O1'`):
    - no affiliations → `apply`, `reuseAffiliationId: null`, `clearPrimaryOn: []`
    - an O1 affiliation that is Current and Primary, and no other Primary → `noChange`
    - an O1 affiliation that is Former → `apply`, reusing its id
    - an O1 affiliation that is Draft → `apply`, reusing its id
    - O1 Former plus O1 Current (non-Primary) → reuses the Current one's id
    - an O2 affiliation that is Primary and Current → `apply`, with `clearPrimaryOn` = [O2]
    - an O2 affiliation that is non-Primary and Current → not in `clearPrimaryOn`
    - an affiliation with `organizationId: null` that is Primary → in `clearPrimaryOn`
    - O1 Current and Primary, plus O2 Primary → `apply` (O1 reused, O2 cleared), not `noChange`
  - `previousPrimaryNote`: `[]` → `''`; [Acme] → `' (previous Primary: Acme, still Current)'`; a null name → `' (previous Primary: (no Organization), still Current)'`. Two entries are joined with `', '` inside one parenthesis.

- [ ] **Step 2: Run them and see them fail.** `npm test -- src/changeRequests/employer.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement `employer.ts`.** No I/O, no imports beyond types.

- [ ] **Step 4: Run them and see them pass.** Same command. Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -m "feat(member-portal): employer name matching and affiliation plan (#127)"`

### Task 2: Config, types and the Monday client

**Files:**
- Modify: `src/types.ts` (`ChangeRequestsConfig`, `DonorContactInfo`, Monday column keys), `src/config.ts` (validation and gate), `config/sandbox.json`, `config/svbc.json`, `config/local.json`, `config/split.test.ts`
- Modify: `src/monday/client.ts` (`MondayClient` and `HttpMondayClient`), `src/monday/fakeClient.ts`
- Test: `src/config.test.ts`, `src/monday/client.test.ts`

**Interfaces:**
- Consumes: `OrganizationCandidate` and `AffiliationRecord` from Task 1.
- Produces:
  ```ts
  // types.ts
  export interface EmployerAffiliationColumns { personLink: string; organizationLink: string; status: string; primary: string }
  export interface EmployerAnswerConfig {
    affiliationsBoardId: number; affiliationColumns: EmployerAffiliationColumns;
    currentStatusLabel: string; personAffiliationsLink: string;
  }
  // ChangeRequestsConfig gains: employer: EmployerAnswerConfig | null
  // monday.columns gains: donorEmployer: string  (placeholder allowed)
  // DonorContactInfo gains: employer: string      ('' when donorEmployer is the placeholder)
  // config.ts
  export function employerAnswerEnabled(config: Config): boolean
    // changeRequestsEnabled(config) && employer !== null && donorEmployer is not the placeholder
  // MondayClient
  findOrganizationsByNames(params: { boardId: number; names: string[] }): Promise<OrganizationCandidate[]>
  getPersonAffiliations(params: { donorItemId: string; employer: EmployerAnswerConfig }): Promise<AffiliationRecord[]>
  createAffiliation(params: { employer: EmployerAnswerConfig; itemName: string; donorItemId: string; organizationItemId: string }): Promise<void>
  updateAffiliation(params: { employer: EmployerAnswerConfig; itemId: string; makeCurrent: boolean; primary: boolean }): Promise<void>
  ```

- [ ] **Step 1: Write the failing config tests** in `config.test.ts`:
  - `employer: null` validates, and `employerAnswerEnabled` is false.
  - A full `employer` block validates, and with `donorEmployer` set, `employerAnswerEnabled` is true.
  - A missing `affiliationColumns.primary` throws `/changeRequests\.employer\.affiliationColumns\.primary/`.
  - A non-positive `affiliationsBoardId` throws.
  - `donorEmployer` left as the placeholder makes `employerAnswerEnabled` false.
  - Add to `config/split.test.ts`: `changeRequests.employer.affiliationsBoardId` is a real sandbox id that differs from production's.

- [ ] **Step 2: Write the failing client tests** in `client.test.ts`, following its existing fetch-mock style:
  - `findOrganizationsByNames` sends one `items_page_by_column_values` query with `column_id: 'name'` and every name in `column_values`, as variables, and returns `{id, name}` items. With `names: []` it makes no request and returns `[]`.
  - `getPersonAffiliations` reads the People item's `personAffiliationsLink` linked ids, then those items' organizationLink (`linked_items { id name }`), status `text` and primary checkbox. It maps a checkbox `text` of `'v'` to `primary: true`, and an empty link to `organizationId: null`.
  - `createAffiliation` sends `create_item` with `{ [personLink]: { item_ids: [n] }, [organizationLink]: { item_ids: [n] }, [status]: { label: currentStatusLabel }, [primary]: { checked: 'true' } }`, as a non-idempotent request.
  - `updateAffiliation` sends `change_multiple_column_values`. With `makeCurrent: true, primary: true` it sets status `{ label }` and primary `{ checked: 'true' }`. With `makeCurrent: false, primary: false` it sends **only** primary, set to `null` (which clears a checkbox), and no status key.
  - `getDonorContactInfo` returns `employer` from `donorEmployer`, and `''` without querying that column when it is the placeholder.

- [ ] **Step 3: Run them and see them fail.** `npm test -- src/config.test.ts src/monday/client.test.ts config/split.test.ts`

- [ ] **Step 4: Implement.**
  - In `config.ts`, `changeRequests.employer` is optional: absent or `null` both become `null`.
  - Fill the three JSON files from Global Constraints.
  - Add the four methods to `fakeClient.ts`: no organizations, no affiliations, writes logged like `createChangeRequestItem`.
  - Fix every other `Config` / `DonorContactInfo` fixture the typecheck flags by adding `employer: null` / `employer: ''`.

- [ ] **Step 5: Verify.** Run `npm test` and `npm run typecheck`. Expected: all pass.

- [ ] **Step 6: Commit.** `git commit -m "feat(member-portal): employer answer config and Monday affiliation calls (#127)"`

### Task 3: Portal form, submit and matching-gifts link

**Files:**
- Modify: `src/db/changeRequests.ts` (`ChangeRequestField` gains `'employer'`), `src/changeRequests/submitChangeRequest.ts`, `src/changeRequests/changeRequestViews.ts`, `src/matchingGifts/matchingGiftViews.ts`, `src/routes.ts` (pass the gate and the `?field=` preselect), `src/i18n/locales/*.ts`
- Test: `src/changeRequests/submitChangeRequest.test.ts`, `src/changeRequests/changeRequestViews.test.ts`, `src/matchingGifts/matchingGiftViews.test.ts`, `src/routes.test.ts`

**Interfaces:**
- Consumes: `employerAnswerEnabled`, and `DonorContactInfo.employer` (Task 2).
- Produces: `FIELD_LABELS.employer = 'Employer'`. A D1 row has `field: 'employer'` and `oldValue` = People → Employer Name.

- [ ] **Step 1: Write the failing tests.**
  - submit: `field: 'employer'` with `newValue: 'Google'` creates a row with `oldValue` = contact.employer and enqueues it. The same value within the window → `duplicate`. When the route's gate is off, `employer` is rejected as an unknown field: `submitChangeRequest` takes a new `allowedFields?: ChangeRequestField[]` in `SubmitDeps`, and the route omits `'employer'` unless `employerAnswerEnabled`.
  - views: with employer enabled, the select has `<option value="employer">` and current details show an Employer row. Disabled → neither appears. With `preselectField: 'employer'` the option is `selected`.
  - matching-gifts view: with `employerFormUrl` set, the page has a link to `/{locale}/portal/change-request?field=employer` with the new copy. Without it, no link. The rendered HTML contains no donor value: the view takes no donor data, so assert its signature takes only `locale` and `employerFormUrl`.
  - routes: `GET /en/portal/change-request?field=employer` preselects. Any other `field` value is ignored.

- [ ] **Step 2: Run them and see them fail.** `npm test -- src/changeRequests src/matchingGifts src/routes.test.ts`

- [ ] **Step 3: Implement.**
  - New i18n keys, with English copy:
    - `changeRequest.fieldEmployer`: `'Employer'`
    - `matchingGifts.employerPrompt`: `'Tell us where you work, so we can let you know if your employer matches your gifts.'`
    - `matchingGifts.employerLink`: `'Add your employer'`
  - Translate the keys into all nine other locales.
  - The spec's `#employer` anchor becomes `?field=employer`. The form is one `<select>`, so a preselect does what the anchor was for. Record this in the spec's "Left to the builder".

- [ ] **Step 4: Verify.** Run `npm test` and `npm run typecheck`. Expected: pass.

- [ ] **Step 5: Commit.** `git commit -m "feat(member-portal): donors can submit their employer (#127)"`

### Task 4: Writer applies the answer

**Files:**
- Create: `src/changeRequests/applyEmployer.ts`
- Modify: `src/changeRequests/processBatch.ts`, `src/writeSwitch.ts` (`dryRunChangeDeps` placeholders)
- Test: `src/changeRequests/applyEmployer.test.ts`, `src/changeRequests/processBatch.test.ts`

**Interfaces:**
- Consumes: Task 1 functions; Task 2 client methods and `EmployerAnswerConfig`.
- Produces:
  ```ts
  export const EMPLOYER_LABELS = { applied: 'Employer (applied)', noChange: 'Employer (no change)', needsOrganization: 'Employer (needs an Organization)' } as const
  export async function applyEmployerAnswer(
    row: ChangeRequestRow, deps: { monday: MondayClient; config: Config }): Promise<{ fieldLabel: string; newValue: string }>
  ```

- [ ] **Step 1: Write the failing tests** in `applyEmployer.test.ts`, with a `vi.fn()` MondayClient:
  - One match, no affiliations → `createAffiliation` with `itemName: 'Jane Example — Google'` → `{ fieldLabel: 'Employer (applied)', newValue: 'Google' }`.
  - One match, previous Primary at Acme → `updateAffiliation({ itemId: <acme>, makeCurrent: false, primary: false })` is called, and `newValue: 'Google (previous Primary: Acme, still Current)'`.
  - One match, existing Former O1 → `updateAffiliation({ itemId, makeCurrent: true, primary: true })`, and no create.
  - **Order:** the matched affiliation is written before any clear-Primary call. So a crash between the two leaves two Primaries for a moment, never none. The retry clears the old one.
  - `retry after partial apply`: affiliations already show O1 Current and Primary and nothing else Primary → no write calls → `Employer (no change)`, with `newValue` the Organization's name (same as `applied`).
  - Typed name that differs from the Organization's (`'google llc'` vs `'Google'`): `newValue` is `'Google'` (the Organization's name), and the log's old value is unchanged.
  - Zero candidates → `Employer (needs an Organization)`, `newValue` = the typed name, and no affiliation calls.
  - Two candidates → `newValue: '"Acme" — 2 Organizations match: Acme Corp, ACME Inc'`.
  - `unmatchable name goes to staff without a lookup`: typed `'Inc.'` → `findOrganizationsByNames` not called → needs-an-Organization.
  - `config.changeRequests.employer` null → throws `config: changeRequests.employer is not configured` (the row then retries into the DLQ, the same as a missing boardId).

- [ ] **Step 2: Write the failing `processBatch.test.ts` cases.**
  - An `employer` row with no existing log item calls `applyEmployerAnswer`, then `createChangeRequestItem` with the returned `fieldLabel` and `newValue`, `itemName: 'Employer change — Jane Example (#42)'`, then `markWritten`.
  - An `employer` row whose log item already exists is adopted, and `applyEmployerAnswer` is not called.
  - Dry run (`consumeChangeQueueBatch` under `off`): `createAffiliation`, `updateAffiliation` and `createChangeRequestItem` are recorded as skips and never reach the client, and reads still run.

- [ ] **Step 3: Run them and see them fail.** `npm test -- src/changeRequests`

- [ ] **Step 4: Implement.**
  - `applyEmployer.ts`: `organizationNameVariants` → (if non-empty) `findOrganizationsByNames` on `config.monday.organizationsBoardId` → `pickOrganization` → `getPersonAffiliations` → `planAffiliationChange` → writes, in this order: reuse/update or create, then clear Primary on each other affiliation.
  - In `processOne`, after the adopt check, `employer` rows take their `fieldLabel`/`newValue` from `applyEmployerAnswer`. Other fields are unchanged.
  - In `dryRunChangeDeps`, add `createAffiliation: undefined, updateAffiliation: undefined`.

- [ ] **Step 5: Verify.**
  - `npm test`, `npm run typecheck`, `node ../scripts/check-log-safety.mjs`, `node ../scripts/check-worker-flags.mjs --strict`. Expected: all pass, and `flags.ts` is unchanged.

- [ ] **Step 6: Commit.** `git commit -m "feat(member-portal): writer applies a donor's employer answer (#127)"`

### Task 5: Docs

**Files:**
- Modify: `member-portal/README.md` (new "v4.1 — Donor-supplied employer" section after v4: behaviour, labels, config keys, the writer's Affiliations writes, sandbox check from the spec's Testing section), `docs/uat/member-portal.md` (a UAT case: matched, unmatched, previous Primary), root `README.md` status table row for member-portal if it lists features.

- [ ] **Step 1: Write the docs.** Copy facts from the spec and plan only. Do not describe the token as scoped.
- [ ] **Step 2: Commit.** `git commit -m "docs(member-portal): document donor-supplied employer (#127)"`
