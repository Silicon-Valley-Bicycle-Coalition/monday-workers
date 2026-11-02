# Donor Roll Call board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A nightly `rollcall` custodian duty in `donation-rollups` that keeps a Donor Roll Call board current: one item per household or organization per fiscal year (FY2026 on, plus the year in progress), with total, tier and review notes.

**Architecture:** Pure computation (`src/rollcall/compute.ts`) ported from monday-migration's `scripts/donor-roll-call.mjs`. It's fed by the D1 `gifts` ledger and a new duty-owned D1 table, `roll_call_credits`, which holds the gifts the ledger can't credit (matching with Matched By, Anonymous Donor, no Donor). The duty refreshes that table from active Donations items, reads People and Organizations, computes rows, and diffs them against the board by Row Key. Writes go through the existing write switch.

**Tech Stack:** TypeScript, Cloudflare Workers + D1, Hono, vitest (`npm test` in `donation-rollups/`), monday.com GraphQL (API 2025-10), Node `.mjs` setup scripts.

**Spec:** `docs/superpowers/specs/2026-11-02-donor-roll-call-board-design.md` (read it first; this plan argues from it).

## Global Constraints

- Tiers, highest first: `$50,000+`, `$25,000+`, `$10,000+`, `$5,000+`, `$2,500+`, `$1,000+`, `$500+`, `$100+`, else `Under $100`.
- Counted statuses: `Received`, `Received (Historical)`. Default excluded Gift Types: `["Contracts"]`. Matching Gift Type label: `Matching Donation`.
- `rollCall.firstFiscalYear` = 2026. Fiscal Year is written as text ("2026"), never a number.
- Row Key format: `<FY>|household:<Household ID>`, `<FY>|item:<itemId>`, `<FY>|anonymous`.
- Group title: `FY<year>` for a closed year, `FY<year> (in progress)` for the current one.
- Listed status labels: `Listed`, `Don't list`. Type labels: `Household`, `Individual`, `Organization`, `Anonymous`.
- New People/Organizations column titles: `Don't List in Recognition` (checkbox, all three boards) and `Recognition Name` (text, Organizations only).
- Anonymous Donor wins over a Donor link; a Matching Donation with Matched By goes to the company even when anonymous.
- `rollCall: null` in config turns the duty off. All money is integer cents internally (`src/money.ts`).
- Every Monday or D1 write goes through the write switch: new mutators get registered in `src/writeSwitch.ts`.

## Review Focus

1. **Two people joined into a household after their rows exist.** Their two Individual rows for that year are deleted and one Household row is created, closed years included (the key positively changed). Covered in Task 5.
2. **A duplicate Row Key on the board** (an ambiguous `createItem` that committed, then retried). Keep the oldest item, delete the rest, and never create a third. Covered in Task 5.
3. **A gift on a Donations item that drops out of the active read.** Archived means the credit row is kept and frozen; deleted means the row is removed. Never decide from absence alone; check `state`. Covered in Task 4.
4. **The write cap hits mid-run.** Report `remaining > 0`; `dutiesForDate` re-runs `rollcall` next night until it completes, with no double creates. Covered in Tasks 5 and 6.
5. **A household spanning People and People (Historical).** Members from both boards group by Household ID into one row. Covered in Task 1.

---

### Task 1: Roll call computation

