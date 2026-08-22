# membership-reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `membership-reminders` Cloudflare Worker that replaces Salesforce's renewal-reminder
automation — a daily Cron Trigger that emails members 6/4/2 weeks before their membership expires and
stamps the board item so re-runs are idempotent.

**Architecture:** A single Hono + TypeScript Cloudflare Worker with one `scheduled()` handler and no D1.
Pure logic (dates, filtering, templates, retry) lives in small, independently-tested modules; a thin
`MondayClient` wraps the GraphQL API; orchestration in `reminders.ts` wires them together. Email sending
and Monday board/column IDs are behind clean seams so they can be swapped from stubs to real values
without touching orchestration logic.

**Tech Stack:** Hono, TypeScript, Vitest, Wrangler (Cloudflare Workers), `@cloudflare/workers-types`.

**Spec:** [`docs/superpowers/specs/2026-08-22-membership-reminders-design.md`](../specs/2026-08-22-membership-reminders-design.md)
(and the product spec it builds on, [`membership-reminders/README.md`](../../../membership-reminders/README.md))

## Global Constraints

- Stack is Hono + TypeScript on Cloudflare Workers, no D1 — idempotency state lives on the board item
  itself (spec: README "Stack" line).
- Config (board ID, column IDs, stage offsets, renewal URL) lives in `config/svbc.json`, imported
  statically — never hardcode SVBC-specific IDs in `src/` (repo-wide forkability rule, parent README).
- The Monday API token is a secret set via `wrangler secret put MONDAY_API_TOKEN` — never committed,
  never a staff member's personal token (parent README's least-privilege-token rule).
- `config/svbc.json`'s `monday.donorsBoardId` (`null`) and column IDs (`"REPLACE_WITH_COLUMN_ID"`) are
  intentional placeholders — the sandbox Donors board doesn't exist yet (design spec, "Decisions made").
  This is not a plan gap; every task below is fully testable against mocked dependencies without real IDs.
- Email sending is a stub (`src/email.ts` logs instead of calling a provider) until a provider is picked
  (design spec) — swapping in a real provider later must not require changing `reminders.ts`.
- ES modules (`"type": "module"`), vanilla TypeScript, no unnecessary abstraction (user's global
  preferences).
- TDD: every module below is built test-first — write the failing test, watch it fail, implement,
  watch it pass, commit.

---

### Task 1: Scaffold the Worker project

**Files:**
- Create: `membership-reminders/package.json`
- Create: `membership-reminders/tsconfig.json`
- Create: `membership-reminders/wrangler.jsonc`
- Create: `membership-reminders/config/svbc.json`
- Create: `membership-reminders/src/types.ts`
- Create: `membership-reminders/src/index.ts`
- Test: `membership-reminders/src/index.test.ts`
- Modify: `membership-reminders/README.md` (append a "Local development" section)

**Interfaces:**
- Produces: `Config`, `Member`, `StageConfig`, `RunSummary` types from `src/types.ts`, used by every
  later task. Exact shapes:

```typescript
// src/types.ts
export interface StageConfig {
  tag: string;
  offsetDays: number;
}

export interface MondayColumns {
  membershipStatus: string;
  membershipTier: string;
  memberUntil: string;
  remindersSent: string;
  email: string;
}

export interface Config {
  monday: {
    apiUrl: string;
    donorsBoardId: number | null;
    columns: MondayColumns;
  };
  stages: StageConfig[];
  renewalUrl: string;
  timeZone: string;
  lifetimeTierValue: string;
  activeStatusValue: string;
}

export interface Member {
  id: string;
  name: string;
  email: string;
  membershipTier: string;
  memberUntil: string; // YYYY-MM-DD
  remindersSent: string; // raw comma-separated stamp text, e.g. "6w:2026-10-01"
}

export interface RunSummary {
  stages: Record<string, { sent: number; skipped: number; failed: number }>;
}
```

- [ ] **Step 1: Create the package manifest**

```bash
mkdir -p membership-reminders/src membership-reminders/config
cd membership-reminders
npm init -y
npm pkg set type=module
npm pkg set private=true
npm pkg set scripts.dev="wrangler dev"
npm pkg set scripts.deploy="wrangler deploy"
npm pkg set scripts.test="vitest run"
npm pkg set scripts.typecheck="tsc --noEmit"
npm install hono
npm install --save-dev typescript vitest wrangler @cloudflare/workers-types
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["@cloudflare/workers-types"]
  },
  "include": ["src", "config"]
}
```

- [ ] **Step 3: Write `wrangler.jsonc`**

```jsonc
{
  "name": "svbc-membership-reminders",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-01",
  "triggers": {
    // Once daily, 15:00 UTC = 7am Pacific (PDT) / 8am Pacific (PST). The exact fire
    // hour doesn't affect correctness — dates.ts computes "today" in America/Los_Angeles
    // independent of when the cron actually fires.
    "crons": ["0 15 * * *"]
  }
}
```

- [ ] **Step 4: Write the placeholder config**

