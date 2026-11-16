# Sponsorship Audit History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `donation-rollups` writes a "Sponsorships" section (seven years of paid and in-kind sponsorships, with event and yearly totals) into each Organizations item's description, above Gift History.

**Architecture:** Two new D1 facts per gift (`sponsorship_event`, `in_kind_value_cents`) are read on the recompute path and backfilled by a new custodian duty. A pure renderer turns an owner's `GiftHistoryRow[]` into the section; the consumer prepends it to the existing gift-history markdown for Organizations owners only. Everything is driven by a new optional `donationRollups.sponsorships` config block; absent, nothing changes.

**Tech Stack:** TypeScript Cloudflare Worker (Hono, D1, Queues), vitest, `wrangler`. All commands run from `donation-rollups/`.

**Spec:** `docs/superpowers/specs/2026-11-02-sponsorship-audit-history-design.md`

## Global Constraints

- Config, not hardcoding: every SVBC value (gift type labels, board ids, column ids, year basis, window) lives in `config/svbc.json` / `config/sandbox.json`, validated at startup in `src/config.ts`.
- Absent `donationRollups.sponsorships` (null or missing) = no new reads, no section, no new duty work.
- Qualifying gift: status equals `receivedStatusLabel` (`Received`), not removed, Gift Type in `giftTypes` (cash, valued at Amount) or `inKindGiftTypes` (valued at In-Kind Value, falling back to Amount when In-Kind Value is blank or 0).
- SVBC values: `giftTypes: ["Sponsorship"]`, `inKindGiftTypes: ["In Kind Donation / Sponsorship"]`, `yearBasis: "calendar"`, `windowYears: 7`.
- Section only on the Organizations board's items; placed above `## Gift History`; omitted when no qualifying gift falls in the window.
- Event source order: Sponsorship Cycle text, else linked sponsorship pipeline item's `<event name> <group title>`, else blank (rendered `—`).
- Footer copy: `_Paid and in-kind sponsorships, last {N} {calendar|fiscal} years. Maintained automatically by donation-rollups — edits here are overwritten._`
- Never edit `src/monday/graphql.ts` or `src/flags.ts` (byte-identical copies; CI checks).
- No `console.*` that could log an email address (`node ../scripts/check-log-safety.mjs`).
- Type-check with `npm run typecheck`, never bare `tsc`.

## Review Focus

1. **A gift with no date** (`giftDateISO === ''`) of a sponsorship type — must be left out of the window, not crash or land in year 0. Test in Task 4.
2. **Year rollover with no gift changes** — on Jan 1 (calendar) the window moves; the oldest year must drop off without waiting for a gift edit. Test in Task 6 (`dutiesForDate` adds `sweep` on Jan 1 for calendar basis).
3. **Markdown-breaking event text** (a `|` or newline in Sponsorship Cycle, e.g. multi-select joined with `; `) — must stay inside its cell. Test in Task 4.
4. **A Person owner with in-kind gifts** — must get no Sponsorships section. Test in Task 5.
5. **An in-kind gift with blank Amount entered after go-live** — `getDonationsByIds` skips blank-Amount items, so it never reaches D1. Accepted limitation: Task 7's protocol change tells staff to fill Amount for in-kind sponsorships; Task 3 adds a test pinning that the reader still skips it (so nobody "fixes" it into a $0 gift that changes gift counts).

---

### Task 1: Config block

**Files:**
- Modify: `src/types.ts` (new `SponsorshipsConfig`, `DonationBoardConfig.columns` additions, `DonationRollupsConfig.donationRollups.sponsorships`)
- Modify: `src/config.ts` (new `validateSponsorships`, wired next to `validateDonorLevel`; board column validation)
- Modify: `config/svbc.json`, `config/sandbox.json`
- Test: `src/config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SponsorshipsConfig {
    organizationsBoardId: number;
    giftTypes: string[];
    inKindGiftTypes: string[];
    yearBasis: 'calendar' | 'fiscal';
    windowYears: number;              // integer >= 1
    pipelineBoards: Record<string, string>; // pipeline board id -> event name, e.g. "18391037433": "BTWD"
  }
  // DonationBoardConfig.columns gains (all optional, null/omitted = not configured):
  sponsorshipCycle?: string | null;
  inKindValue?: string | null;
  sponsorshipPipelineLinks?: string[];     // Donations-side reverse connect column ids, one per pipeline board
  // DonationRollupsConfig['donationRollups'] gains:
  sponsorships: SponsorshipsConfig | null;
  ```

