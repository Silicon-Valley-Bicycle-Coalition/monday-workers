# Donor Portal v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add year-end consolidated tax letters (HTML + print CSS, rendered live from Monday) and staff-reviewed address/contact change requests to the existing `donor-portal` Worker.

**Architecture:** Two independent features inside the existing v1 Worker. Letters are a pure read path: session-scoped routes render a printable HTML letter from the Donations board — no PDF generation, no storage. Change requests are the monorepo's standard write path: validate → D1 row (dedupe + audit) → Cloudflare Queue → consumer creates an item on a staff-owned Change Requests Monday board. Both features are gated by config (letters on signed-off acknowledgment language, change requests on the staff board existing), so either can deploy before the other is unblocked.

**Tech Stack:** Hono + TypeScript on Cloudflare Workers, D1, Cloudflare Queues, Vitest with `@cloudflare/vitest-plugin` (real D1 + migrations in tests), Monday.com GraphQL API v2.

**Spec:** `docs/superpowers/specs/2026-08-24-donor-portal-v2-design.md` — read it first; this plan argues from it.

## Global Constraints

- All commands run from `donor-portal/` inside the `monday-workers` repo (`cd donor-portal` first). There is no root package.json.
- ES modules only; vanilla TypeScript; no new runtime dependencies — Hono is already there, and nothing here needs more.
- TDD: every task writes the failing test first, sees it fail, then implements. Run `npm test` and `npm run typecheck` before every commit.
- Conventional commits, scoped `donor-portal` (e.g. `feat(donor-portal): …`).
- SVBC-specific values (board ids, column ids, letter wording, tier names) live in `config/svbc.json`, never in source. Placeholder letter language is the literal string `REPLACE_AFTER_SIGNOFF`; placeholder column ids are `REPLACE_WITH_COLUMN_ID`.
- The Worker stays read-only against Donors/Donations/Organizations boards. Its ONLY Monday write is `create_item` on the Change Requests board.
- Every data read/write is scoped server-side to the authenticated session's donor item ids. Path/body params may select **among** the session's own ids, never widen them.
- All donor-visible pages that show PII set `Cache-Control: private, no-store, max-age=0` (v1 rule, see `GET /portal` in `src/routes.ts`).
- All user- or Monday-sourced strings are HTML-escaped at render (use `escapeHtml`); all attacker-reachable strings sent to Monday go through GraphQL variables, never string interpolation into the query (v1 rule, see NOTE comments in `src/monday/client.ts`).
- Never commit real donor data. Test fixtures use invented names/emails only.

---

### Task 1: Config + types groundwork (feature gates)

Adds the `taxLetter` and `changeRequests` config sections, the two new Donors-board column ids the change-request form needs, the new TypeScript types, and the two feature-gate helpers. After this task the Worker still behaves exactly as v1 — both features are configured but gated off.

**Files:**
- Modify: `config/svbc.json`
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `src/config.test.ts` (append tests)
- Modify: `src/routes.test.ts` (the `const config: Config` fixture at ~line 57 must gain the new keys or typecheck breaks)
- Modify: `src/portal/loadPortalData.test.ts`, `src/monday/client.test.ts` — ONLY if they also build a full `Config` literal; grep first: `grep -rn "const config: Config" src/`

**Interfaces:**
- Consumes: existing `Config`, `MondayColumns` from `src/types.ts`; `validateConfig` from `src/config.ts`.
- Produces (later tasks rely on these exact names):
  - `types.ts`: `TaxLetterConfig { orgLegalName: string; ein: string; orgAddress: string; signatureName: string; signatureTitle: string; plainStatement: string; benefitStatement: string; benefitTiers: string[] }`
  - `types.ts`: `ChangeRequestColumns { donorLink: string; field: string; oldValue: string; newValue: string; submittedAt: string }`
  - `types.ts`: `ChangeRequestsConfig { boardId: number | null; columns: ChangeRequestColumns; dedupeWindowHours: number }`
  - `types.ts`: `Config` gains `taxLetter: TaxLetterConfig; changeRequests: ChangeRequestsConfig`; `MondayColumns` gains `donorAddress: string; donorPhone: string`
  - `config.ts`: `lettersEnabled(config: Config): boolean`, `changeRequestsEnabled(config: Config): boolean`

- [ ] **Step 1: Write the failing tests** — append to `src/config.test.ts`:

```ts
import { lettersEnabled, changeRequestsEnabled } from './config';
// (merge into the existing import from './config' at the top of the file)

// Helper: a fully-valid v2 config fragment for these tests. Reuse the file's existing
// valid-config fixture and spread these keys in — the fixture variable name in the existing
// file is the one to extend; do not invent a second full fixture.
const v2Sections = {
  taxLetter: {
    orgLegalName: 'Silicon Valley Bicycle Coalition',
    ein: '00-0000000',
    orgAddress: '123 Example St, San Jose, CA 95112',
    signatureName: 'Alex Example',
    signatureTitle: 'Executive Director',
    plainStatement: 'No goods or services were provided in exchange for these contributions.',
    benefitStatement: 'Your membership benefits have an estimated fair-market value of $0.',
    benefitTiers: ['Champion'],
  },
  changeRequests: {
    boardId: 123,
    columns: {
      donorLink: 'connect_1',
      field: 'text_1',
      oldValue: 'text_2',
      newValue: 'text_3',
      submittedAt: 'date_1',
    },
    dedupeWindowHours: 72,
  },
};

describe('v2 config sections', () => {
  it('rejects a config missing the taxLetter section', () => {
    const cfg = structuredClone(validBase); // the file's existing valid fixture
    Object.assign(cfg, v2Sections);
    delete (cfg as Record<string, unknown>).taxLetter;
    expect(() => validateConfig(cfg)).toThrow('taxLetter');
  });

  it('rejects a config missing changeRequests.dedupeWindowHours', () => {
    const cfg = structuredClone(validBase);
    Object.assign(cfg, structuredClone(v2Sections));
    delete (cfg as { changeRequests: Record<string, unknown> }).changeRequests.dedupeWindowHours;
    expect(() => validateConfig(cfg)).toThrow('changeRequests.dedupeWindowHours');
  });

  it('accepts REPLACE_AFTER_SIGNOFF letter language (gate, not error)', () => {
    const cfg = structuredClone(validBase);
    Object.assign(cfg, structuredClone(v2Sections));
    (cfg as { taxLetter: { plainStatement: string } }).taxLetter.plainStatement = 'REPLACE_AFTER_SIGNOFF';
    expect(() => validateConfig(cfg)).not.toThrow();
  });
});

describe('lettersEnabled', () => {
  it('is true when every taxLetter field is real', () => {
    const cfg = validateConfig(Object.assign(structuredClone(validBase), structuredClone(v2Sections)));
    expect(lettersEnabled(cfg)).toBe(true);
  });

  it('is false while any taxLetter string is still REPLACE_AFTER_SIGNOFF', () => {
    const raw = Object.assign(structuredClone(validBase), structuredClone(v2Sections));
    (raw as { taxLetter: { ein: string } }).taxLetter.ein = 'REPLACE_AFTER_SIGNOFF';
    expect(lettersEnabled(validateConfig(raw))).toBe(false);
  });
});

describe('changeRequestsEnabled', () => {
  it('is true when boardId is set and no column is a placeholder', () => {
    const cfg = validateConfig(Object.assign(structuredClone(validBase), structuredClone(v2Sections)));
    expect(changeRequestsEnabled(cfg)).toBe(true);
  });

  it('is false when boardId is null', () => {
    const raw = Object.assign(structuredClone(validBase), structuredClone(v2Sections));
    (raw as { changeRequests: { boardId: number | null } }).changeRequests.boardId = null;
    expect(changeRequestsEnabled(validateConfig(raw))).toBe(false);
  });

  it('is false while a Change Requests column id is a placeholder', () => {
    const raw = Object.assign(structuredClone(validBase), structuredClone(v2Sections));
    (raw as { changeRequests: { columns: { field: string } } }).changeRequests.columns.field = 'REPLACE_WITH_COLUMN_ID';
    expect(changeRequestsEnabled(validateConfig(raw))).toBe(false);
  });

  it('is false while donorAddress/donorPhone Donors-board columns are placeholders', () => {
    const raw = Object.assign(structuredClone(validBase), structuredClone(v2Sections));
    (raw as { monday: { columns: { donorAddress: string } } }).monday.columns.donorAddress = 'REPLACE_WITH_COLUMN_ID';
    expect(changeRequestsEnabled(validateConfig(raw))).toBe(false);
  });
});
```

Adapt `validBase` to whatever the existing valid-fixture variable in `config.test.ts` is actually called; also add `donorAddress: 'text_addr'` and `donorPhone: 'phone_1'` to that fixture's `monday.columns`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/config.test.ts`
Expected: FAIL — `lettersEnabled` not exported; missing-key tests fail because `validateConfig` doesn't know `taxLetter`.

- [ ] **Step 3: Implement**

`src/types.ts` — add after the existing `MondayColumns` (and extend it):

```ts
export interface MondayColumns {
  // …existing ten keys unchanged…
  donorAddress: string;
  donorPhone: string;
}

export interface TaxLetterConfig {
  orgLegalName: string;
  ein: string;
  orgAddress: string;
  signatureName: string;
  signatureTitle: string;
  plainStatement: string;
  benefitStatement: string;
  benefitTiers: string[];
}

export interface ChangeRequestColumns {
  donorLink: string;
  field: string;
  oldValue: string;
  newValue: string;
  submittedAt: string;
}

export interface ChangeRequestsConfig {
  boardId: number | null;
  columns: ChangeRequestColumns;
  dedupeWindowHours: number;
}
```

and extend `Config` with `taxLetter: TaxLetterConfig;` and `changeRequests: ChangeRequestsConfig;`.

`src/config.ts` — extend validation and add the gates:

```ts
const REQUIRED_TOP_LEVEL = ['monday', 'resend', 'auth', 'rateLimit', 'taxLetter', 'changeRequests'] as const;

// REQUIRED_COLUMNS deliberately does NOT gain donorAddress/donorPhone: those two columns only
// matter to the change-request feature, which is gated (changeRequestsEnabled), not
// deploy-blocking. Add them to a new list checked for *presence* only:
const V2_DONOR_COLUMNS: (keyof MondayColumns)[] = ['donorAddress', 'donorPhone'];

const REQUIRED_TAX_LETTER_KEYS = [
  'orgLegalName', 'ein', 'orgAddress', 'signatureName', 'signatureTitle',
  'plainStatement', 'benefitStatement', 'benefitTiers',
] as const;
const REQUIRED_CHANGE_REQUEST_KEYS = ['boardId', 'columns', 'dedupeWindowHours'] as const;
const REQUIRED_CHANGE_REQUEST_COLUMNS = ['donorLink', 'field', 'oldValue', 'newValue', 'submittedAt'] as const;

const SIGNOFF_PLACEHOLDER = 'REPLACE_AFTER_SIGNOFF';

// Inside validateConfig, after the existing rateLimit block:
//   requireKeys(columns, 'monday.columns', V2_DONOR_COLUMNS);              // presence only
//   const taxLetter = requireObject(cfg, 'taxLetter');
//   requireKeys(taxLetter, 'taxLetter', REQUIRED_TAX_LETTER_KEYS);
//   const changeRequests = requireObject(cfg, 'changeRequests');
//   requireKeys(changeRequests, 'changeRequests', REQUIRED_CHANGE_REQUEST_KEYS);
//   const crColumns = requireObject(changeRequests, 'changeRequests.columns');
//   requireKeys(crColumns, 'changeRequests.columns', REQUIRED_CHANGE_REQUEST_COLUMNS);

export function lettersEnabled(config: Config): boolean {
  const t = config.taxLetter;
  const strings = [t.orgLegalName, t.ein, t.orgAddress, t.signatureName, t.signatureTitle, t.plainStatement, t.benefitStatement];
  return strings.every((s) => s !== SIGNOFF_PLACEHOLDER && s.length > 0);
}

export function changeRequestsEnabled(config: Config): boolean {
  const cr = config.changeRequests;
  if (cr.boardId === null) return false;
  const crCols = [cr.columns.donorLink, cr.columns.field, cr.columns.oldValue, cr.columns.newValue, cr.columns.submittedAt];
  const donorCols = [config.monday.columns.donorAddress, config.monday.columns.donorPhone];
  return [...crCols, ...donorCols].every((c) => c !== 'REPLACE_WITH_COLUMN_ID');
}
```