**Files:**
- Create: `donation-rollups/src/rollcall/compute.ts`
- Test: `donation-rollups/src/rollcall/compute.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const TIERS_CENTS: readonly number[]; // [5_000_000, 2_500_000, 1_000_000, 500_000, 250_000, 100_000, 50_000, 10_000]
  export function tierFor(cents: number): string;
  export const RECEIVED_LABELS: readonly string[];  // ['Received', 'Received (Historical)']
  export interface CountedGift { giftItemId: string; fiscalYear: number; cents: number; credit: string; unmatchedMatch: boolean }
  //   credit = 'item:<id>' | 'anonymous' | 'unplaced'
  export interface DonorRecord { kind: 'person' | 'organization'; name: string; recognitionName: string;
    householdId: string; householdEmail: string; doNotSolicit: boolean; dontList: boolean }
  //   recognitionName = Household Greeting for a person, Recognition Name for an organization ('' when blank)
  export interface RollCallRow { key: string; fiscalYear: number; name: string; tier: string;
    type: 'Household' | 'Individual' | 'Organization' | 'Anonymous'; listed: 'Listed' | "Don't list";
    totalCents: number; gifts: number; personIds: string[]; organizationId: string | null; reviewNote: string }
  export function buildRollCall(gifts: CountedGift[], donors: Map<string, DonorRecord>):
    { rows: RollCallRow[]; unplaced: { gifts: number; cents: number } };
  ```
  `buildRollCall` groups per fiscal year, then per household (Household ID) or item, like the script's `buildRollCall`. Port its review-note wording exactly ("Do Not Solicit is checked on …", "includes $X.XX of employer matching with no Matched By company", "shares a Household Email with … — same household?", "members' Household Greetings differ: …"), joined with `; `. `listed` is `Don't list` when any member (or the organization) has `dontList`. `personIds` lists every member of the household, including those with no gifts that year. A credit of `unplaced`, or to an item not in `donors`, counts toward `unplaced`. Rows are sorted by fiscal year desc, then total desc, then name.

- [ ] **Step 1: Write the failing tests** in `compute.test.ts` (vitest), covering:
  - `tierFor(5_000_000) === '$50,000+'`, `tierFor(249_999) === '$1,000+'`, `tierFor(10_000) === '$100+'`, `tierFor(9_999) === 'Under $100'`.
  - A household (`HH1`: p10 on board People, p11 from People (Historical); same map) with gifts 30_000 + 10_000 cents in FY2026 gives one row: `key '2026|household:HH1'`, `type 'Household'`, `totalCents 40_000`, `gifts 2`, `personIds ['p10','p11']`, `name` = the greeting.
  - The same people with one gift in FY2026 and one in FY2027 give two rows with keys `2026|…` and `2027|…`.
  - An organization with `recognitionName ''` is named by `name`; with `'Acme Foundation'`, by that.
  - `dontList` on one household member gives `listed "Don't list"`; `doNotSolicit` gives the note.
  - `credit 'anonymous'` gifts pool into one `2026|anonymous` row with `type 'Anonymous'`, empty `personIds`.
  - `unmatchedMatch` gifts give the matching note with dollars to two decimals.
  - Shared Household Email across two keys gives the note on both rows. Differing greetings give the greetings note.
  - A credit to an unknown item is counted in `unplaced` and makes no row.
- [ ] **Step 2: Run** `npx vitest run src/rollcall/compute.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `compute.ts` to the interfaces above, using integer cents. Format dollars with `formatCents` from `src/money.ts`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(donation-rollups): roll call computation`.

### Task 2: Config block

**Files:**
- Modify: `donation-rollups/src/types.ts` (add `RollCallConfig`; `donationRollups.rollCall: RollCallConfig | null`)
- Modify: `donation-rollups/src/config.ts` (add `validateRollCall`, wire it like `validateRecurringGifts`)
- Modify: `donation-rollups/config/sandbox.json`, `donation-rollups/config/svbc.json` (`"rollCall": null`)
- Test: `donation-rollups/src/config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RollCallConfig {
    boardId: number;
    firstFiscalYear: number;                 // 2026
    excludedGiftTypes: string[];             // default ["Contracts"] when the key is absent
    writesPerRun: number;                    // default 500
    columns: { fiscalYear: string; tier: string; type: string; listed: string; total: string; gifts: string;
      people: string; organization: string; reviewNote: string; rowKey: string };
    donations: { boardId: number; columns: { amount: string; status: string; fiscalYear: string; giftType: string;
      donorLink: string; matchedBy: string; anonymous: string } };
    people: Record<string, { householdId: string; householdGreeting: string; householdEmail: string;
      doNotSolicit: string; dontList: string }>;   // keyed by People / People (Historical) board id
    organizations: { boardId: number; columns: { recognitionName: string; dontList: string } };
  }
  ```
