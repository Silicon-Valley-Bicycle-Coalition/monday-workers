# Membership Renewal Write Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After Salesforce retires, every Received `Donation`-type gift on the Donations board
creates or extends its donor's membership on the People boards (Membership Status / Tier /
Member Since / Member Until) and stamps Term Start / Term End / Membership Type on the gift,
exactly as Salesforce's `Create_members` flow did, with no staff edit.

**Architecture:** No new Worker. `donation-rollups`' existing webhook → D1 → Queue → consumer
recompute gains one step: a pure fold over the owner's eligible post-cutover gifts, seeded from a
per-owner baseline captured once into a new D1 table, merged extend-only with the board's
current values, and written in the same owner column call the rollups already use. Eligible
gifts get their term columns written back with compare-before-write guards so the resulting
webhook loop stops after one idle pass. `funraise-sync` only gains a Gift Type stamp so its
gifts qualify. Everything is gated on one optional config block (`donationRollups.membership`,
`null` = feature off) so the Worker deploys unchanged until the block is filled in.

**Tech Stack:** Hono + TypeScript strict, Cloudflare D1 (migrations in `migrations/`), Cloudflare
Queues, Vitest with `@cloudflare/vitest-plugin` (real D1 in tests, `env.DB` from
`cloudflare:test`; migrations auto-applied by `test/apply-migrations.ts`), Monday.com GraphQL API
(`API-Version: 2026-01`). Commands run from `donation-rollups/` or `funraise-sync/`:
`npm test`, `npm run typecheck`.

**Spec:** [`docs/superpowers/specs/2026-09-15-membership-renewal-write-path-design.md`](../specs/2026-09-15-membership-renewal-write-path-design.md) — read "The rule, in Monday terms", "Baseline", "Merge with the board", and "Writes and idempotency" before starting.

## Global Constraints

- Gift eligibility (spec "The rule"): Status text equals `receivedStatusLabel` exactly; Gift Type
  is in `membership.eligibleGiftTypes` (default `["Donation"]`); gift date ≥ `membership.fromISO`;
  owner board has `ownerColumns.membership`; owner is not already Lifetime when the gift is folded.
- Term End = Term Start + `membership.termMonths` (default 12); **Feb 29 rolls to Mar 1**.
- Lifetime when `amountCents >= membership.lifetimeThresholdCents` (default `100000`): gift
  Membership Type `Lifetime`, Term End **blank**, owner Tier Lifetime, owner Member Until **blank**.
- Membership Type per gift: `New` if the owner has no Member Since before this gift, `Reacquire` if
  the owner's Until before this gift is earlier than the gift date, else `Renewal`.
- Owner merge is **extend-only**: Since = min, Until = max (blank if Lifetime), Tier never
  downgrades, Status = Active if Lifetime or Until ≥ today (UTC), else Lapsed. Owners with no
  membership anywhere (baseline, board, gifts) are left untouched.
- Baseline is captured **once** per owner, from the board, before this feature's first write to
  that owner; never updated by the Worker.
- Every membership write — owner columns and gift term columns — is written **only when the value
  differs** from what the board holds. Owner write precedes gift writes.
- Column value shapes follow the existing consumer: dates `{ date: "YYYY-MM-DD" }` or `null`
  to clear, status `{ label: "<label>" }`, text columns a plain string (`''` to clear).
- Gift-type labels, status labels, tier labels and type labels are **config**, never literals in
  code (`membership.statusLabels`, `tierLabels`, `typeLabels`).
- When the `membership` block is present, every `donationBoards[]` entry must configure
  `giftType`, `termStart`, `termEnd`, `membershipType`, and at least one `ownerColumnsByBoard`
  entry must have `membership`.
- No new Worker, queue, webhook, or bootstrap script. Sandbox ids only in `config/svbc.json`
  (People `18428131737`, People (Historical) `18428131744`, Donations `18428131791`).
- Conventional commits; each task ends in a commit.

## File structure

`donation-rollups/`

- `migrations/0005_membership_baseline.sql` — create: the `membership_baseline` table.
- `src/types.ts` — modify: `MembershipConfig`, `OwnerMembershipColumns`, `OwnerColumns.membership?`,
  term column ids on `DonationBoardConfig.columns`, `donationRollups.membership: MembershipConfig | null`.
- `src/config.ts` — modify: validate the block and the cross-requirements above.
- `src/config.test.ts` — create: validation tests (none exist today).
- `src/membership/derive.ts` — create: the pure rule (`addMonths`, `isEligibleGift`,
  `deriveMembership`, `mergeWithBoard`, `statusFor`, `membershipColumnValues`, `termColumnValues`).
- `src/membership/derive.test.ts` — create.
- `src/db/membershipBaseline.ts` — create: `MembershipBaselineStore` + D1 impl.
- `src/db/membershipBaseline.test.ts` — create (real D1).
- `src/monday/client.ts` — modify: `DonationRecord` term fields, `getDonationsByIds` reads them,
  new `getOwnerMembership`.
- `src/monday/client.test.ts` — modify.
- `src/consumer/processBatch.ts` — modify: the membership step.
- `src/consumer/processBatch.test.ts` — modify.
- `src/index.ts` — modify: wire `baselineStore`.
- `config/svbc.json` — modify: sandbox ids + `membership` block.
- `README.md` — modify: "Membership" section + baseline reset runbook line.

`funraise-sync/`

- `src/types.ts`, `src/config.ts`, `src/config.test.ts`, `src/consumer/processBatch.ts`,
  `src/consumer/processBatch.test.ts`, `config/svbc.json`, `README.md` — modify: Gift Type stamp.

---

## Task 1: Migration, types, config validation

**Files:**
- Create: `donation-rollups/migrations/0005_membership_baseline.sql`
- Modify: `donation-rollups/src/types.ts`
- Modify: `donation-rollups/src/config.ts`
- Create: `donation-rollups/src/config.test.ts`

**Interfaces:**
- Produces (types.ts):

```ts
export interface MembershipConfig {
  fromISO: string;                 // 'YYYY-MM-DD'; gifts before it are migrated history
  eligibleGiftTypes: string[];     // Gift Type text values that create/extend a term
  termMonths: number;              // 12
  lifetimeThresholdCents: number;  // 100000
  statusLabels: { active: string; lapsed: string };
  tierLabels: { member: string; lifetime: string };
  typeLabels: { new: string; renewal: string; reacquire: string; lifetime: string };
}
export interface OwnerMembershipColumns { status: string; tier: string; since: string; until: string }
// OwnerColumns gains:            membership?: OwnerMembershipColumns
// DonationBoardConfig.columns gains: termStart?: string | null; termEnd?: string | null; membershipType?: string | null
// DonationRollupsConfig.donationRollups gains: membership: MembershipConfig | null
```

- [ ] **Step 1: Write the migration**

`donation-rollups/migrations/0005_membership_baseline.sql`:

```sql
-- Membership renewal write path (docs/superpowers/specs/2026-09-15-membership-renewal-write-path-design.md,
-- "Baseline"). One row per owner: the membership state the board held BEFORE this Worker's
-- first membership write to that owner — captured lazily on that first recompute, never
-- updated afterward. Membership Type (New / Renewal / Reacquire) for each post-cutover gift is
-- derived from this row plus earlier gifts, so re-running a recompute yields identical types.
-- To re-seed an owner after a staff correction to migrated history: DELETE the row; the next
-- recompute recaptures it from the board.
CREATE TABLE membership_baseline (
  owner_item_id TEXT PRIMARY KEY,
  owner_board_id TEXT NOT NULL,
  since TEXT,            -- ISO date or NULL
  until TEXT,            -- ISO date or NULL (NULL for Lifetime and for never-members)
  tier TEXT,             -- 'member' | 'lifetime' | NULL — canonical keys, not board labels
  captured_at TEXT NOT NULL
);
```

- [ ] **Step 2: Extend the types**

In `donation-rollups/src/types.ts`, change `DonationBoardConfig.columns` to:

```ts
  columns: {
    donorLink: string;
    amount: string;
    date: string;
    fiscalYear: string | null; // null where the column doesn't exist yet — derived from date instead
    status: string;
    // Optional: refreshes the gifts ledger's gift_type from Monday when configured.
    giftType?: string | null;
    // Membership term columns on the gift (spec "Writes and idempotency"). Required, and
    // giftType required, whenever donationRollups.membership is configured.
    termStart?: string | null;
    termEnd?: string | null;
    membershipType?: string | null;
  };
```

Add after `OwnerColumns`:

```ts
// The four membership columns on a People-type owner board. Absent on Organizations: an
// owner whose board has no entry never gets a membership write (spec "The rule").
export interface OwnerMembershipColumns {
  status: string;
  tier: string;
  since: string;
  until: string;
}

// donationRollups.membership — the Create_members rule, in Monday terms. null = feature off.
export interface MembershipConfig {
  fromISO: string;
  eligibleGiftTypes: string[];
  termMonths: number;
  lifetimeThresholdCents: number;
  statusLabels: { active: string; lapsed: string };
  tierLabels: { member: string; lifetime: string };
  typeLabels: { new: string; renewal: string; reacquire: string; lifetime: string };
}
```

Add `membership?: OwnerMembershipColumns;` as the last member of `OwnerColumns`, and
`membership: MembershipConfig | null;` as the last member of `DonationRollupsConfig.donationRollups`.

- [ ] **Step 3: Write the failing config tests**

