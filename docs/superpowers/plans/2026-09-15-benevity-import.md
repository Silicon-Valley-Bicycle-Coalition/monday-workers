# benevity-import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hand-keying Benevity employer-matching disbursement CSVs into the Donations
board with a webhook-driven Worker: parse the report, dedupe on Transaction ID, resolve the paying
company and (when disclosed) the employee, split each row into up to two Donations items, and
worklist anything it can't resolve.

**Architecture:** Same shape as `funraise-sync` — Hono webhook route → D1 (idempotency ledger) →
Cloudflare Queue → consumer performs resolution and the Monday write. Extended with a three-table
D1 model (`uploads` → `disbursements` → `rows`) because one upload can bundle several Benevity
disbursements, and a CSV parser that has to recognize a preamble, a header, and a trailer.

**Tech Stack:** Hono + TypeScript + Cloudflare Workers + D1 + Cloudflare Queues + Vitest, matching
`../funraise-sync`.

**Spec:** [`benevity-import/README.md`](../../../benevity-import/README.md)

## Global Constraints

- Config-driven, not hardcoded: every Monday board id and column id lives in `config/svbc.json`,
  validated at startup (spec: Monday targets).
- Never auto-create an Organization or a Person — unresolved rows go to a worklist (spec:
  Resolution).
- `Gift Type` and `Status` labels must be exactly `Donation` / `Matching Donation` and `Received`
  (spec: Splitting a row into gifts).
- Every Donations item this Worker creates carries `Benevity Transaction ID`; look it up before
  creating so a retry adopts the existing item instead of duplicating (spec: Idempotency).
- Rows older than `benevityImport.minDonationDate` are skipped, never backfilled (spec:
  Idempotency and the migrated history).
- No donor postal address is ever written to Monday from this Worker (spec: PII).
- A block that fails header or total-sum validation must not lose the other blocks in the same
  file (spec: Data flow / Input format).

---

## File structure

```
benevity-import/
  package.json
  wrangler.jsonc
  tsconfig.json
  vitest.config.ts
  config/svbc.json
  migrations/
    0001_create_tables.sql
  test/
    env.d.ts
    apply-migrations.ts
  src/
    types.ts
    config.ts / config.test.ts
    index.ts / index.test.ts
    util/
      errorMessage.ts
      money.ts / money.test.ts
    mapping/
      fiscalYear.ts / fiscalYear.test.ts
      giftSplit.ts / giftSplit.test.ts
    parse/
      csv.ts / csv.test.ts
      report.ts / report.test.ts
    db/
      uploads.ts / uploads.test.ts
      disbursements.ts / disbursements.test.ts
      rows.ts / rows.test.ts
      aliases.ts / aliases.test.ts
    monday/
      client.ts / client.test.ts
    matching/
      organizations.ts / organizations.test.ts
      people.ts / people.test.ts
    webhook/
      validate.ts / validate.test.ts
      route.ts / route.test.ts
    consumer/
      processBatch.ts / processBatch.test.ts
    integration.test.ts
```

Each `db/*.ts` owns one table; `parse/csv.ts` (generic tokenizing) is separate from
`parse/report.ts` (Benevity-specific block/preamble/trailer shape) so the tokenizer stays reusable
and testable on its own. `matching/organizations.ts` and `matching/people.ts` are separate because
they have unrelated resolution rules and different worklist reasons. `mapping/giftSplit.ts` is pure
data-shaping (row + resolved ids → Monday column-value payloads) with no I/O, mirroring
`funraise-sync`'s `mapping/fieldMap.ts`.

---

### Task 1: Project scaffold

**Files:**
- Create: `benevity-import/package.json`
- Create: `benevity-import/wrangler.jsonc`
- Create: `benevity-import/tsconfig.json`
- Create: `benevity-import/vitest.config.ts`
- Create: `benevity-import/test/env.d.ts`
- Create: `benevity-import/test/apply-migrations.ts`
- Create: `benevity-import/.gitignore`
- Create: `benevity-import/config/svbc.json` (placeholder — filled in as later tasks add config keys)