- [ ] **Step 1: Write failing tests** in `src/config.test.ts`: `validates a sponsorships block` (SVBC values above parse through unchanged); `sponsorships null or missing parses as null`; `rejects windowYears 0`; `rejects yearBasis "weekly"`; `rejects organizationsBoardId not in ownerColumnsByBoard` (error message contains `donationRollups.sponsorships.organizationsBoardId`); `rejects sponsorshipCycle configured while sponsorships is null` is NOT required — optional columns may exist without the block.
- [ ] **Step 2: Run** `npm test -- src/config.test.ts` — Expected: new tests FAIL.
- [ ] **Step 3: Implement** `validateSponsorships(raw: unknown, ownerBoardIds: string[]): SponsorshipsConfig | null` in `src/config.ts`, following `validateDonorLevel`'s error style (`config: "donationRollups.sponsorships.<key>" ...`), and accept the three optional board columns (string or null; `sponsorshipPipelineLinks` array of non-empty strings).
- [ ] **Step 4: Fill config.** Read column ids live (read-only) with the Monday API: production Donations board `18437909794` columns titled `Sponsorship Cycle`, `In-Kind Value`, and the reverse connect columns created by the five pipelines' two-way Donations connects (`monday-migration` `docs/29`); Organizations board id from `ownerColumnsByBoard` (`18437909779`). `pipelineBoards` for production: `{"18391037433":"BTWD","18390869107":"Advocacy Summit","18390883634":"Fundraising Ride","18391037577":"Misc.","18423176514":"Annual Gala"}`. Sandbox: the sandbox board's equivalents; if the sandbox has no pipeline boards, `pipelineBoards: {}` and no `sponsorshipPipelineLinks`. If a production reverse connect column doesn't exist yet (the board-linking backfill hasn't run), omit it and note it in the PR description.
- [ ] **Step 5: Run** `npm test -- src/config.test.ts` and `npm test -- config/split.test.ts` and `npm run typecheck` — Expected: PASS.
- [ ] **Step 6: Commit** `feat(donation-rollups): sponsorships config block`.

### Task 2: D1 facts

**Files:**
- Create: `migrations/0012_gift_sponsorship_facts.sql`
- Modify: `src/db/gifts.ts` (`GiftFact`, `StoredFacts`, `factsDiffer`, the `refreshFacts` upsert, `giftsForOwner`, two new store methods)
- Modify: `src/projections/giftHistory.ts` (`GiftHistoryRow` gains two fields)
- Test: `src/db/gifts.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // GiftFact gains (undefined = not configured, leave stored; same rule as termStart):
  sponsorshipEvent?: string | null;   // resolved label, '' when read and blank
  inKindValueCents?: number | null;   // 0 when read and blank
  // GiftHistoryRow gains:
  sponsorshipEvent: string | null;    // null = never read
  inKindValueCents: number | null;
  // GiftsStore gains:
  giftsMissingSponsorshipFacts(giftTypes: string[], afterItemId: string, limit: number): Promise<string[]>;
  setSponsorshipFacts(rows: { mondayItemId: string; sponsorshipEvent: string; inKindValueCents: number }[], now: string): Promise<void>;
  ```
- Migration: `ALTER TABLE gifts ADD COLUMN sponsorship_event TEXT;` and `ALTER TABLE gifts ADD COLUMN in_kind_value_cents INTEGER;` with a header comment: NULL = not read yet; '' / 0 = read and blank.