```json
{
  "monday": {
    "apiUrl": "https://api.monday.com/v2",
    "donorsBoardId": null,
    "columns": {
      "membershipStatus": "REPLACE_WITH_COLUMN_ID",
      "membershipTier": "REPLACE_WITH_COLUMN_ID",
      "memberUntil": "REPLACE_WITH_COLUMN_ID",
      "remindersSent": "REPLACE_WITH_COLUMN_ID",
      "email": "REPLACE_WITH_COLUMN_ID"
    }
  },
  "stages": [
    { "tag": "6w", "offsetDays": 42 },
    { "tag": "4w", "offsetDays": 28 },
    { "tag": "2w", "offsetDays": 14 }
  ],
  "renewalUrl": "https://bikesiliconvalley.org/renew",
  "timeZone": "America/Los_Angeles",
  "lifetimeTierValue": "Lifetime",
  "activeStatusValue": "Active"
}
```

Save this as `membership-reminders/config/svbc.json`.

- [ ] **Step 5: Write `src/types.ts`**

Use the exact interface block from the Interfaces section above.

- [ ] **Step 6: Write the failing test for the health route**

```typescript
// src/index.test.ts
import { describe, it, expect } from 'vitest';
import worker from './index';

describe('GET /health', () => {
  it('returns ok', async () => {
    const res = await worker.fetch(new Request('http://worker/health'), {} as never, {} as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npx vitest run src/index.test.ts`
Expected: FAIL — `src/index.ts` does not exist yet.

- [ ] **Step 8: Write minimal `src/index.ts`**

```typescript
// src/index.ts
import { Hono } from 'hono';

export interface Env {
  MONDAY_API_TOKEN: string;
}

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ ok: true }));

export default {
  fetch: app.fetch,
};
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npx vitest run src/index.test.ts`
Expected: PASS

- [ ] **Step 10: Run the typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 11: Document local development**

Append this section to `membership-reminders/README.md` (the existing product-spec README, do not
remove any existing content):

```markdown
## Local development

- `npm install` — install dependencies
- `npm test` — run the Vitest suite
- `npm run typecheck` — type-check with no emit
- `npm run dev` — run the Worker locally with `wrangler dev`
- `npm run deploy` — deploy with `wrangler deploy`
- `wrangler secret put MONDAY_API_TOKEN` — set the Monday API token (never commit it)

`config/svbc.json`'s `monday.donorsBoardId` and column IDs are placeholders until the sandbox Donors
board exists (see the design spec). Fill them in before the first real `wrangler dev` / `deploy` run
against Monday — until then, `npm test` covers all logic against mocked dependencies.
```

- [ ] **Step 12: Commit**

```bash
git add membership-reminders/
git commit -m "feat(membership-reminders): scaffold Hono worker with health route"
```

---

### Task 2: Date utilities

**Files:**
- Create: `membership-reminders/src/dates.ts`
- Test: `membership-reminders/src/dates.test.ts`

**Interfaces:**
- Consumes: nothing (pure module, only uses built-in `Intl`/`Date`).
- Produces:
  - `todayISOInTimeZone(timeZone: string): string` — returns `YYYY-MM-DD` for "now" in `timeZone`.
  - `addDaysISO(dateISO: string, days: number): string` — returns `YYYY-MM-DD`.
  - `targetDateForStage(offsetDays: number, timeZone: string): string` — returns `YYYY-MM-DD`, used by
    `reminders.ts` (Task 9) to compute each stage's query date.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/dates.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { todayISOInTimeZone, addDaysISO, targetDateForStage } from './dates';

describe('todayISOInTimeZone', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T06:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('returns the UTC date when timeZone is UTC', () => {
    expect(todayISOInTimeZone('UTC')).toBe('2026-01-15');
  });

  it('returns the previous day in a timezone behind UTC', () => {
    expect(todayISOInTimeZone('America/Los_Angeles')).toBe('2026-01-14');
  });
});

describe('addDaysISO', () => {
  it('adds days within the same month', () => {
    expect(addDaysISO('2026-01-01', 10)).toBe('2026-01-11');
  });

  it('crosses a month boundary', () => {
    expect(addDaysISO('2026-01-15', 42)).toBe('2026-02-26');
  });

  it('crosses a year boundary', () => {
    expect(addDaysISO('2026-12-20', 14)).toBe('2027-01-03');
  });
});

