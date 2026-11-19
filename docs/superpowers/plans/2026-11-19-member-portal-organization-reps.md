# Member portal organization reps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A rep that staff granted Portal access signs in (Personal Email, or the Work Email on that
Affiliation) and reaches each organization's giving history and year-end statements; in January
every rep gets a statement-ready email.

**Architecture:** Access is a list of **org grants** (`{ orgItemId, affiliationItemId, via }`)
computed when the sign-in is requested, carried on the token row and then the session. Every
organization route re-reads the granting Affiliation by id before rendering. The statement is a pure
builder over three reads (gifts with Donor = org, matches with Matched By = org, one volunteer sweep
for the year). The January cron gains an organization pass with its own D1 dedupe table, sharing
the letter queue through a `kind: 'org'` message.

**Tech Stack:** Cloudflare Workers, Hono server-rendered views, D1, Queues, Monday GraphQL via the
`MONDAY_AUTH` broker, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-19-member-portal-organization-reps-design.md`

## Global Constraints

- All work in `member-portal/`; run `npm test` and `npm run typecheck` there (never a bare `tsc`).
  Worker tests need the sandbox disabled (workerd binds a port).
- No client JavaScript. Views escape every Monday value with `escapeHtml`.
- Every new UI string in all ten locales (`src/i18n`); the parity test must pass. The statement
  body itself stays English, like the person letter (official document); its page chrome is
  translated.
- Gated config: new column ids use `REPLACE_WITH_COLUMN_ID`; with the Portal access column unset
  the whole feature is off and nothing org-related is requested from Monday.
- `console.*` never logs an email address (`node ../scripts/check-log-safety.mjs`).
- Migration 0009 is applied to sandbox D1, then production D1, before the PR merges (user approves
  each, as with 0007/0008).
- Anti-goals, verbatim from the spec: access only by staff grant per person; no access after staff
  remove it; an organization id never treated as a person id (or the reverse); a deductible total
  that never counts sponsorships, grants, contracts, event tickets or employer matching; a statement
  that never reads as if the whole total were a tax-deductible gift.
- Employee volunteering is an aggregate (people, hours), hidden below 3 people. No employee names
  anywhere on an organization page.
- Unmatched employee gifts never appear.

## Review Focus

1. **One gift linked both ways.** An item whose Donor is the org *and* whose Matched By is the org
   must appear once (as a gift), not twice, and totals must not double. → Task 6 test.
2. **An org-only session on person routes.** A Work Email session has no people; every person door,
   letter and card route must send it home, not render an empty or broken page. → Task 5 test.
3. **Same address is a Personal Email and a Work Email.** Signs in as the person, the person's own
   Portal access Affiliations add grants, and the Work Email grant is not duplicated. → Task 4 test.
4. **A grant whose Affiliation was archived or moved to another organization.** Live check fails
   (not-found), even though the session still lists the org. → Task 4 test.
5. **The rep's Work Email changes mid-session.** A `workEmail` grant stops working on the next org
   page. → Task 4 test.

---

### Task 1: Config, gates and Monday columns

**Files:**
- Modify: `member-portal/src/types.ts`, `member-portal/src/config.ts`, `member-portal/config/svbc.json`,
  `member-portal/config/sandbox.json`
- Test: `member-portal/src/config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // types.ts
  export interface OrganizationsConfig {
    portalAccessColumn: string;      // Affiliations checkbox "Portal access"
    workEmailColumn: string;         // Affiliations "Work Email"
    addressColumn: string;           // Organizations address (placeholder = no address line)
    acknowledgmentSignedOff: boolean;
    volunteerFloor: number;          // 3
  }
  // Config gains `organizations: OrganizationsConfig`
  // config.ts
  export function orgAccessEnabled(config: Config): boolean;   // portalAccessColumn set, changeRequests.employer set, monday.organizationsBoardId set
  export function workEmailSignInEnabled(config: Config): boolean; // orgAccessEnabled && workEmailColumn set
  export function orgAcknowledgmentEnabled(config: Config): boolean; // orgAccessEnabled && acknowledgmentSignedOff && signedOffEin(config) !== null
  ```

- [ ] **Step 1: Look up / create the Monday columns (operator step, ask the user before any Monday
  write).** Read the Affiliations board's Work Email column id (sandbox `18437342615`, production
  `18437909787`) and the Organizations board's address column id (sandbox `18437342579`, production
  `18437909779`). Ask the user to approve creating a **Portal access** checkbox on both Affiliations
  boards; create it, note the ids. Do not add it to `MARKED_COLUMNS` (staff own it). Hide nothing:
  Affiliations has no form view.
- [ ] **Step 2: Write failing tests** in `config.test.ts`: `validateConfig` accepts the
  `organizations` block; rejects a missing block, a non-boolean `acknowledgmentSignedOff`, a
  `volunteerFloor` < 1; `orgAccessEnabled` false with `portalAccessColumn: 'REPLACE_WITH_COLUMN_ID'`
  and true with a real id; `workEmailSignInEnabled` false when `workEmailColumn` is the placeholder;
  `orgAcknowledgmentEnabled` false while `acknowledgmentSignedOff` is false.
- [ ] **Step 3: Run** `npm test -- src/config.test.ts` → FAIL.
- [ ] **Step 4: Implement** the type, validation (same style as the existing blocks) and the three
  gates. Both JSON configs get the block with real Work Email / address / Portal access ids from Step
  1, `acknowledgmentSignedOff: false`, `volunteerFloor: 3`. `config/split.test.ts` must still pass.
- [ ] **Step 5: Run** `npm test -- src/config.test.ts config/split.test.ts` → PASS; `npm run typecheck` → clean.
- [ ] **Step 6: Commit** `feat(member-portal): organization access config and gates`.

### Task 2: Migration 0009 and org grants on tokens and sessions

**Files:**
- Create: `member-portal/migrations/0009_organization_reps.sql`, `member-portal/src/orgs/grants.ts`
  (type only in this task)
- Modify: `member-portal/src/db/tokens.ts`, `member-portal/src/db/sessions.ts`, `member-portal/src/auth/session.ts`
- Test: `member-portal/src/db/tokens.test.ts`, `member-portal/src/db/sessions.test.ts`, `member-portal/src/auth/session.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/orgs/grants.ts
  export interface OrgGrant {
    orgItemId: string;
    affiliationItemId: string;
    via: 'person' | 'workEmail';
    personItemId: string | null;   // the Affiliation's person, for verified_emails
  }
  // NewMagicLinkToken.orgGrants?: OrgGrant[]; ConsumedToken.orgGrants: OrgGrant[]
  // NewSession.orgGrants: OrgGrant[]; SessionInfo.orgGrants: OrgGrant[]
  ```
- Migration (one file, applied once):
  ```sql
  ALTER TABLE magic_link_tokens ADD COLUMN org_grants TEXT;
  ALTER TABLE sessions ADD COLUMN org_grants TEXT;
  CREATE TABLE org_statement_sends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_item_id TEXT NOT NULL,
    affiliation_item_id TEXT NOT NULL,
    year INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    created_at TEXT NOT NULL,
    sent_at TEXT
  );
  CREATE UNIQUE INDEX idx_org_statement_sends_key ON org_statement_sends (org_item_id, affiliation_item_id, year);
  ```
  Header comment in the style of 0007/0008 (apply to both D1s before merging; nullable, so older
  code is unaffected).

- [ ] **Step 1: Write failing tests:** a token created with `orgGrants` comes back from
  `consumeToken` and `claimByRequest` with the same grants; a row with `org_grants` NULL reads as
  `[]`; `getSession` round-trips grants and reads NULL as `[]`; `startSession` passes the consumed
  token's grants to `createSession` and records the verified address for `donorItemIds` plus each
  `workEmail` grant's `personItemId` (deduplicated, nulls skipped).
- [ ] **Step 2: Run** `npm test -- src/db src/auth/session.test.ts` → FAIL.
- [ ] **Step 3: Implement** the migration, the `OrgGrant` type, JSON (de)serialization in both
  stores, and `startSession`'s verified-id list.
- [ ] **Step 4: Run** the same tests → PASS; full `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(member-portal): carry organization grants through sign-in`.
- [ ] **Step 6 (operator, ask first):** apply 0009 to sandbox D1 (`wrangler d1 migrations apply
  <db> --remote --env sandbox`, `CLOUDFLARE_ACCOUNT_ID` set); after the user says so, production.

### Task 3: Monday reads for Affiliations and organizations

**Files:**
- Modify: `member-portal/src/monday/client.ts`, `member-portal/src/monday/fakeClient.ts`, `member-portal/src/types.ts`
- Test: `member-portal/src/monday/client.test.ts`

**Interfaces:**
- Produces (on `MondayClient`; the client gets `OrganizationsConfig` and the employer config through
  its constructor or params, as `getPersonAffiliations` does today):
  ```ts
  export interface OrgAffiliation {
    id: string;
    personItemId: string | null;
    organizationId: string | null;
    statusLabel: string | null;
    portalAccess: boolean;
    workEmail: string;            // '' when unset or the column is unconfigured
  }
  // DonorMatch gains matchedPersonal: boolean (Personal Email, not Household, equals the address)
  // AffiliationRecord gains portalAccess: boolean (false when the column is the placeholder)
  findAffiliationsByWorkEmail(email: string): Promise<OrgAffiliation[]>;   // exact, case-insensitive post-filter like findDonorsByEmail
  getAffiliation(affiliationItemId: string): Promise<OrgAffiliation | null>; // null if missing or not active
  getOrganizationAffiliations(orgItemId: string): Promise<OrgAffiliation[]>; // Affiliations whose Organization link = org; active only
  getOrganization(orgItemId: string): Promise<{ id: string; name: string; address: string } | null>; // null unless the item is active AND on monday.organizationsBoardId
  getOrganizationGifts(orgItemId: string): Promise<OrgGift[]>;     // Donations with Donor = org
  getOrganizationMatches(orgItemId: string): Promise<OrgGift[]>;   // Donations with Matched By = org; [] when donationMatchedBy is the placeholder
  getCompletedVolunteerHoursInYear(year: number): Promise<Map<string, number>>; // personItemId → hours, one Volunteers-board sweep, completedStatuses only
  listYearActivity(year: number, excludedGiftTypes: string[]): Promise<{ personIds: string[]; organizationIds: string[] }>;
  export interface OrgGift { itemId: string; date: string; amount: string; giftType: string; description: string }
  ```
- `listYearActivity` **replaces** `listDonorIdsWithDonationsInYear`: same sweep, but it reads the
  Donor link's `linked_items { id board { id } }` and splits by board. `personIds` keeps today's
  filters (status, floor, excluded types) and now drops organization-board ids (they were being swept
  into the person run). `organizationIds` = orgs linked as Donor on any countable gift in the year,
  plus orgs in Matched By when that column is configured. Update `runLetterCron` to use `personIds`.
- `getOrganizationGifts` / `getOrganizationMatches` reuse `fetchItemsLinkedToDonor` and apply the
  same countable-status and `historyStartISO` floor as `getDonationsForDonor`; `giftType` is the
  `donationDescription` column (it is the Gift Type column).

- [ ] **Step 1: Write failing tests** (fetch-mock style already in `client.test.ts`):
  `findDonorsByEmail` sets `matchedPersonal` true only for a Personal Email match;
  `findAffiliationsByWorkEmail` drops items whose Work Email differs after trim/lowercase;
  `getOrganization` returns null for an item on the People board; `getAffiliation` returns null for
  an archived item; `listYearActivity` puts a People-board donor in `personIds`, an
  Organizations-board donor in `organizationIds` (including an excluded gift type, e.g.
  `Sponsorship`), and a Matched By org in `organizationIds`; no request names
  `REPLACE_WITH_COLUMN_ID` when the Portal access column is the placeholder.
- [ ] **Step 2: Run** `npm test -- src/monday/client.test.ts` → FAIL.
- [ ] **Step 3: Implement** the methods and fake-client counterparts (`fakeClient.ts` gets in-memory
  maps: affiliations, organizations, org gifts, org matches, volunteer hours).
- [ ] **Step 4: Run** `npm test` → PASS (letter cron tests updated for the rename); `npm run typecheck` → clean.
- [ ] **Step 5: Commit** `feat(member-portal): Monday reads for organization reps`.

### Task 4: Grant resolution at sign-in and the live check

**Files:**
- Modify: `member-portal/src/orgs/grants.ts`, `member-portal/src/auth/requestLogin.ts`
- Test: `member-portal/src/orgs/grants.test.ts`, `member-portal/src/auth/requestLogin.test.ts`

**Interfaces:**
- Consumes: Task 2 `OrgGrant`, Task 3 reads, Task 1 gates.
- Produces:
  ```ts
  export async function resolveOrgGrants(
    email: string, matches: DonorMatch[], deps: { monday: MondayClient; config: Config },
  ): Promise<OrgGrant[]>;
  export async function hasOrgAccess(
    grant: OrgGrant, sessionEmailHash: string | null, deps: { monday: MondayClient; config: Config },
  ): Promise<boolean>;
  // Finds the session's grant for an org id; null when the session holds none.
  export function grantFor(grants: OrgGrant[], orgItemId: string): OrgGrant | null;
  ```
- `resolveOrgGrants`: `[]` unless `orgAccessEnabled`. For each match with `matchedPersonal`, read
  `getPersonAffiliations`; keep `statusLabel === currentStatusLabel && portalAccess && organizationId`
  → `via: 'person'`. If `workEmailSignInEnabled`, add `findAffiliationsByWorkEmail(email)` results
  that are Current with Portal access → `via: 'workEmail'`. One grant per `orgItemId`, `person`
  winning over `workEmail`. Any read failure: log (no address) and drop that read's grants; never
  throw.
- `hasOrgAccess`: `getAffiliation(grant.affiliationItemId)` must be non-null, Current, Portal access
  ticked, `organizationId === grant.orgItemId`; for `via: 'workEmail'` also
  `sha256Hex(workEmail.trim().toLowerCase()) === sessionEmailHash`. Read failure → false.
  (The spec's "re-reads the session people's Affiliations" is implemented as re-reading the one
  granting Affiliation by id: same guarantee, one read, and it covers Work Email sessions that have
  no people.)
- `requestLogin`: after `findDonorsByEmail`, `grants = await resolveOrgGrants(...)`. Return early
  only when both `matches` and `grants` are empty. Token carries `donorItemIds` (people) and
  `orgGrants`. Locale: first match's Preferred Language, else (work-only) the Affiliation person's
  is not read — use `localeHint`.

- [ ] **Step 1: Write failing tests** in `grants.test.ts` (fake client): Personal Email match with a
  Current + Portal access Affiliation → one `person` grant; Household-only match → no grant; Former,
  Draft, or Portal access unticked → none; Work Email on a Current + Portal access Affiliation with no
  person match → one `workEmail` grant; **same address is Personal and Work for one org → a single
  `person` grant** (Review Focus 3); Affiliations read throws → `[]` and no throw; feature gate off →
  `[]` with no Monday call. `hasOrgAccess`: true for a live grant; false when unticked, Former,
  **archived, or relinked to another org** (Review Focus 4), on read failure, and for a `workEmail`
  grant **after the Work Email changed** (Review Focus 5).
  In `requestLogin.test.ts`: a work-only address sends the email and the token has `donorItemIds: []`
  and one grant; an address matching nothing sends nothing.
- [ ] **Step 2: Run** `npm test -- src/orgs src/auth/requestLogin.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; full `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(member-portal): organization grants at sign-in and live access check`.