`donation-rollups/src/config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateConfig } from './config';

const ownerColumns = {
  giftLedgerJson: 'glj', lifetimeGiving: 'lg', giftCount: 'gc', firstGift: 'fg',
  thisYearAmount: 'tya', thisYearCount: 'tyc', lastYearAmount: 'lya', lastYearCount: 'lyc',
  largestGift: 'lag', smallestGift: 'smg', averageGift: 'avg', lastGiftDate: 'lgd', lastGiftAmount: 'lga',
};
const membershipColumns = { status: 'ms', tier: 'mt', since: 'msince', until: 'muntil' };
const membership = {
  fromISO: '2026-10-01', eligibleGiftTypes: ['Donation'], termMonths: 12, lifetimeThresholdCents: 100000,
  statusLabels: { active: 'Active', lapsed: 'Lapsed' },
  tierLabels: { member: 'Member', lifetime: 'Lifetime' },
  typeLabels: { new: 'New', renewal: 'Renewal', reacquire: 'Reacquire', lifetime: 'Lifetime' },
};
const donationBoard = {
  boardId: 1,
  columns: { donorLink: 'dl', amount: 'am', date: 'dt', status: 'st', fiscalYear: null,
    giftType: 'gt', termStart: 'ts', termEnd: 'te', membershipType: 'mty' },
};
const base = {
  monday: { apiUrl: 'https://api.monday.com/v2', accountUrl: 'https://acme.monday.com' },
  custodian: { activeFiscalYears: 2, workspaceId: 1, capacityAlertPct: 80, alertItemId: null,
    annualSummaryBoardId: null, annualSummaryColumns: null },
  donationRollups: {
    receivedStatusLabel: 'Received',
    donationBoards: [donationBoard],
    ownerColumnsByBoard: { '2': { ...ownerColumns, membership: membershipColumns }, '3': ownerColumns },
    membership,
  },
};

describe('validateConfig — membership block', () => {
  it('accepts a full membership config and passes it through', () => {
    const cfg = validateConfig(base);
    expect(cfg.donationRollups.membership).toEqual(membership);
    expect(cfg.donationRollups.ownerColumnsByBoard['2']!.membership).toEqual(membershipColumns);
    expect(cfg.donationRollups.ownerColumnsByBoard['3']!.membership).toBeUndefined();
    expect(cfg.donationRollups.donationBoards[0]!.columns.termStart).toBe('ts');
  });

  it('treats a missing or null membership block as off', () => {
    const { membership: _m, ...rest } = base.donationRollups;
    expect(validateConfig({ ...base, donationRollups: rest }).donationRollups.membership).toBeNull();
    expect(validateConfig({ ...base, donationRollups: { ...rest, membership: null } }).donationRollups.membership).toBeNull();
  });

  it('with membership off, term columns and owner membership columns are still optional', () => {
    const board = { boardId: 1, columns: { donorLink: 'dl', amount: 'am', date: 'dt', status: 'st', fiscalYear: null } };
    const cfg = validateConfig({ ...base, donationRollups: { ...base.donationRollups, membership: null, donationBoards: [board] } });
    expect(cfg.donationRollups.donationBoards[0]!.columns.termStart).toBeNull();
  });

  it.each([
    ['fromISO', 'not-a-date', /fromISO/],
    ['eligibleGiftTypes', [], /eligibleGiftTypes/],
    ['termMonths', 0, /termMonths/],
    ['lifetimeThresholdCents', -1, /lifetimeThresholdCents/],
    ['statusLabels', { active: 'Active' }, /statusLabels\.lapsed/],
    ['tierLabels', { member: '', lifetime: 'Lifetime' }, /tierLabels\.member/],
    ['typeLabels', { new: 'New', renewal: 'Renewal', reacquire: 'Reacquire' }, /typeLabels\.lifetime/],
  ])('rejects a bad membership.%s', (key, value, pattern) => {
    const bad = { ...base, donationRollups: { ...base.donationRollups, membership: { ...membership, [key]: value } } };
    expect(() => validateConfig(bad)).toThrow(pattern);
  });

  it.each(['giftType', 'termStart', 'termEnd', 'membershipType'])(
    'requires donation board column %s when membership is on', (key) => {
      const { [key]: _drop, ...columns } = donationBoard.columns as Record<string, unknown>;
      const bad = { ...base, donationRollups: { ...base.donationRollups, donationBoards: [{ boardId: 1, columns }] } };
      expect(() => validateConfig(bad)).toThrow(new RegExp(`columns\\.${key}`));
    });

  it('requires at least one owner board with membership columns when membership is on', () => {
    const bad = { ...base, donationRollups: { ...base.donationRollups, ownerColumnsByBoard: { '3': ownerColumns } } };
    expect(() => validateConfig(bad)).toThrow(/at least one ownerColumnsByBoard entry must have "membership"/);
  });

  it('rejects a partial owner membership block', () => {
    const bad = { ...base, donationRollups: { ...base.donationRollups,
      ownerColumnsByBoard: { '2': { ...ownerColumns, membership: { status: 'ms', tier: 'mt', since: 'msince' } } } } };
    expect(() => validateConfig(bad)).toThrow(/membership\.until/);
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd donation-rollups && npx vitest run src/config.test.ts`
Expected: FAIL — `membership` is not passed through (`toEqual` fails) and no rejection messages exist yet.

- [ ] **Step 5: Implement the validation**

In `donation-rollups/src/config.ts`:

Add imports: `import type { DonationRollupsConfig, DonationBoardConfig, OwnerColumns, CustodianConfig, MembershipConfig, OwnerMembershipColumns } from './types';`

Add a constant after `REQUIRED_OWNER_COLUMNS`:

```ts
const OPTIONAL_TERM_COLUMNS = ['giftType', 'termStart', 'termEnd', 'membershipType'] as const;
const MEMBERSHIP_COLUMNS = ['status', 'tier', 'since', 'until'] as const;
```

In `validateDonationBoard`, replace the `giftType` check and the return with:

```ts
  for (const key of OPTIONAL_TERM_COLUMNS) {
    if (columns[key] !== undefined && columns[key] !== null
      && (typeof columns[key] !== 'string' || columns[key] === '')) {
      throw new Error(`config: donationRollups.donationBoards[${index}].columns.${key} must be a column id string, null, or omitted`);
    }
  }
  return {
    boardId: b.boardId,
    columns: {
      donorLink: columns.donorLink as string, amount: columns.amount as string,
      date: columns.date as string, status: columns.status as string,
      fiscalYear: columns.fiscalYear as string | null,
      giftType: (columns.giftType ?? null) as string | null,
      termStart: (columns.termStart ?? null) as string | null,
      termEnd: (columns.termEnd ?? null) as string | null,
      membershipType: (columns.membershipType ?? null) as string | null,
    },
  };
```

In `validateOwnerColumns`, replace the return with:

```ts
  let membership: OwnerMembershipColumns | undefined;
  if (columns.membership !== undefined && columns.membership !== null) {
    if (typeof columns.membership !== 'object') {
      throw new Error(`config: donationRollups.ownerColumnsByBoard["${boardId}"].membership must be an object or omitted`);
    }
    const m = columns.membership as Record<string, unknown>;
    for (const key of MEMBERSHIP_COLUMNS) {
      if (typeof m[key] !== 'string' || m[key] === '') {
        throw new Error(`config: donationRollups.ownerColumnsByBoard["${boardId}"].membership.${key} must be a Monday column id string`);
      }
    }
    membership = { status: m.status as string, tier: m.tier as string, since: m.since as string, until: m.until as string };
  }
  const { membership: _raw, ...rest } = columns;
  return { ...(rest as unknown as OwnerColumns), ...(membership ? { membership } : {}) };
```

Add a new function:

```ts
function validateMembership(raw: unknown): MembershipConfig | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object') throw new Error('config: "donationRollups.membership" must be an object or null');
  const m = raw as Record<string, unknown>;
  if (typeof m.fromISO !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(m.fromISO)) {
    throw new Error('config: "donationRollups.membership.fromISO" must be a YYYY-MM-DD date');
  }
  if (!Array.isArray(m.eligibleGiftTypes) || m.eligibleGiftTypes.length === 0
    || m.eligibleGiftTypes.some((t) => typeof t !== 'string' || t === '')) {
    throw new Error('config: "donationRollups.membership.eligibleGiftTypes" must be a non-empty array of Gift Type labels');
  }
  if (typeof m.termMonths !== 'number' || !Number.isInteger(m.termMonths) || m.termMonths < 1) {
    throw new Error('config: "donationRollups.membership.termMonths" must be a positive integer');
  }
  if (typeof m.lifetimeThresholdCents !== 'number' || !Number.isInteger(m.lifetimeThresholdCents) || m.lifetimeThresholdCents < 0) {
    throw new Error('config: "donationRollups.membership.lifetimeThresholdCents" must be a non-negative integer');
  }
  const labels = (group: string, keys: readonly string[]): Record<string, string> => {
    const g = m[group];
    if (typeof g !== 'object' || g === null) throw new Error(`config: "donationRollups.membership.${group}" must be an object`);
    const out: Record<string, string> = {};
    for (const key of keys) {
      const v = (g as Record<string, unknown>)[key];
      if (typeof v !== 'string' || v === '') throw new Error(`config: "donationRollups.membership.${group}.${key}" must be a non-empty label`);
      out[key] = v;
    }
    return out;
  };
  return {
    fromISO: m.fromISO,
    eligibleGiftTypes: m.eligibleGiftTypes as string[],
    termMonths: m.termMonths,
    lifetimeThresholdCents: m.lifetimeThresholdCents,
    statusLabels: labels('statusLabels', ['active', 'lapsed']) as MembershipConfig['statusLabels'],
    tierLabels: labels('tierLabels', ['member', 'lifetime']) as MembershipConfig['tierLabels'],
    typeLabels: labels('typeLabels', ['new', 'renewal', 'reacquire', 'lifetime']) as MembershipConfig['typeLabels'],
  };
}
```

In `validateConfig`, after `ownerColumnsByBoard` is built and before the `return`:

```ts
  const membership = validateMembership(dr.membership);
  if (membership !== null) {
    donationBoards.forEach((b, i) => {
      for (const key of OPTIONAL_TERM_COLUMNS) {
        if (!b.columns[key]) {
          throw new Error(`config: donationRollups.donationBoards[${i}].columns.${key} is required when donationRollups.membership is configured`);
        }
      }
    });
    if (!Object.values(ownerColumnsByBoard).some((o) => o.membership !== undefined)) {
      throw new Error('config: at least one ownerColumnsByBoard entry must have "membership" columns when donationRollups.membership is configured');
    }
  }
```

and change the return to include it:

```ts
    donationRollups: { donationBoards, receivedStatusLabel: dr.receivedStatusLabel, ownerColumnsByBoard, membership },
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `cd donation-rollups && npx vitest run src/config.test.ts && npm run typecheck`
Expected: config tests PASS. Typecheck will report `processBatch.test.ts` config literals missing
`membership` — fix by adding `membership: null,` to the `donationRollups` object in
`src/consumer/processBatch.test.ts` and in any custodian test config literal that builds a
`DonationRollupsConfig` (`grep -n "receivedStatusLabel" src/**/*.test.ts` lists them). Re-run
until typecheck is clean and `npm test` is green.

- [ ] **Step 7: Commit**

```bash
git add donation-rollups/migrations/0005_membership_baseline.sql donation-rollups/src/types.ts donation-rollups/src/config.ts donation-rollups/src/config.test.ts donation-rollups/src
git commit -m "feat(donation-rollups): membership config block, term column ids, baseline migration"
```

---

## Task 2: The pure rule — `membership/derive.ts`

**Files:**
- Create: `donation-rollups/src/membership/derive.ts`
- Create: `donation-rollups/src/membership/derive.test.ts`

**Interfaces:**
- Consumes: `MembershipConfig`, `OwnerMembershipColumns` from Task 1.
- Produces:

```ts
export type Tier = 'member' | 'lifetime';
export type TermType = 'new' | 'renewal' | 'reacquire' | 'lifetime';
export interface MembershipState { since: string | null; until: string | null; tier: Tier | null }
export interface MembershipGift { id: string; dateISO: string; amountCents: number; status: string; giftType: string | null }
export interface GiftTerm { start: string; end: string | null; type: TermType }
export interface DerivedMembership { state: MembershipState; terms: Map<string, GiftTerm> }
export interface BoardMembership extends MembershipState { statusLabel: string | null }  // raw label as read

