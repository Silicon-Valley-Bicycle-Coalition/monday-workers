# Affiliation Model, Plan 2 of 4: `donation-rollups` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `donation-rollups` keep the affiliation model's money rollups live after cutover:
per-affiliation **Attributed Giving / Attributed Gift Count / Last Attributed Gift** on the
Affiliations board and per-person **Organizational Giving** on the People boards, recomputed from
the D1 ledger every time a Donation changes, reconciled nightly, and bootstrapped from the
importer's artifacts like every other projection this Worker owns.

**Architecture:** The existing webhook → D1 → Queue → consumer path is unchanged; the consumer
gains a second phase after the owner write. The D1 `gifts` ledger learns each gift's **Acting for**
affiliation (a new column, read from the Donation's connect column), a new `affiliations` table
maps affiliation items to their Person (refreshed from Monday on every affiliation recompute,
bootstrapped from artifacts), and two new pure rollups are computed from those rows and written
to the Affiliations board and the person's board. Everything is gated on one config block
(`affiliations`, `null` until the Affiliations board exists) so the Worker stays deployable against
the current sandbox. Non-money rollups are deferred (see Scope).

**Tech Stack:** Hono + TypeScript strict, Cloudflare D1 (migrations in `migrations/`), Cloudflare
Queues, Vitest with `@cloudflare/vitest-plugin` (real D1 in tests, `env.DB` from
`cloudflare:test`), Monday.com GraphQL API (`API-Version: 2026-01`). Commands run from
`donation-rollups/`: `npm test`, `npm run typecheck`.

**Spec:** [`docs/superpowers/specs/2026-09-08-person-org-email-model-design.md`](../specs/2026-09-08-person-org-email-model-design.md) — sections "Data model" (Affiliations board rollup columns, People `Organizational Giving`), "Rollups", and the 2026-09-11 Donor-link decision in "Decision history".

**Plan 1 (done, merged as [GL!50](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/merge_requests/50) plus the Donor-link follow-up):** `salesforce-import` now emits the
Affiliations board, `Acting for` + `Attribution` on Donations and Event Registrations, seed values
for the three attributed columns and `Organizational Giving`, and points an attributed org gift's
**Donor at the organization**. This Worker reads Donor as written; it never re-points it.

## Scope rulings

- **Money only.** The spec's non-money rollups (Attributed Registrations, Volunteer Hours,
  Activities) are deferred to a plan after Plan 3: `Acting for` does not exist on Volunteers or
  Activities until the resolver provisions it, and counting registrations rides the same webhook
  the resolver will subscribe. One pass later is cheaper than two.