### Task 5: Sessions without people, and "You manage" on home

**Files:**
- Modify: `member-portal/src/routes.ts`, `member-portal/src/home/loadHomeData.ts`, `member-portal/src/home/homeView.ts`, `member-portal/src/i18n/*`
- Test: `member-portal/src/routes.test.ts`, `member-portal/src/home/loadHomeData.test.ts`, `member-portal/src/views.test.ts` (or `homeView` tests where they live)

**Interfaces:**
- Consumes: `SessionInfo.orgGrants`, `getDonorNames` (board-agnostic `items(ids:)` name lookup),
  Task 6 `orgStatementYears` (for the ready line; wire after Task 6 lands, or stub to `[]` here and
  connect in Task 6).
- Produces:
  ```ts
  // HomeData gains:
  orgs: { orgItemId: string; name: string | null; statementReadyYear: number | null }[];
  // loadHomeData(donorItemIds, deps, locale, orgGrants: OrgGrant[] = [])
  ```
- Home: when `people` is empty and `orgs` non-empty, no greeting/headline/cards/doors, only the
  section. Otherwise the section sits below the doors. Each row links to
  `/:locale/portal/org/:orgItemId`. Names from one `getDonorNames` call; failure → `name: null`,
  rendered as `t('orgs.unnamed')`. `statementReadyYear` = last year when today ≤ `home.taxLetterUntil`
  and that year has a statement; else null. No gold button in the section.