export const EMPTY_STATE: MembershipState;
export function addMonths(iso: string, months: number): string;
export function isEligibleGift(g: MembershipGift, config: MembershipConfig, receivedStatusLabel: string): boolean;
export function deriveMembership(baseline: MembershipState, gifts: MembershipGift[], config: MembershipConfig, receivedStatusLabel: string): DerivedMembership;
export function mergeWithBoard(derived: MembershipState, board: MembershipState): MembershipState;
export function statusFor(state: MembershipState, todayISO: string): 'active' | 'lapsed' | null;
export function tierFromLabel(label: string | null, config: MembershipConfig): Tier | null;
export function membershipColumnValues(merged: MembershipState, status: 'active' | 'lapsed' | null, board: BoardMembership, columns: OwnerMembershipColumns, config: MembershipConfig): Record<string, unknown>;
export function termColumnValues(term: GiftTerm | undefined, current: { termStart: string | null; termEnd: string | null; membershipType: string | null }, columns: { termStart: string; termEnd: string; membershipType: string }, config: MembershipConfig): Record<string, unknown>;
```

- [ ] **Step 1: Write the failing tests**

`donation-rollups/src/membership/derive.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  addMonths, isEligibleGift, deriveMembership, mergeWithBoard, statusFor, tierFromLabel,
  membershipColumnValues, termColumnValues, EMPTY_STATE,
  type MembershipGift, type MembershipState,
} from './derive';
import type { MembershipConfig } from '../types';

const config: MembershipConfig = {
  fromISO: '2026-10-01', eligibleGiftTypes: ['Donation'], termMonths: 12, lifetimeThresholdCents: 100000,
  statusLabels: { active: 'Active', lapsed: 'Lapsed' },
  tierLabels: { member: 'Member', lifetime: 'Lifetime' },
  typeLabels: { new: 'New', renewal: 'Renewal', reacquire: 'Reacquire', lifetime: 'Lifetime' },
};
const RECEIVED = 'Received';
const gift = (over: Partial<MembershipGift>): MembershipGift => ({
  id: 'g1', dateISO: '2026-11-05', amountCents: 5000, status: RECEIVED, giftType: 'Donation', ...over,
});
const member = (since: string, until: string | null, tier: MembershipState['tier'] = 'member'): MembershipState =>
  ({ since, until, tier });

describe('addMonths', () => {
  it('adds a year to an ordinary date', () => expect(addMonths('2026-11-05', 12)).toBe('2027-11-05'));
  it('rolls Feb 29 to Mar 1 like the Salesforce flow', () => expect(addMonths('2028-02-29', 12)).toBe('2029-03-01'));
  it('keeps Feb 29 when the target year is a leap year', () => expect(addMonths('2024-02-29', 48)).toBe('2028-02-29'));
  it('clamps other month-end overflow to the 1st of the next month', () => expect(addMonths('2026-01-31', 1)).toBe('2026-03-01'));
});

describe('isEligibleGift', () => {
  it('accepts a Received Donation on/after fromISO', () => {
    expect(isEligibleGift(gift({ dateISO: '2026-10-01' }), config, RECEIVED)).toBe(true);
  });
  it.each([
    ['status', gift({ status: 'Received (Historical)' })],
    ['gift type', gift({ giftType: 'Matching Donation' })],
    ['null gift type', gift({ giftType: null })],
    ['date before cutover', gift({ dateISO: '2026-09-30' })],
    ['empty date', gift({ dateISO: '' })],
  ])('rejects on %s', (_label, g) => expect(isEligibleGift(g, config, RECEIVED)).toBe(false));
});

describe('deriveMembership', () => {
  it('a never-member gets a New one-year term and a Member tier', () => {
    const d = deriveMembership(EMPTY_STATE, [gift({})], config, RECEIVED);
    expect(d.state).toEqual({ since: '2026-11-05', until: '2027-11-05', tier: 'member' });
    expect(d.terms.get('g1')).toEqual({ start: '2026-11-05', end: '2027-11-05', type: 'new' });
  });

  it('a migrated Active member renewing early gets Renewal and Until extends from the gift date', () => {
    const d = deriveMembership(member('2017-05-18', '2027-04-11'), [gift({})], config, RECEIVED);
    expect(d.state).toEqual({ since: '2017-05-18', until: '2027-11-05', tier: 'member' });
    expect(d.terms.get('g1')!.type).toBe('renewal');
  });

  it('a Lapsed member (Until before the gift) gets Reacquire', () => {
    const d = deriveMembership(member('2015-01-01', '2026-03-01'), [gift({})], config, RECEIVED);
    expect(d.terms.get('g1')!.type).toBe('reacquire');
    expect(d.state.until).toBe('2027-11-05');
  });

  it('Until on the gift date itself still counts as Renewal (not yet lapsed)', () => {
    const d = deriveMembership(member('2015-01-01', '2026-11-05'), [gift({})], config, RECEIVED);
    expect(d.terms.get('g1')!.type).toBe('renewal');
  });

  it('a gift at exactly the lifetime threshold makes a Lifetime term with blank end and blank Until', () => {
    const d = deriveMembership(member('2015-01-01', '2026-03-01'), [gift({ amountCents: 100000 })], config, RECEIVED);
    expect(d.terms.get('g1')).toEqual({ start: '2026-11-05', end: null, type: 'lifetime' });
    expect(d.state).toEqual({ since: '2015-01-01', until: null, tier: 'lifetime' });
  });

  it('a later gift from a Lifetime owner produces no term and changes nothing', () => {
    const d = deriveMembership(member('2015-01-01', null, 'lifetime'), [gift({})], config, RECEIVED);
    expect(d.terms.size).toBe(0);
    expect(d.state).toEqual({ since: '2015-01-01', until: null, tier: 'lifetime' });
  });

  it('folds in date order regardless of input order, tie-breaking by id', () => {
    const gifts = [
      gift({ id: 'later', dateISO: '2027-12-01' }),
      gift({ id: 'b', dateISO: '2026-11-05' }),
      gift({ id: 'a', dateISO: '2026-11-05' }),
    ];
    const d = deriveMembership(EMPTY_STATE, gifts, config, RECEIVED);
    expect(d.terms.get('a')!.type).toBe('new');
    expect(d.terms.get('b')!.type).toBe('renewal');
    expect(d.terms.get('later')!.type).toBe('reacquire'); // Until was 2027-11-05, before this gift
    expect(d.state.until).toBe('2028-12-01');
  });

  it('ignores ineligible gifts entirely', () => {
    const gifts = [gift({ id: 'failed', status: 'Failed' }), gift({ id: 'old', dateISO: '2020-01-01' }),
      gift({ id: 'match', giftType: 'Matching Donation' })];
    const d = deriveMembership(EMPTY_STATE, gifts, config, RECEIVED);
    expect(d.terms.size).toBe(0);
    expect(d.state).toEqual(EMPTY_STATE);
  });

  it('is idempotent: the same inputs yield the same output', () => {
    const gifts = [gift({ id: 'a', dateISO: '2026-11-05' }), gift({ id: 'b', dateISO: '2027-06-01' })];
    const once = deriveMembership(member('2015-01-01', '2026-03-01'), gifts, config, RECEIVED);
    const twice = deriveMembership(member('2015-01-01', '2026-03-01'), gifts, config, RECEIVED);
    expect(twice).toEqual(once);
  });
});

describe('mergeWithBoard (extend-only)', () => {
  it('takes the earlier Since and the later Until', () => {
    expect(mergeWithBoard(member('2020-01-01', '2027-11-05'), member('2015-01-01', '2028-01-01')))
      .toEqual({ since: '2015-01-01', until: '2028-01-01', tier: 'member' });
  });
  it('Lifetime on either side wins and blanks Until', () => {
    expect(mergeWithBoard(member('2020-01-01', '2027-11-05'), member('2015-01-01', null, 'lifetime')))
      .toEqual({ since: '2015-01-01', until: null, tier: 'lifetime' });
    expect(mergeWithBoard(member('2020-01-01', null, 'lifetime'), member('2015-01-01', '2028-01-01')))
      .toEqual({ since: '2015-01-01', until: null, tier: 'lifetime' });
  });
  it('an empty derived state leaves the board state unchanged', () => {
    expect(mergeWithBoard(EMPTY_STATE, member('2015-01-01', '2026-03-01'))).toEqual(member('2015-01-01', '2026-03-01'));
  });
  it('both empty stays empty', () => expect(mergeWithBoard(EMPTY_STATE, EMPTY_STATE)).toEqual(EMPTY_STATE));
});

describe('statusFor', () => {
  it('Lifetime is always active', () => expect(statusFor(member('2015-01-01', null, 'lifetime'), '2099-01-01')).toBe('active'));
  it('Until today or later is active; earlier is lapsed', () => {
    expect(statusFor(member('2015-01-01', '2026-11-05'), '2026-11-05')).toBe('active');
    expect(statusFor(member('2015-01-01', '2026-11-04'), '2026-11-05')).toBe('lapsed');
  });
  it('a member with no Until and no Lifetime is lapsed; a never-member is null', () => {
    expect(statusFor({ since: '2015-01-01', until: null, tier: 'member' }, '2026-11-05')).toBe('lapsed');
    expect(statusFor(EMPTY_STATE, '2026-11-05')).toBeNull();
  });
});

describe('tierFromLabel', () => {
  it('maps the configured labels and treats any other non-empty label as member', () => {
    expect(tierFromLabel('Lifetime', config)).toBe('lifetime');
    expect(tierFromLabel('Member', config)).toBe('member');
    expect(tierFromLabel('Family', config)).toBe('member');
    expect(tierFromLabel('', config)).toBeNull();
    expect(tierFromLabel(null, config)).toBeNull();
  });
});

describe('membershipColumnValues (changed keys only)', () => {
  const columns = { status: 'ms', tier: 'mt', since: 'msince', until: 'muntil' };
  it('writes every column for a never-member becoming New', () => {
    const board = { since: null, until: null, tier: null, statusLabel: null };
    expect(membershipColumnValues(member('2026-11-05', '2027-11-05'), 'active', board, columns, config)).toEqual({
      ms: { label: 'Active' }, mt: { label: 'Member' }, msince: { date: '2026-11-05' }, muntil: { date: '2027-11-05' },
    });
  });
  it('writes only Until and Status for a lapsed member renewing', () => {
    const board = { since: '2015-01-01', until: '2026-03-01', tier: 'member' as const, statusLabel: 'Lapsed' };
    expect(membershipColumnValues(member('2015-01-01', '2027-11-05'), 'active', board, columns, config)).toEqual({
      ms: { label: 'Active' }, muntil: { date: '2027-11-05' },
    });
  });
  it('writes nothing when the board already matches', () => {
    const board = { since: '2015-01-01', until: '2027-11-05', tier: 'member' as const, statusLabel: 'Active' };
    expect(membershipColumnValues(member('2015-01-01', '2027-11-05'), 'active', board, columns, config)).toEqual({});
  });
  it('clears Until (null) when the owner becomes Lifetime', () => {
    const board = { since: '2015-01-01', until: '2027-11-05', tier: 'member' as const, statusLabel: 'Active' };
    expect(membershipColumnValues(member('2015-01-01', null, 'lifetime'), 'active', board, columns, config)).toEqual({
      mt: { label: 'Lifetime' }, muntil: null,
    });
  });
  it('writes nothing at all for a never-member with no gifts (status null)', () => {
    const board = { since: null, until: null, tier: null, statusLabel: null };
    expect(membershipColumnValues(EMPTY_STATE, null, board, columns, config)).toEqual({});
  });
});