- [ ] **Step 1: Write failing tests** in `src/db/gifts.test.ts`: `refreshFacts stores sponsorshipEvent and inKindValueCents`; `refreshFacts with them undefined leaves stored values` (store `'2024 Summit'`, refresh with undefined, read back `'2024 Summit'`); `a changed sponsorshipEvent counts as a change` (`{ changed: 1 }`); `giftsForOwner returns sponsorshipEvent and inKindValueCents`; `giftsMissingSponsorshipFacts returns only NULL rows of the given types, archived included, removed excluded, ordered by id after the cursor`; `setSponsorshipFacts writes '' and 0 so the row is no longer missing`.
- [ ] **Step 2: Run** `npm test -- src/db/gifts.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** `factsDiffer`: a present (`!= null`) and different value counts, like `termStart`. Upsert: `COALESCE(excluded.x, gifts.x)` for both. `giftsMissingSponsorshipFacts` selects where `(sponsorship_event IS NULL OR in_kind_value_cents IS NULL) AND removed_at IS NULL AND gift_type IN (...) AND monday_item_id > ?`, ordered, limited.
- [ ] **Step 4: Run** `npm test -- src/db/gifts.test.ts` and `npm run typecheck` — Expected: PASS (fix any `GiftHistoryRow` literals in other tests by adding the two fields as `null`).
- [ ] **Step 5: Commit** `feat(donation-rollups): store sponsorship event and in-kind value per gift`.

### Task 3: Reading the facts from Monday

**Files:**
- Modify: `src/monday/client.ts` (`DonationReadColumns`, `DonationRecord`, `getDonationsByIds`, new `getItemsBoardAndGroup`, `DonationRollupsMondayClient` and `CustodianMondayClient` interfaces)
- Test: `src/monday/client.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // DonationReadColumns gains: sponsorshipCycle?: string | null; inKindValue?: string | null; sponsorshipPipelineLinks?: string[];
  // DonationRecord gains (undefined when the column isn't configured):
  sponsorshipCycle?: string | null;       // trimmed text, null when blank
  inKindValueCents?: number | null;       // parseAmountCents of the cell, null when blank
  pipelineItemId?: string | null;         // first linked id across sponsorshipPipelineLinks, null when none
  getItemsBoardAndGroup(itemIds: string[]): Promise<Map<string, { boardId: string; groupTitle: string }>>;
  ```

- [ ] **Step 1: Write failing tests** (mocked GraphQL, same style as existing `getDonationsByIds` tests): `reads sponsorship cycle, in-kind value and pipeline link when configured`; `leaves them undefined when not configured` (and the GraphQL `columnIds` variable doesn't include them); `still skips an item with blank Amount even when In-Kind Value is set` (Review Focus 5); `getItemsBoardAndGroup maps item id to board id and group title`.
- [ ] **Step 2: Run** `npm test -- src/monday/client.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** `getItemsBoardAndGroup` queries `items(ids:, limit: 100) { id board { id } group { title } }` in chunks of 100; missing items are absent from the map.
- [ ] **Step 4: Run** `npm test -- src/monday/client.test.ts` and `npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(donation-rollups): read sponsorship cycle, in-kind value and pipeline link`.

### Task 4: The Sponsorships renderer

**Files:**
- Create: `src/projections/sponsorships.ts`
- Test: `src/projections/sponsorships.test.ts`

**Interfaces:**
- Consumes: `GiftHistoryRow` (Task 2), `SponsorshipsConfig` (Task 1), `FiscalYearConfig`.
- Produces:
  ```ts
  export function buildSponsorshipsMarkdown(
    rows: GiftHistoryRow[], cfg: SponsorshipsConfig, receivedStatusLabel: string,
    fiscalYear: FiscalYearConfig, accountUrl: string, todayISO: string,
  ): string | null;   // null = no qualifying gift in the window
  ```
