# Funding Leads Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, in the CRM Sandbox v4 workspace only, a Leads board for all funding solicitations (multi-select Type) whose Pledged stage hands off idempotently to a linked Deals item, seeded from the "2027 Sponsor List" sheet.

**Architecture:** Follows the repo's operator-tool convention (`scripts/windfall-board.mjs`): a dependency-free CLI `scripts/funding-leads-board.mjs` plus pure, `node:test`-tested logic in `scripts/lib/funding-leads.mjs`. It runs with the operator's own token through the `monday-backup` GraphQL transport, dry-run by default and `--apply` to write. Every command hard-refuses any workspace other than 18210301.

**Tech Stack:** Node 22.18+ (strip-only TS import of `monday-backup/src/monday/graphql.ts`), `node:test`, Monday GraphQL API.

**Spec:** `docs/superpowers/specs/2026-11-11-funding-leads-board-design.md`

## Global Constraints

- Sandbox only: workspace id **18210301**; never write to production workspace **10001654** or board **8531259839**.
- Never duplicate boards (`duplicate_board`); create fresh regular boards.
- Type and Events of interest are **multi-select dropdowns**; a multi-event deal stays one item.
- Stage labels must include **Pledged** (marked done) and **Lost**; Invoice Status / PO Number do **not** appear on Leads.
- Hand-off is idempotent: the Deal link column is the dedupe key; the lead stays on Leads.
- No donor PII in the repo: seed data is read from a gitignored path outside `scripts/`; tests use synthetic fixtures.
- Scripts must pass `node scripts/check-log-safety.mjs` (no logging that could emit an email address). Exit 0 ok, 1 check failed, 2 usage/API error or unknown write outcome.
- Column titles are compared through `bareTitle` from `scripts/lib/column-titles.mjs`.

## Review Focus

- Pledged set twice, or moved out and back: still exactly one Deal.
- Sheet row with several emails in one cell ("a@x.org, b@x.org"): all kept, none logged.
- Organization name variants ("Applied Materials" vs "Applied Materials Foundation", trailing spaces, `AT\&T`): exact-normalized match only; near-matches go to a review file, never merged.
- Same company on several sheet rows or tabs: one Lead per distinct solicitation, one Organization.
- Blank Event, blank Type or blank amount in a row: item is created with the field empty, not skipped or defaulted wrongly.
- Token that can reach workspace 10001654: guard still refuses before any request.

---

### Task 1: Board spec and sandbox guard

**Files:**
- Create: `scripts/lib/funding-leads.mjs`
- Test: `scripts/lib/funding-leads.test.mjs`

**Interfaces:**
- Produces: `SANDBOX_WORKSPACE_ID = 18210301`; `assertSandboxWorkspace(workspaceId: number|string): void` (throws `Error` unless equal to 18210301, including for 10001654); `LEADS_COLUMNS: {title, type, settings?}[]`; `DEAL_EXTRA_COLUMNS: same shape`; `STAGES: {label, done}[]`; `TYPES`, `EVENTS`, `BTWD_TIERS`, `FUNDER_STATUSES: string[]`.

- [ ] **Step 1: Write failing tests** — `assertSandboxWorkspace(10001654)` throws; `assertSandboxWorkspace('18210301')` does not; `STAGES` includes `{label:'Pledged', done:true}` and `Lost`; `LEADS_COLUMNS` has Type and Events of interest typed `dropdown`; no `LEADS_COLUMNS` title matches /invoice|po number/i; `EVENTS` equals `['BTWD','Advocacy Summit','Dinner','Fundraising Ride','Wellness','Misc']`; `TYPES` equals `['Grant','Contract','Sponsorship']`.
- [ ] **Step 2: Run** `node --test scripts/lib/funding-leads.test.mjs` — expect FAIL (module missing).
- [ ] **Step 3: Implement** the exports above. Stage order: Research, Needs Cultivation, Cultivation, Scheduled Meeting, Proposal Submitted, Evaluation, Pledged, Lost. Leads columns per the spec: Organization (board_relation), Contact (board_relation), Amount (numbers, `$`), Owner (people), Expected Close (date), Type, Events of interest, BTWD tier (status), Funder Status (status), Stage (status), Deal (board_relation, the dedupe key). Deal extras: Type, Events of interest (dropdowns), Lead (board_relation), Invoice Status, PO Number.
- [ ] **Step 4: Run tests** — expect PASS.
- [ ] **Step 5: Commit** `feat(scripts): funding leads board spec and sandbox guard`.