- [ ] **Step 1: Write failing tests:** a full valid block parses, with the defaults applied for an absent `excludedGiftTypes` and `writesPerRun`. `rollCall: null` gives `null`. A missing column id throws an error naming its path (e.g. `donationRollups.rollCall.columns.rowKey`). `firstFiscalYear` that isn't an integer throws.
- [ ] **Step 2: Run** `npx vitest run src/config.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** `validateRollCall(raw: unknown): RollCallConfig | null` with the existing `columnId()` helper, and add `rollCall` to the returned config. Set `"rollCall": null` in both JSON configs.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS (other tests' config fixtures may need `rollCall: null`).
- [ ] **Step 5: Commit** `feat(donation-rollups): rollCall config block`.

### Task 3: D1 — credits table and a fiscal-year gift read

**Files:**
- Create: `donation-rollups/migrations/0011_roll_call_credits.sql`
- Create: `donation-rollups/src/db/rollCallCredits.ts`
- Modify: `donation-rollups/src/db/gifts.ts` (add `countedGifts`)
- Modify: `donation-rollups/src/writeSwitch.ts` (dry-run proxy for the new store)
- Modify: `donation-rollups/src/custodian/custodian.ts` (`CustodianDeps.rollCallCredits`), `donation-rollups/src/index.ts` (wire `new D1RollCallCreditsStore(env.DB)`)
- Test: `donation-rollups/src/db/rollCallCredits.test.ts`, and add a `countedGifts` test to the existing gifts store test file

**Interfaces:**
- Produces:
  ```sql
  CREATE TABLE roll_call_credits (gift_item_id TEXT PRIMARY KEY, fiscal_year INTEGER NOT NULL,
    amount_cents INTEGER NOT NULL, status TEXT NOT NULL, gift_type TEXT, credit TEXT,
    unmatched_match INTEGER NOT NULL DEFAULT 0, archived_at TEXT, updated_at TEXT NOT NULL);
  CREATE INDEX idx_roll_call_credits_fy ON roll_call_credits (fiscal_year);
  ```
  ```ts
  export interface CreditRow { giftItemId: string; fiscalYear: number; amountCents: number; status: string;
    giftType: string | null; credit: string | null; unmatchedMatch: boolean; archivedAt: string | null }
  //   credit null = "ledger credits this gift" (a row kept only to carry unmatchedMatch)
  export interface RollCallCreditsStore {
    all(fromFY: number): Promise<CreditRow[]>;
    upsert(rows: CreditRow[], now: string): Promise<number>;          // diff-only; returns rows written
    remove(giftItemIds: string[]): Promise<void>;
    markArchived(giftItemIds: string[], now: string): Promise<void>;
  }
  // GiftsStore addition:
  countedGifts(fromFY: number): Promise<{ mondayItemId: string; ownerItemId: string; fiscalYear: number;
    amountCents: number; status: string; giftType: string | null }[]>;   // removed_at IS NULL
  ```
  `credit` is nullable so the `unmatched_match` flag for a ledger-credited gift (an employer match with no Matched By but a Donor) lives in the same table without crediting anyone else.
- [ ] **Step 1: Write failing tests** against the D1 test binding the other `src/db/*.test.ts` use: `upsert` writes once and is a no-op on an identical second call (returns 0); `markArchived` stamps `archived_at`; `all(2026)` leaves out FY2025; `countedGifts(2026)` leaves out removed gifts and earlier years.
- [ ] **Step 2: Run** `npx vitest run src/db`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the migration (see `test/apply-migrations.ts` for how tests pick it up), the store and `countedGifts`. Add `ROLLCALL_MUTATORS = ['upsert','remove','markArchived']` and a dry-run wrapper in `custodianDepsFor`.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(donation-rollups): roll_call_credits table and countedGifts`.

### Task 4: Refresh the credits from active Donations

**Files:**
- Modify: `donation-rollups/src/monday/client.ts` (new reads)
- Modify: `donation-rollups/src/custodian/custodian.ts` (`CustodianMondayClient` additions)
- Create: `donation-rollups/src/rollcall/credits.ts`
- Test: `donation-rollups/src/rollcall/credits.test.ts`

**Interfaces:**
- Consumes: `RollCallConfig` (Task 2), `RollCallCreditsStore` / `CreditRow` (Task 3).
- Produces:
  ```ts
  // client.ts / CustodianMondayClient
  pageDonationCredits(cfg: RollCallConfig['donations'], cursor: string | null): Promise<{ cursor: string | null; items: {
    id: string; fiscalYear: number; amountCents: number; status: string | null; giftType: string;
    donorItemIds: string[]; matchedByItemIds: string[]; anonymous: boolean }[] }>;
  getItemsState(itemIds: string[]): Promise<Map<string, 'active' | 'archived' | 'deleted'>>; // missing id = deleted
  // credits.ts
  export type DonationCreditItem = Awaited<ReturnType<CustodianMondayClient['pageDonationCredits']>>['items'][number];
  export function creditFor(item: DonationCreditItem, excludedGiftTypes: string[]):
    { credit: string | null; unmatchedMatch: boolean } | 'ledger' | 'skip';   // received = RECEIVED_LABELS (Task 1)
  export async function refreshCredits(deps: CustodianDeps, cfg: RollCallConfig, now: string):
    Promise<{ upserted: number; removed: number; archived: number }>;
  ```
  `creditFor` rules (spec §3): excluded type or not received → `'skip'`. A matching gift with Matched By → `item:<matchedBy>`. Anonymous → `anonymous`. No Donor and no flag → `unplaced`, so the duty's report counts it and alerts. A matching gift with no Matched By and a Donor → `{ credit: null, unmatchedMatch: true }`. Otherwise `'ledger'` (no row).
  `refreshCredits` pages every active item. It upserts each one that yields a row and removes rows for active items that now yield `'ledger'` or `'skip'`. Stored rows with `archived_at IS NULL` that didn't appear get resolved with `getItemsState`: `archived` → `markArchived`, `deleted` → `remove`, `active` → leave alone (paging race). Rows already archived are never touched.
- [ ] **Step 1: Write failing tests** for `creditFor`'s six outcomes and for `refreshCredits` with a fake client and an in-memory store:
  - an active anonymous gift is upserted;
  - it disappears from the active read and `getItemsState` says `archived`: kept, `archivedAt` set;
  - one that says `deleted`: removed;
  - an already-archived row whose item reads back with empty connect columns is never rewritten.
- [ ] **Step 2: Run** `npx vitest run src/rollcall/credits.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the two client methods: `items_page(limit: 500)` reading the seven columns with `linked_item_ids`, and `items(ids:, limit: 100){ id state }` in chunks of 100 (README: `items(ids:)` defaults to 25 without `limit`). Then implement `credits.ts`. Parse amounts with `parseAmountCents`, the checkbox from its `value` JSON `{"checked":true}`, and status with the client's `statusLabel`.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(donation-rollups): roll call credits from active Donations`.

### Task 5: Board diff and sync

**Files:**
- Modify: `donation-rollups/src/monday/client.ts`, `donation-rollups/src/custodian/custodian.ts` (`CustodianMondayClient` additions), `donation-rollups/src/writeSwitch.ts` (proxy the new writes)
- Create: `donation-rollups/src/rollcall/sync.ts`
- Test: `donation-rollups/src/rollcall/sync.test.ts`

**Interfaces:**
- Consumes: `RollCallRow` (Task 1), `RollCallConfig` (Task 2).
- Produces:
  ```ts
  // client additions
  listGroups(boardId: number): Promise<{ id: string; title: string }[]>;
  createGroup(boardId: number, title: string): Promise<string>;        // not idempotent
  updateGroupTitle(boardId: number, groupId: string, title: string): Promise<void>;
  createItemInGroup(boardId: number, groupId: string, name: string, columnValues: Record<string, unknown>): Promise<string>;
  moveItemToGroup(itemId: string, groupId: string): Promise<void>;
  deleteItem(itemId: string): Promise<void>;
  pageItemsColumnsText  // existing; add `name` and `groupId` to ItemColumns (optional fields, so existing callers are unaffected)
  // sync.ts
  export interface BoardItem { id: string; name: string; groupId: string; cells: Map<string, string | null> }
  export type SyncOp = { op: 'create'; row: RollCallRow } | { op: 'update'; itemId: string; row: RollCallRow; values: Record<string, unknown> }
    | { op: 'move'; itemId: string; fiscalYear: number } | { op: 'delete'; itemId: string; reason: 'gone' | 'duplicate' };
  export function columnValuesFor(row: RollCallRow, cols: RollCallConfig['columns']): Record<string, unknown>;
  export function planSync(rows: RollCallRow[], items: BoardItem[], cols: RollCallConfig['columns'],
    frozenYears: Set<number>, groupYearById: Map<string, number>): SyncOp[];
  export async function applySync(deps: CustodianDeps, cfg: RollCallConfig, ops: SyncOp[], currentFY: number):
    Promise<{ applied: number; remaining: number }>;   // caps at cfg.writesPerRun
  ```
  `planSync` matches items by the Row Key cell:
  - **duplicates:** keep the lowest item id; the rest are `delete duplicate`.
  - **missing:** `create`.
  - **differing cells or name:** `update`, with only the differing columns in `values`.
  - **wrong group:** `move`.
  - **key not computed:** `delete gone`, **unless** its fiscal year is in `frozenYears` (closed years whose gifts are all archived) **and** none of its people or organization appear in any computed row of that year. A household join changes the key and does delete; a donor who simply vanished from the inputs doesn't.

  Status columns are written as `{ label }`, the people connect column as `{ item_ids: [...] }`, numbers in dollars from cents, the long text as `{ text }`.

  `applySync` makes year groups first: create a missing group, or retitle one so the current year reads "(in progress)" and closed years don't. Then it applies deletes, updates, moves and creates, stopping at `writesPerRun`.
- [ ] **Step 1: Write failing tests** for `planSync`:
  - an identical board gives no ops;
  - a changed total gives one `update` touching only `total` (and `tier` if it moved);
  - **Review Focus 1:** two Individual items replaced by one Household row in a frozen year give two `delete gone` plus one `create`;
  - an item for a frozen year whose donor isn't in any row is kept;
  - **Review Focus 2:** two items with the same key give one `delete duplicate` (the higher id) and no create;
  - an item in the wrong year group gives `move`.

  Then for `applySync` with a fake client: writes stop at `writesPerRun` and the leftovers count as `remaining`, and a missing year group gets created before the items that go in it.
- [ ] **Step 2: Run** `npx vitest run src/rollcall/sync.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the client methods (`create_group`, `update_group(board_id, group_id, group_attribute: title, new_value)`, `create_item(group_id:)`, `move_item_to_group`, `delete_item`; read `name` and `group { id }` in `pageItemsColumnsText`) and `sync.ts`. In `custodianDepsFor`, `createGroup` and `createItemInGroup` return `dry-run-<n>`; the other new writes are `undefined` (recorded, not sent).
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(donation-rollups): roll call board sync`.

### Task 6: The `rollcall` duty

**Files:**
- Create: `donation-rollups/src/custodian/rollcall.ts`
- Modify: `donation-rollups/src/custodian/custodian.ts` (`DUTIES`, `runDuty`, `dutiesForDate`), `donation-rollups/src/custodian/routes.test.ts`
- Test: `donation-rollups/src/custodian/rollcall.test.ts`, `donation-rollups/src/custodian/custodian.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: `export async function runRollCall(deps: CustodianDeps, now: Date): Promise<DutyReport>`, where `detail: { rows: number; unplaced: { gifts: number; cents: number }; credits: {...}; applied: number; remaining: number }`.

  Order, per the spec §5:
  1. `rollCall` null → `{ ok: true, summary: 'rollcall: not configured, skipped' }`.
  2. `refreshCredits`.
  3. `gifts.countedGifts(firstFY)` filtered by status/excluded type, minus gifts that have a credits row with `credit !== null`, plus the credits rows (with `unmatchedMatch` carried onto the ledger gift).
  4. Read People boards and Organizations into `DonorRecord`s.
  5. `buildRollCall`.
  6. Page the board.
  7. `planSync` with `frozenYears` = every FY from `firstFiscalYear` to `currentFY - custodian.activeFiscalYears` inclusive. Those years' gifts are all archived.
  8. `applySync`.

  `ok` is false when `unplaced.gifts > 0`, so the existing `alert` fires.
- [ ] **Step 1: Write failing tests:**
  - one end-to-end `runRollCall` with fakes: a ledger gift, an anonymous credit, a household and an org produce the expected creates;
  - `dutiesForDate` includes `rollcall` every night;
  - **Review Focus 4:** a last `rollcall` report with `detail.remaining > 0` keeps it in the list (add it to the continuation loop next to `classify`);
  - `POST /custodian/run/rollcall` is accepted by the route.
- [ ] **Step 2: Run** `npx vitest run src/custodian`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** `rollcall.ts`, then add `'rollcall'` to `DUTIES`, to `runDuty`, to the nightly list and to the continuation loop.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(donation-rollups): nightly rollcall duty`.

### Task 7: Setup script and README

**Files:**
- Create: `donation-rollups/scripts/setup-roll-call-board.mjs` (pattern: `scripts/setup-annual-summary-board.mjs`)
- Modify: `donation-rollups/README.md` (new section "Donor Roll Call board")

**Interfaces:**
- Produces: `node scripts/setup-roll-call-board.mjs --workspace <id> [--name "Donor Roll Call"] [--board <id>] --people <id>[,<id>] --organizations <id> --donations <id>`. It's idempotent: same-titled columns are reused.

  It creates the board and the eleven columns from spec §4. Status columns are seeded with their labels: Tier's nine, Type's four, Listed's two. It adds `Don't List in Recognition` (checkbox) to each `--people` board and `--organizations`, and `Recognition Name` (text, with the spec's description) to Organizations. It looks up the existing column ids by title: Household ID, Household Greeting, Household Email, Do Not Solicit on People; Amount, Status, Fiscal Year Ending, Gift Type, Donor, Matched By, Anonymous Donor on Donations. Then it prints the complete `rollCall` JSON block with `firstFiscalYear: 2026`.

  Saved views: try `create_view` with a filter and sort. If the API can't express them, print the three views (spec §4) as manual steps.
- [ ] **Step 1: Run against sandbox v4** (People `18437342592`, People (Historical) `18437342607`, Organizations `18437342579`, Donations `18437342657`, workspace `18210301`). First add Household ID / Household Greeting there with monday-migration's `copy-household-greetings.mjs` (pointed at the sandbox boards). Expected: the board exists and a JSON block prints.
- [ ] **Step 2: Paste the block into `config/sandbox.json`**, then run `npm test`. Expected: PASS (`config/split.test.ts`-style checks still hold).
- [ ] **Step 3: Write the README section:** what the board is, the duty, the credits table and why it exists (spec §6), the setup steps, the config block, and the manual views if any.
- [ ] **Step 4: Commit** `feat(donation-rollups): roll call board setup script, sandbox config, README`.

### Task 8: Sandbox, then production, then retire the script

**Files:**
- Modify: `donation-rollups/config/svbc.json`
- monday-migration (separate repo, `main`): `protocols/monday/donor-roll-call.md`, `docs/40-donor-roll-call.md`, `CLAUDE.md`; delete `scripts/donor-roll-call.mjs` and its test at the end

- [ ] **Step 1: Sandbox.** Apply migration 0011 to the sandbox D1 (`wrangler d1 migrations apply … --remote --env sandbox`), `npm run deploy:sandbox`, then `POST /custodian/run/rollcall` (Bearer `CUSTODIAN_SECRET`) until `remaining` is 0. Expected: rows in FY groups; a Don't List checkbox flips a row's Listed on the next run.
- [ ] **Step 2: Production setup.** Run the setup script with People `18437909781`, People (Historical) `18437909784`, Organizations `18437909779`, Donations `18437909794`, workspace `18201685`, and paste the block into `config/svbc.json`. Apply 0011 to the production D1 **before** deploying (README deploy-order rule), then `npm run deploy`.
- [ ] **Step 3: Run `rollcall` until `remaining` is 0, then compare FY2026** with monday-migration's script: `node --env-file=.env scripts/donor-roll-call.mjs … --out backup/donor-roll-call-FY2026.csv`, matching board rows by Row Key ↔ the CSV's Monday Item IDs. Expected: same rows and totals to the cent. The only explained difference allowed is a gift with Anonymous Donor checked *and* a Donor, which the board puts on Anonymous. Record the result in monday-migration `docs/40` §5.
- [ ] **Step 4: Update monday-migration:**
  - the protocol: open the Donor Roll Call board, use the "Last closed year" view and export it; plus the two new columns and how they carry forward. Then edit Box Note `2566398832240` by hand to match.
  - `docs/40`: the board replaces the script.
  - `CLAUDE.md`: remove the script's command line.
  - Delete `scripts/donor-roll-call.mjs` and `scripts/test/donor-roll-call.test.mjs`.

  Then run `node --test scripts/test/*.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** in each repo; open the monday-workers MR for `feat/donor-roll-call-board`.