- Year of a gift: calendar → `giftDateISO.slice(0, 4)`; fiscal → the existing fiscal-year-from-date helper with `fiscalYear.startMonth`, labelled `FY` + two digits. Window: the year containing `todayISO` and the `windowYears - 1` before it.
- Exact layout (newest year first, newest gift first within a year):
  ```markdown
  ## Sponsorships

  | Year | Date | Event | Amount |
  | --- | --- | --- | --- |
  | 2026 | [2026-04-12](<accountUrl>/boards/<board>/pulses/<id>) | 2026 BTWD | $5,000.00 |
  | 2026 | [2026-02-01](…) | 2026 BTWD | $1,200.00 (in-kind) |
  | **2026 total** | | | **$5,000.00 cash · $1,200.00 in-kind** |
  | **Total, 2020–2026** | | | **$5,000.00 cash · $1,200.00 in-kind** |

  _Paid and in-kind sponsorships, last 7 calendar years. Maintained automatically by donation-rollups — edits here are overwritten._
  ```
  A total with no in-kind shows only `**$5,000.00**`; with no cash only `**$1,200.00 in-kind**`. Blank or null event renders `—`. The overall-total label uses the window's first and last year labels.

- [ ] **Step 1: Write failing tests** in `src/projections/sponsorships.test.ts`: `renders the exact layout above for one cash and one in-kind gift` (full string equality); `in-kind uses inKindValueCents, falling back to amountCents when null or 0`; `excludes Pending, Failed, Received (Historical) and other gift types`; `excludes gifts older than the window and keeps the current partial year` (todayISO `2026-11-02`, gifts dated `2019-12-31` out, `2020-01-01` in); `fiscal basis labels FY26 for 2025-07-01..2026-06-30` (startMonth 7); `returns null when nothing qualifies`; `undated gift is excluded` (Review Focus 1); `escapes | and newlines in event text` (Review Focus 3: `'A|B\nC'` renders `A\|B C`); `blank event renders —`.
- [ ] **Step 2: Run** `npm test -- src/projections/sponsorships.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `buildSponsorshipsMarkdown`, reusing `giftHistory.ts`'s `dollars` and `cell` helpers (export them from there rather than copying).
- [ ] **Step 4: Run** the test file and `npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(donation-rollups): sponsorships section renderer`.

### Task 5: Wire into the recompute path

**Files:**
- Modify: `src/consumer/processBatch.ts` (gift facts from `DonationRecord`; event resolution; description write ~line 523)
- Test: `src/consumer/processBatch.test.ts` (or the existing consumer test file that covers the description write)

**Interfaces:**
- Consumes: Tasks 1–4.
- Event resolution, per active donation in the recompute: `record.sponsorshipCycle` when non-empty; else, when `record.pipelineItemId` is set and `getItemsBoardAndGroup` maps it to a board in `cfg.pipelineBoards`, `` `${cfg.pipelineBoards[boardId]} ${groupTitle}` ``; else `''`. Only resolved when `sponsorships` is configured; otherwise `sponsorshipEvent`/`inKindValueCents` stay `undefined` on the `GiftFact`. One `getItemsBoardAndGroup` call per recompute for all pipeline ids.

- [ ] **Step 1: Write failing tests**: `an Organizations owner's description starts with ## Sponsorships then ## Gift History`; `a People owner with an in-kind Received gift gets no Sponsorships section` (Review Focus 4); `event falls back to pipeline board name + group title when Sponsorship Cycle is blank`; `a non-empty Sponsorship Cycle wins over the pipeline link`; `with sponsorships null the description equals buildGiftHistoryMarkdown output exactly` (no behaviour change); `refreshFacts receives sponsorshipEvent and inKindValueCents for configured boards`.
- [ ] **Step 2: Run** the consumer tests — Expected: FAIL.
- [ ] **Step 3: Implement** in `processBatch.ts`: compute `const sponsorships = cfg.sponsorships && ownerBoardId === String(cfg.sponsorships.organizationsBoardId) ? buildSponsorshipsMarkdown(history, …) : null;` and write `sponsorships ? `${sponsorships}\n\n${giftHistoryMd}` : giftHistoryMd` inside the existing non-fatal `setItemDescription` try.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(donation-rollups): Sponsorships section on Organizations`.

### Task 6: Backfill duty and year rollover

**Files:**
- Create: `src/custodian/sponsorships.ts`
- Modify: `src/custodian/custodian.ts` (`DUTIES`, `dutiesForDate`, duty dispatch), `src/custodian/routes.ts` if duties are listed there
- Test: `src/custodian/sponsorships.test.ts`, `src/custodian/custodian.test.ts`

**Interfaces:**
- Consumes: `giftsMissingSponsorshipFacts`, `setSponsorshipFacts` (Task 2); `getItemsColumnsText` (existing).
- Produces: `export async function runSponsorshipsBackfill(deps: CustodianDeps, now: Date): Promise<DutyReport>` with `detail: { backfilled: number; remaining: number }`. Duty name `'sponsorships'` added to `DUTIES`.
- Backfill reads, by item id (archived included), the configured `sponsorshipCycle` and `inKindValue` columns across all donation boards and writes `sponsorshipEvent` = trimmed cycle text or `''`, `inKindValueCents` = parsed cents or `0`. Gift types: `giftTypes ∪ inKindGiftTypes`. Budget `BACKFILL_PER_RUN` = 5,000 per run in batches of 500, cursor by item id, like `backfillTermStarts`. It does not read pipeline links (archived items read them empty; Task 5 covers active gifts).

- [ ] **Step 1: Write failing tests**: `backfills NULL facts for sponsorship and in-kind gifts only`; `writes '' and 0 for blank cells so they aren't re-read`; `stops at the per-run budget and reports remaining > 0`; `is a no-op reporting 0 when sponsorships is null`; in `custodian.test.ts`: `dutiesForDate runs sponsorships nightly when configured`, `re-runs sponsorships while its last report has remaining > 0`, `adds sweep on January 1 when yearBasis is calendar` (Review Focus 2), `does not add a January sweep for fiscal basis or when sponsorships is null`.
- [ ] **Step 2: Run** `npm test -- src/custodian` — Expected: FAIL.
- [ ] **Step 3: Implement.** `dutiesForDate` needs the sponsorships config: change its signature to accept it as an optional trailing parameter and pass it from the cron handler.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`, `node ../scripts/check-log-safety.mjs` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(donation-rollups): sponsorships backfill duty and January sweep`.