describe('termColumnValues (changed keys only)', () => {
  const columns = { termStart: 'ts', termEnd: 'te', membershipType: 'mty' };
  const blank = { termStart: null, termEnd: null, membershipType: null };
  it('writes all three on a fresh gift', () => {
    expect(termColumnValues({ start: '2026-11-05', end: '2027-11-05', type: 'renewal' }, blank, columns, config))
      .toEqual({ ts: { date: '2026-11-05' }, te: { date: '2027-11-05' }, mty: 'Renewal' });
  });
  it('writes nothing when the item already matches', () => {
    const current = { termStart: '2026-11-05', termEnd: '2027-11-05', membershipType: 'Renewal' };
    expect(termColumnValues({ start: '2026-11-05', end: '2027-11-05', type: 'renewal' }, current, columns, config)).toEqual({});
  });
  it('a Lifetime term writes a blank end', () => {
    expect(termColumnValues({ start: '2026-11-05', end: null, type: 'lifetime' }, blank, columns, config))
      .toEqual({ ts: { date: '2026-11-05' }, mty: 'Lifetime' });
  });
  it('an ineligible gift (no term) is never touched, even if it carries stale values', () => {
    const current = { termStart: '2020-01-01', termEnd: '2021-01-01', membershipType: 'Renewal' };
    expect(termColumnValues(undefined, current, columns, config)).toEqual({});
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd donation-rollups && npx vitest run src/membership/derive.test.ts`
Expected: FAIL — module `./derive` not found.

- [ ] **Step 3: Implement `derive.ts`**

`donation-rollups/src/membership/derive.ts`:

```ts
// The Salesforce Create_members flow, in Monday terms — spec §"The rule, in Monday terms".
// Everything here is pure: the consumer feeds it the baseline, the owner's gifts, and today's
// date, and writes back only what changed. Keep it that way; the idempotency argument in the
// spec depends on this module having no I/O and no clock.
import type { MembershipConfig, OwnerMembershipColumns } from '../types';

export type Tier = 'member' | 'lifetime';
export type TermType = 'new' | 'renewal' | 'reacquire' | 'lifetime';

export interface MembershipState {
  since: string | null; // ISO date
  until: string | null; // ISO date; null for Lifetime and for never-members
  tier: Tier | null;
}

export interface MembershipGift {
  id: string;
  dateISO: string; // '' when unknown
  amountCents: number;
  status: string;
  giftType: string | null;
}

export interface GiftTerm {
  start: string;
  end: string | null; // null for Lifetime
  type: TermType;
}

export interface DerivedMembership {
  state: MembershipState;
  terms: Map<string, GiftTerm>; // gift item id -> its term; absent = no term for this gift
}

// What the owner board currently holds, as read — statusLabel is the raw label text so the
// changed-only write can compare it without re-deriving.
export interface BoardMembership extends MembershipState {
  statusLabel: string | null;
}

export const EMPTY_STATE: MembershipState = { since: null, until: null, tier: null };

const pad = (n: number): string => String(n).padStart(2, '0');

// Calendar month arithmetic on a plain ISO date. Day overflow (Feb 29 → a non-leap year,
// Jan 31 + 1 month) rolls forward into the next month, which for the one case Salesforce's
// OneYearFromClose formula handles (Feb 29) yields the same Mar 1.
export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number) as [number, number, number];
  const total = (m - 1) + months;
  const year = y + Math.floor(total / 12);
  const month = (total % 12) + 1;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (d <= daysInMonth) return `${year}-${pad(month)}-${pad(d)}`;
  const next = new Date(Date.UTC(year, month, 1)); // month is 1-based here, so this is the 1st of the following month
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-01`;
}

export function isEligibleGift(g: MembershipGift, config: MembershipConfig, receivedStatusLabel: string): boolean {
  return g.status === receivedStatusLabel
    && g.giftType !== null && config.eligibleGiftTypes.includes(g.giftType)
    && /^\d{4}-\d{2}-\d{2}/.test(g.dateISO) && g.dateISO.slice(0, 10) >= config.fromISO;
}

const minDate = (a: string | null, b: string | null): string | null =>
  a === null ? b : b === null ? a : (a < b ? a : b);
const maxDate = (a: string | null, b: string | null): string | null =>
  a === null ? b : b === null ? a : (a > b ? a : b);

export function deriveMembership(
  baseline: MembershipState, gifts: MembershipGift[], config: MembershipConfig, receivedStatusLabel: string,
): DerivedMembership {
  const eligible = gifts
    .filter((g) => isEligibleGift(g, config, receivedStatusLabel))
    .sort((a, b) => (a.dateISO < b.dateISO ? -1 : a.dateISO > b.dateISO ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  let state: MembershipState = { ...baseline };
  const terms = new Map<string, GiftTerm>();
  for (const g of eligible) {
    if (state.tier === 'lifetime') continue; // the flow's "Already a life member" exit
    const start = g.dateISO.slice(0, 10);
    if (g.amountCents >= config.lifetimeThresholdCents) {
      terms.set(g.id, { start, end: null, type: 'lifetime' });
      state = { since: minDate(state.since, start), until: null, tier: 'lifetime' };
      continue;
    }
    const end = addMonths(start, config.termMonths);
    const type: TermType = state.since === null ? 'new'
      : (state.until !== null && state.until < start) ? 'reacquire'
      : 'renewal';
    terms.set(g.id, { start, end, type });
    state = { since: minDate(state.since, start), until: maxDate(state.until, end), tier: 'member' };
  }
  return { state, terms };
}

// Extend-only (spec §"Merge with the board"): the integration never shortens or downgrades.
export function mergeWithBoard(derived: MembershipState, board: MembershipState): MembershipState {
  const tier: Tier | null = derived.tier === 'lifetime' || board.tier === 'lifetime' ? 'lifetime'
    : derived.tier ?? board.tier;
  return {
    since: minDate(derived.since, board.since),
    until: tier === 'lifetime' ? null : maxDate(derived.until, board.until),
    tier,
  };
}

export function statusFor(state: MembershipState, todayISO: string): 'active' | 'lapsed' | null {
  if (state.tier === null && state.since === null && state.until === null) return null;
  if (state.tier === 'lifetime') return 'active';
  return state.until !== null && state.until >= todayISO ? 'active' : 'lapsed';
}

export function tierFromLabel(label: string | null, config: MembershipConfig): Tier | null {
  if (label === null || label === '') return null;
  return label === config.tierLabels.lifetime ? 'lifetime' : 'member';
}

const dateCol = (iso: string | null): unknown => (iso === null ? null : { date: iso });

export function membershipColumnValues(
  merged: MembershipState, status: 'active' | 'lapsed' | null, board: BoardMembership,
  columns: OwnerMembershipColumns, config: MembershipConfig,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (status === null) return out; // never a member anywhere — leave the blanks alone
  const statusLabel = config.statusLabels[status];
  if (statusLabel !== board.statusLabel) out[columns.status] = { label: statusLabel };
  if (merged.tier !== board.tier && merged.tier !== null) out[columns.tier] = { label: config.tierLabels[merged.tier] };
  if (merged.since !== board.since) out[columns.since] = dateCol(merged.since);
  if (merged.until !== board.until) out[columns.until] = dateCol(merged.until);
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

Run: `cd donation-rollups && npx vitest run src/membership/derive.test.ts`
Expected: PASS. If the `addMonths('2026-01-31', 1)` case fails, check the `Date.UTC(year, month, 0)`
call: `month` there is 1-based, so `Date.UTC(y, m, 0)` is the last day of month `m`. If the Lifetime
"blank end" `termColumnValues` case writes `te: null`, note that `blank.termEnd` is already `null`,
so no key must be emitted — the equality check handles it.

- [ ] **Step 5: Commit**

```bash
git add donation-rollups/src/membership
git commit -m "feat(donation-rollups): pure membership derivation (Create_members rule, extend-only merge)"
```

---

## Task 3: Baseline store (D1)

**Files:**
- Create: `donation-rollups/src/db/membershipBaseline.ts`
- Create: `donation-rollups/src/db/membershipBaseline.test.ts`

**Interfaces:**
- Consumes: `MembershipState` from Task 2; table from Task 1.
- Produces:

```ts
export interface BaselineRow extends MembershipState { ownerItemId: string; ownerBoardId: string; capturedAt: string }
export interface MembershipBaselineStore {
  get(ownerItemId: string): Promise<BaselineRow | null>;
  // Inserts only if absent; returns the row that is now stored (the existing one on conflict).
  captureIfAbsent(row: BaselineRow): Promise<BaselineRow>;
}
export class D1MembershipBaselineStore implements MembershipBaselineStore
```

- [ ] **Step 1: Write the failing tests**

`donation-rollups/src/db/membershipBaseline.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { D1MembershipBaselineStore, type BaselineRow } from './membershipBaseline';

const row = (over: Partial<BaselineRow> = {}): BaselineRow => ({
  ownerItemId: `o-${Math.random().toString(36).slice(2)}`, ownerBoardId: 'b1',
  since: '2015-01-01', until: '2026-03-01', tier: 'member', capturedAt: '2026-10-05T00:00:00Z', ...over,
});

describe('D1MembershipBaselineStore', () => {
  it('get returns null for an unknown owner', async () => {
    expect(await new D1MembershipBaselineStore(env.DB).get('nobody')).toBeNull();
  });

  it('captureIfAbsent inserts and get reads it back, nulls preserved', async () => {
    const store = new D1MembershipBaselineStore(env.DB);
    const r = row({ until: null, tier: 'lifetime' });
    expect(await store.captureIfAbsent(r)).toEqual(r);
    expect(await store.get(r.ownerItemId)).toEqual(r);
  });

  it('captureIfAbsent never overwrites — the first capture wins', async () => {
    const store = new D1MembershipBaselineStore(env.DB);
    const first = row();
    await store.captureIfAbsent(first);
    const second = { ...first, since: '1999-01-01', until: '2030-01-01', capturedAt: '2026-11-01T00:00:00Z' };
    expect(await store.captureIfAbsent(second)).toEqual(first);
    expect(await store.get(first.ownerItemId)).toEqual(first);
  });

  it('a never-member baseline is all nulls', async () => {
    const store = new D1MembershipBaselineStore(env.DB);
    const r = row({ since: null, until: null, tier: null });
    await store.captureIfAbsent(r);
    expect(await store.get(r.ownerItemId)).toEqual(r);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd donation-rollups && npx vitest run src/db/membershipBaseline.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the store**

`donation-rollups/src/db/membershipBaseline.ts`:

```ts
import type { MembershipState, Tier } from '../membership/derive';

// One row per owner — the membership state the board held before this Worker's first
// membership write to that owner (spec §"Baseline"). Written once, read on every recompute.
export interface BaselineRow extends MembershipState {
  ownerItemId: string;
  ownerBoardId: string;
  capturedAt: string;
}

export interface MembershipBaselineStore {
  get(ownerItemId: string): Promise<BaselineRow | null>;
  // Insert-if-absent. Returns what is stored afterwards: the new row, or the existing one
  // when a concurrent recompute for the same owner got there first.
  captureIfAbsent(row: BaselineRow): Promise<BaselineRow>;
}

interface D1Row {
  owner_item_id: string; owner_board_id: string;
  since: string | null; until: string | null; tier: string | null; captured_at: string;
}

const fromRow = (r: D1Row): BaselineRow => ({
  ownerItemId: r.owner_item_id, ownerBoardId: r.owner_board_id,
  since: r.since, until: r.until, tier: r.tier as Tier | null, capturedAt: r.captured_at,
});

export class D1MembershipBaselineStore implements MembershipBaselineStore {
  constructor(private db: D1Database) {}

  async get(ownerItemId: string): Promise<BaselineRow | null> {
    const r = await this.db
      .prepare(`SELECT owner_item_id, owner_board_id, since, until, tier, captured_at
                FROM membership_baseline WHERE owner_item_id = ?1`)
      .bind(ownerItemId)
      .first<D1Row>();
    return r === null ? null : fromRow(r);
  }

  async captureIfAbsent(row: BaselineRow): Promise<BaselineRow> {
    await this.db
      .prepare(`INSERT INTO membership_baseline (owner_item_id, owner_board_id, since, until, tier, captured_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                ON CONFLICT (owner_item_id) DO NOTHING`)
      .bind(row.ownerItemId, row.ownerBoardId, row.since, row.until, row.tier, row.capturedAt)
      .run();
    return (await this.get(row.ownerItemId))!;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd donation-rollups && npx vitest run src/db/membershipBaseline.test.ts`
Expected: PASS (the migration from Task 1 is applied automatically by `test/apply-migrations.ts`).

- [ ] **Step 5: Commit**

```bash
git add donation-rollups/src/db/membershipBaseline.ts donation-rollups/src/db/membershipBaseline.test.ts
git commit -m "feat(donation-rollups): membership_baseline D1 store"
```

---

## Task 4: Monday client — read term columns and the owner's membership

**Files:**
- Modify: `donation-rollups/src/monday/client.ts`
- Modify: `donation-rollups/src/monday/client.test.ts`

**Interfaces:**
- Produces:

```ts
// DonationRecord gains (present only when the board configures the column; '' reads as null):
//   termStart?: string | null; termEnd?: string | null; membershipType?: string | null
// getDonationsByIds's `columns` parameter gains the same three optional ids.
// New on DonationRollupsMondayClient:
getOwnerMembership(ownerItemId: string, columns: OwnerMembershipColumns):
  Promise<{ statusLabel: string | null; tierLabel: string | null; since: string | null; until: string | null }>;
```

- [ ] **Step 1: Write the failing tests**

Append to `donation-rollups/src/monday/client.test.ts`:

```ts
describe('getDonationsByIds — membership term columns', () => {
  const TERM_COLUMNS = { ...COLUMNS, giftType: 'gt_1', termStart: 'ts_1', termEnd: 'te_1', membershipType: 'mty_1' };

  it('reads the three term columns when configured, blank as null', async () => {
    const client = clientReturning(itemsResponse([
      { id: 'dn1', cells: { amount_1: '50', date_1: '2026-11-05', status_1: 'Received', gt_1: 'Donation',
        ts_1: '2026-11-05', te_1: '', mty_1: 'Lifetime' } },
    ]));
    const [d] = await client.getDonationsByIds(['dn1'], TERM_COLUMNS);
    expect(d).toMatchObject({ giftType: 'Donation', termStart: '2026-11-05', termEnd: null, membershipType: 'Lifetime' });
  });

  it('leaves the term fields undefined when the board has no term columns', async () => {
    const client = clientReturning(itemsResponse([
      { id: 'dn1', cells: { amount_1: '50', date_1: '2026-11-05', status_1: 'Received' } },
    ]));
    const [d] = await client.getDonationsByIds(['dn1'], COLUMNS);
    expect(d!.termStart).toBeUndefined();
    expect(d!.termEnd).toBeUndefined();
    expect(d!.membershipType).toBeUndefined();
  });

  it('requests the term column ids from Monday', async () => {
    const client = clientReturning(itemsResponse([]));
    await client.getDonationsByIds(['dn1'], TERM_COLUMNS);
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string);
    expect(body.variables.columnIds).toEqual(expect.arrayContaining(['ts_1', 'te_1', 'mty_1']));
  });
});

describe('getOwnerMembership', () => {
  const OWNER = { status: 'ms', tier: 'mt', since: 'msince', until: 'muntil' };
  it('returns the four values, blanks as null', async () => {
    const client = clientReturning(itemsResponse([
      { id: 'o1', cells: { ms: 'Active', mt: 'Member', msince: '2015-01-01', muntil: '' } },
    ]));
    expect(await client.getOwnerMembership('o1', OWNER))
      .toEqual({ statusLabel: 'Active', tierLabel: 'Member', since: '2015-01-01', until: null });
  });
  it('a never-member reads as all null', async () => {
    const client = clientReturning(itemsResponse([{ id: 'o1', cells: { ms: null, mt: null, msince: null, muntil: null } }]));
    expect(await client.getOwnerMembership('o1', OWNER))
      .toEqual({ statusLabel: null, tierLabel: null, since: null, until: null });
  });
  it('a missing item reads as all null rather than throwing', async () => {
    const client = clientReturning(itemsResponse([]));
    expect(await client.getOwnerMembership('gone', OWNER))
      .toEqual({ statusLabel: null, tierLabel: null, since: null, until: null });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd donation-rollups && npx vitest run src/monday/client.test.ts`
Expected: FAIL — `getOwnerMembership` is not a function; term fields undefined in the first test.

- [ ] **Step 3: Implement**

In `donation-rollups/src/monday/client.ts`:

Add `import type { OwnerMembershipColumns } from '../types';` at the top.

Change `DonationRecord` to:

```ts
export interface DonationRecord {
  id: string;
  amount: number;
  dateISO: string;
  fiscalYear: number;
  status: string;
  giftType?: string | null; // present when the board's Gift Type column is configured
  // Present when the board's membership term columns are configured; '' reads as null.
  termStart?: string | null;
  termEnd?: string | null;
  membershipType?: string | null;
}
```

Define the columns type once, above the interface, and use it in both the interface and the class:

```ts
export type DonationReadColumns = {
  amount: string; date: string; fiscalYear: string | null; status: string;
  giftType?: string | null; termStart?: string | null; termEnd?: string | null; membershipType?: string | null;
};
```

In `DonationRollupsMondayClient`, change `getDonationsByIds`'s `columns` parameter type to
`DonationReadColumns` and add, after `getDonorLinkForDonation`:

```ts
  // The four membership columns on a People-type owner, as label/date text — the membership
  // step's "what does the board hold" read (spec §"Merge with the board"). A missing item
  // reads as all-null so a deleted owner degrades to "never a member", not a thrown recompute.
  getOwnerMembership(ownerItemId: string, columns: OwnerMembershipColumns):
    Promise<{ statusLabel: string | null; tierLabel: string | null; since: string | null; until: string | null }>;
```

In `HttpMondayClient.getDonationsByIds`, change the signature's `columns` type to
`DonationReadColumns`, extend `columnIds`:

```ts
    const columnIds = [columns.amount, columns.date, columns.status,
      ...(columns.fiscalYear ? [columns.fiscalYear] : []),
      ...(columns.giftType ? [columns.giftType] : []),
      ...(columns.termStart ? [columns.termStart] : []),
      ...(columns.termEnd ? [columns.termEnd] : []),
      ...(columns.membershipType ? [columns.membershipType] : [])];
```

and replace the `donations.push(...)` line with:

```ts
        const optionalText = (id: string | null | undefined): string | null | undefined =>
          id ? (byId.get(id) || null) : undefined;
        donations.push({
          id: item.id, amount, dateISO, fiscalYear, status, giftType,
          termStart: optionalText(columns.termStart),
          termEnd: optionalText(columns.termEnd),
          membershipType: optionalText(columns.membershipType),
        });
```

Add the new method after `getDonorLinkForDonation`:

```ts
  async getOwnerMembership(ownerItemId: string, columns: OwnerMembershipColumns) {
    const ids = [columns.status, columns.tier, columns.since, columns.until];
    const cols = (await this.getItemsColumnsText([ownerItemId], ids)).get(ownerItemId);
    const text = (id: string): string | null => cols?.get(id) ?? null;
    return { statusLabel: text(columns.status), tierLabel: text(columns.tier), since: text(columns.since), until: text(columns.until) };
  }
```

(`getItemsColumnsText` already maps `''` to `null` and requests with `limit: 100`.)

- [ ] **Step 4: Run the tests and typecheck**

Run: `cd donation-rollups && npx vitest run src/monday/client.test.ts && npm run typecheck`
Expected: client tests PASS. Typecheck fails in `processBatch.test.ts`'s `fakeMondayClient` (missing
`getOwnerMembership`) — add `getOwnerMembership: vi.fn().mockResolvedValue({ statusLabel: null, tierLabel: null, since: null, until: null }),`
to that fake, and to any other fake implementing `DonationRollupsMondayClient` (`grep -rn "getDonorLinkForDonation: vi.fn" src`). Re-run `npm run typecheck && npm test` until green.

- [ ] **Step 5: Commit**

```bash
git add donation-rollups/src/monday/client.ts donation-rollups/src/monday/client.test.ts donation-rollups/src/consumer/processBatch.test.ts
git commit -m "feat(donation-rollups): read gift term columns and owner membership from Monday"
```

---

## Task 5: Consumer — the membership step

**Files:**
- Modify: `donation-rollups/src/consumer/processBatch.ts`
- Modify: `donation-rollups/src/consumer/processBatch.test.ts`
- Modify: `donation-rollups/src/index.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: `ProcessBatchDeps.baselineStore: MembershipBaselineStore`.

- [ ] **Step 1: Write the failing tests**

In `donation-rollups/src/consumer/processBatch.test.ts`, add imports and fixtures near the top
(after the existing `config` constant):

```ts
import type { MembershipBaselineStore, BaselineRow } from '../db/membershipBaseline';
import type { MembershipConfig } from '../types';

const membershipConfig: MembershipConfig = {
  fromISO: '2026-10-01', eligibleGiftTypes: ['Donation'], termMonths: 12, lifetimeThresholdCents: 100000,
  statusLabels: { active: 'Active', lapsed: 'Lapsed' },
  tierLabels: { member: 'Member', lifetime: 'Lifetime' },
  typeLabels: { new: 'New', renewal: 'Renewal', reacquire: 'Reacquire', lifetime: 'Lifetime' },
};
const memberOwnerColumns: OwnerColumns = { ...ownerColumns, membership: { status: 'ms', tier: 'mt', since: 'msince', until: 'muntil' } };
const membershipBoard = { boardId: 1, columns: { donorLink: 'donor_link_1', amount: 'amount_1', date: 'date_1', status: 'status_1',
  fiscalYear: 'fy_1', giftType: 'gt_1', termStart: 'ts_1', termEnd: 'te_1', membershipType: 'mty_1' } };
const membershipEnabled: DonationRollupsConfig = {
  ...config,
  donationRollups: {
    ...config.donationRollups,
    donationBoards: [membershipBoard],
    ownerColumnsByBoard: { '2': memberOwnerColumns, '3': ownerColumns },
    membership: membershipConfig,
  },
};

function fakeBaselineStore(existing: BaselineRow | null = null): MembershipBaselineStore & { captured: BaselineRow[] } {
  const captured: BaselineRow[] = [];
  return {
    captured,
    get: vi.fn().mockResolvedValue(existing),
    captureIfAbsent: vi.fn().mockImplementation(async (row: BaselineRow) => { captured.push(row); return existing ?? row; }),
  };
}

const NOW = new Date('2026-11-06T12:00:00Z');
const renewalGift = { id: 'dn1', amount: 50, dateISO: '2026-11-05', fiscalYear: 2027, status: 'Received',
  giftType: 'Donation', termStart: null, termEnd: null, membershipType: null };
```

Every existing `processRecomputeBatch(...)` call in this file passes a deps object; add
`baselineStore: fakeBaselineStore()` to each (search for `giftsStore, mondayClient, config`).

Then add the describe block at the end of the file:

```ts
describe('membership step (spec 2026-09-15)', () => {
  function deps(over: {
    board?: { statusLabel: string | null; tierLabel: string | null; since: string | null; until: string | null };
    baseline?: BaselineRow | null;
    donations?: unknown[];
    ownerBoard?: string;
    cfg?: DonationRollupsConfig;
  } = {}) {
    const changeColumnValues = vi.fn().mockResolvedValue(undefined);
    const baselineStore = fakeBaselineStore(over.baseline ?? null);
    const mondayClient = fakeMondayClient({
      changeColumnValues,
      getItemBoardId: vi.fn().mockResolvedValue(over.ownerBoard ?? '2'),
      getDonationsByIds: vi.fn().mockResolvedValue(over.donations ?? [renewalGift]),
      getOwnerMembership: vi.fn().mockResolvedValue(over.board ?? { statusLabel: null, tierLabel: null, since: null, until: null }),
    });
    return {
      changeColumnValues, baselineStore, mondayClient,
      run: () => processRecomputeBatch([fakeMessage('dn1')], {
        pendingStore: fakePendingStore(), linksStore: fakeLinksStore(), giftsStore: fakeGiftsStore(),
        baselineStore, mondayClient, config: over.cfg ?? membershipEnabled, now: NOW,
      }),
    };
  }

  it('a lapsed migrated member renewing: captures the baseline once, writes Status+Until on the owner, stamps the gift', async () => {
    const d = deps({ board: { statusLabel: 'Lapsed', tierLabel: 'Member', since: '2015-01-01', until: '2026-03-01' } });
    await d.run();
    expect(d.baselineStore.captured).toEqual([expect.objectContaining({ ownerItemId: 'donor-1', ownerBoardId: '2',
      since: '2015-01-01', until: '2026-03-01', tier: 'member' })]);
    const [ownerCall, giftCall] = d.changeColumnValues.mock.calls;
    expect(ownerCall![0]).toBe(2); expect(ownerCall![1]).toBe('donor-1');
    expect(ownerCall![2]).toMatchObject({ ms: { label: 'Active' }, muntil: { date: '2027-11-05' } });
    expect(ownerCall![2]).not.toHaveProperty('msince');
    expect(ownerCall![2]).not.toHaveProperty('mt');
    expect(giftCall).toEqual([1, 'dn1', { ts_1: { date: '2026-11-05' }, te_1: { date: '2027-11-05' }, mty_1: 'Reacquire' }]);
  });

  it('uses the stored baseline, not the board, for the term type on a re-run', async () => {
    // Board already reflects the first run (Active, Until 2027-11-05); baseline says lapsed → still Reacquire.
    const baseline: BaselineRow = { ownerItemId: 'donor-1', ownerBoardId: '2', since: '2015-01-01', until: '2026-03-01', tier: 'member', capturedAt: 'x' };
    const d = deps({ baseline, board: { statusLabel: 'Active', tierLabel: 'Member', since: '2015-01-01', until: '2027-11-05' },
      donations: [{ ...renewalGift, termStart: '2026-11-05', termEnd: '2027-11-05', membershipType: 'Reacquire' }] });
    await d.run();
    expect(d.baselineStore.captureIfAbsent).not.toHaveBeenCalled();
    expect(d.changeColumnValues).toHaveBeenCalledTimes(1); // rollups only — no membership keys, no gift write
    expect(d.changeColumnValues.mock.calls[0]![2]).not.toHaveProperty('ms');
  });

  it('a never-member: writes all four owner columns and a New term', async () => {
    const d = deps();
    await d.run();
    expect(d.changeColumnValues.mock.calls[0]![2]).toMatchObject({
      ms: { label: 'Active' }, mt: { label: 'Member' }, msince: { date: '2026-11-05' }, muntil: { date: '2027-11-05' } });
    expect(d.changeColumnValues.mock.calls[1]![2]).toMatchObject({ mty_1: 'New' });
  });

  it('a $1,000 gift makes the owner Lifetime with Until cleared and a blank Term End', async () => {
    const d = deps({ board: { statusLabel: 'Active', tierLabel: 'Member', since: '2015-01-01', until: '2027-04-11' },
      donations: [{ ...renewalGift, amount: 1000 }] });
    await d.run();
    expect(d.changeColumnValues.mock.calls[0]![2]).toMatchObject({ mt: { label: 'Lifetime' }, muntil: null });
    expect(d.changeColumnValues.mock.calls[1]![2]).toEqual({ ts_1: { date: '2026-11-05' }, mty_1: 'Lifetime' });
  });

  it('a staff-extended Until on the board is kept (extend-only merge)', async () => {
    const d = deps({ board: { statusLabel: 'Active', tierLabel: 'Member', since: '2015-01-01', until: '2029-01-01' } });
    await d.run();
    expect(d.changeColumnValues.mock.calls[0]![2]).not.toHaveProperty('muntil');
    expect(d.changeColumnValues.mock.calls[1]![2]).toMatchObject({ mty_1: 'Renewal', te_1: { date: '2027-11-05' } });
  });

  it('an Organizations owner (no membership columns) gets no membership writes and no baseline', async () => {
    const d = deps({ ownerBoard: '3' });
    await d.run();
    expect(d.baselineStore.captureIfAbsent).not.toHaveBeenCalled();
    expect(d.mondayClient.getOwnerMembership).not.toHaveBeenCalled();
    expect(d.changeColumnValues).toHaveBeenCalledTimes(1);
  });

  it('with the membership block null the step is skipped entirely', async () => {
    const d = deps({ cfg: { ...membershipEnabled, donationRollups: { ...membershipEnabled.donationRollups, membership: null } } });
    await d.run();
    expect(d.mondayClient.getOwnerMembership).not.toHaveBeenCalled();
    expect(d.changeColumnValues).toHaveBeenCalledTimes(1);
  });

  it('ineligible gifts (pre-cutover, non-Donation, not Received) neither write the owner nor stamp the gift', async () => {
    const d = deps({ donations: [
      { ...renewalGift, id: 'old', dateISO: '2026-09-30' },
      { ...renewalGift, id: 'match', giftType: 'Matching Donation' },
      { ...renewalGift, id: 'pending', status: 'Pending' },
    ] });
    await d.run();
    expect(d.changeColumnValues).toHaveBeenCalledTimes(1);
    expect(d.changeColumnValues.mock.calls[0]![2]).not.toHaveProperty('ms');
  });

  it('the owner write precedes the gift writes, and a failing gift write still retries the message', async () => {
    const d = deps();
    d.changeColumnValues.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('monday API: HTTP 500'));
    const message = fakeMessage('dn1');
    await processRecomputeBatch([message], {
      pendingStore: fakePendingStore(), linksStore: fakeLinksStore(), giftsStore: fakeGiftsStore(),
      baselineStore: d.baselineStore, mondayClient: d.mondayClient, config: membershipEnabled, now: NOW,
    });
    expect(d.changeColumnValues.mock.calls[0]![1]).toBe('donor-1');
    expect(message.retry).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd donation-rollups && npx vitest run src/consumer/processBatch.test.ts`
Expected: FAIL — no membership keys written, `baselineStore` unused, second `changeColumnValues` call absent.

- [ ] **Step 3: Implement the step**

In `donation-rollups/src/consumer/processBatch.ts`:

Add imports:

```ts
import type { MembershipBaselineStore } from '../db/membershipBaseline';
import type { DonationRecord } from '../monday/client';
import type { DonationBoardConfig, MembershipConfig, OwnerMembershipColumns } from '../types';
import {
  deriveMembership, mergeWithBoard, statusFor, tierFromLabel,
  membershipColumnValues, termColumnValues, type MembershipState,
} from '../membership/derive';
```

(merge the `../types` import with the existing one: `DonationRollupsConfig, OwnerColumns, RecomputeQueueMessage, DonationBoardConfig, MembershipConfig, OwnerMembershipColumns`.)

Add to `ProcessBatchDeps`: `baselineStore: MembershipBaselineStore;`

In `processOne`, the donations are fetched per board and flattened; the gift write needs each
gift's board. Replace the `perBoard` / `donations` lines with:

```ts
  const perBoard = await Promise.all(donationBoards
    .filter((b) => linksByBoard.has(String(b.boardId)))
    .map(async (b) => ({ board: b, items: await mondayClient.getDonationsByIds(linksByBoard.get(String(b.boardId))!, b.columns) })));
  const donations = perBoard.flatMap((p) => p.items);
```

After `const rollup = computeRollup(...)` and before the `history`/projection lines, add:

```ts
  // Membership renewal write path (spec 2026-09-15): only for owners on a board with the four
  // membership columns, and only when the feature block is configured. Organizations and a
  // null block both skip silently — neither is a fault.
  const membership = config.donationRollups.membership;
  const membershipColumns = ownerColumns.membership;
  let membershipValues: Record<string, unknown> = {};
  const giftTermWrites: { boardId: number; itemId: string; values: Record<string, unknown> }[] = [];
  if (membership !== null && membershipColumns !== undefined) {
    const step = await planMembershipWrites(deps, ownerItemId, ownerBoardId, membershipColumns, membership, perBoard);
    membershipValues = step.ownerValues;
    giftTermWrites.push(...step.giftWrites);
  }
```

Change the `columnValues` construction to include them:

```ts
  const columnValues = {
    ...rollupToColumnValues(rollup, ownerColumns),
    [ownerColumns.giftLedgerJson]: ledgerProjection.json,
    ...membershipValues,
  };
```

Immediately after the existing `await mondayClient.changeColumnValues(Number(ownerBoardId), ownerItemId, columnValues);`
line (before the description `try`), add:

```ts
  // Gift term columns, owner first (spec §"Writes and idempotency"): if one of these fails the
  // owner is already right and the retry re-derives the missing stamps. Each write fires this
  // Worker's own webhook; the resulting recompute finds nothing changed and writes nothing.
  for (const w of giftTermWrites) {
    await mondayClient.changeColumnValues(w.boardId, w.itemId, w.values);
  }
```

Add the helper at module level (below `processOne`):

```ts
async function planMembershipWrites(
  deps: ProcessBatchDeps, ownerItemId: string, ownerBoardId: string,
  columns: OwnerMembershipColumns, membership: MembershipConfig,
  perBoard: { board: DonationBoardConfig; items: DonationRecord[] }[],
): Promise<{ ownerValues: Record<string, unknown>; giftWrites: { boardId: number; itemId: string; values: Record<string, unknown> }[] }> {
  const { mondayClient, baselineStore, config } = deps;
  const board = await mondayClient.getOwnerMembership(ownerItemId, columns);
  const boardState: MembershipState = { since: board.since, until: board.until, tier: tierFromLabel(board.tierLabel, membership) };

  // Captured before this Worker's first membership write to the owner — by construction,
  // since the capture happens on the same recompute that would make that write.
  const baseline = (await baselineStore.get(ownerItemId))
    ?? (await baselineStore.captureIfAbsent({ ownerItemId, ownerBoardId, ...boardState, capturedAt: new Date().toISOString() }));

  const gifts = perBoard.flatMap((p) => p.items.map((d) => ({
    id: d.id, dateISO: d.dateISO, amountCents: Math.round(d.amount * 100), status: d.status, giftType: d.giftType ?? null,
  })));
  const derived = deriveMembership({ since: baseline.since, until: baseline.until, tier: baseline.tier },
    gifts, membership, config.donationRollups.receivedStatusLabel);
  const merged = mergeWithBoard(derived.state, boardState);
  const todayISO = (deps.now ?? new Date()).toISOString().slice(0, 10);
  const ownerValues = membershipColumnValues(merged, statusFor(merged, todayISO),
    { ...boardState, statusLabel: board.statusLabel }, columns, membership);

  const giftWrites: { boardId: number; itemId: string; values: Record<string, unknown> }[] = [];
  for (const { board: b, items } of perBoard) {
    const cols = b.columns;
    if (!cols.termStart || !cols.termEnd || !cols.membershipType) continue; // validated present when membership is on
    for (const d of items) {
      const values = termColumnValues(derived.terms.get(d.id),
        { termStart: d.termStart ?? null, termEnd: d.termEnd ?? null, membershipType: d.membershipType ?? null },
        { termStart: cols.termStart, termEnd: cols.termEnd, membershipType: cols.membershipType }, membership);
      if (Object.keys(values).length > 0) giftWrites.push({ boardId: b.boardId, itemId: d.id, values });
    }
  }
  return { ownerValues, giftWrites };
}
```

In `donation-rollups/src/index.ts`, import `D1MembershipBaselineStore` from `./db/membershipBaseline`
and add `baselineStore: new D1MembershipBaselineStore(env.DB),` to the `processRecomputeBatch` deps
in the `queue` handler.

- [ ] **Step 4: Run all tests and typecheck**

Run: `cd donation-rollups && npm test && npm run typecheck`
Expected: PASS. If the "re-run" test sees a gift write, check that `getDonationsByIds`'s fake returns
the term text exactly as `termColumnValues` compares it (`'Reacquire'`, ISO dates) — the compare is
string equality on what Monday returns. If the custodian's sweep tests construct
`ProcessBatchDeps`, add `baselineStore` there too.

- [ ] **Step 5: Commit**

```bash
git add donation-rollups/src/consumer donation-rollups/src/index.ts
git commit -m "feat(donation-rollups): derive and write membership state and gift terms on recompute"
```

---

## Task 6: `funraise-sync` — stamp Gift Type on new Donations items

**Files:**
- Modify: `funraise-sync/src/types.ts`
- Modify: `funraise-sync/src/config.ts`
- Modify: `funraise-sync/src/config.test.ts`
- Modify: `funraise-sync/src/consumer/processBatch.ts`
- Modify: `funraise-sync/src/consumer/processBatch.test.ts`
- Modify: `funraise-sync/config/svbc.json`
- Modify: `funraise-sync/README.md`

**Interfaces:**
- Produces (config, under `funraiseSync`): `giftTypeColumn: string | null`, `giftTypeValue: string`.

- [ ] **Step 1: Write the failing tests**

In `funraise-sync/src/config.test.ts`, add `giftTypeColumn: null, giftTypeValue: 'Donation',` to
`validConfig.funraiseSync` (next to `thankYouSentColumn`), then add a describe block:

```ts
describe('validateConfig — giftTypeColumn / giftTypeValue', () => {
  it('throws when giftTypeColumn is missing', () => {
    const { giftTypeColumn, ...funraiseSync } = validConfig.funraiseSync;
    expect(() => validateConfig({ ...validConfig, funraiseSync })).toThrow(/giftTypeColumn/);
  });
  it('throws when giftTypeColumn is an empty string', () => {
    const funraiseSync = { ...validConfig.funraiseSync, giftTypeColumn: '' };
    expect(() => validateConfig({ ...validConfig, funraiseSync })).toThrow(/giftTypeColumn/);
  });
  it('throws when giftTypeValue is empty', () => {
    const funraiseSync = { ...validConfig.funraiseSync, giftTypeColumn: 'gt_col', giftTypeValue: '' };
    expect(() => validateConfig({ ...validConfig, funraiseSync })).toThrow(/giftTypeValue/);
  });
  it('accepts a configured column and value', () => {
    const funraiseSync = { ...validConfig.funraiseSync, giftTypeColumn: 'gt_col', giftTypeValue: 'Donation' };
    expect(() => validateConfig({ ...validConfig, funraiseSync })).not.toThrow();
  });
});
```

In `funraise-sync/src/consumer/processBatch.test.ts`, add `giftTypeColumn: null, giftTypeValue: 'Donation',`
to the `config.funraiseSync` literal, then append:

```ts
describe('Gift Type stamp (membership renewal write path, spec 2026-09-15)', () => {
  const giftTypeConfig: FunraiseSyncConfig = {
    ...config,
    funraiseSync: { ...config.funraiseSync, giftTypeColumn: 'gt_col', giftTypeValue: 'Donation' },
  };

  it('stamps Gift Type when creating a Donations item', async () => {
    const eventStore = fakeStore(eventRow({ matchedDonorItemId: '7' }));
    const createItem = vi.fn().mockResolvedValue({ id: 'item-new' });
    const mondayClient: MondayClient = { findItemByColumnValue: vi.fn().mockResolvedValue(null), createItem, changeColumnValues: vi.fn() };
    await processFunraiseQueueBatch([fakeMessage()], { eventStore, mondayClient, config: giftTypeConfig });
    expect(createItem).toHaveBeenCalledWith(111, expect.any(String), expect.objectContaining({ gt_col: 'Donation' }));
  });

  it('stamps Gift Type when adopting an orphaned Donations item', async () => {
    const eventStore = fakeStore(eventRow({ matchedDonorItemId: '7' }));
    const changeColumnValues = vi.fn().mockResolvedValue(undefined);
    const mondayClient: MondayClient = { findItemByColumnValue: vi.fn().mockResolvedValue({ id: 'item-orphan' }), createItem: vi.fn(), changeColumnValues };
    await processFunraiseQueueBatch([fakeMessage()], { eventStore, mondayClient, config: giftTypeConfig });
    expect(changeColumnValues).toHaveBeenCalledWith(111, 'item-orphan', expect.objectContaining({ gt_col: 'Donation' }));
  });

  it('never touches Gift Type on a later update — staff may have reclassified the gift', async () => {
    const eventStore = fakeStore(eventRow({ matchedDonorItemId: '7', mondayItemId: 'item-existing' }));
    const changeColumnValues = vi.fn().mockResolvedValue(undefined);
    const mondayClient: MondayClient = { findItemByColumnValue: vi.fn(), createItem: vi.fn(), changeColumnValues };
    await processFunraiseQueueBatch([fakeMessage()], { eventStore, mondayClient, config: giftTypeConfig });
    expect(changeColumnValues).toHaveBeenCalledWith(111, 'item-existing', expect.not.objectContaining({ gt_col: expect.anything() }));
  });

  it('never stamps recurring gifts or registrations', async () => {
    const eventStore = fakeStore(eventRow({ entityType: 'pledge', entityId: 'sub-1', matchedDonorItemId: '7' }));
    const createItem = vi.fn().mockResolvedValue({ id: 'item-pledge' });
    const mondayClient: MondayClient = { findItemByColumnValue: vi.fn().mockResolvedValue(null), createItem, changeColumnValues: vi.fn() };
    await processFunraiseQueueBatch([fakeMessage('pledge', 'sub-1')], { eventStore, mondayClient, config: giftTypeConfig });
    expect(createItem).toHaveBeenCalledWith(222, expect.any(String), expect.not.objectContaining({ gt_col: expect.anything() }));
  });

  it('does nothing when giftTypeColumn is null', async () => {
    const eventStore = fakeStore(eventRow({ matchedDonorItemId: '7' }));
    const createItem = vi.fn().mockResolvedValue({ id: 'item-new' });
    const mondayClient: MondayClient = { findItemByColumnValue: vi.fn().mockResolvedValue(null), createItem, changeColumnValues: vi.fn() };
    await processFunraiseQueueBatch([fakeMessage()], { eventStore, mondayClient, config });
    expect(createItem).toHaveBeenCalledWith(111, expect.any(String), expect.not.objectContaining({ gt_col: expect.anything() }));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd funraise-sync && npx vitest run src/config.test.ts src/consumer/processBatch.test.ts`
Expected: FAIL — no `giftTypeColumn` validation; `gt_col` never written.

- [ ] **Step 3: Implement**

`funraise-sync/src/types.ts`, in `FunraiseSyncConfig.funraiseSync` after `thankYouSentColumn`:

```ts
    // Text column on the Donations board stamped with giftTypeValue on a transaction's first
    // write only — donation-rollups' membership rule only counts gifts whose Gift Type is in its
    // eligible list (spec 2026-09-15), and staff may later reclassify a gift, so updates never
    // touch it. null disables the stamp.
    giftTypeColumn: string | null;
    giftTypeValue: string;
```

`funraise-sync/src/config.ts`, after the `thankYouSentColumn` check:

```ts
  if (
    !('giftTypeColumn' in funraiseSync) ||
    (funraiseSync.giftTypeColumn !== null &&
      (typeof funraiseSync.giftTypeColumn !== 'string' || funraiseSync.giftTypeColumn === ''))
  ) {
    throw new Error('config: "funraiseSync.giftTypeColumn" must be a Monday column id string, or null to disable');
  }
  if (funraiseSync.giftTypeColumn !== null
    && (typeof funraiseSync.giftTypeValue !== 'string' || funraiseSync.giftTypeValue === '')) {
    throw new Error('config: "funraiseSync.giftTypeValue" must be a non-empty Gift Type label when giftTypeColumn is set');
  }
```

`funraise-sync/src/consumer/processBatch.ts`: change the destructuring line to
`const { donorLinkColumn, entityIdColumn, thankYouSentColumn, giftTypeColumn, giftTypeValue } = deps.config.funraiseSync;`
and directly after the `thankYouSentColumn` block (which sits after the "already has a Monday
item" early return, so updates never reach it) add:

```ts
  // First write only, transactions only — same reasoning as Thank You Sent above.
  if (giftTypeColumn && entityType === 'transaction') {
    columnValues[giftTypeColumn] = giftTypeValue;
  }
```

`funraise-sync/config/svbc.json`: after `"thankYouSentColumn": "thank_you_sent_column_id",` add
`"giftTypeColumn": "text_mm6j66w3",` and `"giftTypeValue": "Donation",` (the sandbox Donations
board's Gift Type column; production id at cutover like every other id here).

`funraise-sync/README.md`: under "Field mapping", add a paragraph:

> **Gift Type.** Every transaction item is stamped `giftTypeValue` (default `Donation`) in
> `giftTypeColumn` on its first write, never on updates. `donation-rollups`' membership rule
> (spec `docs/superpowers/specs/2026-09-15-membership-renewal-write-path-design.md`) only
> counts gifts whose Gift Type is in its eligible list, so without this stamp a Funraise
> renewal would never extend a membership. Staff can reclassify a gift afterwards (e.g. to
> `Matching Donation`) and this Worker will not undo it.

- [ ] **Step 4: Run tests and typecheck**

Run: `cd funraise-sync && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add funraise-sync/src funraise-sync/config/svbc.json funraise-sync/README.md
git commit -m "feat(funraise-sync): stamp Gift Type on new Donations items so they qualify for membership terms"
```

---

## Task 7: Sandbox config and README

**Files:**
- Modify: `donation-rollups/config/svbc.json`
- Modify: `donation-rollups/README.md`

- [ ] **Step 1: Fill in the sandbox config**

In `donation-rollups/config/svbc.json`:

Under `donationRollups.donationBoards[0].columns` add:

```json
        "termStart": "date_mm6jyeva",
        "termEnd": "date_mm6jnna5",
        "membershipType": "text_mm6jas1b"
```

Under `ownerColumnsByBoard["18428131737"]` (People) add:

```json
        "membership": {
          "status": "color_mm6jbkns",
          "tier": "color_mm6jhs7g",
          "since": "date_mm6jv5gt",
          "until": "date_mm6jq0va"
        }
```

Under `ownerColumnsByBoard["18428131744"]` (People (Historical)) add:

```json
        "membership": {
          "status": "color_mm6j5hbd",
          "tier": "color_mm6jfgr9",
          "since": "date_mm6j6p7b",
          "until": "date_mm6jpvx8"
        }
```

Leave `18428131727` (Organizations) without a `membership` key. Add to `donationRollups`, after
`ownerColumnsByBoard`:

```json
    "membership": {
      "fromISO": "2026-10-01",
      "eligibleGiftTypes": ["Donation"],
      "termMonths": 12,
      "lifetimeThresholdCents": 100000,
      "statusLabels": { "active": "Active", "lapsed": "Lapsed" },
      "tierLabels": { "member": "Member", "lifetime": "Lifetime" },
      "typeLabels": { "new": "New", "renewal": "Renewal", "reacquire": "Reacquire", "lifetime": "Lifetime" }
    }
```

`fromISO` is the planned October cutover; set it to the real cutover date when it is fixed. The
label values match the sandbox boards' status labels read live 2026-09-15.

- [ ] **Step 2: Verify the shipped config validates**

Run: `cd donation-rollups && npm run typecheck && npm test`
Expected: PASS. Nothing in the test suite loads the real `config/svbc.json` today, so add this
to `src/config.test.ts` first, so a bad shipped file fails CI rather than the first deploy:

```ts
import rawConfig from '../config/svbc.json';

it('the shipped config/svbc.json validates with membership on', () => {
  expect(validateConfig(rawConfig).donationRollups.membership?.eligibleGiftTypes).toEqual(['Donation']);
});
```

- [ ] **Step 3: Document in the README**

Add a section to `donation-rollups/README.md` before "Ledger v2 + the custodian":

```markdown
## Membership renewal write path (spec `docs/superpowers/specs/2026-09-15-membership-renewal-write-path-design.md`)

Salesforce's `Create_members` flow turned every won Donation-type gift into a one-year
membership term (and a $1,000+ gift into a Lifetime one). This Worker replicates that rule as
one more step of the recompute: after the rollups, it folds the owner's eligible post-cutover
gifts (Status = Received, Gift Type in `membership.eligibleGiftTypes`, date ≥
`membership.fromISO`) into Membership Status / Tier / Member Since / Member Until on the owner's
People item, and stamps Term Start / Term End / Membership Type on each eligible gift. Both
writes are compare-before-write, so the gift stamp's own webhook triggers one idle recompute and
stops. The merge with the board is **extend-only** — a staff-granted comp or Lifetime is never
shortened or downgraded; shorten by hand if you mean to.

* **Gated** on `donationRollups.membership` (null = off) and on an owner board having a
  `membership` column block; Organizations never get a term.
* **Baseline.** `membership_baseline` (migration 0005) holds each owner's pre-feature state,
  captured from the board on the first recompute that touches them, so New/Renewal/Reacquire
  stays stable across re-runs. It is never updated. To re-seed one owner after correcting their
  migrated history in the UI:
  `wrangler d1 execute svbc-donation-rollups --remote --command "DELETE FROM membership_baseline WHERE owner_item_id='<id>'" -y`
  — the next recompute recaptures it.
* **Auto-lapse** stays a native board automation ("When Member Until arrives … set Membership
  Status to Lapsed"); this Worker agrees with it by construction. `mailchimp-sync` picks up the
  People changes through its own webhook; the donor portal reads the same columns.
* **Funraise gifts** qualify only because `funraise-sync` stamps Gift Type = Donation on the
  items it creates (see that README) and only once its Date column transform lands — a gift
  with an empty Date never starts a term.
* Not replicated: Salesforce's inconsistent Lifetime firing, and the Matching Donation terms
  staff created by cloning gifts. Add `"Matching Donation"` to `eligibleGiftTypes` if that
  practice should continue.
```

Also add `0005_membership_baseline.sql` wherever the README lists migrations, if it does
(`grep -n "0004" README.md`).

- [ ] **Step 4: Commit**

```bash
git add donation-rollups/config/svbc.json donation-rollups/README.md donation-rollups/src/config.test.ts
git commit -m "docs(donation-rollups): sandbox membership config and README for the renewal write path"
```

---

## Task 8: Sandbox verification (manual, before the MR)

**Files:** none. Requires a deployed Worker pointed at the CRM Sandbox with migration 0005
applied (`wrangler d1 migrations apply svbc-donation-rollups --remote`) and the webhooks from
`scripts/setup-webhooks.mjs` subscribed.

- [ ] **Step 1: Pick a Lapsed sandbox member** on People (`18428131737`) — filter Membership
  Status = Lapsed — and note their Member Since / Member Until.
- [ ] **Step 2: Hand-create a Donations item** on `18428131791`: Amount 50, Date today, Status
  Received, Gift Type `Donation`, Donor = that person.
- [ ] **Step 3: Within a minute, confirm** the person shows Membership Status Active, Member
  Until one year from today, Member Since unchanged; the gift shows Term Start today, Term End one
  year out, Membership Type `Reacquire`; `membership_baseline` has one row for the owner with the
  pre-gift values (`wrangler d1 execute … --command "SELECT * FROM membership_baseline"`).
- [ ] **Step 4: Edit the gift's Amount to 1000.** Confirm Tier Lifetime, Member Until blank,
  gift Membership Type `Lifetime`, Term End blank.
- [ ] **Step 5: Edit any unrelated column on the gift twice.** Confirm the item's activity log
  shows no further column writes by the Worker (the idle recompute wrote nothing).
- [ ] **Step 6: Record the result** in the MR description, then delete the test gift and reset
  the person's four columns by hand (and delete their baseline row), so the sandbox matches the
  import again.

---

## Self-review against the spec

- **The rule** (eligibility, term dates, Feb 29, Lifetime threshold, New/Renewal/Reacquire,
  already-Lifetime skip) — Task 2, tested case by case.
- **Baseline** (table, lazy capture before first write, never updated, reset runbook) — Tasks 1,
  3, 5, 7.
- **Merge with the board** (extend-only; Status derived; never-member untouched) — Task 2
  `mergeWithBoard` / `statusFor` / `membershipColumnValues`, exercised end-to-end in Task 5.
- **Writes and idempotency** (changed-only owner keys; changed-only gift stamps; owner before
  gifts; loop terminates) — Tasks 2, 4, 5; the re-run test in Task 5 proves the idle pass writes
  nothing.
- **funraise-sync change** (Gift Type stamp, first write only, null disables; date transform
  precondition documented) — Task 6.
- **Configuration** (block shape, per-board ids, cross-requirements, feature off when null) —
  Tasks 1 and 7.
- **Error handling** — config mismatch surfaces as a Monday write error → retry/DLQ (unchanged
  path); baseline capture precedes any write; ineligible or undated gifts are skipped, not thrown
  (`isEligibleGift`); Organizations and null-block skips are silent (Task 5 tests).
- **Testing** — every bullet in the spec's Testing section maps to a test in Tasks 2–6; the
  sandbox verification is Task 8.
- **Non-goals** — no reminder logic, no custodian check, no joint memberships, no tiers: none
  appear in any task.
- Type names are consistent across tasks: `MembershipConfig`, `OwnerMembershipColumns`,
  `MembershipState`, `MembershipGift`, `GiftTerm`, `DerivedMembership`, `BoardMembership`,
  `BaselineRow`, `MembershipBaselineStore`, `DonationReadColumns`, `getOwnerMembership`,
  `planMembershipWrites`.