describe('targetDateForStage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T06:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('combines today-in-timezone with the offset', () => {
    expect(targetDateForStage(42, 'America/Los_Angeles')).toBe('2026-02-25');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/dates.test.ts`
Expected: FAIL — `src/dates.ts` does not exist yet.

- [ ] **Step 3: Write `src/dates.ts`**

```typescript
// src/dates.ts
export function todayISOInTimeZone(timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

export function addDaysISO(dateISO: string, days: number): string {
  const [year, month, day] = dateISO.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function targetDateForStage(offsetDays: number, timeZone: string): string {
  return addDaysISO(todayISOInTimeZone(timeZone), offsetDays);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/dates.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add membership-reminders/src/dates.ts membership-reminders/src/dates.test.ts
git commit -m "feat(membership-reminders): timezone-aware date utilities"
```

---

### Task 3: Config validation

**Files:**
- Create: `membership-reminders/src/config.ts`
- Test: `membership-reminders/src/config.test.ts`

**Interfaces:**
- Consumes: `Config` type from `src/types.ts` (Task 1).
- Produces: `validateConfig(raw: unknown): Config` — throws a descriptive `Error` if a required key is
  missing or the wrong shape; otherwise returns `raw` typed as `Config`. Used by `src/index.ts` (Task 10)
  before the config is handed to `reminders.ts`.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/config.test.ts
import { describe, it, expect } from 'vitest';
import { validateConfig } from './config';

const validConfig = {
  monday: {
    apiUrl: 'https://api.monday.com/v2',
    donorsBoardId: null,
    columns: {
      membershipStatus: 'status',
      membershipTier: 'tier',
      memberUntil: 'until',
      remindersSent: 'sent',
      email: 'email',
    },
  },
  stages: [{ tag: '6w', offsetDays: 42 }],
  renewalUrl: 'https://example.org/renew',
  timeZone: 'America/Los_Angeles',
  lifetimeTierValue: 'Lifetime',
  activeStatusValue: 'Active',
};

describe('validateConfig', () => {
  it('returns the config unchanged when valid', () => {
    expect(validateConfig(validConfig)).toEqual(validConfig);
  });

  it('throws when a top-level key is missing', () => {
    const { renewalUrl, ...missing } = validConfig;
    expect(() => validateConfig(missing)).toThrow(/renewalUrl/);
  });

  it('throws when monday.columns is missing a column', () => {
    const { email, ...missingEmail } = validConfig.monday.columns;
    const broken = { ...validConfig, monday: { ...validConfig.monday, columns: missingEmail } };
    expect(() => validateConfig(broken)).toThrow(/email/);
  });

  it('throws when stages is empty', () => {
    expect(() => validateConfig({ ...validConfig, stages: [] })).toThrow(/stages/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/config.test.ts`
Expected: FAIL — `src/config.ts` does not exist yet.

- [ ] **Step 3: Write `src/config.ts`**

```typescript
// src/config.ts
import type { Config, MondayColumns } from './types';

const REQUIRED_TOP_LEVEL = [
  'monday',
  'stages',
  'renewalUrl',
  'timeZone',
  'lifetimeTierValue',
  'activeStatusValue',
] as const;

const REQUIRED_COLUMNS: (keyof MondayColumns)[] = [
  'membershipStatus',
  'membershipTier',
  'memberUntil',
  'remindersSent',
  'email',
];

export function validateConfig(raw: unknown): Config {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('config: expected an object');
  }
  const cfg = raw as Record<string, unknown>;

  for (const key of REQUIRED_TOP_LEVEL) {
    if (!(key in cfg)) {
      throw new Error(`config: missing required key "${key}"`);
    }
  }

  const monday = cfg.monday as Record<string, unknown>;
  const columns = monday.columns as Record<string, unknown> | undefined;
  if (!columns) {
    throw new Error('config: missing required key "monday.columns"');
  }
  for (const key of REQUIRED_COLUMNS) {
    if (!(key in columns)) {
      throw new Error(`config: missing required key "monday.columns.${key}"`);
    }
  }

  if (!Array.isArray(cfg.stages) || cfg.stages.length === 0) {
    throw new Error('config: "stages" must be a non-empty array');
  }

  return cfg as unknown as Config;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add membership-reminders/src/config.ts membership-reminders/src/config.test.ts
git commit -m "feat(membership-reminders): validate config shape at startup"
```

---

### Task 4: Reminder email templates

**Files:**
- Create: `membership-reminders/src/templates.ts`
- Test: `membership-reminders/src/templates.test.ts`

**Interfaces:**
- Consumes: `StageConfig` type from `src/types.ts` (Task 1).
- Produces:
  - `TemplateData { name: string; memberUntil: string; renewalUrl: string }`
  - `RenderedEmail { subject: string; body: string }`
  - `renderTemplate(stage: StageConfig, data: TemplateData): RenderedEmail` — throws if `stage.tag` has
    no template. Used by `src/reminders.ts` (Task 9).

- [ ] **Step 1: Write the failing tests**

```typescript
// src/templates.test.ts
import { describe, it, expect } from 'vitest';
import { renderTemplate } from './templates';

const data = { name: 'Jamie', memberUntil: '2026-10-01', renewalUrl: 'https://example.org/renew' };

describe('renderTemplate', () => {
  it('renders the 6-week stage', () => {
    const email = renderTemplate({ tag: '6w', offsetDays: 42 }, data);
    expect(email.subject).toMatch(/6 weeks/);
    expect(email.body).toContain('Jamie');
    expect(email.body).toContain('2026-10-01');
    expect(email.body).toContain('https://example.org/renew');
  });

  it('renders the 4-week stage', () => {
    const email = renderTemplate({ tag: '4w', offsetDays: 28 }, data);
    expect(email.subject).toMatch(/4 weeks/);
  });

  it('renders the 2-week stage', () => {
    const email = renderTemplate({ tag: '2w', offsetDays: 14 }, data);
    expect(email.subject).toMatch(/2 weeks/);
  });

  it('throws for an unknown stage tag', () => {
    expect(() => renderTemplate({ tag: '1w', offsetDays: 7 }, data)).toThrow(/1w/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/templates.test.ts`
Expected: FAIL — `src/templates.ts` does not exist yet.

- [ ] **Step 3: Write `src/templates.ts`**

```typescript
// src/templates.ts
import type { StageConfig } from './types';

export interface TemplateData {
  name: string;
  memberUntil: string;
  renewalUrl: string;
}

export interface RenderedEmail {
  subject: string;
  body: string;
}

const SUBJECTS: Record<string, string> = {
  '6w': 'Your SVBC membership renews in 6 weeks',
  '4w': 'Your SVBC membership renews in 4 weeks',
  '2w': 'Your SVBC membership renews in 2 weeks',
};

const INTROS: Record<string, string> = {
  '6w': 'just a heads-up that your membership is coming up for renewal.',
  '4w': 'your membership renews soon — here is a reminder to renew.',
  '2w': 'your membership renews very soon. This is your final reminder.',
};

export function renderTemplate(stage: StageConfig, data: TemplateData): RenderedEmail {
  const subject = SUBJECTS[stage.tag];
  const intro = INTROS[stage.tag];
  if (!subject || !intro) {
    throw new Error(`templates: no template defined for stage "${stage.tag}"`);
  }
  const body = [
    `Hi ${data.name},`,
    '',
    intro,
    '',
    `Your membership expires on ${data.memberUntil}.`,
    `Renew here: ${data.renewalUrl}`,
    '',
    'Thanks for being a member of Silicon Valley Bicycle Coalition!',
  ].join('\n');
  return { subject, body };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/templates.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add membership-reminders/src/templates.ts membership-reminders/src/templates.test.ts
git commit -m "feat(membership-reminders): 6/4/2-week reminder templates"
```

---

### Task 5: Eligibility and idempotency filters

**Files:**
- Create: `membership-reminders/src/filter.ts`
- Test: `membership-reminders/src/filter.test.ts`

**Interfaces:**
- Consumes: `Member`, `StageConfig` types from `src/types.ts` (Task 1).
- Produces:
  - `isEligible(member: Member, lifetimeTierValue: string): boolean`
  - `stampValue(stage: StageConfig, memberUntil: string): string`
  - `hasStamp(remindersSent: string, stage: StageConfig, memberUntil: string): boolean`
  - `appendStamp(remindersSent: string, stage: StageConfig, memberUntil: string): string`

  All four are used by `src/reminders.ts` (Task 9).

- [ ] **Step 1: Write the failing tests**

```typescript
// src/filter.test.ts
import { describe, it, expect } from 'vitest';
import { isEligible, stampValue, hasStamp, appendStamp } from './filter';
import type { Member, StageConfig } from './types';

const stage6w: StageConfig = { tag: '6w', offsetDays: 42 };

function member(overrides: Partial<Member> = {}): Member {
  return {
    id: '1',
    name: 'Jamie',
    email: 'jamie@example.org',
    membershipTier: 'Individual',
    memberUntil: '2026-10-01',
    remindersSent: '',
    ...overrides,
  };
}

describe('isEligible', () => {
  it('is true for an active, non-Lifetime member with a Member Until date', () => {
    expect(isEligible(member(), 'Lifetime')).toBe(true);
  });

  it('is false for a Lifetime member', () => {
    expect(isEligible(member({ membershipTier: 'Lifetime' }), 'Lifetime')).toBe(false);
  });

  it('is false when Member Until is blank', () => {
    expect(isEligible(member({ memberUntil: '' }), 'Lifetime')).toBe(false);
  });
});

describe('stampValue', () => {
  it('combines the stage tag and member-until date', () => {
    expect(stampValue(stage6w, '2026-10-01')).toBe('6w:2026-10-01');
  });
});

describe('hasStamp', () => {
  it('is false on an empty reminders-sent value', () => {
    expect(hasStamp('', stage6w, '2026-10-01')).toBe(false);
  });

  it('is true when the exact stamp is present among others', () => {
    expect(hasStamp('4w:2026-04-01, 6w:2026-10-01', stage6w, '2026-10-01')).toBe(true);
  });

  it('is false when the tag matches but the term date differs (renewed)', () => {
    expect(hasStamp('6w:2026-01-01', stage6w, '2026-10-01')).toBe(false);
  });
});

describe('appendStamp', () => {
  it('returns the bare stamp when reminders-sent is empty', () => {
    expect(appendStamp('', stage6w, '2026-10-01')).toBe('6w:2026-10-01');
  });

  it('appends to an existing value', () => {
    expect(appendStamp('4w:2026-04-01', stage6w, '2026-10-01')).toBe('4w:2026-04-01, 6w:2026-10-01');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/filter.test.ts`
Expected: FAIL — `src/filter.ts` does not exist yet.

- [ ] **Step 3: Write `src/filter.ts`**

```typescript
// src/filter.ts
import type { Member, StageConfig } from './types';

export function isEligible(member: Member, lifetimeTierValue: string): boolean {
  if (member.membershipTier === lifetimeTierValue) return false;
  if (!member.memberUntil) return false;
  return true;
}

export function stampValue(stage: StageConfig, memberUntil: string): string {
  return `${stage.tag}:${memberUntil}`;
}

export function hasStamp(remindersSent: string, stage: StageConfig, memberUntil: string): boolean {
  if (!remindersSent) return false;
  const target = stampValue(stage, memberUntil);
  return remindersSent
    .split(',')
    .map((s) => s.trim())
    .includes(target);
}

export function appendStamp(remindersSent: string, stage: StageConfig, memberUntil: string): string {
  const value = stampValue(stage, memberUntil);
  return remindersSent ? `${remindersSent}, ${value}` : value;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/filter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add membership-reminders/src/filter.ts membership-reminders/src/filter.test.ts
git commit -m "feat(membership-reminders): eligibility and idempotency-stamp helpers"
```

---

### Task 6: Retry-with-backoff helper

**Files:**
- Create: `membership-reminders/src/retry.ts`
- Test: `membership-reminders/src/retry.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `withRetry<T>(fn: () => Promise<T>, options: { attempts: number; delayMs: number }):
  Promise<T>` — used by `src/reminders.ts` (Task 9) to wrap the send and stamp calls independently.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/retry.test.ts
import { describe, it, expect, vi } from 'vitest';
import { withRetry } from './retry';

describe('withRetry', () => {
  it('returns the result on the first successful attempt', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { attempts: 3, delayMs: 0 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries after failures and returns the eventual success', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'))
      .mockResolvedValue('ok');
    const result = await withRetry(fn, { attempts: 3, delayMs: 0 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws the last error once attempts are exhausted', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));
    await expect(withRetry(fn, { attempts: 2, delayMs: 0 })).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/retry.test.ts`
Expected: FAIL — `src/retry.ts` does not exist yet.

- [ ] **Step 3: Write `src/retry.ts`**

```typescript
// src/retry.ts
export interface RetryOptions {
  attempts: number;
  delayMs: number;
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < options.attempts) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
    }
  }
  throw lastError;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/retry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add membership-reminders/src/retry.ts membership-reminders/src/retry.test.ts
git commit -m "feat(membership-reminders): generic retry-with-backoff helper"
```

---

### Task 7: Email-sending stub

**Files:**
- Create: `membership-reminders/src/email.ts`
- Test: `membership-reminders/src/email.test.ts`

**Interfaces:**
- Consumes: `RenderedEmail` type from `src/templates.ts` (Task 4).
- Produces:
  - `EmailRecipient { email: string; name: string }`
  - `sendReminderEmail(recipient: EmailRecipient, email: RenderedEmail): Promise<void>` — used by
    `src/reminders.ts` (Task 9) and `src/index.ts` (Task 10). Logging-only for v1; swapping in a real
    provider later means changing only this file's body, not its signature.

- [ ] **Step 1: Write the failing test**

```typescript
// src/email.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { sendReminderEmail } from './email';

describe('sendReminderEmail', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs the send and resolves', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(
      sendReminderEmail(
        { email: 'jamie@example.org', name: 'Jamie' },
        { subject: 'Renew soon', body: 'body text' },
      ),
    ).resolves.toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('jamie@example.org'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Renew soon'));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/email.test.ts`
Expected: FAIL — `src/email.ts` does not exist yet.

- [ ] **Step 3: Write `src/email.ts`**

```typescript
// src/email.ts
import type { RenderedEmail } from './templates';

export interface EmailRecipient {
  email: string;
  name: string;
}

export async function sendReminderEmail(
  recipient: EmailRecipient,
  email: RenderedEmail,
): Promise<void> {
  console.log(
    `[email-stub] would send to ${recipient.email} (${recipient.name}): subject="${email.subject}"`,
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/email.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add membership-reminders/src/email.ts membership-reminders/src/email.test.ts
git commit -m "feat(membership-reminders): logging stub for reminder emails"
```

---

### Task 8: Monday API client

**Files:**
- Create: `membership-reminders/src/monday.ts`
- Test: `membership-reminders/src/monday.test.ts`

**Interfaces:**
- Consumes: `Member`, `MondayColumns` types from `src/types.ts` (Task 1).
- Produces:
  - `class MondayClient { constructor(apiUrl: string, token: string, fetchFn?: typeof fetch) }`
  - `MondayClient.queryDueMembers(boardId: number, columns: MondayColumns, activeStatusValue: string,
    targetDateISO: string): Promise<Member[]>`
  - `MondayClient.stampReminderSent(itemId: string, boardId: number, columnId: string, newValue:
    string): Promise<void>`

  Both methods are used by `src/reminders.ts` (Task 9), which supplies a `MondayClient` instance rather
  than importing this module directly — keeps `reminders.ts` testable against a fake with the same shape.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/monday.test.ts
import { describe, it, expect, vi } from 'vitest';
import { MondayClient } from './monday';
import type { MondayColumns } from './types';

const columns: MondayColumns = {
  membershipStatus: 'status',
  membershipTier: 'tier',
  memberUntil: 'until',
  remindersSent: 'sent',
  email: 'email',
};

function fakeResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

describe('MondayClient.queryDueMembers', () => {
  it('maps items and column values into Member objects', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      fakeResponse({
        data: {
          boards: [
            {
              items_page: {
                items: [
                  {
                    id: '123',
                    name: 'Jamie',
                    column_values: [
                      { id: 'email', text: 'jamie@example.org' },
                      { id: 'tier', text: 'Individual' },
                      { id: 'until', text: '2026-10-01' },
                      { id: 'sent', text: '4w:2026-04-01' },
                    ],
                  },
                ],
              },
            },
          ],
        },
      }),
    );
    const client = new MondayClient('https://api.monday.com/v2', 'token', fetchFn);
    const members = await client.queryDueMembers(999, columns, 'Active', '2026-10-01');
    expect(members).toEqual([
      {
        id: '123',
        name: 'Jamie',
        email: 'jamie@example.org',
        membershipTier: 'Individual',
        memberUntil: '2026-10-01',
        remindersSent: '4w:2026-04-01',
      },
    ]);
  });

  it('throws when the response has GraphQL errors', async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse({ errors: [{ message: 'bad column' }] }));
    const client = new MondayClient('https://api.monday.com/v2', 'token', fetchFn);
    await expect(client.queryDueMembers(999, columns, 'Active', '2026-10-01')).rejects.toThrow(
      'bad column',
    );
  });

  it('throws on a non-ok HTTP response', async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse({}, false, 500));
    const client = new MondayClient('https://api.monday.com/v2', 'token', fetchFn);
    await expect(client.queryDueMembers(999, columns, 'Active', '2026-10-01')).rejects.toThrow(
      'HTTP 500',
    );
  });
});