- **Post-cutover Donor re-pointing is Plan 3's job.** When the resolver attributes a new org gift
  it must also set Donor to the organization (the importer's `giftDonorSfId` rule); this Worker's
  personal rollups then exclude it automatically.
- **Affiliation → Person is read from Monday on every affiliation recompute**, not cached
  forever: one `items(ids:)` call per affected affiliation (typically one or two per run), which
  keeps a staff re-point of an affiliation's Person from going stale. D1 `affiliations` is the
  bootstrap and the previous-person memory, not the source of truth.
- **Archived gifts keep their stored `acting_for_item_id`.** An archived item's `board_relation`
  reads empty (README, "Archived donations and this Worker"), so the refresh rule is: active gift →
  take Monday's value verbatim (clearing is allowed); archived gift → keep D1's value.

## Global Constraints

- TypeScript strict; `npm run typecheck` (runs `wrangler types` then `tsc --noEmit`) must be clean.
- Every D1-backed module gets a Vitest test against the real D1 binding (`env.DB` from
  `cloudflare:test`), never a hand-rolled `D1Database` mock. Consumer and custodian tests use the
  `vi.fn()` fakes in `src/consumer/processBatch.test.ts` / `src/custodian/custodian.test.ts`,
  extended for the new store methods.
- Rollups count gifts whose status equals `config.donationRollups.receivedStatusLabel` exactly
  (`'Received'`), the same filter as `computeRollup`. Amounts are integer cents in D1 and written
  to Monday as dollars via `String(cents / 100)`.
- All new behavior is gated on `config.affiliations !== null`. With it `null`, every existing
  test must pass unchanged and the consumer must make no additional Monday calls.
- Column ids in `config/svbc.json` for the Affiliations board are `null` placeholders until the
  next sandbox load creates the board; tests run entirely against mocks and D1.
- Monday `items(ids:)` calls pass `limit: 100` explicitly and chunk by 100 (README: the silent-25
  default). The Workers Free plan caps subrequests at 50 per invocation; the reconcile legs added
  here must slice like the existing ones.
- No new webhook subscriptions: a change to a Donation's `Acting for` column fires the existing
  `change_column_value` subscription on the Donations board.
- Conventional commits, one commit per task, in a worktree
  (`git worktree add ../monday-workers-rollups-affiliations -b feat/rollups-affiliations main`).

---

## File structure

| File | Responsibility |
|---|---|
| `migrations/0005_affiliations.sql` (create) | `gifts.acting_for_item_id` + index; `affiliations` table |
| `src/types.ts`, `src/config.ts`, `config/svbc.json` (modify) | `affiliations` config block, `actingForLink` on donation boards, optional `organizationalGiving` owner column |
| `src/db/gifts.ts` (modify) | `actingForItemId` in `GiftFact`/`refreshFacts`; `actingForByIds`, `attributedTotals`, `organizationalGivingTotals` |
| `src/db/affiliations.ts` (create) | `D1AffiliationsStore`: upsert / get / forPerson / bulkUpsert |
| `src/monday/client.ts` (modify) | `actingForItemId` in `DonationRecord`; `getAffiliationSummary` |
| `src/rollups/attributed.ts` (create) | pure `computeAttributedRollup`, `attributedToColumnValues` |
| `src/consumer/processBatch.ts` (modify) | phase 2: affiliation + person recompute after the owner write |
| `src/projections/giftHistory.ts` (modify) | 6th tuple element; "Driven for organizations" markdown section |
| `src/custodian/custodian.ts` (modify) | reconcile legs 5 (affiliations) and 6 (Organizational Giving) |
| `scripts/bootstrap-gifts-lib.mjs`, `scripts/bootstrap-gifts-from-artifacts.mjs` (modify) | `acting_for_item_id` column; `affiliations` rows from the same artifacts |
| `scripts/setup-affiliation-columns.mjs` (create) | ensures the three Affiliations columns + People `Organizational Giving`; prints config |
| `README.md` (modify) | the new phase, the gate, bootstrap and setup steps |

---

## Task 1: Migration, types, config

**Files:**
- Create: `migrations/0005_affiliations.sql`
- Modify: `src/types.ts`, `src/config.ts`, `config/svbc.json`
- Test: `src/config.test.ts` (create)

**Interfaces:**
- Produces:
  ```ts
  // types.ts
  export interface AffiliationsConfig {
    boardId: number;
    columns: { personLink: string; attributedGiving: string; attributedGiftCount: string; lastAttributedGift: string };
  }
  // DonationBoardConfig.columns gains: actingForLink: string | null;
  // OwnerColumns gains: organizationalGiving?: string;   // People boards only
  // DonationRollupsConfig gains: affiliations: AffiliationsConfig | null;
  ```
  D1: `gifts.acting_for_item_id TEXT` (nullable) with index `idx_gifts_acting_for`; table
  `affiliations (affiliation_item_id TEXT PRIMARY KEY, person_item_id TEXT NOT NULL, person_board_id TEXT NOT NULL, name TEXT NOT NULL, updated_at TEXT NOT NULL)` with index `idx_affiliations_person`.

- [ ] **Step 1: Write the failing config test**

```ts
// src/config.test.ts
import { describe, it, expect } from 'vitest';
import { validateConfig } from './config';
import rawConfig from '../config/svbc.json';

const base = () => JSON.parse(JSON.stringify(rawConfig)) as Record<string, any>;

describe('validateConfig — affiliations block', () => {
  it('accepts affiliations: null (feature gated off) and leaves actingForLink null', () => {
    const cfg = validateConfig(base());
    expect(cfg.affiliations).toBeNull();
    expect(cfg.donationRollups.donationBoards[0]!.columns.actingForLink).toBeNull();
  });
  it('accepts a full affiliations block and an optional organizationalGiving owner column', () => {
    const raw = base();
    raw.affiliations = { boardId: 555, columns: { personLink: 'br_p', attributedGiving: 'n_ag',
      attributedGiftCount: 'n_agc', lastAttributedGift: 'd_lag' } };
    raw.donationRollups.donationBoards[0].columns.actingForLink = 'br_af';
    raw.donationRollups.ownerColumnsByBoard['18428131737'].organizationalGiving = 'n_og';
    const cfg = validateConfig(raw);
    expect(cfg.affiliations).toEqual({ boardId: 555, columns: { personLink: 'br_p', attributedGiving: 'n_ag',
      attributedGiftCount: 'n_agc', lastAttributedGift: 'd_lag' } });
    expect(cfg.donationRollups.donationBoards[0]!.columns.actingForLink).toBe('br_af');
    expect(cfg.donationRollups.ownerColumnsByBoard['18428131737']!.organizationalGiving).toBe('n_og');
    expect(cfg.donationRollups.ownerColumnsByBoard['18428131727']!.organizationalGiving).toBeUndefined();
  });
  it('rejects an affiliations block missing a column, and a block without actingForLink on the donation board', () => {
    const raw = base();
    raw.affiliations = { boardId: 555, columns: { personLink: 'br_p', attributedGiving: 'n_ag', attributedGiftCount: 'n_agc' } };
    expect(() => validateConfig(raw)).toThrow(/affiliations\.columns\.lastAttributedGift/);
    raw.affiliations.columns.lastAttributedGift = 'd_lag';
    expect(() => validateConfig(raw)).toThrow(/actingForLink.*required when affiliations is set/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/config.test.ts`
Expected: FAIL — `cfg.affiliations` is undefined; no such validation.

- [ ] **Step 3: Migration**

```sql
-- migrations/0005_affiliations.sql
-- Affiliation model (spec 2026-09-08, Plan 2): a gift the Primary Contact drove for an
-- organization carries the Affiliation item it was attributed to (the Donation's "Acting for"
-- connect column). Nullable: most gifts are personal. Archived items' board_relation reads
-- empty, so the recompute path preserves this value for archived gifts (db/gifts.ts).
ALTER TABLE gifts ADD COLUMN acting_for_item_id TEXT;
CREATE INDEX idx_gifts_acting_for ON gifts (acting_for_item_id);

-- Affiliation item -> the Person it belongs to, so Organizational Giving (sum over a person's
-- affiliations) can be computed from D1. Refreshed from Monday on every affiliation recompute;
-- bootstrapped from salesforce-import's artifacts. Not authoritative for the link itself.
CREATE TABLE affiliations (
  affiliation_item_id TEXT PRIMARY KEY,
  person_item_id TEXT NOT NULL,
  person_board_id TEXT NOT NULL,
  name TEXT NOT NULL,                -- "<Person> @ <Organization>", for the gift-history markdown
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_affiliations_person ON affiliations (person_item_id);
```

- [ ] **Step 4: Types**

In `src/types.ts`, add `actingForLink: string | null;` to `DonationBoardConfig.columns` (after
`giftType`), add `organizationalGiving?: string;` to `OwnerColumns` with the comment
`// People boards only — Organizations have no driven-giving concept.`, and add:

```ts
export interface AffiliationsConfig {
  boardId: number;
  columns: {
    personLink: string;          // Affiliations board: connect → People / People (Historical)
    attributedGiving: string;    // numbers (currency)
    attributedGiftCount: string; // numbers
    lastAttributedGift: string;  // date
  };
}
```

and `affiliations: AffiliationsConfig | null;` to `DonationRollupsConfig` (top level, beside
`custodian`). Add `affiliationItemId?: string` nowhere yet — the queue message is unchanged.

- [ ] **Step 5: Config validation**

In `src/config.ts`: in `validateDonationBoard`, after the `giftType` check, validate
`actingForLink` like `fiscalYear` (string or null; `undefined` → null) and return it. In
`validateOwnerColumns`, allow an optional `organizationalGiving` string. Add:

```ts
function validateAffiliations(raw: unknown, donationBoards: DonationBoardConfig[]): AffiliationsConfig | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') throw new Error('config: "affiliations" must be an object or null');
  const a = raw as Record<string, unknown>;
  if (typeof a.boardId !== 'number') throw new Error('config: "affiliations.boardId" must be a number');
  const columns = (a.columns ?? {}) as Record<string, unknown>;
  for (const key of ['personLink', 'attributedGiving', 'attributedGiftCount', 'lastAttributedGift'] as const) {
    if (typeof columns[key] !== 'string' || columns[key] === '') {
      throw new Error(`config: "affiliations.columns.${key}" must be a Monday column id string`);
    }
  }
  for (const b of donationBoards) {
    if (b.columns.actingForLink === null) {
      throw new Error(`config: donationBoards[${b.boardId}].columns.actingForLink is required when affiliations is set`);
    }
  }
  return { boardId: a.boardId, columns: columns as unknown as AffiliationsConfig['columns'] };
}
```

and return `affiliations: validateAffiliations(cfg.affiliations, donationBoards)` from
`validateConfig`. In `config/svbc.json` add `"actingForLink": null` to the donation board's
`columns` and a top-level `"affiliations": null` (after `"custodian"`). Do not add
`organizationalGiving` to any owner board yet — `setup-affiliation-columns.mjs` (Task 10) prints it.

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS (the new migration applies in the test harness via `readD1Migrations`).

- [ ] **Step 7: Commit**

```bash
git add migrations/0005_affiliations.sql src/types.ts src/config.ts src/config.test.ts config/svbc.json
git commit -m "feat(donation-rollups): affiliations config block, acting_for ledger column, affiliations table"
```

---

## Task 2: Gifts store — acting_for facts and the two aggregate reads

**Files:**
- Modify: `src/db/gifts.ts`
- Test: `src/db/gifts.test.ts`

**Interfaces:**
- Produces (on `GiftsStore` and `D1GiftsStore`):
  ```ts
  // GiftFact gains: actingForItemId?: string | null;   // undefined = column not configured, leave stored value
  actingForByIds(mondayItemIds: string[]): Promise<Map<string, string | null>>;
  attributedTotals(affiliationItemId: string, statusLabel: string): Promise<{ cents: number; count: number; lastGiftDateISO: string | null }>;
  organizationalGivingTotals(personItemId: string, statusLabel: string): Promise<{ cents: number; count: number }>;
  ```
  `refreshFacts` rule for `acting_for_item_id`: when `actingForItemId` is `undefined` → keep the
  stored value; when the stored row is archived (`archived_at IS NOT NULL`) → keep the stored
  value; otherwise take the new value (including `null` = cleared).

- [ ] **Step 1: Write the failing tests** (append to `src/db/gifts.test.ts`; `beforeEach` there
  already clears `gifts` — also clear `affiliations` in it)

```ts
describe('D1GiftsStore — acting_for', () => {
  it('refreshFacts writes acting_for for active gifts, keeps it for archived ones, ignores undefined', async () => {
    const store = new D1GiftsStore(env.DB);
    await store.refreshFacts([
      gift({ mondayItemId: 'g-active', actingForItemId: 'af-1' }),
      gift({ mondayItemId: 'g-archived', actingForItemId: 'af-1' }),
    ], 'import', '2026-01-01T00:00:00Z');
    await store.markArchived(['g-archived'], '2026-01-02T00:00:00Z');
    // A later webhook recompute: Monday reads the archived item's relation as empty (null),
    // and the active item was cleared by staff (null too).
    await store.refreshFacts([
      gift({ mondayItemId: 'g-active', actingForItemId: null }),
      gift({ mondayItemId: 'g-archived', actingForItemId: null }),
    ], 'webhook', '2026-01-03T00:00:00Z');
    expect(await store.actingForByIds(['g-active', 'g-archived'])).toEqual(new Map([['g-active', null], ['g-archived', 'af-1']]));
    // undefined (column not configured) never touches the stored value.
    await store.refreshFacts([gift({ mondayItemId: 'g-archived' })], 'webhook', '2026-01-04T00:00:00Z');
    expect((await store.actingForByIds(['g-archived'])).get('g-archived')).toBe('af-1');
  });

  it('attributedTotals sums Received gifts acting for one affiliation, newest date wins', async () => {
    const store = new D1GiftsStore(env.DB);
    await store.refreshFacts([
      gift({ mondayItemId: 'a1', actingForItemId: 'af-1', amountCents: 50000, giftDateISO: '2024-02-02' }),
      gift({ mondayItemId: 'a2', actingForItemId: 'af-1', amountCents: 2500, giftDateISO: '2025-05-05' }),
      gift({ mondayItemId: 'a3', actingForItemId: 'af-1', amountCents: 999, giftDateISO: '2025-06-06', status: 'Received (Historical)' }),
      gift({ mondayItemId: 'a4', actingForItemId: 'af-2', amountCents: 100 }),
    ], 'import', '2026-01-01T00:00:00Z');
    expect(await store.attributedTotals('af-1', 'Received')).toEqual({ cents: 52500, count: 2, lastGiftDateISO: '2025-05-05' });
    expect(await store.attributedTotals('af-none', 'Received')).toEqual({ cents: 0, count: 0, lastGiftDateISO: null });
  });

  it('organizationalGivingTotals sums across every affiliation that belongs to the person', async () => {
    const store = new D1GiftsStore(env.DB);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO affiliations VALUES ('af-1','p-1','b1','Ada @ Acme','2026-01-01T00:00:00Z')`),
      env.DB.prepare(`INSERT INTO affiliations VALUES ('af-2','p-1','b1','Ada @ Beta','2026-01-01T00:00:00Z')`),
      env.DB.prepare(`INSERT INTO affiliations VALUES ('af-9','p-9','b1','Bo @ Acme','2026-01-01T00:00:00Z')`),
    ]);
    await store.refreshFacts([
      gift({ mondayItemId: 'o1', actingForItemId: 'af-1', amountCents: 50000 }),
      gift({ mondayItemId: 'o2', actingForItemId: 'af-2', amountCents: 7500 }),
      gift({ mondayItemId: 'o3', actingForItemId: 'af-9', amountCents: 100 }),
      gift({ mondayItemId: 'o4', actingForItemId: 'af-1', amountCents: 5, status: 'Failed' }),
    ], 'import', '2026-01-01T00:00:00Z');
    expect(await store.organizationalGivingTotals('p-1', 'Received')).toEqual({ cents: 57500, count: 2 });
    expect(await store.organizationalGivingTotals('p-none', 'Received')).toEqual({ cents: 0, count: 0 });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/db/gifts.test.ts`
Expected: FAIL — methods missing.

- [ ] **Step 3: Implement**

In `src/db/gifts.ts`, add `actingForItemId?: string | null;` to `GiftFact` with the comment from
the Interfaces block, add the three methods to the `GiftsStore` interface, and change
`refreshFacts`'s statement to:

```ts
      await this.db.batch(chunk.map((g) => this.db
        .prepare(
          `INSERT INTO gifts (monday_item_id, owner_item_id, owner_board_id, amount_cents,
             gift_date, fiscal_year, status, gift_type, acting_for_item_id, source, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
           ON CONFLICT (monday_item_id) DO UPDATE SET
             owner_item_id = excluded.owner_item_id,
             owner_board_id = excluded.owner_board_id,
             amount_cents = excluded.amount_cents,
             gift_date = excluded.gift_date,
             fiscal_year = excluded.fiscal_year,
             status = excluded.status,
             gift_type = COALESCE(excluded.gift_type, gifts.gift_type),
             -- ?12 = 1 when the caller supplied acting_for (even null): active gifts take the new
             -- value verbatim (staff may clear it); archived gifts keep D1's, since an archived
             -- item's board_relation always reads back empty on Monday.
             acting_for_item_id = CASE
               WHEN ?12 = 0 THEN gifts.acting_for_item_id
               WHEN gifts.archived_at IS NOT NULL THEN COALESCE(excluded.acting_for_item_id, gifts.acting_for_item_id)
               ELSE excluded.acting_for_item_id END,
             source = excluded.source,
             updated_at = excluded.updated_at`,
        )
        .bind(g.mondayItemId, g.ownerItemId, g.ownerBoardId, g.amountCents,
          g.giftDateISO, g.fiscalYear, g.status, g.giftType ?? null,
          g.actingForItemId ?? null, source, now, g.actingForItemId === undefined ? 0 : 1)));