### Task 7: Docs and rollout

**Files:**
- Modify: `donation-rollups/README.md` (new "Sponsorships section" part: config block, event sources, duty, the Item description widget prerequisite on Organizations, the D1 owner check below, rollout order)
- Modify (`monday-migration` repo, its own worktree): `protocols/monday/reporting-grants-and-sponsorships.md` (new "Answering a sponsor's audit request" part; in-kind sponsorships must have Amount filled and be connected to their pipeline item), `protocols/monday/entering-payments.md` and `protocols/monday/donor-data-entry-and-acknowledgement.md` if they don't already say a sponsorship's Donor is the company and it's connected to its pipeline item; `docs/23-cutover-runbook.md` (rollout steps below)

- [ ] **Step 1: README.** Include the read-only owner check, run with `wrangler d1 execute` against the production D1: count `Received` gifts of the configured sponsorship types by `owner_board_id`; expected all but a handful on the Organizations board (production load: 848 of 865 `Sponsorship`; the 17 person-owned have no Organizations match and are listed for staff by item id, year and amount only).
- [ ] **Step 2: Rollout steps in `docs/23`**, in order: confirm the **Item description** widget on the production Organizations item view; set `donation-rollups:writes` per the write-switch runbook; `npm run deploy:sandbox`, apply migration 0012 to sandbox D1, run `POST /custodian/run/sponsorships` until `remaining: 0`, `POST /custodian/run/sweep` until done, then paste one company's section into a Gmail draft and confirm it stays a table; repeat for production with `npm run deploy`; spot-check three long-history sponsors against the sponsor history sheet.
- [ ] **Step 3: Protocol text** as listed above, then copy each changed protocol into its Box Note by hand (README of `protocols/monday` lists the note ids) and point the Sponsorships board description's "earlier years" line at the company card (the five pipelines merged into it on 2026-11-03) (keep the sheet link as the full archive).
- [ ] **Step 4: Commit** each repo's docs separately: `docs(donation-rollups): sponsorships section` and `docs(protocols): answering a sponsor's audit request`.