describe('MondayClient.stampReminderSent', () => {
  it('posts a mutation with the item id, column id, and new value', async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse({ data: { change_simple_column_value: { id: '123' } } }));
    const client = new MondayClient('https://api.monday.com/v2', 'token', fetchFn);
    await client.stampReminderSent('123', 999, 'sent', '6w:2026-10-01');

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchFn.mock.calls[0];
    const body = JSON.parse(requestInit.body as string);
    expect(body.variables).toEqual({
      boardId: 999,
      itemId: '123',
      columnId: 'sent',
      value: '6w:2026-10-01',
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/monday.test.ts`
Expected: FAIL — `src/monday.ts` does not exist yet.

- [ ] **Step 3: Write `src/monday.ts`**

```typescript
// src/monday.ts
import type { Member, MondayColumns } from './types';

interface MondayColumnValue {
  id: string;
  text: string | null;
}

interface MondayItem {
  id: string;
  name: string;
  column_values: MondayColumnValue[];
}

function columnText(item: MondayItem, columnId: string): string {
  return item.column_values.find((c) => c.id === columnId)?.text ?? '';
}

export function toMember(item: MondayItem, columns: MondayColumns): Member {
  return {
    id: item.id,
    name: item.name,
    email: columnText(item, columns.email),
    membershipTier: columnText(item, columns.membershipTier),
    memberUntil: columnText(item, columns.memberUntil),
    remindersSent: columnText(item, columns.remindersSent),
  };
}

export class MondayClient {
  constructor(
    private apiUrl: string,
    private token: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  private async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await this.fetchFn(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.token,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
      throw new Error(`monday: HTTP ${response.status}`);
    }
    const json = (await response.json()) as { data?: T; errors?: { message: string }[] };
    if (json.errors?.length) {
      throw new Error(`monday: ${json.errors.map((e) => e.message).join('; ')}`);
    }
    return json.data as T;
  }

  async queryDueMembers(
    boardId: number,
    columns: MondayColumns,
    activeStatusValue: string,
    targetDateISO: string,
  ): Promise<Member[]> {
    // NOTE: verify this query_params shape against Monday's current GraphQL API docs once the
    // sandbox Donors board exists — the exact rule syntax for status/date columns has changed
    // across Monday API versions.
    const query = `
      query ($boardId: ID!) {
        boards(ids: [$boardId]) {
          items_page(
            query_params: {
              rules: [
                { column_id: "${columns.membershipStatus}", compare_value: ["${activeStatusValue}"], operator: any_of },
                { column_id: "${columns.memberUntil}", compare_value: ["${targetDateISO}"], operator: any_of }
              ]
            }
          ) {
            items {
              id
              name
              column_values(ids: [${JSON.stringify(columns.email)}, ${JSON.stringify(columns.membershipTier)}, ${JSON.stringify(columns.memberUntil)}, ${JSON.stringify(columns.remindersSent)}]) {
                id
                text
              }
            }
          }
        }
      }
    `;
    const data = await this.request<{ boards: { items_page: { items: MondayItem[] } }[] }>(query, {
      boardId,
    });
    const items = data.boards[0]?.items_page.items ?? [];
    return items.map((item) => toMember(item, columns));
  }

  async stampReminderSent(
    itemId: string,
    boardId: number,
    columnId: string,
    newValue: string,
  ): Promise<void> {
    const mutation = `
      mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: String!) {
        change_simple_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) {
          id
        }
      }
    `;
    await this.request(mutation, { boardId, itemId, columnId, value: newValue });
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/monday.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add membership-reminders/src/monday.ts membership-reminders/src/monday.test.ts
git commit -m "feat(membership-reminders): Monday GraphQL client for querying and stamping members"
```

---

### Task 9: Reminder orchestration

**Files:**
- Create: `membership-reminders/src/reminders.ts`
- Test: `membership-reminders/src/reminders.test.ts`

**Interfaces:**
- Consumes:
  - `Config`, `RunSummary` from `src/types.ts` (Task 1)
  - `targetDateForStage` from `src/dates.ts` (Task 2)
  - `isEligible`, `hasStamp`, `appendStamp` from `src/filter.ts` (Task 5)
  - `renderTemplate` from `src/templates.ts` (Task 4)
  - `withRetry` from `src/retry.ts` (Task 6)
  - `MondayClient` (structural shape only — a fake with matching methods is used in tests) and
    `sendReminderEmail`'s signature from `src/monday.ts` / `src/email.ts` (Tasks 7–8)
- Produces: `runReminders(config: Config, deps: { monday: MondayClientLike; sendEmail: typeof
  sendReminderEmail }): Promise<RunSummary>` — used by `src/index.ts` (Task 10). Throws immediately if
  `config.monday.donorsBoardId` is `null`.

**Design note on error handling** (from the design spec): sending and stamping are retried
*independently*. If sending fails after retries, the member is counted as `failed` and stamping is
never attempted. If sending succeeds but stamping fails after retries, the member is still counted as
`sent` (the email went out — that's what matters) and the stamp failure is logged, not counted as a
run failure. This avoids a duplicate send that a single retry-wrapped block around both calls would
cause.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/reminders.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runReminders } from './reminders';
import type { Config, Member } from './types';

const baseConfig: Config = {
  monday: {
    apiUrl: 'https://api.monday.com/v2',
    donorsBoardId: 999,
    columns: {
      membershipStatus: 'status',
      membershipTier: 'tier',
      memberUntil: 'until',
      remindersSent: 'sent',
      email: 'email',
    },
  },
  stages: [{ tag: '6w', offsetDays: 42 }],
  renewalUrl: 'https://example.org/renew',
  timeZone: 'America/Los_Angeles',
  lifetimeTierValue: 'Lifetime',
  activeStatusValue: 'Active',
};

function member(overrides: Partial<Member> = {}): Member {
  return {
    id: '1',
    name: 'Jamie',
    email: 'jamie@example.org',
    membershipTier: 'Individual',
    memberUntil: '2026-10-01',
    remindersSent: '',
    ...overrides,
  };
}

function makeDeps(members: Member[]) {
  return {
    monday: {
      queryDueMembers: vi.fn().mockResolvedValue(members),
      stampReminderSent: vi.fn().mockResolvedValue(undefined),
    },
    sendEmail: vi.fn().mockResolvedValue(undefined),
  };
}

describe('runReminders', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T06:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('throws if donorsBoardId is not configured', async () => {
    const config = { ...baseConfig, monday: { ...baseConfig.monday, donorsBoardId: null } };
    await expect(runReminders(config, makeDeps([]))).rejects.toThrow('donorsBoardId');
  });

  it('sends and stamps an eligible, unstamped member', async () => {
    const deps = makeDeps([member()]);
    const summary = await runReminders(baseConfig, deps);
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
    expect(deps.monday.stampReminderSent).toHaveBeenCalledWith('1', 999, 'sent', '6w:2026-10-01');
    expect(summary.stages['6w']).toEqual({ sent: 1, skipped: 0, failed: 0 });
  });

  it('skips a Lifetime-tier member without sending', async () => {
    const deps = makeDeps([member({ membershipTier: 'Lifetime' })]);
    const summary = await runReminders(baseConfig, deps);
    expect(deps.sendEmail).not.toHaveBeenCalled();
    expect(summary.stages['6w']).toEqual({ sent: 0, skipped: 1, failed: 0 });
  });

  it('skips a member already stamped for this term', async () => {
    const deps = makeDeps([member({ remindersSent: '6w:2026-10-01' })]);
    const summary = await runReminders(baseConfig, deps);
    expect(deps.sendEmail).not.toHaveBeenCalled();
    expect(summary.stages['6w']).toEqual({ sent: 0, skipped: 1, failed: 0 });
  });

  it('counts a member as failed when sending never succeeds, without stamping', async () => {
    const deps = makeDeps([member()]);
    deps.sendEmail.mockRejectedValue(new Error('send failed'));
    const summary = await runReminders(baseConfig, deps);
    expect(deps.monday.stampReminderSent).not.toHaveBeenCalled();
    expect(summary.stages['6w']).toEqual({ sent: 0, skipped: 0, failed: 1 });
  });

  it('still counts as sent when the send succeeds but stamping never succeeds', async () => {
    const deps = makeDeps([member()]);
    deps.monday.stampReminderSent.mockRejectedValue(new Error('stamp failed'));
    const summary = await runReminders(baseConfig, deps);
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
    expect(summary.stages['6w']).toEqual({ sent: 1, skipped: 0, failed: 0 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/reminders.test.ts`
Expected: FAIL — `src/reminders.ts` does not exist yet.

- [ ] **Step 3: Write `src/reminders.ts`**

```typescript
// src/reminders.ts
import type { Config, Member, RunSummary } from './types';
import { targetDateForStage } from './dates';
import { isEligible, hasStamp, appendStamp } from './filter';
import { renderTemplate } from './templates';
import { withRetry } from './retry';
import type { sendReminderEmail } from './email';

export interface MondayClientLike {
  queryDueMembers(
    boardId: number,
    columns: Config['monday']['columns'],
    activeStatusValue: string,
    targetDateISO: string,
  ): Promise<Member[]>;
  stampReminderSent(
    itemId: string,
    boardId: number,
    columnId: string,
    newValue: string,
  ): Promise<void>;
}

export interface ReminderDeps {
  monday: MondayClientLike;
  sendEmail: typeof sendReminderEmail;
}

const RETRY_OPTIONS = { attempts: 3, delayMs: 200 };

export async function runReminders(config: Config, deps: ReminderDeps): Promise<RunSummary> {
  if (!config.monday.donorsBoardId) {
    throw new Error(
      'reminders: monday.donorsBoardId is not configured — set it once the sandbox Donors board exists',
    );
  }
  const boardId = config.monday.donorsBoardId;
  const summary: RunSummary = { stages: {} };

  for (const stage of config.stages) {
    const targetDate = targetDateForStage(stage.offsetDays, config.timeZone);
    const counts = { sent: 0, skipped: 0, failed: 0 };
    summary.stages[stage.tag] = counts;

    const members = await deps.monday.queryDueMembers(
      boardId,
      config.monday.columns,
      config.activeStatusValue,
      targetDate,
    );

    for (const member of members) {
      if (!isEligible(member, config.lifetimeTierValue)) {
        counts.skipped++;
        continue;
      }
      if (hasStamp(member.remindersSent, stage, member.memberUntil)) {
        counts.skipped++;
        continue;
      }

      const email = renderTemplate(stage, {
        name: member.name,
        memberUntil: member.memberUntil,
        renewalUrl: config.renewalUrl,
      });

      try {
        await withRetry(() => deps.sendEmail({ email: member.email, name: member.name }, email), RETRY_OPTIONS);
      } catch (sendErr) {
        counts.failed++;
        console.error(
          `[membership-reminders] failed to send stage=${stage.tag} member=${member.id}: ${(sendErr as Error).message}`,
        );
        continue;
      }

      counts.sent++;

      try {
        const newValue = appendStamp(member.remindersSent, stage, member.memberUntil);
        await withRetry(
          () => deps.monday.stampReminderSent(member.id, boardId, config.monday.columns.remindersSent, newValue),
          RETRY_OPTIONS,
        );
      } catch (stampErr) {
        console.error(
          `[membership-reminders] sent but failed to stamp stage=${stage.tag} member=${member.id}: ${(stampErr as Error).message}`,
        );
      }
    }
  }

  const hasFailures = Object.values(summary.stages).some((s) => s.failed > 0);
  const logFn = hasFailures ? console.error : console.log;
  logFn(`[membership-reminders] run summary: ${JSON.stringify(summary)}`);

  return summary;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/reminders.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add membership-reminders/src/reminders.ts membership-reminders/src/reminders.test.ts
git commit -m "feat(membership-reminders): orchestrate query, send, and stamp per stage"
```

---

### Task 10: Wire the Cron entrypoint

**Files:**
- Modify: `membership-reminders/src/index.ts`
- Test: `membership-reminders/src/index.test.ts`

**Interfaces:**
- Consumes: `validateConfig` (`src/config.ts`, Task 3), `MondayClient` (`src/monday.ts`, Task 8),
  `sendReminderEmail` (`src/email.ts`, Task 7), `runReminders` (`src/reminders.ts`, Task 9), and the raw
  `config/svbc.json` written in Task 1.
- Produces: the default-exported Worker object (`{ fetch, scheduled }`) that Wrangler loads — this is
  the last task, nothing downstream depends on it.

- [ ] **Step 1: Write the failing test for the scheduled handler**

Replace the full contents of `src/index.test.ts` with (this keeps the Task 1 health-route test and
adds the scheduled-handler test alongside it):

```typescript
// src/index.test.ts
import { describe, it, expect, vi } from 'vitest';
import worker from './index';
import { runReminders } from './reminders';

vi.mock('./reminders', () => ({
  runReminders: vi.fn().mockResolvedValue({ stages: {} }),
}));

describe('GET /health', () => {
  it('returns ok', async () => {
    const res = await worker.fetch(new Request('http://worker/health'), {} as never, {} as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('scheduled', () => {
  it('runs the reminder job and waits for it', async () => {
    const waitUntil = vi.fn();
    const env = { MONDAY_API_TOKEN: 'test-token' };

    await worker.scheduled?.({} as ScheduledEvent, env, { waitUntil } as unknown as ExecutionContext);

    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntil.mock.calls[0][0];
    expect(runReminders).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/index.test.ts`
Expected: FAIL — `worker.scheduled` is undefined.

- [ ] **Step 3: Update `src/index.ts`**

```typescript
// src/index.ts
import { Hono } from 'hono';
import configJson from '../config/svbc.json';
import { validateConfig } from './config';
import { MondayClient } from './monday';
import { sendReminderEmail } from './email';
import { runReminders } from './reminders';

export interface Env {
  MONDAY_API_TOKEN: string;
}

const config = validateConfig(configJson);

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ ok: true }));

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const monday = new MondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN);
    ctx.waitUntil(runReminders(config, { monday, sendEmail: sendReminderEmail }));
  },
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/index.test.ts`
Expected: PASS (both the Task 1 health-route test and the new scheduled test)

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add membership-reminders/src/index.ts membership-reminders/src/index.test.ts
git commit -m "feat(membership-reminders): wire scheduled handler to reminder orchestration"
```

---

## After this plan

Not covered here, tracked as follow-ups in the spec and README:

- Filling in `config/svbc.json`'s real `donorsBoardId` and column IDs once the sandbox Donors board is
  built, and the real renewal-page URL once one exists.
- Picking and wiring a real email provider into `src/email.ts` (Resend or MailChannels — see the design
  spec) — the `EmailRecipient`/`RenderedEmail` signature in that file is deliberately stable so this is
  a one-file change.
- `wrangler secret put MONDAY_API_TOKEN` against a dedicated least-privilege Monday integration user
  before the first real deploy.