(`requireObject`'s error message uses the key as given — passing `'changeRequests.columns'` produces the right message; check the helper and adjust if it only takes bare keys.)

`config/svbc.json` — add to `monday.columns`:

```json
"donorAddress": "REPLACE_WITH_COLUMN_ID",
"donorPhone": "REPLACE_WITH_COLUMN_ID"
```

and add two new top-level sections:

```json
"taxLetter": {
  "orgLegalName": "Silicon Valley Bicycle Coalition",
  "ein": "REPLACE_AFTER_SIGNOFF",
  "orgAddress": "REPLACE_AFTER_SIGNOFF",
  "signatureName": "REPLACE_AFTER_SIGNOFF",
  "signatureTitle": "REPLACE_AFTER_SIGNOFF",
  "plainStatement": "REPLACE_AFTER_SIGNOFF",
  "benefitStatement": "REPLACE_AFTER_SIGNOFF",
  "benefitTiers": []
},
"changeRequests": {
  "boardId": null,
  "columns": {
    "donorLink": "REPLACE_WITH_COLUMN_ID",
    "field": "REPLACE_WITH_COLUMN_ID",
    "oldValue": "REPLACE_WITH_COLUMN_ID",
    "newValue": "REPLACE_WITH_COLUMN_ID",
    "submittedAt": "REPLACE_WITH_COLUMN_ID"
  },
  "dedupeWindowHours": 72
}
```

Then fix every test fixture that builds a full `Config` literal (at minimum `src/routes.test.ts`'s `const config: Config`): add

```ts
taxLetter: {
  orgLegalName: 'SVBC', ein: '00-0000000', orgAddress: 'addr', signatureName: 'Alex',
  signatureTitle: 'ED', plainStatement: 'plain', benefitStatement: 'benefit', benefitTiers: ['Champion'],
},
changeRequests: {
  boardId: 99,
  columns: { donorLink: 'c1', field: 'c2', oldValue: 'c3', newValue: 'c4', submittedAt: 'c5' },
  dedupeWindowHours: 72,
},
```

- [ ] **Step 4: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS (all pre-existing tests still green with the extended fixtures).

- [ ] **Step 5: Commit**

```bash
git add config/svbc.json src/types.ts src/config.ts src/config.test.ts src/routes.test.ts
git commit -m "feat(donor-portal): add v2 config sections and feature gates for letters + change requests"
```

(Include any other fixture files you had to touch.)

---

### Task 2: Letter data module

Pure logic: turn a donor's full donation history into one completed tax year's letter data, and list which letters exist. Reuses `MondayClient.getDonorPortalData` — no new Monday queries.

**Files:**
- Create: `src/letters/loadLetterData.ts`
- Test: `src/letters/loadLetterData.test.ts`

**Interfaces:**
- Consumes: `MondayClient` (`src/monday/client.ts` — only `getDonorPortalData(donorItemId): Promise<DonorPortalData>`); `TaxLetterConfig` from `src/types.ts`.
- Produces (Tasks 3–4 rely on these exact shapes):

```ts
export interface LetterGift { date: string; amount: string; }
export interface LetterData {
  donorId: string;
  donorName: string;
  year: number;
  gifts: LetterGift[];        // chronological ascending
  totalFormatted: string;     // e.g. "$1,234.56"
  statement: string;          // plain or benefit variant, chosen by tier
}
export interface LetterYearListing { donorId: string; donorName: string; years: number[]; } // desc

export function parseAmount(text: string): number;
export function giftYear(date: string): number | null;
export async function listLetterYears(donorItemIds: string[], monday: MondayClient, now: Date): Promise<LetterYearListing[]>;
export async function loadLetterData(
  donorItemId: string, year: number, monday: MondayClient, taxLetter: TaxLetterConfig, now: Date
): Promise<LetterData | null>;   // null: year not completed, or no gifts that year
```

- [ ] **Step 1: Write the failing tests** — `src/letters/loadLetterData.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { parseAmount, giftYear, listLetterYears, loadLetterData } from './loadLetterData';
import type { MondayClient } from '../monday/client';
import type { DonorPortalData, TaxLetterConfig } from '../types';

const taxLetter: TaxLetterConfig = {
  orgLegalName: 'SVBC', ein: '00-0000000', orgAddress: 'addr',
  signatureName: 'Alex', signatureTitle: 'ED',
  plainStatement: 'PLAIN-STATEMENT', benefitStatement: 'BENEFIT-STATEMENT',
  benefitTiers: ['Champion'],
};

const NOW = new Date('2026-08-24T00:00:00.000Z'); // current year 2026 → letters exist for ≤2025

function donor(overrides: Partial<DonorPortalData>): DonorPortalData {
  return {
    id: 'donor-1', name: 'Jane Example', membershipStatus: 'Active', membershipTier: 'Member',
    totalDonated: '0',
    donations: [],
    ...overrides,
  };
}

function fakeMonday(data: Record<string, DonorPortalData>): MondayClient {
  return {
    findDonorsByEmail: vi.fn(),
    getDonorPortalData: vi.fn().mockImplementation((id: string) => Promise.resolve(data[id])),
    getDiscountOrganizations: vi.fn(),
  } as unknown as MondayClient;
}

describe('parseAmount', () => {
  it('parses currency-formatted text', () => {
    expect(parseAmount('$1,234.56')).toBe(1234.56);
  });
  it('treats unparseable text as zero', () => {
    expect(parseAmount('pending')).toBe(0);
  });
});

describe('giftYear', () => {
  it('reads the year off a YYYY-MM-DD date', () => {
    expect(giftYear('2025-03-14')).toBe(2025);
  });
  it('returns null for a date it cannot read', () => {
    expect(giftYear('')).toBeNull();
  });
});

describe('loadLetterData', () => {
  const d = donor({
    donations: [
      { date: '2025-06-01', amount: '$50.00', description: 'gift' },
      { date: '2025-01-15', amount: '$25.00', description: 'gift' },
      { date: '2024-12-31', amount: '$999.00', description: 'prior year' },
      { date: '2026-02-01', amount: '$10.00', description: 'current year' },
    ],
  });

  it('includes only the requested year, ascending, with a formatted total', async () => {
    const result = await loadLetterData('donor-1', 2025, fakeMonday({ 'donor-1': d }), taxLetter, NOW);
    expect(result).not.toBeNull();
    expect(result!.gifts.map((g) => g.date)).toEqual(['2025-01-15', '2025-06-01']);
    expect(result!.totalFormatted).toBe('$75.00');
  });

  it('selects the plain statement for a non-benefit tier', async () => {
    const result = await loadLetterData('donor-1', 2025, fakeMonday({ 'donor-1': d }), taxLetter, NOW);
    expect(result!.statement).toBe('PLAIN-STATEMENT');
  });

  it('selects the benefit statement for a benefit-carrying tier', async () => {
    const champ = donor({ membershipTier: 'Champion', donations: d.donations });
    const result = await loadLetterData('donor-1', 2025, fakeMonday({ 'donor-1': champ }), taxLetter, NOW);
    expect(result!.statement).toBe('BENEFIT-STATEMENT');
  });

  it('returns null for the current (incomplete) year', async () => {
    expect(await loadLetterData('donor-1', 2026, fakeMonday({ 'donor-1': d }), taxLetter, NOW)).toBeNull();
  });

  it('returns null for a completed year with no gifts', async () => {
    expect(await loadLetterData('donor-1', 2023, fakeMonday({ 'donor-1': d }), taxLetter, NOW)).toBeNull();
  });
});

describe('listLetterYears', () => {
  it('lists completed years with gifts, newest first, per donor', async () => {
    const a = donor({
      id: 'donor-1', name: 'Jane Example',
      donations: [
        { date: '2024-05-01', amount: '$5', description: '' },
        { date: '2025-05-01', amount: '$5', description: '' },
        { date: '2026-01-01', amount: '$5', description: '' }, // current year: excluded
      ],
    });
    const b = donor({ id: 'donor-2', name: 'Sam Example', donations: [] });
    const result = await listLetterYears(['donor-1', 'donor-2'], fakeMonday({ 'donor-1': a, 'donor-2': b }), NOW);
    expect(result).toEqual([
      { donorId: 'donor-1', donorName: 'Jane Example', years: [2025, 2024] },
      { donorId: 'donor-2', donorName: 'Sam Example', years: [] },
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/letters/loadLetterData.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement** — `src/letters/loadLetterData.ts`:

```ts
import type { MondayClient } from '../monday/client';
import type { DonationRecord, TaxLetterConfig } from '../types';

export interface LetterGift {
  date: string;
  amount: string;
}

export interface LetterData {
  donorId: string;
  donorName: string;
  year: number;
  gifts: LetterGift[];
  totalFormatted: string;
  statement: string;
}

export interface LetterYearListing {
  donorId: string;
  donorName: string;
  years: number[];
}

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function parseAmount(text: string): number {
  const n = Number(text.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

export function giftYear(date: string): number | null {
  const match = /^(\d{4})-/.exec(date);
  return match ? Number(match[1]) : null;
}

function completedYearsWithGifts(donations: DonationRecord[], now: Date): number[] {
  const currentYear = now.getUTCFullYear();
  const years = new Set<number>();
  for (const donation of donations) {
    const year = giftYear(donation.date);
    if (year !== null && year < currentYear) {
      years.add(year);
    }
  }
  return [...years].sort((a, b) => b - a);
}

export async function listLetterYears(
  donorItemIds: string[],
  monday: MondayClient,
  now: Date
): Promise<LetterYearListing[]> {
  const donors = await Promise.all(donorItemIds.map((id) => monday.getDonorPortalData(id)));
  return donors.map((donor) => ({
    donorId: donor.id,
    donorName: donor.name,
    years: completedYearsWithGifts(donor.donations, now),
  }));
}

export async function loadLetterData(
  donorItemId: string,
  year: number,
  monday: MondayClient,
  taxLetter: TaxLetterConfig,
  now: Date
): Promise<LetterData | null> {
  if (year >= now.getUTCFullYear()) {
    return null;
  }

  const donor = await monday.getDonorPortalData(donorItemId);
  const gifts = donor.donations
    .filter((donation) => giftYear(donation.date) === year)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((donation) => ({ date: donation.date, amount: donation.amount }));

  if (gifts.length === 0) {
    return null;
  }

  const total = donor.donations
    .filter((donation) => giftYear(donation.date) === year)
    .reduce((sum, donation) => sum + parseAmount(donation.amount), 0);

  const statement = taxLetter.benefitTiers.includes(donor.membershipTier)
    ? taxLetter.benefitStatement
    : taxLetter.plainStatement;

  return {
    donorId: donor.id,
    donorName: donor.name,
    year,
    gifts,
    totalFormatted: USD.format(total),
    statement,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/letters/loadLetterData.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/letters/loadLetterData.ts src/letters/loadLetterData.test.ts
git commit -m "feat(donor-portal): letter data aggregation for year-end tax letters"
```

---

### Task 3: Letter views (HTML + print CSS)

Server-rendered views for the letters list, the letter itself, and the feature-disabled state. The letter page is the printable document — `@media print` hides portal chrome and the browser's Print → Save as PDF is the delivery mechanism.

**Files:**
- Modify: `src/views.ts` — change `function escapeHtml` to `export function escapeHtml` (needed by the new view modules; no other change).
- Create: `src/letters/letterViews.ts`
- Test: `src/letters/letterViews.test.ts`

**Interfaces:**
- Consumes: `escapeHtml` from `../views`; `LetterData`, `LetterYearListing` from `./loadLetterData`; `TaxLetterConfig` from `../types`.
- Produces (Task 4 renders these):

```ts
export function lettersListView(listings: LetterYearListing[]): string;
export function letterView(data: LetterData, taxLetter: TaxLetterConfig, generatedOn: string): string;
export function lettersUnavailableView(): string;
```

- [ ] **Step 1: Write the failing tests** — `src/letters/letterViews.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { lettersListView, letterView, lettersUnavailableView } from './letterViews';
import type { LetterData } from './loadLetterData';
import type { TaxLetterConfig } from '../types';

const taxLetter: TaxLetterConfig = {
  orgLegalName: 'Silicon Valley Bicycle Coalition', ein: '00-0000000',
  orgAddress: '123 Example St, San Jose, CA 95112',
  signatureName: 'Alex Example', signatureTitle: 'Executive Director',
  plainStatement: 'No goods or services were provided.', benefitStatement: 'FMV statement.',
  benefitTiers: ['Champion'],
};

const letter: LetterData = {
  donorId: 'donor-1', donorName: 'Jane <script> Example', year: 2025,
  gifts: [
    { date: '2025-01-15', amount: '$25.00' },
    { date: '2025-06-01', amount: '$50.00' },
  ],
  totalFormatted: '$75.00',
  statement: 'No goods or services were provided.',
};

describe('lettersListView', () => {
  it('links each donor-year pair to its letter route', () => {
    const html = lettersListView([{ donorId: 'donor-1', donorName: 'Jane', years: [2025, 2024] }]);
    expect(html).toContain('/portal/letters/donor-1/2025');
    expect(html).toContain('/portal/letters/donor-1/2024');
  });

  it('shows an explicit empty state for a donor with no completed-year gifts', () => {
    const html = lettersListView([{ donorId: 'donor-2', donorName: 'Sam', years: [] }]);
    expect(html).toContain('No letters are available yet');
  });
});

describe('letterView', () => {
  it('contains the org identity, EIN, statement, gifts, and total', () => {
    const html = letterView(letter, taxLetter, 'August 24, 2026');
    expect(html).toContain('Silicon Valley Bicycle Coalition');
    expect(html).toContain('00-0000000');
    expect(html).toContain('No goods or services were provided.');
    expect(html).toContain('2025-01-15');
    expect(html).toContain('$75.00');
    expect(html).toContain('August 24, 2026');
  });

  it('escapes donor-sourced text', () => {
    const html = letterView(letter, taxLetter, 'August 24, 2026');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('has print CSS and a print button hidden from print', () => {
    const html = letterView(letter, taxLetter, 'August 24, 2026');
    expect(html).toContain('@media print');
    expect(html).toContain('window.print()');
    expect(html).toContain('class="no-print"');
  });
});

describe('lettersUnavailableView', () => {
  it('says letters are not available yet', () => {
    expect(lettersUnavailableView()).toContain('not available yet');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/letters/letterViews.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement** — export `escapeHtml` from `src/views.ts`, then create `src/letters/letterViews.ts`:

```ts
import { escapeHtml } from '../views';
import type { TaxLetterConfig } from '../types';
import type { LetterData, LetterYearListing } from './loadLetterData';

export function lettersListView(listings: LetterYearListing[]): string {
  const sections = listings
    .map((listing) => {
      const items =
        listing.years.length === 0
          ? `<p>No letters are available yet for ${escapeHtml(listing.donorName)} — letters cover completed calendar years with at least one donation.</p>`
          : `<ul>${listing.years
              .map(
                (year) =>
                  `<li><a href="/portal/letters/${encodeURIComponent(listing.donorId)}/${year}">${year} tax letter</a></li>`
              )
              .join('')}</ul>`;
      return `<section><h2>${escapeHtml(listing.donorName)}</h2>${items}</section>`;
    })
    .join('');

  return `
    <h1>Tax documents</h1>
    <p>Each letter is a consolidated acknowledgment of the donations our records show for that
    calendar year. Open a letter and use your browser's Print option to print it or save it as
    a PDF.</p>
    ${sections}
    <p><a href="/portal">Back to your portal</a></p>
  `;
}

export function letterView(data: LetterData, taxLetter: TaxLetterConfig, generatedOn: string): string {
  const rows = data.gifts
    .map((gift) => `<tr><td>${escapeHtml(gift.date)}</td><td>${escapeHtml(gift.amount)}</td></tr>`)
    .join('');

  return `
    <style>
      .letter { font-family: Georgia, 'Times New Roman', serif; max-width: 42rem; margin: 0 auto; line-height: 1.5; }
      .letter table { border-collapse: collapse; width: 100%; }
      .letter th, .letter td { text-align: left; padding: 0.25rem 1rem 0.25rem 0; border-bottom: 1px solid #ccc; }
      .letter tr { page-break-inside: avoid; }
      .letter .total { font-weight: bold; }
      @page { size: letter; margin: 1in; }
      @media print {
        .no-print { display: none; }
      }
    </style>
    <nav class="no-print">
      <a href="/portal/letters">Back to tax documents</a>
      <button type="button" onclick="window.print()">Print or save as PDF</button>
    </nav>
    <article class="letter">
      <header>
        <p><strong>${escapeHtml(taxLetter.orgLegalName)}</strong><br>
        ${escapeHtml(taxLetter.orgAddress)}<br>
        EIN: ${escapeHtml(taxLetter.ein)}</p>
      </header>
      <p>${escapeHtml(generatedOn)}</p>
      <p>Dear ${escapeHtml(data.donorName)},</p>
      <p>Thank you for supporting ${escapeHtml(taxLetter.orgLegalName)}. Our records show the
      following contributions from you during the ${data.year} calendar year:</p>
      <table>
        <thead><tr><th>Date</th><th>Amount</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="total">Total contributions for ${data.year}: ${escapeHtml(data.totalFormatted)}</p>
      <p>${escapeHtml(data.statement)}</p>
      <p>Please retain this letter for your tax records. If anything here looks incorrect,
      contact us and we will review it.</p>
      <p>Sincerely,<br>
      ${escapeHtml(taxLetter.signatureName)}<br>
      ${escapeHtml(taxLetter.signatureTitle)}, ${escapeHtml(taxLetter.orgLegalName)}</p>
      <footer><p><small>Generated from ${escapeHtml(taxLetter.orgLegalName)}'s records on ${escapeHtml(generatedOn)}.</small></p></footer>
    </article>
  `;
}

export function lettersUnavailableView(): string {
  return `
    <h1>Tax documents</h1>
    <p>Year-end tax letters are not available yet. Please check back soon, or contact us if you
    need a giving summary in the meantime.</p>
    <p><a href="/portal">Back to your portal</a></p>
  `;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/letters/letterViews.test.ts && npm test -- src/views.test.ts && npm run typecheck`
Expected: PASS (including the untouched views tests after the `escapeHtml` export change).

- [ ] **Step 5: Commit**

```bash
git add src/views.ts src/letters/letterViews.ts src/letters/letterViews.test.ts
git commit -m "feat(donor-portal): letter list and printable letter views with print CSS"
```

---

### Task 4: Letter routes + session helper refactor

Wire the two letter routes into the Hono app, extracting the session check that `GET /portal` already does into a shared helper (three more routes need it in this plan).

**Files:**
- Modify: `src/routes.ts`
- Test: `src/routes.test.ts` (append)

**Interfaces:**
- Consumes: `lettersEnabled` (Task 1), `listLetterYears`/`loadLetterData` (Task 2), `lettersListView`/`letterView`/`lettersUnavailableView` (Task 3), existing `AppDeps`, `sha256Hex`, `errorView`.
- Produces: routes `GET /portal/letters` and `GET /portal/letters/:donorItemId/:year`; module-private helper `getSessionDonorIds(c, deps): Promise<string[] | null>` used by `/portal` and all new authenticated routes (Task 8 uses it too — same name).

- [ ] **Step 1: Write the failing tests** — append to `src/routes.test.ts`. Reuse the file's existing `makeDeps`, `fakeMonday`, and login-flow helpers; add a small helper that performs the full login and returns the session cookie:

```ts
async function loginAndGetCookie(app: ReturnType<typeof createApp>, emailSender: { sendLoginEmail: ReturnType<typeof vi.fn> }, email: string): Promise<string> {
  await app.request('/login', {
    method: 'POST',
    body: new URLSearchParams({ email }),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const loginUrl = emailSender.sendLoginEmail.mock.calls[0]![0].loginUrl;
  const callbackRes = await app.request(`/auth/callback?token=${extractToken(loginUrl)}`);
  return (callbackRes.headers.get('set-cookie') as string).split(';')[0]!;
}

// fakeMonday's getDonorPortalData mock must, for these tests, return donations so letters
// exist. Extend fakeMonday (or build a variant) so donations for donor-1 include:
//   { date: '2025-03-14', amount: '$40.00', description: 'gift' }

describe('GET /portal/letters', () => {
  it('redirects to /login without a session', async () => {
    const res = await createApp(makeDeps()).request('/portal/letters');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('lists a completed year for the logged-in donor with no-store caching', async () => {
    const monday = fakeMondayWithDonations(); // the variant described above
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/portal/letters', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('/portal/letters/donor-1/2025');
    expect(res.headers.get('cache-control')).toBe('private, no-store, max-age=0');
  });

  it('shows the unavailable state while letter language is placeholder', async () => {
    const gatedConfig = structuredClone(config);
    gatedConfig.taxLetter.plainStatement = 'REPLACE_AFTER_SIGNOFF';
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender, config: gatedConfig }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/portal/letters', { headers: { Cookie: cookie } });
    expect(await res.text()).toContain('not available yet');
  });
});

describe('GET /portal/letters/:donorItemId/:year', () => {
  it('renders the letter for the session donor and a completed year', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/portal/letters/donor-1/2025', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Total contributions for 2025');
    expect(res.headers.get('cache-control')).toBe('private, no-store, max-age=0');
  });

  it("404s for a donor item id that is not the session's own", async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/portal/letters/other-donor/2025', { headers: { Cookie: cookie } });
    expect(res.status).toBe(404);
  });

  it('404s for the current (incomplete) year', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/portal/letters/donor-1/2026', { headers: { Cookie: cookie } });
    expect(res.status).toBe(404);
  });

  it('404s for a non-numeric year', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/portal/letters/donor-1/not-a-year', { headers: { Cookie: cookie } });
    expect(res.status).toBe(404);
  });
});
```

`fakeMondayWithDonations()` wraps the existing `fakeMonday` with `matchesByEmail = { 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] }` and a `getDonorPortalData` mock whose `donations` array contains the 2025 gift shown above. Write it once at the top of the new describe blocks.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/routes.test.ts`
Expected: new tests FAIL (404 from Hono for unknown routes); pre-existing tests PASS.

- [ ] **Step 3: Implement** in `src/routes.ts`:

Add imports:

```ts
import type { Context } from 'hono';
import { lettersEnabled } from './config';
import { listLetterYears, loadLetterData } from './letters/loadLetterData';
import { letterView, lettersListView, lettersUnavailableView } from './letters/letterViews';
```

Add the helper above `createApp` and refactor `GET /portal` to use it:

```ts
const NO_STORE = 'private, no-store, max-age=0';

async function getSessionDonorIds(c: Context, deps: AppDeps): Promise<string[] | null> {
  const sessionToken = getCookie(c, SESSION_COOKIE);
  if (!sessionToken) return null;
  return deps.sessionStore.getSession(await sha256Hex(sessionToken), deps.now().toISOString());
}
```

(`GET /portal` becomes: `const donorItemIds = await getSessionDonorIds(c, deps); if (donorItemIds === null) return c.redirect('/login');` — behavior identical.)

Add the routes inside `createApp`:

```ts
app.get('/portal/letters', async (c) => {
  const donorItemIds = await getSessionDonorIds(c, deps);
  if (donorItemIds === null) return c.redirect('/login');

  c.header('Cache-Control', NO_STORE);
  if (!lettersEnabled(deps.config)) {
    return c.html(lettersUnavailableView());
  }
  const listings = await listLetterYears(donorItemIds, deps.monday, deps.now());
  return c.html(lettersListView(listings));
});

app.get('/portal/letters/:donorItemId/:year', async (c) => {
  const donorItemIds = await getSessionDonorIds(c, deps);
  if (donorItemIds === null) return c.redirect('/login');

  c.header('Cache-Control', NO_STORE);
  if (!lettersEnabled(deps.config)) {
    return c.html(lettersUnavailableView());
  }

  // The path param selects among the session's own donor items — never widens them.
  const donorItemId = c.req.param('donorItemId');
  const yearParam = c.req.param('year');
  const year = /^\d{4}$/.test(yearParam) ? Number(yearParam) : null;
  if (!donorItemIds.includes(donorItemId) || year === null) {
    return c.html(errorView('That letter does not exist.'), 404);
  }

  const data = await loadLetterData(donorItemId, year, deps.monday, deps.config.taxLetter, deps.now());
  if (data === null) {
    return c.html(errorView('That letter does not exist.'), 404);
  }

  const generatedOn = deps.now().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
  return c.html(letterView(data, deps.config.taxLetter, generatedOn));
});
```

Also add a link to the portal page so donors can find it — in `src/views.ts` `portalView`, before the logout form:

```html
<p><a href="/portal/letters">Tax documents</a></p>
```

- [ ] **Step 4: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes.ts src/routes.test.ts src/views.ts
git commit -m "feat(donor-portal): letter list and letter routes with session scoping"
```

---

### Task 5: Change-requests D1 migration + store

The durable request record: audit trail, dedupe, and the consumer's idempotency marker.

**Files:**
- Create: `migrations/0002_create_change_requests.sql`
- Create: `src/db/changeRequests.ts`
- Test: `src/db/changeRequests.test.ts`

**Interfaces:**
- Consumes: `D1Database` (Workers types); test env via `cloudflare:workers` (see `src/db/sessions.test.ts` for the idiom — migrations are applied by `test/apply-migrations.ts` automatically once the SQL file exists).
- Produces (Tasks 7 and 9 rely on these exact shapes):

```ts
export type ChangeRequestField = 'address' | 'email' | 'phone';
export interface NewChangeRequest {
  donorItemId: string; donorName: string; field: ChangeRequestField;
  oldValue: string; newValue: string; dedupeHash: string; createdAt: string;
}
export interface ChangeRequestRow {
  id: number; donorItemId: string; donorName: string; field: ChangeRequestField;
  oldValue: string; newValue: string; status: 'queued' | 'written';
}
export interface ChangeRequestStore {
  createRequest(params: NewChangeRequest): Promise<number>;          // returns row id
  hasRecentDuplicate(dedupeHash: string, sinceISO: string): Promise<boolean>;
  getRequest(id: number): Promise<ChangeRequestRow | null>;
  markWritten(id: number, writtenAtISO: string): Promise<void>;
}
export class D1ChangeRequestStore implements ChangeRequestStore { constructor(db: D1Database) }
```

- [ ] **Step 1: Write the migration** — `migrations/0002_create_change_requests.sql`:

```sql
CREATE TABLE change_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  donor_item_id TEXT NOT NULL,
  donor_name TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT NOT NULL,
  new_value TEXT NOT NULL,
  dedupe_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at TEXT NOT NULL,
  written_at TEXT
);

CREATE INDEX idx_change_requests_dedupe ON change_requests (dedupe_hash, created_at);
```

- [ ] **Step 2: Write the failing tests** — `src/db/changeRequests.test.ts` (same idiom as `sessions.test.ts`):

```ts
import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1ChangeRequestStore } from './changeRequests';

function newRequest(overrides: Partial<Parameters<D1ChangeRequestStore['createRequest']>[0]> = {}) {
  return {
    donorItemId: 'donor-1',
    donorName: 'Jane Example',
    field: 'address' as const,
    oldValue: '1 Old St',
    newValue: '2 New Ave',
    dedupeHash: 'hash-a',
    createdAt: '2026-08-24T10:00:00.000Z',
    ...overrides,
  };
}

describe('D1ChangeRequestStore', () => {
  it('creates a request and reads it back as queued', async () => {
    const store = new D1ChangeRequestStore(env.DB);
    const id = await store.createRequest(newRequest());
    const row = await store.getRequest(id);
    expect(row).toEqual({
      id,
      donorItemId: 'donor-1',
      donorName: 'Jane Example',
      field: 'address',
      oldValue: '1 Old St',
      newValue: '2 New Ave',
      status: 'queued',
    });
  });

  it('returns null for an unknown id', async () => {
    const store = new D1ChangeRequestStore(env.DB);
    expect(await store.getRequest(999_999)).toBeNull();
  });

  it('finds a duplicate inside the window and not outside it', async () => {
    const store = new D1ChangeRequestStore(env.DB);
    await store.createRequest(newRequest({ dedupeHash: 'hash-window', createdAt: '2026-08-24T10:00:00.000Z' }));
    expect(await store.hasRecentDuplicate('hash-window', '2026-08-24T00:00:00.000Z')).toBe(true);
    expect(await store.hasRecentDuplicate('hash-window', '2026-08-25T00:00:00.000Z')).toBe(false);
    expect(await store.hasRecentDuplicate('other-hash', '2026-08-24T00:00:00.000Z')).toBe(false);
  });

  it('marks a request written', async () => {
    const store = new D1ChangeRequestStore(env.DB);
    const id = await store.createRequest(newRequest({ dedupeHash: 'hash-written' }));
    await store.markWritten(id, '2026-08-24T11:00:00.000Z');
    expect((await store.getRequest(id))!.status).toBe('written');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- src/db/changeRequests.test.ts`
Expected: FAIL — module does not exist. (If it fails with "no such table", the migrations setup didn't pick up the new SQL file — check `test/apply-migrations.ts` reads all of `migrations/`.)

- [ ] **Step 4: Implement** — `src/db/changeRequests.ts`:

```ts
export type ChangeRequestField = 'address' | 'email' | 'phone';

export interface NewChangeRequest {
  donorItemId: string;
  donorName: string;
  field: ChangeRequestField;
  oldValue: string;
  newValue: string;
  dedupeHash: string;
  createdAt: string;
}

export interface ChangeRequestRow {
  id: number;
  donorItemId: string;
  donorName: string;
  field: ChangeRequestField;
  oldValue: string;
  newValue: string;
  status: 'queued' | 'written';
}

export interface ChangeRequestStore {
  createRequest(params: NewChangeRequest): Promise<number>;
  hasRecentDuplicate(dedupeHash: string, sinceISO: string): Promise<boolean>;
  getRequest(id: number): Promise<ChangeRequestRow | null>;
  markWritten(id: number, writtenAtISO: string): Promise<void>;
}

export class D1ChangeRequestStore implements ChangeRequestStore {
  constructor(private db: D1Database) {}

  async createRequest(params: NewChangeRequest): Promise<number> {
    const result = await this.db
      .prepare(
        `INSERT INTO change_requests (donor_item_id, donor_name, field, old_value, new_value, dedupe_hash, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
      )
      .bind(
        params.donorItemId,
        params.donorName,
        params.field,
        params.oldValue,
        params.newValue,
        params.dedupeHash,
        params.createdAt
      )
      .run();
    return result.meta.last_row_id;
  }

  async hasRecentDuplicate(dedupeHash: string, sinceISO: string): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT 1 AS found FROM change_requests WHERE dedupe_hash = ?1 AND created_at > ?2 LIMIT 1`)
      .bind(dedupeHash, sinceISO)
      .first<{ found: number }>();
    return row !== null;
  }

  async getRequest(id: number): Promise<ChangeRequestRow | null> {
    const row = await this.db
      .prepare(
        `SELECT id, donor_item_id, donor_name, field, old_value, new_value, status
         FROM change_requests WHERE id = ?1`
      )
      .bind(id)
      .first<{
        id: number;
        donor_item_id: string;
        donor_name: string;
        field: ChangeRequestField;
        old_value: string;
        new_value: string;
        status: 'queued' | 'written';
      }>();
    if (row === null) return null;
    return {
      id: row.id,
      donorItemId: row.donor_item_id,
      donorName: row.donor_name,
      field: row.field,
      oldValue: row.old_value,
      newValue: row.new_value,
      status: row.status,
    };
  }

  async markWritten(id: number, writtenAtISO: string): Promise<void> {
    await this.db
      .prepare(`UPDATE change_requests SET status = 'written', written_at = ?1 WHERE id = ?2`)
      .bind(writtenAtISO, id)
      .run();
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- src/db/changeRequests.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add migrations/0002_create_change_requests.sql src/db/changeRequests.ts src/db/changeRequests.test.ts
git commit -m "feat(donor-portal): change_requests table and D1 store"
```

---

### Task 6: Monday client — contact info read + change-request item write

Two new `MondayClient` methods: read a donor's current contact fields (for the form's old values), and the Worker's single write — `create_item` on the Change Requests board.

**Files:**
- Modify: `src/monday/client.ts`
- Modify: `src/types.ts` (add `DonorContactInfo`)
- Test: `src/monday/client.test.ts` (append; follow the file's existing fetch-mock idiom — read it first and reuse its helper for stubbing `fetchFn`)

**Interfaces:**
- Consumes: existing `HttpMondayClient` constructor and `request` helper; `ChangeRequestColumns` from `../types`.
- Produces:

```ts
// types.ts
export interface DonorContactInfo { id: string; name: string; email: string; address: string; phone: string; }

// client.ts — added to the MondayClient interface (every fake in tests gains these two methods)
getDonorContactInfo(donorItemId: string): Promise<DonorContactInfo>;
createChangeRequestItem(params: {
  boardId: number;
  columns: ChangeRequestColumns;
  itemName: string;
  donorItemId: string;
  fieldLabel: string;
  oldValue: string;
  newValue: string;
  submittedAtISO: string;
}): Promise<void>;
```

- [ ] **Step 1: Write the failing tests** — append to `src/monday/client.test.ts`, reusing its existing constructor/fetch-stub helpers (the constructor takes `fetchFn` as its last argument):

```ts
describe('getDonorContactInfo', () => {
  it('reads name, email, address, and phone off the donor item', async () => {
    // Stub fetchFn to return this GraphQL data payload (adapt to the file's stub helper):
    const payload = {
      data: {
        items: [
          {
            id: 'donor-1',
            name: 'Jane Example',
            column_values: [
              { id: 'email_col', text: 'jane@example.org' },
              { id: 'addr_col', text: '1 Old St' },
              { id: 'phone_col', text: '555-0100' },
            ],
          },
        ],
      },
    };
    // columns fixture for this test: donorEmail: 'email_col', donorAddress: 'addr_col', donorPhone: 'phone_col'
    const client = makeClient(payload); // the file's existing helper name may differ — reuse it
    const info = await client.getDonorContactInfo('donor-1');
    expect(info).toEqual({
      id: 'donor-1',
      name: 'Jane Example',
      email: 'jane@example.org',
      address: '1 Old St',
      phone: '555-0100',
    });
  });

  it('throws when the donor item does not exist', async () => {
    const client = makeClient({ data: { items: [] } });
    await expect(client.getDonorContactInfo('missing')).rejects.toThrow('not found');
  });
});

describe('createChangeRequestItem', () => {
  it('sends a create_item mutation with JSON column values and no interpolated user input', async () => {
    let captured: { query: string; variables: Record<string, unknown> } | null = null;
    // Stub fetchFn to capture JSON.parse(init.body) into `captured` and return { data: { create_item: { id: '1' } } }
    const client = makeCapturingClient((body) => { captured = body; });

    await client.createChangeRequestItem({
      boardId: 123,
      columns: { donorLink: 'connect_1', field: 'text_1', oldValue: 'text_2', newValue: 'text_3', submittedAt: 'date_1' },
      itemName: 'Address change — Jane Example',
      donorItemId: '4567',
      fieldLabel: 'Address',
      oldValue: '1 Old St',
      newValue: '2 New "Ave"',
      submittedAtISO: '2026-08-24T10:15:30.000Z',
    });

    expect(captured).not.toBeNull();
    // User-sourced strings travel as variables, never inside the query text:
    expect(captured!.query).not.toContain('2 New');
    expect(captured!.variables.itemName).toBe('Address change — Jane Example');
    const columnValues = JSON.parse(captured!.variables.columnValues as string) as Record<string, unknown>;
    expect(columnValues.connect_1).toEqual({ item_ids: [4567] });
    expect(columnValues.text_1).toBe('Address');
    expect(columnValues.text_2).toBe('1 Old St');
    expect(columnValues.text_3).toBe('2 New "Ave"');
    expect(columnValues.date_1).toEqual({ date: '2026-08-24', time: '10:15:30' });
  });
});
```

Write `makeCapturingClient` beside the tests if the file has no capturing stub yet: a `fetchFn` that records the parsed request body and resolves with `new Response(JSON.stringify({ data: { create_item: { id: '1' } } }))`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/monday/client.test.ts`
Expected: FAIL — methods do not exist.

- [ ] **Step 3: Implement** — add `DonorContactInfo` to `src/types.ts` (shape above), then in `src/monday/client.ts` extend the `MondayClient` interface and add to `HttpMondayClient`:

```ts
async getDonorContactInfo(donorItemId: string): Promise<DonorContactInfo> {
  const query = `
    query ($itemId: ID!) {
      items(ids: [$itemId]) {
        id
        name
        column_values(ids: ["${this.columns.donorEmail}", "${this.columns.donorAddress}", "${this.columns.donorPhone}"]) {
          id
          text
        }
      }
    }
  `;
  const data = await this.request<{ items: MondayItem[] }>(query, { itemId: donorItemId });
  const item = data.items[0];
  if (!item) {
    throw new Error(`monday: donor item "${donorItemId}" not found`);
  }
  return {
    id: item.id,
    name: item.name,
    email: columnText(item, this.columns.donorEmail),
    address: columnText(item, this.columns.donorAddress),
    phone: columnText(item, this.columns.donorPhone),
  };
}

async createChangeRequestItem(params: {
  boardId: number;
  columns: ChangeRequestColumns;
  itemName: string;
  donorItemId: string;
  fieldLabel: string;
  oldValue: string;
  newValue: string;
  submittedAtISO: string;
}): Promise<void> {
  // NOTE: the column_values shapes below (connect-boards { item_ids }, date { date, time })
  // are written from current Monday API v2 knowledge but not verified against a live account —
  // verify against the real Change Requests board before deploy (same caveat as the read-side
  // NOTEs above). All user-sourced values travel as GraphQL variables.
  const mutation = `
    mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
      create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues) {
        id
      }
    }
  `;
  const columnValues: Record<string, unknown> = {
    [params.columns.donorLink]: { item_ids: [Number(params.donorItemId)] },
    [params.columns.field]: params.fieldLabel,
    [params.columns.oldValue]: params.oldValue,
    [params.columns.newValue]: params.newValue,
    [params.columns.submittedAt]: {
      date: params.submittedAtISO.slice(0, 10),
      time: params.submittedAtISO.slice(11, 19),
    },
  };
  await this.request<{ create_item: { id: string } }>(mutation, {
    boardId: params.boardId,
    itemName: params.itemName,
    columnValues: JSON.stringify(columnValues),
  });
}
```

Import `ChangeRequestColumns` and `DonorContactInfo` from `../types`. Then extend every `MondayClient` fake in the test files that build one (at minimum `src/routes.test.ts`'s `fakeMonday`) with:

```ts
getDonorContactInfo: vi.fn().mockImplementation((id: string) =>
  Promise.resolve({ id, name: `Donor ${id}`, email: 'donor@example.org', address: '1 Old St', phone: '555-0100' })
),
createChangeRequestItem: vi.fn().mockResolvedValue(undefined),
```

- [ ] **Step 4: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/monday/client.ts src/monday/client.test.ts src/types.ts src/routes.test.ts
git commit -m "feat(donor-portal): monday contact-info read and change-request item write"
```

---

### Task 7: submitChangeRequest module

The write-path brain: whitelist + length validation, session scoping, dedupe, D1 insert, queue send. Pure module with injected deps, mirroring `requestLogin`'s shape.

**Files:**
- Create: `src/changeRequests/submitChangeRequest.ts`
- Test: `src/changeRequests/submitChangeRequest.test.ts`

**Interfaces:**
- Consumes: `ChangeRequestStore`, `ChangeRequestField` (Task 5); `MondayClient.getDonorContactInfo` (Task 6); `sha256Hex` from `../crypto/hash`.
- Produces (Tasks 8–9 rely on these):

```ts
export interface ChangeQueueMessage { requestId: number; }
export type SubmitResult =
  | { kind: 'submitted' }
  | { kind: 'duplicate' }
  | { kind: 'invalid'; message: string };
export const FIELD_LABELS: Record<ChangeRequestField, string>; // address→'Address', email→'Email', phone→'Phone'
export const MAX_NEW_VALUE_LENGTH = 500;
export interface SubmitDeps {
  monday: MondayClient;
  store: ChangeRequestStore;
  queue: { send(message: ChangeQueueMessage): Promise<void> };
  dedupeWindowHours: number;
  now: () => Date;
}
export async function submitChangeRequest(
  sessionDonorIds: string[],
  input: { donorItemId: string; field: string; newValue: string },
  deps: SubmitDeps
): Promise<SubmitResult>;
```

- [ ] **Step 1: Write the failing tests** — `src/changeRequests/submitChangeRequest.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { submitChangeRequest, MAX_NEW_VALUE_LENGTH } from './submitChangeRequest';
import type { ChangeRequestStore } from '../db/changeRequests';
import type { MondayClient } from '../monday/client';

function fakeStore(overrides: Partial<ChangeRequestStore> = {}): ChangeRequestStore {
  return {
    createRequest: vi.fn().mockResolvedValue(42),
    hasRecentDuplicate: vi.fn().mockResolvedValue(false),
    getRequest: vi.fn().mockResolvedValue(null),
    markWritten: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function fakeMonday(): MondayClient {
  return {
    getDonorContactInfo: vi.fn().mockResolvedValue({
      id: 'donor-1', name: 'Jane Example', email: 'jane@example.org', address: '1 Old St', phone: '555-0100',
    }),
  } as unknown as MondayClient;
}

function makeDeps(store = fakeStore()) {
  return {
    store,
    monday: fakeMonday(),
    queue: { send: vi.fn().mockResolvedValue(undefined) },
    dedupeWindowHours: 72,
    now: () => new Date('2026-08-24T10:00:00.000Z'),
  };
}

describe('submitChangeRequest', () => {
  it('records the request with the current Monday value as old_value and enqueues it', async () => {
    const store = fakeStore();
    const deps = makeDeps(store);
    const result = await submitChangeRequest(['donor-1'], { donorItemId: 'donor-1', field: 'address', newValue: ' 2 New Ave ' }, deps);

    expect(result).toEqual({ kind: 'submitted' });
    expect(store.createRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        donorItemId: 'donor-1',
        donorName: 'Jane Example',
        field: 'address',
        oldValue: '1 Old St',
        newValue: '2 New Ave', // trimmed
        createdAt: '2026-08-24T10:00:00.000Z',
      })
    );
    expect(deps.queue.send).toHaveBeenCalledWith({ requestId: 42 });
  });

  it('rejects a donor item id outside the session', async () => {
    const deps = makeDeps();
    const result = await submitChangeRequest(['donor-1'], { donorItemId: 'other', field: 'address', newValue: 'x' }, deps);
    expect(result.kind).toBe('invalid');
    expect(deps.queue.send).not.toHaveBeenCalled();
  });

  it('rejects an unknown field', async () => {
    const result = await submitChangeRequest(['donor-1'], { donorItemId: 'donor-1', field: 'ssn', newValue: 'x' }, makeDeps());
    expect(result.kind).toBe('invalid');
  });

  it('rejects an empty and an oversized new value', async () => {
    const deps = makeDeps();
    expect((await submitChangeRequest(['donor-1'], { donorItemId: 'donor-1', field: 'phone', newValue: '   ' }, deps)).kind).toBe('invalid');
    const oversized = 'x'.repeat(MAX_NEW_VALUE_LENGTH + 1);
    expect((await submitChangeRequest(['donor-1'], { donorItemId: 'donor-1', field: 'phone', newValue: oversized }, deps)).kind).toBe('invalid');
  });

  it('reports a duplicate inside the dedupe window without inserting or enqueueing', async () => {
    const store = fakeStore({ hasRecentDuplicate: vi.fn().mockResolvedValue(true) });
    const deps = makeDeps(store);
    const result = await submitChangeRequest(['donor-1'], { donorItemId: 'donor-1', field: 'address', newValue: '2 New Ave' }, deps);
    expect(result).toEqual({ kind: 'duplicate' });
    expect(store.createRequest).not.toHaveBeenCalled();
    expect(deps.queue.send).not.toHaveBeenCalled();
  });

  it('computes the dedupe window from config hours', async () => {
    const store = fakeStore();
    const deps = makeDeps(store);
    await submitChangeRequest(['donor-1'], { donorItemId: 'donor-1', field: 'address', newValue: '2 New Ave' }, deps);
    const sinceISO = (store.hasRecentDuplicate as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(sinceISO).toBe('2026-08-21T10:00:00.000Z'); // now − 72h
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/changeRequests/submitChangeRequest.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement** — `src/changeRequests/submitChangeRequest.ts`:

```ts
import type { MondayClient } from '../monday/client';
import type { ChangeRequestField, ChangeRequestStore } from '../db/changeRequests';
import { sha256Hex } from '../crypto/hash';

export interface ChangeQueueMessage {
  requestId: number;
}

export type SubmitResult =
  | { kind: 'submitted' }
  | { kind: 'duplicate' }
  | { kind: 'invalid'; message: string };

export const FIELD_LABELS: Record<ChangeRequestField, string> = {
  address: 'Address',
  email: 'Email',
  phone: 'Phone',
};

export const MAX_NEW_VALUE_LENGTH = 500;

export interface SubmitDeps {
  monday: MondayClient;
  store: ChangeRequestStore;
  queue: { send(message: ChangeQueueMessage): Promise<void> };
  dedupeWindowHours: number;
  now: () => Date;
}

function isChangeRequestField(value: string): value is ChangeRequestField {
  return value in FIELD_LABELS;
}

export async function submitChangeRequest(
  sessionDonorIds: string[],
  input: { donorItemId: string; field: string; newValue: string },
  deps: SubmitDeps
): Promise<SubmitResult> {
  // The donorItemId selects among the session's own donor items — never widens them.
  if (!sessionDonorIds.includes(input.donorItemId)) {
    return { kind: 'invalid', message: 'Unknown donor record.' };
  }
  if (!isChangeRequestField(input.field)) {
    return { kind: 'invalid', message: 'Unknown field.' };
  }
  const newValue = input.newValue.trim();
  if (newValue.length === 0 || newValue.length > MAX_NEW_VALUE_LENGTH) {
    return { kind: 'invalid', message: `Please enter a value up to ${MAX_NEW_VALUE_LENGTH} characters.` };
  }

  const now = deps.now();
  const dedupeHash = await sha256Hex(`${input.donorItemId}|${input.field}|${newValue}`);
  const sinceISO = new Date(now.getTime() - deps.dedupeWindowHours * 3600 * 1000).toISOString();
  if (await deps.store.hasRecentDuplicate(dedupeHash, sinceISO)) {
    return { kind: 'duplicate' };
  }

  const contact = await deps.monday.getDonorContactInfo(input.donorItemId);
  const oldValue = { address: contact.address, email: contact.email, phone: contact.phone }[input.field];

  const requestId = await deps.store.createRequest({
    donorItemId: input.donorItemId,
    donorName: contact.name,
    field: input.field,
    oldValue,
    newValue,
    dedupeHash,
    createdAt: now.toISOString(),
  });

  // If this send throws, the route surfaces an error and the D1 row stays 'queued' — visible,
  // not silently dropped (spec: Error handling).
  await deps.queue.send({ requestId });
  return { kind: 'submitted' };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/changeRequests/submitChangeRequest.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/changeRequests/submitChangeRequest.ts src/changeRequests/submitChangeRequest.test.ts
git commit -m "feat(donor-portal): change-request validation, dedupe, and enqueue"
```

---

### Task 8: Change-request views + routes

The donor-facing form and its POST handler, gated on `changeRequestsEnabled`, rate-limited per IP via the existing Workers rate limiter binding (key-prefixed so login and change-request budgets stay separate).

**Files:**
- Create: `src/changeRequests/changeRequestViews.ts`
- Test: `src/changeRequests/changeRequestViews.test.ts`
- Modify: `src/routes.ts` (two routes + new `AppDeps` member)
- Modify: `src/routes.test.ts` (append; `makeDeps` gains the new member)

**Interfaces:**
- Consumes: `getSessionDonorIds` (Task 4), `changeRequestsEnabled` (Task 1), `submitChangeRequest`/`SubmitResult`/`ChangeQueueMessage` (Task 7), `DonorContactInfo` (Task 6), `escapeHtml`.
- Produces:
  - Views: `changeRequestFormView(donors: DonorContactInfo[]): string`, `changeRequestResultView(result: SubmitResult): string`, `changeRequestsUnavailableView(): string`
  - `AppDeps` gains `changeQueue: { send(message: ChangeQueueMessage): Promise<void> }` and `changeStore: ChangeRequestStore` (Task 9 wires the real ones)
  - Routes: `GET /portal/change-request`, `POST /portal/change-request`

- [ ] **Step 1: Write the failing view tests** — `src/changeRequests/changeRequestViews.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { changeRequestFormView, changeRequestResultView, changeRequestsUnavailableView } from './changeRequestViews';

const donors = [
  { id: 'donor-1', name: 'Jane <b>Example</b>', email: 'jane@example.org', address: '1 Old St', phone: '555-0100' },
  { id: 'donor-2', name: 'Sam Example', email: 'jane@example.org', address: '2 Shared Rd', phone: '' },
];

describe('changeRequestFormView', () => {
  it('shows each donor with their current values, escaped', () => {
    const html = changeRequestFormView(donors);
    expect(html).toContain('1 Old St');
    expect(html).toContain('2 Shared Rd');
    expect(html).not.toContain('<b>Example</b>');
    expect(html).toContain('&lt;b&gt;Example&lt;/b&gt;');
  });

  it('posts back to the change-request route with the three expected fields', () => {
    const html = changeRequestFormView(donors);
    expect(html).toContain('action="/portal/change-request"');
    expect(html).toContain('name="donorItemId"');
    expect(html).toContain('name="field"');
    expect(html).toContain('name="newValue"');
  });
});

describe('changeRequestResultView', () => {
  it('confirms a submitted request and sets expectations about staff review', () => {
    const html = changeRequestResultView({ kind: 'submitted' });
    expect(html).toContain('review');
  });
  it('explains a duplicate', () => {
    expect(changeRequestResultView({ kind: 'duplicate' })).toContain('already');
  });
  it('shows the validation message', () => {
    expect(changeRequestResultView({ kind: 'invalid', message: 'Unknown field.' })).toContain('Unknown field.');
  });
});

describe('changeRequestsUnavailableView', () => {
  it('says the feature is not available yet', () => {
    expect(changeRequestsUnavailableView()).toContain('not available yet');
  });
});
```

- [ ] **Step 2: Run view tests to verify they fail**

Run: `npm test -- src/changeRequests/changeRequestViews.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the views** — `src/changeRequests/changeRequestViews.ts`:

```ts
import { escapeHtml } from '../views';
import type { DonorContactInfo } from '../types';
import type { SubmitResult } from './submitChangeRequest';

function donorOption(donor: DonorContactInfo): string {
  return `<option value="${escapeHtml(donor.id)}">${escapeHtml(donor.name)}</option>`;
}

function donorCurrentValues(donor: DonorContactInfo): string {
  return `
    <section>
      <h3>${escapeHtml(donor.name)} — current details</h3>
      <dl>
        <dt>Address</dt><dd>${escapeHtml(donor.address)}</dd>
        <dt>Email</dt><dd>${escapeHtml(donor.email)}</dd>
        <dt>Phone</dt><dd>${escapeHtml(donor.phone)}</dd>
      </dl>
    </section>
  `;
}

export function changeRequestFormView(donors: DonorContactInfo[]): string {
  return `
    <h1>Request a change to your details</h1>
    <p>Submit the new value below. SVBC staff review every request before it's applied — you'll
    see the update once they've processed it.</p>
    ${donors.map(donorCurrentValues).join('')}
    <form action="/portal/change-request" method="post">
      <label>Whose record
        <select name="donorItemId" required>${donors.map(donorOption).join('')}</select>
      </label>
      <label>What to change
        <select name="field" required>
          <option value="address">Address</option>
          <option value="email">Email</option>
          <option value="phone">Phone</option>
        </select>
      </label>
      <label>New value
        <input type="text" name="newValue" maxlength="500" required />
      </label>
      <button type="submit">Submit for review</button>
    </form>
    <p>Note: an email change takes effect for portal login once staff apply it.</p>
    <p><a href="/portal">Back to your portal</a></p>
  `;
}

export function changeRequestResultView(result: SubmitResult): string {
  if (result.kind === 'submitted') {
    return `
      <h1>Request received</h1>
      <p>Thanks — SVBC staff will review your request and apply the change. This usually takes a
      few business days.</p>
      <p><a href="/portal">Back to your portal</a></p>
    `;
  }
  if (result.kind === 'duplicate') {
    return `
      <h1>Already submitted</h1>
      <p>We already have this exact request on file — staff will get to it soon. No need to
      submit it again.</p>
      <p><a href="/portal">Back to your portal</a></p>
    `;
  }
  return `
    <h1>Something needs fixing</h1>
    <p>${escapeHtml(result.message)}</p>
    <p><a href="/portal/change-request">Back to the form</a></p>
  `;
}

export function changeRequestsUnavailableView(): string {
  return `
    <h1>Request a change</h1>
    <p>Self-service change requests are not available yet. Please contact SVBC and we'll update
    your details for you.</p>
    <p><a href="/portal">Back to your portal</a></p>
  `;
}
```

- [ ] **Step 4: Run view tests to verify they pass**

Run: `npm test -- src/changeRequests/changeRequestViews.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing route tests** — append to `src/routes.test.ts` (extend `makeDeps` first: add `changeStore: fakeChangeStore()` and `changeQueue: { send: vi.fn().mockResolvedValue(undefined) }`, with `fakeChangeStore` mirroring Task 7's in-memory fake):

```ts
describe('GET /portal/change-request', () => {
  it('redirects to /login without a session', async () => {
    const res = await createApp(makeDeps()).request('/portal/change-request');
    expect(res.status).toBe(302);
  });

  it('renders the form with current values for the logged-in donor', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/portal/change-request', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('1 Old St');
    expect(res.headers.get('cache-control')).toBe('private, no-store, max-age=0');
  });

  it('shows the unavailable state when the board is not configured', async () => {
    const gatedConfig = structuredClone(config);
    gatedConfig.changeRequests.boardId = null;
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender, config: gatedConfig }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/portal/change-request', { headers: { Cookie: cookie } });
    expect(await res.text()).toContain('not available yet');
  });
});

describe('POST /portal/change-request', () => {
  function postForm(app: ReturnType<typeof createApp>, cookie: string, fields: Record<string, string>) {
    return app.request('/portal/change-request', {
      method: 'POST',
      body: new URLSearchParams(fields),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    });
  }

  it('submits a valid request and confirms', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const changeQueue = { send: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender, changeQueue }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await postForm(app, cookie, { donorItemId: 'donor-1', field: 'address', newValue: '2 New Ave' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('review');
    expect(changeQueue.send).toHaveBeenCalledOnce();
  });

  it('denies when the IP rate limiter says no', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const ipLimiter = { limit: vi.fn().mockResolvedValue({ success: false }) };
    const app = createApp(makeDeps({ monday, emailSender, ipLimiter }));
    // login also consults ipLimiter — mock success:false AFTER login, or build the cookie first
    // with a permissive limiter and swap deps. Simplest: two apps sharing sessionStore:
    const permissive = makeDeps({ monday, emailSender });
    const loginApp = createApp(permissive);
    const cookie = await loginAndGetCookie(loginApp, emailSender, 'donor@example.org');
    const limitedApp = createApp({ ...permissive, ipLimiter });

    const res = await postForm(limitedApp, cookie, { donorItemId: 'donor-1', field: 'address', newValue: '2 New Ave' });
    expect(res.status).toBe(429);
  });
});
```

- [ ] **Step 6: Run route tests to verify they fail**

Run: `npm test -- src/routes.test.ts`
Expected: new tests FAIL (unknown routes / missing deps members).

- [ ] **Step 7: Implement the routes** in `src/routes.ts`:

Extend `AppDeps`:

```ts
import type { ChangeRequestStore } from './db/changeRequests';
import type { ChangeQueueMessage } from './changeRequests/submitChangeRequest';
import { submitChangeRequest } from './changeRequests/submitChangeRequest';
import { changeRequestFormView, changeRequestResultView, changeRequestsUnavailableView } from './changeRequests/changeRequestViews';
import { changeRequestsEnabled } from './config'; // merge into the existing ./config import

export interface AppDeps {
  // …existing members…
  changeStore: ChangeRequestStore;
  changeQueue: { send(message: ChangeQueueMessage): Promise<void> };
}
```

Add the routes inside `createApp`:

```ts
app.get('/portal/change-request', async (c) => {
  const donorItemIds = await getSessionDonorIds(c, deps);
  if (donorItemIds === null) return c.redirect('/login');

  c.header('Cache-Control', NO_STORE);
  if (!changeRequestsEnabled(deps.config)) {
    return c.html(changeRequestsUnavailableView());
  }
  const donors = await Promise.all(donorItemIds.map((id) => deps.monday.getDonorContactInfo(id)));
  return c.html(changeRequestFormView(donors));
});

app.post('/portal/change-request', async (c) => {
  const donorItemIds = await getSessionDonorIds(c, deps);
  if (donorItemIds === null) return c.redirect('/login');

  c.header('Cache-Control', NO_STORE);
  if (!changeRequestsEnabled(deps.config)) {
    return c.html(changeRequestsUnavailableView());
  }

  // Same limiter binding as login, but a distinct key prefix so the two budgets don't
  // interfere. No enumeration concern here (the caller is already authenticated), so a plain
  // 429 is fine.
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const ipResult = await deps.ipLimiter.limit(`change:${ip}`);
  if (!ipResult.success) {
    return c.html(errorView('Too many requests — please try again in a minute.'), 429);
  }

  const body = await c.req.parseBody();
  const input = {
    donorItemId: typeof body.donorItemId === 'string' ? body.donorItemId : '',
    field: typeof body.field === 'string' ? body.field : '',
    newValue: typeof body.newValue === 'string' ? body.newValue : '',
  };

  const result = await submitChangeRequest(donorItemIds, input, {
    monday: deps.monday,
    store: deps.changeStore,
    queue: deps.changeQueue,
    dedupeWindowHours: deps.config.changeRequests.dedupeWindowHours,
    now: deps.now,
  });
  return c.html(changeRequestResultView(result));
});
```

Add a portal link in `src/views.ts` `portalView` next to the Tax documents link:

```html
<p><a href="/portal/change-request">Request a change to your details</a></p>
```

- [ ] **Step 8: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/changeRequests/changeRequestViews.ts src/changeRequests/changeRequestViews.test.ts src/routes.ts src/routes.test.ts src/views.ts
git commit -m "feat(donor-portal): change-request form and submission routes"
```

---

### Task 9: Queue consumer + Worker wiring

The consumer that turns queued requests into Monday items, plus the deployment plumbing: `Env`, `index.ts`, and `wrangler.jsonc` queues.

**Files:**
- Create: `src/changeRequests/processBatch.ts`
- Test: `src/changeRequests/processBatch.test.ts`
- Modify: `src/types.ts` (`Env` gains `CHANGE_QUEUE`)
- Modify: `src/index.ts` (wire new deps; add `queue()` export)
- Modify: `wrangler.jsonc` (queue producer/consumer)

**Interfaces:**
- Consumes: `ChangeRequestStore` (Task 5), `MondayClient.createChangeRequestItem` (Task 6), `ChangeQueueMessage` + `FIELD_LABELS` (Task 7), `Config`.
- Produces:

```ts
export interface QueueMessageLike<T> { body: T; ack(): void; retry(): void; }  // same shape as funraise-sync
export interface ProcessChangeBatchDeps { store: ChangeRequestStore; monday: MondayClient; config: Config; }
export async function processChangeQueueBatch(
  messages: QueueMessageLike<ChangeQueueMessage>[], deps: ProcessChangeBatchDeps
): Promise<void>;
```

- [ ] **Step 1: Write the failing tests** — `src/changeRequests/processBatch.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { processChangeQueueBatch } from './processBatch';
import type { ChangeRequestStore, ChangeRequestRow } from '../db/changeRequests';
import type { MondayClient } from '../monday/client';
import type { Config } from '../types';

const row: ChangeRequestRow = {
  id: 42, donorItemId: 'donor-1', donorName: 'Jane Example', field: 'address',
  oldValue: '1 Old St', newValue: '2 New Ave', status: 'queued',
};

// Reuse the full valid test Config shape from routes.test.ts (Task 1 fixture) — only
// changeRequests matters here:
declare const config: Config;

function makeMessage(requestId: number) {
  return { body: { requestId }, ack: vi.fn(), retry: vi.fn() };
}

function fakeStore(getResult: ChangeRequestRow | null): ChangeRequestStore {
  return {
    createRequest: vi.fn(),
    hasRecentDuplicate: vi.fn(),
    getRequest: vi.fn().mockResolvedValue(getResult),
    markWritten: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeMonday(): MondayClient {
  return { createChangeRequestItem: vi.fn().mockResolvedValue(undefined) } as unknown as MondayClient;
}

describe('processChangeQueueBatch', () => {
  it('creates the Monday item, marks written, and acks', async () => {
    const store = fakeStore(row);
    const monday = fakeMonday();
    const message = makeMessage(42);

    await processChangeQueueBatch([message], { store, monday, config });

    expect(monday.createChangeRequestItem).toHaveBeenCalledWith(
      expect.objectContaining({
        boardId: config.changeRequests.boardId,
        itemName: 'Address change — Jane Example',
        donorItemId: 'donor-1',
        fieldLabel: 'Address',
        oldValue: '1 Old St',
        newValue: '2 New Ave',
      })
    );
    expect(store.markWritten).toHaveBeenCalledWith(42, expect.any(String));
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('acks an already-written row without a second Monday write (redelivery idempotency)', async () => {
    const store = fakeStore({ ...row, status: 'written' });
    const monday = fakeMonday();
    const message = makeMessage(42);

    await processChangeQueueBatch([message], { store, monday, config });

    expect(monday.createChangeRequestItem).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalled();
  });

  it('retries on a Monday failure without marking written', async () => {
    const store = fakeStore(row);
    const monday = fakeMonday();
    (monday.createChangeRequestItem as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('monday: HTTP 500'));
    const message = makeMessage(42);

    await processChangeQueueBatch([message], { store, monday, config });

    expect(store.markWritten).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('retries when the row is missing (DLQ makes it visible)', async () => {
    const message = makeMessage(999);
    await processChangeQueueBatch([message], { store: fakeStore(null), monday: fakeMonday(), config });
    expect(message.retry).toHaveBeenCalled();
  });
});
```

(Build the `config` constant concretely in the test file with the Task 1 fixture shape — the `declare` line above is shorthand for "copy the fixture", not code to keep.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/changeRequests/processBatch.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement** — `src/changeRequests/processBatch.ts`:

```ts
import type { ChangeRequestStore } from '../db/changeRequests';
import type { MondayClient } from '../monday/client';
import type { Config } from '../types';
import { FIELD_LABELS, type ChangeQueueMessage } from './submitChangeRequest';

export interface QueueMessageLike<T> {
  body: T;
  ack(): void;
  retry(): void;
}

export interface ProcessChangeBatchDeps {
  store: ChangeRequestStore;
  monday: MondayClient;
  config: Config;
}

export async function processChangeQueueBatch(
  messages: QueueMessageLike<ChangeQueueMessage>[],
  deps: ProcessChangeBatchDeps
): Promise<void> {
  for (const message of messages) {
    try {
      await processOne(message.body.requestId, deps);
      message.ack();
    } catch (err) {
      console.error(
        `donor-portal consumer: failed to process change request ${message.body.requestId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      message.retry();
    }
  }
}

async function processOne(requestId: number, deps: ProcessChangeBatchDeps): Promise<void> {
  const row = await deps.store.getRequest(requestId);
  if (row === null) {
    // A queued message with no row is a bug worth surfacing — let retries exhaust into the DLQ
    // rather than acking it into silence.
    throw new Error(`no change_requests row for id ${requestId}`);
  }
  if (row.status === 'written') {
    return; // redelivery after a crash between write and ack — nothing to do
  }

  const boardId = deps.config.changeRequests.boardId;
  if (boardId === null) {
    throw new Error('config: changeRequests.boardId is not configured');
  }

  const fieldLabel = FIELD_LABELS[row.field];
  await deps.monday.createChangeRequestItem({
    boardId,
    columns: deps.config.changeRequests.columns,
    itemName: `${fieldLabel} change — ${row.donorName}`,
    donorItemId: row.donorItemId,
    fieldLabel,
    oldValue: row.oldValue,
    newValue: row.newValue,
    submittedAtISO: new Date().toISOString(),
  });
  await deps.store.markWritten(row.id, new Date().toISOString());
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/changeRequests/processBatch.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the Worker** —

`src/types.ts`, extend `Env`:

```ts
import type { ChangeQueueMessage } from './changeRequests/submitChangeRequest';

export interface Env {
  DB: D1Database;
  MONDAY_API_TOKEN: string;
  RESEND_API_KEY: string;
  LOGIN_RATE_LIMITER: RateLimit;
  CHANGE_QUEUE: Queue<ChangeQueueMessage>;
}
```

(If importing into `types.ts` creates a cycle with `submitChangeRequest.ts` importing types, move `ChangeQueueMessage` into `types.ts` instead and re-export it from `submitChangeRequest.ts` — keep the Task 7 import path working.)

`src/index.ts` — in `fetch()`, add to the `createApp` deps:

```ts
changeStore: new D1ChangeRequestStore(env.DB),
changeQueue: { send: (message) => env.CHANGE_QUEUE.send(message).then(() => undefined) },
```

and add the consumer export alongside `fetch`:

```ts
async queue(batch: MessageBatch<ChangeQueueMessage>, env: Env): Promise<void> {
  const config = validateConfig(rawConfig);
  await processChangeQueueBatch([...batch.messages], {
    store: new D1ChangeRequestStore(env.DB),
    monday: new HttpMondayClient(
      config.monday.apiUrl,
      env.MONDAY_API_TOKEN,
      config.monday.columns,
      config.monday.donorsBoardId ?? 0,
      config.monday.donationsBoardId ?? 0,
      config.monday.organizationsBoardId ?? 0
    ),
    config,
  });
},
```

with imports for `D1ChangeRequestStore`, `processChangeQueueBatch`, and `ChangeQueueMessage`.

`wrangler.jsonc` — add after `ratelimits`:

```jsonc
"queues": {
  "producers": [{ "queue": "donor-portal-change-requests", "binding": "CHANGE_QUEUE" }],
  "consumers": [
    {
      "queue": "donor-portal-change-requests",
      "max_retries": 3,
      "dead_letter_queue": "donor-portal-change-requests-dlq"
    }
  ]
},
```

- [ ] **Step 6: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/changeRequests/processBatch.ts src/changeRequests/processBatch.test.ts src/types.ts src/index.ts wrangler.jsonc
git commit -m "feat(donor-portal): change-request queue consumer and worker wiring"
```

---

### Task 10: Documentation

Record v2 in the Worker's README (the spec-of-record for this Worker per the monorepo convention) — features, gates, and operator steps.

**Files:**
- Modify: `donor-portal/README.md`

**Interfaces:** none — prose only.

- [ ] **Step 1: Append a v2 section to `README.md`** (after the existing "Security notes" section):

```markdown
## v2 — Year-end tax letters and change requests

Design: `docs/superpowers/specs/2026-08-24-donor-portal-v2-design.md`. Two independent,
config-gated features:

* **Tax letters** (`GET /portal/letters`, `GET /portal/letters/:donorItemId/:year`): a
  consolidated per-year giving letter rendered live from the Donations board as HTML with print
  CSS — the browser's Print → Save as PDF is the delivery mechanism; nothing is generated or
  stored server-side. Only completed calendar years with at least one donation get a letter.
  **Gated on `taxLetter` config:** every string in it ships as `REPLACE_AFTER_SIGNOFF` and the
  feature shows a friendly "not available yet" state until SVBC signs off on the IRS
  acknowledgment language (both the plain no-goods-or-services statement and the
  benefit/quid-pro-quo variant used for tiers listed in `taxLetter.benefitTiers`) and an
  operator fills in the real wording.
* **Change requests** (`GET`/`POST /portal/change-request`): a donor submits a new address,
  email, or phone; the Worker records it in D1 (dedupe window:
  `changeRequests.dedupeWindowHours`) and a queue consumer creates an item on a staff-owned
  Change Requests board (donor link, field, old value, new value, submitted-at). Staff apply
  approved changes to the Donors board by hand — the portal never writes donor records.
  **Gated on `changeRequests.boardId`** plus its column ids and the `donorAddress`/`donorPhone`
  Donors-board column ids in config.

Operator setup for v2, in addition to the v1 steps: create the Change Requests board (five
columns: connect-boards to Donors, three text, one date) and fill in
`changeRequests.boardId`/`columns`; fill in `monday.columns.donorAddress` and
`monday.columns.donorPhone`; grant the portal's integration user **write access to the Change
Requests board only**; create the `donor-portal-change-requests` queue and its
`donor-portal-change-requests-dlq` dead-letter queue before deploying; apply D1 migration
`0002_create_change_requests.sql`; and, once the letter language is signed off, replace every
`REPLACE_AFTER_SIGNOFF` in `taxLetter`.
```

Also update the README's header block: change `**Status:** Decided — build.` context if it still describes v1 as unbuilt, and extend the Stack line's parenthetical `(tokens/sessions only …)` to `(tokens/sessions and queued change requests — Monday stays the system of record for donor data)`.

- [ ] **Step 2: Verify the suite still passes (docs-only change, sanity check)**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(donor-portal): document v2 features, gates, and operator setup"
```

---

## Post-plan verification (not a task — executor checklist before calling v2 done)

- `npm test` and `npm run typecheck` green from `donor-portal/`.
- Manual print-preview check of a letter in a real browser (screen + print): chrome hidden, table rows don't split across pages, one page for a typical donor.
- The three GraphQL NOTE caveats (items_page rules shapes, `create_item` column_values shapes) verified against the live Monday account before deploy — they are flagged in-code, consistent with v1's practice.
- Deploy checklist beyond code: queue + DLQ created, D1 migration applied, integration user's board access extended by exactly the Change Requests board.