```

and the three reads:

```ts
  async actingForByIds(mondayItemIds: string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    for (let i = 0; i < mondayItemIds.length; i += CHUNK) {
      const chunk = mondayItemIds.slice(i, i + CHUNK);
      const res = await this.db
        .prepare(`SELECT monday_item_id, acting_for_item_id FROM gifts
                  WHERE monday_item_id IN (${chunk.map((_, j) => `?${j + 1}`).join(',')})`)
        .bind(...chunk)
        .all<{ monday_item_id: string; acting_for_item_id: string | null }>();
      for (const r of res.results) out.set(r.monday_item_id, r.acting_for_item_id);
    }
    return out;
  }

  async attributedTotals(affiliationItemId: string, statusLabel: string): Promise<{ cents: number; count: number; lastGiftDateISO: string | null }> {
    const r = await this.db
      .prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS cents, COUNT(*) AS n, MAX(gift_date) AS last
                FROM gifts WHERE acting_for_item_id = ?1 AND status = ?2`)
      .bind(affiliationItemId, statusLabel)
      .first<{ cents: number; n: number; last: string | null }>();
    return { cents: r?.cents ?? 0, count: r?.n ?? 0, lastGiftDateISO: r?.last || null };
  }

  async organizationalGivingTotals(personItemId: string, statusLabel: string): Promise<{ cents: number; count: number }> {
    const r = await this.db
      .prepare(`SELECT COALESCE(SUM(g.amount_cents), 0) AS cents, COUNT(*) AS n
                FROM gifts g JOIN affiliations a ON a.affiliation_item_id = g.acting_for_item_id
                WHERE a.person_item_id = ?1 AND g.status = ?2`)
      .bind(personItemId, statusLabel)
      .first<{ cents: number; n: number }>();
    return { cents: r?.cents ?? 0, count: r?.n ?? 0 };
  }
```

Also add `acting_for_item_id` to the `giftsForOwner` SELECT and `actingForItemId: r.acting_for_item_id`
to its mapped rows (Task 7's projection needs it); extend `GiftHistoryRow` in
`src/projections/giftHistory.ts` with `actingForItemId: string | null;` and update the one
existing test fixture in `giftHistory.test.ts` and the `oversizedHistory` fixture in
`processBatch.test.ts` with `actingForItemId: null`.

- [ ] **Step 4: Update the consumer/custodian fakes** so the suite compiles: in
  `src/consumer/processBatch.test.ts` `fakeGiftsStore()` and the equivalent in
  `src/custodian/custodian.test.ts`, add
  `actingForByIds: vi.fn().mockResolvedValue(new Map()), attributedTotals: vi.fn().mockResolvedValue({ cents: 0, count: 0, lastGiftDateISO: null }), organizationalGivingTotals: vi.fn().mockResolvedValue({ cents: 0, count: 0 }),`.

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/gifts.ts src/db/gifts.test.ts src/projections/giftHistory.ts src/projections/giftHistory.test.ts src/consumer/processBatch.test.ts src/custodian/custodian.test.ts
git commit -m "feat(donation-rollups): ledger carries acting_for; attributed and organizational totals"
```

---

## Task 3: Affiliations store

**Files:**
- Create: `src/db/affiliations.ts`
- Test: `src/db/affiliations.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface AffiliationRow { affiliationItemId: string; personItemId: string; personBoardId: string; name: string }
  export interface AffiliationsStore {
    upsert(row: AffiliationRow, updatedAt: string): Promise<void>;
    get(affiliationItemId: string): Promise<AffiliationRow | null>;
    forPerson(personItemId: string): Promise<AffiliationRow[]>;
    bulkUpsert(rows: (AffiliationRow & { updatedAt: string })[]): Promise<number>;
  }
  export class D1AffiliationsStore implements AffiliationsStore
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// src/db/affiliations.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { D1AffiliationsStore } from './affiliations';

beforeEach(async () => { await env.DB.prepare('DELETE FROM affiliations').run(); });

describe('D1AffiliationsStore', () => {
  it('upserts, reads back, and lists by person', async () => {
    const store = new D1AffiliationsStore(env.DB);
    await store.upsert({ affiliationItemId: 'af-1', personItemId: 'p-1', personBoardId: 'b1', name: 'Ada @ Acme' }, '2026-01-01T00:00:00Z');
    await store.upsert({ affiliationItemId: 'af-2', personItemId: 'p-1', personBoardId: 'b1', name: 'Ada @ Beta' }, '2026-01-01T00:00:00Z');
    expect(await store.get('af-1')).toEqual({ affiliationItemId: 'af-1', personItemId: 'p-1', personBoardId: 'b1', name: 'Ada @ Acme' });
    expect(await store.get('af-x')).toBeNull();
    expect((await store.forPerson('p-1')).map((a) => a.affiliationItemId).sort()).toEqual(['af-1', 'af-2']);
  });
  it('a re-point moves the affiliation to the new person', async () => {
    const store = new D1AffiliationsStore(env.DB);
    await store.upsert({ affiliationItemId: 'af-1', personItemId: 'p-1', personBoardId: 'b1', name: 'Ada @ Acme' }, '2026-01-01T00:00:00Z');
    await store.upsert({ affiliationItemId: 'af-1', personItemId: 'p-2', personBoardId: 'b2', name: 'Ada @ Acme' }, '2026-01-02T00:00:00Z');
    expect((await store.get('af-1'))?.personItemId).toBe('p-2');
    expect(await store.forPerson('p-1')).toEqual([]);
  });
  it('bulkUpsert writes in batches and returns the count', async () => {
    const store = new D1AffiliationsStore(env.DB);
    const rows = Array.from({ length: 250 }, (_, i) => ({ affiliationItemId: `af-${i}`, personItemId: `p-${i % 7}`,
      personBoardId: 'b1', name: `P${i} @ O`, updatedAt: '2026-01-01T00:00:00Z' }));
    expect(await store.bulkUpsert(rows)).toBe(250);
    expect((await store.forPerson('p-0')).length).toBe(36);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/db/affiliations.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** (same shape as `src/db/links.ts`)

```ts
// src/db/affiliations.ts
export interface AffiliationRow { affiliationItemId: string; personItemId: string; personBoardId: string; name: string }

// Affiliation item -> Person. Refreshed from Monday on every affiliation recompute (the
// consumer reads the item's Person link fresh), so this is a memory of the last-known person
// (to recompute someone an affiliation moved AWAY from) and the bootstrap seed — never the
// source of truth for the link itself.
export interface AffiliationsStore {
  upsert(row: AffiliationRow, updatedAt: string): Promise<void>;
  get(affiliationItemId: string): Promise<AffiliationRow | null>;
  forPerson(personItemId: string): Promise<AffiliationRow[]>;
  bulkUpsert(rows: (AffiliationRow & { updatedAt: string })[]): Promise<number>;
}

const UPSERT = `INSERT INTO affiliations (affiliation_item_id, person_item_id, person_board_id, name, updated_at)
  VALUES (?1, ?2, ?3, ?4, ?5)
  ON CONFLICT (affiliation_item_id) DO UPDATE SET
    person_item_id = excluded.person_item_id, person_board_id = excluded.person_board_id,
    name = excluded.name, updated_at = excluded.updated_at`;

interface Rec { affiliation_item_id: string; person_item_id: string; person_board_id: string; name: string }
const toRow = (r: Rec): AffiliationRow =>
  ({ affiliationItemId: r.affiliation_item_id, personItemId: r.person_item_id, personBoardId: r.person_board_id, name: r.name });

export class D1AffiliationsStore implements AffiliationsStore {
  constructor(private db: D1Database) {}

  async upsert(row: AffiliationRow, updatedAt: string): Promise<void> {
    await this.db.prepare(UPSERT).bind(row.affiliationItemId, row.personItemId, row.personBoardId, row.name, updatedAt).run();
  }
  async get(affiliationItemId: string): Promise<AffiliationRow | null> {
    const r = await this.db.prepare(`SELECT affiliation_item_id, person_item_id, person_board_id, name FROM affiliations WHERE affiliation_item_id = ?1`)
      .bind(affiliationItemId).first<Rec>();
    return r === null ? null : toRow(r);
  }
  async forPerson(personItemId: string): Promise<AffiliationRow[]> {
    const res = await this.db.prepare(`SELECT affiliation_item_id, person_item_id, person_board_id, name FROM affiliations WHERE person_item_id = ?1 ORDER BY affiliation_item_id`)
      .bind(personItemId).all<Rec>();
    return res.results.map(toRow);
  }
  async bulkUpsert(rows: (AffiliationRow & { updatedAt: string })[]): Promise<number> {
    const BATCH = 100;
    let written = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      await this.db.batch(chunk.map((r) => this.db.prepare(UPSERT)
        .bind(r.affiliationItemId, r.personItemId, r.personBoardId, r.name, r.updatedAt)));
      written += chunk.length;
    }
    return written;
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run src/db/affiliations.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/affiliations.ts src/db/affiliations.test.ts
git commit -m "feat(donation-rollups): D1 affiliations store (affiliation item -> person)"
```

---

## Task 4: Monday client — read Acting for, read an affiliation's person

**Files:**
- Modify: `src/monday/client.ts`
- Test: `src/monday/client.test.ts` (follow its existing scripted-`fetch` pattern)

**Interfaces:**
- Produces:
  ```ts
  // DonationRecord gains: actingForItemId?: string | null;   // undefined when the board has no actingForLink configured
  // getDonationsByIds's columns param gains: actingForLink?: string | null;
  export interface AffiliationSummary { name: string; personItemId: string | null; personBoardId: string | null }
  getAffiliationSummary(affiliationItemId: string, personLinkColumnId: string): Promise<AffiliationSummary | null>;   // null = item gone
  ```

- [ ] **Step 1: Write the failing tests** (append to `src/monday/client.test.ts`, using the
  file's existing helper that stubs `globalThis.fetch` with a scripted response)

```ts
describe('HttpMondayClient — affiliation model reads', () => {
  it('getDonationsByIds returns actingForItemId from the board_relation when configured, undefined otherwise', async () => {
    const respond = { items: [{ id: 'dn1', column_values: [
      { id: 'amount_1', text: '50' }, { id: 'date_1', text: '2024-02-02' }, { id: 'status_1', text: 'Received' },
      { id: 'af_1', text: 'Ada @ Acme', linked_item_ids: ['af-1'] } ] }] };
    const client = clientWith(respond);   // the file's helper: returns HttpMondayClient whose fetch resolves {data: respond}
    const [withAf] = await client.getDonationsByIds(['dn1'], { amount: 'amount_1', date: 'date_1', status: 'status_1', fiscalYear: null, actingForLink: 'af_1' });
    expect(withAf!.actingForItemId).toBe('af-1');
    const [without] = await client.getDonationsByIds(['dn1'], { amount: 'amount_1', date: 'date_1', status: 'status_1', fiscalYear: null });
    expect(without!.actingForItemId).toBeUndefined();
  });
  it('getDonationsByIds reports null when the configured Acting for column is empty', async () => {
    const respond = { items: [{ id: 'dn1', column_values: [
      { id: 'amount_1', text: '50' }, { id: 'date_1', text: '2024-02-02' }, { id: 'status_1', text: 'Received' },
      { id: 'af_1', text: '', linked_item_ids: [] } ] }] };
    const [d] = await clientWith(respond).getDonationsByIds(['dn1'], { amount: 'amount_1', date: 'date_1', status: 'status_1', fiscalYear: null, actingForLink: 'af_1' });
    expect(d!.actingForItemId).toBeNull();
  });
  it('getAffiliationSummary returns the item name and its Person link + board', async () => {
    const calls = [
      { items: [{ id: 'af-1', name: 'Ada @ Acme', column_values: [{ id: 'br_p', linked_item_ids: ['p-1'] }] }] },
      { items: [{ board: { id: '18428131737' } }] },
    ];
    const client = clientWithSequence(calls);   // helper variant returning each response in turn
    expect(await client.getAffiliationSummary('af-1', 'br_p')).toEqual({ name: 'Ada @ Acme', personItemId: 'p-1', personBoardId: '18428131737' });
  });
  it('getAffiliationSummary: no Person link → nulls; deleted item → null', async () => {
    expect(await clientWithSequence([{ items: [{ id: 'af-1', name: 'X @ Y', column_values: [{ id: 'br_p', linked_item_ids: [] }] }] }])
      .getAffiliationSummary('af-1', 'br_p')).toEqual({ name: 'X @ Y', personItemId: null, personBoardId: null });
    expect(await clientWithSequence([{ items: [] }]).getAffiliationSummary('af-gone', 'br_p')).toBeNull();
  });
});
```

If `client.test.ts` has no `clientWith` / `clientWithSequence` helpers, add them at the top of
the file: stub `globalThis.fetch` with `vi.fn()` returning `new Response(JSON.stringify({ data }))`
for one or successive `data` objects, and construct `new HttpMondayClient('https://x', 't')`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/monday/client.test.ts`
Expected: FAIL — `actingForItemId` undefined / method missing.

- [ ] **Step 3: Implement**

In `getDonationsByIds`: add `actingForLink?: string | null` to the `columns` parameter type (both
in the interface and the class), include it in `columnIds` when set, request
`column_values(ids: $columnIds) { id text ... on BoardRelationValue { linked_item_ids } }`, type
the column value as `{ id: string; text: string | null; linked_item_ids?: string[] }`, and set:

```ts
        const actingForItemId = columns.actingForLink
          ? (item.column_values.find((cv) => cv.id === columns.actingForLink)?.linked_item_ids?.[0] ?? null)
          : undefined;
        donations.push({ id: item.id, amount, dateISO, fiscalYear, status, giftType, actingForItemId });
```

Add to the interface and class:

```ts
  async getAffiliationSummary(affiliationItemId: string, personLinkColumnId: string): Promise<AffiliationSummary | null> {
    const data = await this.graphql<{ items: { id: string; name: string; column_values: { id: string; linked_item_ids?: string[] }[] }[] }>(
      `query ($itemId: ID!, $columnId: [String!]) {
        items(ids: [$itemId]) { id name column_values(ids: $columnId) { id ... on BoardRelationValue { linked_item_ids } } }
      }`,
      { itemId: affiliationItemId, columnId: [personLinkColumnId] },
    );
    const item = data.items[0];
    if (item === undefined) return null;
    const personItemId = item.column_values[0]?.linked_item_ids?.[0] ?? null;
    const personBoardId = personItemId === null ? null : await this.getItemBoardId(personItemId);
    return { name: item.name, personItemId, personBoardId };
  }
```

Add `getAffiliationSummary: vi.fn().mockResolvedValue(null)` to `fakeMondayClient` in
`processBatch.test.ts`.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/monday/client.ts src/monday/client.test.ts src/consumer/processBatch.test.ts
git commit -m "feat(donation-rollups): read Acting for on donations and an affiliation's Person"
```

---

## Task 5: Pure attributed rollup

**Files:**
- Create: `src/rollups/attributed.ts`
- Test: `src/rollups/attributed.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface AttributedRollup { attributedGiving: number; attributedGiftCount: number; lastAttributedGiftISO: string | null }
  export function attributedRollupFromTotals(t: { cents: number; count: number; lastGiftDateISO: string | null }): AttributedRollup;
  export function attributedToColumnValues(r: AttributedRollup, columns: AffiliationsConfig['columns']): Record<string, unknown>;
  export function organizationalGivingColumnValue(cents: number): string;   // '' when 0? No: '0' — see test
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// src/rollups/attributed.test.ts
import { describe, it, expect } from 'vitest';
import { attributedRollupFromTotals, attributedToColumnValues, organizationalGivingColumnValue } from './attributed';

const columns = { personLink: 'br_p', attributedGiving: 'n_ag', attributedGiftCount: 'n_agc', lastAttributedGift: 'd_lag' };

describe('attributed rollup', () => {
  it('converts ledger cents to dollars and keeps the last date', () => {
    expect(attributedRollupFromTotals({ cents: 52500, count: 2, lastGiftDateISO: '2025-05-05' }))
      .toEqual({ attributedGiving: 525, attributedGiftCount: 2, lastAttributedGiftISO: '2025-05-05' });
  });
  it('maps to the configured column ids; an empty affiliation writes 0 / 0 / null', () => {
    expect(attributedToColumnValues({ attributedGiving: 525, attributedGiftCount: 2, lastAttributedGiftISO: '2025-05-05' }, columns))
      .toEqual({ n_ag: '525', n_agc: '2', d_lag: { date: '2025-05-05' } });
    expect(attributedToColumnValues(attributedRollupFromTotals({ cents: 0, count: 0, lastGiftDateISO: null }), columns))
      .toEqual({ n_ag: '0', n_agc: '0', d_lag: null });
  });
  it('organizationalGivingColumnValue writes dollars, including an explicit 0 after the last gift moves away', () => {
    expect(organizationalGivingColumnValue(57500)).toBe('575');
    expect(organizationalGivingColumnValue(0)).toBe('0');
  });
});
```

- [ ] **Step 2: Run them to verify they fail** — `npx vitest run src/rollups/attributed.test.ts`

- [ ] **Step 3: Implement**

```ts
// src/rollups/attributed.ts
import type { AffiliationsConfig } from '../types';

// Per-affiliation money rollups (spec "Rollups"): what a person drove for one organization
// during one tenure. Lifetime, not fiscal-year split — there is no This/Last Year here.
export interface AttributedRollup { attributedGiving: number; attributedGiftCount: number; lastAttributedGiftISO: string | null }

export function attributedRollupFromTotals(t: { cents: number; count: number; lastGiftDateISO: string | null }): AttributedRollup {
  return { attributedGiving: t.cents / 100, attributedGiftCount: t.count, lastAttributedGiftISO: t.lastGiftDateISO };
}

// Explicit zeros, not blanks: a tenure whose last attributed gift was re-pointed elsewhere
// must read 0, or the stale total would sit there looking current.
export function attributedToColumnValues(r: AttributedRollup, columns: AffiliationsConfig['columns']): Record<string, unknown> {
  return {
    [columns.attributedGiving]: String(r.attributedGiving),
    [columns.attributedGiftCount]: String(r.attributedGiftCount),
    [columns.lastAttributedGift]: r.lastAttributedGiftISO === null ? null : { date: r.lastAttributedGiftISO.slice(0, 10) },
  };
}

export function organizationalGivingColumnValue(cents: number): string {
  return String(cents / 100);
}
```

- [ ] **Step 4: Run and commit**

```bash
npx vitest run src/rollups/attributed.test.ts && npm run typecheck
git add src/rollups/attributed.ts src/rollups/attributed.test.ts
git commit -m "feat(donation-rollups): pure attributed and organizational rollup mapping"
```

---

## Task 6: Consumer phase 2 — affiliation and person recompute

**Files:**
- Modify: `src/consumer/processBatch.ts`, `src/index.ts`
- Test: `src/consumer/processBatch.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces: `ProcessBatchDeps` gains `affiliationsStore: AffiliationsStore`; `processOne` runs
  `recomputeAffiliations(...)` after the owner write when `config.affiliations !== null`.
  Exported for tests: `affectedAffiliations(previous: Map<string, string | null>, donations: DonationRecord[]): Set<string>`.

**Behavior (spec "Rollups", with the rulings above):**
1. Before `refreshFacts`, read the previously stored `acting_for` for the fetched donation ids
   (`giftsStore.actingForByIds`). After `refreshFacts`, the affected affiliations are the union of
   the previous values and the fetched `actingForItemId`s (both non-null) — so a gift moved from
   one affiliation to another recomputes both.
2. For each affected affiliation: `getAffiliationSummary` from Monday. If `null` (item deleted),
   log and skip. Else `affiliationsStore.upsert` (remembering the previous row first), compute
   `attributedTotals` → `attributedToColumnValues` → `changeColumnValues(affiliations.boardId, …)`.
3. Affected persons = the current `personItemId` of each affected affiliation ∪ the previous
   `personItemId` from D1 (a re-pointed affiliation). For each person whose board has an
   `organizationalGiving` column configured: `organizationalGivingTotals` →
   `changeColumnValues(personBoardId, personItemId, { [organizationalGiving]: value })`. A person
   board without that column (Organizations, or People before `setup-affiliation-columns.mjs`
   runs) is skipped with a `console.warn` naming the board — never a retry.
4. Any Monday failure in phase 2 throws, so the message retries like phase 1 (the owner write is
   idempotent).

- [ ] **Step 1: Write the failing tests** (append to `processBatch.test.ts`)

```ts
import { affectedAffiliations } from './processBatch';
import type { AffiliationsStore } from '../db/affiliations';

const affiliationsCfg = { boardId: 555, columns: { personLink: 'br_p', attributedGiving: 'n_ag', attributedGiftCount: 'n_agc', lastAttributedGift: 'd_lag' } };
const configWithAffiliations: DonationRollupsConfig = {
  ...config,
  affiliations: affiliationsCfg,
  donationRollups: { ...config.donationRollups,
    donationBoards: config.donationRollups.donationBoards.map((b) => ({ ...b, columns: { ...b.columns, actingForLink: `af_${b.boardId}` } })),
    ownerColumnsByBoard: { '2': { ...ownerColumns, organizationalGiving: 'og' }, '3': ownerColumns } },
};
function fakeAffiliationsStore(overrides: Partial<AffiliationsStore> = {}): AffiliationsStore {
  return { upsert: vi.fn().mockResolvedValue(undefined), get: vi.fn().mockResolvedValue(null),
    forPerson: vi.fn().mockResolvedValue([]), bulkUpsert: vi.fn().mockResolvedValue(0), ...overrides };
}

describe('affectedAffiliations', () => {
  it('unions previous and current acting-for ids, ignoring nulls', () => {
    expect([...affectedAffiliations(new Map([['dn1', 'af-old'], ['dn2', null]]),
      [{ id: 'dn1', amount: 1, dateISO: '2024-01-01', fiscalYear: 2024, status: 'Received', actingForItemId: 'af-new' },
       { id: 'dn2', amount: 1, dateISO: '2024-01-01', fiscalYear: 2024, status: 'Received', actingForItemId: null }])].sort())
      .toEqual(['af-new', 'af-old']);
  });
});

describe('consumer phase 2 — affiliation rollups', () => {
  const donation = { id: 'dn1', amount: 500, dateISO: '2024-02-02', fiscalYear: 2024, status: 'Received', actingForItemId: 'af-1' };
  function setup(over: { giftsStore?: Partial<GiftsStore>; affiliationsStore?: Partial<AffiliationsStore>; monday?: Partial<DonationRollupsMondayClient> } = {}) {
    const giftsStore = { ...fakeGiftsStore(), ...over.giftsStore } as GiftsStore;
    (giftsStore.attributedTotals as ReturnType<typeof vi.fn>).mockResolvedValue({ cents: 50000, count: 1, lastGiftDateISO: '2024-02-02' });
    (giftsStore.organizationalGivingTotals as ReturnType<typeof vi.fn>).mockResolvedValue({ cents: 50000, count: 1 });
    const mondayClient = fakeMondayClient({
      getDonationsByIds: vi.fn().mockResolvedValue([donation]),
      getAffiliationSummary: vi.fn().mockResolvedValue({ name: 'Uma @ Beta', personItemId: 'p-1', personBoardId: '2' }),
      ...over.monday });
    const affiliationsStore = fakeAffiliationsStore(over.affiliationsStore);
    return { giftsStore, mondayClient, affiliationsStore };
  }

  it('writes the three attributed columns on the Affiliations board and Organizational Giving on the person', async () => {
    const { giftsStore, mondayClient, affiliationsStore } = setup();
    await processRecomputeBatch([fakeMessage('dn1')], { pendingStore: fakePendingStore(), linksStore: fakeLinksStore(),
      giftsStore, affiliationsStore, mondayClient, config: configWithAffiliations, now: new Date('2026-01-01') });
    expect(mondayClient.getDonationsByIds).toHaveBeenCalledWith(['dn1'], expect.objectContaining({ actingForLink: 'af_1' }));
    expect(giftsStore.refreshFacts).toHaveBeenCalledWith([expect.objectContaining({ mondayItemId: 'dn1', actingForItemId: 'af-1' })], 'webhook', expect.any(String));
    expect(mondayClient.getAffiliationSummary).toHaveBeenCalledWith('af-1', 'br_p');
    expect(affiliationsStore.upsert).toHaveBeenCalledWith({ affiliationItemId: 'af-1', personItemId: 'p-1', personBoardId: '2', name: 'Uma @ Beta' }, expect.any(String));
    expect(mondayClient.changeColumnValues).toHaveBeenCalledWith(555, 'af-1', { n_ag: '500', n_agc: '1', d_lag: { date: '2024-02-02' } });
    expect(mondayClient.changeColumnValues).toHaveBeenCalledWith(2, 'p-1', { og: '500' });
  });

  it('recomputes the affiliation a gift moved away from, and the person it used to belong to', async () => {
    const { giftsStore, mondayClient, affiliationsStore } = setup({
      giftsStore: { actingForByIds: vi.fn().mockResolvedValue(new Map([['dn1', 'af-old']])) },
      affiliationsStore: { get: vi.fn().mockImplementation(async (id: string) =>
        id === 'af-old' ? { affiliationItemId: 'af-old', personItemId: 'p-old', personBoardId: '2', name: 'Old @ Org' } : null) },
      monday: { getAffiliationSummary: vi.fn().mockImplementation(async (id: string) =>
        ({ name: `${id} name`, personItemId: id === 'af-old' ? 'p-old' : 'p-1', personBoardId: '2' })) },
    });
    await processRecomputeBatch([fakeMessage('dn1')], { pendingStore: fakePendingStore(), linksStore: fakeLinksStore(),
      giftsStore, affiliationsStore, mondayClient, config: configWithAffiliations, now: new Date('2026-01-01') });
    expect(mondayClient.changeColumnValues).toHaveBeenCalledWith(555, 'af-old', expect.anything());
    expect(mondayClient.changeColumnValues).toHaveBeenCalledWith(555, 'af-1', expect.anything());
    expect(mondayClient.changeColumnValues).toHaveBeenCalledWith(2, 'p-old', { og: '500' });
    expect(mondayClient.changeColumnValues).toHaveBeenCalledWith(2, 'p-1', { og: '500' });
  });

  it('skips Organizational Giving with a warning when the person board has no such column, and skips a deleted affiliation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { giftsStore, mondayClient, affiliationsStore } = setup({
      monday: { getAffiliationSummary: vi.fn().mockResolvedValue({ name: 'X @ Y', personItemId: 'p-3', personBoardId: '3' }) } });
    await processRecomputeBatch([fakeMessage('dn1')], { pendingStore: fakePendingStore(), linksStore: fakeLinksStore(),
      giftsStore, affiliationsStore, mondayClient, config: configWithAffiliations, now: new Date('2026-01-01') });
    expect(mondayClient.changeColumnValues).not.toHaveBeenCalledWith(3, 'p-3', expect.anything());
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no organizationalGiving column for board "3"'));
    warn.mockRestore();

    const gone = setup({ monday: { getAffiliationSummary: vi.fn().mockResolvedValue(null) } });
    const message = fakeMessage('dn1');
    await processRecomputeBatch([message], { pendingStore: fakePendingStore(), linksStore: fakeLinksStore(),
      giftsStore: gone.giftsStore, affiliationsStore: gone.affiliationsStore, mondayClient: gone.mondayClient, config: configWithAffiliations, now: new Date('2026-01-01') });
    expect(message.ack).toHaveBeenCalled();
    expect(gone.mondayClient.changeColumnValues).not.toHaveBeenCalledWith(555, expect.anything(), expect.anything());
  });

  it('does nothing extra when affiliations is null (gate off)', async () => {
    const { giftsStore, mondayClient, affiliationsStore } = setup();
    await processRecomputeBatch([fakeMessage('dn1')], { pendingStore: fakePendingStore(), linksStore: fakeLinksStore(),
      giftsStore, affiliationsStore, mondayClient, config, now: new Date('2026-01-01') });
    expect(mondayClient.getAffiliationSummary).not.toHaveBeenCalled();
    expect(giftsStore.actingForByIds).not.toHaveBeenCalled();
    expect(mondayClient.changeColumnValues).toHaveBeenCalledTimes(1);   // the owner write only
  });

  it('a phase-2 Monday failure retries the message (owner write is idempotent)', async () => {
    const { giftsStore, mondayClient, affiliationsStore } = setup({
      monday: { changeColumnValues: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('monday API: HTTP 500')) } });
    const message = fakeMessage('dn1');
    await processRecomputeBatch([message], { pendingStore: fakePendingStore(), linksStore: fakeLinksStore(),
      giftsStore, affiliationsStore, mondayClient, config: configWithAffiliations, now: new Date('2026-01-01') });
    expect(message.retry).toHaveBeenCalled();
  });
});
```

Every existing `processRecomputeBatch(...)` call in the file needs `affiliationsStore: fakeAffiliationsStore()`
added to its deps — do it with one search/replace on `linksStore: fakeLinksStore(` → add the key
after it where absent.

- [ ] **Step 2: Run them to verify they fail** — `npx vitest run src/consumer/processBatch.test.ts`

- [ ] **Step 3: Implement**

In `processBatch.ts`: import `AffiliationsStore`, `attributedRollupFromTotals`,
`attributedToColumnValues`, `organizationalGivingColumnValue`, `DonationRecord`. Add
`affiliationsStore: AffiliationsStore;` to `ProcessBatchDeps`. Pass `actingForLink: b.columns.actingForLink`
into `getDonationsByIds` (it is part of `b.columns` already — confirm the object is passed whole).
Change the refresh section:

```ts
  const affiliationsCfg = config.affiliations;
  const fetchedIds = donations.map((d) => d.id);
  const previousActingFor = affiliationsCfg ? await deps.giftsStore.actingForByIds(fetchedIds) : new Map<string, string | null>();

  await deps.giftsStore.refreshFacts(
    donations.map((d) => ({
      mondayItemId: d.id, ownerItemId, ownerBoardId,
      amountCents: Math.round(d.amount * 100),
      giftDateISO: d.dateISO, fiscalYear: d.fiscalYear, status: d.status,
      giftType: d.giftType ?? null,
      actingForItemId: d.actingForItemId,   // undefined when no actingForLink is configured
    })),
    'webhook', new Date().toISOString());
```

After the `pendingStore.updateStatus(... 'written' ...)` block's preceding description write
(i.e. after the owner write and description, before marking written), insert:

```ts
  if (affiliationsCfg !== null) {
    await recomputeAffiliations(deps, affiliationsCfg, affectedAffiliations(previousActingFor, donations));
  }
```

and add the helpers:

```ts
export function affectedAffiliations(previous: Map<string, string | null>, donations: DonationRecord[]): Set<string> {
  const out = new Set<string>();
  for (const v of previous.values()) if (v) out.add(v);
  for (const d of donations) if (d.actingForItemId) out.add(d.actingForItemId);
  return out;
}

// Phase 2 (spec "Rollups"): the affiliations this batch of gifts touches get their attributed
// totals rewritten, and every person those affiliations belong to — now, or before a re-point —
// gets Organizational Giving rewritten. Full recompute from the ledger, like phase 1.
async function recomputeAffiliations(deps: ProcessBatchDeps, cfg: AffiliationsConfig, affiliationIds: Set<string>): Promise<void> {
  const { mondayClient, giftsStore, affiliationsStore, config } = deps;
  const { receivedStatusLabel, ownerColumnsByBoard } = config.donationRollups;
  const now = new Date().toISOString();
  const persons = new Map<string, string>(); // person item id -> board id
  for (const affiliationId of affiliationIds) {
    const previous = await affiliationsStore.get(affiliationId);
    if (previous) persons.set(previous.personItemId, previous.personBoardId);
    const summary = await mondayClient.getAffiliationSummary(affiliationId, cfg.columns.personLink);
    if (summary === null) {
      console.warn(`donation-rollups consumer: affiliation "${affiliationId}" no longer exists on Monday — skipped`);
      continue;
    }
    if (summary.personItemId !== null && summary.personBoardId !== null) {
      await affiliationsStore.upsert({ affiliationItemId: affiliationId, personItemId: summary.personItemId,
        personBoardId: summary.personBoardId, name: summary.name }, now);
      persons.set(summary.personItemId, summary.personBoardId);
    }
    const totals = await giftsStore.attributedTotals(affiliationId, receivedStatusLabel);
    await mondayClient.changeColumnValues(cfg.boardId, affiliationId,
      attributedToColumnValues(attributedRollupFromTotals(totals), cfg.columns));
  }
  for (const [personItemId, personBoardId] of persons) {
    const column = ownerColumnsByBoard[personBoardId]?.organizationalGiving;
    if (!column) {
      console.warn(`donation-rollups consumer: no organizationalGiving column for board "${personBoardId}" — Organizational Giving for "${personItemId}" not written`);
      continue;
    }
    const totals = await giftsStore.organizationalGivingTotals(personItemId, receivedStatusLabel);
    await mondayClient.changeColumnValues(Number(personBoardId), personItemId, { [column]: organizationalGivingColumnValue(totals.cents) });
  }
}
```

In `src/index.ts`, construct `new D1AffiliationsStore(env.DB)` and pass it as `affiliationsStore`
in the `queue` handler's deps.

- [ ] **Step 4: Run tests and typecheck** — `npx vitest run && npm run typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/consumer/processBatch.ts src/consumer/processBatch.test.ts src/index.ts
git commit -m "feat(donation-rollups): recompute attributed and organizational giving after each owner write"
```

---

## Task 7: Gift-history projections carry the affiliation

**Files:**
- Modify: `src/projections/giftHistory.ts`, `src/consumer/processBatch.ts` (markdown call)
- Test: `src/projections/giftHistory.test.ts`, `src/consumer/processBatch.test.ts`

**Interfaces:**
- Produces: ledger tuples become `[itemId, dateISO, cents, type, status, actingForItemId | '']`
  (`parseGiftLedgerJson` already tolerates length ≥ 5 and reads only indices 0/2/4);
  `buildGiftHistoryMarkdown(rows, accountUrl, driven?: { affiliationName: string; cents: number; count: number }[])`
  appends a "Driven for organizations" section when `driven` is non-empty.

- [ ] **Step 1: Write the failing tests**

```ts
// append to giftHistory.test.ts
it('tuples carry the acting-for affiliation id as a sixth element ("" when personal)', () => {
  const rows = [
    { mondayItemId: 'g1', donationBoardId: '1', amountCents: 5000, giftDateISO: '2020-01-15', fiscalYear: 2020, status: 'Received', giftType: 'Donation', archived: false, actingForItemId: null },
    { mondayItemId: 'g2', donationBoardId: '1', amountCents: 50000, giftDateISO: '2024-02-02', fiscalYear: 2024, status: 'Received', giftType: 'Sponsorship', archived: false, actingForItemId: 'af-1' },
  ];
  expect(JSON.parse(buildGiftLedgerJson(rows).json)).toEqual([
    ['g2', '2024-02-02', 50000, 'Sponsorship', 'Received', 'af-1'],
    ['g1', '2020-01-15', 5000, 'Donation', 'Received', ''],
  ]);
  expect(parseGiftLedgerJson(buildGiftLedgerJson(rows).json)!.entries).toHaveLength(2);
});
it('markdown gains a "Driven for organizations" section only when there is driven giving', () => {
  const md = buildGiftHistoryMarkdown([], 'https://acme.monday.com', [{ affiliationName: 'Uma @ Beta Org', cents: 50000, count: 1 }]);
  expect(md).toContain('## Driven for organizations');
  expect(md).toContain('| Uma @ Beta Org | $500.00 | 1 |');
  expect(buildGiftHistoryMarkdown([], 'https://acme.monday.com')).not.toContain('Driven for');
});
```

In `processBatch.test.ts`'s first phase-2 test, add
`expect(mondayClient.setItemDescription).toHaveBeenCalledWith('donor-1', expect.stringContaining('Driven for organizations'));`
only if the owner is a person with driven giving — simpler: add a dedicated test where
`affiliationsStore.forPerson` returns one row for `'donor-1'` and `organizationalGivingTotals`
returns `{ cents: 50000, count: 1 }`, and assert the description contains the section.

- [ ] **Step 2: Run to verify failure**, then **Step 3: implement**: `tuple` gains
  `r.actingForItemId ?? ''`; `GiftLedgerTuple` becomes a 6-tuple; the marker tuple appends `''`;
  `buildGiftHistoryMarkdown` takes the optional third parameter and, when non-empty, appends:

```ts
    lines.push('', '## Driven for organizations', '', '| Affiliation | Attributed giving | Gifts |', '| --- | --- | --- |');
    for (const d of driven) lines.push(`| ${d.affiliationName} | ${dollars(d.cents)} | ${d.count} |`);
```

  In the consumer, before `setItemDescription`, when `affiliationsCfg !== null`: for the owner,
  `const mine = await affiliationsStore.forPerson(ownerItemId)`; for each, `attributedTotals` →
  `{ affiliationName: a.name, cents, count }` (skip zeros); pass as the third argument.

- [ ] **Step 4: Run and commit**

```bash
npx vitest run && npm run typecheck
git add src/projections/giftHistory.ts src/projections/giftHistory.test.ts src/consumer/processBatch.ts src/consumer/processBatch.test.ts
git commit -m "feat(donation-rollups): gift-history projections carry the acting-for affiliation"
```

---

## Task 8: Reconcile legs 5 and 6

**Files:**
- Modify: `src/custodian/custodian.ts`, `src/db/gifts.ts` (two aggregate reads), `src/index.ts`
- Test: `src/custodian/custodian.test.ts`, `src/db/gifts.test.ts`

**Interfaces:**
- `GiftsStore` gains `attributedTotalsAll(statusLabel): Promise<Map<string, { cents: number; count: number }>>`
  (per affiliation) and `organizationalGivingAll(statusLabel): Promise<Map<string, { cents: number; personBoardId: string }>>`
  (per person, via the `affiliations` join).
- `CustodianDeps` gains `affiliations: AffiliationsStore` (unused by legs 5/6 directly but wired for symmetry — omit if the reviewer objects).
- Reconcile report `detail` gains `affiliationMismatches`, `affiliationMismatchCount`,
  `organizationalMismatches`, `organizationalMismatchCount`; `ok` requires both zero. Runs only on
  the final slice (`remaining === 0`) and only when `config.affiliations !== null`; reads Monday
  in chunks of 100 via `getItemsColumnsText`.

- [ ] **Step 1: Failing tests** — in `gifts.test.ts`, seed three affiliations/gifts as in Task 2 and
  assert `attributedTotalsAll('Received')` returns `Map { 'af-1' => {cents: 57500? …} }` per the
  seed you write, and `organizationalGivingAll('Received')` returns `{ 'p-1': { cents, personBoardId: 'b1' } }`.
  In `custodian.test.ts`, a reconcile run with `config.affiliations` set where the fake
  `getItemsColumnsText` returns `n_ag: '525'` for `af-1` while the ledger says 52500 cents →
  clean; and `'524'` → `ok: false` with `affiliationMismatches: [{ affiliationItemId: 'af-1', ledgerCents: 52500, mondayCents: 52400 }]`;
  same shape for `organizationalMismatches` keyed by `personItemId`.

- [ ] **Step 2: Implement** the two reads (GROUP BY `acting_for_item_id` with `IS NOT NULL`; GROUP BY
  `a.person_item_id, a.person_board_id`) and, in `runReconcile` inside `if (remaining === 0)` after
  leg 4:

```ts
    if (deps.config.affiliations !== null) {
      const { boardId, columns } = deps.config.affiliations;
      const ledgerByAffiliation = await deps.gifts.attributedTotalsAll(receivedStatusLabel);
      const ids = [...ledgerByAffiliation.keys()].sort();
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        const monday = await deps.mondayClient.getItemsColumnsText(chunk, [columns.attributedGiving]);
        for (const id of chunk) {
          const text = monday.get(id)?.get(columns.attributedGiving) ?? null;
          const mondayCents = text === null ? null : Math.round(Number(text) * 100);
          const ledgerCents = ledgerByAffiliation.get(id)!.cents;
          if (mondayCents !== ledgerCents) affiliationMismatches.push({ affiliationItemId: id, ledgerCents, mondayCents });
        }
      }
      void boardId;
      const ledgerByPerson = await deps.gifts.organizationalGivingAll(receivedStatusLabel);
      const byBoard = new Map<string, string[]>();
      for (const [personId, t] of ledgerByPerson) byBoard.set(t.personBoardId, [...(byBoard.get(t.personBoardId) ?? []), personId]);
      for (const [personBoardId, personIds] of byBoard) {
        const column = ownerColumnsByBoard[personBoardId]?.organizationalGiving;
        if (!column) continue;
        for (let i = 0; i < personIds.length; i += 100) {
          const chunk = personIds.slice(i, i + 100);
          const monday = await deps.mondayClient.getItemsColumnsText(chunk, [column]);
          for (const id of chunk) {
            const text = monday.get(id)?.get(column) ?? null;
            const mondayCents = text === null ? null : Math.round(Number(text) * 100);
            const ledgerCents = ledgerByPerson.get(id)!.cents;
            if (mondayCents !== ledgerCents) organizationalMismatches.push({ personItemId: id, ledgerCents, mondayCents });
          }
        }
      }
    }
```

  (declare both arrays beside `summaryBoardMismatches`; add them to `ok`, `summary`, and `detail`).
  Add the two new methods to every `fakeGiftsStore` (`vi.fn().mockResolvedValue(new Map())`).

- [ ] **Step 3: Run and commit**

```bash
npx vitest run && npm run typecheck
git add src/custodian/custodian.ts src/custodian/custodian.test.ts src/db/gifts.ts src/db/gifts.test.ts src/index.ts
git commit -m "feat(donation-rollups): reconcile attributed giving and Organizational Giving against the ledger"
```

---

## Task 9: Bootstrap from artifacts

**Files:**
- Modify: `scripts/bootstrap-gifts-lib.mjs`, `scripts/bootstrap-gifts-from-artifacts.mjs`
- Test: `scripts/bootstrap-gifts-lib.test.mjs`

**Interfaces:**
- `buildGiftRows` rows gain `actingForItemId: string | null` — from the payload's `Acting for`
  link resolved through the ledger (`itemBySfId`) like the Donor link; `GIFT_COLUMNS` gains
  `acting_for_item_id` and `renderSql`'s tuple writes it (NULL when null).
- New `buildAffiliationRows({ payloads, ledgerEntries, boards })` → rows
  `{ affiliationItemId, personItemId, personBoardId, name }` from payloads with `board === 'affiliations'`
  whose `Person` link resolves through the ledger; and `renderAffiliationsSql(rows, now)` using
  the same staged-swap pattern into `affiliations`.
- The CLI writes both SQL files (`--out-affiliations bootstrap-affiliations.sql`) and prints
  counts; the README's bootstrap steps gain the second `wrangler d1 execute`.

- [ ] **Step 1: Failing tests** — in `bootstrap-gifts-lib.test.mjs`, add a donation payload with
  `links: [{ column: 'Donor', targetSfIds: ['org1'] }, { column: 'Acting for', targetSfIds: ['af1'] }]`
  and ledger successes for `af1` on board `affiliations`; assert the row's `actingForItemId` is
  `af1`'s item id and that `renderSql` output contains `acting_for_item_id` and the id. Add an
  affiliations payload (`board: 'affiliations'`, `links: [{ column: 'Person', targetSfIds: ['c3'] }]`,
  `name: 'Uma N @ Beta Org'`) and assert `buildAffiliationRows` returns
  `{ affiliationItemId, personItemId, personBoardId: <people-live board id>, name }`, and that
  `renderAffiliationsSql` stages into `affiliations_bootstrap` and swaps.

- [ ] **Step 2: Implement** in the lib (mirror `buildGiftRows`; `boardIdByKey` already maps
  logical keys to ids). In the CLI, call `buildAffiliationRows`, write the second file, and print
  `${affRows.length} affiliations → ${OUT_AFF}`. Guard: refuse (without `--force`) when gifts
  reference an `Acting for` item the ledger lacks — count them and report, don't drop silently.

- [ ] **Step 3: Run and commit**

```bash
node --test scripts/bootstrap-gifts-lib.test.mjs   # or however the file is run today — check package.json / README
git add scripts/bootstrap-gifts-lib.mjs scripts/bootstrap-gifts-lib.test.mjs scripts/bootstrap-gifts-from-artifacts.mjs
git commit -m "feat(donation-rollups): bootstrap acting_for and the affiliations table from importer artifacts"
```

---

## Task 10: Column provisioning script, README

**Files:**
- Create: `scripts/setup-affiliation-columns.mjs`
- Modify: `README.md`

- [ ] **Step 1: Script** — copy the shape of `scripts/setup-owner-columns.mjs`. Usage:
  `MONDAY_API_TOKEN=... node scripts/setup-affiliation-columns.mjs <affiliationsBoardId> <peopleBoardId> [<peopleBoardId> ...]`.
  On the Affiliations board ensure (by title) `Attributed Giving` (numbers, currency),
  `Attributed Gift Count` (numbers), `Last Attributed Gift` (date), and find `Person`
  (board_relation, must already exist — error if missing); on each People board ensure
  `Organizational Giving` (numbers, currency). Print a config-ready JSON block:
  `{ "affiliations": { boardId, columns: { personLink, attributedGiving, attributedGiftCount, lastAttributedGift } }, "organizationalGivingByBoard": { "<peopleBoardId>": "<colId>" } }`
  plus a reminder to fill `donationBoards[].columns.actingForLink` from the Donations board's
  `Acting for` column id (print it too: read the Donations board id from `config/svbc.json` and
  look up the column titled `Acting for`).

- [ ] **Step 2: README** — add a "Affiliation model (Plan 2)" section after "Gift-history
  projections": what phase 2 writes and reads, the `affiliations: null` gate, the archived-gift
  rule for `acting_for`, the bootstrap step (`bootstrap-gifts-from-artifacts.mjs` now emits two
  SQL files; run both with `wrangler d1 execute … -y`), `setup-affiliation-columns.mjs`, the
  reconcile legs 5/6, and the deferred non-money rollups. Update the "Not yet done" list.

- [ ] **Step 3: Commit**

```bash
git add scripts/setup-affiliation-columns.mjs README.md
git commit -m "docs(donation-rollups): affiliation-model setup script and README section"
```

---

## Self-review against the spec

- **Rollups section:** per-affiliation money rollups (Tasks 2, 5, 6), Organizational Giving as the
  sum over a person's affiliations (Task 2's join, Task 6's write), reverse index extended (Task 1's
  `acting_for_item_id` + `affiliations`), personal and organization rollups untouched (phase 1
  unchanged; the Donor-link rule lives in the importer). Gift-history section (Task 7). Non-money
  rollups: deferred by ruling, recorded in Scope.
- **Ledger authority (docs/20):** D1 remains the source for every projection; reconcile covers the
  two new projections (Task 8); bootstrap covers both new tables (Task 9).
- **Gate:** every task's new behavior is behind `config.affiliations`; Task 6's test asserts the
  consumer makes no extra calls with the gate off.
- **Type consistency:** `AffiliationsConfig` (Task 1) is consumed by Tasks 5, 6, 8, 10;
  `AffiliationRow`/`AffiliationsStore` (Task 3) by Tasks 6, 7; `DonationRecord.actingForItemId`
  (Task 4) by Task 6's `affectedAffiliations`; `GiftHistoryRow.actingForItemId` (Task 2) by Task 7.
- **Open question for execution:** `getAffiliationSummary` costs two subrequests per affiliation
  (item + person's board). If a batch touches many affiliations (a bulk re-point), phase 2 could
  approach the Free-plan 50-subrequest cap; the consumer processes one message per invocation with
  `max_concurrency: 1`, and a single gift touches at most two affiliations, so this is fine until
  Workers Paid — note it in the README.