- Person routes (`card`, `giving`, `activity`, `letters`, `letters/:id/:year`, `info`, `pledges`,
  `matching-gifts`, card regenerate): an authenticated session with `donorItemIds.length === 0`
  redirects to `/:locale/portal`. Add one helper beside `getSessionDonorIds` rather than repeating
  the check.
- i18n keys (all ten locales): `orgs.sectionTitle` ("You manage"), `orgs.unnamed` ("An
  organization you manage"), `orgs.statementReady` ("Your {year} year-end statement is ready").

- [ ] **Step 1: Write failing tests:** home for a person with one grant shows the section with the
  org name and link; a work-only session's home shows only the section (no card, no doors); names
  read failing shows `orgs.unnamed`; **a work-only session GETting `/en/portal/card`, `/giving`,
  `/letters`, `/info` is redirected home** (Review Focus 2); a person session with no grants renders
  home exactly as before (existing snapshot/assertions unchanged).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` → PASS (i18n parity included).
- [ ] **Step 5: Commit** `feat(member-portal): organizations on the home page`.

### Task 6: Organization data and the statement builder

**Files:**
- Create: `member-portal/src/orgs/statement.ts`, `member-portal/src/orgs/loadOrgData.ts`
- Modify: `member-portal/src/letters/loadLetterData.ts` (extract the shared split)
- Test: `member-portal/src/orgs/statement.test.ts`, `member-portal/src/orgs/loadOrgData.test.ts`, `member-portal/src/letters/loadLetterData.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // loadLetterData.ts — extracted, loadLetterData now uses it; behavior unchanged
  export function splitForLetter<T extends { description: string }>(gifts: T[], taxLetter: TaxLetterConfig): { acknowledged: T[]; separate: T[] };

  // statement.ts (pure)
  export interface OrgStatement {
    org: { id: string; name: string; address: string };
    year: number;
    summary: { label: string; count: number; total: string }[];   // one per Gift Type group, then "Employee matching"
    totalSupport: string;
    groups: { label: string; gifts: OrgGift[]; subtotal: string }[]; // by Gift Type, date order
    matches: { date: string; amount: string }[];                      // no names, ever
    matchTotal: string;
    volunteering: { people: number; hours: string } | null;          // null below volunteerFloor or when volunteer history is off
    acknowledgment: { gifts: OrgGift[]; separateGifts: OrgGift[]; total: string; statement: string } | null;
  }
  export function buildStatement(input: {
    org: { id: string; name: string; address: string };
    year: number; gifts: OrgGift[]; matches: OrgGift[];
    volunteerHoursByPerson: Map<string, number> | null; employeeIds: string[];
    taxLetter: TaxLetterConfig; volunteerFloor: number; acknowledgmentOn: boolean;
  }): OrgStatement | null;   // null when the year has no gifts and no matches
  export function statementYears(gifts: OrgGift[], matches: OrgGift[], now: Date): number[]; // completed years only, newest first

  // loadOrgData.ts
  export async function loadOrgPage(orgItemId: string, deps): Promise<{ org; gifts: OrgGift[]; matches: OrgGift[]; years: number[] } | null>;
  export async function loadOrgStatement(orgItemId: string, year: number, deps): Promise<OrgStatement | null>;
  ```
- Rules: a match whose `itemId` also appears in `gifts` is dropped from `matches` (Review Focus 1).
  `acknowledgment` is null when `acknowledgmentOn` is false or no gift survives `splitForLetter`;
  its `statement` is always `taxLetter.plainStatement`. Totals use `parseAmount` and `formatUsd`.
  Group labels are the Gift Type text as entered (trimmed); an empty Gift Type groups as
  "Other". Employees = `getOrganizationAffiliations` with Current status (Portal access irrelevant).
  The volunteer sweep runs only when `volunteerHistoryEnabled(config)`.

- [ ] **Step 1: Write failing tests** in `statement.test.ts`: groups and subtotals per Gift Type;
  `Sponsorship`, `Grants`, `Contracts`, `Event Ticket`, `Matching Donation` listed but **not** in
  `acknowledgment.total`; `Donor Advised Fund` in `separateGifts`; acknowledgment null when the
  switch is off; **an item in both gifts and matches counted once** (Review Focus 1); matches carry
  only date and amount; volunteering null with 2 people, present with 3 (hours summed, only
  employees counted); a year with nothing → null; `statementYears` excludes the current year.
  `loadLetterData.test.ts` stays green after the extraction. `loadOrgData.test.ts`: an id that
  `getOrganization` rejects (People-board item) → null.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Connect `statementReadyYear` in `loadHomeData` (Task 5).
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(member-portal): organization statement builder`.

### Task 7: Organization page and statement page

**Files:**
- Create: `member-portal/src/orgs/orgViews.ts`
- Modify: `member-portal/src/routes.ts`, `member-portal/src/i18n/*`, `member-portal/src/assets/portalStyles.ts` (print rules only if the letter's don't already cover the page)
- Test: `member-portal/src/orgs/orgViews.test.ts`, `member-portal/src/routes.test.ts`

**Interfaces:**
- Consumes: `grantFor`, `hasOrgAccess` (Task 4), `loadOrgPage`, `loadOrgStatement` (Task 6),
  `doorPage` (`src/doors/layout.ts`), `donationHistoryEnabled`.
- Routes:
  - `GET /:locale/portal/org/:orgItemId` → `orgPageView(...)`.
  - `GET /:locale/portal/org/:orgItemId/statement/:year` → `orgStatementView(...)`.
  - Both: no session → sign-in with `next=` (existing pattern); `grantFor` null, `hasOrgAccess`
    false, `getOrganization` null or any read failure → the same not-found page (404) for all four;
    `NO_STORE` cache header; no Monday donation read before the live check passes.
- `orgPageView`: door layout ("‹ Home", org name). **Giving**: newest first, date, amount, Gift Type,
  description; a total per calendar year; "Employee match" rows (date, amount) only when
  `matchLinesEnabled`; the whole Giving part follows `donationHistoryEnabled` exactly as the person
  giving door does. **Year-end statements**: one link per `years` entry; none → `orgs.noStatements`.
- `orgStatementView`: letterhead and signature like `letterView`; sections in spec order (Summary,
  Gifts and payments, Employee matching, Employee volunteering, Tax acknowledgment), each omitted
  when empty. With the acknowledgment off: the line "A tax acknowledgment for these gifts will
  follow." With it on: the deductible gifts, SVBC legal name and EIN, `plainStatement`, and "The
  other sections are listed for {org}'s records and are not acknowledged as tax-deductible gifts."
  Body English; chrome (back link, print button) translated.
- i18n keys: `orgs.giving`, `orgs.statements`, `orgs.statementLink` ("{year} year-end statement"),
  `orgs.noStatements`, `orgs.employeeMatch`, `orgs.yearTotal`, `orgs.print`.

- [ ] **Step 1: Write failing tests** (routes with fake client): granted rep sees name, gifts with
  Gift Type labels, statement links; **an org id not in the session's grants → 404**; a grant whose
  Affiliation is unticked → 404; **a People-board id under `/org/` → 404**; **an org id under
  `/letters/:donorItemId/:year` → the existing refusal** (anti-goal: org id as person id); statement
  page shows Sponsorship under Gifts and payments and not in the acknowledged total; no employee
  name appears anywhere in the statement HTML (assert the fake employee's name is absent);
  acknowledgment-off line present when the switch is off; responses carry `Cache-Control: private,
  no-store, max-age=0`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` → PASS; `npm run typecheck` → clean.
- [ ] **Step 5: Commit** `feat(member-portal): organization page and year-end statement`.

### Task 8: January statement emails

**Files:**
- Create: `member-portal/src/db/orgStatementSends.ts`, `member-portal/src/orgs/runOrgStatementPass.ts`, `member-portal/src/orgs/processOrgStatementSend.ts`
- Modify: `member-portal/src/letters/runLetterCron.ts`, `member-portal/src/letters/processLetterSendBatch.ts`, `member-portal/src/types.ts`, `member-portal/src/email/*` (types, sender, templates), `member-portal/src/i18n/*`, `member-portal/src/index.ts`
- Test: one `.test.ts` beside each new file; `runLetterCron.test.ts`, `processLetterSendBatch.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // types.ts
  export interface LetterSendQueueMessage extends WriteStamp { sendId: number; kind?: 'org' } // absent = person
  // db/orgStatementSends.ts — same contract as LetterSendStore, keyed (orgItemId, affiliationItemId, year)
  export interface OrgStatementSendStore {
    listKeysForYear(year: number): Promise<Set<string>>;            // `${org}:${affiliation}`
    createQueued(p: { orgItemId: string; affiliationItemId: string; year: number; createdAt: string }): Promise<number>;
    findByKey(orgItemId: string, affiliationItemId: string, year: number): Promise<OrgStatementSendRow | null>;
    getById(id: number): Promise<OrgStatementSendRow | null>;
    claimForSending(id: number, nowISO: string): Promise<boolean>;
    releaseClaim(id: number): Promise<void>;
    markSent(id: number, nowISO: string): Promise<void>;
    markSkipped(id: number, nowISO: string): Promise<void>;
    requeue(id: number, nowISO: string): Promise<void>;
  }
  export async function runOrgStatementPass(deps, year: number, organizationIds: string[], budget: number): Promise<{ eligibleReps: number; alreadyHandled: number; triggered: number; failed: number; deferred: number }>;
  // EmailSender gains:
  sendOrgStatementReadyEmail(p: { to: string; orgName: string; year: number; loginUrl: string; locale: Locale }): Promise<void>;
  ```
- Cron: `runLetterCron` keeps its gates (write switch, configured, settings, auto-send, start date,
  history floor), runs the person pass only when `lettersEnabled`, then the org pass when
  `orgAccessEnabled`, with `maxTriggersPerRun` minus what the person pass used. The org pass does
  **not** depend on `lettersEnabled` (the statement's acknowledgment has its own switch). The `ran`
  result gains an `orgs` field with the pass's counts; `skipped: 'letters-not-signed-off'` is
  returned only when neither pass can run.
- Org pass: for each org from `listYearActivity(...).organizationIds`, `getOrganizationAffiliations`
  → reps = Current + Portal access with a person or a Work Email; skip keys already in the store;
  `createQueued` + queue `{ sendId, kind: 'org' }` through `stampedQueue`. Same dedupe-hit handling
  as `triggerLetterSend` (stranded `queued` re-sent, `skipped` requeued).
- Consumer (`processOrgStatementSend`), mirroring `processOne`'s claim/send/mark order: re-read the
  Affiliation (Current + Portal access + same org, else `markSkipped`); `loadOrgStatement` non-null
  else skip; recipient = Affiliation Work Email when set, else the person's Personal Email
  (`getDonorContactInfo(person).email`), none → skip and log without the address; token =
  `{ donorItemIds: [], orgGrants: [{ orgItemId, affiliationItemId, via: workEmail ? 'workEmail' : 'person', personItemId }], emailHash: sha256(recipient) }`
  with `letterLinkTtlHours`; link = `magicLinkUrl(base, token, locale, '/<locale>/portal/org/<org>/statement/<year>')`;
  locale from the person's Preferred Language, else `DEFAULT_LOCALE`.
- Email copy (built-in i18n, all ten locales; not the Letter Settings templates): subject
  `orgs.emailSubject` "{org}'s {year} year-end statement is ready"; body explains the statement
  lists all of the organization's support and the link signs them in.

- [ ] **Step 1: Write failing tests:** two reps for one org → two rows, two messages; rerun → zero
  new; a rep added after the first run → one new; a Former rep → none; person pass with letters not
  signed off still lets the org pass run; budget shared (person pass uses 199 of 200 → org pass
  queues 1, defers the rest); consumer sends to the Work Email when set, else Personal Email; the
  minted token has no people and one grant; an unticked Affiliation at send time → `skipped`, no
  email; `sending` row on redelivery → no second email; queue dispatch routes `kind: 'org'` to the
  org consumer and an unmarked message to the person one; under write switch `off` the message is
  stamped `dropped` and stays a dry run.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` → PASS; `npm run typecheck` → clean; `node ../scripts/check-log-safety.mjs` → clean.
- [ ] **Step 5: Commit** `feat(member-portal): January statement emails for organization reps`.

### Task 9: Docs, runbook and UAT

**Files:**
- Modify: `member-portal/README.md`, the staff UAT script the home-page PR updated (same file),
  root `README.md` status row for `member-portal`, `docs/runbooks/` (a short "Give a rep portal
  access" section in the member-portal runbook or README's staff section)

- [ ] **Step 1:** README: org reps feature, the `organizations` config block and its gates,
  migration 0009, the acknowledgment switch (off until the accountant signs off the wording), the
  January org pass and its dedupe table.
- [ ] **Step 2:** Staff runbook: tick **Portal access** on the person's Current Affiliation; the
  rep signs in with their Personal Email or that Affiliation's Work Email; untick or mark Former to
  end access (takes effect on the next organization page; the home list may show the org up to 24 h).
- [ ] **Step 3:** UAT script (sandbox): grant, sign in with Personal Email, with Work Email
  (org-only home), revoke and reload the org page (not found), statement with a Sponsorship and a
  match, volunteering hidden below 3, January pass dry run under `hold`.
- [ ] **Step 4:** Commit `docs(member-portal): organization reps`.