**Interfaces:** none — this task produces a buildable, empty skeleton.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "benevity-import",
  "version": "0.1.0",
  "description": "Benevity disbursement CSV → Monday.com Donations sync.",
  "main": "src/index.ts",
  "scripts": {
    "test": "vitest run",
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "typecheck": "wrangler types --include-runtime=false && tsc --noEmit"
  },
  "keywords": [],
  "author": "",
  "license": "MIT",
  "type": "module",
  "private": true,
  "dependencies": {
    "hono": "^4.13.3"
  },
  "devDependencies": {
    "@cloudflare/vitest-plugin": "^1.0.0",
    "@cloudflare/workers-types": "^5.20260822.1",
    "typescript": "^7.0.2",
    "vitest": "^4.1.11",
    "wrangler": "^4.125.0"
  }
}
```

- [ ] **Step 2: Create `wrangler.jsonc`**

```jsonc
{
  "name": "svbc-benevity-import",
  "main": "src/index.ts",
  "account_id": "f323cb191edeb5d30acc4d289427a010", // SVBC Account — forks: replace with your own
  "compatibility_date": "2026-08-01",
  "upload_source_maps": true,
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "svbc-benevity-import",
      // Replace after running: wrangler d1 create svbc-benevity-import
      "database_id": "REPLACE_AFTER_WRANGLER_D1_CREATE",
      "migrations_dir": "migrations"
    }
  ],
  "queues": {
    "producers": [{ "queue": "benevity-import-writes", "binding": "WRITE_QUEUE" }],
    "consumers": [
      {
        "queue": "benevity-import-writes",
        "max_retries": 3,
        // Single consumer at a time — Monday's per-token complexity budget punishes
        // concurrent writers during a backlog drain (same reasoning as funraise-sync).
        "max_concurrency": 1,
        "dead_letter_queue": "benevity-import-writes-dlq"
      }
    ]
  },
  "triggers": {
    // Daily raw_row retention purge — window set by benevityImport.rawRowRetentionDays / unresolvedRowRetentionDays.
    "crons": ["15 9 * * *"]
  },
  "observability": {
    "enabled": true
  }
}
```

- [ ] **Step 3: Create `tsconfig.json`** (copy verbatim from `../funraise-sync/tsconfig.json`)

```bash
cp ../funraise-sync/tsconfig.json tsconfig.json
```

- [ ] **Step 4: Create `vitest.config.ts`** (copy verbatim from `../funraise-sync/vitest.config.ts`)

```bash
cp ../funraise-sync/vitest.config.ts vitest.config.ts
cp ../funraise-sync/test/env.d.ts test/env.d.ts
cp ../funraise-sync/test/apply-migrations.ts test/apply-migrations.ts
```

Open the copied `test/apply-migrations.ts` and confirm it reads `migrations/*.sql` generically
(it does in `funraise-sync` — no Worker-specific names inside). No edits needed.

- [ ] **Step 5: Create `.gitignore`**

```
node_modules/
.wrangler/
.dev.vars
*.log
```

- [ ] **Step 6: Create a placeholder `config/svbc.json`**

```json
{
  "monday": {
    "apiUrl": "https://api.monday.com/v2",
    "boards": {
      "donations": null,
      "organizations": null,
      "people": null,
      "affiliations": null,
      "benevityUploads": null
    }
  }
}
```

- [ ] **Step 7: Install and verify the skeleton builds**

```bash
npm install
npm run typecheck
```

Expected: fails on missing `src/index.ts` — that's fine, this task only proves the toolchain
(`wrangler types`, `tsc`) runs. Create an empty `src/index.ts` with `export default {};` so
`typecheck` passes clean.

- [ ] **Step 8: Commit**

```bash
git add package.json wrangler.jsonc tsconfig.json vitest.config.ts test/ .gitignore config/svbc.json src/index.ts
git commit -m "chore(benevity-import): scaffold Worker project"
```

### Task 2: Types and config validation

**Files:**
- Create: `benevity-import/src/types.ts`
- Create: `benevity-import/src/config.ts`
- Test: `benevity-import/src/config.test.ts`
- Modify: `benevity-import/config/svbc.json` (fill in the full shape)

**Interfaces:**
- Produces: `BenevityImportConfig` (and its sub-shapes), `Env`, `validateConfig(raw: unknown): BenevityImportConfig` — every later task imports config through this type and function.

- [ ] **Step 1: Write `src/types.ts`**

```typescript
import type { BenevityQueueMessage } from './consumer/processBatch';

export interface MondayBoards {
  donations: number | null;
  organizations: number | null;
  people: number | null;
  affiliations: number | null;
  benevityUploads: number | null;
}

export interface DonationsColumns {
  donor: string;
  matchedBy: string;
  amount: string;
  date: string;
  disbursementDate: string;
  fiscalYearEnding: string;
  status: string;
  giftType: string;
  anonymousDonor: string;
  transactionId: string;
}

export interface WorklistColumns {
  reason: string;
  name: string;
  email: string;
  company: string;
  amount: string;
  date: string;
}

export interface UploadsBoardConfig {
  fileColumn: string;
  worklistGroupId: string;
  worklistColumns: WorklistColumns;
}

export interface BenevityImportConfig {
  monday: {
    apiUrl: string;
    boards: MondayBoards;
  };
  benevityImport: {
    // ISO date (YYYY-MM-DD). Rows with Donation Date before this are skipped, never backfilled —
    // the migrated Salesforce history has no Transaction IDs to dedupe against.
    minDonationDate: string;
    donationsColumns: DonationsColumns;
    // Monday's item-name pseudo-column id, used for name-based lookups. Almost always "name".
    organizationsNameColumn: string;
    peopleColumns: {
      personalEmail: string;
      householdEmail: string;
      employer: string;
    };
    affiliationsColumns: {
      person: string;
      organization: string;
      workEmail: string;
    };
    uploadsBoard: UploadsBoardConfig;
    // Raw Benevity "Company" string -> canonical Organizations item name, e.g.
    // {"Google, LLC": "Google"}. A hit here is retried through the same name lookup as an
    // exact match, so it must be case-and-spelling-exact to the target Organization's name.
    organizationAliases: Record<string, string>;
    rawRowRetentionDays: number;
    unresolvedRowRetentionDays: number;
  };
}

// Bindings (DB, queues) come from the generated Cloudflare.Env
// (`npm run typecheck` regenerates worker-configuration.d.ts from wrangler.jsonc);
// only secrets and narrowed queue message types are declared here.
export interface Env extends Cloudflare.Env {
  WRITE_QUEUE: Queue<BenevityQueueMessage>;
  MONDAY_API_TOKEN: string;
  // Shared secret required as `?secret=...` on the registered Monday webhook URL
  // (`wrangler secret put BENEVITY_WEBHOOK_SECRET`). Optional in the type because secrets
  // aren't declared in wrangler.jsonc — the webhook route fails closed (401 on every
  // delivery) until it is set, same convention as funraise-sync.
  BENEVITY_WEBHOOK_SECRET?: string;
}
```

- [ ] **Step 2: Write the failing test `src/config.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { validateConfig } from './config';

const validConfig = {
  monday: {
    apiUrl: 'https://api.monday.com/v2',
    boards: {
      donations: 111,
      organizations: 222,
      people: 333,
      affiliations: 444,
      benevityUploads: 555,
    },
  },
  benevityImport: {
    minDonationDate: '2026-07-01',
    donationsColumns: {
      donor: 'donor_col',
      matchedBy: 'matched_by_col',
      amount: 'amount_col',
      date: 'date_col',
      disbursementDate: 'disbursement_date_col',
      fiscalYearEnding: 'fy_ending_col',
      status: 'status_col',
      giftType: 'gift_type_col',
      anonymousDonor: 'anonymous_col',
      transactionId: 'txn_id_col',
    },
    organizationsNameColumn: 'name',
    peopleColumns: {
      personalEmail: 'personal_email_col',
      householdEmail: 'household_email_col',
      employer: 'employer_col',
    },
    affiliationsColumns: {
      person: 'person_col',
      organization: 'organization_col',
      workEmail: 'work_email_col',
    },
    uploadsBoard: {
      fileColumn: 'file_col',
      worklistGroupId: 'review',
      worklistColumns: {
        reason: 'reason_col',
        name: 'name_col',
        email: 'email_col',
        company: 'company_col',
        amount: 'amount_col',
        date: 'date_col',
      },
    },
    organizationAliases: { 'Google, LLC': 'Google' },
    rawRowRetentionDays: 90,
    unresolvedRowRetentionDays: 365,
  },
};

describe('validateConfig', () => {
  it('accepts a fully-populated config', () => {
    expect(() => validateConfig(validConfig)).not.toThrow();
  });

  it('rejects a missing board id key', () => {
    const { organizations, ...rest } = validConfig.monday.boards;
    const bad = { ...validConfig, monday: { ...validConfig.monday, boards: rest } };
    expect(() => validateConfig(bad)).toThrow(/monday\.boards\.organizations/);
  });

  it('rejects a non-positive retention window', () => {
    const bad = {
      ...validConfig,
      benevityImport: { ...validConfig.benevityImport, rawRowRetentionDays: 0 },
    };
    expect(() => validateConfig(bad)).toThrow(/rawRowRetentionDays/);
  });

  it('rejects an organizationAliases value that is not a string', () => {
    const bad = {
      ...validConfig,
      benevityImport: { ...validConfig.benevityImport, organizationAliases: { Google: 42 } },
    };
    expect(() => validateConfig(bad)).toThrow(/organizationAliases/);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- src/config.test.ts`
Expected: FAIL — `./config` has no exported member `validateConfig` (module doesn't exist yet).

- [ ] **Step 4: Write `src/config.ts`**

```typescript
import type { BenevityImportConfig } from './types';

const REQUIRED_BOARD_KEYS = ['donations', 'organizations', 'people', 'affiliations', 'benevityUploads'] as const;

const REQUIRED_DONATIONS_COLUMNS = [
  'donor',
  'matchedBy',
  'amount',
  'date',
  'disbursementDate',
  'fiscalYearEnding',
  'status',
  'giftType',
  'anonymousDonor',
  'transactionId',
] as const;

const REQUIRED_PEOPLE_COLUMNS = ['personalEmail', 'householdEmail', 'employer'] as const;
const REQUIRED_AFFILIATIONS_COLUMNS = ['person', 'organization', 'workEmail'] as const;
const REQUIRED_WORKLIST_COLUMNS = ['reason', 'name', 'email', 'company', 'amount', 'date'] as const;

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`config: missing required key "${path}"`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, path: string): void {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`config: "${path}" must be a non-empty string`);
  }
}

function requireStringFields(obj: Record<string, unknown>, keys: readonly string[], pathPrefix: string): void {
  for (const key of keys) {
    requireNonEmptyString(obj[key], `${pathPrefix}.${key}`);
  }
}

export function validateConfig(raw: unknown): BenevityImportConfig {
  const cfg = requireObject(raw, 'config');

  const monday = requireObject(cfg.monday, 'monday');
  requireNonEmptyString(monday.apiUrl, 'monday.apiUrl');
  const boards = requireObject(monday.boards, 'monday.boards');
  for (const key of REQUIRED_BOARD_KEYS) {
    if (!(key in boards)) {
      throw new Error(`config: missing required key "monday.boards.${key}"`);
    }
    const value = boards[key];
    if (value !== null && typeof value !== 'number') {
      throw new Error(`config: "monday.boards.${key}" must be a number or null`);
    }
  }

  const benevityImport = requireObject(cfg.benevityImport, 'benevityImport');
  requireNonEmptyString(benevityImport.minDonationDate, 'benevityImport.minDonationDate');
  if (Number.isNaN(Date.parse(benevityImport.minDonationDate as string))) {
    throw new Error('config: "benevityImport.minDonationDate" must be a valid ISO date');
  }

  const donationsColumns = requireObject(benevityImport.donationsColumns, 'benevityImport.donationsColumns');
  requireStringFields(donationsColumns, REQUIRED_DONATIONS_COLUMNS, 'benevityImport.donationsColumns');

  requireNonEmptyString(benevityImport.organizationsNameColumn, 'benevityImport.organizationsNameColumn');

  const peopleColumns = requireObject(benevityImport.peopleColumns, 'benevityImport.peopleColumns');
  requireStringFields(peopleColumns, REQUIRED_PEOPLE_COLUMNS, 'benevityImport.peopleColumns');

  const affiliationsColumns = requireObject(benevityImport.affiliationsColumns, 'benevityImport.affiliationsColumns');
  requireStringFields(affiliationsColumns, REQUIRED_AFFILIATIONS_COLUMNS, 'benevityImport.affiliationsColumns');

  const uploadsBoard = requireObject(benevityImport.uploadsBoard, 'benevityImport.uploadsBoard');
  requireNonEmptyString(uploadsBoard.fileColumn, 'benevityImport.uploadsBoard.fileColumn');
  requireNonEmptyString(uploadsBoard.worklistGroupId, 'benevityImport.uploadsBoard.worklistGroupId');
  const worklistColumns = requireObject(uploadsBoard.worklistColumns, 'benevityImport.uploadsBoard.worklistColumns');
  requireStringFields(worklistColumns, REQUIRED_WORKLIST_COLUMNS, 'benevityImport.uploadsBoard.worklistColumns');

  const organizationAliases = benevityImport.organizationAliases;
  if (typeof organizationAliases !== 'object' || organizationAliases === null) {
    throw new Error('config: "benevityImport.organizationAliases" must be an object');
  }
  for (const [key, value] of Object.entries(organizationAliases as Record<string, unknown>)) {
    if (typeof value !== 'string' || value === '') {
      throw new Error(`config: "benevityImport.organizationAliases.${key}" must be a non-empty string`);
    }
  }

  for (const key of ['rawRowRetentionDays', 'unresolvedRowRetentionDays'] as const) {
    const value = benevityImport[key];
    if (typeof value !== 'number' || value <= 0) {
      throw new Error(`config: "benevityImport.${key}" must be a positive number of days`);
    }
  }

  return cfg as unknown as BenevityImportConfig;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- src/config.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/config.ts src/config.test.ts
git commit -m "feat(benevity-import): config schema and validation"
```

### Task 3: Money parsing utility

**Files:**
- Create: `benevity-import/src/util/errorMessage.ts`
- Create: `benevity-import/src/util/money.ts`
- Test: `benevity-import/src/util/money.test.ts`

**Interfaces:**
- Produces: `errorMessage(err: unknown): string`; `parseAmount(raw: string): number` — later tasks
  (report parser, gift splitting) call `parseAmount` on every Benevity amount/total field. Returns
  dollars rounded to cents, `0` for an empty string, throws on anything non-numeric. Negative
  values are returned, not rejected — Benevity clawback rows are a real (if rare) case the spec
  requires routing to `needs-review`, not dropping at parse time.

- [ ] **Step 1: Write `src/util/errorMessage.ts`** (copy verbatim — same one-liner as funraise-sync)

```typescript
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

- [ ] **Step 2: Write the failing test `src/util/money.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { parseAmount } from './money';

describe('parseAmount', () => {
  it('parses a plain decimal string', () => {
    expect(parseAmount('120.00')).toBe(120);
  });

  it('rounds to the nearest cent', () => {
    expect(parseAmount('120.005')).toBe(120.01);
  });

  it('treats an empty string as zero', () => {
    expect(parseAmount('')).toBe(0);
  });

  it('treats a whitespace-only string as zero', () => {
    expect(parseAmount('   ')).toBe(0);
  });

  it('passes through a negative amount unchanged in sign', () => {
    expect(parseAmount('-15.50')).toBe(-15.5);
  });

  it('throws on a non-numeric string', () => {
    expect(() => parseAmount('N/A')).toThrow(/not a valid amount/);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- src/util/money.test.ts`
Expected: FAIL — `./money` module doesn't exist yet.

- [ ] **Step 4: Write `src/util/money.ts`**

```typescript
export function parseAmount(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed === '') return 0;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    throw new Error(`money: "${raw}" is not a valid amount`);
  }
  return Math.round(value * 100) / 100;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- src/util/money.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add src/util/errorMessage.ts src/util/money.ts src/util/money.test.ts
git commit -m "feat(benevity-import): money parsing utility"
```

### Task 4: CSV tokenizer

**Files:**
- Create: `benevity-import/src/parse/csv.ts`
- Test: `benevity-import/src/parse/csv.test.ts`

**Interfaces:**
- Produces: `parseCsvLine(line: string): string[]`; `parseCsvRows(text: string): string[][]` — the
  report parser (Task 5) is the only consumer. **Known limitation, documented not hidden:** this
  tokenizer splits on newlines *before* checking for quotes, so a quoted field containing an
  embedded newline (e.g. a multi-line Comment) is mis-split. Benevity's own report format wasn't
  observed to do this in the verified export, and no other column in the spec's "used for" table
  needs multi-line values. If a future export does contain one, swap in a proper streaming CSV
  parser at this file's boundary — nothing above it needs to change.

- [ ] **Step 1: Write the failing test `src/parse/csv.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { parseCsvLine, parseCsvRows } from './csv';

describe('parseCsvLine', () => {
  it('splits a simple comma-separated line', () => {
    expect(parseCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('keeps a comma inside quotes as part of the field', () => {
    expect(parseCsvLine('"eBay, Inc.",Project,120.00')).toEqual(['eBay, Inc.', 'Project', '120.00']);
  });

  it('unescapes doubled quotes inside a quoted field', () => {
    expect(parseCsvLine('"Say ""hi""",b')).toEqual(['Say "hi"', 'b']);
  });

  it('preserves an empty field between two commas', () => {
    expect(parseCsvLine('a,,c')).toEqual(['a', '', 'c']);
  });

  it('treats an empty quoted field as an empty string', () => {
    expect(parseCsvLine('a,"",c')).toEqual(['a', '', 'c']);
  });
});

describe('parseCsvRows', () => {
  it('splits multiple lines and skips blank ones', () => {
    expect(parseCsvRows('a,b\n\nc,d\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('handles CRLF line endings', () => {
    expect(parseCsvRows('a,b\r\nc,d\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/parse/csv.test.ts`
Expected: FAIL — `./csv` module doesn't exist yet.

- [ ] **Step 3: Write `src/parse/csv.ts`**

```typescript
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

// Line-oriented: does not handle a quoted field containing an embedded newline. See the
// module-level note in this task's plan entry for why that's an accepted scope limit.
export function parseCsvRows(text: string): string[][] {
  return text
    .split(/\r\n|\n/)
    .filter((line) => line.length > 0)
    .map(parseCsvLine);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/parse/csv.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/parse/csv.ts src/parse/csv.test.ts
git commit -m "feat(benevity-import): CSV line/row tokenizer"
```

### Task 5: Benevity report parser

**Files:**
- Create: `benevity-import/src/parse/report.ts`
- Test: `benevity-import/src/parse/report.test.ts`

**Interfaces:**
- Consumes: `parseCsvLine` from `./csv` (Task 4); `parseAmount` from `../util/money` (Task 3);
  `errorMessage` from `../util/errorMessage` (Task 3).
- Produces: `ParsedRow`, `ParsedBlock`, `parseBenevityReport(csvText: string): ParsedBlock[]` — the
  webhook route (Task 16) is the only caller. A block with `headerError !== null` has `rows: []`;
  a block with `sumMismatch: true` has rows populated but the caller must not write them to Monday
  (spec: "a mismatch marks the whole block needs-review rather than writing partial data").

- [ ] **Step 1: Write the failing test `src/parse/report.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { parseBenevityReport } from './report';

// Structure matches a real SVBC export verified 2026-09-15 (see benevity-import/README.md,
// Input format) — all names/amounts below are synthetic.
function block(opts: {
  disbursementId?: string;
  periodEnding?: string;
  currency?: string;
  rows?: string[];
  grossTotal?: string;
} = {}): string {
  const {
    disbursementId = 'ABC123',
    periodEnding = 'Tue 16 Dec 2025 0:00:00',
    currency = 'USD',
    rows = [
      '"Acme, Inc.",Silicon Valley Bicycle Coalition,2025-12-06T01:40:55Z,Jordan,Rivera,jordan@acme.example,Not shared by donor,Not shared by donor,Not shared by donor,94043,,,TXN001,One Time,USD,,BlueSnap,User Donation,50.00,100.00,0.00,0.00,',
    ],
    grossTotal = '150.00',
  } = opts;
  return [
    'Donations Report,',
    '"#-------------------------------------------",',
    'Charity Name,SILICON VALLEY BICYCLE COALITION',
    'Charity ID,840-770338658',
    `Period Ending,${periodEnding}`,
    `Currency,${currency}`,
    'Payment Method,EFT',
    `Disbursement ID,${disbursementId}`,
    'Note,Rounding may be applied to some values in this report.',
    '"#-------------------------------------------",',
    '',
    'Company,Project,Donation Date,Donor First Name,Donor Last Name,Email,Address,City,State/Province,Postal Code,Activity,Comment,Transaction ID,Donation Frequency,Currency,Project Remote ID,Source,Reason,Total Donation to be Acknowledged,Match Amount,Cause Support Fee,Merchant Fee,Fee Comment',
    ...rows,
    `Totals,,,,,,,,,,,,,,,,,,${grossTotal},0.00,0.00,0.00`,
    `Total Donations (Gross),${grossTotal}`,
    'Check Fee,0.00',
    `Net Total Payment,${grossTotal}`,
    '',
  ].join('\n');
}

describe('parseBenevityReport', () => {
  it('parses a single-disbursement block', () => {
    const [result] = parseBenevityReport(block());
    expect(result.headerError).toBeNull();
    expect(result.disbursementId).toBe('ABC123');
    expect(result.periodEnding).toBe('2025-12-16');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      company: 'Acme, Inc.',
      donorFirstName: 'Jordan',
      donorLastName: 'Rivera',
      email: 'jordan@acme.example',
      donationDate: '2025-12-06',
      transactionId: 'TXN001',
      currency: 'USD',
      totalDonationToBeAcknowledged: 50,
      matchAmount: 100,
    });
  });

  it('flags "Not shared by donor" through unchanged for the resolver to interpret', () => {
    const csv = block({
      rows: [
        '"Acme, Inc.",Project,2025-12-06T01:40:55Z,Not shared by donor,Not shared by donor,Not shared by donor,Not shared by donor,Not shared by donor,Not shared by donor,94043,,,TXN002,One Time,USD,,BlueSnap,User Donation,25.00,0.00,0.00,0.00,',
      ],
      grossTotal: '25.00',
    });
    const [result] = parseBenevityReport(csv);
    expect(result.rows[0].donorFirstName).toBe('Not shared by donor');
    expect(result.rows[0].email).toBe('Not shared by donor');
  });

  it('parses a row reported in a non-USD currency without rejecting it', () => {
    const csv = block({
      rows: [
        '"Acme, Inc.",Project,2025-12-06T01:40:55Z,Jordan,Rivera,jordan@acme.example,Not shared by donor,Not shared by donor,Not shared by donor,94043,,,TXN003,One Time,EUR,,BlueSnap,User Donation,120.00,240.00,0.00,0.00,',
      ],
      grossTotal: '360.00',
    });
    const [result] = parseBenevityReport(csv);
    expect(result.rows[0].currency).toBe('EUR');
  });

  it('flags a block whose row totals do not match its reported gross total', () => {
    const csv = block({ grossTotal: '999.00' });
    const [result] = parseBenevityReport(csv);
    expect(result.sumMismatch).toBe(true);
  });

  it('does not flag a block whose row totals match its reported gross total', () => {
    const [result] = parseBenevityReport(block());
    expect(result.sumMismatch).toBe(false);
  });

  it('records a header error without throwing, for a block missing a required column', () => {
    const csv = block().replace('Transaction ID,', 'Txn Id Renamed,');
    const [result] = parseBenevityReport(csv);
    expect(result.headerError).toMatch(/Transaction ID/);
    expect(result.rows).toEqual([]);
  });

  it('parses a file bundling two disbursements into two independent blocks', () => {
    const csv = block({ disbursementId: 'FIRST01' }) + block({ disbursementId: 'SECOND02' });
    const results = parseBenevityReport(csv);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.disbursementId)).toEqual(['FIRST01', 'SECOND02']);
  });

  it('a bad block in a bundle does not prevent the good block from parsing', () => {
    const bad = block({ disbursementId: 'BAD01' }).replace('Transaction ID,', 'Txn Id Renamed,');
    const good = block({ disbursementId: 'GOOD02' });
    const results = parseBenevityReport(bad + good);
    expect(results[0].headerError).not.toBeNull();
    expect(results[1].headerError).toBeNull();
    expect(results[1].disbursementId).toBe('GOOD02');
  });

  it('throws if the file contains no "Donations Report" block at all', () => {
    expect(() => parseBenevityReport('not,a,benevity,file\n')).toThrow(/no "Donations Report" block/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/parse/report.test.ts`
Expected: FAIL — `./report` module doesn't exist yet.

- [ ] **Step 3: Write `src/parse/report.ts`**

```typescript
import { parseCsvLine } from './csv';
import { parseAmount } from '../util/money';
import { errorMessage } from '../util/errorMessage';

export interface ParsedRow {
  company: string;
  donorFirstName: string;
  donorLastName: string;
  email: string;
  donationDate: string; // ISO date (YYYY-MM-DD)
  transactionId: string;
  donationFrequency: string;
  currency: string;
  totalDonationToBeAcknowledged: number;
  matchAmount: number;
  // Comment/Reason/Source/Activity/Project/Project Remote ID, concatenated. Carried through for
  // a future Monday Updates post (spec: Input format) — not written anywhere by this Worker yet;
  // see the plan's Task 5 note and the README's open questions.
  notes: string;
}

export interface ParsedBlock {
  disbursementId: string;
  periodEnding: string; // ISO date
  currency: string;
  paymentMethod: string;
  charityName: string;
  rows: ParsedRow[];
  reportedGrossTotal: number;
  reportedNetTotal: number;
  sumMismatch: boolean;
  headerError: string | null;
}

const REQUIRED_HEADER_COLUMNS = [
  'Company',
  'Donor First Name',
  'Donor Last Name',
  'Email',
  'Donation Date',
  'Transaction ID',
  'Donation Frequency',
  'Currency',
  'Total Donation to be Acknowledged',
  'Match Amount',
] as const;

const NOTE_COLUMNS = ['Comment', 'Reason', 'Source', 'Activity', 'Project', 'Project Remote ID'];

const MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

export function parseBenevityReport(csvText: string): ParsedBlock[] {
  const lines = csvText.split(/\r\n|\n/).filter((line) => line.length > 0);
  const blockStarts: number[] = [];
  lines.forEach((line, i) => {
    if (/^Donations Report\b/i.test(line)) blockStarts.push(i);
  });
  if (blockStarts.length === 0) {
    throw new Error('report: no "Donations Report" block found in file');
  }

  return blockStarts.map((start, idx) => {
    const end = idx + 1 < blockStarts.length ? blockStarts[idx + 1] : lines.length;
    return parseBlock(lines.slice(start, end));
  });
}

function parseBlock(lines: string[]): ParsedBlock {
  try {
    return parseBlockOrThrow(lines);
  } catch (err) {
    return {
      disbursementId: '',
      periodEnding: '',
      currency: '',
      paymentMethod: '',
      charityName: '',
      rows: [],
      reportedGrossTotal: 0,
      reportedNetTotal: 0,
      sumMismatch: false,
      headerError: errorMessage(err),
    };
  }
}

function parseBlockOrThrow(lines: string[]): ParsedBlock {
  let i = 1; // lines[0] is "Donations Report,"
  if (!lines[i]?.startsWith('#')) {
    throw new Error('report: expected a separator line after "Donations Report"');
  }
  i++;

  const preamble: Record<string, string> = {};
  while (i < lines.length && !lines[i].startsWith('#')) {
    const [key, ...rest] = parseCsvLine(lines[i]);
    preamble[(key ?? '').trim()] = rest.join(',').trim();
    i++;
  }
  if (i >= lines.length) {
    throw new Error('report: preamble never closed with a separator line');
  }
  i++; // skip closing separator

  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length) {
    throw new Error('report: no header row found');
  }
  const header = parseCsvLine(lines[i]);
  i++;
  for (const column of REQUIRED_HEADER_COLUMNS) {
    if (!header.includes(column)) {
      throw new Error(`report: header is missing required column "${column}"`);
    }
  }
  const colIndex = (name: string): number => header.indexOf(name);

  const rows: ParsedRow[] = [];
  while (i < lines.length && !/^totals\b/i.test(lines[i])) {
    const fields = parseCsvLine(lines[i]);
    const field = (name: string): string => (fields[colIndex(name)] ?? '').trim();
    rows.push({
      company: field('Company'),
      donorFirstName: field('Donor First Name'),
      donorLastName: field('Donor Last Name'),
      email: field('Email'),
      donationDate: parseDonationDate(field('Donation Date')),
      transactionId: field('Transaction ID'),
      donationFrequency: field('Donation Frequency'),
      currency: field('Currency'),
      totalDonationToBeAcknowledged: parseAmount(field('Total Donation to be Acknowledged')),
      matchAmount: parseAmount(field('Match Amount')),
      notes: buildNotes(fields, header),
    });
    i++;
  }

  let reportedGrossTotal = 0;
  let reportedNetTotal = 0;
  if (i < lines.length && /^totals\b/i.test(lines[i])) {
    i++;
    while (i < lines.length) {
      const [label, value] = parseCsvLine(lines[i]);
      if (/Total Donations \(Gross\)/i.test(label ?? '')) reportedGrossTotal = parseAmount(value ?? '');
      if (/Net Total Payment/i.test(label ?? '')) reportedNetTotal = parseAmount(value ?? '');
      i++;
    }
  }

  const rowsTotal = rows.reduce((sum, r) => sum + r.totalDonationToBeAcknowledged + r.matchAmount, 0);
  const sumMismatch = Math.abs(rowsTotal - reportedGrossTotal) > 0.01;

  if (!preamble['Disbursement ID']) {
    throw new Error('report: preamble missing "Disbursement ID"');
  }

  return {
    disbursementId: preamble['Disbursement ID'],
    periodEnding: parsePeriodEnding(preamble['Period Ending'] ?? ''),
    currency: preamble['Currency'] ?? '',
    paymentMethod: preamble['Payment Method'] ?? '',
    charityName: preamble['Charity Name'] ?? '',
    rows,
    reportedGrossTotal,
    reportedNetTotal,
    sumMismatch,
    headerError: null,
  };
}

function parseDonationDate(raw: string): string {
  // Row-level dates are full ISO datetimes ("2025-12-06T01:40:55Z"); Donations `Date` only
  // needs the calendar date.
  const isoDate = raw.slice(0, 10);
  if (Number.isNaN(Date.parse(isoDate))) {
    throw new Error(`report: "Donation Date" value "${raw}" is not a valid date`);
  }
  return isoDate;
}

function parsePeriodEnding(raw: string): string {
  // Benevity's preamble format, verified 2026-09-15: "Tue 16 Dec 2025 0:00:00"
  // (weekday name, day, three-letter month, 4-digit year, time — time discarded).
  const match = /^\w{3}\s+(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\b/.exec(raw.trim());
  const month = match ? MONTHS[match[2]] : undefined;
  if (!match || !month) {
    throw new Error(`report: "Period Ending" value "${raw}" doesn't match the expected format`);
  }
  const day = match[1].padStart(2, '0');
  return `${match[3]}-${month}-${day}`;
}

function buildNotes(fields: string[], header: string[]): string {
  return NOTE_COLUMNS.map((col) => {
    const idx = header.indexOf(col);
    const value = idx === -1 ? '' : (fields[idx] ?? '').trim();
    return value === '' ? null : `${col}: ${value}`;
  })
    .filter((v): v is string => v !== null)
    .join('; ');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/parse/report.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/parse/report.ts src/parse/report.test.ts
git commit -m "feat(benevity-import): Benevity disbursement report parser"
```

### Task 6: Fiscal year calculation

**Files:**
- Create: `benevity-import/src/mapping/fiscalYear.ts`
- Test: `benevity-import/src/mapping/fiscalYear.test.ts`

**Interfaces:**
- Produces: `fiscalYearEnding(isoDate: string): string` — Task 14 (`giftSplit.ts`) calls this on
  each row's `donationDate`. SVBC's fiscal year runs July 1 – June 30 (spec: Splitting a row into
  gifts, "same rule as `salesforce-import`"). There is no shared package across Workers in this
  repo (each Worker is self-contained per the root `CLAUDE.md`), so this is a deliberate
  reimplementation, not a copy — the test below pins the July 1 boundary so a future change to
  either Worker's rule is caught by a failing test, not silently.

- [ ] **Step 1: Write the failing test `src/mapping/fiscalYear.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { fiscalYearEnding } from './fiscalYear';

describe('fiscalYearEnding', () => {
  it('a date in the first half of the calendar year ends that same June 30', () => {
    expect(fiscalYearEnding('2026-03-15')).toBe('2026-06-30');
  });

  it('June 30 itself ends that same June 30', () => {
    expect(fiscalYearEnding('2026-06-30')).toBe('2026-06-30');
  });

  it('July 1 rolls into the following fiscal year', () => {
    expect(fiscalYearEnding('2026-07-01')).toBe('2027-06-30');
  });

  it('a date in the back half of the calendar year ends the following June 30', () => {
    expect(fiscalYearEnding('2026-12-06')).toBe('2027-06-30');
  });

  it('throws on an invalid date string', () => {
    expect(() => fiscalYearEnding('not-a-date')).toThrow(/not a valid date/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/mapping/fiscalYear.test.ts`
Expected: FAIL — `./fiscalYear` module doesn't exist yet.

- [ ] **Step 3: Write `src/mapping/fiscalYear.ts`**

```typescript
export function fiscalYearEnding(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`fiscalYear: "${isoDate}" is not a valid date`);
  }
  const month = date.getUTCMonth(); // 0 = January
  const year = date.getUTCFullYear();
  const endingYear = month >= 6 ? year + 1 : year; // Jul(6)-Dec(11) -> next calendar year's June 30
  return `${endingYear}-06-30`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/mapping/fiscalYear.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mapping/fiscalYear.ts src/mapping/fiscalYear.test.ts
git commit -m "feat(benevity-import): fiscal year ending calculation"
```

### Task 7: D1 schema and the uploads store

**Files:**
- Create: `benevity-import/migrations/0001_create_tables.sql`
- Create: `benevity-import/src/db/uploads.ts`
- Test: `benevity-import/src/db/uploads.test.ts`

**Interfaces:**
- Produces: the full D1 schema (`uploads`, `disbursements`, `rows`, `aliases` — Tasks 8-10 use the
  latter three tables against this same migration file, no new migration needed); `UploadRow`,
  `UploadStore`, `D1UploadStore` — the webhook route (Task 16) is the only caller.

- [ ] **Step 1: Write `migrations/0001_create_tables.sql`**

```sql
CREATE TABLE uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monday_asset_id TEXT NOT NULL UNIQUE,
  uploaded_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'parsing',
  block_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE disbursements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  upload_id INTEGER NOT NULL REFERENCES uploads(id),
  disbursement_id TEXT NOT NULL,
  period_ending TEXT NOT NULL,
  currency TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  reported_gross_total REAL NOT NULL DEFAULT 0,
  reported_net_total REAL NOT NULL DEFAULT 0,
  needs_review INTEGER NOT NULL DEFAULT 0,
  review_reason TEXT
);
CREATE INDEX idx_disbursements_upload ON disbursements (upload_id);

-- Transaction ID is the true idempotency key: global, not scoped to one file or block, so the
-- same gift arriving in two overlapping uploads is still one row (spec: Idempotency).
CREATE TABLE rows (
  transaction_id TEXT PRIMARY KEY,
  disbursement_id INTEGER NOT NULL REFERENCES disbursements(id),
  status TEXT NOT NULL DEFAULT 'ingested',
  monday_employee_item_id TEXT,
  monday_match_item_id TEXT,
  raw_row TEXT NOT NULL,
  error TEXT,
  ingested_at TEXT NOT NULL,
  written_at TEXT
);
CREATE INDEX idx_rows_disbursement ON rows (disbursement_id);

-- Learned Company-string -> Organizations-item-id aliases, appended to whenever staff resolve a
-- worklist item by hand (spec: Resolution, Company -> Organizations item).
CREATE TABLE aliases (
  raw_company_name TEXT PRIMARY KEY,
  organization_item_id TEXT NOT NULL,
  learned_at TEXT NOT NULL
);
```

- [ ] **Step 2: Write the failing test `src/db/uploads.test.ts`**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { D1UploadStore } from './uploads';
import { applyMigrations } from '../../test/apply-migrations';

describe('D1UploadStore', () => {
  beforeEach(async () => {
    await applyMigrations(env.DB);
  });

  it('creates an upload and reads it back by Monday asset id', async () => {
    const store = new D1UploadStore(env.DB);
    const created = await store.createUpload('asset-1', '2026-09-15T00:00:00Z');
    expect(created.status).toBe('parsing');
    expect(created.blockCount).toBe(0);

    const found = await store.getUploadByAssetId('asset-1');
    expect(found).toMatchObject({ id: created.id, mondayAssetId: 'asset-1', status: 'parsing' });
  });

  it('returns null for an asset id with no upload', async () => {
    const store = new D1UploadStore(env.DB);
    expect(await store.getUploadByAssetId('missing')).toBeNull();
  });

  it('marks an upload parsed with its block count', async () => {
    const store = new D1UploadStore(env.DB);
    const created = await store.createUpload('asset-2', '2026-09-15T00:00:00Z');
    await store.markParsed(created.id, 3);
    const found = await store.getUploadByAssetId('asset-2');
    expect(found).toMatchObject({ status: 'parsed', blockCount: 3 });
  });

  it('marks an upload errored', async () => {
    const store = new D1UploadStore(env.DB);
    const created = await store.createUpload('asset-3', '2026-09-15T00:00:00Z');
    await store.markError(created.id);
    const found = await store.getUploadByAssetId('asset-3');
    expect(found?.status).toBe('error');
  });

  it('rejects a duplicate Monday asset id', async () => {
    const store = new D1UploadStore(env.DB);
    await store.createUpload('asset-4', '2026-09-15T00:00:00Z');
    await expect(store.createUpload('asset-4', '2026-09-15T01:00:00Z')).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- src/db/uploads.test.ts`
Expected: FAIL — `./uploads` module doesn't exist yet (and would also fail on a missing table
until Step 1's migration is picked up — confirm Step 1 is saved first).

- [ ] **Step 4: Write `src/db/uploads.ts`**

```typescript
export type UploadStatus = 'parsing' | 'parsed' | 'error';

export interface UploadRow {
  id: number;
  mondayAssetId: string;
  uploadedAt: string;
  status: UploadStatus;
  blockCount: number;
}

export interface UploadStore {
  createUpload(mondayAssetId: string, uploadedAt: string): Promise<UploadRow>;
  getUploadByAssetId(mondayAssetId: string): Promise<UploadRow | null>;
  markParsed(id: number, blockCount: number): Promise<void>;
  markError(id: number): Promise<void>;
}

interface D1UploadRecord {
  id: number;
  monday_asset_id: string;
  uploaded_at: string;
  status: UploadStatus;
  block_count: number;
}

function toUploadRow(record: D1UploadRecord): UploadRow {
  return {
    id: record.id,
    mondayAssetId: record.monday_asset_id,
    uploadedAt: record.uploaded_at,
    status: record.status,
    blockCount: record.block_count,
  };
}

export class D1UploadStore implements UploadStore {
  constructor(private db: D1Database) {}

  async createUpload(mondayAssetId: string, uploadedAt: string): Promise<UploadRow> {
    const result = await this.db
      .prepare(
        `INSERT INTO uploads (monday_asset_id, uploaded_at, status, block_count)
         VALUES (?1, ?2, 'parsing', 0)
         RETURNING id, monday_asset_id, uploaded_at, status, block_count`
      )
      .bind(mondayAssetId, uploadedAt)
      .first<D1UploadRecord>();
    if (result === null) {
      throw new Error(`db: failed to create upload for asset "${mondayAssetId}"`);
    }
    return toUploadRow(result);
  }

  async getUploadByAssetId(mondayAssetId: string): Promise<UploadRow | null> {
    const record = await this.db
      .prepare(`SELECT id, monday_asset_id, uploaded_at, status, block_count FROM uploads WHERE monday_asset_id = ?1`)
      .bind(mondayAssetId)
      .first<D1UploadRecord>();
    return record === null ? null : toUploadRow(record);
  }

  async markParsed(id: number, blockCount: number): Promise<void> {
    await this.db
      .prepare(`UPDATE uploads SET status = 'parsed', block_count = ?2 WHERE id = ?1`)
      .bind(id, blockCount)
      .run();
  }

  async markError(id: number): Promise<void> {
    await this.db.prepare(`UPDATE uploads SET status = 'error' WHERE id = ?1`).bind(id).run();
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- src/db/uploads.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add migrations/0001_create_tables.sql src/db/uploads.ts src/db/uploads.test.ts
git commit -m "feat(benevity-import): D1 schema and uploads store"
```

### Task 8: Disbursements store

**Files:**
- Create: `benevity-import/src/db/disbursements.ts`
- Test: `benevity-import/src/db/disbursements.test.ts`

**Interfaces:**
- Produces: `DisbursementRow`, `DisbursementStore`, `D1DisbursementStore` — the webhook route
  (Task 16) creates one row per parsed block; the consumer (Task 17) reads one to get a row's
  `periodEnding` for the `Benevity Disbursement Date` column.

- [ ] **Step 1: Write the failing test `src/db/disbursements.test.ts`**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { D1UploadStore } from './uploads';
import { D1DisbursementStore } from './disbursements';
import { applyMigrations } from '../../test/apply-migrations';

describe('D1DisbursementStore', () => {
  let uploadId: number;

  beforeEach(async () => {
    await applyMigrations(env.DB);
    const uploads = new D1UploadStore(env.DB);
    uploadId = (await uploads.createUpload('asset-1', '2026-09-15T00:00:00Z')).id;
  });

  it('creates a disbursement and reads it back', async () => {
    const store = new D1DisbursementStore(env.DB);
    const created = await store.createDisbursement({
      uploadId,
      disbursementId: 'ABC123',
      periodEnding: '2025-12-16',
      currency: 'USD',
      rowCount: 1,
      reportedGrossTotal: 150,
      reportedNetTotal: 150,
      needsReview: false,
      reviewReason: null,
    });
    expect(created.id).toBeGreaterThan(0);

    const found = await store.getDisbursement(created.id);
    expect(found).toMatchObject({
      uploadId,
      disbursementId: 'ABC123',
      periodEnding: '2025-12-16',
      needsReview: false,
    });
  });

  it('persists a needs-review disbursement with its reason', async () => {
    const store = new D1DisbursementStore(env.DB);
    const created = await store.createDisbursement({
      uploadId,
      disbursementId: 'BAD01',
      periodEnding: '2025-12-16',
      currency: 'USD',
      rowCount: 0,
      reportedGrossTotal: 0,
      reportedNetTotal: 0,
      needsReview: true,
      reviewReason: 'row totals do not match the reported gross total',
    });
    const found = await store.getDisbursement(created.id);
    expect(found?.needsReview).toBe(true);
    expect(found?.reviewReason).toBe('row totals do not match the reported gross total');
  });

  it('returns null for an id with no disbursement', async () => {
    const store = new D1DisbursementStore(env.DB);
    expect(await store.getDisbursement(999999)).toBeNull();
  });

  it('lists disbursements for an upload in creation order, empty for an upload with none', async () => {
    const store = new D1DisbursementStore(env.DB);
    const first = await store.createDisbursement({
      uploadId, disbursementId: 'FIRST', periodEnding: '2025-12-16', currency: 'USD',
      rowCount: 1, reportedGrossTotal: 50, reportedNetTotal: 50, needsReview: false, reviewReason: null,
    });
    const second = await store.createDisbursement({
      uploadId, disbursementId: 'SECOND', periodEnding: '2025-12-16', currency: 'USD',
      rowCount: 1, reportedGrossTotal: 60, reportedNetTotal: 60, needsReview: false, reviewReason: null,
    });
    expect((await store.listByUpload(uploadId)).map((d) => d.id)).toEqual([first.id, second.id]);
    expect(await store.listByUpload(999999)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/db/disbursements.test.ts`
Expected: FAIL — `./disbursements` module doesn't exist yet.

- [ ] **Step 3: Write `src/db/disbursements.ts`**

```typescript
export interface DisbursementRow {
  id: number;
  uploadId: number;
  disbursementId: string;
  periodEnding: string;
  currency: string;
  rowCount: number;
  reportedGrossTotal: number;
  reportedNetTotal: number;
  needsReview: boolean;
  reviewReason: string | null;
}

export type NewDisbursement = Omit<DisbursementRow, 'id'>;

export interface DisbursementStore {
  createDisbursement(input: NewDisbursement): Promise<DisbursementRow>;
  getDisbursement(id: number): Promise<DisbursementRow | null>;
  // Added during Task 16's fix round 1: lets a webhook redelivery resume a stuck upload from
  // the first block that was never fully processed, instead of reprocessing blocks that
  // already ran to completion (which would otherwise insert a duplicate disbursement row, and
  // for a needs-review block, a duplicate worklist item).
  listByUpload(uploadId: number): Promise<DisbursementRow[]>;
}

interface D1DisbursementRecord {
  id: number;
  upload_id: number;
  disbursement_id: string;
  period_ending: string;
  currency: string;
  row_count: number;
  reported_gross_total: number;
  reported_net_total: number;
  needs_review: number;
  review_reason: string | null;
}

function toDisbursementRow(record: D1DisbursementRecord): DisbursementRow {
  return {
    id: record.id,
    uploadId: record.upload_id,
    disbursementId: record.disbursement_id,
    periodEnding: record.period_ending,
    currency: record.currency,
    rowCount: record.row_count,
    reportedGrossTotal: record.reported_gross_total,
    reportedNetTotal: record.reported_net_total,
    needsReview: record.needs_review === 1,
    reviewReason: record.review_reason,
  };
}

export class D1DisbursementStore implements DisbursementStore {
  constructor(private db: D1Database) {}

  async createDisbursement(input: NewDisbursement): Promise<DisbursementRow> {
    const result = await this.db
      .prepare(
        `INSERT INTO disbursements
           (upload_id, disbursement_id, period_ending, currency, row_count,
            reported_gross_total, reported_net_total, needs_review, review_reason)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         RETURNING id, upload_id, disbursement_id, period_ending, currency, row_count,
                   reported_gross_total, reported_net_total, needs_review, review_reason`
      )
      .bind(
        input.uploadId,
        input.disbursementId,
        input.periodEnding,
        input.currency,
        input.rowCount,
        input.reportedGrossTotal,
        input.reportedNetTotal,
        input.needsReview ? 1 : 0,
        input.reviewReason
      )
      .first<D1DisbursementRecord>();
    if (result === null) {
      throw new Error(`db: failed to create disbursement "${input.disbursementId}"`);
    }
    return toDisbursementRow(result);
  }

  async getDisbursement(id: number): Promise<DisbursementRow | null> {
    const record = await this.db
      .prepare(
        `SELECT id, upload_id, disbursement_id, period_ending, currency, row_count,
                reported_gross_total, reported_net_total, needs_review, review_reason
         FROM disbursements WHERE id = ?1`
      )
      .bind(id)
      .first<D1DisbursementRecord>();
    return record === null ? null : toDisbursementRow(record);
  }

  async listByUpload(uploadId: number): Promise<DisbursementRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, upload_id, disbursement_id, period_ending, currency, row_count,
                reported_gross_total, reported_net_total, needs_review, review_reason
         FROM disbursements WHERE upload_id = ?1 ORDER BY id ASC`
      )
      .bind(uploadId)
      .all<D1DisbursementRecord>();
    return results.map(toDisbursementRow);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/db/disbursements.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/db/disbursements.ts src/db/disbursements.test.ts
git commit -m "feat(benevity-import): disbursements store"
```

### Task 9: Rows store

**Files:**
- Create: `benevity-import/src/db/rows.ts`
- Test: `benevity-import/src/db/rows.test.ts`

**Interfaces:**
- Produces: `RowStatus`, `DonationRowRecord`, `RowStore`, `D1RowStore` — the webhook route (Task
  16) upserts one row per data row (keyed on Transaction ID, globally — spec: Idempotency); the
  consumer (Task 17) reads and updates it after resolution/write; the scheduled handler (Task 18)
  purges `rawRow` on the retention schedule.

- [ ] **Step 1: Write the failing test `src/db/rows.test.ts`**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { D1UploadStore } from './uploads';
import { D1DisbursementStore } from './disbursements';
import { D1RowStore } from './rows';
import { applyMigrations } from '../../test/apply-migrations';

describe('D1RowStore', () => {
  let disbursementId: number;

  beforeEach(async () => {
    await applyMigrations(env.DB);
    const uploads = new D1UploadStore(env.DB);
    const uploadId = (await uploads.createUpload('asset-1', '2026-09-15T00:00:00Z')).id;
    const disbursements = new D1DisbursementStore(env.DB);
    disbursementId = (
      await disbursements.createDisbursement({
        uploadId,
        disbursementId: 'ABC123',
        periodEnding: '2025-12-16',
        currency: 'USD',
        rowCount: 1,
        reportedGrossTotal: 150,
        reportedNetTotal: 150,
        needsReview: false,
        reviewReason: null,
      })
    ).id;
  });

  it('inserts a new row as ingested', async () => {
    const store = new D1RowStore(env.DB);
    const result = await store.upsertRow({
      transactionId: 'TXN001',
      disbursementId,
      rawRow: '{"company":"Acme"}',
      status: 'ingested',
      ingestedAt: '2026-09-15T00:00:00Z',
    });
    expect(result).toBe('inserted');

    const found = await store.getRow('TXN001');
    expect(found).toMatchObject({ transactionId: 'TXN001', status: 'ingested', disbursementId });
  });

  it('reports a re-upsert of the same Transaction ID as a duplicate and leaves the row untouched', async () => {
    const store = new D1RowStore(env.DB);
    await store.upsertRow({
      transactionId: 'TXN001',
      disbursementId,
      rawRow: '{"company":"Acme"}',
      status: 'ingested',
      ingestedAt: '2026-09-15T00:00:00Z',
    });
    await store.updateStatus('TXN001', 'written', { writtenAt: '2026-09-15T01:00:00Z' });

    const result = await store.upsertRow({
      transactionId: 'TXN001',
      disbursementId,
      rawRow: '{"company":"Acme"}',
      status: 'ingested',
      ingestedAt: '2026-09-15T02:00:00Z',
    });
    expect(result).toBe('duplicate');

    const found = await store.getRow('TXN001');
    expect(found?.status).toBe('written'); // untouched by the duplicate upsert
  });

  it('updates status and patch fields', async () => {
    const store = new D1RowStore(env.DB);
    await store.upsertRow({
      transactionId: 'TXN002',
      disbursementId,
      rawRow: '{}',
      status: 'ingested',
      ingestedAt: '2026-09-15T00:00:00Z',
    });
    await store.updateStatus('TXN002', 'written', {
      mondayEmployeeItemId: '111',
      mondayMatchItemId: '222',
      writtenAt: '2026-09-15T03:00:00Z',
    });
    const found = await store.getRow('TXN002');
    expect(found).toMatchObject({
      status: 'written',
      mondayEmployeeItemId: '111',
      mondayMatchItemId: '222',
      writtenAt: '2026-09-15T03:00:00Z',
    });
  });

  it('purges raw_row for written rows older than the cutoff, and leaves newer ones alone', async () => {
    const store = new D1RowStore(env.DB);
    await store.upsertRow({
      transactionId: 'OLD',
      disbursementId,
      rawRow: '{"x":1}',
      status: 'ingested',
      ingestedAt: '2026-01-01T00:00:00Z',
    });
    await store.updateStatus('OLD', 'written', { writtenAt: '2026-01-01T00:00:00Z' });
    await store.upsertRow({
      transactionId: 'NEW',
      disbursementId,
      rawRow: '{"x":2}',
      status: 'ingested',
      ingestedAt: '2026-09-01T00:00:00Z',
    });
    await store.updateStatus('NEW', 'written', { writtenAt: '2026-09-01T00:00:00Z' });

    const purged = await store.purgeWrittenRawRows('2026-06-01T00:00:00Z');
    expect(purged).toBe(1);
    expect((await store.getRow('OLD'))?.rawRow).toBe('{}');
    expect((await store.getRow('NEW'))?.rawRow).toBe('{"x":2}');
  });

  it('purges raw_row for unresolved rows older than the cutoff', async () => {
    const store = new D1RowStore(env.DB);
    await store.upsertRow({
      transactionId: 'STALE',
      disbursementId,
      rawRow: '{"x":1}',
      status: 'needs-review',
      ingestedAt: '2025-01-01T00:00:00Z',
    });
    const purged = await store.purgeUnresolvedRawRows('2026-01-01T00:00:00Z');
    expect(purged).toBe(1);
    expect((await store.getRow('STALE'))?.rawRow).toBe('{}');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/db/rows.test.ts`
Expected: FAIL — `./rows` module doesn't exist yet.

- [ ] **Step 3: Write `src/db/rows.ts`**

```typescript
export type RowStatus = 'ingested' | 'written' | 'needs-review' | 'skipped';

export interface DonationRowRecord {
  transactionId: string;
  disbursementId: number;
  status: RowStatus;
  mondayEmployeeItemId: string | null;
  mondayMatchItemId: string | null;
  rawRow: string;
  error: string | null;
  ingestedAt: string;
  writtenAt: string | null;
}

export interface NewRow {
  transactionId: string;
  disbursementId: number;
  rawRow: string;
  status: RowStatus;
  ingestedAt: string;
}

export interface RowStatusPatch {
  mondayEmployeeItemId?: string;
  mondayMatchItemId?: string;
  error?: string;
  writtenAt?: string;
}

export type UpsertRowResult = 'inserted' | 'duplicate';

export interface RowStore {
  upsertRow(row: NewRow): Promise<UpsertRowResult>;
  getRow(transactionId: string): Promise<DonationRowRecord | null>;
  updateStatus(transactionId: string, status: RowStatus, patch?: RowStatusPatch): Promise<void>;
  purgeWrittenRawRows(writtenBefore: string): Promise<number>;
  purgeUnresolvedRawRows(ingestedBefore: string): Promise<number>;
}

interface D1RowRecord {
  transaction_id: string;
  disbursement_id: number;
  status: RowStatus;
  monday_employee_item_id: string | null;
  monday_match_item_id: string | null;
  raw_row: string;
  error: string | null;
  ingested_at: string;
  written_at: string | null;
}

function toRow(record: D1RowRecord): DonationRowRecord {
  return {
    transactionId: record.transaction_id,
    disbursementId: record.disbursement_id,
    status: record.status,
    mondayEmployeeItemId: record.monday_employee_item_id,
    mondayMatchItemId: record.monday_match_item_id,
    rawRow: record.raw_row,
    error: record.error,
    ingestedAt: record.ingested_at,
    writtenAt: record.written_at,
  };
}

export class D1RowStore implements RowStore {
  constructor(private db: D1Database) {}

  // Transaction ID is globally unique (PRIMARY KEY), so ON CONFLICT DO NOTHING is enough to make
  // a re-upload of an overlapping file a no-op for rows already known — never overwrites an
  // in-flight or completed row's status.
  async upsertRow(row: NewRow): Promise<UpsertRowResult> {
    const result = await this.db
      .prepare(
        `INSERT INTO rows (transaction_id, disbursement_id, status, raw_row, ingested_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (transaction_id) DO NOTHING`
      )
      .bind(row.transactionId, row.disbursementId, row.status, row.rawRow, row.ingestedAt)
      .run();
    return result.meta.changes === 0 ? 'duplicate' : 'inserted';
  }

  async getRow(transactionId: string): Promise<DonationRowRecord | null> {
    const record = await this.db
      .prepare(
        `SELECT transaction_id, disbursement_id, status, monday_employee_item_id, monday_match_item_id,
                raw_row, error, ingested_at, written_at
         FROM rows WHERE transaction_id = ?1`
      )
      .bind(transactionId)
      .first<D1RowRecord>();
    return record === null ? null : toRow(record);
  }

  async updateStatus(transactionId: string, status: RowStatus, patch: RowStatusPatch = {}): Promise<void> {
    await this.db
      .prepare(
        `UPDATE rows SET
           status = ?2,
           monday_employee_item_id = COALESCE(?3, monday_employee_item_id),
           monday_match_item_id = COALESCE(?4, monday_match_item_id),
           error = ?5,
           written_at = COALESCE(?6, written_at)
         WHERE transaction_id = ?1`
      )
      .bind(
        transactionId,
        status,
        patch.mondayEmployeeItemId ?? null,
        patch.mondayMatchItemId ?? null,
        patch.error ?? null,
        patch.writtenAt ?? null
      )
      .run();
  }

  async purgeWrittenRawRows(writtenBefore: string): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE rows SET raw_row = '{}'
         WHERE status = 'written' AND written_at < ?1 AND raw_row != '{}'`
      )
      .bind(writtenBefore)
      .run();
    return result.meta.changes;
  }

  async purgeUnresolvedRawRows(ingestedBefore: string): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE rows SET raw_row = '{}'
         WHERE status != 'written' AND ingested_at < ?1 AND raw_row != '{}'`
      )
      .bind(ingestedBefore)
      .run();
    return result.meta.changes;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/db/rows.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/db/rows.ts src/db/rows.test.ts
git commit -m "feat(benevity-import): rows store"
```

### Task 10: Aliases store

**Files:**
- Create: `benevity-import/src/db/aliases.ts`
- Test: `benevity-import/src/db/aliases.test.ts`

**Interfaces:**
- Produces: `AliasStore`, `D1AliasStore` — the organizations matcher (Task 12) reads it on every
  resolution attempt and writes to it when staff resolve a worklist item by hand (spec:
  Resolution, "the Worker then learns the alias by appending it to a D1 `aliases` table").

- [ ] **Step 1: Write the failing test `src/db/aliases.test.ts`**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { D1AliasStore } from './aliases';
import { applyMigrations } from '../../test/apply-migrations';

describe('D1AliasStore', () => {
  beforeEach(async () => {
    await applyMigrations(env.DB);
  });

  it('returns null for an unlearned company name', async () => {
    const store = new D1AliasStore(env.DB);
    expect(await store.getAlias('Unknown Co')).toBeNull();
  });

  it('learns an alias and returns it on lookup', async () => {
    const store = new D1AliasStore(env.DB);
    await store.learnAlias('Acme Inc', '999', '2026-09-15T00:00:00Z');
    expect(await store.getAlias('Acme Inc')).toBe('999');
  });

  it('overwrites a previously learned alias for the same raw name', async () => {
    const store = new D1AliasStore(env.DB);
    await store.learnAlias('Acme Inc', '999', '2026-09-15T00:00:00Z');
    await store.learnAlias('Acme Inc', '1000', '2026-09-16T00:00:00Z');
    expect(await store.getAlias('Acme Inc')).toBe('1000');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/db/aliases.test.ts`
Expected: FAIL — `./aliases` module doesn't exist yet.

- [ ] **Step 3: Write `src/db/aliases.ts`**

```typescript
export interface AliasStore {
  getAlias(rawCompanyName: string): Promise<string | null>;
  learnAlias(rawCompanyName: string, organizationItemId: string, learnedAt: string): Promise<void>;
}

export class D1AliasStore implements AliasStore {
  constructor(private db: D1Database) {}

  async getAlias(rawCompanyName: string): Promise<string | null> {
    const record = await this.db
      .prepare(`SELECT organization_item_id FROM aliases WHERE raw_company_name = ?1`)
      .bind(rawCompanyName)
      .first<{ organization_item_id: string }>();
    return record === null ? null : record.organization_item_id;
  }

  async learnAlias(rawCompanyName: string, organizationItemId: string, learnedAt: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO aliases (raw_company_name, organization_item_id, learned_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT (raw_company_name) DO UPDATE SET
           organization_item_id = excluded.organization_item_id,
           learned_at = excluded.learned_at`
      )
      .bind(rawCompanyName, organizationItemId, learnedAt)
      .run();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/db/aliases.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/db/aliases.ts src/db/aliases.test.ts
git commit -m "feat(benevity-import): company alias store"
```

### Task 11: Monday GraphQL client

**Files:**
- Create: `benevity-import/src/monday/client.ts`
- Test: `benevity-import/src/monday/client.test.ts`

**Interfaces:**
- Produces: `MondayItem { id: string; name: string }`, `MondayAsset { id: string; name: string;
  publicUrl: string }`, `MondayClient`, `HttpMondayClient` with methods
  `findItemsByColumnValue(boardId, columnId, value): Promise<MondayItem[]>`,
  `findItemsByName(boardId, name): Promise<MondayItem[]>`,
  `getLinkedItemIds(itemId, columnId): Promise<string[]>`,
  `createItem(boardId, itemName, columnValues, groupId?): Promise<MondayItem>`,
  `changeColumnValues(boardId, itemId, columnValues): Promise<void>`,
  `fetchAsset(assetId): Promise<MondayAsset>`. Every resolution/matching task (12, 13) and the
  webhook route (16) and consumer (17) depend on this shape. Unlike `funraise-sync`'s client, every
  lookup returns an **array**, not a single-or-null — this Worker's resolution rules need to tell
  "one match" from "several matches" (spec: Resolution, "Several hits ... worklist").

- [ ] **Step 1: Write the failing test `src/monday/client.test.ts`**

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { HttpMondayClient } from './client';

function mockFetchOnce(responseBody: unknown, ok = true) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => responseBody,
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HttpMondayClient', () => {
  it('finds items by column value', async () => {
    const fetchMock = mockFetchOnce({
      data: { items_page_by_column_values: { items: [{ id: '123', name: 'Jordan Rivera' }] } },
    });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');

    const items = await client.findItemsByColumnValue(999, 'email', 'a@example.com');

    expect(items).toEqual([{ id: '123', name: 'Jordan Rivera' }]);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.variables).toEqual({
      boardId: 999,
      columns: [{ column_id: 'email', column_values: ['a@example.com'] }],
    });
  });

  it('returns an empty array when nothing matches', async () => {
    mockFetchOnce({ data: { items_page_by_column_values: { items: [] } } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');
    expect(await client.findItemsByColumnValue(999, 'email', 'nobody@example.com')).toEqual([]);
  });

  it('finds items by name using the "name" pseudo-column', async () => {
    const fetchMock = mockFetchOnce({
      data: { items_page_by_column_values: { items: [{ id: '456', name: 'Acme, Inc.' }] } },
    });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');

    const items = await client.findItemsByName(999, 'Acme, Inc.');

    expect(items).toEqual([{ id: '456', name: 'Acme, Inc.' }]);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.variables.columns).toEqual([{ column_id: 'name', column_values: ['Acme, Inc.'] }]);
  });

  it('reads linked item ids from a board-relation column', async () => {
    mockFetchOnce({
      data: { items: [{ column_values: [{ linked_item_ids: ['111', '222'] }] }] },
    });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');
    expect(await client.getLinkedItemIds('789', 'organization_link')).toEqual(['111', '222']);
  });

  it('returns an empty array when a board-relation column has no linked items', async () => {
    mockFetchOnce({ data: { items: [{ column_values: [{}] }] } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');
    expect(await client.getLinkedItemIds('789', 'organization_link')).toEqual([]);
  });

  it('creates an item, optionally in a group', async () => {
    const fetchMock = mockFetchOnce({ data: { create_item: { id: '456', name: 'Jane - Donation' } } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');

    const item = await client.createItem(999, 'Jane - Donation', { amount: 50 }, 'review');

    expect(item).toEqual({ id: '456', name: 'Jane - Donation' });
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.variables.itemName).toBe('Jane - Donation');
    expect(body.variables.groupId).toBe('review');
    expect(JSON.parse(body.variables.columnValues)).toEqual({ amount: 50 });
  });

  it('changes column values on an existing item', async () => {
    const fetchMock = mockFetchOnce({ data: { change_multiple_column_values: { id: '456' } } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');
    await client.changeColumnValues(999, '456', { amount: 75 });
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(JSON.parse(body.variables.columnValues)).toEqual({ amount: 75 });
  });

  it('fetches an asset by id', async () => {
    mockFetchOnce({
      data: { assets: [{ id: 'a1', name: 'report.csv', public_url: 'https://files.monday.com/a1' }] },
    });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');
    const asset = await client.fetchAsset('a1');
    expect(asset).toEqual({ id: 'a1', name: 'report.csv', publicUrl: 'https://files.monday.com/a1' });
  });

  it('throws when the requested asset is not found', async () => {
    mockFetchOnce({ data: { assets: [] } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');
    await expect(client.fetchAsset('missing')).rejects.toThrow(/not found/);
  });

  it('throws with the server message when the API returns GraphQL errors', async () => {
    mockFetchOnce({ errors: [{ message: 'Invalid board id' }] });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');
    await expect(client.findItemsByColumnValue(999, 'email', 'x')).rejects.toThrow(/Invalid board id/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/monday/client.test.ts`
Expected: FAIL — `./client` module doesn't exist yet.

- [ ] **Step 3: Write `src/monday/client.ts`**

```typescript
export interface MondayItem {
  id: string;
  name: string;
}

export interface MondayAsset {
  id: string;
  name: string;
  publicUrl: string;
}

export interface MondayClient {
  findItemsByColumnValue(boardId: number, columnId: string, value: string): Promise<MondayItem[]>;
  findItemsByName(boardId: number, name: string): Promise<MondayItem[]>;
  getLinkedItemIds(itemId: string, columnId: string): Promise<string[]>;
  createItem(
    boardId: number,
    itemName: string,
    columnValues: Record<string, unknown>,
    groupId?: string
  ): Promise<MondayItem>;
  changeColumnValues(boardId: number, itemId: string, columnValues: Record<string, unknown>): Promise<void>;
  fetchAsset(assetId: string): Promise<MondayAsset>;
}

const MONDAY_API_VERSION = '2026-01';

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
  // Monday's rate-limit / auth-failure shape: HTTP 200 with no data and no errors array.
  error_message?: string;
  status_code?: number;
}

export class HttpMondayClient implements MondayClient {
  constructor(
    private apiUrl: string,
    private apiToken: string
  ) {}

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.apiToken,
        'API-Version': MONDAY_API_VERSION,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
      throw new Error(`monday API: HTTP ${response.status}`);
    }
    const json = (await response.json()) as GraphQLResponse<T>;
    if (json.errors && json.errors.length > 0) {
      throw new Error(`monday API: ${json.errors.map((e) => e.message).join('; ')}`);
    }
    if (!json.data) {
      const detail =
        typeof json.error_message === 'string'
          ? `${json.error_message}${json.status_code === undefined ? '' : ` (status_code ${json.status_code})`}`
          : JSON.stringify(json);
      throw new Error(`monday API: response contained no data — ${detail}`);
    }
    return json.data;
  }

  async findItemsByColumnValue(boardId: number, columnId: string, value: string): Promise<MondayItem[]> {
    const data = await this.graphql<{ items_page_by_column_values: { items: MondayItem[] } }>(
      `query ($boardId: ID!, $columns: [ItemsPageByColumnValuesQuery!]!) {
        items_page_by_column_values(board_id: $boardId, columns: $columns) {
          items { id name }
        }
      }`,
      { boardId, columns: [{ column_id: columnId, column_values: [value] }] }
    );
    return data.items_page_by_column_values.items;
  }

  // Monday's item name is filterable through the same items_page_by_column_values query using
  // the reserved column_id "name" — no separate query shape needed.
  findItemsByName(boardId: number, name: string): Promise<MondayItem[]> {
    return this.findItemsByColumnValue(boardId, 'name', name);
  }

  async getLinkedItemIds(itemId: string, columnId: string): Promise<string[]> {
    const data = await this.graphql<{
      items: { column_values: { linked_item_ids?: string[] }[] }[];
    }>(
      `query ($itemId: ID!, $columnId: [String!]) {
        items(ids: [$itemId]) {
          column_values(ids: $columnId) {
            ... on BoardRelationValue { linked_item_ids }
          }
        }
      }`,
      { itemId, columnId: [columnId] }
    );
    const item = data.items[0];
    if (!item || item.column_values.length === 0) return [];
    return item.column_values[0]?.linked_item_ids ?? [];
  }

  async createItem(
    boardId: number,
    itemName: string,
    columnValues: Record<string, unknown>,
    groupId?: string
  ): Promise<MondayItem> {
    const data = await this.graphql<{ create_item: MondayItem }>(
      `mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!, $groupId: String) {
        create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues, group_id: $groupId) {
          id name
        }
      }`,
      { boardId, itemName, columnValues: JSON.stringify(columnValues), groupId: groupId ?? null }
    );
    return data.create_item;
  }

  async changeColumnValues(boardId: number, itemId: string, columnValues: Record<string, unknown>): Promise<void> {
    await this.graphql<{ change_multiple_column_values: MondayItem }>(
      `mutation ($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
        change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $columnValues) {
          id
        }
      }`,
      { boardId, itemId, columnValues: JSON.stringify(columnValues) }
    );
  }

  async fetchAsset(assetId: string): Promise<MondayAsset> {
    const data = await this.graphql<{ assets: { id: string; name: string; public_url: string }[] }>(
      `query ($assetIds: [ID!]!) {
        assets(ids: $assetIds) { id name public_url }
      }`,
      { assetIds: [assetId] }
    );
    const asset = data.assets[0];
    if (!asset) {
      throw new Error(`monday API: asset "${assetId}" not found`);
    }
    return { id: asset.id, name: asset.name, publicUrl: asset.public_url };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/monday/client.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/monday/client.ts src/monday/client.test.ts
git commit -m "feat(benevity-import): Monday GraphQL client"
```

**Verify against the live API before deploy (flagged, not hidden):** `getLinkedItemIds`'s
`BoardRelationValue` fragment and `fetchAsset`'s `public_url` field match Monday's documented v2
schema as of this plan's writing, but — same as the CSV column names — confirm both against
Monday's live GraphQL schema explorer for this account before the first real deploy, since column
type internals occasionally shift between API versions.

### Task 12: Organization resolution

**Files:**
- Create: `benevity-import/src/matching/organizations.ts`
- Test: `benevity-import/src/matching/organizations.test.ts`

**Interfaces:**
- Consumes: `MondayClient` (Task 11), `AliasStore` (Task 10), `BenevityImportConfig` (Task 2).
- Produces: `OrganizationResolution`, `resolveOrganization(mondayClient, aliasStore, config,
  companyName): Promise<OrganizationResolution>` — the consumer (Task 17) calls this first for
  every row; a company match is required before person resolution runs (spec: Data flow step 1).

**Design note on "case-insensitive" exact matching:** Monday's `items_page_by_column_values`
already does case-insensitive text comparison against the `name` pseudo-column, so a plain
`findItemsByName` covers the spec's "exact, case-insensitive match" directly — no client-side
normalization needed for that step. What it *can't* do is match across genuinely different
strings ("Google, LLC" vs "Google") — that's what the alias table (config-seeded, then learned in
D1) is for.

- [ ] **Step 1: Write the failing test `src/matching/organizations.test.ts`**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { resolveOrganization } from './organizations';
import type { MondayClient, MondayItem } from '../monday/client';
import type { AliasStore } from '../db/aliases';
import type { BenevityImportConfig } from '../types';

function fakeConfig(aliases: Record<string, string> = {}): BenevityImportConfig {
  return {
    monday: { apiUrl: '', boards: { donations: 1, organizations: 222, people: 1, affiliations: 1, benevityUploads: 1 } },
    benevityImport: {
      minDonationDate: '2026-07-01',
      donationsColumns: {} as never,
      organizationsNameColumn: 'name',
      peopleColumns: {} as never,
      affiliationsColumns: {} as never,
      uploadsBoard: {} as never,
      organizationAliases: aliases,
      rawRowRetentionDays: 90,
      unresolvedRowRetentionDays: 365,
    },
  };
}

function fakeMondayClient(overrides: Partial<MondayClient> = {}): MondayClient {
  return {
    findItemsByColumnValue: vi.fn().mockResolvedValue([]),
    findItemsByName: vi.fn().mockResolvedValue([]),
    getLinkedItemIds: vi.fn().mockResolvedValue([]),
    createItem: vi.fn(),
    changeColumnValues: vi.fn(),
    fetchAsset: vi.fn(),
    ...overrides,
  };
}

function fakeAliasStore(overrides: Partial<AliasStore> = {}): AliasStore {
  return {
    getAlias: vi.fn().mockResolvedValue(null),
    learnAlias: vi.fn(),
    ...overrides,
  };
}

describe('resolveOrganization', () => {
  it('resolves on an exact name match', async () => {
    const monday = fakeMondayClient({
      findItemsByName: vi.fn().mockResolvedValue([{ id: '1', name: 'Acme' } satisfies MondayItem]),
    });
    const result = await resolveOrganization(monday, fakeAliasStore(), fakeConfig(), 'Acme');
    expect(result).toEqual({ status: 'resolved', organizationItemId: '1' });
  });

  it('resolves through a previously learned D1 alias without another name lookup', async () => {
    const findItemsByName = vi.fn().mockResolvedValue([]);
    const monday = fakeMondayClient({ findItemsByName });
    const aliasStore = fakeAliasStore({ getAlias: vi.fn().mockResolvedValue('42') });
    const result = await resolveOrganization(monday, aliasStore, fakeConfig(), 'Acme Holdings');
    expect(result).toEqual({ status: 'resolved', organizationItemId: '42' });
  });

  it('resolves through a config-seeded alias', async () => {
    const monday = fakeMondayClient({
      findItemsByName: vi
        .fn()
        .mockResolvedValueOnce([]) // exact match on raw name fails
        .mockResolvedValueOnce([{ id: '7', name: 'Google' } satisfies MondayItem]), // alias target found
    });
    const config = fakeConfig({ 'Google, LLC': 'Google' });
    const result = await resolveOrganization(monday, fakeAliasStore(), config, 'Google, LLC');
    expect(result).toEqual({ status: 'resolved', organizationItemId: '7' });
  });

  it('goes to the worklist when nothing matches', async () => {
    const monday = fakeMondayClient();
    const result = await resolveOrganization(monday, fakeAliasStore(), fakeConfig(), 'Totally Unknown Co');
    expect(result.status).toBe('unresolved');
  });

  it('goes to the worklist when the name lookup returns more than one exact match', async () => {
    const monday = fakeMondayClient({
      findItemsByName: vi.fn().mockResolvedValue([
        { id: '1', name: 'Acme' },
        { id: '2', name: 'Acme' },
      ] satisfies MondayItem[]),
    });
    const result = await resolveOrganization(monday, fakeAliasStore(), fakeConfig(), 'Acme');
    expect(result.status).toBe('unresolved');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/matching/organizations.test.ts`
Expected: FAIL — `./organizations` module doesn't exist yet.

- [ ] **Step 3: Write `src/matching/organizations.ts`**

```typescript
import type { MondayClient } from '../monday/client';
import type { AliasStore } from '../db/aliases';
import type { BenevityImportConfig } from '../types';

export type OrganizationResolution =
  | { status: 'resolved'; organizationItemId: string }
  | { status: 'unresolved'; reason: string };

function exactlyOne(items: { id: string; name: string }[], expectedName: string): string | null {
  const matches = items.filter((item) => item.name.toLowerCase() === expectedName.toLowerCase());
  return matches.length === 1 ? matches[0].id : null;
}

export async function resolveOrganization(
  mondayClient: MondayClient,
  aliasStore: AliasStore,
  config: BenevityImportConfig,
  companyName: string
): Promise<OrganizationResolution> {
  const boardId = config.monday.boards.organizations;
  if (boardId === null) {
    throw new Error('config: monday.boards.organizations is not configured');
  }

  const exact = await mondayClient.findItemsByName(boardId, companyName);
  const exactId = exactlyOne(exact, companyName);
  if (exactId) return { status: 'resolved', organizationItemId: exactId };
  if (exact.length > 1) {
    return { status: 'unresolved', reason: `"${companyName}" matches ${exact.length} Organizations by name` };
  }

  const learnedId = await aliasStore.getAlias(companyName);
  if (learnedId) return { status: 'resolved', organizationItemId: learnedId };

  const configAlias = config.benevityImport.organizationAliases[companyName];
  if (configAlias) {
    const aliased = await mondayClient.findItemsByName(boardId, configAlias);
    const aliasedId = exactlyOne(aliased, configAlias);
    if (aliasedId) return { status: 'resolved', organizationItemId: aliasedId };
  }

  return { status: 'unresolved', reason: `no Organization matches "${companyName}"` };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/matching/organizations.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/matching/organizations.ts src/matching/organizations.test.ts
git commit -m "feat(benevity-import): organization resolution"
```

### Task 13: Person resolution

**Files:**
- Create: `benevity-import/src/matching/people.ts`
- Test: `benevity-import/src/matching/people.test.ts`

**Interfaces:**
- Consumes: `MondayClient` (Task 11), `BenevityImportConfig` (Task 2).
- Produces: `PersonResolution`, `resolvePerson(mondayClient, config, row, organizationItemId):
  Promise<PersonResolution>` — the consumer (Task 17) calls this after `resolveOrganization`
  succeeds. `row` is the subset of `ParsedRow` needed here: `{ company, donorFirstName,
  donorLastName, email }`.

**Resolution order (spec: Resolution, Employee → People item):**
1. Both name and email withheld (blank or the literal `Not shared by donor`) → `anonymous`,
   no further lookups.
2. Email, normalized: check People `Personal Email`, People `Household Email`, and Affiliations
   `Work Email` (resolved back to the linked Person via `getLinkedItemIds`). Exactly one candidate
   across all three → resolved. More than one → `unresolved` with the candidate ids listed.
3. Name + employer: find People whose name exactly matches, intersected with People who are
   either (a) linked to the resolved Organization via an Affiliations row, or (b) have an
   `Employer` text value equal to the row's `Company` string. Exactly one → resolved; otherwise →
   `unresolved` with candidates.
4. Neither step resolves → `unresolved`, never auto-created (spec: "propose, staff confirm").

- [ ] **Step 1: Write the failing test `src/matching/people.test.ts`**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { resolvePerson } from './people';
import type { MondayClient, MondayItem } from '../monday/client';
import type { BenevityImportConfig } from '../types';

function fakeConfig(): BenevityImportConfig {
  return {
    monday: { apiUrl: '', boards: { donations: 1, organizations: 1, people: 222, affiliations: 333, benevityUploads: 1 } },
    benevityImport: {
      minDonationDate: '2026-07-01',
      donationsColumns: {} as never,
      organizationsNameColumn: 'name',
      peopleColumns: { personalEmail: 'personal_email', householdEmail: 'household_email', employer: 'employer' },
      affiliationsColumns: { person: 'person_link', organization: 'org_link', workEmail: 'work_email' },
      uploadsBoard: {} as never,
      organizationAliases: {},
      rawRowRetentionDays: 90,
      unresolvedRowRetentionDays: 365,
    },
  };
}

function fakeMondayClient(overrides: Partial<MondayClient> = {}): MondayClient {
  return {
    findItemsByColumnValue: vi.fn().mockResolvedValue([]),
    findItemsByName: vi.fn().mockResolvedValue([]),
    getLinkedItemIds: vi.fn().mockResolvedValue([]),
    createItem: vi.fn(),
    changeColumnValues: vi.fn(),
    fetchAsset: vi.fn(),
    ...overrides,
  };
}

const anonymousRow = { company: 'Acme', donorFirstName: 'Not shared by donor', donorLastName: 'Not shared by donor', email: 'Not shared by donor' };

describe('resolvePerson', () => {
  it('is anonymous when name and email are both withheld', async () => {
    const result = await resolvePerson(fakeMondayClient(), fakeConfig(), anonymousRow, '1');
    expect(result).toEqual({ status: 'anonymous' });
  });

  it('resolves on a single personal-email match', async () => {
    const monday = fakeMondayClient({
      findItemsByColumnValue: vi.fn((boardId, columnId) =>
        columnId === 'personal_email' ? Promise.resolve([{ id: '1', name: 'Jordan Rivera' }]) : Promise.resolve([])
      ),
    });
    const result = await resolvePerson(
      monday,
      fakeConfig(),
      { company: 'Acme', donorFirstName: 'Jordan', donorLastName: 'Rivera', email: 'jordan@acme.example' },
      '1'
    );
    expect(result).toEqual({ status: 'resolved', personItemId: '1' });
  });

  it('goes to the worklist when the email matches more than one Person', async () => {
    const monday = fakeMondayClient({
      findItemsByColumnValue: vi.fn((boardId, columnId) =>
        columnId === 'personal_email'
          ? Promise.resolve([{ id: '1', name: 'A' }])
          : columnId === 'household_email'
            ? Promise.resolve([{ id: '2', name: 'B' }])
            : Promise.resolve([])
      ),
    });
    const result = await resolvePerson(
      monday,
      fakeConfig(),
      { company: 'Acme', donorFirstName: 'Jordan', donorLastName: 'Rivera', email: 'shared@acme.example' },
      '1'
    );
    expect(result.status).toBe('unresolved');
    if (result.status === 'unresolved') {
      expect(result.candidates.sort()).toEqual(['1', '2']);
    }
  });

  it('resolves on name + an Affiliation linking the Person to the resolved Organization, when no email is disclosed', async () => {
    const monday = fakeMondayClient({
      findItemsByColumnValue: vi.fn((boardId, columnId, value) =>
        columnId === 'org_link' && value === '99' ? Promise.resolve([{ id: 'aff-1', name: 'Affiliation' }]) : Promise.resolve([])
      ),
      findItemsByName: vi.fn().mockResolvedValue([{ id: '5', name: 'Jordan Rivera' }] satisfies MondayItem[]),
      getLinkedItemIds: vi.fn().mockResolvedValue(['5']),
    });
    const result = await resolvePerson(
      monday,
      fakeConfig(),
      { company: 'Acme', donorFirstName: 'Jordan', donorLastName: 'Rivera', email: 'Not shared by donor' },
      '99'
    );
    expect(result).toEqual({ status: 'resolved', personItemId: '5' });
  });

  it('resolves on name + a matching Employer text field', async () => {
    const monday = fakeMondayClient({
      findItemsByColumnValue: vi.fn((boardId, columnId, value) =>
        columnId === 'employer' && value === 'Acme' ? Promise.resolve([{ id: '5', name: 'Jordan Rivera' }]) : Promise.resolve([])
      ),
      findItemsByName: vi.fn().mockResolvedValue([{ id: '5', name: 'Jordan Rivera' }] satisfies MondayItem[]),
    });
    const result = await resolvePerson(
      monday,
      fakeConfig(),
      { company: 'Acme', donorFirstName: 'Jordan', donorLastName: 'Rivera', email: 'Not shared by donor' },
      '99'
    );
    expect(result).toEqual({ status: 'resolved', personItemId: '5' });
  });

  it('goes to the worklist when no email and no employer-confirmed name match exists', async () => {
    const monday = fakeMondayClient({
      findItemsByName: vi.fn().mockResolvedValue([{ id: '5', name: 'Jordan Rivera' }] satisfies MondayItem[]),
    });
    const result = await resolvePerson(
      monday,
      fakeConfig(),
      { company: 'Acme', donorFirstName: 'Jordan', donorLastName: 'Rivera', email: 'Not shared by donor' },
      '99'
    );
    expect(result.status).toBe('unresolved');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/matching/people.test.ts`
Expected: FAIL — `./people` module doesn't exist yet.

- [ ] **Step 3: Write `src/matching/people.ts`**

```typescript
import type { MondayClient } from '../monday/client';
import type { BenevityImportConfig } from '../types';

export type PersonResolution =
  | { status: 'resolved'; personItemId: string }
  | { status: 'anonymous' }
  | { status: 'unresolved'; reason: string; candidates: string[] };

export interface PersonResolutionRow {
  company: string;
  donorFirstName: string;
  donorLastName: string;
  email: string;
}

function isWithheld(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  return trimmed === '' || trimmed === 'not shared by donor';
}

export async function resolvePerson(
  mondayClient: MondayClient,
  config: BenevityImportConfig,
  row: PersonResolutionRow,
  organizationItemId: string
): Promise<PersonResolution> {
  const hasEmail = !isWithheld(row.email);
  const hasName = !isWithheld(row.donorFirstName) && !isWithheld(row.donorLastName);
  if (!hasEmail && !hasName) return { status: 'anonymous' };

  const peopleBoardId = config.monday.boards.people;
  const affiliationsBoardId = config.monday.boards.affiliations;
  if (peopleBoardId === null) throw new Error('config: monday.boards.people is not configured');
  if (affiliationsBoardId === null) throw new Error('config: monday.boards.affiliations is not configured');
  const { peopleColumns, affiliationsColumns } = config.benevityImport;

  if (hasEmail) {
    const email = row.email.trim().toLowerCase();
    const [byPersonalEmail, byHouseholdEmail, workEmailAffiliations] = await Promise.all([
      mondayClient.findItemsByColumnValue(peopleBoardId, peopleColumns.personalEmail, email),
      mondayClient.findItemsByColumnValue(peopleBoardId, peopleColumns.householdEmail, email),
      mondayClient.findItemsByColumnValue(affiliationsBoardId, affiliationsColumns.workEmail, email),
    ]);
    const workEmailPersonIds = (
      await Promise.all(
        workEmailAffiliations.map((affiliation) => mondayClient.getLinkedItemIds(affiliation.id, affiliationsColumns.person))
      )
    ).flat();

    const candidateIds = new Set<string>([
      ...byPersonalEmail.map((item) => item.id),
      ...byHouseholdEmail.map((item) => item.id),
      ...workEmailPersonIds,
    ]);
    if (candidateIds.size === 1) {
      return { status: 'resolved', personItemId: [...candidateIds][0] };
    }
    if (candidateIds.size > 1) {
      return {
        status: 'unresolved',
        reason: `email "${row.email}" matches ${candidateIds.size} People`,
        candidates: [...candidateIds],
      };
    }
  }

  if (hasName) {
    const fullName = `${row.donorFirstName} ${row.donorLastName}`.trim().toLowerCase();
    const [nameMatches, affiliationsAtOrg, employerTextMatches] = await Promise.all([
      mondayClient.findItemsByName(peopleBoardId, `${row.donorFirstName} ${row.donorLastName}`),
      mondayClient.findItemsByColumnValue(affiliationsBoardId, affiliationsColumns.organization, organizationItemId),
      mondayClient.findItemsByColumnValue(peopleBoardId, peopleColumns.employer, row.company),
    ]);
    const exactNameMatches = nameMatches.filter((item) => item.name.trim().toLowerCase() === fullName);
    const affiliatedPersonIds = new Set(
      (
        await Promise.all(affiliationsAtOrg.map((a) => mondayClient.getLinkedItemIds(a.id, affiliationsColumns.person)))
      ).flat()
    );
    const employerTextIds = new Set(employerTextMatches.map((item) => item.id));

    const employerConfirmed = exactNameMatches.filter(
      (item) => affiliatedPersonIds.has(item.id) || employerTextIds.has(item.id)
    );
    if (employerConfirmed.length === 1) {
      return { status: 'resolved', personItemId: employerConfirmed[0].id };
    }
    if (employerConfirmed.length > 1) {
      return {
        status: 'unresolved',
        reason: `name "${row.donorFirstName} ${row.donorLastName}" + employer matches ${employerConfirmed.length} People`,
        candidates: employerConfirmed.map((item) => item.id),
      };
    }
  }

  return {
    status: 'unresolved',
    reason: `no email or name+employer match for "${row.donorFirstName} ${row.donorLastName}" <${row.email}>`,
    candidates: [],
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/matching/people.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/matching/people.ts src/matching/people.test.ts
git commit -m "feat(benevity-import): person resolution"
```

### Task 14: Gift splitting

**Files:**
- Create: `benevity-import/src/mapping/giftSplit.ts`
- Test: `benevity-import/src/mapping/giftSplit.test.ts`

**Interfaces:**
- Consumes: `ParsedRow` (Task 5), `fiscalYearEnding` (Task 6), `BenevityImportConfig` (Task 2).
- Produces: `GiftContext`, `GiftSpec`, `splitRowIntoGifts(ctx, config): GiftSpec[]` — pure, no I/O
  (mirrors `funraise-sync`'s `mapping/fieldMap.ts`). The consumer (Task 17) is the only caller;
  it fills in `organizationItemId`/`personItemId` from Tasks 12-13 before calling this.

Implements the spec's "Splitting a row into gifts" table exactly: up to two `GiftSpec`s per row,
each carrying its own Transaction-ID-derived idempotency key (`<id>` / `<id>-match`), `Gift Type`
and `Status` label strings verbatim, and the Global Constraint that `Matched By` is set only on
the match gift.

- [ ] **Step 1: Write the failing test `src/mapping/giftSplit.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { splitRowIntoGifts } from './giftSplit';
import type { ParsedRow } from '../parse/report';
import type { BenevityImportConfig } from '../types';

function fakeConfig(): BenevityImportConfig {
  return {
    monday: { apiUrl: '', boards: { donations: 1, organizations: 1, people: 1, affiliations: 1, benevityUploads: 1 } },
    benevityImport: {
      minDonationDate: '2026-07-01',
      donationsColumns: {
        donor: 'donor_col',
        matchedBy: 'matched_by_col',
        amount: 'amount_col',
        date: 'date_col',
        disbursementDate: 'disbursement_date_col',
        fiscalYearEnding: 'fy_col',
        status: 'status_col',
        giftType: 'gift_type_col',
        anonymousDonor: 'anon_col',
        transactionId: 'txn_col',
      },
      organizationsNameColumn: 'name',
      peopleColumns: {} as never,
      affiliationsColumns: {} as never,
      uploadsBoard: {} as never,
      organizationAliases: {},
      rawRowRetentionDays: 90,
      unresolvedRowRetentionDays: 365,
    },
  };
}

function fakeRow(overrides: Partial<ParsedRow> = {}): ParsedRow {
  return {
    company: 'Acme, Inc.',
    donorFirstName: 'Jordan',
    donorLastName: 'Rivera',
    email: 'jordan@acme.example',
    donationDate: '2025-12-06',
    transactionId: 'TXN001',
    donationFrequency: 'One Time',
    currency: 'USD',
    totalDonationToBeAcknowledged: 50,
    matchAmount: 100,
    notes: '',
    ...overrides,
  };
}

describe('splitRowIntoGifts', () => {
  it('produces both an employee gift and a company match when both amounts are positive', () => {
    const gifts = splitRowIntoGifts(
      { row: fakeRow(), disbursementPeriodEnding: '2025-12-16', organizationItemId: '99', personItemId: '5' },
      fakeConfig()
    );
    expect(gifts).toHaveLength(2);
    expect(gifts.map((g) => g.transactionId)).toEqual(['TXN001', 'TXN001-match']);
  });

  it('produces only the employee gift when there is no match amount', () => {
    const gifts = splitRowIntoGifts(
      { row: fakeRow({ matchAmount: 0 }), disbursementPeriodEnding: '2025-12-16', organizationItemId: '99', personItemId: '5' },
      fakeConfig()
    );
    expect(gifts).toHaveLength(1);
    expect(gifts[0].transactionId).toBe('TXN001');
  });

  it('produces only the company match when there is no employee amount', () => {
    const gifts = splitRowIntoGifts(
      {
        row: fakeRow({ totalDonationToBeAcknowledged: 0 }),
        disbursementPeriodEnding: '2025-12-16',
        organizationItemId: '99',
        personItemId: '5',
      },
      fakeConfig()
    );
    expect(gifts).toHaveLength(1);
    expect(gifts[0].transactionId).toBe('TXN001-match');
  });

  it('sets exact Gift Type and Status labels, and Matched By only on the match gift', () => {
    const config = fakeConfig();
    const [employeeGift, matchGift] = splitRowIntoGifts(
      { row: fakeRow(), disbursementPeriodEnding: '2025-12-16', organizationItemId: '99', personItemId: '5' },
      config
    );
    expect(employeeGift.columnValues[config.benevityImport.donationsColumns.giftType]).toEqual({ label: 'Donation' });
    expect(employeeGift.columnValues[config.benevityImport.donationsColumns.status]).toEqual({ label: 'Received' });
    expect(employeeGift.columnValues[config.benevityImport.donationsColumns.matchedBy]).toBeUndefined();
    expect(matchGift.columnValues[config.benevityImport.donationsColumns.giftType]).toEqual({ label: 'Matching Donation' });
    expect(matchGift.columnValues[config.benevityImport.donationsColumns.matchedBy]).toEqual({ item_ids: [99] });
  });

  it('writes the disbursement Period Ending separately from the row Donation Date', () => {
    const config = fakeConfig();
    const [gift] = splitRowIntoGifts(
      { row: fakeRow(), disbursementPeriodEnding: '2025-12-16', organizationItemId: '99', personItemId: '5' },
      config
    );
    expect(gift.columnValues[config.benevityImport.donationsColumns.date]).toEqual({ date: '2025-12-06' });
    expect(gift.columnValues[config.benevityImport.donationsColumns.disbursementDate]).toEqual({ date: '2025-12-16' });
  });

  it('checks Anonymous Donor and omits Donor when no person is resolved', () => {
    const config = fakeConfig();
    const [gift] = splitRowIntoGifts(
      { row: fakeRow(), disbursementPeriodEnding: '2025-12-16', organizationItemId: '99', personItemId: null },
      config
    );
    expect(gift.columnValues[config.benevityImport.donationsColumns.anonymousDonor]).toEqual({ checked: 'true' });
    expect(gift.columnValues[config.benevityImport.donationsColumns.donor]).toBeUndefined();
    expect(gift.itemName).toContain('Anonymous');
  });

  it('computes Fiscal Year Ending from the Donation Date', () => {
    const config = fakeConfig();
    const [gift] = splitRowIntoGifts(
      {
        row: fakeRow({ donationDate: '2026-08-01' }),
        disbursementPeriodEnding: '2026-08-15',
        organizationItemId: '99',
        personItemId: '5',
      },
      config
    );
    expect(gift.columnValues[config.benevityImport.donationsColumns.fiscalYearEnding]).toEqual({ date: '2027-06-30' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/mapping/giftSplit.test.ts`
Expected: FAIL — `./giftSplit` module doesn't exist yet.

- [ ] **Step 3: Write `src/mapping/giftSplit.ts`**

```typescript
import type { ParsedRow } from '../parse/report';
import type { BenevityImportConfig } from '../types';
import { fiscalYearEnding } from './fiscalYear';

export interface GiftContext {
  row: ParsedRow;
  disbursementPeriodEnding: string;
  organizationItemId: string;
  // null means no Person was resolved (anonymous or withheld) — never a placeholder for "not yet looked up".
  personItemId: string | null;
}

export interface GiftSpec {
  transactionId: string;
  itemName: string;
  columnValues: Record<string, unknown>;
}

export function splitRowIntoGifts(ctx: GiftContext, config: BenevityImportConfig): GiftSpec[] {
  const { row, disbursementPeriodEnding, organizationItemId, personItemId } = ctx;
  const cols = config.benevityImport.donationsColumns;
  const donorLabel = personItemId ? `${row.donorFirstName} ${row.donorLastName}`.trim() : 'Anonymous';
  const fyEnding = fiscalYearEnding(row.donationDate);

  const baseColumns = (amount: number): Record<string, unknown> => ({
    [cols.amount]: amount,
    [cols.date]: { date: row.donationDate },
    [cols.disbursementDate]: { date: disbursementPeriodEnding },
    [cols.fiscalYearEnding]: { date: fyEnding },
    [cols.status]: { label: 'Received' },
    [cols.anonymousDonor]: { checked: personItemId ? 'false' : 'true' },
    [cols.transactionId]: row.transactionId,
    ...(personItemId ? { [cols.donor]: { item_ids: [Number(personItemId)] } } : {}),
  });

  const gifts: GiftSpec[] = [];

  if (row.totalDonationToBeAcknowledged > 0) {
    gifts.push({
      transactionId: row.transactionId,
      itemName: `${donorLabel} - Donation ${row.donationDate} (Benevity)`,
      columnValues: {
        ...baseColumns(row.totalDonationToBeAcknowledged),
        [cols.giftType]: { label: 'Donation' },
      },
    });
  }

  if (row.matchAmount > 0) {
    gifts.push({
      transactionId: `${row.transactionId}-match`,
      itemName: `${row.company} - Employer Matching ${donorLabel} ${row.donationDate}`,
      columnValues: {
        ...baseColumns(row.matchAmount),
        [cols.giftType]: { label: 'Matching Donation' },
        [cols.matchedBy]: { item_ids: [Number(organizationItemId)] },
      },
    });
  }

  return gifts;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/mapping/giftSplit.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mapping/giftSplit.ts src/mapping/giftSplit.test.ts
git commit -m "feat(benevity-import): split a row into employee/match gift specs"
```

### Task 15: Webhook payload validation and worklist items

**Files:**
- Create: `benevity-import/src/webhook/validate.ts`
- Create: `benevity-import/src/matching/worklist.ts`
- Test: `benevity-import/src/webhook/validate.test.ts`
- Test: `benevity-import/src/matching/worklist.test.ts`

**Interfaces:**
- Produces: `isChallenge(body): boolean`, `validateUploadEvent(body): { itemId: string; assetIds:
  string[] }` — the webhook route (Task 16) is the only caller of both. `WorklistItemInput`,
  `createWorklistItem(mondayClient, config, input): Promise<void>` — used by both the webhook
  route (block-level failures) and the consumer (Task 17, row-level failures), which is why it's
  factored out rather than duplicated (Global Constraints: DRY).

**Verify against a real delivery before deploy (flagged, not hidden):** Monday's file-column
webhook payload shape below (`event.pulseId`, `event.value.files[].assetId`) is this plan's
best-effort match to Monday's documented webhook conventions — same category of thing as the CSV
column names in Task 5 and the GraphQL fragments in Task 11. Capture one real delivery from the
"Benevity Uploads" board during setup and adjust `validateUploadEvent` if the shape differs; the
function's job is exactly this one parse, so the fix stays contained to this file.

- [ ] **Step 1: Write the failing test `src/webhook/validate.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { isChallenge, validateUploadEvent } from './validate';

describe('isChallenge', () => {
  it('recognizes a subscribe handshake payload', () => {
    expect(isChallenge({ challenge: 'abc123' })).toBe(true);
  });

  it('rejects a real event payload', () => {
    expect(isChallenge({ event: { pulseId: 1 } })).toBe(false);
  });
});

describe('validateUploadEvent', () => {
  it('extracts the item id, changed column id, and asset ids from a file-column-change event', () => {
    const body = {
      event: {
        pulseId: 12345,
        columnId: 'file_col',
        value: { files: [{ assetId: 999, name: 'report.csv' }] },
      },
    };
    expect(validateUploadEvent(body)).toEqual({ itemId: '12345', columnId: 'file_col', assetIds: ['999'] });
  });

  it('collects multiple asset ids when more than one file was dropped at once', () => {
    const body = {
      event: { pulseId: 1, columnId: 'file_col', value: { files: [{ assetId: 1 }, { assetId: 2 }] } },
    };
    expect(validateUploadEvent(body)).toEqual({ itemId: '1', columnId: 'file_col', assetIds: ['1', '2'] });
  });

  it('throws when the payload has no event', () => {
    expect(() => validateUploadEvent({})).toThrow(/missing "event"/);
  });

  it('throws when the event has no file assetIds', () => {
    expect(() => validateUploadEvent({ event: { pulseId: 1, columnId: 'file_col', value: {} } })).toThrow(/no file assetIds/);
  });

  it('throws when the event has no columnId', () => {
    expect(() => validateUploadEvent({ event: { pulseId: 1, value: { files: [{ assetId: 1 }] } } })).toThrow(/missing "columnId"/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/webhook/validate.test.ts`
Expected: FAIL — `./validate` module doesn't exist yet.

- [ ] **Step 3: Write `src/webhook/validate.ts`**

```typescript
export function isChallenge(body: unknown): body is { challenge: string } {
  return typeof body === 'object' && body !== null && typeof (body as Record<string, unknown>).challenge === 'string';
}

export interface ValidatedUploadEvent {
  itemId: string;
  // Which column changed. Monday's webhook subscription is itself scoped to one column at setup
  // time, so this is normally redundant — but it's cheap to double-check at runtime rather than
  // trust that the subscription was configured correctly (spec: Trigger, "a file column on a
  // small staff-facing 'Benevity Uploads' board"), and the route (Task 16) uses it to ignore a
  // change on any other column instead of misreading its `value` shape as a file list.
  columnId: string;
  assetIds: string[];
}

export function validateUploadEvent(body: unknown): ValidatedUploadEvent {
  if (typeof body !== 'object' || body === null) {
    throw new Error('benevity webhook: payload must be a JSON object');
  }
  const event = (body as Record<string, unknown>).event;
  if (typeof event !== 'object' || event === null) {
    throw new Error('benevity webhook: payload missing "event"');
  }
  const e = event as Record<string, unknown>;
  const pulseId = e.pulseId;
  if (typeof pulseId !== 'number' && typeof pulseId !== 'string') {
    throw new Error('benevity webhook: event missing "pulseId"');
  }
  const columnId = e.columnId;
  if (typeof columnId !== 'string' || columnId === '') {
    throw new Error('benevity webhook: event missing "columnId"');
  }

  const value = e.value;
  const files =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>).files : undefined;
  const assetIds = Array.isArray(files)
    ? files
        .map((file) => (typeof file === 'object' && file !== null ? (file as Record<string, unknown>).assetId : undefined))
        .filter((id): id is string | number => typeof id === 'string' || typeof id === 'number')
        .map(String)
    : [];
  if (assetIds.length === 0) {
    throw new Error('benevity webhook: event has no file assetIds');
  }

  return { itemId: String(pulseId), columnId, assetIds };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/webhook/validate.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Write the failing test `src/matching/worklist.test.ts`**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createWorklistItem } from './worklist';
import type { MondayClient } from '../monday/client';
import type { BenevityImportConfig } from '../types';

function fakeConfig(): BenevityImportConfig {
  return {
    monday: { apiUrl: '', boards: { donations: 1, organizations: 1, people: 1, affiliations: 1, benevityUploads: 777 } },
    benevityImport: {
      minDonationDate: '2026-07-01',
      donationsColumns: {} as never,
      organizationsNameColumn: 'name',
      peopleColumns: {} as never,
      affiliationsColumns: {} as never,
      uploadsBoard: {
        fileColumn: 'file_col',
        worklistGroupId: 'review',
        worklistColumns: { reason: 'reason_c', name: 'name_c', email: 'email_c', company: 'company_c', amount: 'amount_c', date: 'date_c' },
      },
      organizationAliases: {},
      rawRowRetentionDays: 90,
      unresolvedRowRetentionDays: 365,
    },
  };
}

describe('createWorklistItem', () => {
  it('creates an item in the configured review group with the given reason', async () => {
    const createItem = vi.fn().mockResolvedValue({ id: '1', name: 'x' });
    const monday = { createItem } as unknown as MondayClient;

    await createWorklistItem(monday, fakeConfig(), {
      reason: 'no Organization matches "Acme Co"',
      name: 'Jordan Rivera',
      email: 'jordan@acme.example',
      company: 'Acme Co',
      amount: 50,
      date: '2025-12-06',
    });

    expect(createItem).toHaveBeenCalledWith(
      777,
      'Jordan Rivera',
      {
        reason_c: 'no Organization matches "Acme Co"',
        email_c: 'jordan@acme.example',
        company_c: 'Acme Co',
        amount_c: 50,
        date_c: { date: '2025-12-06' },
      },
      'review'
    );
  });

  it('falls back to the company name when no person name is disclosed', async () => {
    const createItem = vi.fn().mockResolvedValue({ id: '1', name: 'x' });
    const monday = { createItem } as unknown as MondayClient;

    await createWorklistItem(monday, fakeConfig(), {
      reason: 'block failed validation',
      name: '',
      email: '',
      company: 'Acme Co',
      amount: 0,
      date: '2025-12-06',
    });

    expect(createItem.mock.calls[0][1]).toBe('Acme Co');
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npm test -- src/matching/worklist.test.ts`
Expected: FAIL — `./worklist` module doesn't exist yet.

- [ ] **Step 7: Write `src/matching/worklist.ts`**

```typescript
import type { MondayClient } from '../monday/client';
import type { BenevityImportConfig } from '../types';

export interface WorklistItemInput {
  reason: string;
  name: string;
  email: string;
  company: string;
  amount: number;
  date: string;
}

export async function createWorklistItem(
  mondayClient: MondayClient,
  config: BenevityImportConfig,
  input: WorklistItemInput
): Promise<void> {
  const boardId = config.monday.boards.benevityUploads;
  if (boardId === null) {
    throw new Error('config: monday.boards.benevityUploads is not configured');
  }
  const { worklistColumns, worklistGroupId } = config.benevityImport.uploadsBoard;

  await mondayClient.createItem(
    boardId,
    input.name || input.company || 'Benevity row needs review',
    {
      [worklistColumns.reason]: input.reason,
      [worklistColumns.email]: input.email,
      [worklistColumns.company]: input.company,
      [worklistColumns.amount]: input.amount,
      [worklistColumns.date]: { date: input.date },
    },
    worklistGroupId
  );
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npm test -- src/matching/worklist.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 9: Commit**

```bash
git add src/webhook/validate.ts src/webhook/validate.test.ts src/matching/worklist.ts src/matching/worklist.test.ts
git commit -m "feat(benevity-import): webhook payload validation and worklist items"
```

### Task 16: Webhook route (ingestion)

**Files:**
- Create: `benevity-import/src/webhook/route.ts`
- Test: `benevity-import/src/webhook/route.test.ts`

**Interfaces:**
- Consumes: `isChallenge`/`validateUploadEvent` (Task 15), `createWorklistItem` (Task 15),
  `parseBenevityReport`/`ParsedBlock` (Task 5), `MondayClient` (Task 11), `UploadStore` (Task 7),
  `DisbursementStore` (Task 8), `RowStore` (Task 9), `errorMessage` (Task 3).
- Produces: `AppDeps`, `QueueLike`, `createApp(deps): Hono` — `src/index.ts` (Task 18) is the only
  caller. `QueueLike.send(message: BenevityQueueMessage)` — `BenevityQueueMessage` itself is
  defined in Task 17 (`consumer/processBatch.ts`) since the consumer owns the queue message shape,
  same convention as `funraise-sync`.

This task implements the "Cloudflare Worker (webhook handler)" box of the spec's Data flow
diagram: fetch the asset, split it into blocks, validate each block's own header and total-sum,
upsert rows (skipping anything before `minDonationDate`), and enqueue only rows that are new and
valid. A block that fails validation gets exactly one worklist item — not one per row — so a bad
total doesn't spam the review board (spec: "one bad block in a bundled file doesn't lose the good
ones around it").

- [ ] **Step 1: Write the failing test `src/webhook/route.test.ts`**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createApp, type AppDeps } from './route';
import type { MondayClient } from '../monday/client';
import type { UploadStore } from '../db/uploads';
import type { DisbursementStore } from '../db/disbursements';
import type { RowStore } from '../db/rows';
import type { BenevityImportConfig } from '../types';

const SECRET = 'test-secret';

function fakeConfig(): BenevityImportConfig {
  return {
    monday: { apiUrl: '', boards: { donations: 1, organizations: 1, people: 1, affiliations: 1, benevityUploads: 777 } },
    benevityImport: {
      minDonationDate: '2026-01-01',
      donationsColumns: {} as never,
      organizationsNameColumn: 'name',
      peopleColumns: {} as never,
      affiliationsColumns: {} as never,
      uploadsBoard: {
        fileColumn: 'file_col',
        worklistGroupId: 'review',
        worklistColumns: { reason: 'reason_c', name: 'name_c', email: 'email_c', company: 'company_c', amount: 'amount_c', date: 'date_c' },
      },
      organizationAliases: {},
      rawRowRetentionDays: 90,
      unresolvedRowRetentionDays: 365,
    },
  };
}

function validReport(opts: { disbursementId?: string; transactionId?: string } = {}): string {
  const { disbursementId = 'ABC123', transactionId = 'TXN001' } = opts;
  return [
    'Donations Report,',
    '"#---",',
    'Charity Name,SVBC',
    'Charity ID,123',
    'Period Ending,Tue 16 Dec 2026 0:00:00',
    'Currency,USD',
    'Payment Method,EFT',
    `Disbursement ID,${disbursementId}`,
    'Note,',
    '"#---",',
    '',
    'Company,Project,Donation Date,Donor First Name,Donor Last Name,Email,Address,City,State/Province,Postal Code,Activity,Comment,Transaction ID,Donation Frequency,Currency,Project Remote ID,Source,Reason,Total Donation to be Acknowledged,Match Amount,Cause Support Fee,Merchant Fee,Fee Comment',
    `"Acme, Inc.",Project,2026-12-06T00:00:00Z,Jordan,Rivera,jordan@acme.example,x,x,x,94043,,,${transactionId},One Time,USD,,BlueSnap,User Donation,50.00,0.00,0.00,0.00,`,
    'Totals,,,,,,,,,,,,,,,,,,50.00,0.00,0.00,0.00',
    'Total Donations (Gross),50.00',
    'Check Fee,0.00',
    'Net Total Payment,50.00',
    '',
  ].join('\n');
}

function fakeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  const uploadStore: UploadStore = {
    createUpload: vi.fn().mockResolvedValue({ id: 1, mondayAssetId: 'a1', uploadedAt: 'now', status: 'parsing', blockCount: 0 }),
    getUploadByAssetId: vi.fn().mockResolvedValue(null),
    markParsed: vi.fn(),
    markError: vi.fn(),
  };
  const disbursementStore: DisbursementStore = {
    createDisbursement: vi.fn().mockImplementation((input) => Promise.resolve({ id: 10, ...input })),
    getDisbursement: vi.fn(),
    listByUpload: vi.fn().mockResolvedValue([]),
  };
  const rowStore: RowStore = {
    upsertRow: vi.fn().mockResolvedValue('inserted'),
    getRow: vi.fn(),
    updateStatus: vi.fn(),
    purgeWrittenRawRows: vi.fn(),
    purgeUnresolvedRawRows: vi.fn(),
  };
  const mondayClient: MondayClient = {
    findItemsByColumnValue: vi.fn().mockResolvedValue([]),
    findItemsByName: vi.fn().mockResolvedValue([]),
    getLinkedItemIds: vi.fn().mockResolvedValue([]),
    createItem: vi.fn().mockResolvedValue({ id: '1', name: 'x' }),
    changeColumnValues: vi.fn(),
    fetchAsset: vi.fn().mockResolvedValue({ id: 'a1', name: 'report.csv', publicUrl: 'https://files.monday.com/a1' }),
  };
  return {
    mondayClient,
    uploadStore,
    disbursementStore,
    rowStore,
    config: fakeConfig(),
    queue: { send: vi.fn().mockResolvedValue(undefined) },
    webhookSecret: SECRET,
    fetchCsv: vi.fn().mockResolvedValue(validReport()),
    now: () => '2026-09-15T00:00:00Z',
    ...overrides,
  };
}

function post(app: ReturnType<typeof createApp>, body: unknown, secret: string | null = SECRET) {
  const url = secret === null ? '/webhooks/monday/benevity-upload' : `/webhooks/monday/benevity-upload?secret=${secret}`;
  return app.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

describe('webhook route', () => {
  it('responds ok on /health', async () => {
    const app = createApp(fakeDeps());
    const res = await app.request('/health');
    expect(res.status).toBe(200);
  });

  it('rejects a request with the wrong secret', async () => {
    const app = createApp(fakeDeps());
    const res = await post(app, { event: {} }, 'wrong');
    expect(res.status).toBe(401);
  });

  it('rejects every request when no secret is configured', async () => {
    const app = createApp(fakeDeps({ webhookSecret: undefined }));
    const res = await post(app, { event: {} });
    expect(res.status).toBe(401);
  });

  it('echoes the Monday subscribe handshake challenge', async () => {
    const app = createApp(fakeDeps());
    const res = await post(app, { challenge: 'abc123' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'abc123' });
  });

  it('ignores a column-change event for a column other than the configured file column', async () => {
    const deps = fakeDeps();
    const app = createApp(deps);
    const res = await post(app, {
      event: { pulseId: 1, columnId: 'some_other_column', value: { files: [{ assetId: 'a1' }] } },
    });
    expect(res.status).toBe(200);
    expect(deps.mondayClient.fetchAsset).not.toHaveBeenCalled();
  });

  it('ingests a valid single-block file and enqueues its row', async () => {
    const deps = fakeDeps();
    const app = createApp(deps);
    const res = await post(app, { event: { pulseId: 1, columnId: 'file_col', value: { files: [{ assetId: 'a1' }] } } });
    expect(res.status).toBe(200);
    expect(deps.rowStore.upsertRow).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: 'TXN001', status: 'ingested' })
    );
    expect(deps.queue.send).toHaveBeenCalledWith({ transactionId: 'TXN001' });
    expect(deps.uploadStore.markParsed).toHaveBeenCalledWith(1, 1);
  });

  it('is a no-op for an asset already ingested', async () => {
    const deps = fakeDeps({ uploadStore: { ...fakeDeps().uploadStore, getUploadByAssetId: vi.fn().mockResolvedValue({ id: 1, mondayAssetId: 'a1', uploadedAt: 'x', status: 'parsed', blockCount: 1 }) } });
    const app = createApp(deps);
    const res = await post(app, { event: { pulseId: 1, columnId: 'file_col', value: { files: [{ assetId: 'a1' }] } } });
    expect(res.status).toBe(200);
    expect(deps.mondayClient.fetchAsset).not.toHaveBeenCalled();
  });

  it('skips a row dated before minDonationDate without enqueueing it', async () => {
    const deps = fakeDeps({ fetchCsv: vi.fn().mockResolvedValue(validReport()) });
    deps.config.benevityImport.minDonationDate = '2027-01-01'; // after the fixture's 2026-12-06 row
    const app = createApp(deps);
    await post(app, { event: { pulseId: 1, columnId: 'file_col', value: { files: [{ assetId: 'a1' }] } } });
    expect(deps.rowStore.upsertRow).toHaveBeenCalledWith(expect.objectContaining({ status: 'skipped' }));
    expect(deps.queue.send).not.toHaveBeenCalled();
  });

  it('creates one worklist item and marks every row needs-review for a block with a bad header, without enqueueing', async () => {
    const badCsv = validReport().replace('Transaction ID,', 'Txn Id Renamed,');
    const deps = fakeDeps({ fetchCsv: vi.fn().mockResolvedValue(badCsv) });
    const app = createApp(deps);
    await post(app, { event: { pulseId: 1, columnId: 'file_col', value: { files: [{ assetId: 'a1' }] } } });
    expect(deps.mondayClient.createItem).toHaveBeenCalledTimes(1);
    expect(deps.queue.send).not.toHaveBeenCalled();
  });

  it('creates one worklist item and marks rows needs-review for a block whose totals do not match, without enqueueing', async () => {
    const mismatched = validReport().replace('Total Donations (Gross),50.00', 'Total Donations (Gross),999.00');
    const deps = fakeDeps({ fetchCsv: vi.fn().mockResolvedValue(mismatched) });
    const app = createApp(deps);
    await post(app, { event: { pulseId: 1, columnId: 'file_col', value: { files: [{ assetId: 'a1' }] } } });
    expect(deps.mondayClient.createItem).toHaveBeenCalledTimes(1);
    expect(deps.rowStore.upsertRow).toHaveBeenCalledWith(expect.objectContaining({ status: 'needs-review' }));
    expect(deps.queue.send).not.toHaveBeenCalled();
  });

  it('retries an asset stuck at "parsing" from a failed prior attempt, instead of no-op-ing past it', async () => {
    const deps = fakeDeps({
      uploadStore: {
        ...fakeDeps().uploadStore,
        getUploadByAssetId: vi
          .fn()
          .mockResolvedValue({ id: 1, mondayAssetId: 'a1', uploadedAt: 'x', status: 'parsing', blockCount: 0 }),
      },
    });
    const app = createApp(deps);
    const res = await post(app, { event: { pulseId: 1, columnId: 'file_col', value: { files: [{ assetId: 'a1' }] } } });
    expect(res.status).toBe(200);
    // Must still fetch and process — a 'parsing' upload is not "done," unlike 'parsed'.
    expect(deps.mondayClient.fetchAsset).toHaveBeenCalled();
    expect(deps.uploadStore.createUpload).not.toHaveBeenCalled(); // reuses existing.id, never double-creates
    expect(deps.uploadStore.markParsed).toHaveBeenCalledWith(1, 1);
  });

  it('resumes a stuck retry from the first never-completed block, without reprocessing a block that already succeeded', async () => {
    // Two-block file; block 1 already has a disbursement row from a prior attempt (it
    // succeeded before block 2 failed and the upload got stuck at 'parsing').
    const bundled =
      validReport({ disbursementId: 'FIRST01', transactionId: 'TXN001' }) +
      validReport({ disbursementId: 'SECOND02', transactionId: 'TXN002' });
    const deps = fakeDeps({
      fetchCsv: vi.fn().mockResolvedValue(bundled),
      uploadStore: {
        ...fakeDeps().uploadStore,
        getUploadByAssetId: vi
          .fn()
          .mockResolvedValue({ id: 1, mondayAssetId: 'a1', uploadedAt: 'x', status: 'parsing', blockCount: 0 }),
      },
      disbursementStore: {
        ...fakeDeps().disbursementStore,
        listByUpload: vi.fn().mockResolvedValue([{ id: 10, disbursementId: 'FIRST01' } as never]), // 1 block already done
        createDisbursement: vi.fn().mockImplementation((input) => Promise.resolve({ id: 11, ...input })),
      },
    });
    const app = createApp(deps);
    await post(app, { event: { pulseId: 1, columnId: 'file_col', value: { files: [{ assetId: 'a1' }] } } });
    // Only the second (never-completed) block creates a new disbursement row.
    expect(deps.disbursementStore.createDisbursement).toHaveBeenCalledTimes(1);
    expect(deps.disbursementStore.createDisbursement).toHaveBeenCalledWith(
      expect.objectContaining({ disbursementId: 'SECOND02' })
    );
    expect(deps.uploadStore.markParsed).toHaveBeenCalledWith(1, 2);
  });

  it('resuming a needs-review block that already has a disbursement row does not re-post its worklist item, but still (re-)upserts its rows', async () => {
    // Simulates a block that failed AFTER its worklist item posted but BEFORE its row upsert
    // finished — the narrower gap a coarser count-only resume check would miss.
    const badCsv = validReport().replace('Transaction ID,', 'Txn Id Renamed,'); // -> headerError, needsReview
    const deps = fakeDeps({
      fetchCsv: vi.fn().mockResolvedValue(badCsv),
      uploadStore: {
        ...fakeDeps().uploadStore,
        getUploadByAssetId: vi
          .fn()
          .mockResolvedValue({ id: 1, mondayAssetId: 'a1', uploadedAt: 'x', status: 'parsing', blockCount: 0 }),
      },
      disbursementStore: {
        ...fakeDeps().disbursementStore,
        listByUpload: vi.fn().mockResolvedValue([
          { id: 10, uploadId: 1, disbursementId: '', periodEnding: '', currency: '', rowCount: 0,
            reportedGrossTotal: 0, reportedNetTotal: 0, needsReview: true, reviewReason: 'x' } as never,
        ]),
      },
    });
    const app = createApp(deps);
    await post(app, { event: { pulseId: 1, columnId: 'file_col', value: { files: [{ assetId: 'a1' }] } } });
    // Reused the existing row — never created a second one, never re-posted the worklist item.
    expect(deps.disbursementStore.createDisbursement).not.toHaveBeenCalled();
    expect(deps.mondayClient.createItem).not.toHaveBeenCalled();
    // A header-error block has zero rows to upsert, so this only proves the code path taken
    // (existingDisbursement !== null -> skip worklist post) without needing row-level fixtures;
    // the sum-mismatch case below covers the "rows still get upserted" half.
  });

  it('resuming a needs-review block from a sum mismatch still (re-)upserts its rows even though its disbursement row already exists', async () => {
    const mismatched = validReport().replace('Total Donations (Gross),50.00', 'Total Donations (Gross),999.00');
    const deps = fakeDeps({
      fetchCsv: vi.fn().mockResolvedValue(mismatched),
      uploadStore: {
        ...fakeDeps().uploadStore,
        getUploadByAssetId: vi
          .fn()
          .mockResolvedValue({ id: 1, mondayAssetId: 'a1', uploadedAt: 'x', status: 'parsing', blockCount: 0 }),
      },
      disbursementStore: {
        ...fakeDeps().disbursementStore,
        listByUpload: vi.fn().mockResolvedValue([
          { id: 10, uploadId: 1, disbursementId: 'ABC123', periodEnding: '2026-12-16', currency: 'USD',
            rowCount: 1, reportedGrossTotal: 999, reportedNetTotal: 999, needsReview: true, reviewReason: 'x' } as never,
        ]),
      },
    });
    const app = createApp(deps);
    await post(app, { event: { pulseId: 1, columnId: 'file_col', value: { files: [{ assetId: 'a1' }] } } });
    expect(deps.disbursementStore.createDisbursement).not.toHaveBeenCalled();
    expect(deps.mondayClient.createItem).not.toHaveBeenCalled(); // no re-posted worklist item
    // The row IS still upserted against the reused disbursement id — proves a row upsert a
    // partial prior attempt never reached still gets recorded on this retry.
    expect(deps.rowStore.upsertRow).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: 'TXN001', disbursementId: 10, status: 'needs-review' })
    );
  });

  it('marks the upload errored and returns 500 when a block throws mid-processing, so Monday redelivers', async () => {
    const deps = fakeDeps({
      disbursementStore: {
        ...fakeDeps().disbursementStore,
        createDisbursement: vi.fn().mockRejectedValue(new Error('D1 write failed')),
      },
    });
    const app = createApp(deps);
    const res = await post(app, { event: { pulseId: 1, columnId: 'file_col', value: { files: [{ assetId: 'a1' }] } } });
    expect(res.status).toBe(500);
    expect(deps.uploadStore.markError).toHaveBeenCalledWith(1);
    expect(deps.uploadStore.markParsed).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/webhook/route.test.ts`
Expected: FAIL — `./route` module doesn't exist yet.

- [ ] **Step 3: Write `src/webhook/route.ts`**

```typescript
import { Hono } from 'hono';
import type { MondayClient } from '../monday/client';
import type { UploadStore } from '../db/uploads';
import type { DisbursementStore, DisbursementRow } from '../db/disbursements';
import type { RowStore } from '../db/rows';
import type { BenevityImportConfig } from '../types';
import { parseBenevityReport, type ParsedBlock } from '../parse/report';
import { isChallenge, validateUploadEvent } from './validate';
import { createWorklistItem } from '../matching/worklist';
import { errorMessage } from '../util/errorMessage';
import type { BenevityQueueMessage } from '../consumer/processBatch';

export interface QueueLike {
  send(message: BenevityQueueMessage): Promise<void>;
}

export interface AppDeps {
  mondayClient: MondayClient;
  uploadStore: UploadStore;
  disbursementStore: DisbursementStore;
  rowStore: RowStore;
  config: BenevityImportConfig;
  queue: QueueLike;
  // Shared secret required as `?secret=...` on the registered Monday webhook URL
  // (`wrangler secret put BENEVITY_WEBHOOK_SECRET`). Fails closed when unset.
  webhookSecret: string | undefined;
  // Plain GET of the asset's time-limited public_url — separate from mondayClient's GraphQL
  // calls so tests can stub it without a fetch mock.
  fetchCsv: (url: string) => Promise<string>;
  now: () => string;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true }));

  app.post('/webhooks/monday/benevity-upload', async (c) => {
    if (deps.webhookSecret === undefined || c.req.query('secret') !== deps.webhookSecret) {
      return c.json({ ok: false }, 401);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: 'invalid JSON body' }, 200);
    }

    if (isChallenge(body)) {
      return c.json(body, 200);
    }

    let event;
    try {
      event = validateUploadEvent(body);
    } catch (err) {
      console.error(`benevity webhook: rejected delivery: ${errorMessage(err)}`);
      return c.json({ ok: false, error: errorMessage(err) }, 200);
    }

    if (event.columnId !== deps.config.benevityImport.uploadsBoard.fileColumn) {
      // The webhook subscription should already be scoped to this one column at setup time —
      // this is a defensive double-check, not the primary filter (see the note on
      // ValidatedUploadEvent.columnId in webhook/validate.ts).
      return c.json({ ok: true, ignored: true }, 200);
    }

    for (const assetId of event.assetIds) {
      try {
        await ingestAsset(assetId, deps);
      } catch (err) {
        console.error(`benevity webhook: failed to ingest asset "${assetId}": ${errorMessage(err)}`);
        return c.json({ ok: false }, 500);
      }
    }

    return c.json({ ok: true }, 200);
  });

  return app;
}

async function ingestAsset(assetId: string, deps: AppDeps): Promise<void> {
  const existing = await deps.uploadStore.getUploadByAssetId(assetId);
  if (existing !== null && existing.status === 'parsed') {
    // Redelivery of an already-FULLY-ingested asset — a fast no-op. Per-row dedup on
    // Transaction ID in D1 `rows` is the real safety net even if this check is ever bypassed.
    // Deliberately NOT short-circuiting on mere existence: an upload stuck at 'parsing' (a
    // prior attempt died partway through the block loop below) or 'error' (a prior parse
    // failure) must still be retried on redelivery, or a transient failure on block 2 of a
    // 3-block file would silently and permanently drop blocks 2-3 forever, while still
    // answering Monday's redelivery with 200. Reusing `existing.id` here (never calling
    // createUpload twice) avoids violating uploads.monday_asset_id's UNIQUE constraint.
    return;
  }

  const asset = await deps.mondayClient.fetchAsset(assetId);
  const csvText = await deps.fetchCsv(asset.publicUrl);
  const upload = existing ?? (await deps.uploadStore.createUpload(assetId, deps.now()));

  let blocks: ParsedBlock[];
  try {
    blocks = parseBenevityReport(csvText);
  } catch (err) {
    await deps.uploadStore.markError(upload.id);
    console.error(`benevity webhook: asset "${assetId}" failed to parse: ${errorMessage(err)}`);
    return;
  }

  // Resume, don't restart — but resume at the RIGHT granularity. A retry re-fetches and
  // re-parses the SAME asset (a pure function of its bytes), so block order and content are
  // stable across attempts: `existingDisbursements[i]` (if present) IS block `i`'s own row from
  // a prior attempt, by construction (blocks are always created via a single sequential,
  // awaited loop). Passed into `ingestBlock`, it lets that block skip re-creating its
  // `disbursements` row and re-posting its worklist item (neither is safe to repeat — no
  // dedup), while ALWAYS re-running its row-upsert loop regardless (row upserts ARE safe to
  // repeat — `rows.upsertRow`'s `ON CONFLICT (transaction_id) DO NOTHING` makes an already-
  // written row a no-op). That combination is what closes the gap a coarser
  // "already-has-a-disbursement-row = fully done" check left open: a block that fails
  // *mid*-processing (after its disbursement row commits, before every row is upserted or, for
  // a needs-review block, before its worklist item posts) resumes exactly where it left off on
  // retry instead of being silently skipped as "done" or fully re-run as "not started."
  const existingDisbursements = await deps.disbursementStore.listByUpload(upload.id);

  try {
    for (let i = 0; i < blocks.length; i++) {
      await ingestBlock(blocks[i], upload.id, deps, existingDisbursements[i] ?? null);
    }
  } catch (err) {
    // Mark it visibly failed (not stuck silently at 'parsing') and rethrow so the webhook
    // handler's outer catch returns 500 — Monday redelivers, and this same asset id resumes
    // processing above instead of no-op'ing past it.
    await deps.uploadStore.markError(upload.id);
    throw err;
  }

  await deps.uploadStore.markParsed(upload.id, blocks.length);
}

async function ingestBlock(
  block: ParsedBlock,
  uploadId: number,
  deps: AppDeps,
  existingDisbursement: DisbursementRow | null
): Promise<void> {
  const needsReview = block.headerError !== null || block.sumMismatch;
  const reviewReason =
    block.headerError ?? (block.sumMismatch ? 'row totals do not match the reported gross total' : null);

  const disbursement =
    existingDisbursement ??
    (await deps.disbursementStore.createDisbursement({
      uploadId,
      disbursementId: block.disbursementId,
      periodEnding: block.periodEnding,
      currency: block.currency,
      rowCount: block.rows.length,
      reportedGrossTotal: block.reportedGrossTotal,
      reportedNetTotal: block.reportedNetTotal,
      needsReview,
      reviewReason,
    }));

  if (needsReview) {
    if (existingDisbursement === null) {
      // Only post the worklist item the first time this block is attempted — createItem has no
      // dedup of its own, so re-posting it on every redelivery would spam duplicate items onto
      // the live board.
      await createWorklistItem(deps.mondayClient, deps.config, {
        reason: reviewReason ?? 'block needs review',
        name: `Disbursement ${block.disbursementId || '(unknown)'}`,
        email: '',
        company: block.charityName,
        amount: block.reportedGrossTotal,
        date: block.periodEnding || deps.now().slice(0, 10),
      });
    }
    // Every row is (re-)recorded so nothing is silently lost, but none are enqueued — spec: "a
    // mismatch marks the whole block needs-review rather than writing partial data from a
    // block the parser may have mis-split." Idempotent even on a retry of this exact block.
    for (const row of block.rows) {
      await deps.rowStore.upsertRow({
        transactionId: row.transactionId,
        disbursementId: disbursement.id,
        rawRow: JSON.stringify(row),
        status: 'needs-review',
        ingestedAt: deps.now(),
      });
    }
    return;
  }

  for (const row of block.rows) {
    if (row.donationDate < deps.config.benevityImport.minDonationDate) {
      await deps.rowStore.upsertRow({
        transactionId: row.transactionId,
        disbursementId: disbursement.id,
        rawRow: JSON.stringify(row),
        status: 'skipped',
        ingestedAt: deps.now(),
      });
      continue;
    }

    const result = await deps.rowStore.upsertRow({
      transactionId: row.transactionId,
      disbursementId: disbursement.id,
      rawRow: JSON.stringify(row),
      status: 'ingested',
      ingestedAt: deps.now(),
    });
    if (result === 'inserted') {
      await deps.queue.send({ transactionId: row.transactionId });
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/webhook/route.test.ts`
Expected: PASS (15 tests)

- [ ] **Step 5: Commit**

```bash
git add src/webhook/route.ts src/webhook/route.test.ts
git commit -m "feat(benevity-import): webhook ingestion route"
```

### Task 17: Queue consumer

**Files:**
- Create: `benevity-import/src/consumer/processBatch.ts`
- Test: `benevity-import/src/consumer/processBatch.test.ts`

**Interfaces:**
- Consumes: `resolveOrganization` (Task 12), `resolvePerson` (Task 13), `splitRowIntoGifts` (Task
  14), `createWorklistItem` (Task 15), `MondayClient` (Task 11), `RowStore`/`DonationRowRecord`
  (Task 9), `DisbursementStore` (Task 8), `AliasStore` (Task 10), `ParsedRow` (Task 5),
  `errorMessage` (Task 3).
- Produces: `BenevityQueueMessage { transactionId: string }`, `QueueMessageLike<T>`,
  `ProcessBatchDeps`, `processBenevityQueueBatch(messages, deps): Promise<void>` — `src/index.ts`
  (Task 18) is the only caller; `route.ts` (Task 16) imports only the `BenevityQueueMessage` type.

**Status semantics (spec: Idempotency — the D1 `rows` status enum is exactly `ingested` /
`written` / `needs-review` / `skipped`, no fifth "failed" state):** a genuine business-resolution
failure (currency, negative amount, unresolved company/person) calls `createWorklistItem`, sets
the row to `needs-review`, and **acks the message** — it's a terminal, human-actionable outcome,
not a retry candidate. An unexpected error (Monday API down, a bug) is left at whatever status the
row already had (reasserted via `updateStatus`, so the `error` column is visible for debugging)
and the message is **retried** — Cloudflare Queues' own retry+DLQ mechanism is the recovery path,
matching `funraise-sync`'s convention of never doing manual backoff.

**Per-gift idempotency (spec: Idempotency, "the consumer looks it up before creating"):** each
`GiftSpec`'s own Transaction ID (`<id>` or `<id>-match`) is looked up on the Donations board
*independently* before writing, so a retry that finds the employee gift already created but the
match gift still missing only creates the match gift — never a duplicate employee gift.

**Deferred, not built here (documented scope cut, matches this plan's other flagged gaps):** the
spec's "staff ... create the Organization and re-run the row" (Resolution) implies some way to
re-trigger a single `needs-review` row after a human fixes the underlying cause. No such re-run
path is built in this plan — today that's a re-upload of the same file (D1's per-row dedup on
Transaction ID makes that safe) or a manual D1 row edit. A dedicated "retry this worklist item"
action is a reasonable follow-up once the Worker is live and this friction is felt for real.

- [ ] **Step 1: Write the failing test `src/consumer/processBatch.test.ts`**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { processBenevityQueueBatch, type QueueMessageLike, type BenevityQueueMessage, type ProcessBatchDeps } from './processBatch';
import type { RowStore, DonationRowRecord } from '../db/rows';
import type { DisbursementStore } from '../db/disbursements';
import type { AliasStore } from '../db/aliases';
import type { BenevityImportConfig } from '../types';
import type { ParsedRow } from '../parse/report';

function fakeConfig(): BenevityImportConfig {
  return {
    monday: { apiUrl: '', boards: { donations: 111, organizations: 222, people: 333, affiliations: 444, benevityUploads: 777 } },
    benevityImport: {
      minDonationDate: '2026-01-01',
      donationsColumns: {
        donor: 'donor_c', matchedBy: 'matched_by_c', amount: 'amount_c', date: 'date_c',
        disbursementDate: 'disb_date_c', fiscalYearEnding: 'fy_c', status: 'status_c',
        giftType: 'gift_type_c', anonymousDonor: 'anon_c', transactionId: 'txn_c',
      },
      organizationsNameColumn: 'name',
      peopleColumns: { personalEmail: 'personal_email_c', householdEmail: 'household_email_c', employer: 'employer_c' },
      affiliationsColumns: { person: 'person_c', organization: 'org_c', workEmail: 'work_email_c' },
      uploadsBoard: {
        fileColumn: 'file_c', worklistGroupId: 'review',
        worklistColumns: { reason: 'reason_c', name: 'name_c', email: 'email_c', company: 'company_c', amount: 'amount_c', date: 'date_c' },
      },
      organizationAliases: {},
      rawRowRetentionDays: 90,
      unresolvedRowRetentionDays: 365,
    },
  };
}

function fakeParsedRow(overrides: Partial<ParsedRow> = {}): ParsedRow {
  return {
    company: 'Acme, Inc.',
    donorFirstName: 'Jordan',
    donorLastName: 'Rivera',
    email: 'jordan@acme.example',
    donationDate: '2026-03-01',
    transactionId: 'TXN001',
    donationFrequency: 'One Time',
    currency: 'USD',
    totalDonationToBeAcknowledged: 50,
    matchAmount: 100,
    notes: '',
    ...overrides,
  };
}

function fakeRowRecord(parsed: ParsedRow, overrides: Partial<DonationRowRecord> = {}): DonationRowRecord {
  return {
    transactionId: parsed.transactionId,
    disbursementId: 1,
    status: 'ingested',
    mondayEmployeeItemId: null,
    mondayMatchItemId: null,
    rawRow: JSON.stringify(parsed),
    error: null,
    ingestedAt: '2026-09-15T00:00:00Z',
    writtenAt: null,
    ...overrides,
  };
}

function message(transactionId: string): QueueMessageLike<BenevityQueueMessage> {
  return { body: { transactionId }, ack: vi.fn(), retry: vi.fn() };
}

function fakeDeps(overrides: Partial<ProcessBatchDeps> = {}): ProcessBatchDeps {
  const rowStore: RowStore = {
    upsertRow: vi.fn(),
    getRow: vi.fn(),
    updateStatus: vi.fn(),
    purgeWrittenRawRows: vi.fn(),
    purgeUnresolvedRawRows: vi.fn(),
  };
  const disbursementStore: DisbursementStore = {
    createDisbursement: vi.fn(),
    getDisbursement: vi.fn().mockResolvedValue({
      id: 1, uploadId: 1, disbursementId: 'ABC123', periodEnding: '2026-03-16', currency: 'USD',
      rowCount: 1, reportedGrossTotal: 150, reportedNetTotal: 150, needsReview: false, reviewReason: null,
    }),
  };
  const aliasStore: AliasStore = { getAlias: vi.fn().mockResolvedValue(null), learnAlias: vi.fn() };
  const mondayClient = {
    findItemsByColumnValue: vi.fn().mockResolvedValue([]),
    findItemsByName: vi.fn().mockResolvedValue([{ id: '99', name: 'Acme, Inc.' }]),
    getLinkedItemIds: vi.fn().mockResolvedValue([]),
    createItem: vi.fn().mockResolvedValue({ id: '501', name: 'x' }),
    changeColumnValues: vi.fn(),
    fetchAsset: vi.fn(),
  };
  return {
    rowStore,
    disbursementStore,
    aliasStore,
    mondayClient: mondayClient as never,
    config: fakeConfig(),
    now: () => '2026-09-15T00:00:00Z',
    ...overrides,
  };
}

describe('processBenevityQueueBatch', () => {
  it('resolves company and (absent) person, writes both gifts, and marks the row written', async () => {
    const parsed = fakeParsedRow();
    const deps = fakeDeps();
    (deps.rowStore.getRow as ReturnType<typeof vi.fn>).mockResolvedValue(fakeRowRecord(parsed));

    const msg = message('TXN001');
    await processBenevityQueueBatch([msg], deps);

    expect(deps.mondayClient.createItem).toHaveBeenCalledTimes(2); // employee gift + match gift
    expect(deps.rowStore.updateStatus).toHaveBeenCalledWith(
      'TXN001',
      'written',
      expect.objectContaining({ mondayEmployeeItemId: '501', mondayMatchItemId: '501', writtenAt: '2026-09-15T00:00:00Z' })
    );
    expect(msg.ack).toHaveBeenCalled();
  });

  it('updates an existing Donations item instead of creating a duplicate, when one is already stamped with the Transaction ID', async () => {
    const parsed = fakeParsedRow({ matchAmount: 0 }); // single gift, simpler assertion
    const deps = fakeDeps({
      mondayClient: {
        findItemsByColumnValue: vi.fn().mockResolvedValue([{ id: '900', name: 'existing' }]),
        findItemsByName: vi.fn().mockResolvedValue([{ id: '99', name: 'Acme, Inc.' }]),
        getLinkedItemIds: vi.fn().mockResolvedValue([]),
        createItem: vi.fn(),
        changeColumnValues: vi.fn(),
        fetchAsset: vi.fn(),
      } as never,
    });
    (deps.rowStore.getRow as ReturnType<typeof vi.fn>).mockResolvedValue(fakeRowRecord(parsed));

    await processBenevityQueueBatch([message('TXN001')], deps);

    expect(deps.mondayClient.createItem).not.toHaveBeenCalled();
    expect(deps.mondayClient.changeColumnValues).toHaveBeenCalledWith(111, '900', expect.any(Object));
  });

  it('is a no-op for a row already written', async () => {
    const parsed = fakeParsedRow();
    const deps = fakeDeps();
    (deps.rowStore.getRow as ReturnType<typeof vi.fn>).mockResolvedValue(fakeRowRecord(parsed, { status: 'written' }));

    const msg = message('TXN001');
    await processBenevityQueueBatch([msg], deps);

    expect(deps.mondayClient.createItem).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalled();
  });

  it('worklists and marks needs-review for a non-USD row, acking the message', async () => {
    const parsed = fakeParsedRow({ currency: 'EUR' });
    const deps = fakeDeps();
    (deps.rowStore.getRow as ReturnType<typeof vi.fn>).mockResolvedValue(fakeRowRecord(parsed));

    const msg = message('TXN001');
    await processBenevityQueueBatch([msg], deps);

    expect(deps.mondayClient.createItem).toHaveBeenCalledWith(777, expect.any(String), expect.any(Object), 'review');
    expect(deps.rowStore.updateStatus).toHaveBeenCalledWith('TXN001', 'needs-review', expect.objectContaining({ error: expect.stringMatching(/EUR/) }));
    expect(msg.ack).toHaveBeenCalled();
  });

  it('worklists and marks needs-review for a negative amount', async () => {
    const parsed = fakeParsedRow({ matchAmount: -10 });
    const deps = fakeDeps();
    (deps.rowStore.getRow as ReturnType<typeof vi.fn>).mockResolvedValue(fakeRowRecord(parsed));

    await processBenevityQueueBatch([message('TXN001')], deps);

    expect(deps.rowStore.updateStatus).toHaveBeenCalledWith('TXN001', 'needs-review', expect.objectContaining({ error: expect.stringMatching(/negative/) }));
  });

  it('worklists and marks needs-review when the company does not resolve, without attempting person resolution', async () => {
    const parsed = fakeParsedRow();
    const deps = fakeDeps({
      mondayClient: {
        findItemsByColumnValue: vi.fn().mockResolvedValue([]),
        findItemsByName: vi.fn().mockResolvedValue([]), // no Organization match
        getLinkedItemIds: vi.fn().mockResolvedValue([]),
        createItem: vi.fn().mockResolvedValue({ id: '1', name: 'x' }),
        changeColumnValues: vi.fn(),
        fetchAsset: vi.fn(),
      } as never,
    });
    (deps.rowStore.getRow as ReturnType<typeof vi.fn>).mockResolvedValue(fakeRowRecord(parsed));

    await processBenevityQueueBatch([message('TXN001')], deps);

    const findItemsByColumnValue = deps.mondayClient.findItemsByColumnValue as ReturnType<typeof vi.fn>;
    expect(findItemsByColumnValue).not.toHaveBeenCalledWith(333, expect.anything(), expect.anything()); // people board never queried
    expect(deps.rowStore.updateStatus).toHaveBeenCalledWith('TXN001', 'needs-review', expect.any(Object));
  });

  it('leaves the row status alone and retries on an unexpected error', async () => {
    const parsed = fakeParsedRow();
    const deps = fakeDeps({
      mondayClient: {
        findItemsByColumnValue: vi.fn().mockRejectedValue(new Error('monday API: HTTP 500')),
        findItemsByName: vi.fn().mockResolvedValue([{ id: '99', name: 'Acme, Inc.' }]),
        getLinkedItemIds: vi.fn().mockResolvedValue([]),
        createItem: vi.fn(),
        changeColumnValues: vi.fn(),
        fetchAsset: vi.fn(),
      } as never,
    });
    (deps.rowStore.getRow as ReturnType<typeof vi.fn>).mockResolvedValue(fakeRowRecord(parsed));

    const msg = message('TXN001');
    await processBenevityQueueBatch([msg], deps);

    expect(deps.rowStore.updateStatus).toHaveBeenCalledWith('TXN001', 'ingested', expect.objectContaining({ error: expect.stringMatching(/HTTP 500/) }));
    expect(msg.retry).toHaveBeenCalled();
    expect(msg.ack).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/consumer/processBatch.test.ts`
Expected: FAIL — `./processBatch` module doesn't exist yet.

- [ ] **Step 3: Write `src/consumer/processBatch.ts`**

```typescript
import type { MondayClient } from '../monday/client';
import type { RowStore, DonationRowRecord } from '../db/rows';
import type { DisbursementStore } from '../db/disbursements';
import type { AliasStore } from '../db/aliases';
import type { BenevityImportConfig } from '../types';
import type { ParsedRow } from '../parse/report';
import { resolveOrganization } from '../matching/organizations';
import { resolvePerson } from '../matching/people';
import { splitRowIntoGifts } from '../mapping/giftSplit';
import { createWorklistItem } from '../matching/worklist';
import { errorMessage } from '../util/errorMessage';

export interface BenevityQueueMessage {
  transactionId: string;
}

export interface QueueMessageLike<T> {
  body: T;
  ack(): void;
  retry(): void;
}

export interface ProcessBatchDeps {
  rowStore: RowStore;
  disbursementStore: DisbursementStore;
  aliasStore: AliasStore;
  mondayClient: MondayClient;
  config: BenevityImportConfig;
  now: () => string;
}

export async function processBenevityQueueBatch(
  messages: QueueMessageLike<BenevityQueueMessage>[],
  deps: ProcessBatchDeps
): Promise<void> {
  for (const message of messages) {
    const { transactionId } = message.body;
    try {
      await processOne(transactionId, deps);
      message.ack();
    } catch (err) {
      const errMsg = errorMessage(err);
      console.error(`benevity consumer: failed to process "${transactionId}": ${errMsg}`);
      // Left at 'ingested' (its only possible pre-write status here) so the queue's own
      // retry+DLQ handles it — this is an unexpected/transient failure, not a business
      // decision, so it must not read as 'needs-review' on the board.
      await deps.rowStore.updateStatus(transactionId, 'ingested', { error: errMsg });
      message.retry();
    }
  }
}

async function processOne(transactionId: string, deps: ProcessBatchDeps): Promise<void> {
  const row = await deps.rowStore.getRow(transactionId);
  if (row === null) {
    throw new Error(`benevity consumer: no row for transaction id "${transactionId}"`);
  }
  if (row.status === 'written') return; // redelivered message for already-completed work

  const parsed = JSON.parse(row.rawRow) as ParsedRow;

  if (parsed.currency !== 'USD') {
    await worklistAndMarkReview(deps, row, parsed, `currency "${parsed.currency}" is not USD`);
    return;
  }
  if (parsed.totalDonationToBeAcknowledged < 0 || parsed.matchAmount < 0) {
    await worklistAndMarkReview(deps, row, parsed, 'row has a negative amount');
    return;
  }

  const orgResult = await resolveOrganization(deps.mondayClient, deps.aliasStore, deps.config, parsed.company);
  if (orgResult.status === 'unresolved') {
    await worklistAndMarkReview(deps, row, parsed, orgResult.reason);
    return;
  }

  const personResult = await resolvePerson(
    deps.mondayClient,
    deps.config,
    {
      company: parsed.company,
      donorFirstName: parsed.donorFirstName,
      donorLastName: parsed.donorLastName,
      email: parsed.email,
    },
    orgResult.organizationItemId
  );
  if (personResult.status === 'unresolved') {
    await worklistAndMarkReview(deps, row, parsed, personResult.reason);
    return;
  }
  const personItemId = personResult.status === 'resolved' ? personResult.personItemId : null;

  const disbursement = await deps.disbursementStore.getDisbursement(row.disbursementId);
  if (disbursement === null) {
    throw new Error(`benevity consumer: no disbursement ${row.disbursementId} for transaction "${transactionId}"`);
  }

  const gifts = splitRowIntoGifts(
    {
      row: parsed,
      disbursementPeriodEnding: disbursement.periodEnding,
      organizationItemId: orgResult.organizationItemId,
      personItemId,
    },
    deps.config
  );

  const donationsBoardId = deps.config.monday.boards.donations;
  if (donationsBoardId === null) {
    throw new Error('config: monday.boards.donations is not configured');
  }
  const txnIdColumn = deps.config.benevityImport.donationsColumns.transactionId;

  let employeeItemId: string | undefined;
  let matchItemId: string | undefined;

  for (const gift of gifts) {
    const existing = await deps.mondayClient.findItemsByColumnValue(donationsBoardId, txnIdColumn, gift.transactionId);
    let itemId: string;
    if (existing.length > 0) {
      itemId = existing[0].id;
      await deps.mondayClient.changeColumnValues(donationsBoardId, itemId, gift.columnValues);
    } else {
      const created = await deps.mondayClient.createItem(donationsBoardId, gift.itemName, gift.columnValues);
      itemId = created.id;
    }
    if (gift.transactionId === transactionId) {
      employeeItemId = itemId;
    } else {
      matchItemId = itemId;
    }
  }

  await deps.rowStore.updateStatus(transactionId, 'written', {
    ...(employeeItemId ? { mondayEmployeeItemId: employeeItemId } : {}),
    ...(matchItemId ? { mondayMatchItemId: matchItemId } : {}),
    writtenAt: deps.now(),
  });
}

async function worklistAndMarkReview(
  deps: ProcessBatchDeps,
  row: DonationRowRecord,
  parsed: ParsedRow,
  reason: string
): Promise<void> {
  await createWorklistItem(deps.mondayClient, deps.config, {
    reason,
    name: `${parsed.donorFirstName} ${parsed.donorLastName}`.trim(),
    email: parsed.email,
    company: parsed.company,
    amount: parsed.totalDonationToBeAcknowledged + parsed.matchAmount,
    date: parsed.donationDate,
  });
  await deps.rowStore.updateStatus(row.transactionId, 'needs-review', { error: reason });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/consumer/processBatch.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/consumer/processBatch.ts src/consumer/processBatch.test.ts
git commit -m "feat(benevity-import): queue consumer — resolve, split, and write gifts"
```

### Task 18: Worker entry point, full config, and the integration test

**Files:**
- Modify: `benevity-import/config/svbc.json` (expand from Task 1's placeholder to the full shape)
- Modify: `benevity-import/src/index.ts`
- Test: `benevity-import/src/index.test.ts`
- Test: `benevity-import/src/integration.test.ts`

**Interfaces:**
- Consumes every module from Tasks 2–17. This is the last task — it wires the real `fetch` /
  `queue` / `scheduled` handlers and proves the whole pipeline end-to-end.

- [ ] **Step 1: Replace `config/svbc.json` with the full shape** (real board/column ids stay
  `null`/empty until provisioned in Monday — see the spec's Monday targets table for what each one
  is)

```json
{
  "monday": {
    "apiUrl": "https://api.monday.com/v2",
    "boards": {
      "donations": null,
      "organizations": null,
      "people": null,
      "affiliations": null,
      "benevityUploads": null
    }
  },
  "benevityImport": {
    "minDonationDate": "2026-09-15",
    "donationsColumns": {
      "donor": "REPLACE_donor_connect_column_id",
      "matchedBy": "REPLACE_matched_by_connect_column_id",
      "amount": "REPLACE_amount_column_id",
      "date": "REPLACE_date_column_id",
      "disbursementDate": "REPLACE_benevity_disbursement_date_column_id",
      "fiscalYearEnding": "REPLACE_fiscal_year_ending_column_id",
      "status": "REPLACE_status_column_id",
      "giftType": "REPLACE_gift_type_column_id",
      "anonymousDonor": "REPLACE_anonymous_donor_column_id",
      "transactionId": "REPLACE_benevity_transaction_id_column_id"
    },
    "organizationsNameColumn": "name",
    "peopleColumns": {
      "personalEmail": "REPLACE_personal_email_column_id",
      "householdEmail": "REPLACE_household_email_column_id",
      "employer": "REPLACE_employer_column_id"
    },
    "affiliationsColumns": {
      "person": "REPLACE_person_connect_column_id",
      "organization": "REPLACE_organization_connect_column_id",
      "workEmail": "REPLACE_work_email_column_id"
    },
    "uploadsBoard": {
      "fileColumn": "REPLACE_file_column_id",
      "worklistGroupId": "REPLACE_review_group_id",
      "worklistColumns": {
        "reason": "REPLACE_reason_column_id",
        "name": "REPLACE_name_column_id",
        "email": "REPLACE_email_column_id",
        "company": "REPLACE_company_column_id",
        "amount": "REPLACE_amount_column_id",
        "date": "REPLACE_date_column_id"
      }
    },
    "organizationAliases": {},
    "rawRowRetentionDays": 90,
    "unresolvedRowRetentionDays": 365
  }
}
```

`minDonationDate` above is a placeholder (today's date, at drafting time) — before the real first
upload, set it to the actual migration data-freeze date per the spec's Idempotency section, so the
first real disbursement after cutover isn't accidentally skipped.

- [ ] **Step 2: Write `src/index.ts`**

```typescript
import rawConfig from '../config/svbc.json';
import { validateConfig } from './config';
import { createApp } from './webhook/route';
import { D1UploadStore } from './db/uploads';
import { D1DisbursementStore } from './db/disbursements';
import { D1RowStore } from './db/rows';
import { D1AliasStore } from './db/aliases';
import { HttpMondayClient } from './monday/client';
import { processBenevityQueueBatch, type BenevityQueueMessage } from './consumer/processBatch';
import type { Env } from './types';

const config = validateConfig(rawConfig);

async function fetchCsv(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`benevity report fetch: HTTP ${response.status}`);
  }
  return response.text();
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const app = createApp({
      mondayClient: new HttpMondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN),
      uploadStore: new D1UploadStore(env.DB),
      disbursementStore: new D1DisbursementStore(env.DB),
      rowStore: new D1RowStore(env.DB),
      config,
      queue: {
        send: (message: BenevityQueueMessage) => env.WRITE_QUEUE.send(message).then(() => undefined),
      },
      webhookSecret: env.BENEVITY_WEBHOOK_SECRET,
      fetchCsv,
      now: () => new Date().toISOString(),
    });
    return app.fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch<BenevityQueueMessage>, env: Env): Promise<void> {
    await processBenevityQueueBatch([...batch.messages], {
      rowStore: new D1RowStore(env.DB),
      disbursementStore: new D1DisbursementStore(env.DB),
      aliasStore: new D1AliasStore(env.DB),
      mondayClient: new HttpMondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN),
      config,
      now: () => new Date().toISOString(),
    });
  },

  // Daily PII retention pass: raw Benevity rows are kept only for replay/debugging, so they're
  // emptied once the write has been in Monday long enough (or, for rows that never resolved,
  // after the longer unresolved-row window). Same shape as funraise-sync's scheduled handler.
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const dayMs = 24 * 60 * 60 * 1000;
    const store = new D1RowStore(env.DB);
    const writtenCutoff = new Date(Date.now() - config.benevityImport.rawRowRetentionDays * dayMs).toISOString();
    const unresolvedCutoff = new Date(
      Date.now() - config.benevityImport.unresolvedRowRetentionDays * dayMs
    ).toISOString();
    const purgedWritten = await store.purgeWrittenRawRows(writtenCutoff);
    const purgedUnresolved = await store.purgeUnresolvedRawRows(unresolvedCutoff);
    if (purgedWritten > 0 || purgedUnresolved > 0) {
      console.log(
        `benevity-import scheduled: purged raw_row from ${purgedWritten} written (older than ${writtenCutoff}) and ${purgedUnresolved} unresolved (older than ${unresolvedCutoff}) rows`
      );
    }
  },
};
```

- [ ] **Step 3: Write `src/index.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import worker from './index';

describe('worker entry point', () => {
  it('exports fetch, queue, and scheduled handlers', () => {
    expect(typeof worker.fetch).toBe('function');
    expect(typeof worker.queue).toBe('function');
    expect(typeof worker.scheduled).toBe('function');
  });

  it('loads and validates config/svbc.json at import time without throwing', async () => {
    // If validateConfig(rawConfig) threw, importing this module (done at the top of this file)
    // would already have failed the whole test file — this just documents the intent.
    expect(worker).toBeDefined();
  });
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/index.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Write `src/integration.test.ts`** — the full webhook → D1 → queue → consumer path,
  against real D1 (via `cloudflare:test`) and a stubbed Monday client, proving the pieces wired in
  Steps 1-2 actually fit together.

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { createApp, type AppDeps } from './webhook/route';
import { processBenevityQueueBatch, type BenevityQueueMessage } from './consumer/processBatch';
import { D1UploadStore } from './db/uploads';
import { D1DisbursementStore } from './db/disbursements';
import { D1RowStore } from './db/rows';
import { D1AliasStore } from './db/aliases';
import type { MondayClient } from './monday/client';
import type { BenevityImportConfig } from './types';
import { applyMigrations } from '../test/apply-migrations';

const SECRET = 'test-secret';

function fakeConfig(): BenevityImportConfig {
  return {
    monday: { apiUrl: '', boards: { donations: 111, organizations: 222, people: 333, affiliations: 444, benevityUploads: 777 } },
    benevityImport: {
      minDonationDate: '2026-01-01',
      donationsColumns: {
        donor: 'donor_c', matchedBy: 'matched_by_c', amount: 'amount_c', date: 'date_c',
        disbursementDate: 'disb_date_c', fiscalYearEnding: 'fy_c', status: 'status_c',
        giftType: 'gift_type_c', anonymousDonor: 'anon_c', transactionId: 'txn_c',
      },
      organizationsNameColumn: 'name',
      peopleColumns: { personalEmail: 'personal_email_c', householdEmail: 'household_email_c', employer: 'employer_c' },
      affiliationsColumns: { person: 'person_c', organization: 'org_c', workEmail: 'work_email_c' },
      uploadsBoard: {
        fileColumn: 'file_c', worklistGroupId: 'review',
        worklistColumns: { reason: 'reason_c', name: 'name_c', email: 'email_c', company: 'company_c', amount: 'amount_c', date: 'date_c' },
      },
      organizationAliases: {},
      rawRowRetentionDays: 90,
      unresolvedRowRetentionDays: 365,
    },
  };
}

function validReport(): string {
  return [
    'Donations Report,',
    '"#---",',
    'Charity Name,SVBC',
    'Charity ID,123',
    'Period Ending,Tue 16 Mar 2026 0:00:00',
    'Currency,USD',
    'Payment Method,EFT',
    'Disbursement ID,ABC123',
    'Note,',
    '"#---",',
    '',
    'Company,Project,Donation Date,Donor First Name,Donor Last Name,Email,Address,City,State/Province,Postal Code,Activity,Comment,Transaction ID,Donation Frequency,Currency,Project Remote ID,Source,Reason,Total Donation to be Acknowledged,Match Amount,Cause Support Fee,Merchant Fee,Fee Comment',
    '"Acme, Inc.",Project,2026-03-06T00:00:00Z,Jordan,Rivera,jordan@acme.example,x,x,x,94043,,,TXN001,One Time,USD,,BlueSnap,User Donation,50.00,100.00,0.00,0.00,',
    'Totals,,,,,,,,,,,,,,,,,,150.00,0.00,0.00,0.00',
    'Total Donations (Gross),150.00',
    'Check Fee,0.00',
    'Net Total Payment,150.00',
    '',
  ].join('\n');
}

describe('benevity-import integration', () => {
  let mondayClient: MondayClient;
  let sentMessages: BenevityQueueMessage[];

  beforeEach(async () => {
    await applyMigrations(env.DB);
    sentMessages = [];
    mondayClient = {
      findItemsByColumnValue: vi.fn().mockResolvedValue([]),
      findItemsByName: vi.fn().mockImplementation((_boardId: number, name: string) =>
        Promise.resolve(name === 'Acme, Inc.' ? [{ id: '99', name: 'Acme, Inc.' }] : [])
      ),
      getLinkedItemIds: vi.fn().mockResolvedValue([]),
      createItem: vi.fn().mockResolvedValue({ id: '501', name: 'x' }),
      changeColumnValues: vi.fn(),
      fetchAsset: vi.fn().mockResolvedValue({ id: 'a1', name: 'report.csv', publicUrl: 'https://files.monday.com/a1' }),
    };
  });

  it('ingests an upload, enqueues its row, and the consumer resolves and writes it (anonymous — no email/name match rigged), worklisting the person', async () => {
    const config = fakeConfig();
    const routeDeps: AppDeps = {
      mondayClient,
      uploadStore: new D1UploadStore(env.DB),
      disbursementStore: new D1DisbursementStore(env.DB),
      rowStore: new D1RowStore(env.DB),
      config,
      queue: { send: async (m) => { sentMessages.push(m); } },
      webhookSecret: SECRET,
      fetchCsv: async () => validReport(),
      now: () => '2026-09-15T00:00:00Z',
    };
    const app = createApp(routeDeps);

    const res = await app.request(`/webhooks/monday/benevity-upload?secret=${SECRET}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: { pulseId: 1, columnId: 'file_c', value: { files: [{ assetId: 'a1' }] } } }),
    });
    expect(res.status).toBe(200);
    expect(sentMessages).toEqual([{ transactionId: 'TXN001' }]);

    // The row is ingested and queued before resolution runs — company resolves ("Acme, Inc."
    // is rigged above), but no email/name-based Person match is rigged, so the row lands on the
    // worklist rather than a hard failure. This proves ingestion and consumption are wired
    // through the same D1 database, not just independently unit-tested.
    await processBenevityQueueBatch(
      sentMessages.map((body) => ({ body, ack: vi.fn(), retry: vi.fn() })),
      {
        rowStore: new D1RowStore(env.DB),
        disbursementStore: new D1DisbursementStore(env.DB),
        aliasStore: new D1AliasStore(env.DB),
        mondayClient,
        config,
        now: () => '2026-09-15T01:00:00Z',
      }
    );

    const row = await new D1RowStore(env.DB).getRow('TXN001');
    expect(row?.status).toBe('needs-review');
    expect(mondayClient.createItem).toHaveBeenCalledWith(777, expect.any(String), expect.any(Object), 'review');
  });

  it('writes both gifts when the person also resolves, and marks the row written', async () => {
    const config = fakeConfig();
    (mondayClient.findItemsByColumnValue as ReturnType<typeof vi.fn>).mockImplementation(
      (boardId: number, columnId: string) =>
        boardId === 333 && columnId === 'personal_email_c'
          ? Promise.resolve([{ id: '5', name: 'Jordan Rivera' }])
          : Promise.resolve([])
    );
    const routeDeps: AppDeps = {
      mondayClient,
      uploadStore: new D1UploadStore(env.DB),
      disbursementStore: new D1DisbursementStore(env.DB),
      rowStore: new D1RowStore(env.DB),
      config,
      queue: { send: async (m) => { sentMessages.push(m); } },
      webhookSecret: SECRET,
      fetchCsv: async () => validReport(),
      now: () => '2026-09-15T00:00:00Z',
    };
    const app = createApp(routeDeps);
    await app.request(`/webhooks/monday/benevity-upload?secret=${SECRET}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: { pulseId: 1, columnId: 'file_c', value: { files: [{ assetId: 'a1' }] } } }),
    });

    await processBenevityQueueBatch(
      sentMessages.map((body) => ({ body, ack: vi.fn(), retry: vi.fn() })),
      {
        rowStore: new D1RowStore(env.DB),
        disbursementStore: new D1DisbursementStore(env.DB),
        aliasStore: new D1AliasStore(env.DB),
        mondayClient,
        config,
        now: () => '2026-09-15T01:00:00Z',
      }
    );

    const row = await new D1RowStore(env.DB).getRow('TXN001');
    expect(row?.status).toBe('written');
    expect(row?.mondayEmployeeItemId).toBe('501');
    expect(row?.mondayMatchItemId).toBe('501');
    expect(mondayClient.createItem).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS — every test file from Tasks 2-18.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add config/svbc.json src/index.ts src/index.test.ts src/integration.test.ts
git commit -m "feat(benevity-import): wire the Worker entry point; end-to-end integration test"
```

## Self-Review

**Spec coverage** — every numbered section of `benevity-import/README.md` maps to a task:

| Spec section | Task(s) |
|---|---|
| Data flow (upload → parse → dedupe → queue → resolve → write) | 15, 16, 17, 18 |
| Trigger (file column, webhook, secret) | 15, 16 |
| Input format (preamble/header/trailer, bundled files, "Not shared by donor") | 5 |
| Splitting a row into gifts (incl. Benevity Disbursement Date) | 6, 14 |
| Resolution — Company → Organizations | 10, 12 |
| Resolution — Employee → People | 13 |
| Idempotency and the migrated history (3-table D1 model, minDonationDate, sum-check) | 5, 7, 8, 9, 16 |
| PII (no address written, raw_row retention) | 9, 18 |
| Monday targets (config-driven, validated at startup) | 2, 11 |
| Related changes — new `Benevity Disbursement Date` column | 14, 18 (config) |

Two spec items are intentionally **not** built here, each flagged in-place rather than silently
dropped: writing Comment/Reason/Source/Activity/Project to a Monday Update (Task 5's `notes`
field is parsed and carried but never posted — a follow-up), and a re-run trigger for a single
`needs-review` row after a human fixes its cause (Task 17 — today a re-upload or manual D1 edit is
the workaround). Both are genuine scope cuts under YAGNI, not gaps discovered too late to flag.

**Placeholder scan:** none found (`TBD`/`TODO`/"implement later"/etc. — grepped clean across the
full plan).

**Type consistency, verified by cross-reference:**
- `MondayClient`'s six methods (Task 11) are called with matching names and argument order
  everywhere they're consumed (Tasks 12, 13, 15, 16, 17) — no leftover singular
  `findItemByColumnValue` from the `funraise-sync` pattern this Worker deliberately diverges from.
- `RowStatus`'s four values (`ingested`/`written`/`needs-review`/`skipped`, Task 9) are used
  consistently in Tasks 16 and 17 — no fifth `'failed'` status invented for transient errors (see
  Task 17's status-semantics note).
- `GiftContext`'s fields (Task 14) match the object literal built at its one call site (Task 17)
  exactly.
- **Found and fixed during this review:** `benevityImport.uploadsBoard.fileColumn` was validated
  by `config.ts` (Task 2) but never read at runtime — the webhook route would have processed a
  change on *any* column of the Benevity Uploads board, not just the file column. Fixed by adding
  `columnId` to `ValidatedUploadEvent` (Task 15) and a check in the route (Task 16) that ignores
  (200, no processing) an event for any other column; tests added in both tasks.

## Execution options

Plan complete and saved to
[`docs/superpowers/plans/2026-09-15-benevity-import.md`](docs/superpowers/plans/2026-09-15-benevity-import.md).
Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