### Task 2: Sheet-row mapping (pure)

**Files:**
- Modify: `scripts/lib/funding-leads.mjs`
- Test: `scripts/lib/funding-leads.test.mjs`

**Interfaces:**
- Consumes: constants from Task 1.
- Produces:
  - `normalizeOrgName(name: string): string` (trim, collapse whitespace, strip `\` escapes, case-insensitive key).
  - `parseEvents(cycle: string): string[]` mapping "2024 BTWD; 2024 Advocacy Summit; 2024 Fundraising Ride", "BTWD / Dinner" and bare "Summit" to `EVENTS` values, deduped, unknown tokens dropped.
  - `parseEmails(cell: string): string[]`.
  - `mapSheetRow(tab: 'active'|'prospects'|'lapsed', row: object): LeadPlan` where `LeadPlan = {name, orgKey, events, types, btwdTier|null, stage, funderStatus|null, amount|null, contacts: {name, emails}[], owners: string[]}`.

- [ ] **Step 1: Write failing tests** (synthetic rows only): `parseEvents('2024 BTWD; 2024 Advocacy Summit; 2024 Fundraising Ride')` equals `['BTWD','Advocacy Summit','Fundraising Ride']`; `parseEvents('2018 BTWD / Dinner')` equals `['BTWD','Dinner']`; `normalizeOrgName('AT\\&T ')` equals `normalizeOrgName('at&t')`; `parseEmails('a@x.org, b@x.org')` has length 2; active row with `Scheduled Meeting: TRUE` → stage `Scheduled Meeting`, FALSE → `Research`; prospects row → `Needs Cultivation`; lapsed row → stage `Lost`, funderStatus `Lapsed`; active row with Type `Local` → `btwdTier 'Local'`, blank Type → `null`; blank amount → `null`; Staff Lead "A, B" → two owners.
- [ ] **Step 2: Run** the test file — expect FAIL.
- [ ] **Step 3: Implement** the four functions in `scripts/lib/funding-leads.mjs`. Types default to `['Sponsorship']` for every sheet row (the sheet only holds sponsorships).
- [ ] **Step 4: Run tests** — expect PASS.
- [ ] **Step 5: Commit** `feat(scripts): map sponsor-sheet rows to lead plans`.

### Task 3: `build` command (boards, columns, views)

**Files:**
- Create: `scripts/funding-leads-board.mjs`
- Test: `scripts/funding-leads-board.test.mjs`

**Interfaces:**
- Consumes: `assertSandboxWorkspace`, `LEADS_COLUMNS`, `DEAL_EXTRA_COLUMNS`, `STAGES`.
- Produces: CLI `build --workspace <id> [--organizations <boardId>] [--deals <boardId>] [--apply]`; exported `planBuild(existingBoards, opts): Step[]` (pure: lists boards/columns/views to create given what already exists; creates nothing that exists, matched by `bareTitle`); `main(argv, env)`.

- [ ] **Step 1: Write failing tests** for `planBuild`: with no existing boards it plans Leads creation, all columns, and the three views (Open: Stage not Pledged/Lost; Pledged; Lost); with a Leads board already present it plans only missing columns (idempotent); with `--workspace 10001654` `main` exits 2 before any request (inject a fetch that fails the test if called); default run (no `--apply`) sends no mutation.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** `planBuild` and `main` using `MondayGraphQL` from `../monday-backup/src/monday/graphql.ts`. If a board titled `Deals` exists in workspace 18210301, extend it with `DEAL_EXTRA_COLUMNS`; otherwise plan a regular board named `Opportunities (Deals)`. Never call `duplicate_board`.
- [ ] **Step 4: Run tests** — expect PASS; then dry run against the sandbox: `MONDAY_API_TOKEN=… node scripts/funding-leads-board.mjs build --workspace 18210301` and confirm the printed plan.
- [ ] **Step 5: Apply** with `--apply`, then re-run the dry run: expected plan is empty (idempotent).
- [ ] **Step 6: Commit** `feat(scripts): funding leads board build command`.

### Task 4: `convert` command (Pledged → Deal, idempotent)

**Files:**
- Modify: `scripts/funding-leads-board.mjs`, `scripts/lib/funding-leads.mjs`
- Test: `scripts/funding-leads-board.test.mjs`

**Interfaces:**
- Consumes: board and column ids from `build`.
- Produces: `planConversions(leads: LeadRow[]): {leadId, deal: DealFields}[]` returning only leads whose Stage is Pledged and whose Deal link is empty; CLI `convert --leads <id> --deals <id> [--apply]` that creates each Deal (carrying Organization, Contact, Amount, Owner, Type, Events of interest, Lead link) and then sets the lead's Deal link; a failed link write after a created Deal is reported and exit 2 (never retried blind).

- [ ] **Step 1: Write failing tests**: Pledged lead with empty Deal link → one conversion; Pledged lead already linked → none; non-Pledged → none; calling `planConversions` twice over the same leads after the first result is applied (link set) → empty; a lead moved out of Pledged and back keeps its link → none.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** `planConversions` and the command; the Deal create and link write are separate requests, and the second is guarded by a re-read of the lead's Deal link.
- [ ] **Step 4: Run tests** — expect PASS.
- [ ] **Step 5: Native automation check:** try creating a Monday automation ("when Stage becomes Pledged, notify/trigger") in the sandbox; if a native automation can create the linked Deal with the dedupe guard, record that in the runbook as an alternative; the script remains the tested path. Do not enable anything outside the sandbox.
- [ ] **Step 6: Commit** `feat(scripts): idempotent pledged-to-deal conversion`.

### Task 5: `seed` command

**Files:**
- Modify: `scripts/funding-leads-board.mjs`
- Test: `scripts/funding-leads-board.test.mjs`

**Interfaces:**
- Consumes: `mapSheetRow`, `normalizeOrgName`.
- Produces: CLI `seed --leads <id> --orgs <id> --data <dir> [--apply]` reading `active.csv`, `prospects.csv`, `lapsed.csv` from a gitignored directory (convention: `monday-migration/data/funding-leads/`); `planSeed(plans: LeadPlan[], existingOrgs: Org[]): {orgCreates, leadCreates, reviewPairs}` (pure); writes `review.txt` into `--data` listing near-match org name pairs (never merges them) and counts only; resumable via a ledger file in `--data` so a re-run skips leads already created.

- [ ] **Step 1: Write failing tests** with synthetic data: two rows for the same normalized org → one `orgCreate`; "Applied Materials" vs "Applied Materials Foundation" → two orgs plus one `reviewPairs` entry; an org that already exists on the Organizations board is linked, not created; re-running with a ledger containing a lead skips it; a row with a blank event/type/amount still yields a lead.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** `planSeed` and the command; the report prints counts and ids only, never names or emails.
- [ ] **Step 4: Run tests** — expect PASS.
- [ ] **Step 5: Export the sheet tabs** to CSV into the gitignored data directory (outside `scripts/`), run `seed` dry, review `review.txt` with the user, then run with `--apply`.
- [ ] **Step 6: Commit** `feat(scripts): seed funding leads from the sponsor sheet`.

### Task 6: Smoke test, docs, CI

**Files:**
- Modify: `CLAUDE.md` (add `funding-leads-board.mjs` to the operator-tools list), `docs/runbooks/funding-leads-board.md` (create)
- Test: live sandbox run of the smoke steps below

- [ ] **Step 1: Smoke (sandbox)**: create a test lead, set Stage Pledged, run `convert --apply` → exactly one Deal linked both ways; run `convert --apply` again → zero new Deals; move Stage out and back to Pledged, run again → zero new Deals; delete the smoke items.
- [ ] **Step 2: Guard check:** `node scripts/funding-leads-board.mjs build --workspace 10001654` → exit 2, no request sent.
- [ ] **Step 3: Token scope:** confirm via `node scripts/check-monday-token-scope.mjs --workspace 10001654` that the token used cannot write to production; record the result in the runbook.
- [ ] **Step 4: Run** `node --test scripts/` and `node scripts/check-log-safety.mjs`; expect all pass.
- [ ] **Step 5: Write the runbook** (commands, dry-run/apply, where the seed data lives, how to promote to production later as a separate decision) and add the CLAUDE.md line.
- [ ] **Step 6: Commit** `docs: funding leads board runbook`.

## Self-review notes

- Spec coverage: Type multi-select (T1), Events multi-select (T1), Stage ending at Pledged/Lost and views (T1, T3), hand-off idempotency (T4, T6), seed and sheet mapping (T2, T5), sandbox guard and no-duplicate-board (T1, T3, T6), role-session compatibility is plain board_relations (T1).
- Deviation from the spec, flagged: the spec says the seed runs "from `monday-migration`"; this plan keeps the code in `monday-workers/scripts/` per the operator-tool convention and reads data from `monday-migration`'s gitignored data directory. Same PII outcome, one place for the tests.
