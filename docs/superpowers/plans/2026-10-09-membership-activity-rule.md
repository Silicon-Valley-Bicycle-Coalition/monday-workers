# Membership Activity Rule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `donation-rollups` derives every person's membership from the full history of their gifts and volunteer check-ins under the 13-month activity rule, writes eight membership columns, and can recompute everyone once after cutover.

**Architecture:** The membership step inside the existing owner recompute stops folding post-cutover gifts over a captured baseline and instead builds *runs* from every qualifying activity (ledger gifts, migrated term starts, Event Registrations check-ins) and derives the owner's eight columns from those runs. Event Registrations becomes a second webhook source feeding a new D1 `volunteer_activity` table, and a new nightly custodian duty flips Member Type on anniversaries and, with `all=true`, drives the one-time post-cutover recompute.

**Tech Stack:** Cloudflare Workers, Hono, D1 (SQLite), Queues, TypeScript, Vitest with `@cloudflare/vitest-plugin` (D1 migrations auto-applied in tests via `test/apply-migrations.ts`), the repo's copied Monday GraphQL transport (`src/monday/graphql.ts`, never edited here).

**Spec:** `docs/superpowers/specs/2026-10-09-membership-activity-rule-design.md` (this repo). Planning record with every decision and the worked examples: private repo `monday-migration/docs/28-membership-activity-rule.md`. The mechanics being extended: `docs/superpowers/specs/2026-09-15-membership-renewal-write-path-design.md` and `donation-rollups/README.md` "Membership renewal write path".

All paths below are relative to `donation-rollups/` unless they start with `docs/` or `scripts/` at the repo root is named explicitly. Every command runs from `donation-rollups/`.

## Global Constraints

- Node 22.18+ (scripts import `.ts` through built-in type stripping; keep `src/monday/graphql.ts` strip-only compatible and **never edit it** — it is a byte-identical copy checked by the `monday-graphql-copies` CI job).
- Type-check only with `npm run typecheck` (regenerates `worker-configuration.d.ts`), never bare `tsc`.
- `node ../scripts/check-log-safety.mjs --staged` runs in the pre-commit hook: no `console.*` call may log an email address. Log item ids only.
- Every new SVBC-specific value (board ids, column ids, labels) goes in `config/svbc.json` and `config/sandbox.json`, validated in `src/config.ts`. `config/split.test.ts` must keep passing: sandbox ids never appear in `svbc.json`; production ids stay `0` / `null` / `REPLACE_WITH_COLUMN_ID` placeholders until cutover.
- Rule values, verbatim from the spec: `termMonths: 13`, `minAmountCents: 100`, `eligibleGiftTypes: ["Donation"]`, `lifetimeThresholdCents: 100000`, type labels `New` / `Continuing` / `Lapsed renewal` / `Lifetime`, blank Hours on a checked-in volunteer counts as 1 hour, Hours explicitly `0` does not qualify.
- Every Monday write stays compare-before-write (changed values only) so `mailchimp-sync` is not fanned out for nothing, and Member Since only ever moves earlier, Member Until only later (except blank for Lifetime), Tier never downgrades.
- Migration `0005` (`membership_baseline`) stays on disk; the table is simply no longer read. New migration is `0009`.
- The `fromISO` config key keeps its name and value (the cutover date); its meaning becomes "gifts before this date are migrated history whose Term Start is trusted; gifts on/after it get term stamps".
- Conventional commits, one commit per task, ending with the attribution line the session reminder gives.

## Review Focus

1. A Role = Volunteer, Attended registration whose linked Event has **no Start date** (or no Event link) must store `qualifies = 0` and recompute nobody, not throw. Pinned in Task 4 (`registrationQualifies`) and Task 8 (`processRegistration`).
2. An **Hours cell with unparseable text** (`"two"`) on a checked-in volunteer must count as blank, i.e. one hour, so a typo never un-members someone; `"0"` and `"0.5"` do not qualify. Pinned in Task 4 (`parseHours`).
3. A registration whose **Attendee link moves** from person A to person B must recompute both, otherwise A keeps a membership they no longer earned. Pinned in Task 8.
4. A **gift and a check-in on the same date** form one run with two activities, in a stable order on re-run, so Member Type and Lapse Count do not flicker between recomputes. Pinned in Task 5.
5. A one-activity run on its **13-month anniversary day** reads New/Lapsed renewal, not Continuing, for the single day it is both past the anniversary and still Active. Pinned in Task 5 (`memberTypeFor`).

---

### Task 1: Migration 0009 and the volunteer activity store

**Files:**
- Create: `migrations/0009_membership_activity.sql`
- Create: `src/db/volunteerActivity.ts`
- Test: `src/db/volunteerActivity.test.ts`

**Interfaces:**
- Consumes: nothing new; `env.DB` in tests comes from `cloudflare:test` with all migrations applied.
- Produces:
  ```ts
  export type VolunteerSource = 'webhook' | 'sweep' | 'historical';
  export interface VolunteerActivityRow {
    registrationItemId: string; boardId: string;
    ownerItemId: string | null; ownerBoardId: string | null;
    activityDateISO: string | null;   // the Event's Start (or the Volunteers row's Date); null = unknown
    hours: number | null;             // null = blank = counts as 1
    qualifies: boolean; source: VolunteerSource;
  }
  export interface VolunteerActivityStore {
    upsert(row: VolunteerActivityRow, now: string): Promise<{ previousOwner: { ownerItemId: string; ownerBoardId: string } | null }>;
    forOwner(ownerItemId: string): Promise<VolunteerActivityRow[]>;          // qualifying rows only
    markRemoved(registrationItemId: string, now: string): Promise<{ ownerItemId: string; ownerBoardId: string } | null>;
    ownersWithActivity(afterOwnerId: string, limit: number): Promise<{ ownerItemId: string; ownerBoardId: string }[]>;
  }
  export class D1VolunteerActivityStore implements VolunteerActivityStore { constructor(db: D1Database) }
  ```

- [ ] **Step 1: Write the migration**

`migrations/0009_membership_activity.sql`:

```sql
-- Membership activity rule (docs/superpowers/specs/2026-10-09-membership-activity-rule-design.md).
-- One row per Event Registrations item (or 2014-2020 Volunteers item) this Worker has read.
-- qualifies = 1 when Role, Attendance, Hours and the Attendee link all pass the rule; the
-- consumer folds qualifying rows into the owner's membership runs alongside their gifts.
CREATE TABLE volunteer_activity (
  registration_item_id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  owner_item_id TEXT,                -- Attendee / Volunteer link; NULL = unlinked, never qualifies
  owner_board_id TEXT,
  activity_date TEXT,                -- ISO date: the Event's Start, or the Volunteers row's Date; NULL = unknown
  hours REAL,                        -- NULL = blank = counts as 1 hour
  qualifies INTEGER NOT NULL,        -- 0 | 1
  source TEXT NOT NULL,              -- 'webhook' | 'sweep' | 'historical'
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_volunteer_activity_owner ON volunteer_activity (owner_item_id);

-- Migrated Term Start, read from the Donations board. NULL = not read yet (the membership
-- duty's backfill fills it); '' = read, and the gift has no term. Only consulted for gifts
-- dated before membership.fromISO — later gifts are stamped by this Worker itself.
ALTER TABLE gifts ADD COLUMN term_start TEXT;

-- What kind of item a pending row's id names: a Donations item, or an Event Registrations item.
ALTER TABLE pending_recomputes ADD COLUMN kind TEXT NOT NULL DEFAULT 'donation';
```

- [ ] **Step 2: Write the failing store test**

`src/db/volunteerActivity.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { D1VolunteerActivityStore, type VolunteerActivityRow } from './volunteerActivity';

const NOW = '2026-11-06T12:00:00Z';
const row = (over: Partial<VolunteerActivityRow> = {}): VolunteerActivityRow => ({
  registrationItemId: `r-${Math.random().toString(36).slice(2)}`, boardId: 'er',
  ownerItemId: 'p1', ownerBoardId: 'people', activityDateISO: '2027-03-14', hours: null,
  qualifies: true, source: 'webhook', ...over,
});

describe('D1VolunteerActivityStore', () => {
  it('upsert then forOwner reads back qualifying rows, nulls preserved', async () => {
    const store = new D1VolunteerActivityStore(env.DB);
    const r = row({ ownerItemId: 'owner-a', hours: null });
    expect(await store.upsert(r, NOW)).toEqual({ previousOwner: null });
    expect(await store.forOwner('owner-a')).toEqual([r]);
  });

  it('forOwner omits non-qualifying rows', async () => {
    const store = new D1VolunteerActivityStore(env.DB);
    await store.upsert(row({ ownerItemId: 'owner-b', qualifies: false }), NOW);
    await store.upsert(row({ ownerItemId: 'owner-b', hours: 2, qualifies: true }), NOW);
    expect((await store.forOwner('owner-b')).map((r) => r.hours)).toEqual([2]);
  });

  it('upsert reports the previous owner when the Attendee link moved, and null when unchanged', async () => {
    const store = new D1VolunteerActivityStore(env.DB);
    const r = row({ ownerItemId: 'owner-c', ownerBoardId: 'people' });
    await store.upsert(r, NOW);
    expect(await store.upsert({ ...r, ownerItemId: 'owner-d' }, NOW))
      .toEqual({ previousOwner: { ownerItemId: 'owner-c', ownerBoardId: 'people' } });
    expect(await store.upsert({ ...r, ownerItemId: 'owner-d' }, NOW)).toEqual({ previousOwner: null });
    expect(await store.forOwner('owner-c')).toEqual([]);
  });

  it('markRemoved flips qualifies off and returns the owner it had; unknown ids return null', async () => {
    const store = new D1VolunteerActivityStore(env.DB);
    const r = row({ ownerItemId: 'owner-e' });
    await store.upsert(r, NOW);
    expect(await store.markRemoved(r.registrationItemId, NOW)).toEqual({ ownerItemId: 'owner-e', ownerBoardId: 'people' });
    expect(await store.forOwner('owner-e')).toEqual([]);
    expect(await store.markRemoved('nope', NOW)).toBeNull();
  });

  it('ownersWithActivity lists distinct qualifying owners after a cursor, ordered', async () => {
    const store = new D1VolunteerActivityStore(env.DB);
    for (const o of ['z-owner-2', 'z-owner-1', 'z-owner-2']) await store.upsert(row({ ownerItemId: o }), NOW);
    await store.upsert(row({ ownerItemId: 'z-owner-3', qualifies: false }), NOW);
    expect(await store.ownersWithActivity('z-', 10)).toEqual([
      { ownerItemId: 'z-owner-1', ownerBoardId: 'people' }, { ownerItemId: 'z-owner-2', ownerBoardId: 'people' }]);
    expect(await store.ownersWithActivity('z-owner-1', 1)).toEqual([{ ownerItemId: 'z-owner-2', ownerBoardId: 'people' }]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test -- src/db/volunteerActivity.test.ts`
Expected: FAIL — cannot resolve `./volunteerActivity`.

- [ ] **Step 4: Implement the store**

`src/db/volunteerActivity.ts`:

```ts
// Event Registrations check-ins (and the 2014-2020 Volunteers board, loaded once) as
// membership activity — spec 2026-10-09 "Volunteer activity in D1". One row per registration
// item; the consumer folds qualifying rows into the owner's runs next to their gifts.
export type VolunteerSource = 'webhook' | 'sweep' | 'historical';

export interface VolunteerActivityRow {
  registrationItemId: string;
  boardId: string;
  ownerItemId: string | null;
  ownerBoardId: string | null;
  activityDateISO: string | null;
  hours: number | null;
  qualifies: boolean;
  source: VolunteerSource;
}

export interface VolunteerActivityStore {
  // Returns the owner the row pointed at before, when this write moved it to someone else —
  // the consumer recomputes that person too (same shape as a Donor-link re-point).
  upsert(row: VolunteerActivityRow, now: string): Promise<{ previousOwner: { ownerItemId: string; ownerBoardId: string } | null }>;
  forOwner(ownerItemId: string): Promise<VolunteerActivityRow[]>;
  // A deleted registration: keep the row, stop it counting, and say who it counted for.
  markRemoved(registrationItemId: string, now: string): Promise<{ ownerItemId: string; ownerBoardId: string } | null>;
  // Distinct owners with at least one qualifying row, cursored by owner id — the membership
  // duty's "people with check-ins but no gift" source.
  ownersWithActivity(afterOwnerId: string, limit: number): Promise<{ ownerItemId: string; ownerBoardId: string }[]>;
}

interface D1Row {
  registration_item_id: string; board_id: string; owner_item_id: string | null; owner_board_id: string | null;
  activity_date: string | null; hours: number | null; qualifies: number; source: VolunteerSource;
}

const fromRow = (r: D1Row): VolunteerActivityRow => ({
  registrationItemId: r.registration_item_id, boardId: r.board_id,
  ownerItemId: r.owner_item_id, ownerBoardId: r.owner_board_id,
  activityDateISO: r.activity_date, hours: r.hours, qualifies: r.qualifies === 1, source: r.source,
});

export class D1VolunteerActivityStore implements VolunteerActivityStore {
  constructor(private db: D1Database) {}

  async upsert(row: VolunteerActivityRow, now: string) {
    const before = await this.db
      .prepare(`SELECT owner_item_id, owner_board_id FROM volunteer_activity WHERE registration_item_id = ?1`)
      .bind(row.registrationItemId)
      .first<{ owner_item_id: string | null; owner_board_id: string | null }>();
    await this.db
      .prepare(`INSERT INTO volunteer_activity (registration_item_id, board_id, owner_item_id, owner_board_id,
                  activity_date, hours, qualifies, source, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                ON CONFLICT (registration_item_id) DO UPDATE SET
                  board_id = excluded.board_id, owner_item_id = excluded.owner_item_id,
                  owner_board_id = excluded.owner_board_id, activity_date = excluded.activity_date,
                  hours = excluded.hours, qualifies = excluded.qualifies, source = excluded.source,
                  updated_at = excluded.updated_at`)
      .bind(row.registrationItemId, row.boardId, row.ownerItemId, row.ownerBoardId,
        row.activityDateISO, row.hours, row.qualifies ? 1 : 0, row.source, now)
      .run();
    const moved = before !== null && before.owner_item_id !== null && before.owner_item_id !== row.ownerItemId;
    return { previousOwner: moved ? { ownerItemId: before.owner_item_id!, ownerBoardId: before.owner_board_id ?? '' } : null };
  }

  async forOwner(ownerItemId: string): Promise<VolunteerActivityRow[]> {
    const res = await this.db
      .prepare(`SELECT registration_item_id, board_id, owner_item_id, owner_board_id, activity_date, hours, qualifies, source
                FROM volunteer_activity WHERE owner_item_id = ?1 AND qualifies = 1
                ORDER BY activity_date, registration_item_id`)
      .bind(ownerItemId)
      .all<D1Row>();
    return res.results.map(fromRow);
  }

  async markRemoved(registrationItemId: string, now: string) {
    const r = await this.db
      .prepare(`SELECT owner_item_id, owner_board_id FROM volunteer_activity WHERE registration_item_id = ?1`)
      .bind(registrationItemId)
      .first<{ owner_item_id: string | null; owner_board_id: string | null }>();
    if (r === null) return null;
    await this.db
      .prepare(`UPDATE volunteer_activity SET qualifies = 0, updated_at = ?2 WHERE registration_item_id = ?1`)
      .bind(registrationItemId, now)
      .run();
    return r.owner_item_id === null ? null : { ownerItemId: r.owner_item_id, ownerBoardId: r.owner_board_id ?? '' };
  }

  async ownersWithActivity(afterOwnerId: string, limit: number) {
    const res = await this.db
      .prepare(`SELECT owner_item_id, MIN(owner_board_id) AS owner_board_id FROM volunteer_activity
                WHERE qualifies = 1 AND owner_item_id IS NOT NULL AND owner_item_id > ?1
                GROUP BY owner_item_id ORDER BY owner_item_id LIMIT ?2`)
      .bind(afterOwnerId, limit)
      .all<{ owner_item_id: string; owner_board_id: string }>();
    return res.results.map((r) => ({ ownerItemId: r.owner_item_id, ownerBoardId: r.owner_board_id }));
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `npm test -- src/db/volunteerActivity.test.ts`
Expected: PASS (5 tests). Also run `npm test -- src/db/membershipBaseline.test.ts` to confirm the migration applied cleanly beside 0005.

- [ ] **Step 6: Commit**

```bash
git add migrations/0009_membership_activity.sql src/db/volunteerActivity.ts src/db/volunteerActivity.test.ts
git commit -m "feat(donation-rollups): add volunteer_activity, gifts.term_start and pending kind (migration 0009)"
```

---

### Task 2: Ledger and pending-store support — `term_start`, `kind`, `writtenSince`

**Files:**
- Modify: `src/db/gifts.ts` (`GiftFact`, `refreshFacts`, `giftsForOwner`, two new methods)
- Modify: `src/projections/giftHistory.ts` (`GiftHistoryRow` gains `termStart?: string | null`)
- Modify: `src/db/pending.ts` (`NewPending.kind`, `PendingRow.kind`)
- Modify: `src/types.ts` (`PendingRow.kind`, `RecomputeKind`, `RecomputeQueueMessage.kind`)
- Modify: `src/db/ownerRecomputes.ts` (`writtenSince`)
- Test: `src/db/gifts.test.ts`, `src/db/pending.test.ts`, `src/db/ownerRecomputes.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // types.ts
  export type RecomputeKind = 'donation' | 'registration';
  export interface RecomputeQueueMessage { kind?: RecomputeKind; donationItemId: string; donationBoardId: string; ownerItemId?: string; ownerBoardId?: string }
  // donationItemId is the triggering item: a Donations item for kind 'donation' (the default), an
  // Event Registrations item for kind 'registration'. The name predates registrations.
  export interface PendingRow { ...existing; kind: RecomputeKind }
  // gifts.ts
  export interface GiftFact { ...existing; termStart?: string | null }   // undefined = column not configured, leave stored
  giftsMissingTermStart(beforeISO: string, afterItemId: string, limit: number): Promise<string[]>;
  setTermStarts(rows: { mondayItemId: string; termStart: string }[], now: string): Promise<void>;  // '' for a read blank
  // giftHistory.ts
  export interface GiftHistoryRow { ...existing; termStart?: string | null }
  // pending.ts
  export interface NewPending { ...existing; kind?: RecomputeKind }
  // ownerRecomputes.ts
  writtenSince(iso: string): Promise<Set<string>>;
  ```

- [ ] **Step 1: Write the failing gifts tests**

Append to `src/db/gifts.test.ts` (it already imports `env` from `cloudflare:test` and `D1GiftsStore`; reuse its existing `fact()` helper if one exists, else the inline rows below):

```ts
describe('term_start (membership activity rule)', () => {
  const base = { ownerItemId: 'o-ts', ownerBoardId: 'b1', amountCents: 500, giftDateISO: '2020-05-01', fiscalYear: 2020, status: 'Received' };
  it('refreshFacts stores a supplied termStart and leaves it alone when undefined', async () => {
    const store = new D1GiftsStore(env.DB);
    await store.refreshFacts([{ ...base, mondayItemId: 'ts-1', termStart: '2020-05-01' }], 'import', 'now');
    await store.refreshFacts([{ ...base, mondayItemId: 'ts-1' }], 'webhook', 'later');
    expect((await store.giftsForOwner('o-ts')).find((g) => g.mondayItemId === 'ts-1')?.termStart).toBe('2020-05-01');
  });
  it('giftsMissingTermStart lists pre-cutover gifts never read, cursored; setTermStarts clears them, blank as ""', async () => {
    const store = new D1GiftsStore(env.DB);
    await store.refreshFacts([
      { ...base, mondayItemId: 'ts-a', giftDateISO: '2019-01-01' },
      { ...base, mondayItemId: 'ts-b', giftDateISO: '2019-02-01' },
      { ...base, mondayItemId: 'ts-c', giftDateISO: '2026-11-01' },   // post-cutover: never listed
    ], 'import', 'now');
    expect(await store.giftsMissingTermStart('2026-10-16', '', 10)).toEqual(expect.arrayContaining(['ts-a', 'ts-b']));
    expect(await store.giftsMissingTermStart('2026-10-16', 'ts-a', 10)).not.toContain('ts-a');
    await store.setTermStarts([{ mondayItemId: 'ts-a', termStart: '2019-01-01' }, { mondayItemId: 'ts-b', termStart: '' }], 'now');
    expect(await store.giftsMissingTermStart('2026-10-16', '', 10)).not.toEqual(expect.arrayContaining(['ts-a', 'ts-b']));
    const rows = await store.giftsForOwner('o-ts');
    expect(rows.find((g) => g.mondayItemId === 'ts-b')?.termStart).toBe('');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- src/db/gifts.test.ts -t "term_start"`
Expected: FAIL — `giftsMissingTermStart is not a function` / `termStart` undefined.

- [ ] **Step 3: Implement in `gifts.ts`**

Add to `GiftFact`: `termStart?: string | null;`. Add to `StoredFacts`: `term_start: string | null;` and select it in `refreshFacts`'s read. In `factsDiffer` add `|| (g.termStart != null && g.termStart !== stored.term_start)`. In the upsert: add column `term_start` as `?13` to the INSERT list and `term_start = COALESCE(excluded.term_start, gifts.term_start)` to the UPDATE set, binding `g.termStart ?? null`. In `giftsForOwner`, select `g.term_start` and map it to `termStart: r.term_start`. Add to the interface and class:

```ts
  // Pre-cutover gifts whose migrated Term Start has never been read from the board (NULL, not
  // '' — a read blank is stored as '' so the backfill never re-reads it).
  giftsMissingTermStart(beforeISO: string, afterItemId: string, limit: number): Promise<string[]>;
  setTermStarts(rows: { mondayItemId: string; termStart: string }[], now: string): Promise<void>;
```

```ts
  async giftsMissingTermStart(beforeISO: string, afterItemId: string, limit: number): Promise<string[]> {
    const res = await this.db
      .prepare(`SELECT monday_item_id FROM gifts
                WHERE term_start IS NULL AND removed_at IS NULL AND gift_date < ?1 AND monday_item_id > ?2
                ORDER BY monday_item_id LIMIT ?3`)
      .bind(beforeISO, afterItemId, limit)
      .all<{ monday_item_id: string }>();
    return res.results.map((r) => r.monday_item_id);
  }

  async setTermStarts(rows: { mondayItemId: string; termStart: string }[], now: string): Promise<void> {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      await this.db.batch(chunk.map((r) => this.db
        .prepare(`UPDATE gifts SET term_start = ?2, updated_at = ?3 WHERE monday_item_id = ?1`)
        .bind(r.mondayItemId, r.termStart, now)));
    }
  }
```

In `src/projections/giftHistory.ts`, add `termStart?: string | null;` to `GiftHistoryRow` (nothing renders it).

- [ ] **Step 4: Pending `kind` and `writtenSince`, with tests**

Append to `src/db/pending.test.ts`:

```ts
it('stores and reads back kind, defaulting to donation', async () => {
  const store = new D1PendingStore(env.DB);
  await store.upsertPending({ donationItemId: 'reg-1', donationBoardId: 'er', eventId: 'e', receivedAt: 'now', kind: 'registration' });
  await store.upsertPending({ donationItemId: 'dn-k', donationBoardId: '1', eventId: 'e', receivedAt: 'now' });
  expect((await store.getPending('reg-1'))?.kind).toBe('registration');
  expect((await store.getPending('dn-k'))?.kind).toBe('donation');
});
```

Append to `src/db/ownerRecomputes.test.ts`:

```ts
it('writtenSince returns the owners whose last successful recompute landed at/after the instant', async () => {
  const store = new D1OwnerRecomputesStore(env.DB);
  await store.record({ ownerItemId: 'ws-old', ownerBoardId: 'b', fetchedAt: '2026-10-17T00:00:00Z', writtenAt: '2026-10-17T00:01:00Z' });
  await store.record({ ownerItemId: 'ws-new', ownerBoardId: 'b', fetchedAt: '2026-10-18T00:00:00Z', writtenAt: '2026-10-18T00:01:00Z' });
  const since = await store.writtenSince('2026-10-18T00:00:00Z');
  expect(since.has('ws-new')).toBe(true);
  expect(since.has('ws-old')).toBe(false);
});
```

Implement: in `types.ts` add `RecomputeKind`, `kind?: RecomputeKind` on `RecomputeQueueMessage` (with the comment from Interfaces), `kind: RecomputeKind` on `PendingRow`. In `pending.ts`: `NewPending.kind?: RecomputeKind`; `D1PendingRecord.kind: RecomputeKind`; `toPendingRow` maps `kind: record.kind`; `upsertPending` inserts `kind` (`row.kind ?? 'donation'`) and updates it on conflict; `getPending` selects `kind`. In `ownerRecomputes.ts`:

```ts
  // Owners recomputed at/after an instant — the membership duty's all=true pass skips them when
  // told the sweep already covered everyone (runbook step 4.0: sweep first, then membership).
  writtenSince(iso: string): Promise<Set<string>>;
```
```ts
  async writtenSince(iso: string): Promise<Set<string>> {
    const res = await this.db
      .prepare(`SELECT owner_item_id FROM owner_recomputes WHERE written_at >= ?1`)
      .bind(iso)
      .all<{ owner_item_id: string }>();
    return new Set(res.results.map((r) => r.owner_item_id));
  }
```

- [ ] **Step 5: Run the three test files**

Run: `npm test -- src/db/gifts.test.ts src/db/pending.test.ts src/db/ownerRecomputes.test.ts`
Expected: PASS. Then `npm run typecheck` — expect errors only in `processBatch.test.ts` fakes missing the two new `GiftsStore` methods and `writtenSince`; add `giftsMissingTermStart: vi.fn().mockResolvedValue([])`, `setTermStarts: vi.fn().mockResolvedValue(undefined)` to `fakeGiftsStore()` and `writtenSince: vi.fn().mockResolvedValue(new Set())` to `fakeRecomputesStore()` in `src/consumer/processBatch.test.ts`, and the same two gifts fakes anywhere else `GiftsStore` is faked (`grep -rn "ownersWithOneGift: vi.fn" src`). Re-run `npm run typecheck`: clean.

- [ ] **Step 6: Commit**

```bash
git add src/db src/projections/giftHistory.ts src/types.ts src/consumer/processBatch.test.ts
git commit -m "feat(donation-rollups): persist migrated Term Start, pending kind, and writtenSince"
```

---
### Task 3: Config shape — eight owner columns, `minAmountCents`, renamed type labels, volunteer boards

**Files:**
- Modify: `src/types.ts` (`OwnerMembershipColumns`, `MembershipConfig`, new `VolunteerBoardConfig`, `HistoricalVolunteerBoardConfig`, `donationRollups.volunteerBoards` / `.historicalVolunteerBoards`)
- Modify: `src/config.ts` (`MEMBERSHIP_COLUMNS`, `validateMembership`, new `validateVolunteerBoards`, `validateHistoricalVolunteerBoards`)
- Modify: `config/svbc.json`, `config/sandbox.json`
- Test: `src/config.test.ts`, `config/split.test.ts`

**Interfaces:**
- Produces (`src/types.ts`):
  ```ts
  export interface OwnerMembershipColumns {
    status: string; tier: string; since: string; until: string;
    currentTermStart: string; memberType: string; lapseCount: string; lastLapsed: string;
  }
  export interface MembershipConfig {
    fromISO: string; eligibleGiftTypes: string[]; minAmountCents: number; termMonths: number; lifetimeThresholdCents: number;
    statusLabels: { active: string; lapsed: string };
    tierLabels: { member: string; lifetime: string };
    typeLabels: { new: string; continuing: string; lapsedRenewal: string; lifetime: string };
  }
  export interface VolunteerBoardConfig {
    boardId: number;
    columns: { attendee: string; event: string; attendance: string; role: string; hours: string | null };
    eventBoard: { boardId: number; columns: { start: string } };
    volunteerRoleLabels: string[]; countedAttendanceLabels: string[];
  }
  export interface HistoricalVolunteerBoardConfig {
    boardId: number;
    columns: { volunteer: string; date: string; hours: string; status: string };
    countedStatusLabels: string[];
  }
  // DonationRollupsConfig.donationRollups gains:
  volunteerBoards: VolunteerBoardConfig[]; historicalVolunteerBoards: HistoricalVolunteerBoardConfig[];
  ```
- Validation rules: both arrays are required (may be empty) whenever `membership` is non-null, and default to `[]` when it is null; every owner `membership` block must have all eight keys; `minAmountCents` non-negative integer; `typeLabels` keys exactly `new`, `continuing`, `lapsedRenewal`, `lifetime`.

- [ ] **Step 1: Update the test fixtures and add failing tests**

In `src/config.test.ts`, change the fixtures at the top:

```ts
const membershipColumns = { status: 'ms', tier: 'mt', since: 'msince', until: 'muntil',
  currentTermStart: 'mcts', memberType: 'mtype', lapseCount: 'mlc', lastLapsed: 'mll' };
const membership = {
  fromISO: '2026-10-16', eligibleGiftTypes: ['Donation'], minAmountCents: 100, termMonths: 13, lifetimeThresholdCents: 100000,
  statusLabels: { active: 'Active', lapsed: 'Lapsed' },
  tierLabels: { member: 'Member', lifetime: 'Lifetime' },
  typeLabels: { new: 'New', continuing: 'Continuing', lapsedRenewal: 'Lapsed renewal', lifetime: 'Lifetime' },
};
const volunteerBoard = {
  boardId: 7, columns: { attendee: 'att', event: 'ev', attendance: 'atd', role: 'role', hours: null },
  eventBoard: { boardId: 8, columns: { start: 'start' } },
  volunteerRoleLabels: ['Volunteer'], countedAttendanceLabels: ['Attended'],
};
const historicalVolunteerBoard = {
  boardId: 9, columns: { volunteer: 'vol', date: 'dt', hours: 'hrs', status: 'st' }, countedStatusLabels: ['Completed'],
};
```

and add `volunteerBoards: [volunteerBoard], historicalVolunteerBoards: [historicalVolunteerBoard]` to `base.donationRollups`. Update the `documentedMembershipBlock` constant (around line 60–70) to the same shape as `membership` above. Update the existing `it.each` rejection row `['typeLabels', { new: 'New', renewal: 'Renewal', reacquire: 'Reacquire' }, /typeLabels\.lifetime/]` to `['typeLabels', { new: 'New', continuing: 'Continuing', lapsedRenewal: 'Lapsed renewal' }, /typeLabels\.lifetime/]` and the partial-owner-block test to expect `/membership\.currentTermStart/` when the four new keys are missing. Then add:

```ts
describe('validateConfig — membership activity rule (spec 2026-10-09)', () => {
  it('passes minAmountCents and the renamed type labels through', () => {
    const m = validateConfig(base).donationRollups.membership!;
    expect(m.minAmountCents).toBe(100);
    expect(m.typeLabels).toEqual({ new: 'New', continuing: 'Continuing', lapsedRenewal: 'Lapsed renewal', lifetime: 'Lifetime' });
  });
  it.each([
    ['minAmountCents', -1, /minAmountCents/],
    ['minAmountCents', 1.5, /minAmountCents/],
    ['typeLabels', { new: 'New', renewal: 'Renewal', reacquire: 'Reacquire', lifetime: 'Lifetime' }, /typeLabels\.continuing/],
  ])('rejects a bad membership.%s', (key, value, pattern) => {
    const bad = { ...base, donationRollups: { ...base.donationRollups, membership: { ...membership, [key]: value } } };
    expect(() => validateConfig(bad)).toThrow(pattern);
  });
  it('requires all eight owner membership columns', () => {
    const { lastLapsed: _l, ...seven } = membershipColumns;
    const bad = { ...base, donationRollups: { ...base.donationRollups, ownerColumnsByBoard: { '2': { ...ownerColumns, membership: seven } } } };
    expect(() => validateConfig(bad)).toThrow(/membership\.lastLapsed/);
  });
  it('passes volunteer boards through, hours may be null, arrays may be empty', () => {
    const cfg = validateConfig(base).donationRollups;
    expect(cfg.volunteerBoards).toEqual([volunteerBoard]);
    expect(cfg.historicalVolunteerBoards).toEqual([historicalVolunteerBoard]);
    const empty = validateConfig({ ...base, donationRollups: { ...base.donationRollups, volunteerBoards: [], historicalVolunteerBoards: [] } });
    expect(empty.donationRollups.volunteerBoards).toEqual([]);
  });
  it('requires both volunteer arrays when membership is on, and defaults them to [] when it is off', () => {
    const { volunteerBoards: _v, ...rest } = base.donationRollups;
    expect(() => validateConfig({ ...base, donationRollups: rest })).toThrow(/volunteerBoards/);
    const off = validateConfig({ ...base, donationRollups: { ...rest, membership: null, historicalVolunteerBoards: undefined } });
    expect(off.donationRollups.volunteerBoards).toEqual([]);
    expect(off.donationRollups.historicalVolunteerBoards).toEqual([]);
  });
  it.each([
    ['columns.attendee', { ...volunteerBoard, columns: { ...volunteerBoard.columns, attendee: '' } }, /volunteerBoards\[0\]\.columns\.attendee/],
    ['eventBoard.columns.start', { ...volunteerBoard, eventBoard: { boardId: 8, columns: { start: '' } } }, /eventBoard\.columns\.start/],
    ['volunteerRoleLabels', { ...volunteerBoard, volunteerRoleLabels: [] }, /volunteerRoleLabels/],
    ['hours as a number', { ...volunteerBoard, columns: { ...volunteerBoard.columns, hours: 3 } }, /columns\.hours/],
  ])('rejects a bad volunteerBoards %s', (_label, board, pattern) => {
    const bad = { ...base, donationRollups: { ...base.donationRollups, volunteerBoards: [board] } };
    expect(() => validateConfig(bad)).toThrow(pattern);
  });
  it('rejects a historical volunteer board missing its status column', () => {
    const { status: _s, ...columns } = historicalVolunteerBoard.columns;
    const bad = { ...base, donationRollups: { ...base.donationRollups, historicalVolunteerBoards: [{ ...historicalVolunteerBoard, columns }] } };
    expect(() => validateConfig(bad)).toThrow(/historicalVolunteerBoards\[0\]\.columns\.status/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- src/config.test.ts`
Expected: FAIL on the new describe block and on the fixtures (`typeLabels.renewal` required by the old validator).

- [ ] **Step 3: Implement the types and validation**

`src/types.ts`: replace `OwnerMembershipColumns` and `MembershipConfig` with the Interfaces block above (keep the comments), add `VolunteerBoardConfig` and `HistoricalVolunteerBoardConfig`, and add `volunteerBoards` / `historicalVolunteerBoards` to `donationRollups` in `DonationRollupsConfig`.

`src/config.ts`:

```ts
const MEMBERSHIP_COLUMNS = ['status', 'tier', 'since', 'until', 'currentTermStart', 'memberType', 'lapseCount', 'lastLapsed'] as const;
```

In `validateOwnerColumns`, build `membership` from all eight keys:

```ts
    membership = Object.fromEntries(MEMBERSHIP_COLUMNS.map((k) => [k, m[k] as string])) as unknown as OwnerMembershipColumns;
```

In `validateMembership`, after `termMonths`:

```ts
  if (typeof m.minAmountCents !== 'number' || !Number.isInteger(m.minAmountCents) || m.minAmountCents < 0) {
    throw new Error('config: "donationRollups.membership.minAmountCents" must be a non-negative integer');
  }
```

return it, and change the `typeLabels` keys to `['new', 'continuing', 'lapsedRenewal', 'lifetime']`. Add two validators:

```ts
const nonEmptyLabels = (v: unknown, path: string): string[] => {
  if (!Array.isArray(v) || v.length === 0 || v.some((s) => typeof s !== 'string' || s === '')) {
    throw new Error(`config: ${path} must be a non-empty array of labels`);
  }
  return v as string[];
};
const columnId = (v: unknown, path: string): string => {
  if (typeof v !== 'string' || v === '') throw new Error(`config: ${path} must be a Monday column id string`);
  return v;
};

function validateVolunteerBoards(raw: unknown, membershipOn: boolean): VolunteerBoardConfig[] {
  if (raw === undefined || raw === null) {
    if (membershipOn) throw new Error('config: "donationRollups.volunteerBoards" is required (may be []) when membership is configured');
    return [];
  }
  if (!Array.isArray(raw)) throw new Error('config: "donationRollups.volunteerBoards" must be an array');
  return raw.map((b, i) => {
    const path = `donationRollups.volunteerBoards[${i}]`;
    const v = (typeof b === 'object' && b !== null ? b : {}) as Record<string, unknown>;
    if (typeof v.boardId !== 'number') throw new Error(`config: ${path}.boardId must be a number`);
    const c = (typeof v.columns === 'object' && v.columns !== null ? v.columns : {}) as Record<string, unknown>;
    if (c.hours !== undefined && c.hours !== null && (typeof c.hours !== 'string' || c.hours === '')) {
      throw new Error(`config: ${path}.columns.hours must be a column id string or null`);
    }
    const e = (typeof v.eventBoard === 'object' && v.eventBoard !== null ? v.eventBoard : {}) as Record<string, unknown>;
    if (typeof e.boardId !== 'number') throw new Error(`config: ${path}.eventBoard.boardId must be a number`);
    const ec = (typeof e.columns === 'object' && e.columns !== null ? e.columns : {}) as Record<string, unknown>;
    return {
      boardId: v.boardId,
      columns: {
        attendee: columnId(c.attendee, `${path}.columns.attendee`), event: columnId(c.event, `${path}.columns.event`),
        attendance: columnId(c.attendance, `${path}.columns.attendance`), role: columnId(c.role, `${path}.columns.role`),
        hours: (c.hours ?? null) as string | null,
      },
      eventBoard: { boardId: e.boardId, columns: { start: columnId(ec.start, `${path}.eventBoard.columns.start`) } },
      volunteerRoleLabels: nonEmptyLabels(v.volunteerRoleLabels, `${path}.volunteerRoleLabels`),
      countedAttendanceLabels: nonEmptyLabels(v.countedAttendanceLabels, `${path}.countedAttendanceLabels`),
    };
  });
}

function validateHistoricalVolunteerBoards(raw: unknown, membershipOn: boolean): HistoricalVolunteerBoardConfig[] {
  if (raw === undefined || raw === null) {
    if (membershipOn) throw new Error('config: "donationRollups.historicalVolunteerBoards" is required (may be []) when membership is configured');
    return [];
  }
  if (!Array.isArray(raw)) throw new Error('config: "donationRollups.historicalVolunteerBoards" must be an array');
  return raw.map((b, i) => {
    const path = `donationRollups.historicalVolunteerBoards[${i}]`;
    const v = (typeof b === 'object' && b !== null ? b : {}) as Record<string, unknown>;
    if (typeof v.boardId !== 'number') throw new Error(`config: ${path}.boardId must be a number`);
    const c = (typeof v.columns === 'object' && v.columns !== null ? v.columns : {}) as Record<string, unknown>;
    return {
      boardId: v.boardId,
      columns: {
        volunteer: columnId(c.volunteer, `${path}.columns.volunteer`), date: columnId(c.date, `${path}.columns.date`),
        hours: columnId(c.hours, `${path}.columns.hours`), status: columnId(c.status, `${path}.columns.status`),
      },
      countedStatusLabels: nonEmptyLabels(v.countedStatusLabels, `${path}.countedStatusLabels`),
    };
  });
}
```

In `validateConfig`, after `const membership = validateMembership(dr.membership);`:

```ts
  const volunteerBoards = validateVolunteerBoards(dr.volunteerBoards, membership !== null);
  const historicalVolunteerBoards = validateHistoricalVolunteerBoards(dr.historicalVolunteerBoards, membership !== null);
```

and include both in the returned `donationRollups`. Import the two new types.

- [ ] **Step 4: Update the shipped configs**

`config/svbc.json` — in `donationRollups`: the `membership` block becomes

```json
"membership": {
  "fromISO": "2026-10-16",
  "eligibleGiftTypes": ["Donation"],
  "minAmountCents": 100,
  "termMonths": 13,
  "lifetimeThresholdCents": 100000,
  "statusLabels": { "active": "Active", "lapsed": "Lapsed" },
  "tierLabels": { "member": "Member", "lifetime": "Lifetime" },
  "typeLabels": { "new": "New", "continuing": "Continuing", "lapsedRenewal": "Lapsed renewal", "lifetime": "Lifetime" }
},
"volunteerBoards": [{
  "boardId": 0,
  "columns": { "attendee": "REPLACE_WITH_COLUMN_ID", "event": "REPLACE_WITH_COLUMN_ID", "attendance": "REPLACE_WITH_COLUMN_ID", "role": "REPLACE_WITH_COLUMN_ID", "hours": null },
  "eventBoard": { "boardId": 0, "columns": { "start": "REPLACE_WITH_COLUMN_ID" } },
  "volunteerRoleLabels": ["Volunteer"],
  "countedAttendanceLabels": ["Attended"]
}],
"historicalVolunteerBoards": [{
  "boardId": 0,
  "columns": { "volunteer": "REPLACE_WITH_COLUMN_ID", "date": "REPLACE_WITH_COLUMN_ID", "hours": "REPLACE_WITH_COLUMN_ID", "status": "REPLACE_WITH_COLUMN_ID" },
  "countedStatusLabels": ["Completed"]
}]
```

and the `"0"` owner entry's `membership` block gains `"currentTermStart"`, `"memberType"`, `"lapseCount"`, `"lastLapsed"`, each `"REPLACE_WITH_COLUMN_ID"`.

`config/sandbox.json` — the CRM Sandbox v3 boards do not have the four new People columns or an Hours column yet; Task 14 provisions them and fills real ids. Until then the sandbox must still validate, so in this task set `"membership": null`, add `"volunteerBoards": []` and `"historicalVolunteerBoards": []`, and **remove** the `membership` sub-block from both People entries in `ownerColumnsByBoard` (`18431577220`, `18431577228`) — keep the four ids in a comment-free scratch note for Task 14: status `color_mm79yw6p` / tier `color_mm79baj4` / since `date_mm79y9fa` / until `date_mm79p82j` on 18431577220; read the 18431577228 four from the file before deleting them and paste them into the Task 14 step. (`README` "Enabling" already documents membership as switchable off for exactly this reason.)

- [ ] **Step 5: Extend `config/split.test.ts`**

In the `'no sandbox column id appears anywhere in production'` test, add to the `sandboxIds` set:

```ts
      ...sandbox.donationRollups.volunteerBoards.flatMap((b) => [...columnIds(b.columns as Record<string, unknown>), ...columnIds(b.eventBoard.columns as Record<string, unknown>)]),
      ...sandbox.donationRollups.historicalVolunteerBoards.flatMap((b) => columnIds(b.columns as Record<string, unknown>)),
```

and add a board-id test:

```ts
  it('volunteer boards: production ids are placeholders or differ from the sandbox ones', () => {
    const sandboxBoards = new Set([
      ...sandbox.donationRollups.volunteerBoards.flatMap((b) => [b.boardId, b.eventBoard.boardId]),
      ...sandbox.donationRollups.historicalVolunteerBoards.map((b) => b.boardId),
    ]);
    for (const b of production.donationRollups.volunteerBoards) {
      for (const id of [b.boardId, b.eventBoard.boardId]) expect(isPlaceholder(id) || !sandboxBoards.has(id), String(id)).toBe(true);
    }
    for (const b of production.donationRollups.historicalVolunteerBoards) {
      expect(isPlaceholder(b.boardId) || !sandboxBoards.has(b.boardId), String(b.boardId)).toBe(true);
    }
  });
```

- [ ] **Step 6: Run the tests and type-check**

Run: `npm test -- src/config.test.ts config/split.test.ts`
Expected: PASS. `npm run typecheck` will now fail in `derive.ts`, `processBatch.ts`, `client.ts`, `index.ts` and their tests on the renamed `typeLabels` keys and the eight-key column block — expected; Tasks 5–9 fix them. Do not patch those here.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/config.ts src/config.test.ts config/
git commit -m "feat(donation-rollups): config for the activity rule — eight membership columns, minAmountCents, volunteer boards"
```

---

### Task 4: Volunteer qualification rules (pure)

**Files:**
- Create: `src/membership/volunteer.ts`
- Test: `src/membership/volunteer.test.ts`

**Interfaces:**
- Consumes: `VolunteerBoardConfig`, `HistoricalVolunteerBoardConfig` (Task 3).
- Produces:
  ```ts
  export function parseHours(text: string | null): number | null;   // null = blank or unparseable (counts as 1)
  export interface RegistrationFacts { attendeeItemId: string | null; attendanceLabel: string | null; roleLabel: string | null; hours: number | null }
  export function registrationQualifies(reg: RegistrationFacts, eventStartISO: string | null, board: VolunteerBoardConfig): boolean;
  export interface HistoricalShiftFacts { volunteerItemId: string | null; dateISO: string | null; hours: number | null; statusLabel: string | null }
  export function historicalShiftQualifies(shift: HistoricalShiftFacts, board: HistoricalVolunteerBoardConfig): boolean;
  ```

- [ ] **Step 1: Write the failing tests**

`src/membership/volunteer.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseHours, registrationQualifies, historicalShiftQualifies } from './volunteer';
import type { VolunteerBoardConfig, HistoricalVolunteerBoardConfig } from '../types';

const board: VolunteerBoardConfig = {
  boardId: 7, columns: { attendee: 'att', event: 'ev', attendance: 'atd', role: 'role', hours: 'hrs' },
  eventBoard: { boardId: 8, columns: { start: 'start' } },
  volunteerRoleLabels: ['Volunteer'], countedAttendanceLabels: ['Attended'],
};
const historical: HistoricalVolunteerBoardConfig = {
  boardId: 9, columns: { volunteer: 'vol', date: 'dt', hours: 'hrs', status: 'st' }, countedStatusLabels: ['Completed'],
};
const reg = (over = {}) => ({ attendeeItemId: 'p1', attendanceLabel: 'Attended', roleLabel: 'Volunteer', hours: null, ...over });

describe('parseHours', () => {
  it.each([[null, null], ['', null], ['  ', null], ['two', null], ['3', 3], ['2.5', 2.5], ['0', 0], ['1,5', null]])
    ('%j → %j', (text, want) => expect(parseHours(text)).toBe(want));
});

describe('registrationQualifies (decided 2026-10-09: a checked-in volunteer counts as one hour)', () => {
  it('qualifies with Role = Volunteer, Attended, blank Hours and a dated Event', () => {
    expect(registrationQualifies(reg(), '2027-05-02', board)).toBe(true);
  });
  it.each([
    ['Hours 0', reg({ hours: 0 })], ['Hours 0.5', reg({ hours: 0.5 })],
    ['Participant role', reg({ roleLabel: 'Participant' })], ['no role', reg({ roleLabel: null })],
    ['Registered only', reg({ attendanceLabel: 'Registered' })], ['No Show', reg({ attendanceLabel: 'No Show' })],
    ['no attendee', reg({ attendeeItemId: null })],
  ])('does not qualify: %s', (_label, r) => expect(registrationQualifies(r, '2027-05-02', board)).toBe(false));
  it('does not qualify without an Event Start date (Review Focus 1)', () => {
    expect(registrationQualifies(reg(), null, board)).toBe(false);
  });
  it('Hours 1 and Hours 3 qualify', () => {
    expect(registrationQualifies(reg({ hours: 1 }), '2027-05-02', board)).toBe(true);
    expect(registrationQualifies(reg({ hours: 3 }), '2027-05-02', board)).toBe(true);
  });
});

describe('historicalShiftQualifies', () => {
  const shift = (over = {}) => ({ volunteerItemId: 'p1', dateISO: '2019-06-01', hours: 2, statusLabel: 'Completed', ...over });
  it('a Completed shift with hours ≥ 1 and a date qualifies', () => expect(historicalShiftQualifies(shift(), historical)).toBe(true));
  it.each([
    ['Canceled', shift({ statusLabel: 'Canceled' })], ['blank hours', shift({ hours: null })], ['0.5 hours', shift({ hours: 0.5 })],
    ['no date', shift({ dateISO: null })], ['no volunteer', shift({ volunteerItemId: null })],
  ])('does not qualify: %s', (_label, s) => expect(historicalShiftQualifies(s, historical)).toBe(false));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- src/membership/volunteer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/membership/volunteer.ts`:

```ts
// Which volunteer records count as membership activity (spec 2026-10-09 "Qualifying
// activities"). Pure, like derive.ts: the consumer and the custodian both call these with
// what they read; nothing here does I/O.
import type { VolunteerBoardConfig, HistoricalVolunteerBoardConfig } from '../types';

// Monday's `text` for a numbers column: '' when blank. Anything that isn't a plain decimal
// reads as blank — a typo in Hours must never cost a checked-in volunteer their membership
// (blank = one hour by decision). A real 0 is a real 0 and does not qualify.
export function parseHours(text: string | null): number | null {
  if (text === null) return null;
  const t = text.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

export interface RegistrationFacts {
  attendeeItemId: string | null;
  attendanceLabel: string | null;
  roleLabel: string | null;
  hours: number | null;
}

export function registrationQualifies(reg: RegistrationFacts, eventStartISO: string | null, board: VolunteerBoardConfig): boolean {
  return reg.attendeeItemId !== null
    && eventStartISO !== null
    && reg.roleLabel !== null && board.volunteerRoleLabels.includes(reg.roleLabel)
    && reg.attendanceLabel !== null && board.countedAttendanceLabels.includes(reg.attendanceLabel)
    && (reg.hours === null || reg.hours >= 1);
}

export interface HistoricalShiftFacts {
  volunteerItemId: string | null;
  dateISO: string | null;
  hours: number | null;
  statusLabel: string | null;
}

// The 2014-2020 Volunteers board recorded real hours, so blank there is blank, not one.
export function historicalShiftQualifies(shift: HistoricalShiftFacts, board: HistoricalVolunteerBoardConfig): boolean {
  return shift.volunteerItemId !== null
    && shift.dateISO !== null
    && shift.statusLabel !== null && board.countedStatusLabels.includes(shift.statusLabel)
    && shift.hours !== null && shift.hours >= 1;
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- src/membership/volunteer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/membership/volunteer.ts src/membership/volunteer.test.ts
git commit -m "feat(donation-rollups): volunteer check-in qualification rules"
```

---

### Task 5: The derivation — runs, eight columns, term stamps

**Files:**
- Rewrite: `src/membership/derive.ts`
- Rewrite: `src/membership/derive.test.ts`

**Interfaces:**
- Consumes: `MembershipConfig`, `OwnerMembershipColumns` (Task 3); `VolunteerActivityRow` (Task 1).
- Produces:
  ```ts
  export type Tier = 'member' | 'lifetime';
  export type TermType = 'new' | 'continuing' | 'lapsedRenewal' | 'lifetime';
  export type MemberType = 'new' | 'continuing' | 'lapsedRenewal';
  export type ActivityKind = 'gift' | 'migrated-term' | 'volunteer';
  export interface MembershipActivity { id: string; kind: ActivityKind; dateISO: string; lifetime: boolean }
  export interface MembershipGift { id: string; dateISO: string; amountCents: number; status: string; giftType: string | null; termStart: string | null }
  export interface Run { start: string; end: string; activities: number }
  export interface OwnerMembershipState {
    since: string | null; currentTermStart: string | null; until: string | null; tier: Tier | null;
    lapseCount: number; lastLapsed: string | null; memberType: MemberType | null;
  }
  export interface GiftTerm { start: string; end: string | null; type: TermType }
  export interface DerivedMembership { state: OwnerMembershipState | null; terms: Map<string, GiftTerm> }   // state null = no activity at all
  export interface BoardMembership {   // what the owner item holds now, as read
    statusLabel: string | null; tierLabel: string | null; since: string | null; until: string | null;
    currentTermStart: string | null; memberTypeLabel: string | null; lapseCount: number | null; lastLapsed: string | null;
  }
  export function addMonths(iso: string, months: number): string;                        // unchanged
  export function isQualifyingGift(g: MembershipGift, config: MembershipConfig, receivedStatusLabel: string): boolean;
  export function activitiesFor(gifts: MembershipGift[], volunteers: VolunteerActivityRow[], config: MembershipConfig, receivedStatusLabel: string): MembershipActivity[];
  export function buildRuns(activities: MembershipActivity[], termMonths: number): Run[];
  export function memberTypeFor(run: Run, lapseCount: number, todayISO: string, termMonths: number): MemberType;
  export function deriveMembership(gifts: MembershipGift[], volunteers: VolunteerActivityRow[], config: MembershipConfig, receivedStatusLabel: string, todayISO: string): DerivedMembership;
  export function mergeWithBoard(derived: OwnerMembershipState, board: { since: string | null; until: string | null; tier: Tier | null }): OwnerMembershipState;
  export function statusFor(state: OwnerMembershipState, todayISO: string): 'active' | 'lapsed';
  export function tierFromLabel(label: string | null, config: MembershipConfig): Tier | null;   // unchanged
  export function membershipColumnValues(merged: OwnerMembershipState, status: 'active' | 'lapsed', board: BoardMembership, columns: OwnerMembershipColumns, config: MembershipConfig): Record<string, unknown>;
  export function termColumnValues(term: GiftTerm | undefined, current: { termStart: string | null; termEnd: string | null; membershipType: string | null }, columns: { termStart: string; termEnd: string; membershipType: string }, config: MembershipConfig): Record<string, unknown>;   // unchanged
  ```
  `EMPTY_STATE` is removed.

- [ ] **Step 1: Rewrite the tests**

Replace `src/membership/derive.test.ts` with:

```ts
import { describe, it, expect } from 'vitest';
import {
  addMonths, isQualifyingGift, activitiesFor, buildRuns, memberTypeFor, deriveMembership, mergeWithBoard,
  statusFor, membershipColumnValues, termColumnValues,
  type MembershipGift, type OwnerMembershipState, type BoardMembership,
} from './derive';
import type { MembershipConfig } from '../types';
import type { VolunteerActivityRow } from '../db/volunteerActivity';

const config: MembershipConfig = {
  fromISO: '2026-10-16', eligibleGiftTypes: ['Donation'], minAmountCents: 100, termMonths: 13, lifetimeThresholdCents: 100000,
  statusLabels: { active: 'Active', lapsed: 'Lapsed' },
  tierLabels: { member: 'Member', lifetime: 'Lifetime' },
  typeLabels: { new: 'New', continuing: 'Continuing', lapsedRenewal: 'Lapsed renewal', lifetime: 'Lifetime' },
};
const RECEIVED = 'Received';
const gift = (over: Partial<MembershipGift>): MembershipGift => ({
  id: 'g1', dateISO: '2026-11-03', amountCents: 2500, status: RECEIVED, giftType: 'Donation', termStart: null, ...over,
});
const checkin = (over: Partial<VolunteerActivityRow>): VolunteerActivityRow => ({
  registrationItemId: 'r1', boardId: 'er', ownerItemId: 'p1', ownerBoardId: 'people',
  activityDateISO: '2027-03-14', hours: null, qualifies: true, source: 'webhook', ...over,
});
const COLS = { status: 'ms', tier: 'mt', since: 'msince', until: 'muntil', currentTermStart: 'mcts', memberType: 'mtype', lapseCount: 'mlc', lastLapsed: 'mll' };
const blankBoard: BoardMembership = { statusLabel: null, tierLabel: null, since: null, until: null, currentTermStart: null, memberTypeLabel: null, lapseCount: null, lastLapsed: null };

describe('addMonths', () => {
  it('adds 13 months', () => expect(addMonths('2026-11-03', 13)).toBe('2027-12-03'));
  it('rolls Feb 29 forward', () => expect(addMonths('2028-02-29', 13)).toBe('2029-04-01'));
  it('clamps month-end overflow to the 1st of the next month', () => expect(addMonths('2026-01-31', 1)).toBe('2026-03-01'));
});

describe('isQualifyingGift', () => {
  it('accepts a Received Donation of $1.00 or more on any date', () => {
    expect(isQualifyingGift(gift({ amountCents: 100 }), config, RECEIVED)).toBe(true);
    expect(isQualifyingGift(gift({ dateISO: '2015-01-01' }), config, RECEIVED)).toBe(true);
  });
  it.each([
    ['$0.99', gift({ amountCents: 99 })], ['Matching Donation', gift({ giftType: 'Matching Donation' })],
    ['null type', gift({ giftType: null })], ['Pending', gift({ status: 'Pending' })],
    ['Received (Historical)', gift({ status: 'Received (Historical)' })], ['no date', gift({ dateISO: '' })],
  ])('rejects %s', (_l, g) => expect(isQualifyingGift(g, config, RECEIVED)).toBe(false));
});

describe('activitiesFor', () => {
  it('a qualifying gift is a gift activity; a pre-cutover $0 gift with a Term Start is a migrated term; a blank Term Start is nothing', () => {
    const acts = activitiesFor([
      gift({ id: 'a', dateISO: '2026-11-03' }),
      gift({ id: 'b', dateISO: '2019-05-01', amountCents: 0, termStart: '2019-05-01' }),
      gift({ id: 'c', dateISO: '2019-06-01', amountCents: 0, termStart: '' }),
      gift({ id: 'd', dateISO: '2026-11-20', amountCents: 0, termStart: '2026-11-20' }),   // post-cutover: amount rule only
    ], [], config, RECEIVED);
    expect(acts).toEqual([
      { id: 'b', kind: 'migrated-term', dateISO: '2019-05-01', lifetime: false },
      { id: 'a', kind: 'gift', dateISO: '2026-11-03', lifetime: false },
    ]);
  });
  it('a qualifying check-in is a volunteer activity on the event date; non-qualifying or undated rows are skipped', () => {
    expect(activitiesFor([], [checkin({}), checkin({ registrationItemId: 'r2', qualifies: false }), checkin({ registrationItemId: 'r3', activityDateISO: null })], config, RECEIVED))
      .toEqual([{ id: 'r1', kind: 'volunteer', dateISO: '2027-03-14', lifetime: false }]);
  });
  it('a $1,000 gift is a lifetime activity', () => {
    expect(activitiesFor([gift({ amountCents: 100000 })], [], config, RECEIVED)[0]!.lifetime).toBe(true);
  });
  it('same-day gift and check-in sort stably: by date, then kind, then id (Review Focus 4)', () => {
    const a = activitiesFor([gift({ id: 'g9', dateISO: '2027-03-14' })], [checkin({ registrationItemId: 'r1' })], config, RECEIVED);
    const b = activitiesFor([gift({ id: 'g9', dateISO: '2027-03-14' })], [checkin({ registrationItemId: 'r1' })], config, RECEIVED);
    expect(a.map((x) => x.id)).toEqual(['g9', 'r1']);
    expect(b).toEqual(a);
  });
});

describe('buildRuns', () => {
  const act = (id: string, dateISO: string) => ({ id, kind: 'gift' as const, dateISO, lifetime: false });
  it('one activity is one run ending 13 months later', () => {
    expect(buildRuns([act('a', '2026-11-03')], 13)).toEqual([{ start: '2026-11-03', end: '2027-12-03', activities: 1 }]);
  });
  it('an activity on the previous run end extends it; one the day after starts a new run', () => {
    expect(buildRuns([act('a', '2026-11-03'), act('b', '2027-12-03')], 13))
      .toEqual([{ start: '2026-11-03', end: '2029-01-03', activities: 2 }]);
    expect(buildRuns([act('a', '2026-11-03'), act('b', '2027-12-04')], 13))
      .toEqual([{ start: '2026-11-03', end: '2027-12-03', activities: 1 }, { start: '2027-12-04', end: '2029-01-04', activities: 1 }]);
  });
});

describe('memberTypeFor', () => {
  const run = { start: '2026-11-03', end: '2027-12-03', activities: 1 };
  it('New before the anniversary with no earlier run; Lapsed renewal with one', () => {
    expect(memberTypeFor(run, 0, '2027-06-01', 13)).toBe('new');
    expect(memberTypeFor(run, 1, '2027-06-01', 13)).toBe('lapsedRenewal');
  });
  it('a one-activity run on its anniversary day is still New, not Continuing (Review Focus 5)', () => {
    expect(memberTypeFor(run, 0, '2027-12-03', 13)).toBe('new');
  });
  it('Continuing once past the anniversary with a later re-qualification', () => {
    expect(memberTypeFor({ ...run, end: '2028-07-10', activities: 2 }, 0, '2027-12-03', 13)).toBe('continuing');
    expect(memberTypeFor({ ...run, end: '2028-07-10', activities: 2 }, 0, '2027-12-02', 13)).toBe('new');
  });
});

describe('deriveMembership — the docs/28 worked examples', () => {
  it('first-ever gift, nothing after', () => {
    const d = deriveMembership([gift({})], [], config, RECEIVED, '2026-11-06');
    expect(d.state).toEqual({ since: '2026-11-03', currentTermStart: '2026-11-03', until: '2027-12-03', tier: 'member', lapseCount: 0, lastLapsed: null, memberType: 'new' });
    expect(d.terms.get('g1')).toEqual({ start: '2026-11-03', end: '2027-12-03', type: 'new' });
  });
  it('a second gift inside the run: Since unchanged, Until extends, New until the anniversary, then Continuing; the gift stamps Continuing', () => {
    const gifts = [gift({}), gift({ id: 'g2', dateISO: '2027-06-10' })];
    expect(deriveMembership(gifts, [], config, RECEIVED, '2027-06-11').state).toMatchObject({ since: '2026-11-03', until: '2028-07-10', memberType: 'new' });
    expect(deriveMembership(gifts, [], config, RECEIVED, '2027-12-03').state).toMatchObject({ memberType: 'continuing' });
    expect(deriveMembership(gifts, [], config, RECEIVED, '2027-06-11').terms.get('g2')!.type).toBe('continuing');
  });
  it('lapsed since 2024, back in 2026: Member Since stays 2019, Current Term Start is the return, one lapse, Lapsed renewal', () => {
    const gifts = [gift({ id: 'old1', dateISO: '2019-03-05' }), gift({ id: 'old2', dateISO: '2023-01-15' }), gift({ id: 'back', dateISO: '2026-12-01', amountCents: 5000 })];
    const d = deriveMembership(gifts, [], config, RECEIVED, '2026-12-02');
    expect(d.state).toEqual({ since: '2019-03-05', currentTermStart: '2026-12-01', until: '2028-01-01', tier: 'member', lapseCount: 2, lastLapsed: '2024-02-15', memberType: 'lapsedRenewal' });
    expect(d.terms.get('back')).toEqual({ start: '2026-12-01', end: '2028-01-01', type: 'lapsedRenewal' });
    expect(d.terms.has('old1')).toBe(false);   // pre-cutover gifts are never stamped
  });
  it('never gave; a check-in with blank Hours makes a New member', () => {
    const d = deriveMembership([], [checkin({ activityDateISO: '2027-05-02' })], config, RECEIVED, '2027-05-03');
    expect(d.state).toMatchObject({ since: '2027-05-02', currentTermStart: '2027-05-02', until: '2028-06-02', memberType: 'new', lapseCount: 0 });
    expect(d.terms.size).toBe(0);
  });
  it('a $1,000 gift: Lifetime tier, blank Until, Type by the same rule; a later gift gets no stamp', () => {
    const d = deriveMembership([gift({ amountCents: 100000 }), gift({ id: 'g2', dateISO: '2027-01-01' })], [], config, RECEIVED, '2027-01-02');
    expect(d.state).toMatchObject({ tier: 'lifetime', until: null, memberType: 'new' });
    expect(d.terms.get('g1')).toEqual({ start: '2026-11-03', end: null, type: 'lifetime' });
    expect(d.terms.has('g2')).toBe(false);
  });
  it('a currently lapsed member: their own lapse is not counted until they return', () => {
    const d = deriveMembership([gift({ dateISO: '2024-01-01' })], [], config, RECEIVED, '2026-11-06');
    expect(d.state).toMatchObject({ until: '2025-02-01', lapseCount: 0, lastLapsed: null, memberType: 'new' });
  });
  it('a gift dated exactly on fromISO is stamped; the day before is activity without a stamp', () => {
    const d = deriveMembership([gift({ id: 'on', dateISO: '2026-10-16' }), gift({ id: 'before', dateISO: '2026-10-15' })], [], config, RECEIVED, '2026-11-06');
    expect(d.terms.has('on')).toBe(true);
    expect(d.terms.has('before')).toBe(false);
    expect(d.state!.since).toBe('2026-10-15');
  });
  it('no activity at all: state is null and no terms', () => {
    expect(deriveMembership([gift({ amountCents: 50 })], [checkin({ qualifies: false })], config, RECEIVED, '2026-11-06')).toEqual({ state: null, terms: new Map() });
  });
  it('is identical on re-run with the same inputs', () => {
    const inputs = [gift({ id: 'b', dateISO: '2026-11-03' }), gift({ id: 'a', dateISO: '2026-11-03' })];
    expect(deriveMembership(inputs, [], config, RECEIVED, '2026-11-06')).toEqual(deriveMembership([...inputs].reverse(), [], config, RECEIVED, '2026-11-06'));
  });
});

const state = (over: Partial<OwnerMembershipState> = {}): OwnerMembershipState => ({
  since: '2026-11-03', currentTermStart: '2026-11-03', until: '2027-12-03', tier: 'member', lapseCount: 0, lastLapsed: null, memberType: 'new', ...over,
});

describe('mergeWithBoard (extend-only on Since/Until/Tier; outright on the rest)', () => {
  it('keeps the earlier Since and the later Until from the board; takes derived lapse columns verbatim', () => {
    const m = mergeWithBoard(state({ lapseCount: 1, lastLapsed: '2024-02-15' }), { since: '2015-01-01', until: '2029-01-01', tier: 'member' });
    expect(m).toMatchObject({ since: '2015-01-01', until: '2029-01-01', lapseCount: 1, lastLapsed: '2024-02-15', currentTermStart: '2026-11-03' });
  });
  it('never downgrades a board Lifetime, and blanks Until for it', () => {
    expect(mergeWithBoard(state(), { since: null, until: '2027-01-01', tier: 'lifetime' })).toMatchObject({ tier: 'lifetime', until: null });
  });
});

describe('statusFor', () => {
  it('Active through the Until day, Lapsed after; Lifetime always Active', () => {
    expect(statusFor(state(), '2027-12-03')).toBe('active');
    expect(statusFor(state(), '2027-12-04')).toBe('lapsed');
    expect(statusFor(state({ tier: 'lifetime', until: null }), '2099-01-01')).toBe('active');
  });
});

describe('membershipColumnValues — changed values only, all eight columns', () => {
  it('writes everything for a blank board', () => {
    expect(membershipColumnValues(state(), 'active', blankBoard, COLS, config)).toEqual({
      ms: { label: 'Active' }, mt: { label: 'Member' }, msince: { date: '2026-11-03' }, muntil: { date: '2027-12-03' },
      mcts: { date: '2026-11-03' }, mtype: { label: 'New' }, mlc: '0', mll: null,
    });
  });
  it('writes nothing when the board already matches', () => {
    const board: BoardMembership = { statusLabel: 'Active', tierLabel: 'Member', since: '2026-11-03', until: '2027-12-03',
      currentTermStart: '2026-11-03', memberTypeLabel: 'New', lapseCount: 0, lastLapsed: null };
    expect(membershipColumnValues(state(), 'active', board, COLS, config)).toEqual({});
  });
  it('overwrites a staff-edited Lapse Count and a stale Member Type', () => {
    const board: BoardMembership = { statusLabel: 'Active', tierLabel: 'Member', since: '2026-11-03', until: '2027-12-03',
      currentTermStart: '2026-11-03', memberTypeLabel: 'New', lapseCount: 5, lastLapsed: null };
    expect(membershipColumnValues(state({ memberType: 'continuing' }), 'active', board, COLS, config)).toEqual({ mtype: { label: 'Continuing' }, mlc: '0' });
  });
  it('clears Until for Lifetime with a null date value', () => {
    const board: BoardMembership = { ...blankBoard, until: '2027-01-01' };
    expect(membershipColumnValues(state({ tier: 'lifetime', until: null }), 'active', board, COLS, config)).toMatchObject({ muntil: null, mt: { label: 'Lifetime' } });
  });
});

describe('termColumnValues', () => {
  const cols = { termStart: 'ts', termEnd: 'te', membershipType: 'mty' };
  it('writes the three stamps with the new labels, only where they differ', () => {
    expect(termColumnValues({ start: '2026-11-03', end: '2027-12-03', type: 'lapsedRenewal' }, { termStart: '2026-11-03', termEnd: null, membershipType: null }, cols, config))
      .toEqual({ te: { date: '2027-12-03' }, mty: 'Lapsed renewal' });
    expect(termColumnValues(undefined, { termStart: null, termEnd: null, membershipType: null }, cols, config)).toEqual({});
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- src/membership/derive.test.ts`
Expected: FAIL — `activitiesFor`, `buildRuns`, `memberTypeFor` not exported; old signatures.

- [ ] **Step 3: Rewrite `derive.ts`**

Replace the file with:

```ts
// The membership activity rule, in Monday terms — spec 2026-10-09 "The rule, in Monday terms".
// Everything here is pure: the consumer feeds it the owner's gifts (from the ledger), their
// volunteer check-ins (from D1), the config and today's date, and writes back only what
// changed. Keep it that way; the idempotency argument depends on this module having no I/O.
import type { MembershipConfig, OwnerMembershipColumns } from '../types';
import type { VolunteerActivityRow } from '../db/volunteerActivity';

export type Tier = 'member' | 'lifetime';
export type TermType = 'new' | 'continuing' | 'lapsedRenewal' | 'lifetime';
export type MemberType = 'new' | 'continuing' | 'lapsedRenewal';
export type ActivityKind = 'gift' | 'migrated-term' | 'volunteer';

export interface MembershipActivity { id: string; kind: ActivityKind; dateISO: string; lifetime: boolean }

export interface MembershipGift {
  id: string;
  dateISO: string;            // '' when unknown
  amountCents: number;
  status: string;
  giftType: string | null;
  termStart: string | null;   // migrated Term Start; null = not read, '' = read, blank
}

export interface Run { start: string; end: string; activities: number }

export interface OwnerMembershipState {
  since: string | null;
  currentTermStart: string | null;
  until: string | null;        // null for Lifetime
  tier: Tier | null;
  lapseCount: number;
  lastLapsed: string | null;
  memberType: MemberType | null;
}

export interface GiftTerm { start: string; end: string | null; type: TermType }

export interface DerivedMembership {
  state: OwnerMembershipState | null;   // null = no qualifying activity at all; leave the board alone
  terms: Map<string, GiftTerm>;         // post-fromISO gift item id -> its stamp
}

export interface BoardMembership {
  statusLabel: string | null; tierLabel: string | null; since: string | null; until: string | null;
  currentTermStart: string | null; memberTypeLabel: string | null; lapseCount: number | null; lastLapsed: string | null;
}

const pad = (n: number): string => String(n).padStart(2, '0');

// Calendar month arithmetic on a plain ISO date. Day overflow rolls forward into the 1st of
// the next month, which for Feb 29 matches Salesforce's old OneYearFromClose formula.
export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number) as [number, number, number];
  const total = (m - 1) + months;
  const year = y + Math.floor(total / 12);
  const month = (total % 12) + 1;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (d <= daysInMonth) return `${year}-${pad(month)}-${pad(d)}`;
  const next = new Date(Date.UTC(year, month, 1));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-01`;
}

const isISODate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}/.test(s);

// "Given at least $1": Received, Gift Type in the list, amount at/over the floor, dated.
// No date gate — a qualifying gift counts whenever it happened; fromISO only decides stamping.
export function isQualifyingGift(g: MembershipGift, config: MembershipConfig, receivedStatusLabel: string): boolean {
  return g.status === receivedStatusLabel
    && g.giftType !== null && config.eligibleGiftTypes.includes(g.giftType)
    && g.amountCents >= config.minAmountCents
    && isISODate(g.dateISO);
}

const KIND_ORDER: Record<ActivityKind, number> = { gift: 0, 'migrated-term': 1, volunteer: 2 };
const byDateKindId = (a: MembershipActivity, b: MembershipActivity): number =>
  a.dateISO < b.dateISO ? -1 : a.dateISO > b.dateISO ? 1
  : KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function activitiesFor(
  gifts: MembershipGift[], volunteers: VolunteerActivityRow[], config: MembershipConfig, receivedStatusLabel: string,
): MembershipActivity[] {
  const out: MembershipActivity[] = [];
  for (const g of gifts) {
    if (isQualifyingGift(g, config, receivedStatusLabel)) {
      out.push({ id: g.id, kind: 'gift', dateISO: g.dateISO.slice(0, 10), lifetime: g.amountCents >= config.lifetimeThresholdCents });
    } else if (isISODate(g.dateISO) && g.dateISO.slice(0, 10) < config.fromISO && g.termStart !== null && isISODate(g.termStart)) {
      // Migrated history is trusted as stamped: comps and $0 membership terms were memberships.
      out.push({ id: g.id, kind: 'migrated-term', dateISO: g.termStart.slice(0, 10), lifetime: false });
    }
  }
  for (const v of volunteers) {
    if (v.qualifies && v.activityDateISO !== null && isISODate(v.activityDateISO)) {
      out.push({ id: v.registrationItemId, kind: 'volunteer', dateISO: v.activityDateISO.slice(0, 10), lifetime: false });
    }
  }
  return out.sort(byDateKindId);
}

// Each activity reaches termMonths ahead; one dated on or before the current run's end
// extends it, one dated after starts the next run. Input must already be sorted.
export function buildRuns(activities: MembershipActivity[], termMonths: number): Run[] {
  const runs: Run[] = [];
  for (const a of activities) {
    const current = runs.at(-1);
    if (current !== undefined && a.dateISO <= current.end) {
      current.end = addMonths(a.dateISO, termMonths);
      current.activities += 1;
    } else {
      runs.push({ start: a.dateISO, end: addMonths(a.dateISO, termMonths), activities: 1 });
    }
  }
  return runs;
}

// Continuing from the anniversary of the current run's start — and only if the run was
// re-qualified before then (its end is past the anniversary). Without the second condition a
// one-activity run would read Continuing on the single day it is past its anniversary and still
// Active (Until = anniversary). Otherwise New or Lapsed renewal by whether an earlier run exists.
export function memberTypeFor(run: Run, lapseCount: number, todayISO: string, termMonths: number): MemberType {
  const anniversary = addMonths(run.start, termMonths);
  if (todayISO >= anniversary && run.end > anniversary) return 'continuing';
  return lapseCount === 0 ? 'new' : 'lapsedRenewal';
}

export function deriveMembership(
  gifts: MembershipGift[], volunteers: VolunteerActivityRow[], config: MembershipConfig, receivedStatusLabel: string, todayISO: string,
): DerivedMembership {
  const activities = activitiesFor(gifts, volunteers, config, receivedStatusLabel);
  const terms = new Map<string, GiftTerm>();
  if (activities.length === 0) return { state: null, terms };

  // Walk once: build runs and, for each post-fromISO gift, note whether it opened a run.
  const runs: Run[] = [];
  let lifetime = false;
  for (const a of activities) {
    const current = runs.at(-1);
    const opensRun = current === undefined || a.dateISO > current.end;
    if (opensRun) runs.push({ start: a.dateISO, end: addMonths(a.dateISO, config.termMonths), activities: 1 });
    else { current!.end = addMonths(a.dateISO, config.termMonths); current!.activities += 1; }

    if (a.kind === 'gift' && a.dateISO >= config.fromISO && !lifetime) {
      if (a.lifetime) terms.set(a.id, { start: a.dateISO, end: null, type: 'lifetime' });
      else {
        const type: TermType = opensRun ? (runs.length === 1 ? 'new' : 'lapsedRenewal') : 'continuing';
        terms.set(a.id, { start: a.dateISO, end: addMonths(a.dateISO, config.termMonths), type });
      }
    }
    if (a.lifetime) lifetime = true;
  }

  const current = runs.at(-1)!;
  const lapseCount = runs.length - 1;
  return {
    state: {
      since: runs[0]!.start,
      currentTermStart: current.start,
      until: lifetime ? null : current.end,
      tier: lifetime ? 'lifetime' : 'member',
      lapseCount,
      lastLapsed: lapseCount > 0 ? runs[lapseCount - 1]!.end : null,
      memberType: memberTypeFor(current, lapseCount, todayISO, config.termMonths),
    },
    terms,
  };
}

const minDate = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a < b ? a : b);
const maxDate = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a > b ? a : b);

// Since only ever earlier, Until only ever later, Tier never down; the rest are derived facts
// the board does not get a vote on (spec "Merge with the board").
export function mergeWithBoard(
  derived: OwnerMembershipState, board: { since: string | null; until: string | null; tier: Tier | null },
): OwnerMembershipState {
  const tier: Tier | null = derived.tier === 'lifetime' || board.tier === 'lifetime' ? 'lifetime' : derived.tier ?? board.tier;
  return {
    ...derived,
    since: minDate(derived.since, board.since),
    until: tier === 'lifetime' ? null : maxDate(derived.until, board.until),
    tier,
  };
}

export function statusFor(state: OwnerMembershipState, todayISO: string): 'active' | 'lapsed' {
  if (state.tier === 'lifetime') return 'active';
  return state.until !== null && state.until >= todayISO ? 'active' : 'lapsed';
}

export function tierFromLabel(label: string | null, config: MembershipConfig): Tier | null {
  if (label === null || label === '') return null;
  return label === config.tierLabels.lifetime ? 'lifetime' : 'member';
}

const dateCol = (iso: string | null): unknown => (iso === null ? null : { date: iso });

export function membershipColumnValues(
  merged: OwnerMembershipState, status: 'active' | 'lapsed', board: BoardMembership,
  columns: OwnerMembershipColumns, config: MembershipConfig,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const statusLabel = config.statusLabels[status];
  if (statusLabel !== board.statusLabel) out[columns.status] = { label: statusLabel };
  if (merged.tier !== null && config.tierLabels[merged.tier] !== board.tierLabel) out[columns.tier] = { label: config.tierLabels[merged.tier] };
  if (merged.since !== board.since) out[columns.since] = dateCol(merged.since);
  if (merged.until !== board.until) out[columns.until] = dateCol(merged.until);
  if (merged.currentTermStart !== board.currentTermStart) out[columns.currentTermStart] = dateCol(merged.currentTermStart);
  if (merged.memberType !== null && config.typeLabels[merged.memberType] !== board.memberTypeLabel) {
    out[columns.memberType] = { label: config.typeLabels[merged.memberType] };
  }
  if (merged.lapseCount !== board.lapseCount) out[columns.lapseCount] = String(merged.lapseCount);
  if (merged.lastLapsed !== board.lastLapsed) out[columns.lastLapsed] = dateCol(merged.lastLapsed);
  return out;
}

export function termColumnValues(
  term: GiftTerm | undefined,
  current: { termStart: string | null; termEnd: string | null; membershipType: string | null },
  columns: { termStart: string; termEnd: string; membershipType: string },
  config: MembershipConfig,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (term === undefined) return out;
  if (term.start !== current.termStart) out[columns.termStart] = dateCol(term.start);
  if (term.end !== current.termEnd) out[columns.termEnd] = dateCol(term.end);
  const typeLabel = config.typeLabels[term.type];
  if (typeLabel !== current.membershipType) out[columns.membershipType] = typeLabel;
  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- src/membership/derive.test.ts`
Expected: PASS. Check the lapsed-since-2024 example by hand if it fails: runs are 2019-03-05→2020-04-05, 2023-01-15→2024-02-15, 2026-12-01→2028-01-01, so `lapseCount` 2 and `lastLapsed` 2024-02-15 — the test encodes that, matching docs/28's example once its two early gifts are read as two runs.

- [ ] **Step 5: Commit**

```bash
git add src/membership/derive.ts src/membership/derive.test.ts
git commit -m "feat(donation-rollups): derive membership from activity runs under the 13-month rule"
```

---
### Task 6: Monday client reads — eight owner columns, registrations, events, historical shifts

**Files:**
- Modify: `src/monday/client.ts`
- Test: `src/monday/client.test.ts`

**Interfaces:**
- Consumes: `OwnerMembershipColumns`, `VolunteerBoardConfig`, `HistoricalVolunteerBoardConfig` (Task 3); `BoardMembership` (Task 5); `parseHours` (Task 4).
- Produces (added to `DonationRollupsMondayClient` and `HttpMondayClient`):
  ```ts
  export interface RegistrationRecord { id: string; attendeeItemId: string | null; eventItemId: string | null; attendanceLabel: string | null; roleLabel: string | null; hours: number | null }
  export interface HistoricalShiftRecord { id: string; volunteerItemId: string | null; dateISO: string | null; hours: number | null; statusLabel: string | null }
  getOwnerMembership(ownerItemId: string, columns: OwnerMembershipColumns): Promise<BoardMembership>;
  getRegistration(itemId: string, board: VolunteerBoardConfig): Promise<RegistrationRecord | null>;   // null = deleted / not returned
  getEventStart(eventItemId: string, startColumnId: string): Promise<string | null>;                   // YYYY-MM-DD or null
  pageRegistrations(board: VolunteerBoardConfig, cursor: string | null): Promise<{ items: RegistrationRecord[]; cursor: string | null }>;
  pageHistoricalShifts(board: HistoricalVolunteerBoardConfig, cursor: string | null): Promise<{ items: HistoricalShiftRecord[]; cursor: string | null }>;
  getItemsBoardIds(itemIds: string[]): Promise<Map<string, string>>;   // id -> board id, chunked at 100; missing items absent
  ```
  `pageItemsColumnsText` and `getItemsColumnsText` are unchanged and reused by the custodian.

- [ ] **Step 1: Write the failing tests**

In `src/monday/client.test.ts`, replace the `getOwnerMembership` describe with:

```ts
describe('getOwnerMembership (eight columns)', () => {
  const OWNER = { status: 'ms', tier: 'mt', since: 'msince', until: 'muntil', currentTermStart: 'mcts', memberType: 'mtype', lapseCount: 'mlc', lastLapsed: 'mll' };
  it('returns all eight, blanks as null, Lapse Count as a number', async () => {
    const client = clientReturning(itemsResponse([{ id: 'o1', cells: {
      ms: 'Active', mt: 'Member', msince: '2015-01-01', muntil: '2027-12-03 00:00', mcts: '2026-11-03', mtype: 'New', mlc: '2', mll: '' } }]));
    expect(await client.getOwnerMembership('o1', OWNER)).toEqual({
      statusLabel: 'Active', tierLabel: 'Member', since: '2015-01-01', until: '2027-12-03',
      currentTermStart: '2026-11-03', memberTypeLabel: 'New', lapseCount: 2, lastLapsed: null });
  });
  it('a missing item reads as all null rather than throwing', async () => {
    const client = clientReturning(itemsResponse([]));
    expect(await client.getOwnerMembership('gone', OWNER)).toEqual({
      statusLabel: null, tierLabel: null, since: null, until: null, currentTermStart: null, memberTypeLabel: null, lapseCount: null, lastLapsed: null });
  });
});

const VOL_BOARD = { boardId: 7, columns: { attendee: 'att', event: 'ev', attendance: 'atd', role: 'role', hours: 'hrs' as string | null },
  eventBoard: { boardId: 8, columns: { start: 'start' } }, volunteerRoleLabels: ['Volunteer'], countedAttendanceLabels: ['Attended'] };

describe('registrations and events', () => {
  const regResponse = (cells: Record<string, string | null>, links: Record<string, string[]>) => ({ data: { items: [{ id: 'r1', column_values:
    Object.entries(cells).map(([id, text]) => ({ id, text, ...(links[id] ? { linked_item_ids: links[id] } : {}) })) }] } });
  it('getRegistration reads links, labels and hours; blank hours is null', async () => {
    const client = clientReturning(regResponse({ att: 'Ada', ev: 'Bike Party', atd: 'Attended', role: 'Volunteer', hrs: '' }, { att: ['p1'], ev: ['e1'] }));
    expect(await client.getRegistration('r1', VOL_BOARD)).toEqual({ id: 'r1', attendeeItemId: 'p1', eventItemId: 'e1', attendanceLabel: 'Attended', roleLabel: 'Volunteer', hours: null });
  });
  it('getRegistration without an hours column configured reads hours as null; a deleted item is null', async () => {
    const client = clientReturning(regResponse({ att: '', ev: '', atd: 'Registered', role: '' }, {}));
    expect(await client.getRegistration('r1', { ...VOL_BOARD, columns: { ...VOL_BOARD.columns, hours: null } }))
      .toEqual({ id: 'r1', attendeeItemId: null, eventItemId: null, attendanceLabel: 'Registered', roleLabel: null, hours: null });
    expect(await clientReturning({ data: { items: [] } }).getRegistration('gone', VOL_BOARD)).toBeNull();
  });
  it('getEventStart normalizes to a date and returns null for blank or missing', async () => {
    expect(await clientReturning(itemsResponse([{ id: 'e1', cells: { start: '2027-05-02 18:00' } }])).getEventStart('e1', 'start')).toBe('2027-05-02');
    expect(await clientReturning(itemsResponse([{ id: 'e1', cells: { start: '' } }])).getEventStart('e1', 'start')).toBeNull();
    expect(await clientReturning(itemsResponse([])).getEventStart('e1', 'start')).toBeNull();
  });
  it('pageRegistrations returns the page and cursor with the same record shape', async () => {
    const client = clientReturning({ data: { boards: [{ items_page: { cursor: 'next', items: [{ id: 'r1', column_values: [
      { id: 'att', text: 'Ada', linked_item_ids: ['p1'] }, { id: 'ev', text: 'X', linked_item_ids: ['e1'] },
      { id: 'atd', text: 'Attended' }, { id: 'role', text: 'Volunteer' }, { id: 'hrs', text: '3' }] }] } }] } });
    expect(await client.pageRegistrations(VOL_BOARD, null)).toEqual({ cursor: 'next',
      items: [{ id: 'r1', attendeeItemId: 'p1', eventItemId: 'e1', attendanceLabel: 'Attended', roleLabel: 'Volunteer', hours: 3 }] });
  });
  it('pageHistoricalShifts reads Volunteer link, Date, Hours and Status', async () => {
    const client = clientReturning({ data: { boards: [{ items_page: { cursor: null, items: [{ id: 'v1', column_values: [
      { id: 'vol', text: 'Ada', linked_item_ids: ['p1'] }, { id: 'dt', text: '2019-06-01' }, { id: 'hrs', text: '2' }, { id: 'st', text: 'Completed' }] }] } }] } });
    expect(await client.pageHistoricalShifts({ boardId: 9, columns: { volunteer: 'vol', date: 'dt', hours: 'hrs', status: 'st' }, countedStatusLabels: ['Completed'] }, null))
      .toEqual({ cursor: null, items: [{ id: 'v1', volunteerItemId: 'p1', dateISO: '2019-06-01', hours: 2, statusLabel: 'Completed' }] });
  });
  it('getItemsBoardIds maps ids to boards and omits missing items', async () => {
    const client = clientReturning({ data: { items: [{ id: 'p1', board: { id: '20' } }, { id: 'p2', board: { id: '28' } }] } });
    expect(await client.getItemsBoardIds(['p1', 'p2', 'p3'])).toEqual(new Map([['p1', '20'], ['p2', '28']]));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- src/monday/client.test.ts`
Expected: FAIL — new methods missing; `getOwnerMembership` returns four fields.

- [ ] **Step 3: Implement**

In `src/monday/client.ts`: import `parseHours` from `'../membership/volunteer'`, `BoardMembership` from `'../membership/derive'`, and `VolunteerBoardConfig`, `HistoricalVolunteerBoardConfig` from `'../types'`. Add the two record interfaces from Interfaces. Add the six signatures to `DonationRollupsMondayClient` (replace the old `getOwnerMembership` one). Implement in `HttpMondayClient`:

```ts
  async getOwnerMembership(ownerItemId: string, columns: OwnerMembershipColumns): Promise<BoardMembership> {
    const ids = [columns.status, columns.tier, columns.since, columns.until,
      columns.currentTermStart, columns.memberType, columns.lapseCount, columns.lastLapsed];
    const cols = (await this.getItemsColumnsText([ownerItemId], ids)).get(ownerItemId);
    const text = (id: string): string | null => cols?.get(id) ?? null;
    const date = (id: string): string | null => text(id)?.slice(0, 10) ?? null;
    const count = text(columns.lapseCount);
    return {
      statusLabel: text(columns.status), tierLabel: text(columns.tier), since: date(columns.since), until: date(columns.until),
      currentTermStart: date(columns.currentTermStart), memberTypeLabel: text(columns.memberType),
      lapseCount: count === null || !/^\d+$/.test(count.trim()) ? null : Number(count.trim()),
      lastLapsed: date(columns.lastLapsed),
    };
  }

  private registrationFrom(item: { id: string; column_values: ColumnValue[] }, board: VolunteerBoardConfig): RegistrationRecord {
    const c = board.columns;
    const byId = new Map(item.column_values.map((cv) => [cv.id, cv]));
    const link = (id: string): string | null => byId.get(id)?.linked_item_ids?.[0] ?? null;
    const text = (id: string | null): string | null => (id ? (byId.get(id)?.text || null) : null);
    return { id: item.id, attendeeItemId: link(c.attendee), eventItemId: link(c.event),
      attendanceLabel: text(c.attendance), roleLabel: text(c.role), hours: parseHours(text(c.hours)) };
  }

  private registrationColumnIds(board: VolunteerBoardConfig): string[] {
    const c = board.columns;
    return [c.attendee, c.event, c.attendance, c.role, ...(c.hours ? [c.hours] : [])];
  }

  async getRegistration(itemId: string, board: VolunteerBoardConfig): Promise<RegistrationRecord | null> {
    const data = await this.graphql<{ items: { id: string; column_values: ColumnValue[] }[] }>(
      `query ($ids: [ID!], $columnIds: [String!]) {
        items(ids: $ids) { id column_values(ids: $columnIds) { id text ... on BoardRelationValue { linked_item_ids } } }
      }`,
      { ids: [itemId], columnIds: this.registrationColumnIds(board) },
    );
    const item = data.items[0];
    return item === undefined ? null : this.registrationFrom(item, board);
  }

  async getEventStart(eventItemId: string, startColumnId: string): Promise<string | null> {
    const text = (await this.getItemsColumnsText([eventItemId], [startColumnId])).get(eventItemId)?.get(startColumnId) ?? null;
    return text === null ? null : text.slice(0, 10);
  }

  async pageRegistrations(board: VolunteerBoardConfig, cursor: string | null) {
    const data: { boards: { items_page: { cursor: string | null; items: { id: string; column_values: ColumnValue[] }[] } }[] } =
      await this.graphql(
        `query ($boardId: [ID!], $columnIds: [String!], $cursor: String) {
          boards(ids: $boardId) {
            items_page(limit: 500, cursor: $cursor) { cursor items { id column_values(ids: $columnIds) { id text ... on BoardRelationValue { linked_item_ids } } } }
          }
        }`,
        { boardId: [board.boardId], columnIds: this.registrationColumnIds(board), cursor },
      );
    const page = data.boards[0]?.items_page;
    if (page === undefined) return { items: [], cursor: null };
    return { cursor: page.cursor, items: page.items.map((item) => this.registrationFrom(item, board)) };
  }

  async pageHistoricalShifts(board: HistoricalVolunteerBoardConfig, cursor: string | null) {
    const c = board.columns;
    const data: { boards: { items_page: { cursor: string | null; items: { id: string; column_values: ColumnValue[] }[] } }[] } =
      await this.graphql(
        `query ($boardId: [ID!], $columnIds: [String!], $cursor: String) {
          boards(ids: $boardId) {
            items_page(limit: 500, cursor: $cursor) { cursor items { id column_values(ids: $columnIds) { id text ... on BoardRelationValue { linked_item_ids } } } }
          }
        }`,
        { boardId: [board.boardId], columnIds: [c.volunteer, c.date, c.hours, c.status], cursor },
      );
    const page = data.boards[0]?.items_page;
    if (page === undefined) return { items: [], cursor: null };
    return {
      cursor: page.cursor,
      items: page.items.map((item) => {
        const byId = new Map(item.column_values.map((cv) => [cv.id, cv]));
        const text = (id: string): string | null => byId.get(id)?.text || null;
        return { id: item.id, volunteerItemId: byId.get(c.volunteer)?.linked_item_ids?.[0] ?? null,
          dateISO: text(c.date)?.slice(0, 10) ?? null, hours: parseHours(text(c.hours)), statusLabel: text(c.status) };
      }),
    };
  }

  async getItemsBoardIds(itemIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const chunk of chunksOf(itemIds, 100)) {
      const data = await this.graphql<{ items: { id: string; board: { id: string } }[] }>(
        `query ($ids: [ID!]) { items(ids: $ids, limit: 100) { id board { id } } }`, { ids: chunk });
      for (const item of data.items) out.set(item.id, item.board.id);
    }
    return out;
  }
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- src/monday/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/monday/client.ts src/monday/client.test.ts
git commit -m "feat(donation-rollups): Monday reads for registrations, event starts, historical shifts and eight membership columns"
```

---

### Task 7: The membership step folds the full history (ledger + check-ins); baseline retired

**Files:**
- Modify: `src/consumer/processBatch.ts` (`ProcessBatchDeps`, `recomputeOwner`, `planMembershipWrites`)
- Modify: `src/index.ts` (wire `D1VolunteerActivityStore`, drop the baseline store)
- Test: `src/consumer/processBatch.test.ts` (membership describe block rewritten)

**Interfaces:**
- Consumes: `deriveMembership`, `mergeWithBoard`, `statusFor`, `tierFromLabel`, `membershipColumnValues`, `termColumnValues`, `MembershipGift` (Task 5); `VolunteerActivityStore` (Task 1); `giftsForOwner(...).termStart` (Task 2); `getOwnerMembership` → `BoardMembership` (Task 6).
- Produces: `ProcessBatchDeps` = previous minus `baselineStore` plus `volunteerStore: VolunteerActivityStore`. `recomputeOwner` signature unchanged.

- [ ] **Step 1: Rewrite the membership tests**

In `src/consumer/processBatch.test.ts`: delete the `fakeBaselineStore` helper and the `MembershipBaselineStore`/`BaselineRow` imports; update `membershipConfig` to the Task 3 shape (`fromISO: '2026-10-16'`, `minAmountCents: 100`, `termMonths: 13`, renamed `typeLabels`); update `memberOwnerColumns.membership` to the eight keys `{ status: 'ms', tier: 'mt', since: 'msince', until: 'muntil', currentTermStart: 'mcts', memberType: 'mtype', lapseCount: 'mlc', lastLapsed: 'mll' }`; add `volunteerBoards: [], historicalVolunteerBoards: []` to both `config.donationRollups` and `membershipEnabled.donationRollups`; add a helper:

```ts
function fakeVolunteerStore(rows: VolunteerActivityRow[] = []): VolunteerActivityStore {
  return { upsert: vi.fn().mockResolvedValue({ previousOwner: null }), forOwner: vi.fn().mockResolvedValue(rows),
    markRemoved: vi.fn().mockResolvedValue(null), ownersWithActivity: vi.fn().mockResolvedValue([]) };
}
```

(import `VolunteerActivityStore`, `VolunteerActivityRow` from `'../db/volunteerActivity'`). Every `processRecomputeBatch(...)` deps literal in the file that passed `baselineStore` now passes `volunteerStore: fakeVolunteerStore()` instead; the `fakeMondayClient` default for `getOwnerMembership` becomes the eight-null `BoardMembership`. Replace the whole `describe('membership step (spec 2026-09-15)')` block with:

```ts
const BLANK_BOARD = { statusLabel: null, tierLabel: null, since: null, until: null, currentTermStart: null, memberTypeLabel: null, lapseCount: null, lastLapsed: null };
const ledgerGift = (over: Partial<GiftHistoryRow> = {}): GiftHistoryRow => ({
  mondayItemId: 'dn1', donationBoardId: '1', amountCents: 5000, giftDateISO: '2026-11-05', fiscalYear: 2027,
  status: 'Received', giftType: 'Donation', actingForItemId: null, archived: false, termStart: null, ...over });

describe('membership step (spec 2026-10-09 — full-history fold)', () => {
  function deps(over: {
    board?: Partial<typeof BLANK_BOARD>; history?: GiftHistoryRow[]; volunteers?: VolunteerActivityRow[];
    donations?: unknown[]; ownerBoard?: string; cfg?: DonationRollupsConfig;
  } = {}) {
    const changeColumnValues = vi.fn().mockResolvedValue(undefined);
    const giftsStore = fakeGiftsStore();
    (giftsStore.giftsForOwner as ReturnType<typeof vi.fn>).mockResolvedValue(over.history ?? [ledgerGift()]);
    const volunteerStore = fakeVolunteerStore(over.volunteers ?? []);
    const mondayClient = fakeMondayClient({
      changeColumnValues,
      getItemBoardId: vi.fn().mockResolvedValue(over.ownerBoard ?? '2'),
      getDonationsByIds: vi.fn().mockResolvedValue(over.donations ?? [renewalGift]),
      getOwnerMembership: vi.fn().mockResolvedValue({ ...BLANK_BOARD, ...over.board }),
    });
    return { changeColumnValues, giftsStore, volunteerStore, mondayClient,
      run: () => processRecomputeBatch([fakeMessage('dn1')], {
        pendingStore: fakePendingStore(), linksStore: fakeLinksStore(), giftsStore, affiliationsStore: fakeAffiliationsStore(),
        recomputesStore: fakeRecomputesStore(), volunteerStore, mondayClient, config: over.cfg ?? membershipEnabled, now: NOW }) };
  }

  it('a never-member with one gift: writes all eight owner columns and stamps the gift New', async () => {
    const d = deps();
    await d.run();
    const [ownerCall, giftCall] = d.changeColumnValues.mock.calls;
    expect(ownerCall![2]).toMatchObject({ ms: { label: 'Active' }, mt: { label: 'Member' }, msince: { date: '2026-11-05' },
      muntil: { date: '2027-12-05' }, mcts: { date: '2026-11-05' }, mtype: { label: 'New' }, mlc: '0', mll: null });
    expect(giftCall).toEqual([1, 'dn1', { ts_1: { date: '2026-11-05' }, te_1: { date: '2027-12-05' }, mty_1: 'New' }]);
  });

  it('a lapsed member returning: history from the ledger (not the fetch) gives Lapsed renewal, Lapse Count 1, Since kept', async () => {
    const d = deps({
      history: [ledgerGift({ mondayItemId: 'old', giftDateISO: '2024-01-15', fiscalYear: 2024, archived: true }), ledgerGift()],
      board: { statusLabel: 'Lapsed', tierLabel: 'Member', since: '2024-01-15', until: '2025-02-15' } });
    await d.run();
    expect(d.changeColumnValues.mock.calls[0]![2]).toMatchObject({ ms: { label: 'Active' }, muntil: { date: '2027-12-05' },
      mcts: { date: '2026-11-05' }, mtype: { label: 'Lapsed renewal' }, mlc: '1', mll: { date: '2025-02-15' } });
    expect(d.changeColumnValues.mock.calls[0]![2]).not.toHaveProperty('msince');
    expect(d.changeColumnValues.mock.calls[1]![2]).toMatchObject({ mty_1: 'Lapsed renewal' });
  });

  it('a migrated $0 term before fromISO counts; Member Since moves earlier than the board only via min', async () => {
    const d = deps({
      history: [ledgerGift({ mondayItemId: 'mig', amountCents: 0, giftDateISO: '2019-05-01', fiscalYear: 2019, termStart: '2019-05-01' }), ledgerGift()],
      board: { since: '2015-01-01' } });
    await d.run();
    expect(d.changeColumnValues.mock.calls[0]![2]).not.toHaveProperty('msince');   // board 2015 is earlier: kept
    expect(d.changeColumnValues.mock.calls[0]![2]).toMatchObject({ mlc: '1', mll: { date: '2020-06-01' } });
  });

  it('a check-in alone makes a member and stamps no gift', async () => {
    const d = deps({ history: [], donations: [], volunteers: [{ registrationItemId: 'r1', boardId: 'er', ownerItemId: 'donor-1', ownerBoardId: '2',
      activityDateISO: '2026-10-20', hours: null, qualifies: true, source: 'webhook' }] });
    await d.run();
    expect(d.changeColumnValues).toHaveBeenCalledTimes(1);
    expect(d.changeColumnValues.mock.calls[0]![2]).toMatchObject({ ms: { label: 'Active' }, msince: { date: '2026-10-20' }, muntil: { date: '2027-11-20' }, mtype: { label: 'New' } });
  });

  it('a $1,000 gift makes the owner Lifetime with Until cleared and a blank Term End', async () => {
    const d = deps({ history: [ledgerGift({ amountCents: 100000 })], donations: [{ ...renewalGift, amountCents: 100000 }],
      board: { statusLabel: 'Active', tierLabel: 'Member', since: '2015-01-01', until: '2027-04-11' } });
    await d.run();
    expect(d.changeColumnValues.mock.calls[0]![2]).toMatchObject({ mt: { label: 'Lifetime' }, muntil: null });
    expect(d.changeColumnValues.mock.calls[1]![2]).toEqual({ ts_1: { date: '2026-11-05' }, mty_1: 'Lifetime' });
  });

  it('a staff-extended Until on the board is kept (extend-only merge)', async () => {
    const d = deps({ board: { statusLabel: 'Active', tierLabel: 'Member', since: '2015-01-01', until: '2029-01-01' } });
    await d.run();
    expect(d.changeColumnValues.mock.calls[0]![2]).not.toHaveProperty('muntil');
  });

  it('an Organizations owner (no membership columns) gets no membership writes', async () => {
    const d = deps({ ownerBoard: '3' });
    await d.run();
    expect(d.mondayClient.getOwnerMembership).not.toHaveBeenCalled();
    expect(d.volunteerStore.forOwner).not.toHaveBeenCalled();
    expect(d.changeColumnValues).toHaveBeenCalledTimes(1);
  });

  it('with the membership block null the step is skipped entirely', async () => {
    const d = deps({ cfg: { ...membershipEnabled, donationRollups: { ...membershipEnabled.donationRollups, membership: null } } });
    await d.run();
    expect(d.mondayClient.getOwnerMembership).not.toHaveBeenCalled();
    expect(d.changeColumnValues).toHaveBeenCalledTimes(1);
  });

  it('no qualifying activity at all: nothing membership-related is written even when the board is stale', async () => {
    const d = deps({ history: [ledgerGift({ amountCents: 50 })], donations: [{ ...renewalGift, amountCents: 50 }],
      board: { statusLabel: 'Lapsed', tierLabel: 'Lifetime', since: '2015-01-01', until: '2027-01-01' } });
    await d.run();
    expect(d.changeColumnValues).toHaveBeenCalledTimes(1);
    for (const key of ['ms', 'mt', 'msince', 'muntil', 'mcts', 'mtype', 'mlc', 'mll']) expect(d.changeColumnValues.mock.calls[0]![2]).not.toHaveProperty(key);
  });

  it('writes nothing on a re-run whose board already matches', async () => {
    const d = deps({ board: { statusLabel: 'Active', tierLabel: 'Member', since: '2026-11-05', until: '2027-12-05', currentTermStart: '2026-11-05', memberTypeLabel: 'New', lapseCount: 0, lastLapsed: null },
      donations: [{ ...renewalGift, termStart: '2026-11-05', termEnd: '2027-12-05', membershipType: 'New' }] });
    await d.run();
    expect(d.changeColumnValues).toHaveBeenCalledTimes(1);
    expect(d.changeColumnValues.mock.calls[0]![2]).not.toHaveProperty('ms');
  });

  it('caps gift term stamps per recompute and continues on later recomputes', async () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ ...renewalGift, id: `g${String(i).padStart(2, '0')}`, dateISO: `2026-11-${String(i + 1).padStart(2, '0')}` }));
    const d = deps({ donations: many, history: many.map((g) => ledgerGift({ mondayItemId: g.id, giftDateISO: g.dateISO })) });
    await d.run();
    expect(d.changeColumnValues).toHaveBeenCalledTimes(11);
    expect(d.changeColumnValues.mock.calls.slice(1).map((c) => c[1])).toEqual(many.slice(0, 10).map((g) => g.id));
  });
});
```

Keep the existing `'the owner write precedes the gift writes, and a failing gift write still retries the message'` test, swapping `baselineStore: d.baselineStore` for `volunteerStore: d.volunteerStore`. Import `GiftHistoryRow` from `'../projections/giftHistory'`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- src/consumer/processBatch.test.ts`
Expected: FAIL — `volunteerStore` unknown, old derivation.

- [ ] **Step 3: Implement**

In `src/consumer/processBatch.ts`:

- Replace the `MembershipBaselineStore` import with `import type { VolunteerActivityStore } from '../db/volunteerActivity';` and in `ProcessBatchDeps` replace `baselineStore: MembershipBaselineStore;` with `volunteerStore: VolunteerActivityStore;`.
- Import from `'../membership/derive'`: `deriveMembership, mergeWithBoard, statusFor, tierFromLabel, membershipColumnValues, termColumnValues, type MembershipGift`.
- In `recomputeOwner`, move `const history = await deps.giftsStore.giftsForOwner(ownerItemId);` up to just before the membership step (it is currently fetched after it) and pass `history` into `planMembershipWrites`; the projections below keep using the same `history`.
- Replace `planMembershipWrites` with:

```ts
async function planMembershipWrites(
  deps: ProcessBatchDeps, ownerItemId: string,
  columns: OwnerMembershipColumns, membership: MembershipConfig,
  perBoard: { board: DonationBoardConfig; items: DonationRecord[] }[],
  history: GiftHistoryRow[],
): Promise<{ ownerValues: Record<string, unknown>; giftWrites: { boardId: number; itemId: string; values: Record<string, unknown> }[] }> {
  const { mondayClient, volunteerStore, config } = deps;
  const todayISO = (deps.now ?? new Date()).toISOString().slice(0, 10);

  // Activity comes from the ledger, not the Monday fetch: the ledger carries every gift the owner
  // ever had, archived ones included, plus the migrated Term Start (spec 2026-10-09 "Qualifying
  // activities"). The fetch only decides which active gifts can still take a stamp.
  const gifts: MembershipGift[] = history.map((g) => ({
    id: g.mondayItemId, dateISO: g.giftDateISO, amountCents: g.amountCents, status: g.status,
    giftType: g.giftType, termStart: g.termStart ?? null,
  }));
  const volunteers = await volunteerStore.forOwner(ownerItemId);
  const derived = deriveMembership(gifts, volunteers, membership, config.donationRollups.receivedStatusLabel, todayISO);
  // No qualifying activity anywhere: never rewrite a hand-set membership or flip Status —
  // Status on the calendar is the native automation's job, not ours.
  if (derived.state === null) return { ownerValues: {}, giftWrites: [] };

  const board = await mondayClient.getOwnerMembership(ownerItemId, columns);
  const merged = mergeWithBoard(derived.state, { since: board.since, until: board.until, tier: tierFromLabel(board.tierLabel, membership) });
  const ownerValues = membershipColumnValues(merged, statusFor(merged, todayISO), board, columns, membership);

  const candidates = perBoard.flatMap(({ board: b, items }) => {
    const cols = b.columns;
    if (!cols.termStart || !cols.termEnd || !cols.membershipType) return [];
    return items.map((d) => ({ board: b, d, cols: { termStart: cols.termStart!, termEnd: cols.termEnd!, membershipType: cols.membershipType! } }));
  }).sort((a, b) => (a.d.dateISO < b.d.dateISO ? -1 : a.d.dateISO > b.d.dateISO ? 1 : a.d.id < b.d.id ? -1 : a.d.id > b.d.id ? 1 : 0));

  const giftWrites: { boardId: number; itemId: string; values: Record<string, unknown> }[] = [];
  for (const { board: b, d, cols } of candidates) {
    const values = termColumnValues(derived.terms.get(d.id),
      { termStart: d.termStart ?? null, termEnd: d.termEnd ?? null, membershipType: d.membershipType ?? null }, cols, membership);
    if (Object.keys(values).length > 0) giftWrites.push({ boardId: b.boardId, itemId: d.id, values });
  }
  if (giftWrites.length > MAX_GIFT_TERM_WRITES_PER_RECOMPUTE) {
    console.log(`donation-rollups: owner ${ownerItemId} has ${giftWrites.length - MAX_GIFT_TERM_WRITES_PER_RECOMPUTE} more gift term stamps pending; continuing on the next recompute`);
    giftWrites.length = MAX_GIFT_TERM_WRITES_PER_RECOMPUTE;
  }
  return { ownerValues, giftWrites };
}
```

Import `GiftHistoryRow` type from `'../projections/giftHistory'`. Update the call site: `planMembershipWrites(deps, ownerItemId, membershipColumns, membership, perBoard, history)` (the `ownerBoardId` argument goes away). Also pass `termStart: d.termStart` into the `refreshFacts` rows (`termStart: d.termStart` — undefined when the board has no term column, `null` when blank, which the store treats as "leave stored"; a stamped value is persisted).

In `src/index.ts`: replace the `D1MembershipBaselineStore` import with `import { D1VolunteerActivityStore } from './db/volunteerActivity';` and in `queue()` replace `baselineStore: new D1MembershipBaselineStore(env.DB),` with `volunteerStore: new D1VolunteerActivityStore(env.DB),`.

- [ ] **Step 4: Run the tests and type-check**

Run: `npm test -- src/consumer/processBatch.test.ts && npm run typecheck`
Expected: tests PASS; typecheck fails only in `src/db/membershipBaseline.ts` / its test (unused but still compiling — they reference `MembershipState`, which no longer exists). Delete `src/db/membershipBaseline.ts` and `src/db/membershipBaseline.test.ts` now (Task 13 handles the docs). Re-run `npm run typecheck`: expect remaining errors only in `custodian.test.ts` / `route` fakes if any `GiftsStore` fake lacks the Task 2 methods — fix those fakes. Then clean.

- [ ] **Step 5: Commit**

```bash
git add src/consumer/processBatch.ts src/consumer/processBatch.test.ts src/index.ts src/db/membershipBaseline.ts src/db/membershipBaseline.test.ts
git commit -m "feat(donation-rollups): fold the full gift and check-in history into membership; retire the baseline"
```

---

### Task 8: Registration messages in the consumer

**Files:**
- Modify: `src/consumer/processBatch.ts` (`processOne` branch, new `processRegistration`)
- Test: `src/consumer/processBatch.test.ts`

**Interfaces:**
- Consumes: `RecomputeQueueMessage.kind` (Task 2); `getRegistration`, `getEventStart`, `getItemBoardId` (Task 6); `registrationQualifies` (Task 4); `VolunteerActivityStore.upsert/markRemoved` (Task 1).
- Produces: a `kind: 'registration'` message with `donationItemId` = the registration item id and `donationBoardId` = the Event Registrations board id is processed; `pending_recomputes` row for that id is marked `written`.

- [ ] **Step 1: Write the failing tests**

Append to `src/consumer/processBatch.test.ts`:

```ts
describe('registration messages (kind: registration)', () => {
  const volunteerBoard = { boardId: 7, columns: { attendee: 'att', event: 'ev', attendance: 'atd', role: 'role', hours: null },
    eventBoard: { boardId: 8, columns: { start: 'start' } }, volunteerRoleLabels: ['Volunteer'], countedAttendanceLabels: ['Attended'] };
  const cfg: DonationRollupsConfig = { ...membershipEnabled, donationRollups: { ...membershipEnabled.donationRollups, volunteerBoards: [volunteerBoard] } };
  const reg = (over = {}) => ({ id: 'r1', attendeeItemId: 'p1', eventItemId: 'e1', attendanceLabel: 'Attended', roleLabel: 'Volunteer', hours: null, ...over });
  const regMessage = () => ({ body: { kind: 'registration' as const, donationItemId: 'r1', donationBoardId: '7' }, ack: vi.fn(), retry: vi.fn() });

  function deps(over: { registration?: unknown; eventStart?: string | null; previousOwner?: { ownerItemId: string; ownerBoardId: string } | null; ownerBoard?: string } = {}) {
    const changeColumnValues = vi.fn().mockResolvedValue(undefined);
    const volunteerStore = fakeVolunteerStore();
    (volunteerStore.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({ previousOwner: over.previousOwner ?? null });
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const pendingStore = fakePendingStore();
    const mondayClient = fakeMondayClient({
      changeColumnValues,
      getRegistration: vi.fn().mockResolvedValue(over.registration === undefined ? reg() : over.registration),
      getEventStart: vi.fn().mockResolvedValue(over.eventStart === undefined ? '2027-05-02' : over.eventStart),
      getItemBoardId: vi.fn().mockResolvedValue(over.ownerBoard ?? '2'),
      getDonationsByIds: vi.fn().mockResolvedValue([]),
    });
    const linksStore = fakeLinksStore({ getLinksForOwner: vi.fn().mockResolvedValue(new Map()) });
    return { changeColumnValues, volunteerStore, queue, pendingStore, mondayClient,
      run: (message = regMessage()) => processRecomputeBatch([message], {
        pendingStore, linksStore, giftsStore: fakeGiftsStore(), affiliationsStore: fakeAffiliationsStore(),
        recomputesStore: fakeRecomputesStore(), volunteerStore, mondayClient, config: cfg, queue, now: NOW }) };
  }

  it('a qualifying check-in is stored and recomputes the attendee', async () => {
    const d = deps();
    await d.run();
    expect(d.volunteerStore.upsert).toHaveBeenCalledWith(expect.objectContaining({
      registrationItemId: 'r1', boardId: '7', ownerItemId: 'p1', ownerBoardId: '2', activityDateISO: '2027-05-02', hours: null, qualifies: true, source: 'webhook' }), expect.any(String));
    expect(d.changeColumnValues.mock.calls[0]![1]).toBe('p1');
    expect(d.pendingStore.updateStatus).toHaveBeenCalledWith('r1', 'written', expect.objectContaining({ ownerItemId: 'p1' }));
  });

  it('an undated Event stores qualifies=false and still recomputes the attendee (Review Focus 1)', async () => {
    const d = deps({ eventStart: null });
    await d.run();
    expect(d.volunteerStore.upsert).toHaveBeenCalledWith(expect.objectContaining({ qualifies: false, activityDateISO: null }), expect.any(String));
    expect(d.changeColumnValues).toHaveBeenCalledTimes(1);
  });

  it('an unlinked registrant is stored with no owner and recomputes nobody', async () => {
    const d = deps({ registration: reg({ attendeeItemId: null }) });
    await d.run();
    expect(d.volunteerStore.upsert).toHaveBeenCalledWith(expect.objectContaining({ ownerItemId: null, qualifies: false }), expect.any(String));
    expect(d.mondayClient.getItemBoardId).not.toHaveBeenCalled();
    expect(d.changeColumnValues).not.toHaveBeenCalled();
    expect(d.pendingStore.updateStatus).toHaveBeenCalledWith('r1', 'written', expect.anything());
  });

  it('an Attendee re-point recomputes the new owner inline and queues the previous one (Review Focus 3)', async () => {
    const d = deps({ previousOwner: { ownerItemId: 'p0', ownerBoardId: '2' } });
    await d.run();
    expect(d.changeColumnValues.mock.calls[0]![1]).toBe('p1');
    expect(d.queue.send).toHaveBeenCalledWith({ donationItemId: 'r1', donationBoardId: '7', ownerItemId: 'p0', ownerBoardId: '2' });
  });

  it('a deleted registration is marked removed and its former owner recomputed', async () => {
    const d = deps({ registration: null });
    (d.volunteerStore.markRemoved as ReturnType<typeof vi.fn>).mockResolvedValue({ ownerItemId: 'p1', ownerBoardId: '2' });
    await d.run();
    expect(d.volunteerStore.upsert).not.toHaveBeenCalled();
    expect(d.changeColumnValues.mock.calls[0]![1]).toBe('p1');
  });

  it('an attendee on a board without membership columns (Organizations) is stored but not recomputed', async () => {
    const d = deps({ ownerBoard: '3' });
    await d.run();
    expect(d.volunteerStore.upsert).toHaveBeenCalled();
    expect(d.changeColumnValues).not.toHaveBeenCalled();
  });

  it('a registration from a board outside volunteerBoards is non-retryable: marked failed and acked', async () => {
    const d = deps();
    const message = { body: { kind: 'registration' as const, donationItemId: 'r1', donationBoardId: '999' }, ack: vi.fn(), retry: vi.fn() };
    await d.run(message);
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    expect(d.pendingStore.updateStatus).toHaveBeenCalledWith('r1', 'failed', expect.objectContaining({ error: expect.stringContaining('volunteerBoards') }));
  });
});
```

Add `getRegistration: vi.fn().mockResolvedValue(null)`, `getEventStart: vi.fn().mockResolvedValue(null)`, `pageRegistrations: vi.fn().mockResolvedValue({ items: [], cursor: null })`, `pageHistoricalShifts: vi.fn().mockResolvedValue({ items: [], cursor: null })`, `getItemsBoardIds: vi.fn().mockResolvedValue(new Map())` to `fakeMondayClient`'s defaults.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- src/consumer/processBatch.test.ts -t "registration messages"`
Expected: FAIL — the consumer treats the message as a donation (`config: no donationBoards entry for board id "7"`).

- [ ] **Step 3: Implement**

In `src/consumer/processBatch.ts`, at the top of `processOne` (before the owner-keyed branch):

```ts
  if (message.kind === 'registration') {
    await processRegistration(message, deps);
    return;
  }
```

and add:

```ts
// An Event Registrations item changed (spec 2026-10-09 "Architecture"): re-read it, store whether
// it qualifies as a check-in, and recompute the attendee — plus whoever it counted for before,
// when the Attendee link moved or the item was deleted. Same division of labor as a Donor re-point.
async function processRegistration(message: RecomputeQueueMessage, deps: ProcessBatchDeps): Promise<void> {
  const { donationItemId: registrationItemId, donationBoardId: boardId } = message;
  const { mondayClient, volunteerStore, config } = deps;
  const board = config.donationRollups.volunteerBoards.find((b) => String(b.boardId) === boardId);
  if (board === undefined) {
    throw new NonRetryableError(`config: no volunteerBoards entry for board id "${boardId}" (this registration's board)`);
  }
  const now = new Date().toISOString();
  const owners: { ownerItemId: string; ownerBoardId: string }[] = [];

  const reg = await mondayClient.getRegistration(registrationItemId, board);
  if (reg === null) {
    const removed = await volunteerStore.markRemoved(registrationItemId, now);
    if (removed !== null) owners.push(removed);
  } else {
    const eventStart = reg.eventItemId === null ? null : await mondayClient.getEventStart(reg.eventItemId, board.eventBoard.columns.start);
    const ownerBoardId = reg.attendeeItemId === null ? null : await mondayClient.getItemBoardId(reg.attendeeItemId);
    const qualifies = registrationQualifies(reg, eventStart, board);
    const { previousOwner } = await volunteerStore.upsert({
      registrationItemId, boardId, ownerItemId: reg.attendeeItemId, ownerBoardId,
      activityDateISO: eventStart, hours: reg.hours, qualifies, source: 'webhook',
    }, now);
    if (reg.attendeeItemId !== null && ownerBoardId !== null) owners.push({ ownerItemId: reg.attendeeItemId, ownerBoardId });
    if (previousOwner !== null && previousOwner.ownerItemId !== reg.attendeeItemId) owners.push(previousOwner);
  }

  // Only People boards carry membership columns; a registration linked elsewhere is recorded
  // (the link may move later) but recomputes nothing. First owner inline, the rest queued —
  // a second full recompute here would blow the per-invocation budget max_batch_size is tuned for.
  const recomputable = owners.filter((o) => config.donationRollups.ownerColumnsByBoard[o.ownerBoardId]?.membership !== undefined);
  const [first, ...rest] = recomputable;
  if (first !== undefined) await recomputeOwner(deps, first.ownerItemId, first.ownerBoardId, registrationItemId);
  for (const o of rest) await enqueueOwnerRecompute(deps, message, o);

  await deps.pendingStore.updateStatus(registrationItemId, 'written', {
    ...(first ? { ownerItemId: first.ownerItemId, ownerBoard: first.ownerBoardId } : {}), writtenAt: new Date().toISOString(),
  });
}
```

Import `registrationQualifies` from `'../membership/volunteer'`. Note `enqueueOwnerRecompute` sends a message without `kind`, so the queued previous owner is handled by the existing owner-keyed branch (kind defaults to donation; `donationItemId` is the registration id, used only in logs).

- [ ] **Step 4: Run the tests**

Run: `npm test -- src/consumer/processBatch.test.ts && npm run typecheck`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/consumer/processBatch.ts src/consumer/processBatch.test.ts
git commit -m "feat(donation-rollups): process Event Registrations check-ins as membership activity"
```

---

### Task 9: Webhook route accepts registration boards; index wiring

**Files:**
- Modify: `src/webhook/route.ts` (`AppDeps.registrationBoards`, routing)
- Modify: `src/index.ts` (build `registrationBoards` from config)
- Test: `src/webhook/route.test.ts`

**Interfaces:**
- Consumes: `NewPending.kind` (Task 2), `VolunteerBoardConfig` (Task 3).
- Produces:
  ```ts
  export interface AppDeps {
    ...existing;
    // Event Registrations boards → the column ids whose changes matter (Attendee, Event,
    // Attendance, Role, Hours). create_pulse and item deletion always matter; any other column
    // change on these boards is acknowledged and ignored.
    registrationBoards: ReadonlyMap<string, ReadonlySet<string>>;
  }
  ```

- [ ] **Step 1: Write the failing tests**

In `src/webhook/route.test.ts`, add `registrationBoards: new Map()` to every `createApp({...})` call (a sed: `donationBoardIds: BOARD_IDS, ignoredColumnIds` → `donationBoardIds: BOARD_IDS, registrationBoards: new Map(), ignoredColumnIds`), then append:

```ts
describe('Event Registrations webhooks', () => {
  const REG = new Map([['7', new Set(['att', 'ev', 'atd', 'role', 'hrs'])]]);
  function regApp(send = vi.fn(), pendingStore = fakePendingStore()) {
    return { app: createApp({ pendingStore, queue: { send }, donationBoardIds: BOARD_IDS, registrationBoards: REG, ignoredColumnIds: new Set(), webhookSecret: 'shh' }), send, pendingStore };
  }
  it('enqueues a registration message for create_pulse and records kind on the pending row', async () => {
    const { app, send, pendingStore } = regApp();
    const res = await post(app, { event: { type: 'create_pulse', pulseId: 41, boardId: 7 } });
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledWith({ kind: 'registration', donationItemId: '41', donationBoardId: '7' });
    expect(pendingStore.upsertPending).toHaveBeenCalledWith(expect.objectContaining({ donationItemId: '41', donationBoardId: '7', kind: 'registration' }));
  });
  it('enqueues for a change to an accepted column and for item deletion', async () => {
    const { app, send } = regApp();
    await post(app, { event: { type: 'update_column_value', pulseId: 41, boardId: 7, columnId: 'atd' } });
    await post(app, { event: { type: 'delete_pulse', pulseId: 41, boardId: 7 } });
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('ignores a change to any other column on a registration board', async () => {
    const { app, send } = regApp();
    const res = await post(app, { event: { type: 'update_column_value', pulseId: 41, boardId: 7, columnId: 'notes' } });
    expect(await res.json()).toMatchObject({ ok: true, ignored: expect.stringContaining('notes') });
    expect(send).not.toHaveBeenCalled();
  });
  it('still ignores boards in neither set', async () => {
    const { app, send } = regApp();
    const res = await post(app, { event: { type: 'create_pulse', pulseId: 1, boardId: 999 } });
    expect(await res.json()).toMatchObject({ ok: true, ignored: expect.any(String) });
    expect(send).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- src/webhook/route.test.ts`
Expected: FAIL — `registrationBoards` not a known dep; board 7 ignored.

- [ ] **Step 3: Implement**

In `src/webhook/route.ts`, add `registrationBoards: ReadonlyMap<string, ReadonlySet<string>>;` to `AppDeps` with the comment from Interfaces. Replace the board check and enqueue section (from `if (!deps.donationBoardIds.has(...))` through the `queue.send`) with:

```ts
    const registrationColumns = deps.registrationBoards.get(donationEvent.boardId);
    const kind: RecomputeKind = registrationColumns !== undefined ? 'registration' : 'donation';
    if (kind === 'donation' && !deps.donationBoardIds.has(donationEvent.boardId)) {
      console.warn(`donation-rollups webhook: ignoring event for item "${donationEvent.donationItemId}" on board "${donationEvent.boardId}" — not in config.donationBoards or volunteerBoards (stale subscription?)`);
      return c.json({ ok: true, ignored: `board "${donationEvent.boardId}" not in config.donationBoards or volunteerBoards` }, 200);
    }
    if (donationEvent.columnId !== null && deps.ignoredColumnIds.has(`${donationEvent.boardId}:${donationEvent.columnId}`)) {
      return c.json({ ok: true, ignored: `classification column "${donationEvent.columnId}"` }, 200);
    }
    if (kind === 'registration' && donationEvent.columnId !== null && !registrationColumns!.has(donationEvent.columnId)) {
      return c.json({ ok: true, ignored: `registration column "${donationEvent.columnId}" does not affect membership` }, 200);
    }

    await deps.pendingStore.upsertPending({
      donationItemId: donationEvent.donationItemId,
      donationBoardId: donationEvent.boardId,
      eventId: donationEvent.eventId,
      receivedAt: new Date().toISOString(),
      kind,
    });

    try {
      await deps.queue.send({ ...(kind === 'registration' ? { kind } : {}), donationItemId: donationEvent.donationItemId, donationBoardId: donationEvent.boardId });
```

(the rest of the try/catch is unchanged). Import `RecomputeKind` from `'../types'`.

In `src/index.ts`, in `createApp({...})` add:

```ts
        registrationBoards: new Map(config.donationRollups.volunteerBoards.map((b) => [String(b.boardId),
          new Set([b.columns.attendee, b.columns.event, b.columns.attendance, b.columns.role, ...(b.columns.hours ? [b.columns.hours] : [])])])),
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- src/webhook/route.test.ts src/index.test.ts && npm run typecheck`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/webhook/route.ts src/webhook/route.test.ts src/index.ts
git commit -m "feat(donation-rollups): accept Event Registrations webhooks for the membership rule"
```

---
### Task 10: The `membership` custodian duty — nightly anniversaries, duty options

**Files:**
- Create: `src/custodian/membership.ts`
- Modify: `src/custodian/custodian.ts` (`DUTIES`, `dutiesForDate`, `runDuty(duty, deps, opts)`, `CustodianDeps`, `CustodianMondayClient`)
- Modify: `src/custodian/routes.ts` (parse `all` / `since`)
- Modify: `src/index.ts` (`custodianDeps` wiring, `runDuty` call sites)
- Test: `src/custodian/membership.test.ts`, `src/custodian/custodian.test.ts`, `src/custodian/routes.test.ts`

**Interfaces:**
- Consumes: `addMonths` (Task 5); `VolunteerActivityStore` (Task 1); `OwnerRecomputesStore.writtenSince`, `GiftsStore.giftsMissingTermStart/setTermStarts` (Task 2); client paging methods (Task 6); `registrationQualifies`, `historicalShiftQualifies` (Task 4).
- Produces:
  ```ts
  // custodian.ts
  export const DUTIES = ['archive', 'capacity', 'sweep', 'reconcile', 'requeue', 'classify', 'membership'] as const;
  export interface DutyOptions { all?: boolean; since?: string }
  export function runDuty(duty: Duty, deps: CustodianDeps, opts?: DutyOptions): Promise<DutyReport>;
  export interface CustodianDeps { ...existing; volunteers: VolunteerActivityStore; recomputes: OwnerRecomputesStore }
  export interface CustodianMondayClient { ...existing;
    pageRegistrations(board: VolunteerBoardConfig, cursor: string | null): Promise<{ items: RegistrationRecord[]; cursor: string | null }>;
    pageHistoricalShifts(board: HistoricalVolunteerBoardConfig, cursor: string | null): Promise<{ items: HistoricalShiftRecord[]; cursor: string | null }>;
    getItemsBoardIds(itemIds: string[]): Promise<Map<string, string>>;
  }
  // membership.ts
  export interface MembershipDutyOptions { all: boolean; since: string | null }
  export type MembershipPhase = 'anniversaries' | 'load-volunteers' | 'backfill-terms' | 'enqueue';
  export interface MembershipDetail { all: boolean; since: string | null; phase: MembershipPhase; cursor: string; remaining: number;
    scanned: number; enqueued: number; loaded: number; backfilled: number }
  export async function runMembership(deps: CustodianDeps, now: Date, opts: MembershipDutyOptions, lastDetail: MembershipDetail | null): Promise<DutyReport>;
  export const ENQUEUE_PER_RUN = 3_500; export const BACKFILL_PER_RUN = 5_000;
  // routes.ts: POST /custodian/run/:duty?all=true&since=<ISO> → runDuty(duty, { all: true, since })
  ```

- [ ] **Step 1: Write the failing tests (nightly path, routes, scheduling)**

`src/custodian/membership.test.ts` (D1-backed like `custodian.test.ts`):

```ts
import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { runMembership, ENQUEUE_PER_RUN, type MembershipDetail } from './membership';
import type { CustodianDeps, CustodianMondayClient } from './custodian';
import { D1GiftsStore } from '../db/gifts';
import { D1PendingStore } from '../db/pending';
import { D1VolunteerActivityStore } from '../db/volunteerActivity';
import { D1OwnerRecomputesStore } from '../db/ownerRecomputes';
import type { DonationRollupsConfig, RecomputeQueueMessage } from '../types';

const MEMBERSHIP = { status: 'ms', tier: 'mt', since: 'msince', until: 'muntil', currentTermStart: 'mcts', memberType: 'mtype', lapseCount: 'mlc', lastLapsed: 'mll' };
const OWNER_COLS = { giftLedgerJson: 'c', lifetimeGiving: 'c', giftCount: 'c', firstGift: 'c', thisYearAmount: 'c', thisYearCount: 'c',
  lastYearAmount: 'c', lastYearCount: 'c', largestGift: 'c', smallestGift: 'c', averageGift: 'c', lastGiftDate: 'c', lastGiftAmount: 'c' };
const VOL_BOARD = { boardId: 7, columns: { attendee: 'att', event: 'ev', attendance: 'atd', role: 'role', hours: null as string | null },
  eventBoard: { boardId: 8, columns: { start: 'start' } }, volunteerRoleLabels: ['Volunteer'], countedAttendanceLabels: ['Attended'] };
const HIST_BOARD = { boardId: 9, columns: { volunteer: 'vol', date: 'dt', hours: 'hrs', status: 'st' }, countedStatusLabels: ['Completed'] };

function config(): DonationRollupsConfig {
  return {
    monday: { apiUrl: 'https://x', accountUrl: 'https://acme.monday.com' },
    fiscalYear: { startMonth: 7, timeZone: 'America/Los_Angeles' },
    custodian: { activeFiscalYears: 2, workspaceId: 1, capacityAlertPct: 80, alertItemId: null, annualSummaryBoardId: null, annualSummaryColumns: null },
    affiliations: null,
    donationRollups: {
      donationBoards: [{ boardId: 100, columns: { donorLink: 'd', amount: 'a', date: 'dt', status: 's', fiscalYear: null, giftType: 'gt', termStart: 'ts', termEnd: 'te', membershipType: 'mty', actingForLink: null, classification: null } }],
      receivedStatusLabel: 'Received',
      ownerColumnsByBoard: { '20': { ...OWNER_COLS, membership: MEMBERSHIP }, '28': { ...OWNER_COLS, membership: MEMBERSHIP }, '13': OWNER_COLS },
      membership: { fromISO: '2026-10-16', eligibleGiftTypes: ['Donation'], minAmountCents: 100, termMonths: 13, lifetimeThresholdCents: 100000,
        statusLabels: { active: 'Active', lapsed: 'Lapsed' }, tierLabels: { member: 'Member', lifetime: 'Lifetime' },
        typeLabels: { new: 'New', continuing: 'Continuing', lapsedRenewal: 'Lapsed renewal', lifetime: 'Lifetime' } },
      donorLevel: null, volunteerBoards: [VOL_BOARD], historicalVolunteerBoards: [HIST_BOARD],
    },
  };
}

interface Fake {
  // board id -> items with column text, as pageItemsColumnsText pages them (one page)
  pages?: Record<string, { id: string; text: Record<string, string | null> }[]>;
  registrations?: { id: string; attendeeItemId: string | null; eventItemId: string | null; attendanceLabel: string | null; roleLabel: string | null; hours: number | null }[];
  shifts?: { id: string; volunteerItemId: string | null; dateISO: string | null; hours: number | null; statusLabel: string | null }[];
  boardOf?: Record<string, string>;
  columnText?: Record<string, Record<string, string | null>>;
}
function fakeClient(f: Fake): CustodianMondayClient {
  return {
    async archiveItem() {}, async listWorkspaceBoards() { return []; }, async createUpdate() {}, async createItem() { return 'x'; }, async changeColumnValues() {},
    async pageItemsColumnsText(boardId, columnIds) {
      const items = (f.pages?.[String(boardId)] ?? []).map((i) => ({ id: i.id, text: new Map(columnIds.map((c) => [c, i.text[c] ?? null])) }));
      return { items, cursor: null };
    },
    async getItemsColumnsText(ids, columnIds) {
      const out = new Map<string, Map<string, string | null>>();
      for (const id of ids) { const rec = f.columnText?.[id]; if (rec) out.set(id, new Map(columnIds.map((c) => [c, rec[c] ?? null]))); }
      return out;
    },
    async pageRegistrations() { return { items: f.registrations ?? [], cursor: null }; },
    async pageHistoricalShifts() { return { items: f.shifts ?? [], cursor: null }; },
    async getItemsBoardIds(ids) { return new Map(ids.flatMap((id) => (f.boardOf?.[id] ? [[id, f.boardOf[id]!] as [string, string]] : []))); },
  };
}
function deps(f: Fake, sent: RecomputeQueueMessage[], now = new Date('2027-12-03T10:00:00Z')): CustodianDeps {
  return { gifts: new D1GiftsStore(env.DB), pending: new D1PendingStore(env.DB), volunteers: new D1VolunteerActivityStore(env.DB),
    recomputes: new D1OwnerRecomputesStore(env.DB), mondayClient: fakeClient(f),
    queue: { sendBatch: async (m) => { sent.push(...m); } }, config: config(), now };
}

describe('membership duty — nightly anniversaries', () => {
  it('enqueues owner-keyed recomputes for people whose Current Term Start anniversary is today or yesterday', async () => {
    const sent: RecomputeQueueMessage[] = [];
    const d = deps({ pages: { '20': [
      { id: 'today', text: { mcts: '2026-11-03' } }, { id: 'yesterday', text: { mcts: '2026-11-02' } },
      { id: 'tomorrow', text: { mcts: '2026-11-04' } }, { id: 'blank', text: { mcts: null } } ],
      '28': [{ id: 'hist-today', text: { mcts: '2026-11-03 00:00' } }] } }, sent);
    const report = await runMembership(d, d.now!, { all: false, since: null }, null);
    expect(report.ok).toBe(true);
    expect(sent.map((m) => [m.ownerItemId, m.ownerBoardId])).toEqual([['today', '20'], ['yesterday', '20'], ['hist-today', '28']]);
    expect(sent[0]).toEqual({ donationItemId: 'custodian:membership', donationBoardId: '', ownerItemId: 'today', ownerBoardId: '20' });
    expect(report.detail).toMatchObject({ all: false, phase: 'anniversaries', enqueued: 3, scanned: 5, remaining: 0 });
  });
  it('is a no-op with a report when the membership block is null', async () => {
    const sent: RecomputeQueueMessage[] = [];
    const d = deps({}, sent);
    d.config.donationRollups.membership = null;
    const report = await runMembership(d, d.now!, { all: false, since: null }, null);
    expect(report.ok).toBe(true);
    expect(sent).toEqual([]);
  });
});
```

In `src/custodian/custodian.test.ts`: add to `fakeClient` the four new methods (`pageRegistrations`/`pageHistoricalShifts` returning `{ items: [], cursor: null }`, `getItemsBoardIds` returning `new Map()`), add `volunteers: new D1VolunteerActivityStore(env.DB), recomputes: new D1OwnerRecomputesStore(env.DB)` to `deps()`, add `volunteerBoards: [], historicalVolunteerBoards: []` to `testConfig().donationRollups`, and add:

```ts
it('membership runs nightly', () => {
  expect(dutiesForDate(new Date('2026-03-04T12:00:00Z'), { startMonth: 7, timeZone: 'America/Los_Angeles' })).toContain('membership');
});
```

In `src/custodian/routes.test.ts` add:

```ts
it('passes all=true and since through to the duty; absent options are undefined', async () => {
  const runDuty = vi.fn().mockResolvedValue({ ok: true, summary: 'x' });
  const a = app({ secret: 'shh', runDuty });
  await a.request('/custodian/run/membership?secret=shh&all=true&since=2026-10-17T00:00:00Z', { method: 'POST' });
  expect(runDuty).toHaveBeenCalledWith('membership', { all: true, since: '2026-10-17T00:00:00Z' });
  await a.request('/custodian/run/membership?secret=shh', { method: 'POST' });
  expect(runDuty).toHaveBeenLastCalledWith('membership', {});
});
it('rejects a malformed since', async () => {
  const a = app({ secret: 'shh' });
  expect((await a.request('/custodian/run/membership?secret=shh&all=true&since=yesterday', { method: 'POST' })).status).toBe(400);
});
```

and update the existing `expect(runDuty).toHaveBeenCalledWith('sweep')` to `toHaveBeenCalledWith('sweep', {})`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- src/custodian/`
Expected: FAIL — `./membership` missing; `runDuty` called with one argument; `'membership'` not in `DUTIES`.

- [ ] **Step 3: Implement the duty skeleton and the nightly path**

`src/custodian/membership.ts`:

```ts
// The membership duty (spec 2026-10-09 "Nightly duty and the one-time recompute"). Nightly it
// recomputes the people whose Member Type is due to flip on the 13-month anniversary of their
// Current Term Start. With all=true it is the post-cutover recompute: load volunteer activity,
// backfill migrated Term Starts, then enqueue every person once — sliced and cursored across
// runs like the sweep, continued by the next nightly trigger until remaining is 0.
import { addMonths } from '../membership/derive';
import { registrationQualifies, historicalShiftQualifies } from '../membership/volunteer';
import type { CustodianDeps, DutyReport } from './custodian';
import type { RecomputeQueueMessage } from '../types';

export interface MembershipDutyOptions { all: boolean; since: string | null }
export type MembershipPhase = 'anniversaries' | 'load-volunteers' | 'backfill-terms' | 'enqueue';
export interface MembershipDetail {
  all: boolean; since: string | null; phase: MembershipPhase; cursor: string; remaining: number;
  scanned: number; enqueued: number; loaded: number; backfilled: number;
}

export const ENQUEUE_PER_RUN = 3_500;   // 35 sendBatch calls of 100, same budget as the sweep
export const BACKFILL_PER_RUN = 5_000;  // 50 items(ids:) reads of 100
const TRIGGER_ID = 'custodian:membership';

const ownerMessage = (ownerItemId: string, ownerBoardId: string): RecomputeQueueMessage =>
  ({ donationItemId: TRIGGER_ID, donationBoardId: '', ownerItemId, ownerBoardId });

async function sendAll(deps: CustodianDeps, messages: RecomputeQueueMessage[]): Promise<void> {
  for (let i = 0; i < messages.length; i += 100) await deps.queue.sendBatch(messages.slice(i, i + 100));
}

function membershipBoards(deps: CustodianDeps): { boardId: string; currentTermStart: string }[] {
  return Object.entries(deps.config.donationRollups.ownerColumnsByBoard)
    .filter(([, cols]) => cols.membership !== undefined)
    .map(([boardId, cols]) => ({ boardId, currentTermStart: cols.membership!.currentTermStart }));
}

// Every item on a People board, with one column's text — paged in full each run (reads are
// cheap; Monday page cursors expire, so nothing here persists one across runs).
async function pageBoard(deps: CustodianDeps, boardId: string, columnId: string): Promise<{ id: string; text: string | null }[]> {
  const out: { id: string; text: string | null }[] = [];
  let cursor: string | null = null;
  do {
    const page = await deps.mondayClient.pageItemsColumnsText(Number(boardId), [columnId], cursor);
    for (const item of page.items) out.push({ id: item.id, text: item.text.get(columnId) ?? null });
    cursor = page.cursor;
  } while (cursor !== null);
  return out;
}

export async function runMembership(
  deps: CustodianDeps, now: Date, opts: MembershipDutyOptions, lastDetail: MembershipDetail | null,
): Promise<DutyReport> {
  const membership = deps.config.donationRollups.membership;
  if (membership === null) return { ok: true, summary: 'membership block is null — nothing to do', detail: null };

  // An unfinished all=true pass is continued by whoever runs next (the nightly cron, or the
  // route again); a fresh all=true starts over at the first phase.
  const continuing = lastDetail !== null && lastDetail.all && lastDetail.remaining > 0;
  if (opts.all || continuing) {
    const start: MembershipDetail = continuing ? lastDetail! : { all: true, since: opts.since, phase: 'load-volunteers', cursor: '', remaining: 1,
      scanned: 0, enqueued: 0, loaded: 0, backfilled: 0 };
    return runAll(deps, now, start);
  }
  return runAnniversaries(deps, now, membership.termMonths);
}

async function runAnniversaries(deps: CustodianDeps, now: Date, termMonths: number): Promise<DutyReport> {
  const todayISO = now.toISOString().slice(0, 10);
  const yesterdayISO = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  const messages: RecomputeQueueMessage[] = [];
  let scanned = 0;
  for (const board of membershipBoards(deps)) {
    for (const item of await pageBoard(deps, board.boardId, board.currentTermStart)) {
      scanned++;
      if (item.text === null) continue;
      const anniversary = addMonths(item.text.slice(0, 10), termMonths);
      if (anniversary === todayISO || anniversary === yesterdayISO) messages.push(ownerMessage(item.id, board.boardId));
    }
  }
  await sendAll(deps, messages);
  const detail: MembershipDetail = { all: false, since: null, phase: 'anniversaries', cursor: '', remaining: 0,
    scanned, enqueued: messages.length, loaded: 0, backfilled: 0 };
  return { ok: true, summary: `enqueued ${messages.length} anniversary recompute(s) from ${scanned} people`, detail };
}

// Task 11 fills this in.
async function runAll(deps: CustodianDeps, now: Date, detail: MembershipDetail): Promise<DutyReport> {
  return { ok: false, summary: 'membership all=true is not implemented yet', detail };
}
```

In `src/custodian/custodian.ts`: add `'membership'` to `DUTIES`; add `export interface DutyOptions { all?: boolean; since?: string }`; import `runMembership, type MembershipDetail` from `'./membership'`, `VolunteerActivityStore` from `'../db/volunteerActivity'`, `OwnerRecomputesStore` from `'../db/ownerRecomputes'`, `RegistrationRecord`, `HistoricalShiftRecord` from `'../monday/client'`, `VolunteerBoardConfig`, `HistoricalVolunteerBoardConfig` from `'../types'`. Add the three client methods to `CustodianMondayClient` and `volunteers` / `recomputes` to `CustodianDeps` (Interfaces above). In `dutiesForDate`, change the nightly list to `['reconcile', 'requeue', 'classify', 'membership']`. Change `runDuty`:

```ts
export async function runDuty(duty: Duty, deps: CustodianDeps, opts: DutyOptions = {}): Promise<DutyReport> {
  const now = deps.now ?? new Date();
  let report: DutyReport;
  try {
    report =
      duty === 'archive' ? await runArchive(deps, now)
      : duty === 'capacity' ? await runCapacity(deps)
      : duty === 'sweep' ? await runSweep(deps)
      : duty === 'requeue' ? await runRequeue(deps, now)
      : duty === 'classify' ? await runClassify(deps.mondayClient, deps.config)
      : duty === 'membership' ? await runMembership(deps, now, { all: opts.all ?? false, since: opts.since ?? null },
          ((await deps.gifts.lastRuns()).find((r) => r.duty === 'membership')?.report as { detail?: MembershipDetail } | undefined)?.detail ?? null)
      : await runReconcile(deps);
```

In `src/custodian/routes.ts`, in the `/custodian/run/:duty` handler before calling `runDuty`:

```ts
    const opts: DutyOptions = {};
    if (c.req.query('all') === 'true') opts.all = true;
    const since = c.req.query('since');
    if (since !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(since)) return c.json({ ok: false, error: 'since must be an ISO 8601 timestamp' }, 400);
      opts.since = since;
    }
    const report = await deps.runDuty(duty as Duty, opts);
```

with `runDuty(duty: Duty, opts: DutyOptions): Promise<DutyReport>` in `CustodianAppDeps` (import `DutyOptions`). In `src/index.ts`: `runDuty: (duty, opts) => runDuty(duty, deps, opts)` in the custodian app; `custodianDeps` adds `volunteers: new D1VolunteerActivityStore(env.DB), recomputes: new D1OwnerRecomputesStore(env.DB)`; the `scheduled()` loop is unchanged (`runDuty(duty, deps)` → default opts, and `runMembership` reads the last run itself to continue an all-pass).

- [ ] **Step 4: Run the tests**

Run: `npm test -- src/custodian/ && npm run typecheck`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/custodian src/index.ts
git commit -m "feat(donation-rollups): nightly membership duty flips Member Type on the anniversary"
```

---

### Task 11: `membership?all=true` — load volunteers, backfill Term Starts, enqueue everyone

**Files:**
- Modify: `src/custodian/membership.ts` (`runAll` and its three phases)
- Test: `src/custodian/membership.test.ts`

**Interfaces:**
- Consumes: everything Task 10 wired. Phases persist in `MembershipDetail` and resume from `lastDetail`.
- Produces: the post-cutover command `POST /custodian/run/membership?secret=…&all=true[&since=<ISO>]`, re-run (or left to the nightly cron) until `detail.remaining` is `0`.

- [ ] **Step 1: Write the failing tests**

Append to `src/custodian/membership.test.ts`:

```ts
describe('membership duty — all=true (the post-cutover recompute)', () => {
  it('phase 1 loads historical shifts and registrations into volunteer_activity with resolved owner boards', async () => {
    const sent: RecomputeQueueMessage[] = [];
    const d = deps({
      pages: { '8': [{ id: 'e1', text: { start: '2027-05-02 18:00' } }] },
      registrations: [
        { id: 'r1', attendeeItemId: 'pa', eventItemId: 'e1', attendanceLabel: 'Attended', roleLabel: 'Volunteer', hours: null },
        { id: 'r2', attendeeItemId: 'pb', eventItemId: 'e1', attendanceLabel: 'Registered', roleLabel: 'Volunteer', hours: null },
        { id: 'r3', attendeeItemId: null, eventItemId: 'e1', attendanceLabel: 'Attended', roleLabel: 'Volunteer', hours: null } ],
      shifts: [
        { id: 'v1', volunteerItemId: 'pc', dateISO: '2019-06-01', hours: 2, statusLabel: 'Completed' },
        { id: 'v2', volunteerItemId: 'pc', dateISO: '2019-07-01', hours: 2, statusLabel: 'Canceled' } ],
      boardOf: { pa: '20', pb: '28', pc: '28' },
    }, sent);
    const report = await runMembership(d, d.now!, { all: true, since: null }, null);
    const store = new D1VolunteerActivityStore(env.DB);
    expect(await store.forOwner('pa')).toEqual([expect.objectContaining({ registrationItemId: 'r1', ownerBoardId: '20', activityDateISO: '2027-05-02', qualifies: true, source: 'sweep' })]);
    expect(await store.forOwner('pb')).toEqual([]);
    expect(await store.forOwner('pc')).toEqual([expect.objectContaining({ registrationItemId: 'v1', hours: 2, source: 'historical' })]);
    expect((report.detail as MembershipDetail).loaded).toBe(5);
    expect((report.detail as MembershipDetail).remaining).toBeGreaterThan(0);   // the pass continues into later phases
  });

  it('phase 2 backfills migrated Term Starts from the board, blank as "", and skips post-cutover gifts', async () => {
    const sent: RecomputeQueueMessage[] = [];
    const gifts = new D1GiftsStore(env.DB);
    const base = { ownerItemId: 'bf-owner', ownerBoardId: '20', amountCents: 500, fiscalYear: 2019, status: 'Received' };
    await gifts.refreshFacts([
      { ...base, mondayItemId: 'bf-1', giftDateISO: '2019-01-01' }, { ...base, mondayItemId: 'bf-2', giftDateISO: '2019-02-01' },
      { ...base, mondayItemId: 'bf-3', giftDateISO: '2026-11-01', fiscalYear: 2027 } ], 'import', 'now');
    const d = deps({ columnText: { 'bf-1': { ts: '2019-01-01 00:00' }, 'bf-2': { ts: '' } } }, sent);
    const last: MembershipDetail = { all: true, since: null, phase: 'backfill-terms', cursor: '', remaining: 1, scanned: 0, enqueued: 0, loaded: 0, backfilled: 0 };
    const report = await runMembership(d, d.now!, { all: false, since: null }, last);   // nightly continuation
    const rows = await gifts.giftsForOwner('bf-owner');
    expect(rows.find((g) => g.mondayItemId === 'bf-1')?.termStart).toBe('2019-01-01');
    expect(rows.find((g) => g.mondayItemId === 'bf-2')?.termStart).toBe('');
    expect(rows.find((g) => g.mondayItemId === 'bf-3')?.termStart).toBeNull();
    expect((report.detail as MembershipDetail).backfilled).toBeGreaterThanOrEqual(2);
  });

  it('phase 3 enqueues every person on the membership boards plus check-in-only owners, once, skipping those recomputed since the given instant', async () => {
    const sent: RecomputeQueueMessage[] = [];
    const d = deps({ pages: { '20': [{ id: 'q-a', text: {} }, { id: 'q-b', text: {} }], '28': [{ id: 'q-c', text: {} }] } }, sent);
    await new D1VolunteerActivityStore(env.DB).upsert({ registrationItemId: 'q-r', boardId: '7', ownerItemId: 'q-vol', ownerBoardId: '28',
      activityDateISO: '2027-01-01', hours: null, qualifies: true, source: 'sweep' }, 'now');
    await new D1OwnerRecomputesStore(env.DB).record({ ownerItemId: 'q-b', ownerBoardId: '20', fetchedAt: '2026-10-18T01:00:00Z', writtenAt: '2026-10-18T01:01:00Z' });
    const last: MembershipDetail = { all: true, since: '2026-10-18T00:00:00Z', phase: 'enqueue', cursor: '', remaining: 1, scanned: 0, enqueued: 0, loaded: 0, backfilled: 0 };
    const report = await runMembership(d, d.now!, { all: false, since: null }, last);
    expect(sent.map((m) => m.ownerItemId).sort()).toEqual(['q-a', 'q-c', 'q-vol']);
    expect(sent.every((m) => m.donationItemId === 'custodian:membership')).toBe(true);
    expect(report.detail).toMatchObject({ phase: 'enqueue', remaining: 0, enqueued: 3 });
  });

  it('phase 3 slices at ENQUEUE_PER_RUN and resumes from an owner-id cursor', async () => {
    const sent: RecomputeQueueMessage[] = [];
    const many = Array.from({ length: ENQUEUE_PER_RUN + 5 }, (_, i) => ({ id: `s-${String(i).padStart(5, '0')}`, text: {} }));
    const d = deps({ pages: { '20': many } }, sent);
    const last: MembershipDetail = { all: true, since: null, phase: 'enqueue', cursor: '', remaining: 1, scanned: 0, enqueued: 0, loaded: 0, backfilled: 0 };
    const first = await runMembership(d, d.now!, { all: false, since: null }, last);
    expect(sent.length).toBe(ENQUEUE_PER_RUN);
    expect(first.detail).toMatchObject({ remaining: 5, cursor: `s-${String(ENQUEUE_PER_RUN - 1).padStart(5, '0')}` });
    const second = await runMembership(d, d.now!, { all: false, since: null }, first.detail as MembershipDetail);
    expect(sent.length).toBe(ENQUEUE_PER_RUN + 5);
    expect(second.detail).toMatchObject({ remaining: 0 });
  });

  it('a fresh all=true after a finished pass starts over at phase 1', async () => {
    const sent: RecomputeQueueMessage[] = [];
    const d = deps({}, sent);
    const done: MembershipDetail = { all: true, since: null, phase: 'enqueue', cursor: 'zzz', remaining: 0, scanned: 0, enqueued: 9, loaded: 0, backfilled: 0 };
    const report = await runMembership(d, d.now!, { all: true, since: '2026-10-18T00:00:00Z' }, done);
    expect(report.detail).toMatchObject({ all: true, since: '2026-10-18T00:00:00Z', loaded: 0 });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- src/custodian/membership.test.ts`
Expected: FAIL — `runAll` reports not implemented.

- [ ] **Step 3: Implement the three phases**

Replace the `runAll` stub in `src/custodian/membership.ts`:

```ts
async function runAll(deps: CustodianDeps, now: Date, detail: MembershipDetail): Promise<DutyReport> {
  const d = { ...detail };
  if (d.phase === 'load-volunteers') {
    d.loaded += await loadVolunteers(deps, now);
    d.phase = 'backfill-terms'; d.cursor = '';
  }
  if (d.phase === 'backfill-terms') {
    const r = await backfillTermStarts(deps, now, d.cursor);
    d.backfilled += r.backfilled; d.cursor = r.cursor;
    if (r.remaining > 0) { d.remaining = r.remaining; return done(d); }
    d.phase = 'enqueue'; d.cursor = '';
  }
  const r = await enqueueEveryone(deps, d.since, d.cursor);
  d.enqueued += r.enqueued; d.scanned += r.scanned; d.cursor = r.cursor; d.remaining = r.remaining;
  return done(d);

  function done(detail: MembershipDetail): DutyReport {
    return { ok: true, detail, summary:
      `membership all=true: phase ${detail.phase}, loaded ${detail.loaded} volunteer rows, backfilled ${detail.backfilled} term starts, ` +
      `enqueued ${detail.enqueued} owners` + (detail.remaining > 0 ? ` — ${detail.remaining} remain, continuing next run` : ' — complete') };
  }
}

// Phase 1: the 2014-2020 Volunteers board, then every Event Registrations item, into
// volunteer_activity. Reads only on Monday; upserts are idempotent, so a crash mid-phase is
// simply re-run.
async function loadVolunteers(deps: CustodianDeps, now: Date): Promise<number> {
  const nowISO = now.toISOString();
  let loaded = 0;
  for (const board of deps.config.donationRollups.historicalVolunteerBoards) {
    let cursor: string | null = null;
    do {
      const page = await deps.mondayClient.pageHistoricalShifts(board, cursor);
      const boards = await deps.mondayClient.getItemsBoardIds(page.items.flatMap((s) => (s.volunteerItemId ? [s.volunteerItemId] : [])));
      for (const s of page.items) {
        await deps.volunteers.upsert({ registrationItemId: s.id, boardId: String(board.boardId),
          ownerItemId: s.volunteerItemId, ownerBoardId: s.volunteerItemId ? boards.get(s.volunteerItemId) ?? null : null,
          activityDateISO: s.dateISO, hours: s.hours, qualifies: historicalShiftQualifies(s, board), source: 'historical' }, nowISO);
        loaded++;
      }
      cursor = page.cursor;
    } while (cursor !== null);
  }
  for (const board of deps.config.donationRollups.volunteerBoards) {
    const eventStart = new Map((await pageBoard(deps, String(board.eventBoard.boardId), board.eventBoard.columns.start))
      .map((e) => [e.id, e.text === null ? null : e.text.slice(0, 10)]));
    let cursor: string | null = null;
    do {
      const page = await deps.mondayClient.pageRegistrations(board, cursor);
      const boards = await deps.mondayClient.getItemsBoardIds(page.items.flatMap((r) => (r.attendeeItemId ? [r.attendeeItemId] : [])));
      for (const r of page.items) {
        const start = r.eventItemId === null ? null : eventStart.get(r.eventItemId) ?? null;
        await deps.volunteers.upsert({ registrationItemId: r.id, boardId: String(board.boardId),
          ownerItemId: r.attendeeItemId, ownerBoardId: r.attendeeItemId ? boards.get(r.attendeeItemId) ?? null : null,
          activityDateISO: start, hours: r.hours, qualifies: registrationQualifies(r, start, board), source: 'sweep' }, nowISO);
        loaded++;
      }
      cursor = page.cursor;
    } while (cursor !== null);
  }
  return loaded;
}

// Phase 2: migrated Term Starts for pre-cutover gifts the webhook path never reads (archived
// ones above all). items(ids:) returns archived items; an item Monday no longer returns is
// recorded as '' so it is never asked for again.
async function backfillTermStarts(deps: CustodianDeps, now: Date, cursorIn: string): Promise<{ backfilled: number; cursor: string; remaining: number }> {
  const { fromISO } = deps.config.donationRollups.membership!;
  const termColumns = deps.config.donationRollups.donationBoards.flatMap((b) => (b.columns.termStart ? [b.columns.termStart] : []));
  let cursor = cursorIn;
  let backfilled = 0;
  while (backfilled < BACKFILL_PER_RUN) {
    const ids = await deps.gifts.giftsMissingTermStart(fromISO, cursor, Math.min(500, BACKFILL_PER_RUN - backfilled));
    if (ids.length === 0) return { backfilled, cursor, remaining: 0 };
    const text = await deps.mondayClient.getItemsColumnsText(ids, termColumns);
    await deps.gifts.setTermStarts(ids.map((id) => {
      const cols = text.get(id);
      const value = termColumns.map((c) => cols?.get(c) ?? null).find((v) => v !== null) ?? null;
      return { mondayItemId: id, termStart: value === null ? '' : value.slice(0, 10) };
    }), now.toISOString());
    backfilled += ids.length;
    cursor = ids.at(-1)!;
  }
  const more = await deps.gifts.giftsMissingTermStart(fromISO, cursor, 1);
  return { backfilled, cursor, remaining: more.length };
}

// Phase 3: one owner-keyed recompute per person — every item on a membership board, plus
// anyone with a qualifying check-in who is somehow not on one — minus people a recompute
// already covered since `since` (the runbook runs the sweep first). Owner-id cursor, not a
// Monday page cursor, so the slice survives across nights.
async function enqueueEveryone(deps: CustodianDeps, since: string | null, cursorIn: string): Promise<{ enqueued: number; scanned: number; cursor: string; remaining: number }> {
  const owners = new Map<string, string>();
  for (const board of membershipBoards(deps)) {
    for (const item of await pageBoard(deps, board.boardId, board.currentTermStart)) owners.set(item.id, board.boardId);
  }
  let after = '';
  for (;;) {
    const batch = await deps.volunteers.ownersWithActivity(after, 1000);
    for (const o of batch) if (!owners.has(o.ownerItemId) && o.ownerBoardId !== '') owners.set(o.ownerItemId, o.ownerBoardId);
    if (batch.length < 1000) break;
    after = batch.at(-1)!.ownerItemId;
  }
  const covered = since === null ? new Set<string>() : await deps.recomputes.writtenSince(since);
  const todo = [...owners.keys()].filter((id) => id > cursorIn && !covered.has(id)).sort();
  const slice = todo.slice(0, ENQUEUE_PER_RUN);
  await sendAll(deps, slice.map((id) => ownerMessage(id, owners.get(id)!)));
  return { enqueued: slice.length, scanned: owners.size, cursor: slice.at(-1) ?? cursorIn, remaining: todo.length - slice.length };
}
```

Note `ownersWithActivity` returns owners whose board the loader could not resolve as `''`; those are skipped (they have no People item to write).

- [ ] **Step 4: Run the tests**

Run: `npm test -- src/custodian/ && npm run typecheck`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/custodian/membership.ts src/custodian/membership.test.ts
git commit -m "feat(donation-rollups): membership all=true loads check-ins, backfills term starts, recomputes everyone"
```

---

### Task 12: Provisioning scripts — membership columns and registration webhooks

**Files:**
- Create: `scripts/setup-membership-columns.mjs`
- Modify: `scripts/setup-webhooks.mjs`

**Interfaces:**
- Produces: `MONDAY_API_TOKEN=… node scripts/setup-membership-columns.mjs <peopleBoardId> [<peopleBoardId>…] [--registrations <boardId>]` prints a JSON block with, per People board, the full eight-key `membership` object (existing four found by title, four created), and for the registrations board `{ "hours": "<id>" }`. `setup-webhooks.mjs` also subscribes `create_item`, `change_column_value`, `item_deleted` on every `volunteerBoards` entry.

- [ ] **Step 1: Write the columns script**

`scripts/setup-membership-columns.mjs`, following `setup-owner-columns.mjs` exactly (same token check, same `MondayGraphQL` import and `graphql()` wrapper, same create-by-title-if-missing loop):

```js
#!/usr/bin/env node
// Ensures each People-type board has the eight membership columns the activity rule writes
// (spec 2026-10-09) — the four salesforce-import created (found by title) plus Current Term
// Start, Member Type, Lapse Count and Last Lapsed — and, with --registrations, an Hours column
// on Event Registrations. Prints config-ready blocks for config/<env>.json.
//
// Usage:
//   MONDAY_API_TOKEN=... node scripts/setup-membership-columns.mjs <peopleBoardId> [<peopleBoardId> ...] [--registrations <boardId>]

import { MondayGraphQL } from '../src/monday/graphql.ts';

const token = process.env.MONDAY_API_TOKEN;
if (!token) { console.error('setup-membership-columns: MONDAY_API_TOKEN is required'); process.exit(1); }
const args = process.argv.slice(2);
const regIdx = args.indexOf('--registrations');
const registrationsBoardId = regIdx >= 0 ? args[regIdx + 1] : null;
const boardIds = args.filter((a, i) => /^\d+$/.test(a) && i !== regIdx + 1);
if (boardIds.length === 0 && registrationsBoardId === null) {
  console.error('usage: node scripts/setup-membership-columns.mjs <peopleBoardId> [...] [--registrations <boardId>]');
  process.exit(1);
}

const MEMBERSHIP_FIELDS = {
  status: { title: 'Membership Status' },      // existing — found by title, never created here
  tier: { title: 'Membership Tier' },
  since: { title: 'Member Since' },
  until: { title: 'Member Until' },
  currentTermStart: { title: 'Current Term Start', type: 'date' },
  memberType: { title: 'Member Type', type: 'status', defaults: JSON.stringify({ labels: { 0: 'New', 1: 'Continuing', 2: 'Lapsed renewal' } }) },
  lapseCount: { title: 'Lapse Count', type: 'numbers' },
  lastLapsed: { title: 'Last Lapsed', type: 'date' },
};
const HOURS = { title: 'Hours', type: 'numbers' };

const monday = new MondayGraphQL('https://api.monday.com/v2', token);
async function graphql(query, variables) {
  return monday.request(query, variables, { idempotent: !/^\s*mutation\b/.test(query) });
}
async function boardColumns(boardId) {
  const data = await graphql('query ($ids: [ID!]) { boards(ids: $ids) { name columns { id title type } } }', { ids: [boardId] });
  const board = data.boards?.[0];
  if (!board) throw new Error(`setup-membership-columns: board ${boardId} not found`);
  return { name: board.name, byTitle: new Map(board.columns.map((c) => [c.title, c])) };
}
async function ensure(boardId, name, byTitle, spec) {
  const existing = byTitle.get(spec.title);
  if (existing) return existing.id;
  if (!spec.type) throw new Error(`setup-membership-columns: ${name} (${boardId}) has no "${spec.title}" column — run salesforce-import's column setup first`);
  const created = await graphql(
    `mutation ($board: ID!, $title: String!, $type: ColumnType!, $defaults: JSON) {
       create_column (board_id: $board, title: $title, column_type: $type, defaults: $defaults) { id } }`,
    { board: boardId, title: spec.title, type: spec.type, defaults: spec.defaults });
  console.error(`setup-membership-columns: ${name} (${boardId}): created "${spec.title}" → ${created.create_column.id}`);
  return created.create_column.id;
}

const out = { ownerColumnsByBoard: {}, registrations: null };
for (const boardId of boardIds) {
  const { name, byTitle } = await boardColumns(boardId);
  const membership = {};
  for (const [field, spec] of Object.entries(MEMBERSHIP_FIELDS)) membership[field] = await ensure(boardId, name, byTitle, spec);
  out.ownerColumnsByBoard[boardId] = { membership };
}
if (registrationsBoardId !== null) {
  const { name, byTitle } = await boardColumns(registrationsBoardId);
  out.registrations = { boardId: Number(registrationsBoardId), hours: await ensure(registrationsBoardId, name, byTitle, HOURS) };
}
console.log(JSON.stringify(out, null, 2));
```

- [ ] **Step 2: Extend the webhook script**

In `scripts/setup-webhooks.mjs`, after the `donationBoards` loop and before `console.error('setup-webhooks: done')`:

```js
// Event Registrations boards (membership activity rule, spec 2026-10-09): a check-in, an
// Attendee re-point or a deletion must reach the consumer. Three events, not five — a
// registration is never archived or restored by this Worker's logic.
for (const board of config.donationRollups.volunteerBoards ?? []) {
  const existing = await graphql('query ($id: ID!) { webhooks (board_id: $id) { id event } }', { id: String(board.boardId) });
  const have = new Set((existing.webhooks ?? []).map((w) => w.event));
  for (const event of ['create_item', 'change_column_value', 'item_deleted']) {
    if (have.has(event)) { console.error(`setup-webhooks: registrations board ${board.boardId} already has ${event} — skipping`); continue; }
    const created = await graphql(
      `mutation ($board: ID!, $url: String!, $event: WebhookEventType!) {
         create_webhook (board_id: $board, url: $url, event: $event) { id } }`,
      { board: String(board.boardId), url, event });
    console.error(`setup-webhooks: registrations board ${board.boardId} subscribed ${event} → webhook ${created.create_webhook.id}`);
  }
}
```

- [ ] **Step 3: Syntax-check both scripts without a token**

Run: `node --check scripts/setup-membership-columns.mjs && node --check scripts/setup-webhooks.mjs && node scripts/setup-membership-columns.mjs 2>&1 | head -1`
Expected: both parse; the third prints the `MONDAY_API_TOKEN is required` line and exits 1. Then `node ../scripts/check-log-safety.mjs` from the repo root: no findings.

- [ ] **Step 4: Commit**

```bash
git add scripts/setup-membership-columns.mjs scripts/setup-webhooks.mjs
git commit -m "feat(donation-rollups): provision the membership columns, Hours, and registration webhooks"
```

---

### Task 13: Documentation — README membership section, deploy checklist

**Files:**
- Modify: `README.md` ("Membership renewal write path" section, "Config" bullets, "Not yet done")
- Modify: `../docs/production-deploy-checklist.md` (the `donation-rollups` D1 migrations row)

- [ ] **Step 1: Rewrite the README section**

Replace the whole `## Membership renewal write path (spec …2026-09-15…)` section (from its heading to just before `## Ledger v2 + the custodian`) — including the "Rule change decided 2026-10-09 — not yet implemented" banner — with a section headed `## Membership — the activity rule (spec \`docs/superpowers/specs/2026-10-09-membership-activity-rule-design.md\`)` that states, in this order: the rule in one sentence; the qualifying activities table (gift ≥ $1 of Gift Type Donation and Received, migrated Term Start before `fromISO` regardless of amount, Event Registrations Role = Volunteer + Attended with blank Hours = 1, historical Volunteers Completed shifts ≥ 1 hour); the run model and the eight owner columns with their derivation (copy the "Owner state" table from the spec); per-gift stamps for post-`fromISO` gifts with the labels New / Continuing / Lapsed renewal / Lifetime; the extend-only merge on Since/Until/Tier and outright writes on the other four; "Enabling — order matters" rewritten for migration 0009 (apply before deploying the build that reads it; the block is on in `sandbox.json` once Task 14 lands, `null` otherwise) with the new config block from the spec's "Configuration" section; the webhook subscriptions (`setup-webhooks.mjs` now covers `volunteerBoards`); the `membership` duty — nightly anniversaries, and the post-cutover command:

```
POST /custodian/run/membership?secret=…&all=true[&since=<ISO of the sweep's start>]
```

repeated (or left to the 09:00 UTC cron) until `detail.remaining` is `0`, with the phases `load-volunteers → backfill-terms → enqueue` and what each costs; the known limits (a staff comp that only extends Until does not bridge two runs; migrated terms on the 6,619-term placeholder Opportunity have no Term Start and so do not seed runs — Member Since still comes from the board via min); and a bullet list of what changed from the 2026-09-15 write path (baseline retired, `typeLabels` keys renamed, `termMonths` 13, `minAmountCents`). Delete the `membership_baseline` reset runbook line. Keep the "Expiry-day boundary", "Refunds", "Concurrent gifts" and "Recurring donors" bullets, updating "about a year" to "13 months".

In the `## Config` section, add bullets for `donationRollups.membership.minAmountCents`, `donationRollups.volunteerBoards` (board, the five column ids, `eventBoard`, labels; "every board here needs its own webhook subscription" like `donationBoards`), and `donationRollups.historicalVolunteerBoards` (read once by the duty, no webhook). Under `## Not yet done`, add: "Sync Member Type and Current Term Start to Mailchimp merge fields (`mailchimp-sync`), so a welcome-back Journey can target Lapsed renewal."

- [ ] **Step 2: Deploy checklist**

In `../docs/production-deploy-checklist.md`, find the `donation-rollups` row of the D1 / queues table (the rows near lines 93–97 list each Worker's applied migrations) and change its migrations text to say `0001–0009` must be applied, with 0009 applied **before** deploying the membership-rule build — same ordering rule as 0005/0006. If the row says a specific set is "already applied", leave that and append "; 0009 pending (membership rule)".

- [ ] **Step 3: Check the docs render and nothing stale remains**

Run: `grep -rn "membership_baseline\|baselineStore\|Reacquire\|renewal:\|reacquire:" README.md src config scripts ../docs/production-deploy-checklist.md`
Expected: no hits except the historical note in the README's "what changed" bullet list and the 2026-09-15 spec (untouched).

- [ ] **Step 4: Commit**

```bash
git add README.md ../docs/production-deploy-checklist.md
git commit -m "docs(donation-rollups): document the membership activity rule, duty and post-cutover recompute"
```

---

### Task 14: Sandbox provisioning, real sandbox ids, full verification

**Files:**
- Modify: `config/sandbox.json`
- Test: `config/split.test.ts`, `src/config.test.ts` (shipped-config tests)

This task touches the live **CRM Sandbox v3** Monday workspace (never production). The token is `MONDAY_API_TOKEN` in `monday-migration/.env` (the shared copy beside this repo); if it is not available to you, do Step 4's fallback and say so in the commit.

- [ ] **Step 1: Provision the sandbox columns**

Run from `donation-rollups/`:

```bash
MONDAY_API_TOKEN=… node scripts/setup-membership-columns.mjs 18431577220 18431577228 --registrations 18431577302
```

Expected: four columns created on each People board (or found, on a re-run), Hours created on Event Registrations, and a JSON block printed.

- [ ] **Step 2: Fill `config/sandbox.json`**

Set `donationRollups.membership` to the Task 3 block (`fromISO: "2026-10-01"` — the sandbox's own cutover date, not production's), put the printed eight-key `membership` objects under `ownerColumnsByBoard["18431577220"]` and `["18431577228"]`, and set:

```json
"volunteerBoards": [{
  "boardId": 18431577302,
  "columns": { "attendee": "<Attendee column id>", "event": "<Event column id>", "attendance": "<Attendance column id>", "role": "<Role column id>", "hours": "<printed Hours id>" },
  "eventBoard": { "boardId": 18431577282, "columns": { "start": "<Start column id>" } },
  "volunteerRoleLabels": ["Volunteer"],
  "countedAttendanceLabels": ["Attended"]
}],
"historicalVolunteerBoards": [{
  "boardId": 18431577321,
  "columns": { "volunteer": "<Volunteer column id>", "date": "<Date column id>", "hours": "<Hours column id>", "status": "<Status column id>" },
  "countedStatusLabels": ["Completed"]
}]
```

Read the column ids by title with one query per board (same `boards(ids:) { columns { id title type } }` the scripts use; `people-reclassification/config/sandbox.json` names the titles: Attendee, Event, Attendance, Source on 18431577302; Start on 18431577282; Volunteer, Date on 18431577321 — plus Role on registrations and Hours, Status on Volunteers, from `monday-migration/docs/22` §3.9–3.10).

- [ ] **Step 3: Run everything**

Run: `npm test && npm run typecheck`
Expected: all green, including `config/split.test.ts` (no sandbox id in `svbc.json`; both configs validate) and the `config.test.ts` shipped-config tests.

- [ ] **Step 4: Fallback if the sandbox cannot be reached**

Leave `sandbox.json` as Task 3 left it (`membership: null`, empty arrays, no owner `membership` blocks), make sure `npm test && npm run typecheck` are green, and record in the commit message that the sandbox ids are still to be filled by running Step 1–2.

- [ ] **Step 5: Sandbox smoke test (only if Step 1 ran)**

Deploy with `npm run deploy:sandbox` after `CI=1 wrangler d1 migrations apply svbc-donation-rollups-sandbox --remote --env sandbox`, subscribe the registration webhook with `MONDAY_API_TOKEN=… WEBHOOK_SECRET=… node scripts/setup-webhooks.mjs --worker-url <sandbox worker url> --config config/sandbox.json`, then on the sandbox boards: set one registration's Attendance to Attended with Role = Volunteer for a person with no gifts → within a minute their People item shows Membership Status Active, Member Since = Current Term Start = the event's date, Member Until 13 months on, Member Type New. Then `POST /custodian/run/membership?secret=…&all=true` and read `/custodian/status` until `remaining` is 0. Note the counts in the commit message.

- [ ] **Step 6: Commit**

```bash
git add config/sandbox.json
git commit -m "chore(donation-rollups): sandbox v3 ids for the membership activity rule"
```

---

## Self-review notes

- Spec coverage: activity sources (Tasks 4, 5, 11), run model and eight columns (5), per-gift stamps (5, 7), extend-only merge (5, 7), baseline retired (7), Event Registrations webhook (8, 9, 12), `volunteer_activity` + `term_start` + pending `kind` (1, 2), nightly duty and `all=true` phases with `since` (10, 11), config block (3, 14), scripts (12), README and checklist (13). Not in this plan, by the spec's own non-goals: `mailchimp-sync` merge fields, a per-lapse log, relabelling the free-text Membership Type on migrated gifts.
- Type consistency: `BoardMembership` (Task 5) is what `getOwnerMembership` (Task 6) returns and `membershipColumnValues` (5) and `planMembershipWrites` (7) consume; `RegistrationRecord` (6) satisfies `RegistrationFacts` (4) structurally, as `HistoricalShiftRecord` satisfies `HistoricalShiftFacts`; `MembershipDetail` (10) is what `runDuty` (10) reads back from `lastRuns` and `runAll` (11) mutates; the owner-keyed message shape `{ donationItemId: 'custodian:membership', donationBoardId: '', ownerItemId, ownerBoardId }` (10, 11) is handled by the existing owner-keyed branch in `processOne` (7).
- Review Focus pins: 1 → Task 4 (`does not qualify without an Event Start`) and Task 8 (`an undated Event…`); 2 → Task 4 (`parseHours` cases); 3 → Task 8 (`Attendee re-point…`); 4 → Task 5 (`same-day gift and check-in…`); 5 → Task 5 (`memberTypeFor` anniversary case).
