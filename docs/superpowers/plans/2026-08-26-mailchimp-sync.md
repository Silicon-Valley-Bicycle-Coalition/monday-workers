# mailchimp-sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repurpose the never-deployed `membership-reminders` Worker into `mailchimp-sync`: a
bidirectional, webhook-driven sync between Monday.com's Donors board and a Mailchimp audience,
plus a daily cron that keeps an auto-generated "Mailchimp Campaigns" Monday board in sync with
Mailchimp's Interest Categories.

**Architecture:** Three independent flows in one Worker, each following this repo's standard
webhook-driven shape (Hono route → D1 idempotency table → Cloudflare Queue → consumer does the
external write, with retry + dead-letter queue on failure): (1) outbound — a Monday Donor change
pushes merge fields/tags to Mailchimp; (2) inbound — a Mailchimp subscribe/unsubscribe/profile
event pushes the contact's current Interest memberships onto a Monday connect-column; (3) a daily
cron reconciles the Campaigns board's items against Mailchimp's actual Interest Categories
(create/rename/archive), with no queue — a self-healing cron-poller like `committee-calendars`.

**Tech Stack:** Hono + TypeScript, Cloudflare D1, Cloudflare Queues, Cloudflare Cron Triggers,
Vitest with `@cloudflare/vitest-plugin` for D1-backed tests, Monday.com GraphQL API, Mailchimp
Marketing API v3.

**Spec:** [`docs/superpowers/specs/2026-08-26-mailchimp-sync-design.md`](../specs/2026-08-26-mailchimp-sync-design.md)

## Global Constraints

- TypeScript strict mode, `noUncheckedIndexedAccess: true` (see `tsconfig.json`) — every task's
  code must satisfy this.
- No manual retry logic inside the outbound/inbound consumers — a thrown error triggers
  `message.retry()` and Cloudflare Queues' own retry/DLQ (3 attempts, per `wrangler.jsonc`).
  `withRetry` (`src/retry.ts`, unchanged) is used only in the cron-based reconciliation path,
  which has no Queue safety net of its own.
- Distinguish transient Mailchimp failures (429, 5xx) from permanent ones (4xx) via
  `MailchimpTransientError` / `MailchimpPermanentError` — a permanent error acks the message
  (logged, not retried) instead of looping to the DLQ.
- Board/column ids and the Mailchimp audience id are placeholders (`null` / `REPLACE_WITH_*`) in
  `config/svbc.json` until the real Donors board and Mailchimp audience exist — every task's tests
  run entirely against mocked Monday/Mailchimp clients, never live APIs.
- Every new D1-backed module gets a Vitest test using the real `@cloudflare/vitest-plugin` D1
  binding (not a hand-rolled mock of `D1Database`) — see Task 1's harness.
- Match `donation-rollups`' file layout and naming conventions exactly (`src/monday/client.ts`,
  `src/webhook/`, `src/db/`, `src/consumer/`) since it's this repo's only existing precedent for
  this Worker shape.

---

## Task 1: Repurpose the Worker skeleton

**Files:**
- Rename (git mv): `membership-reminders/` → `mailchimp-sync/`
- Delete: `mailchimp-sync/src/dates.ts`, `dates.test.ts`, `filter.ts`, `filter.test.ts`,
  `reminders.ts`, `reminders.test.ts`, `templates.ts`, `templates.test.ts`, `email.ts`,
  `email.test.ts`, `src/monday.ts`, `src/monday.test.ts` (replaced by `src/monday/client.ts` in
  Task 6), `src/index.ts`, `src/index.test.ts` (rewritten in Task 8), `src/config.ts`,
  `src/config.test.ts`, `src/types.ts` (rewritten in Task 2)
- Modify: `mailchimp-sync/package.json`, `mailchimp-sync/wrangler.jsonc`
- Create: `mailchimp-sync/vitest.config.ts`, `mailchimp-sync/test/apply-migrations.ts`,
  `mailchimp-sync/test/env.d.ts`

**Interfaces:**
- Produces: a Worker directory named `mailchimp-sync` with `npm test` passing (trivially, on the
  one remaining file — `src/retry.ts`/`src/retry.test.ts`, kept unchanged) under the
  `@cloudflare/vitest-plugin` D1 test harness, ready for Task 2 onward to build into.

- [ ] **Step 1: Rename the directory and inspect what's left**

```bash
git mv membership-reminders mailchimp-sync
ls mailchimp-sync/src
```

Expected remaining files after the `git mv`: `config.ts`, `config.test.ts`, `dates.ts`,
`dates.test.ts`, `email.ts`, `email.test.ts`, `filter.ts`, `filter.test.ts`, `index.ts`,
`index.test.ts`, `monday.ts`, `monday.test.ts`, `reminders.ts`, `reminders.test.ts`, `retry.ts`,
`retry.test.ts`, `templates.ts`, `templates.test.ts`, `types.ts`.

- [ ] **Step 2: Delete the obsolete send/timing files**

```bash
git rm mailchimp-sync/src/dates.ts mailchimp-sync/src/dates.test.ts \
       mailchimp-sync/src/filter.ts mailchimp-sync/src/filter.test.ts \
       mailchimp-sync/src/reminders.ts mailchimp-sync/src/reminders.test.ts \
       mailchimp-sync/src/templates.ts mailchimp-sync/src/templates.test.ts \
       mailchimp-sync/src/email.ts mailchimp-sync/src/email.test.ts \
       mailchimp-sync/src/monday.ts mailchimp-sync/src/monday.test.ts \
       mailchimp-sync/src/index.ts mailchimp-sync/src/index.test.ts \
       mailchimp-sync/src/config.ts mailchimp-sync/src/config.test.ts \
       mailchimp-sync/src/types.ts
```

`src/retry.ts` and `src/retry.test.ts` are the only files left in `src/` — leave them untouched,
they're reused as-is (see Global Constraints).

- [ ] **Step 3: Update `package.json`**

Replace `mailchimp-sync/package.json` with:

```json
{
  "name": "mailchimp-sync",
  "version": "0.1.0",
  "description": "Bidirectional Monday.com <-> Mailchimp sync: Donor merge fields/tags out, campaign/journey membership back, plus a Campaigns board kept in sync with Mailchimp's Interest Categories.",
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
    "hono": "^4.13.3",
    "md5": "^2.3.0"
  },
  "devDependencies": {
    "@cloudflare/vitest-plugin": "^1.0.0",
    "@cloudflare/workers-types": "^5.20260822.1",
    "@types/md5": "^2.3.5",
    "typescript": "^7.0.2",
    "vitest": "^4.1.11",
    "wrangler": "^4.125.0"
  }
}
```

`md5` is needed because Mailchimp's API keys every contact by the MD5 hex digest of their
lowercased email (the `subscriber_hash` in every `/lists/{list_id}/members/{subscriber_hash}`
call) — Web Crypto's `SubtleCrypto` (available in Workers) does not implement MD5, only the SHA
family, so this can't be done with a built-in.

- [ ] **Step 4: Replace `wrangler.jsonc`**

```jsonc
{
  "name": "svbc-mailchimp-sync",
  "main": "src/index.ts",
  "account_id": "f323cb191edeb5d30acc4d289427a010", // SVBC Account — forks: replace with your own
  "compatibility_date": "2026-08-01",
  "upload_source_maps": true,
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "svbc-mailchimp-sync",
      "database_id": "REPLACE_WITH_D1_DATABASE_ID", // set by `wrangler d1 create` at deploy time
      "migrations_dir": "migrations"
    }
  ],
  "queues": {
    "producers": [
      { "queue": "mailchimp-sync-outbound", "binding": "OUTBOUND_QUEUE" },
      { "queue": "mailchimp-sync-inbound", "binding": "INBOUND_QUEUE" }
    ],
    "consumers": [
      {
        "queue": "mailchimp-sync-outbound",
        "max_retries": 3,
        "max_concurrency": 1,
        "dead_letter_queue": "mailchimp-sync-outbound-dlq"
      },
      {
        "queue": "mailchimp-sync-inbound",
        "max_retries": 3,
        "max_concurrency": 1,
        "dead_letter_queue": "mailchimp-sync-inbound-dlq"
      }
    ]
  },
  "triggers": {
    // Once daily, 15:00 UTC = 7am Pacific (PDT) / 8am Pacific (PST) — Campaigns-board
    // reconciliation only, see Task 10. Fire hour doesn't affect correctness.
    "crons": ["0 15 * * *"]
  },
  "observability": {
    "enabled": true
  }
}
```

- [ ] **Step 5: Add the D1 Vitest harness (copied from `donation-rollups`, unchanged)**

Create `mailchimp-sync/vitest.config.ts`:

```typescript
import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig, defineProject } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));

  return defineProject({
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
    },
  });
});
```

Create `mailchimp-sync/test/apply-migrations.ts`:

```typescript
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

Create `mailchimp-sync/test/env.d.ts` (extended again in Tasks 8/13 as more bindings are added):

```typescript
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    OUTBOUND_QUEUE: Queue<{ donorItemId: string }>;
    INBOUND_QUEUE: Queue<{ email: string }>;
    MONDAY_API_TOKEN: string;
    MAILCHIMP_API_KEY: string;
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}
```

Create an empty `mailchimp-sync/migrations/` directory so `readD1Migrations` has somewhere to
read from before Task 4 adds the first migration file:

```bash
mkdir -p mailchimp-sync/migrations
touch mailchimp-sync/migrations/.gitkeep
```

- [ ] **Step 6: Install dependencies and verify the harness runs green**

```bash
cd mailchimp-sync && npm install && npm test
```

Expected: the `retry.test.ts` suite passes (4 tests), no other test files exist yet.

- [ ] **Step 7: Commit**

```bash
git add mailchimp-sync package.json 2>/dev/null; git add mailchimp-sync
git commit -m "chore(mailchimp-sync): repurpose membership-reminders skeleton

Renames the never-deployed membership-reminders Worker, strips its
cron/template/email-sending code (timing and copy move to Mailchimp
Journeys per the design doc), and adds the D1 Vitest harness this
Worker needs that membership-reminders never did."
```

---

## Task 2: Types and config validation

**Files:**
- Create: `mailchimp-sync/src/types.ts`
- Create: `mailchimp-sync/src/config.ts`
- Test: `mailchimp-sync/src/config.test.ts`
- Create: `mailchimp-sync/config/svbc.json`

**Interfaces:**
- Produces: `Config`, `Env`, `DonorRecord`, `OutboundSyncMessage`, `InboundSyncMessage`,
  `PendingStatus`, `MailchimpInterest` types; `validateConfig(raw: unknown): Config`.

- [ ] **Step 1: Write `src/types.ts`**

```typescript
export interface MailchimpMergeFieldsConfig {
  memberSince: string;
  memberUntil: string;
  membershipTier: string;
  membershipStatus: string;
  address: string;
  totalGiven: string;
}

export interface MailchimpTagsConfig {
  activeMember: string;
  lapsedMember: string;
  lifetimeMember: string;
  hasDonated: string;
}

export interface MondayColumnsConfig {
  membershipStatus: string;
  membershipTier: string;
  memberSince: string;
  memberUntil: string;
  addr1: string;
  city: string;
  state: string;
  zip: string;
  email: string;
  totalGiven: string;
  mailchimpCampaigns: string;
}

export interface Config {
  monday: {
    apiUrl: string;
    donorsBoardId: number | null;
    campaignsBoardId: number | null;
    columns: MondayColumnsConfig;
  };
  mailchimp: {
    apiBaseUrl: string;
    audienceId: string;
    mergeFields: MailchimpMergeFieldsConfig;
    tags: MailchimpTagsConfig;
  };
  lifetimeTierValue: string;
  activeStatusValue: string;
}

export interface Env {
  DB: D1Database;
  OUTBOUND_QUEUE: Queue<OutboundSyncMessage>;
  INBOUND_QUEUE: Queue<InboundSyncMessage>;
  MONDAY_API_TOKEN: string;
  MONDAY_WEBHOOK_SECRET?: string;
  MAILCHIMP_API_KEY: string;
  MAILCHIMP_WEBHOOK_SECRET?: string;
}

export interface OutboundSyncMessage {
  donorItemId: string;
}

export interface InboundSyncMessage {
  email: string;
}

export type PendingStatus = 'received' | 'queued' | 'written' | 'failed';

// A Donor item's column values, already resolved to plain strings — '' means the
// column was blank, never undefined/missing (see monday/client.ts's getDonorById).
export interface DonorRecord {
  id: string;
  email: string;
  membershipStatus: string;
  membershipTier: string;
  memberSince: string; // YYYY-MM-DD or ''
  memberUntil: string; // YYYY-MM-DD or ''
  addr1: string;
  city: string;
  state: string;
  zip: string;
  totalGiven: string;
}

export interface MailchimpInterest {
  categoryId: string;
  interestId: string;
  name: string;
}
```

- [ ] **Step 2: Write the failing config test**

```typescript
// src/config.test.ts
import { describe, it, expect } from 'vitest';
import { validateConfig } from './config';

function validRaw() {
  return {
    monday: {
      apiUrl: 'https://api.monday.com/v2',
      donorsBoardId: null,
      campaignsBoardId: null,
      columns: {
        membershipStatus: 'c1', membershipTier: 'c2', memberSince: 'c3', memberUntil: 'c4',
        addr1: 'c5', city: 'c6', state: 'c7', zip: 'c8', email: 'c9', totalGiven: 'c10',
        mailchimpCampaigns: 'c11',
      },
    },
    mailchimp: {
      apiBaseUrl: 'https://us1.api.mailchimp.com/3.0',
      audienceId: 'abc123',
      mergeFields: {
        memberSince: 'MEMBERSINCE', memberUntil: 'MEMBERUNTIL', membershipTier: 'MTIER',
        membershipStatus: 'MSTATUS', address: 'ADDRESS', totalGiven: 'TOTALGIVE',
      },
      tags: {
        activeMember: 'active-member', lapsedMember: 'lapsed-member',
        lifetimeMember: 'lifetime-member', hasDonated: 'has-donated',
      },
    },
    lifetimeTierValue: 'Lifetime',
    activeStatusValue: 'Active',
  };
}

describe('validateConfig', () => {
  it('accepts a fully-populated config', () => {
    const config = validateConfig(validRaw());
    expect(config.mailchimp.audienceId).toBe('abc123');
    expect(config.monday.columns.email).toBe('c9');
  });

  it('rejects a non-object', () => {
    expect(() => validateConfig(null)).toThrow('config: expected an object');
  });

  it('rejects a missing monday.columns key', () => {
    const raw = validRaw();
    delete (raw.monday.columns as Record<string, unknown>).email;
    expect(() => validateConfig(raw)).toThrow('config: missing required key "monday.columns.email"');
  });

  it('rejects a missing mailchimp.mergeFields key', () => {
    const raw = validRaw();
    delete (raw.mailchimp.mergeFields as Record<string, unknown>).address;
    expect(() => validateConfig(raw)).toThrow('config: missing required key "mailchimp.mergeFields.address"');
  });

  it('rejects a missing mailchimp.tags key', () => {
    const raw = validRaw();
    delete (raw.mailchimp.tags as Record<string, unknown>).hasDonated;
    expect(() => validateConfig(raw)).toThrow('config: missing required key "mailchimp.tags.hasDonated"');
  });

  it('rejects a missing top-level key', () => {
    const raw = validRaw();
    delete (raw as Record<string, unknown>).lifetimeTierValue;
    expect(() => validateConfig(raw)).toThrow('config: missing required key "lifetimeTierValue"');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- src/config.test.ts`
Expected: FAIL — `./config` has no exported member `validateConfig` (file doesn't exist yet).

- [ ] **Step 4: Write `src/config.ts`**

```typescript
import type { Config, MondayColumnsConfig, MailchimpMergeFieldsConfig, MailchimpTagsConfig } from './types';

const REQUIRED_TOP_LEVEL = ['monday', 'mailchimp', 'lifetimeTierValue', 'activeStatusValue'] as const;

const REQUIRED_MONDAY_COLUMNS: (keyof MondayColumnsConfig)[] = [
  'membershipStatus', 'membershipTier', 'memberSince', 'memberUntil',
  'addr1', 'city', 'state', 'zip', 'email', 'totalGiven', 'mailchimpCampaigns',
];

const REQUIRED_MERGE_FIELDS: (keyof MailchimpMergeFieldsConfig)[] = [
  'memberSince', 'memberUntil', 'membershipTier', 'membershipStatus', 'address', 'totalGiven',
];

const REQUIRED_TAGS: (keyof MailchimpTagsConfig)[] = [
  'activeMember', 'lapsedMember', 'lifetimeMember', 'hasDonated',
];

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`config: missing required key "${path}"`);
  }
  return value as Record<string, unknown>;
}

function requireStringKeys(obj: Record<string, unknown>, keys: readonly string[], prefix: string): void {
  for (const key of keys) {
    if (typeof obj[key] !== 'string' || obj[key] === '') {
      throw new Error(`config: missing required key "${prefix}.${key}"`);
    }
  }
}

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

  const monday = requireObject(cfg.monday, 'monday');
  if (typeof monday.apiUrl !== 'string' || monday.apiUrl === '') {
    throw new Error('config: missing required key "monday.apiUrl"');
  }
  const columns = requireObject(monday.columns, 'monday.columns');
  requireStringKeys(columns, REQUIRED_MONDAY_COLUMNS, 'monday.columns');

  const mailchimp = requireObject(cfg.mailchimp, 'mailchimp');
  if (typeof mailchimp.apiBaseUrl !== 'string' || mailchimp.apiBaseUrl === '') {
    throw new Error('config: missing required key "mailchimp.apiBaseUrl"');
  }
  if (typeof mailchimp.audienceId !== 'string' || mailchimp.audienceId === '') {
    throw new Error('config: missing required key "mailchimp.audienceId"');
  }
  const mergeFields = requireObject(mailchimp.mergeFields, 'mailchimp.mergeFields');
  requireStringKeys(mergeFields, REQUIRED_MERGE_FIELDS, 'mailchimp.mergeFields');
  const tags = requireObject(mailchimp.tags, 'mailchimp.tags');
  requireStringKeys(tags, REQUIRED_TAGS, 'mailchimp.tags');

  if (typeof cfg.lifetimeTierValue !== 'string' || cfg.lifetimeTierValue === '') {
    throw new Error('config: missing required key "lifetimeTierValue"');
  }
  if (typeof cfg.activeStatusValue !== 'string' || cfg.activeStatusValue === '') {
    throw new Error('config: missing required key "activeStatusValue"');
  }

  return {
    monday: {
      apiUrl: monday.apiUrl,
      donorsBoardId: (monday.donorsBoardId as number | null) ?? null,
      campaignsBoardId: (monday.campaignsBoardId as number | null) ?? null,
      columns: columns as unknown as MondayColumnsConfig,
    },
    mailchimp: {
      apiBaseUrl: mailchimp.apiBaseUrl,
      audienceId: mailchimp.audienceId,
      mergeFields: mergeFields as unknown as MailchimpMergeFieldsConfig,
      tags: tags as unknown as MailchimpTagsConfig,
    },
    lifetimeTierValue: cfg.lifetimeTierValue,
    activeStatusValue: cfg.activeStatusValue,
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- src/config.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Create `config/svbc.json`**

```json
{
  "monday": {
    "apiUrl": "https://api.monday.com/v2",
    "donorsBoardId": null,
    "campaignsBoardId": null,
    "columns": {
      "membershipStatus": "REPLACE_WITH_COLUMN_ID",
      "membershipTier": "REPLACE_WITH_COLUMN_ID",
      "memberSince": "REPLACE_WITH_COLUMN_ID",
      "memberUntil": "REPLACE_WITH_COLUMN_ID",
      "addr1": "REPLACE_WITH_COLUMN_ID",
      "city": "REPLACE_WITH_COLUMN_ID",
      "state": "REPLACE_WITH_COLUMN_ID",
      "zip": "REPLACE_WITH_COLUMN_ID",
      "email": "REPLACE_WITH_COLUMN_ID",
      "totalGiven": "REPLACE_WITH_COLUMN_ID",
      "mailchimpCampaigns": "REPLACE_WITH_COLUMN_ID"
    }
  },
  "mailchimp": {
    "apiBaseUrl": "https://REPLACE_WITH_DC.api.mailchimp.com/3.0",
    "audienceId": "REPLACE_WITH_AUDIENCE_ID",
    "mergeFields": {
      "memberSince": "MEMBERSINCE",
      "memberUntil": "MEMBERUNTIL",
      "membershipTier": "MTIER",
      "membershipStatus": "MSTATUS",
      "address": "ADDRESS",
      "totalGiven": "TOTALGIVE"
    },
    "tags": {
      "activeMember": "active-member",
      "lapsedMember": "lapsed-member",
      "lifetimeMember": "lifetime-member",
      "hasDonated": "has-donated"
    }
  },
  "lifetimeTierValue": "Lifetime",
  "activeStatusValue": "Active"
}
```

- [ ] **Step 7: Commit**

```bash
git add mailchimp-sync/src/types.ts mailchimp-sync/src/config.ts mailchimp-sync/src/config.test.ts mailchimp-sync/config/svbc.json
git commit -m "feat(mailchimp-sync): add config/types for the bidirectional sync shape"
```

---

## Task 3: Mailchimp API client

**Files:**
- Create: `mailchimp-sync/src/mailchimp/client.ts`
- Test: `mailchimp-sync/src/mailchimp/client.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks besides `md5` (npm package, Task 1).
- Produces: `MailchimpClient` interface, `HttpMailchimpClient` class, `MailchimpTransientError`,
  `MailchimpPermanentError`, `MailchimpInterest` (re-exported from `types.ts`),
  `MailchimpMemberInterests`. Methods: `upsertMember(email, mergeFields, tags)`,
  `getMemberInterests(email)`, `listInterests()`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/mailchimp/client.test.ts
import { describe, it, expect, vi } from 'vitest';
import { HttpMailchimpClient, MailchimpTransientError, MailchimpPermanentError } from './client';

function fakeFetch(response: Partial<Response> & { json?: () => Promise<unknown>; text?: () => Promise<string> }) {
  return vi.fn().mockResolvedValue({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: response.json ?? (async () => ({})),
    text: response.text ?? (async () => ''),
  } as Response);
}

describe('HttpMailchimpClient.upsertMember', () => {
  it('PUTs the member keyed by the MD5 hash of the lowercased email', async () => {
    const fetchFn = fakeFetch({ ok: true });
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'key-us1', 'aud1', fetchFn);

    await client.upsertMember('Donor@Example.com', { MTIER: 'Standard' }, ['active-member']);

    expect(fetchFn).toHaveBeenCalledWith(
      // md5('donor@example.com') === '8a725a19b3286b4487ff6c02c1305abd'
      'https://us1.api.mailchimp.com/3.0/lists/aud1/members/8a725a19b3286b4487ff6c02c1305abd',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          email_address: 'Donor@Example.com',
          status_if_new: 'subscribed',
          merge_fields: { MTIER: 'Standard' },
          tags: ['active-member'],
        }),
      }),
    );
  });

  it('throws MailchimpTransientError on a 429', async () => {
    const fetchFn = fakeFetch({ ok: false, status: 429, text: async () => 'rate limited' });
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'key', 'aud1', fetchFn);
    await expect(client.upsertMember('a@b.com', {}, [])).rejects.toThrow(MailchimpTransientError);
  });

  it('throws MailchimpTransientError on a 500', async () => {
    const fetchFn = fakeFetch({ ok: false, status: 500, text: async () => 'server error' });
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'key', 'aud1', fetchFn);
    await expect(client.upsertMember('a@b.com', {}, [])).rejects.toThrow(MailchimpTransientError);
  });

  it('throws MailchimpPermanentError on a 400', async () => {
    const fetchFn = fakeFetch({ ok: false, status: 400, text: async () => 'invalid email' });
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'key', 'aud1', fetchFn);
    await expect(client.upsertMember('not-an-email', {}, [])).rejects.toThrow(MailchimpPermanentError);
  });
});

describe('HttpMailchimpClient.getMemberInterests', () => {
  it('returns null on a 404 (contact not yet in the audience)', async () => {
    const fetchFn = fakeFetch({ ok: false, status: 404 });
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'key', 'aud1', fetchFn);
    expect(await client.getMemberInterests('a@b.com')).toBeNull();
  });

  it('returns the interests map on success', async () => {
    const fetchFn = fakeFetch({
      ok: true,
      json: async () => ({ status: 'subscribed', interests: { int1: true, int2: false } }),
    });
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'key', 'aud1', fetchFn);
    expect(await client.getMemberInterests('a@b.com')).toEqual({
      status: 'subscribed',
      interests: { int1: true, int2: false },
    });
  });
});

describe('HttpMailchimpClient.listInterests', () => {
  it('flattens every category into one array of interests', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ categories: [{ id: 'cat1' }] }) } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ interests: [{ id: 'int1', name: 'Newsletter' }, { id: 'int2', name: 'Welcome Drip' }] }),
      } as Response);
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'key', 'aud1', fetchFn);

    const interests = await client.listInterests();

    expect(interests).toEqual([
      { categoryId: 'cat1', interestId: 'int1', name: 'Newsletter' },
      { categoryId: 'cat1', interestId: 'int2', name: 'Welcome Drip' },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/mailchimp/client.test.ts`
Expected: FAIL — `./client` module not found.

- [ ] **Step 3: Write `src/mailchimp/client.ts`**

```typescript
import md5 from 'md5';
import type { MailchimpInterest } from '../types';

export class MailchimpTransientError extends Error {}
export class MailchimpPermanentError extends Error {}

export interface MailchimpMemberInterests {
  status: string;
  interests: Record<string, boolean>;
}

export interface MailchimpClient {
  upsertMember(email: string, mergeFields: Record<string, unknown>, tags: string[]): Promise<void>;
  getMemberInterests(email: string): Promise<MailchimpMemberInterests | null>;
  listInterests(): Promise<MailchimpInterest[]>;
}

function subscriberHash(email: string): string {
  return md5(email.trim().toLowerCase());
}

export class HttpMailchimpClient implements MailchimpClient {
  constructor(
    private apiBaseUrl: string,
    private apiKey: string,
    private audienceId: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  // Mailchimp Marketing API auth: HTTP Basic with any non-empty username and the API
  // key as the password (documented behavior, not a real credential pair).
  private authHeader(): string {
    return `Basic ${btoa(`anystring:${this.apiKey}`)}`;
  }

  async upsertMember(email: string, mergeFields: Record<string, unknown>, tags: string[]): Promise<void> {
    const response = await this.fetchFn(
      `${this.apiBaseUrl}/lists/${this.audienceId}/members/${subscriberHash(email)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: this.authHeader() },
        body: JSON.stringify({
          email_address: email,
          status_if_new: 'subscribed',
          merge_fields: mergeFields,
          tags,
        }),
      },
    );
    if (response.ok) return;
    const detail = await response.text();
    if (response.status === 429 || response.status >= 500) {
      throw new MailchimpTransientError(`mailchimp upsertMember: HTTP ${response.status}: ${detail}`);
    }
    throw new MailchimpPermanentError(`mailchimp upsertMember: HTTP ${response.status}: ${detail}`);
  }

  async getMemberInterests(email: string): Promise<MailchimpMemberInterests | null> {
    const response = await this.fetchFn(
      `${this.apiBaseUrl}/lists/${this.audienceId}/members/${subscriberHash(email)}?fields=status,interests`,
      { headers: { Authorization: this.authHeader() } },
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      const detail = await response.text();
      throw new MailchimpTransientError(`mailchimp getMemberInterests: HTTP ${response.status}: ${detail}`);
    }
    const json = (await response.json()) as { status: string; interests?: Record<string, boolean> };
    return { status: json.status, interests: json.interests ?? {} };
  }

  async listInterests(): Promise<MailchimpInterest[]> {
    const categoriesResponse = await this.fetchFn(
      `${this.apiBaseUrl}/lists/${this.audienceId}/interest-categories?count=100`,
      { headers: { Authorization: this.authHeader() } },
    );
    if (!categoriesResponse.ok) {
      throw new MailchimpTransientError(`mailchimp listInterests: HTTP ${categoriesResponse.status}`);
    }
    const categoriesJson = (await categoriesResponse.json()) as { categories: { id: string }[] };

    const out: MailchimpInterest[] = [];
    for (const category of categoriesJson.categories) {
      const interestsResponse = await this.fetchFn(
        `${this.apiBaseUrl}/lists/${this.audienceId}/interest-categories/${category.id}/interests?count=100`,
        { headers: { Authorization: this.authHeader() } },
      );
      if (!interestsResponse.ok) {
        throw new MailchimpTransientError(`mailchimp listInterests: HTTP ${interestsResponse.status}`);
      }
      const interestsJson = (await interestsResponse.json()) as { interests: { id: string; name: string }[] };
      for (const interest of interestsJson.interests) {
        out.push({ categoryId: category.id, interestId: interest.id, name: interest.name });
      }
    }
    return out;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/mailchimp/client.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add mailchimp-sync/src/mailchimp
git commit -m "feat(mailchimp-sync): add Mailchimp API client (upsert, interests)"
```

---

## Task 4: Outbound D1 migration + pending store

**Files:**
- Create: `mailchimp-sync/migrations/0001_create_pending_outbound_syncs.sql`
- Create: `mailchimp-sync/src/db/pendingOutbound.ts`
- Test: `mailchimp-sync/src/db/pendingOutbound.test.ts`

**Interfaces:**
- Produces: `PendingOutboundStore` interface, `D1PendingOutboundStore` class with
  `upsertPending(donorItemId, receivedAt)`, `updateStatus(donorItemId, status, error?, writtenAt?)`.

- [ ] **Step 1: Remove the placeholder and add the migration**

```bash
rm mailchimp-sync/migrations/.gitkeep
```

Create `mailchimp-sync/migrations/0001_create_pending_outbound_syncs.sql`:

```sql
-- Keyed on the Donor item id — a redelivery for the same item replaces the row and
-- resets to 'received' rather than queuing a duplicate sync.
CREATE TABLE pending_outbound_syncs (
  donor_item_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'received', -- received -> queued -> written | failed
  error TEXT,
  received_at TEXT NOT NULL,
  written_at TEXT
);
```

- [ ] **Step 2: Write the failing test**

```typescript
// src/db/pendingOutbound.test.ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { D1PendingOutboundStore } from './pendingOutbound';

describe('D1PendingOutboundStore', () => {
  it('inserts a new pending row as received', async () => {
    const store = new D1PendingOutboundStore(env.DB);
    await store.upsertPending('item-1', '2026-08-26T00:00:00.000Z');

    const row = await env.DB.prepare(`SELECT * FROM pending_outbound_syncs WHERE donor_item_id = ?1`)
      .bind('item-1').first<{ status: string; received_at: string }>();
    expect(row?.status).toBe('received');
    expect(row?.received_at).toBe('2026-08-26T00:00:00.000Z');
  });

  it('a redelivery for the same item resets status to received and clears the prior error', async () => {
    const store = new D1PendingOutboundStore(env.DB);
    await store.upsertPending('item-2', '2026-08-26T00:00:00.000Z');
    await store.updateStatus('item-2', 'failed', 'boom');

    await store.upsertPending('item-2', '2026-08-26T01:00:00.000Z');

    const row = await env.DB.prepare(`SELECT * FROM pending_outbound_syncs WHERE donor_item_id = ?1`)
      .bind('item-2').first<{ status: string; error: string | null; received_at: string }>();
    expect(row?.status).toBe('received');
    expect(row?.error).toBeNull();
    expect(row?.received_at).toBe('2026-08-26T01:00:00.000Z');
  });

  it('updateStatus records an error and leaves written_at untouched when not provided', async () => {
    const store = new D1PendingOutboundStore(env.DB);
    await store.upsertPending('item-3', '2026-08-26T00:00:00.000Z');

    await store.updateStatus('item-3', 'failed', 'mailchimp down');

    const row = await env.DB.prepare(`SELECT * FROM pending_outbound_syncs WHERE donor_item_id = ?1`)
      .bind('item-3').first<{ status: string; error: string | null; written_at: string | null }>();
    expect(row).toEqual(expect.objectContaining({ status: 'failed', error: 'mailchimp down', written_at: null }));
  });

  it('updateStatus records written_at when provided', async () => {
    const store = new D1PendingOutboundStore(env.DB);
    await store.upsertPending('item-4', '2026-08-26T00:00:00.000Z');

    await store.updateStatus('item-4', 'written', undefined, '2026-08-26T02:00:00.000Z');

    const row = await env.DB.prepare(`SELECT * FROM pending_outbound_syncs WHERE donor_item_id = ?1`)
      .bind('item-4').first<{ status: string; written_at: string | null }>();
    expect(row).toEqual(expect.objectContaining({ status: 'written', written_at: '2026-08-26T02:00:00.000Z' }));
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- src/db/pendingOutbound.test.ts`
Expected: FAIL — `./pendingOutbound` module not found.

- [ ] **Step 4: Write `src/db/pendingOutbound.ts`**

```typescript
import type { PendingStatus } from '../types';

export interface PendingOutboundStore {
  upsertPending(donorItemId: string, receivedAt: string): Promise<void>;
  updateStatus(donorItemId: string, status: PendingStatus, error?: string, writtenAt?: string): Promise<void>;
}

export class D1PendingOutboundStore implements PendingOutboundStore {
  constructor(private db: D1Database) {}

  async upsertPending(donorItemId: string, receivedAt: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO pending_outbound_syncs (donor_item_id, status, received_at)
         VALUES (?1, 'received', ?2)
         ON CONFLICT (donor_item_id) DO UPDATE SET
           status = 'received', error = NULL, received_at = excluded.received_at`,
      )
      .bind(donorItemId, receivedAt)
      .run();
  }

  async updateStatus(donorItemId: string, status: PendingStatus, error?: string, writtenAt?: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE pending_outbound_syncs SET
           status = ?2, error = ?3, written_at = COALESCE(?4, written_at)
         WHERE donor_item_id = ?1`,
      )
      .bind(donorItemId, status, error ?? null, writtenAt ?? null)
      .run();
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- src/db/pendingOutbound.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add mailchimp-sync/migrations mailchimp-sync/src/db/pendingOutbound.ts mailchimp-sync/src/db/pendingOutbound.test.ts
git rm mailchimp-sync/migrations/.gitkeep 2>/dev/null || true
git commit -m "feat(mailchimp-sync): add outbound-sync D1 idempotency table"
```

---

## Task 5: Outbound webhook validation + route

**Files:**
- Create: `mailchimp-sync/src/webhook/validateMonday.ts`
- Create: `mailchimp-sync/src/webhook/outboundRoute.ts`
- Test: `mailchimp-sync/src/webhook/validateMonday.test.ts`
- Test: `mailchimp-sync/src/webhook/outboundRoute.test.ts`

**Interfaces:**
- Consumes: `PendingOutboundStore` (Task 4), `OutboundSyncMessage` (Task 2).
- Produces: `validateMondayWebhookBody(body): MondayDonorEvent`, `createOutboundApp(deps): Hono`,
  `OutboundQueueLike` interface.

- [ ] **Step 1: Write the failing validator test**

```typescript
// src/webhook/validateMonday.test.ts
import { describe, it, expect } from 'vitest';
import { validateMondayWebhookBody } from './validateMonday';

describe('validateMondayWebhookBody', () => {
  it('extracts the donor item id from a valid event', () => {
    expect(validateMondayWebhookBody({ event: { type: 'update_column_value', pulseId: 555, boardId: 123 } }))
      .toEqual({ donorItemId: '555' });
  });

  it('accepts a numeric or string pulseId', () => {
    expect(validateMondayWebhookBody({ event: { pulseId: '555' } })).toEqual({ donorItemId: '555' });
  });

  it('rejects a body with no event object', () => {
    expect(() => validateMondayWebhookBody({})).toThrow('webhook body has no "event" object');
  });

  it('rejects an event with no pulseId', () => {
    expect(() => validateMondayWebhookBody({ event: { type: 'create_pulse' } })).toThrow('webhook event has no pulseId');
  });

  it('rejects a non-object body', () => {
    expect(() => validateMondayWebhookBody('nope')).toThrow('webhook body is not an object');
  });
});
```

- [ ] **Step 2: Run to verify it fails, then write `src/webhook/validateMonday.ts`**

Run: `npm test -- src/webhook/validateMonday.test.ts` — expect FAIL (module not found).

```typescript
export interface MondayDonorEvent {
  donorItemId: string;
}

// Monday's webhook payload for a subscribed event looks like:
//   { event: { type: 'create_pulse' | 'update_column_value' | ..., pulseId, boardId, ... } }
// Only pulseId (the Donor item id) matters here — the outbound consumer re-fetches
// the item's current columns fresh rather than trusting anything else in the payload.
export function validateMondayWebhookBody(body: unknown): MondayDonorEvent {
  if (typeof body !== 'object' || body === null) {
    throw new Error('webhook body is not an object');
  }
  const event = (body as Record<string, unknown>).event;
  if (typeof event !== 'object' || event === null) {
    throw new Error('webhook body has no "event" object');
  }
  const pulseId = (event as Record<string, unknown>).pulseId;
  if (typeof pulseId !== 'number' && typeof pulseId !== 'string') {
    throw new Error('webhook event has no pulseId');
  }
  return { donorItemId: String(pulseId) };
}
```

Run: `npm test -- src/webhook/validateMonday.test.ts` — expect PASS (5 tests).

- [ ] **Step 3: Write the failing route test**

```typescript
// src/webhook/outboundRoute.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createOutboundApp } from './outboundRoute';
import type { PendingOutboundStore } from '../db/pendingOutbound';

function fakePendingStore(overrides: Partial<PendingOutboundStore> = {}): PendingOutboundStore {
  return {
    upsertPending: vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function post(app: ReturnType<typeof createOutboundApp>, body: unknown, query = '') {
  return app.request(`/webhooks/monday/donors${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('webhook secret', () => {
  it('rejects a request missing the configured secret with 401', async () => {
    const send = vi.fn();
    const app = createOutboundApp({ pendingStore: fakePendingStore(), queue: { send }, webhookSecret: 'shh' });
    const res = await post(app, { event: { pulseId: 1 } });
    expect(res.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it('accepts the correct secret, including for the challenge handshake', async () => {
    const app = createOutboundApp({ pendingStore: fakePendingStore(), queue: { send: vi.fn() }, webhookSecret: 'shh' });
    const res = await post(app, { challenge: 'abc' }, '?secret=shh');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'abc' });
  });
});

describe('POST /webhooks/monday/donors', () => {
  it('echoes the challenge verbatim during webhook-subscription verification', async () => {
    const app = createOutboundApp({ pendingStore: fakePendingStore(), queue: { send: vi.fn() } });
    const res = await post(app, { challenge: 'abc123' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'abc123' });
  });

  it('upserts and enqueues a valid event, keyed on the donor item id', async () => {
    const pendingStore = fakePendingStore();
    const send = vi.fn().mockResolvedValue(undefined);
    const app = createOutboundApp({ pendingStore, queue: { send } });

    const res = await post(app, { event: { pulseId: 555 } });

    expect(res.status).toBe(200);
    expect(pendingStore.upsertPending).toHaveBeenCalledWith('555', expect.any(String));
    expect(send).toHaveBeenCalledWith({ donorItemId: '555' });
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('555', 'queued');
  });

  it('rejects a malformed event body with 200 (no useful retry) and does not enqueue', async () => {
    const send = vi.fn();
    const app = createOutboundApp({ pendingStore: fakePendingStore(), queue: { send } });
    const res = await post(app, { event: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false });
    expect(send).not.toHaveBeenCalled();
  });

  it('returns 500 and marks failed when enqueue throws, so Monday redelivers', async () => {
    const pendingStore = fakePendingStore();
    const send = vi.fn().mockRejectedValue(new Error('queue down'));
    const app = createOutboundApp({ pendingStore, queue: { send } });

    const res = await post(app, { event: { pulseId: 1 } });

    expect(res.status).toBe(500);
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('1', 'failed', 'queue down');
  });
});
```

- [ ] **Step 4: Run to verify it fails, then write `src/webhook/outboundRoute.ts`**

Run: `npm test -- src/webhook/outboundRoute.test.ts` — expect FAIL (module not found).

```typescript
import { Hono } from 'hono';
import type { PendingOutboundStore } from '../db/pendingOutbound';
import { validateMondayWebhookBody } from './validateMonday';
import type { OutboundSyncMessage } from '../types';

export interface OutboundQueueLike {
  send(message: OutboundSyncMessage): Promise<void>;
}

export interface OutboundAppDeps {
  pendingStore: PendingOutboundStore;
  queue: OutboundQueueLike;
  // Monday doesn't sign webhook payloads — the mitigation is a shared secret embedded
  // in the webhook URL at subscription time, checked here. Unset disables the check;
  // never leave it unset outside local dev.
  webhookSecret?: string;
}

// Ingest-and-enqueue only — resolving the Donor's current columns and writing to
// Mailchimp both happen in the queue consumer (src/consumer/outbound.ts), where a
// transient failure gets retries and a dead-letter queue.
export function createOutboundApp(deps: OutboundAppDeps) {
  const app = new Hono();

  app.post('/webhooks/monday/donors', async (c) => {
    if (deps.webhookSecret && c.req.query('secret') !== deps.webhookSecret) {
      return c.json({ ok: false }, 401);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: 'invalid JSON body' }, 200);
    }

    // Monday's webhook-subscription verification handshake: echo the challenge back
    // verbatim, sent once at subscription-creation time.
    if (typeof body === 'object' && body !== null && 'challenge' in body) {
      return c.json({ challenge: (body as { challenge: unknown }).challenge }, 200);
    }

    let donorEvent;
    try {
      donorEvent = validateMondayWebhookBody(body);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`mailchimp-sync outbound webhook: rejected delivery: ${errMsg}`);
      return c.json({ ok: false, error: errMsg }, 200);
    }

    await deps.pendingStore.upsertPending(donorEvent.donorItemId, new Date().toISOString());

    try {
      await deps.queue.send({ donorItemId: donorEvent.donorItemId });
      await deps.pendingStore.updateStatus(donorEvent.donorItemId, 'queued');
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`mailchimp-sync outbound webhook: enqueue failed for donor "${donorEvent.donorItemId}": ${errMsg}`);
      await deps.pendingStore.updateStatus(donorEvent.donorItemId, 'failed', errMsg);
      // A 5xx gives Monday the chance to redeliver; upserting by donor id makes a
      // redelivery safe either way.
      return c.json({ ok: false }, 500);
    }

    return c.json({ ok: true }, 200);
  });

  return app;
}
```

Run: `npm test -- src/webhook/outboundRoute.test.ts` — expect PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add mailchimp-sync/src/webhook/validateMonday.ts mailchimp-sync/src/webhook/validateMonday.test.ts \
        mailchimp-sync/src/webhook/outboundRoute.ts mailchimp-sync/src/webhook/outboundRoute.test.ts
git commit -m "feat(mailchimp-sync): add outbound Monday webhook ingestion"
```

---

## Task 6: Monday client — read a Donor by id

**Files:**
- Create: `mailchimp-sync/src/monday/client.ts`
- Test: `mailchimp-sync/src/monday/client.test.ts`

**Interfaces:**
- Consumes: `MondayColumnsConfig`, `DonorRecord` (Task 2).
- Produces: `MondayClient` interface (grown further in Tasks 9 and 12) with
  `getDonorById(itemId, columns): Promise<DonorRecord | null>`; `HttpMondayClient` class.

- [ ] **Step 1: Write the failing test**

```typescript
// src/monday/client.test.ts
import { describe, it, expect, vi } from 'vitest';
import { HttpMondayClient } from './client';
import type { MondayColumnsConfig } from '../types';

const COLUMNS: MondayColumnsConfig = {
  membershipStatus: 'status', membershipTier: 'tier', memberSince: 'since', memberUntil: 'until',
  addr1: 'addr1', city: 'city', state: 'state', zip: 'zip', email: 'email', totalGiven: 'given',
  mailchimpCampaigns: 'campaigns',
};

function fakeFetch(data: unknown) {
  return vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data }) } as Response);
}

describe('HttpMondayClient.getDonorById', () => {
  it('maps column_values to a DonorRecord, defaulting blank columns to empty string', async () => {
    const fetchFn = fakeFetch({
      items: [{
        id: '42',
        column_values: [
          { id: 'email', text: 'a@b.com' }, { id: 'status', text: 'Active' }, { id: 'tier', text: 'Standard' },
          { id: 'since', text: '2026-01-01' }, { id: 'until', text: null }, { id: 'addr1', text: '1 Main St' },
          { id: 'city', text: 'San Jose' }, { id: 'state', text: 'CA' }, { id: 'zip', text: '95110' },
          { id: 'given', text: '150' },
        ],
      }],
    });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', fetchFn);

    const donor = await client.getDonorById('42', COLUMNS);

    expect(donor).toEqual({
      id: '42', email: 'a@b.com', membershipStatus: 'Active', membershipTier: 'Standard',
      memberSince: '2026-01-01', memberUntil: '', addr1: '1 Main St', city: 'San Jose',
      state: 'CA', zip: '95110', totalGiven: '150',
    });
  });

  it('returns null when the item no longer exists', async () => {
    const fetchFn = fakeFetch({ items: [] });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', fetchFn);
    expect(await client.getDonorById('999', COLUMNS)).toBeNull();
  });

  it('throws on a GraphQL error response', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ errors: [{ message: 'board not found' }] }),
    } as Response);
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', fetchFn);
    await expect(client.getDonorById('42', COLUMNS)).rejects.toThrow('monday: board not found');
  });
});
```

- [ ] **Step 2: Run to verify it fails, then write `src/monday/client.ts`**

Run: `npm test -- src/monday/client.test.ts` — expect FAIL (module not found).

```typescript
import type { MondayColumnsConfig, DonorRecord } from '../types';

export interface MondayClient {
  getDonorById(itemId: string, columns: MondayColumnsConfig): Promise<DonorRecord | null>;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

export class HttpMondayClient implements MondayClient {
  constructor(
    private apiUrl: string,
    private apiToken: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await this.fetchFn(this.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: this.apiToken },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
      throw new Error(`monday: HTTP ${response.status}`);
    }
    const json = (await response.json()) as GraphQLResponse<T>;
    if (json.errors && json.errors.length > 0) {
      throw new Error(`monday: ${json.errors.map((e) => e.message).join('; ')}`);
    }
    return json.data as T;
  }

  async getDonorById(itemId: string, columns: MondayColumnsConfig): Promise<DonorRecord | null> {
    const columnIds = [
      columns.email, columns.membershipStatus, columns.membershipTier,
      columns.memberSince, columns.memberUntil, columns.addr1, columns.city,
      columns.state, columns.zip, columns.totalGiven,
    ];
    const data = await this.graphql<{ items: { id: string; column_values: { id: string; text: string | null }[] }[] }>(
      `query ($itemId: ID!, $columnIds: [String!]) {
        items(ids: [$itemId]) { id column_values(ids: $columnIds) { id text } }
      }`,
      { itemId, columnIds },
    );
    const item = data.items[0];
    if (item === undefined) return null;

    const byId = new Map(item.column_values.map((cv) => [cv.id, cv.text ?? '']));
    return {
      id: item.id,
      email: byId.get(columns.email) ?? '',
      membershipStatus: byId.get(columns.membershipStatus) ?? '',
      membershipTier: byId.get(columns.membershipTier) ?? '',
      memberSince: byId.get(columns.memberSince) ?? '',
      memberUntil: byId.get(columns.memberUntil) ?? '',
      addr1: byId.get(columns.addr1) ?? '',
      city: byId.get(columns.city) ?? '',
      state: byId.get(columns.state) ?? '',
      zip: byId.get(columns.zip) ?? '',
      totalGiven: byId.get(columns.totalGiven) ?? '',
    };
  }
}
```

Run: `npm test -- src/monday/client.test.ts` — expect PASS (3 tests).

- [ ] **Step 3: Commit**

```bash
git add mailchimp-sync/src/monday
git commit -m "feat(mailchimp-sync): add Monday client's getDonorById"
```

---

## Task 7: Outbound consumer (column mapping + batch processing)

**Files:**
- Create: `mailchimp-sync/src/consumer/mapDonor.ts`
- Create: `mailchimp-sync/src/consumer/outbound.ts`
- Test: `mailchimp-sync/src/consumer/mapDonor.test.ts`
- Test: `mailchimp-sync/src/consumer/outbound.test.ts`

**Interfaces:**
- Consumes: `DonorRecord`, `Config`, `OutboundSyncMessage` (Task 2); `MondayClient` (Task 6);
  `MailchimpClient`, `MailchimpPermanentError` (Task 3); `PendingOutboundStore` (Task 4).
- Produces: `buildMergeFields(donor, config)`, `buildTags(donor, config)`,
  `processOutboundBatch(messages, deps)`, `QueueMessageLike<T>` interface (reused in Task 12).

- [ ] **Step 1: Write the failing mapping test**

```typescript
// src/consumer/mapDonor.test.ts
import { describe, it, expect } from 'vitest';
import { buildMergeFields, buildTags } from './mapDonor';
import type { Config, DonorRecord } from '../types';

const CONFIG: Config = {
  monday: { apiUrl: '', donorsBoardId: null, campaignsBoardId: null, columns: {} as never },
  mailchimp: {
    apiBaseUrl: '', audienceId: '',
    mergeFields: {
      memberSince: 'MEMBERSINCE', memberUntil: 'MEMBERUNTIL', membershipTier: 'MTIER',
      membershipStatus: 'MSTATUS', address: 'ADDRESS', totalGiven: 'TOTALGIVE',
    },
    tags: {
      activeMember: 'active-member', lapsedMember: 'lapsed-member',
      lifetimeMember: 'lifetime-member', hasDonated: 'has-donated',
    },
  },
  lifetimeTierValue: 'Lifetime',
  activeStatusValue: 'Active',
};

function donor(overrides: Partial<DonorRecord> = {}): DonorRecord {
  return {
    id: '1', email: 'a@b.com', membershipStatus: 'Active', membershipTier: 'Standard',
    memberSince: '2026-01-01', memberUntil: '2027-01-01', addr1: '1 Main St', city: 'San Jose',
    state: 'CA', zip: '95110', totalGiven: '0', ...overrides,
  };
}

describe('buildMergeFields', () => {
  it('maps every configured merge field, bundling address into one object', () => {
    expect(buildMergeFields(donor(), CONFIG)).toEqual({
      MEMBERSINCE: '2026-01-01',
      MEMBERUNTIL: '2027-01-01',
      MTIER: 'Standard',
      MSTATUS: 'Active',
      ADDRESS: { addr1: '1 Main St', city: 'San Jose', state: 'CA', zip: '95110', country: 'US' },
      TOTALGIVE: '0',
    });
  });
});

describe('buildTags', () => {
  it('tags a Lifetime-tier donor as lifetime-member regardless of status', () => {
    expect(buildTags(donor({ membershipTier: 'Lifetime', membershipStatus: 'Lapsed' }), CONFIG))
      .toContain('lifetime-member');
  });

  it('tags an Active, non-Lifetime donor as active-member', () => {
    expect(buildTags(donor({ membershipStatus: 'Active', membershipTier: 'Standard' }), CONFIG))
      .toContain('active-member');
  });

  it('tags a non-Active, non-Lifetime donor as lapsed-member', () => {
    expect(buildTags(donor({ membershipStatus: 'Lapsed', membershipTier: 'Standard' }), CONFIG))
      .toContain('lapsed-member');
  });

  it('adds has-donated only when totalGiven is a positive number', () => {
    expect(buildTags(donor({ totalGiven: '150' }), CONFIG)).toContain('has-donated');
    expect(buildTags(donor({ totalGiven: '0' }), CONFIG)).not.toContain('has-donated');
    expect(buildTags(donor({ totalGiven: '' }), CONFIG)).not.toContain('has-donated');
  });
});
```

- [ ] **Step 2: Run to verify it fails, then write `src/consumer/mapDonor.ts`**

Run: `npm test -- src/consumer/mapDonor.test.ts` — expect FAIL (module not found).

```typescript
import type { Config, DonorRecord } from '../types';

export function buildMergeFields(donor: DonorRecord, config: Config): Record<string, unknown> {
  const fields = config.mailchimp.mergeFields;
  return {
    [fields.memberSince]: donor.memberSince,
    [fields.memberUntil]: donor.memberUntil,
    [fields.membershipTier]: donor.membershipTier,
    [fields.membershipStatus]: donor.membershipStatus,
    [fields.address]: {
      addr1: donor.addr1,
      city: donor.city,
      state: donor.state,
      zip: donor.zip,
      country: 'US',
    },
    [fields.totalGiven]: donor.totalGiven,
  };
}

export function buildTags(donor: DonorRecord, config: Config): string[] {
  const tags = config.mailchimp.tags;
  const out: string[] = [];

  if (donor.membershipTier === config.lifetimeTierValue) {
    out.push(tags.lifetimeMember);
  } else if (donor.membershipStatus === config.activeStatusValue) {
    out.push(tags.activeMember);
  } else {
    out.push(tags.lapsedMember);
  }

  const total = Number(donor.totalGiven);
  if (!Number.isNaN(total) && total > 0) {
    out.push(tags.hasDonated);
  }

  return out;
}
```

Run: `npm test -- src/consumer/mapDonor.test.ts` — expect PASS (5 tests).

- [ ] **Step 3: Write the failing consumer test**

```typescript
// src/consumer/outbound.test.ts
import { describe, it, expect, vi } from 'vitest';
import { processOutboundBatch } from './outbound';
import { MailchimpPermanentError } from '../mailchimp/client';
import type { MondayClient } from '../monday/client';
import type { MailchimpClient } from '../mailchimp/client';
import type { PendingOutboundStore } from '../db/pendingOutbound';
import type { Config, DonorRecord, OutboundSyncMessage } from '../types';

const CONFIG: Config = {
  monday: { apiUrl: '', donorsBoardId: null, campaignsBoardId: null, columns: {
    membershipStatus: 's', membershipTier: 't', memberSince: 'ms', memberUntil: 'mu',
    addr1: 'a1', city: 'c', state: 'st', zip: 'z', email: 'e', totalGiven: 'g', mailchimpCampaigns: 'mc',
  } },
  mailchimp: {
    apiBaseUrl: '', audienceId: '',
    mergeFields: { memberSince: 'MS', memberUntil: 'MU', membershipTier: 'MT', membershipStatus: 'MST', address: 'AD', totalGiven: 'TG' },
    tags: { activeMember: 'active-member', lapsedMember: 'lapsed-member', lifetimeMember: 'lifetime-member', hasDonated: 'has-donated' },
  },
  lifetimeTierValue: 'Lifetime',
  activeStatusValue: 'Active',
};

function fakeMessage(donorItemId: string): { body: OutboundSyncMessage; ack: () => void; retry: () => void } {
  return { body: { donorItemId }, ack: vi.fn(), retry: vi.fn() };
}

function donor(overrides: Partial<DonorRecord> = {}): DonorRecord {
  return {
    id: '1', email: 'a@b.com', membershipStatus: 'Active', membershipTier: 'Standard',
    memberSince: '2026-01-01', memberUntil: '', addr1: '', city: '', state: '', zip: '', totalGiven: '0',
    ...overrides,
  };
}

describe('processOutboundBatch', () => {
  it('upserts the donor to Mailchimp and acks on success', async () => {
    const message = fakeMessage('1');
    const mondayClient: MondayClient = { getDonorById: vi.fn().mockResolvedValue(donor()) };
    const mailchimpClient: MailchimpClient = {
      upsertMember: vi.fn().mockResolvedValue(undefined),
      getMemberInterests: vi.fn(), listInterests: vi.fn(),
    };
    const pendingStore: PendingOutboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn() };

    await processOutboundBatch([message], { mondayClient, mailchimpClient, pendingStore, config: CONFIG });

    expect(mailchimpClient.upsertMember).toHaveBeenCalledWith('a@b.com', expect.any(Object), expect.any(Array));
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('1', 'written', undefined, expect.any(String));
    expect(message.ack).toHaveBeenCalled();
  });

  it('skips and acks (does not call Mailchimp) when the donor has no email', async () => {
    const message = fakeMessage('2');
    const mondayClient: MondayClient = { getDonorById: vi.fn().mockResolvedValue(donor({ email: '' })) };
    const mailchimpClient: MailchimpClient = { upsertMember: vi.fn(), getMemberInterests: vi.fn(), listInterests: vi.fn() };
    const pendingStore: PendingOutboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn() };

    await processOutboundBatch([message], { mondayClient, mailchimpClient, pendingStore, config: CONFIG });

    expect(mailchimpClient.upsertMember).not.toHaveBeenCalled();
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('2', 'written', undefined, expect.any(String));
    expect(message.ack).toHaveBeenCalled();
  });

  it('skips and acks when the donor item no longer exists', async () => {
    const message = fakeMessage('3');
    const mondayClient: MondayClient = { getDonorById: vi.fn().mockResolvedValue(null) };
    const mailchimpClient: MailchimpClient = { upsertMember: vi.fn(), getMemberInterests: vi.fn(), listInterests: vi.fn() };
    const pendingStore: PendingOutboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn() };

    await processOutboundBatch([message], { mondayClient, mailchimpClient, pendingStore, config: CONFIG });

    expect(message.ack).toHaveBeenCalled();
  });

  it('retries (does not ack) on a transient Mailchimp failure', async () => {
    const message = fakeMessage('4');
    const mondayClient: MondayClient = { getDonorById: vi.fn().mockResolvedValue(donor()) };
    const mailchimpClient: MailchimpClient = {
      upsertMember: vi.fn().mockRejectedValue(new Error('rate limited')),
      getMemberInterests: vi.fn(), listInterests: vi.fn(),
    };
    const pendingStore: PendingOutboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn() };

    await processOutboundBatch([message], { mondayClient, mailchimpClient, pendingStore, config: CONFIG });

    expect(pendingStore.updateStatus).toHaveBeenCalledWith('4', 'failed', 'rate limited');
    expect(message.retry).toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('acks (does not retry) on a permanent Mailchimp failure', async () => {
    const message = fakeMessage('5');
    const mondayClient: MondayClient = { getDonorById: vi.fn().mockResolvedValue(donor()) };
    const mailchimpClient: MailchimpClient = {
      upsertMember: vi.fn().mockRejectedValue(new MailchimpPermanentError('invalid email')),
      getMemberInterests: vi.fn(), listInterests: vi.fn(),
    };
    const pendingStore: PendingOutboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn() };

    await processOutboundBatch([message], { mondayClient, mailchimpClient, pendingStore, config: CONFIG });

    expect(pendingStore.updateStatus).toHaveBeenCalledWith('5', 'failed', 'invalid email');
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run to verify it fails, then write `src/consumer/outbound.ts`**

Run: `npm test -- src/consumer/outbound.test.ts` — expect FAIL (module not found).

```typescript
import type { PendingOutboundStore } from '../db/pendingOutbound';
import type { MondayClient } from '../monday/client';
import type { MailchimpClient } from '../mailchimp/client';
import { MailchimpPermanentError } from '../mailchimp/client';
import type { Config, OutboundSyncMessage } from '../types';
import { buildMergeFields, buildTags } from './mapDonor';

export interface QueueMessageLike<T> {
  body: T;
  ack(): void;
  retry(): void;
}

export interface OutboundConsumerDeps {
  pendingStore: PendingOutboundStore;
  mondayClient: MondayClient;
  mailchimpClient: MailchimpClient;
  config: Config;
}

export async function processOutboundBatch(
  messages: QueueMessageLike<OutboundSyncMessage>[],
  deps: OutboundConsumerDeps,
): Promise<void> {
  for (const message of messages) {
    const { donorItemId } = message.body;
    try {
      await processOne(donorItemId, deps);
      message.ack();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`mailchimp-sync outbound consumer: failed to process donor "${donorItemId}": ${errMsg}`);
      await deps.pendingStore.updateStatus(donorItemId, 'failed', errMsg);
      if (err instanceof MailchimpPermanentError) {
        message.ack(); // retrying a malformed address fails identically every time
      } else {
        message.retry();
      }
    }
  }
}

async function processOne(donorItemId: string, deps: OutboundConsumerDeps): Promise<void> {
  const { mondayClient, mailchimpClient, config, pendingStore } = deps;

  const donor = await mondayClient.getDonorById(donorItemId, config.monday.columns);
  if (donor === null || donor.email === '') {
    await pendingStore.updateStatus(donorItemId, 'written', undefined, new Date().toISOString());
    return;
  }

  await mailchimpClient.upsertMember(donor.email, buildMergeFields(donor, config), buildTags(donor, config));
  await pendingStore.updateStatus(donorItemId, 'written', undefined, new Date().toISOString());
}
```

Run: `npm test -- src/consumer/outbound.test.ts` — expect PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add mailchimp-sync/src/consumer/mapDonor.ts mailchimp-sync/src/consumer/mapDonor.test.ts \
        mailchimp-sync/src/consumer/outbound.ts mailchimp-sync/src/consumer/outbound.test.ts
git commit -m "feat(mailchimp-sync): add outbound queue consumer"
```

---

## Task 8: Wire outbound into `index.ts`

**Files:**
- Create: `mailchimp-sync/src/index.ts`
- Test: `mailchimp-sync/src/index.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–7.
- Produces: the Worker's `fetch`/`queue` handlers (extended again in Tasks 10 and 13).

- [ ] **Step 1: Write the failing integration-style test**

```typescript
// src/index.test.ts
import { describe, it, expect, vi } from 'vitest';
import worker from './index';
import type { Env } from './types';

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    OUTBOUND_QUEUE: { send: vi.fn().mockResolvedValue(undefined) } as unknown as Env['OUTBOUND_QUEUE'],
    INBOUND_QUEUE: { send: vi.fn().mockResolvedValue(undefined) } as unknown as Env['INBOUND_QUEUE'],
    MONDAY_API_TOKEN: 'token',
    MAILCHIMP_API_KEY: 'key',
    ...overrides,
  };
}

describe('fetch', () => {
  it('serves /health', async () => {
    const res = await worker.fetch(
      new Request('https://worker.example/health'), fakeEnv(), {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
  });

  it('mounts the outbound Monday webhook route', async () => {
    const res = await worker.fetch(
      new Request('https://worker.example/webhooks/monday/donors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge: 'abc' }),
      }),
      fakeEnv(), {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'abc' });
  });
});
```

- [ ] **Step 2: Run to verify it fails, then write `src/index.ts`**

Run: `npm test -- src/index.test.ts` — expect FAIL (module not found).

```typescript
import { Hono } from 'hono';
import configJson from '../config/svbc.json';
import { validateConfig } from './config';
import { HttpMondayClient } from './monday/client';
import { HttpMailchimpClient } from './mailchimp/client';
import { D1PendingOutboundStore } from './db/pendingOutbound';
import { createOutboundApp } from './webhook/outboundRoute';
import { processOutboundBatch } from './consumer/outbound';
import type { Env, OutboundSyncMessage } from './types';

const config = validateConfig(configJson);

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const app = new Hono();
    app.get('/health', (c) => c.json({ ok: true }));
    app.route('/', createOutboundApp({
      pendingStore: new D1PendingOutboundStore(env.DB),
      queue: { send: (message: OutboundSyncMessage) => env.OUTBOUND_QUEUE.send(message).then(() => undefined) },
      webhookSecret: env.MONDAY_WEBHOOK_SECRET,
    }));
    return app.fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch<OutboundSyncMessage>, env: Env): Promise<void> {
    await processOutboundBatch([...batch.messages], {
      pendingStore: new D1PendingOutboundStore(env.DB),
      mondayClient: new HttpMondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN),
      mailchimpClient: new HttpMailchimpClient(config.mailchimp.apiBaseUrl, env.MAILCHIMP_API_KEY, config.mailchimp.audienceId),
      config,
    });
  },
};
```

Run: `npm test -- src/index.test.ts` — expect PASS (2 tests).

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS, all suites from Tasks 1–8 green.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (`batch.queue` is used in Task 13, not yet — this handler doesn't branch on
queue name because only one queue's consumer exists so far.)

- [ ] **Step 5: Commit**

```bash
git add mailchimp-sync/src/index.ts mailchimp-sync/src/index.test.ts
git commit -m "feat(mailchimp-sync): wire outbound sync into fetch/queue handlers

Outbound Donor -> Mailchimp sync is now end-to-end: Monday webhook ->
D1 idempotency -> Cloudflare Queue -> Mailchimp upsert."
```

---

## Task 9: Campaign catalog reconciliation

**Files:**
- Create: `mailchimp-sync/migrations/0002_create_campaign_items.sql`
- Create: `mailchimp-sync/src/db/campaignItems.ts`
- Modify: `mailchimp-sync/src/monday/client.ts` (add `createCampaignItem`, `renameItem`,
  `archiveItem`)
- Create: `mailchimp-sync/src/campaigns/reconcile.ts`
- Test: `mailchimp-sync/src/db/campaignItems.test.ts`
- Test: `mailchimp-sync/src/monday/client.test.ts` (extended)
- Test: `mailchimp-sync/src/campaigns/reconcile.test.ts`

**Interfaces:**
- Consumes: `MailchimpClient.listInterests()` (Task 3), `MailchimpInterest` (Task 2).
- Produces: `CampaignItemsStore`/`D1CampaignItemsStore`; `MondayClient.createCampaignItem`,
  `.renameItem`, `.archiveItem`; `reconcileCampaigns(deps): Promise<{ created, renamed, archived }>`
  (reused in Task 12's on-demand refresh).

- [ ] **Step 1: Add the migration**

```sql
-- Keyed on Mailchimp's stable interest_id, not name — names can be edited in
-- Mailchimp without changing identity. archived_at is set (not the row deleted) when
-- an interest disappears from Mailchimp, so a donor's historical connection to it is
-- never lost.
CREATE TABLE campaign_items (
  interest_id TEXT PRIMARY KEY,
  monday_item_id TEXT NOT NULL,
  name TEXT NOT NULL,
  archived_at TEXT
);
```

- [ ] **Step 2: Write the failing store test**

```typescript
// src/db/campaignItems.test.ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { D1CampaignItemsStore } from './campaignItems';

describe('D1CampaignItemsStore', () => {
  it('upsert then getByInterestId round-trips', async () => {
    const store = new D1CampaignItemsStore(env.DB);
    await store.upsert({ interestId: 'int1', mondayItemId: 'item1', name: 'Newsletter', archivedAt: null });

    expect(await store.getByInterestId('int1')).toEqual({
      interestId: 'int1', mondayItemId: 'item1', name: 'Newsletter', archivedAt: null,
    });
  });

  it('getByInterestId returns null for an untracked interest', async () => {
    const store = new D1CampaignItemsStore(env.DB);
    expect(await store.getByInterestId('nope')).toBeNull();
  });

  it('upsert on an existing interest_id updates name/monday_item_id in place', async () => {
    const store = new D1CampaignItemsStore(env.DB);
    await store.upsert({ interestId: 'int2', mondayItemId: 'item2', name: 'Old Name', archivedAt: null });
    await store.upsert({ interestId: 'int2', mondayItemId: 'item2', name: 'New Name', archivedAt: null });

    expect(await store.getByInterestId('int2')).toEqual({
      interestId: 'int2', mondayItemId: 'item2', name: 'New Name', archivedAt: null,
    });
  });

  it('listActive excludes archived rows', async () => {
    const store = new D1CampaignItemsStore(env.DB);
    await store.upsert({ interestId: 'int3', mondayItemId: 'item3', name: 'Active One', archivedAt: null });
    await store.upsert({ interestId: 'int4', mondayItemId: 'item4', name: 'Archived One', archivedAt: null });
    await store.markArchived('int4', '2026-08-26T00:00:00.000Z');

    const active = await store.listActive();
    expect(active.map((r) => r.interestId)).toContain('int3');
    expect(active.map((r) => r.interestId)).not.toContain('int4');
  });

  it('markArchived sets archived_at on the tracked row', async () => {
    const store = new D1CampaignItemsStore(env.DB);
    await store.upsert({ interestId: 'int5', mondayItemId: 'item5', name: 'X', archivedAt: null });
    await store.markArchived('int5', '2026-08-26T00:00:00.000Z');

    expect(await store.getByInterestId('int5')).toEqual({
      interestId: 'int5', mondayItemId: 'item5', name: 'X', archivedAt: '2026-08-26T00:00:00.000Z',
    });
  });
});
```

- [ ] **Step 3: Run to verify it fails, then write `src/db/campaignItems.ts`**

Run: `npm test -- src/db/campaignItems.test.ts` — expect FAIL (module not found).

```typescript
export interface CampaignItemRow {
  interestId: string;
  mondayItemId: string;
  name: string;
  archivedAt: string | null;
}

export interface CampaignItemsStore {
  listActive(): Promise<CampaignItemRow[]>;
  upsert(row: CampaignItemRow): Promise<void>;
  markArchived(interestId: string, archivedAt: string): Promise<void>;
  getByInterestId(interestId: string): Promise<CampaignItemRow | null>;
}

interface D1CampaignItemRecord {
  interest_id: string;
  monday_item_id: string;
  name: string;
  archived_at: string | null;
}

function toRow(record: D1CampaignItemRecord): CampaignItemRow {
  return { interestId: record.interest_id, mondayItemId: record.monday_item_id, name: record.name, archivedAt: record.archived_at };
}

export class D1CampaignItemsStore implements CampaignItemsStore {
  constructor(private db: D1Database) {}

  async listActive(): Promise<CampaignItemRow[]> {
    const { results } = await this.db
      .prepare(`SELECT interest_id, monday_item_id, name, archived_at FROM campaign_items WHERE archived_at IS NULL`)
      .all<D1CampaignItemRecord>();
    return results.map(toRow);
  }

  async upsert(row: CampaignItemRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO campaign_items (interest_id, monday_item_id, name, archived_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (interest_id) DO UPDATE SET
           monday_item_id = excluded.monday_item_id, name = excluded.name, archived_at = excluded.archived_at`,
      )
      .bind(row.interestId, row.mondayItemId, row.name, row.archivedAt)
      .run();
  }

  async markArchived(interestId: string, archivedAt: string): Promise<void> {
    await this.db
      .prepare(`UPDATE campaign_items SET archived_at = ?2 WHERE interest_id = ?1`)
      .bind(interestId, archivedAt)
      .run();
  }

  async getByInterestId(interestId: string): Promise<CampaignItemRow | null> {
    const record = await this.db
      .prepare(`SELECT interest_id, monday_item_id, name, archived_at FROM campaign_items WHERE interest_id = ?1`)
      .bind(interestId)
      .first<D1CampaignItemRecord>();
    return record === null ? null : toRow(record);
  }
}
```

Run: `npm test -- src/db/campaignItems.test.ts` — expect PASS (5 tests).

- [ ] **Step 4: Extend the Monday client test, then the client, with item create/rename/archive**

Add to `src/monday/client.test.ts`:

```typescript
describe('HttpMondayClient.createCampaignItem', () => {
  it('returns the new item id', async () => {
    const fetchFn = fakeFetch({ create_item: { id: 'new-item' } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', fetchFn);
    expect(await client.createCampaignItem(123, 'Newsletter')).toBe('new-item');
  });
});

describe('HttpMondayClient.renameItem', () => {
  it('sends the new name via the "name" pseudo-column', async () => {
    const fetchFn = fakeFetch({ change_simple_column_value: { id: 'item1' } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', fetchFn);
    await client.renameItem(123, 'item1', 'New Name');
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.monday.com/v2',
      expect.objectContaining({ body: expect.stringContaining('"name":"New Name"') }),
    );
  });
});

describe('HttpMondayClient.archiveItem', () => {
  it('archives the given item id', async () => {
    const fetchFn = fakeFetch({ archive_item: { id: 'item1' } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', fetchFn);
    await client.archiveItem('item1');
    expect(fetchFn).toHaveBeenCalled();
  });
});
```

Run: `npm test -- src/monday/client.test.ts` — expect FAIL (methods don't exist).

Add to the `MondayClient` interface and `HttpMondayClient` class in `src/monday/client.ts`:

```typescript
// Add to the MondayClient interface:
  createCampaignItem(boardId: number, name: string): Promise<string>;
  renameItem(boardId: number, itemId: string, name: string): Promise<void>;
  archiveItem(itemId: string): Promise<void>;
```

```typescript
// Add to the HttpMondayClient class:
  async createCampaignItem(boardId: number, name: string): Promise<string> {
    const data = await this.graphql<{ create_item: { id: string } }>(
      `mutation ($boardId: ID!, $name: String!) {
        create_item(board_id: $boardId, item_name: $name) { id }
      }`,
      { boardId, name },
    );
    return data.create_item.id;
  }

  // Monday's item name isn't editable via a normal column mutation, but the item
  // schema treats "name" itself as a simple-value column with id "name" — a
  // documented, commonly-used trick, not a real user-defined column. Verify against
  // Monday's current API docs if this ever starts failing.
  async renameItem(boardId: number, itemId: string, name: string): Promise<void> {
    await this.graphql(
      `mutation ($boardId: ID!, $itemId: ID!, $name: String!) {
        change_simple_column_value(board_id: $boardId, item_id: $itemId, column_id: "name", value: $name) { id }
      }`,
      { boardId, itemId, name },
    );
  }

  async archiveItem(itemId: string): Promise<void> {
    await this.graphql(
      `mutation ($itemId: ID!) { archive_item(item_id: $itemId) { id } }`,
      { itemId },
    );
  }
```

Run: `npm test -- src/monday/client.test.ts` — expect PASS (6 tests).

- [ ] **Step 5: Write the failing reconciliation test**

```typescript
// src/campaigns/reconcile.test.ts
import { describe, it, expect, vi } from 'vitest';
import { reconcileCampaigns } from './reconcile';
import type { MailchimpClient } from '../mailchimp/client';
import type { MondayClient } from '../monday/client';
import type { CampaignItemsStore } from '../db/campaignItems';
import type { Config } from '../types';

const CONFIG: Config = {
  monday: { apiUrl: '', donorsBoardId: null, campaignsBoardId: 999, columns: {} as never },
  mailchimp: { apiBaseUrl: '', audienceId: '', mergeFields: {} as never, tags: {} as never },
  lifetimeTierValue: 'Lifetime', activeStatusValue: 'Active',
};

function fakeCampaignItemsStore(rows: { interestId: string; mondayItemId: string; name: string; archivedAt: string | null }[] = []): CampaignItemsStore {
  return {
    listActive: vi.fn().mockResolvedValue(rows.filter((r) => r.archivedAt === null)),
    upsert: vi.fn().mockResolvedValue(undefined),
    markArchived: vi.fn().mockResolvedValue(undefined),
    getByInterestId: vi.fn().mockImplementation(async (id: string) => rows.find((r) => r.interestId === id) ?? null),
  };
}

describe('reconcileCampaigns', () => {
  it('creates a Monday item for a new Mailchimp interest', async () => {
    const mailchimpClient: MailchimpClient = {
      listInterests: vi.fn().mockResolvedValue([{ categoryId: 'cat1', interestId: 'int1', name: 'Newsletter' }]),
      upsertMember: vi.fn(), getMemberInterests: vi.fn(),
    };
    const mondayClient: MondayClient = {
      createCampaignItem: vi.fn().mockResolvedValue('item1'),
      renameItem: vi.fn(), archiveItem: vi.fn(), getDonorById: vi.fn(),
    };
    const campaignItemsStore = fakeCampaignItemsStore();

    const result = await reconcileCampaigns({ mailchimpClient, mondayClient, campaignItemsStore, config: CONFIG });

    expect(mondayClient.createCampaignItem).toHaveBeenCalledWith(999, 'Newsletter');
    expect(campaignItemsStore.upsert).toHaveBeenCalledWith({ interestId: 'int1', mondayItemId: 'item1', name: 'Newsletter', archivedAt: null });
    expect(result).toEqual({ created: 1, renamed: 0, archived: 0 });
  });

  it('renames the Monday item when a tracked interest is renamed in Mailchimp', async () => {
    const mailchimpClient: MailchimpClient = {
      listInterests: vi.fn().mockResolvedValue([{ categoryId: 'cat1', interestId: 'int1', name: 'New Name' }]),
      upsertMember: vi.fn(), getMemberInterests: vi.fn(),
    };
    const mondayClient: MondayClient = {
      createCampaignItem: vi.fn(), renameItem: vi.fn().mockResolvedValue(undefined),
      archiveItem: vi.fn(), getDonorById: vi.fn(),
    };
    const campaignItemsStore = fakeCampaignItemsStore([{ interestId: 'int1', mondayItemId: 'item1', name: 'Old Name', archivedAt: null }]);

    const result = await reconcileCampaigns({ mailchimpClient, mondayClient, campaignItemsStore, config: CONFIG });

    expect(mondayClient.renameItem).toHaveBeenCalledWith(999, 'item1', 'New Name');
    expect(mondayClient.createCampaignItem).not.toHaveBeenCalled();
    expect(result).toEqual({ created: 0, renamed: 1, archived: 0 });
  });

  it('archives a tracked Monday item whose interest no longer exists in Mailchimp', async () => {
    const mailchimpClient: MailchimpClient = { listInterests: vi.fn().mockResolvedValue([]), upsertMember: vi.fn(), getMemberInterests: vi.fn() };
    const mondayClient: MondayClient = {
      createCampaignItem: vi.fn(), renameItem: vi.fn(), archiveItem: vi.fn().mockResolvedValue(undefined),
      getDonorById: vi.fn(),
    };
    const campaignItemsStore = fakeCampaignItemsStore([{ interestId: 'int1', mondayItemId: 'item1', name: 'Gone', archivedAt: null }]);

    const result = await reconcileCampaigns({ mailchimpClient, mondayClient, campaignItemsStore, config: CONFIG });

    expect(mondayClient.archiveItem).toHaveBeenCalledWith('item1');
    expect(campaignItemsStore.markArchived).toHaveBeenCalledWith('int1', expect.any(String));
    expect(result).toEqual({ created: 0, renamed: 0, archived: 1 });
  });

  it('leaves an unchanged, still-present interest alone', async () => {
    const mailchimpClient: MailchimpClient = {
      listInterests: vi.fn().mockResolvedValue([{ categoryId: 'cat1', interestId: 'int1', name: 'Same' }]),
      upsertMember: vi.fn(), getMemberInterests: vi.fn(),
    };
    const mondayClient: MondayClient = {
      createCampaignItem: vi.fn(), renameItem: vi.fn(), archiveItem: vi.fn(),
      getDonorById: vi.fn(),
    };
    const campaignItemsStore = fakeCampaignItemsStore([{ interestId: 'int1', mondayItemId: 'item1', name: 'Same', archivedAt: null }]);

    const result = await reconcileCampaigns({ mailchimpClient, mondayClient, campaignItemsStore, config: CONFIG });

    expect(mondayClient.createCampaignItem).not.toHaveBeenCalled();
    expect(mondayClient.renameItem).not.toHaveBeenCalled();
    expect(mondayClient.archiveItem).not.toHaveBeenCalled();
    expect(result).toEqual({ created: 0, renamed: 0, archived: 0 });
  });

  it('throws if campaignsBoardId is not configured', async () => {
    const config: Config = { ...CONFIG, monday: { ...CONFIG.monday, campaignsBoardId: null } };
    const mailchimpClient: MailchimpClient = { listInterests: vi.fn(), upsertMember: vi.fn(), getMemberInterests: vi.fn() };
    const mondayClient: MondayClient = {
      createCampaignItem: vi.fn(), renameItem: vi.fn(), archiveItem: vi.fn(),
      getDonorById: vi.fn(),
    };
    await expect(reconcileCampaigns({ mailchimpClient, mondayClient, campaignItemsStore: fakeCampaignItemsStore(), config }))
      .rejects.toThrow('monday.campaignsBoardId must be set');
  });
});
```

- [ ] **Step 6: Run to verify it fails, then write `src/campaigns/reconcile.ts`**

Run: `npm test -- src/campaigns/reconcile.test.ts` — expect FAIL (module not found). Note that
`reconcileCampaigns` only ever calls `getDonorById`/`createCampaignItem`/`renameItem`/`archiveItem`
on `MondayClient` — it has no reason to touch `findItemIdByEmail`/`setConnectColumn` (those belong
to the inbound consumer, added to the interface in Task 12), so this task's `MondayClient` fakes
deliberately don't include them.

```typescript
// src/campaigns/reconcile.ts
import type { MailchimpClient } from '../mailchimp/client';
import type { MondayClient } from '../monday/client';
import type { CampaignItemsStore } from '../db/campaignItems';
import type { Config } from '../types';

export interface ReconcileDeps {
  mailchimpClient: MailchimpClient;
  mondayClient: MondayClient;
  campaignItemsStore: CampaignItemsStore;
  config: Config;
}

export interface ReconcileResult {
  created: number;
  renamed: number;
  archived: number;
}

export async function reconcileCampaigns(deps: ReconcileDeps): Promise<ReconcileResult> {
  const { mailchimpClient, mondayClient, campaignItemsStore, config } = deps;
  const boardId = config.monday.campaignsBoardId;
  if (boardId === null) {
    throw new Error('config: monday.campaignsBoardId must be set before reconciliation can run');
  }

  const interests = await mailchimpClient.listInterests();
  const trackedById = new Map((await campaignItemsStore.listActive()).map((row) => [row.interestId, row]));

  let created = 0;
  let renamed = 0;
  for (const interest of interests) {
    const existing = trackedById.get(interest.interestId);
    if (existing === undefined) {
      const itemId = await mondayClient.createCampaignItem(boardId, interest.name);
      await campaignItemsStore.upsert({ interestId: interest.interestId, mondayItemId: itemId, name: interest.name, archivedAt: null });
      created++;
    } else if (existing.name !== interest.name) {
      await mondayClient.renameItem(boardId, existing.mondayItemId, interest.name);
      await campaignItemsStore.upsert({ interestId: interest.interestId, mondayItemId: existing.mondayItemId, name: interest.name, archivedAt: null });
      renamed++;
    }
    trackedById.delete(interest.interestId);
  }

  let archived = 0;
  for (const stale of trackedById.values()) {
    await mondayClient.archiveItem(stale.mondayItemId);
    await campaignItemsStore.markArchived(stale.interestId, new Date().toISOString());
    archived++;
  }

  return { created, renamed, archived };
}
```

Run: `npm test -- src/campaigns/reconcile.test.ts` — expect PASS (5 tests).

- [ ] **Step 7: Update `outbound.test.ts`'s `MondayClient` fakes for the grown interface, then
  run the full suite and typecheck**

`src/monday/client.ts`'s `MondayClient` interface just gained three methods
(`createCampaignItem`, `renameItem`, `archiveItem`). `src/consumer/outbound.test.ts` (Task 7)
builds `MondayClient` object literals with only `getDonorById` — TypeScript now rejects those as
missing members. Add stubs for the three new methods to every `mondayClient: MondayClient = { ... }`
literal in that file, e.g.:

```typescript
const mondayClient: MondayClient = {
  getDonorById: vi.fn().mockResolvedValue(donor()),
  createCampaignItem: vi.fn(), renameItem: vi.fn(), archiveItem: vi.fn(),
};
```

(`src/index.ts`/`index.test.ts` are unaffected — they use the real `HttpMondayClient`, never a
hand-built `MondayClient` literal.)

Run: `npm test && npm run typecheck`
Expected: all suites PASS; typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add mailchimp-sync/migrations/0002_create_campaign_items.sql mailchimp-sync/src/db/campaignItems.ts \
        mailchimp-sync/src/db/campaignItems.test.ts mailchimp-sync/src/monday/client.ts \
        mailchimp-sync/src/monday/client.test.ts mailchimp-sync/src/campaigns/reconcile.ts \
        mailchimp-sync/src/campaigns/reconcile.test.ts mailchimp-sync/src/consumer/outbound.test.ts \
        mailchimp-sync/src/index.test.ts
git commit -m "feat(mailchimp-sync): add Campaigns board reconciliation

Daily-cron-shaped (wired in the next task): diffs Mailchimp's Interest
Categories against a D1-tracked set of Monday items, creating,
renaming, or archiving as needed. Archives rather than deletes so a
donor's historical connection to a retired campaign isn't lost."
```

---

## Task 10: Wire reconciliation into the scheduled handler

**Files:**
- Modify: `mailchimp-sync/src/index.ts`
- Modify: `mailchimp-sync/src/index.test.ts`

**Interfaces:**
- Consumes: `reconcileCampaigns` (Task 9).
- Produces: the Worker's `scheduled` handler.

- [ ] **Step 1: Write the failing test**

Add to `src/index.test.ts`:

```typescript
describe('scheduled', () => {
  it('runs reconcileCampaigns and does not throw when it fails', async () => {
    const env = fakeEnv();
    const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    // No throw expected even though config.monday.campaignsBoardId is null in the
    // placeholder config/svbc.json — reconcileCampaigns's own rejection is caught
    // inside scheduled(), not propagated.
    await expect(worker.scheduled({} as ScheduledEvent, env, ctx)).resolves.toBeUndefined();
    expect(ctx.waitUntil).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails, then update `src/index.ts`**

Run: `npm test -- src/index.test.ts` — expect FAIL (`worker.scheduled` is not a function).

Add to `src/index.ts`'s existing import block — `HttpMailchimpClient` is already imported from
Task 8, do not add a second `import` line for it, only these two new ones:

```typescript
import { D1CampaignItemsStore } from './db/campaignItems';
import { reconcileCampaigns } from './campaigns/reconcile';
```

```typescript
// Add to the default export object, alongside fetch/queue:
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      reconcileCampaigns({
        mailchimpClient: new HttpMailchimpClient(config.mailchimp.apiBaseUrl, env.MAILCHIMP_API_KEY, config.mailchimp.audienceId),
        mondayClient: new HttpMondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN),
        campaignItemsStore: new D1CampaignItemsStore(env.DB),
        config,
      })
        .then((result) => console.log(`mailchimp-sync reconcile: created ${result.created}, renamed ${result.renamed}, archived ${result.archived}`))
        .catch((err) => console.error(`mailchimp-sync reconcile: run failed: ${(err as Error).message}`)),
    );
  },
```

Run: `npm test -- src/index.test.ts` — expect PASS (3 tests).

- [ ] **Step 3: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add mailchimp-sync/src/index.ts mailchimp-sync/src/index.test.ts
git commit -m "feat(mailchimp-sync): wire Campaigns reconciliation into the daily cron"
```

---

## Task 11: Inbound D1 migration + pending store + Mailchimp webhook

**Files:**
- Create: `mailchimp-sync/migrations/0003_create_pending_inbound_syncs.sql`
- Create: `mailchimp-sync/src/db/pendingInbound.ts`
- Create: `mailchimp-sync/src/webhook/validateMailchimp.ts`
- Create: `mailchimp-sync/src/webhook/inboundRoute.ts`
- Test: `mailchimp-sync/src/db/pendingInbound.test.ts`
- Test: `mailchimp-sync/src/webhook/validateMailchimp.test.ts`
- Test: `mailchimp-sync/src/webhook/inboundRoute.test.ts`

**Interfaces:**
- Produces: `PendingInboundStore`/`D1PendingInboundStore`, `validateMailchimpWebhookBody(params)`,
  `createInboundApp(deps): Hono`, `InboundQueueLike`.

- [ ] **Step 1: Add the migration**

```sql
-- Keyed on the contact's email — Mailchimp's webhook payloads identify a contact by
-- email, not a stable internal id, in the classic Marketing webhook format.
CREATE TABLE pending_inbound_syncs (
  email TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'received', -- received -> queued -> written | failed
  error TEXT,
  received_at TEXT NOT NULL,
  written_at TEXT
);
```

- [ ] **Step 2: Write the failing pending-store test (mirrors Task 4's, keyed on email)**

```typescript
// src/db/pendingInbound.test.ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { D1PendingInboundStore } from './pendingInbound';

describe('D1PendingInboundStore', () => {
  it('inserts a new pending row as received', async () => {
    const store = new D1PendingInboundStore(env.DB);
    await store.upsertPending('a@b.com', '2026-08-26T00:00:00.000Z');

    const row = await env.DB.prepare(`SELECT * FROM pending_inbound_syncs WHERE email = ?1`)
      .bind('a@b.com').first<{ status: string }>();
    expect(row?.status).toBe('received');
  });

  it('a redelivery resets status to received and clears the prior error', async () => {
    const store = new D1PendingInboundStore(env.DB);
    await store.upsertPending('c@d.com', '2026-08-26T00:00:00.000Z');
    await store.updateStatus('c@d.com', 'failed', 'boom');

    await store.upsertPending('c@d.com', '2026-08-26T01:00:00.000Z');

    const row = await env.DB.prepare(`SELECT * FROM pending_inbound_syncs WHERE email = ?1`)
      .bind('c@d.com').first<{ status: string; error: string | null }>();
    expect(row).toEqual(expect.objectContaining({ status: 'received', error: null }));
  });

  it('updateStatus records written_at when provided', async () => {
    const store = new D1PendingInboundStore(env.DB);
    await store.upsertPending('e@f.com', '2026-08-26T00:00:00.000Z');
    await store.updateStatus('e@f.com', 'written', undefined, '2026-08-26T02:00:00.000Z');

    const row = await env.DB.prepare(`SELECT * FROM pending_inbound_syncs WHERE email = ?1`)
      .bind('e@f.com').first<{ status: string; written_at: string | null }>();
    expect(row).toEqual(expect.objectContaining({ status: 'written', written_at: '2026-08-26T02:00:00.000Z' }));
  });
});
```

- [ ] **Step 3: Run to verify it fails, then write `src/db/pendingInbound.ts`** (identical shape to
`pendingOutbound.ts`, keyed on `email` instead of `donor_item_id`)

Run: `npm test -- src/db/pendingInbound.test.ts` — expect FAIL (module not found).

```typescript
import type { PendingStatus } from '../types';

export interface PendingInboundStore {
  upsertPending(email: string, receivedAt: string): Promise<void>;
  updateStatus(email: string, status: PendingStatus, error?: string, writtenAt?: string): Promise<void>;
}

export class D1PendingInboundStore implements PendingInboundStore {
  constructor(private db: D1Database) {}

  async upsertPending(email: string, receivedAt: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO pending_inbound_syncs (email, status, received_at)
         VALUES (?1, 'received', ?2)
         ON CONFLICT (email) DO UPDATE SET
           status = 'received', error = NULL, received_at = excluded.received_at`,
      )
      .bind(email, receivedAt)
      .run();
  }

  async updateStatus(email: string, status: PendingStatus, error?: string, writtenAt?: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE pending_inbound_syncs SET
           status = ?2, error = ?3, written_at = COALESCE(?4, written_at)
         WHERE email = ?1`,
      )
      .bind(email, status, error ?? null, writtenAt ?? null)
      .run();
  }
}
```

Run: `npm test -- src/db/pendingInbound.test.ts` — expect PASS (3 tests).

- [ ] **Step 4: Write the failing validator test**

```typescript
// src/webhook/validateMailchimp.test.ts
import { describe, it, expect } from 'vitest';
import { validateMailchimpWebhookBody } from './validateMailchimp';

describe('validateMailchimpWebhookBody', () => {
  it('extracts the email from a valid unsubscribe event', () => {
    const params = new URLSearchParams({ type: 'unsubscribe', 'data[email]': 'a@b.com' });
    expect(validateMailchimpWebhookBody(params)).toEqual({ email: 'a@b.com' });
  });

  it('rejects a body with no type field', () => {
    const params = new URLSearchParams({ 'data[email]': 'a@b.com' });
    expect(() => validateMailchimpWebhookBody(params)).toThrow('webhook body has no "type" field');
  });

  it('rejects a body with no email field', () => {
    const params = new URLSearchParams({ type: 'profile' });
    expect(() => validateMailchimpWebhookBody(params)).toThrow('webhook body has no "data[email]" field');
  });
});
```

- [ ] **Step 5: Run to verify it fails, then write `src/webhook/validateMailchimp.ts`**

Run: `npm test -- src/webhook/validateMailchimp.test.ts` — expect FAIL (module not found).

```typescript
export interface MailchimpContactEvent {
  email: string;
}

// Mailchimp Marketing webhooks POST application/x-www-form-urlencoded, not JSON, with
// fields like type=unsubscribe&data[email]=... — see
// https://mailchimp.com/developer/marketing/guides/sync-audience-data-webhooks/.
export function validateMailchimpWebhookBody(formData: URLSearchParams): MailchimpContactEvent {
  if (formData.get('type') === null) {
    throw new Error('webhook body has no "type" field');
  }
  const email = formData.get('data[email]');
  if (email === null || email === '') {
    throw new Error('webhook body has no "data[email]" field');
  }
  return { email };
}
```

Run: `npm test -- src/webhook/validateMailchimp.test.ts` — expect PASS (3 tests).

- [ ] **Step 6: Write the failing route test**

```typescript
// src/webhook/inboundRoute.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createInboundApp } from './inboundRoute';
import type { PendingInboundStore } from '../db/pendingInbound';

function fakePendingStore(overrides: Partial<PendingInboundStore> = {}): PendingInboundStore {
  return { upsertPending: vi.fn().mockResolvedValue(undefined), updateStatus: vi.fn().mockResolvedValue(undefined), ...overrides };
}

function postForm(app: ReturnType<typeof createInboundApp>, fields: Record<string, string>, query = '') {
  const body = new URLSearchParams(fields);
  return app.request(`/webhooks/mailchimp/audience${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
}

describe('GET /webhooks/mailchimp/audience', () => {
  it('responds 200 to Mailchimp\'s configuration-time ping', async () => {
    const app = createInboundApp({ pendingStore: fakePendingStore(), queue: { send: vi.fn() } });
    const res = await app.request('/webhooks/mailchimp/audience');
    expect(res.status).toBe(200);
  });
});

describe('webhook secret', () => {
  it('rejects a request missing the configured secret with 401', async () => {
    const send = vi.fn();
    const app = createInboundApp({ pendingStore: fakePendingStore(), queue: { send }, webhookSecret: 'shh' });
    const res = await postForm(app, { type: 'unsubscribe', 'data[email]': 'a@b.com' });
    expect(res.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('POST /webhooks/mailchimp/audience', () => {
  it('upserts and enqueues a valid event, keyed on email', async () => {
    const pendingStore = fakePendingStore();
    const send = vi.fn().mockResolvedValue(undefined);
    const app = createInboundApp({ pendingStore, queue: { send } });

    const res = await postForm(app, { type: 'profile', 'data[email]': 'a@b.com' });

    expect(res.status).toBe(200);
    expect(pendingStore.upsertPending).toHaveBeenCalledWith('a@b.com', expect.any(String));
    expect(send).toHaveBeenCalledWith({ email: 'a@b.com' });
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('a@b.com', 'queued');
  });

  it('rejects a malformed event with 200 and does not enqueue', async () => {
    const send = vi.fn();
    const app = createInboundApp({ pendingStore: fakePendingStore(), queue: { send } });
    const res = await postForm(app, { type: 'profile' }); // no email
    expect(res.status).toBe(200);
    expect(send).not.toHaveBeenCalled();
  });

  it('returns 500 and marks failed when enqueue throws', async () => {
    const pendingStore = fakePendingStore();
    const send = vi.fn().mockRejectedValue(new Error('queue down'));
    const app = createInboundApp({ pendingStore, queue: { send } });

    const res = await postForm(app, { type: 'unsubscribe', 'data[email]': 'a@b.com' });

    expect(res.status).toBe(500);
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('a@b.com', 'failed', 'queue down');
  });
});
```

- [ ] **Step 7: Run to verify it fails, then write `src/webhook/inboundRoute.ts`**

Run: `npm test -- src/webhook/inboundRoute.test.ts` — expect FAIL (module not found).

```typescript
import { Hono } from 'hono';
import type { PendingInboundStore } from '../db/pendingInbound';
import { validateMailchimpWebhookBody } from './validateMailchimp';
import type { InboundSyncMessage } from '../types';

export interface InboundQueueLike {
  send(message: InboundSyncMessage): Promise<void>;
}

export interface InboundAppDeps {
  pendingStore: PendingInboundStore;
  queue: InboundQueueLike;
  // Mailchimp Marketing webhooks aren't cryptographically signed either — same
  // shared-secret-in-URL convention as the Monday side.
  webhookSecret?: string;
}

export function createInboundApp(deps: InboundAppDeps) {
  const app = new Hono();

  // Mailchimp pings the webhook URL with GET when it's first configured, expecting 200.
  app.get('/webhooks/mailchimp/audience', (c) => c.json({ ok: true }));

  app.post('/webhooks/mailchimp/audience', async (c) => {
    if (deps.webhookSecret && c.req.query('secret') !== deps.webhookSecret) {
      return c.json({ ok: false }, 401);
    }

    let params: URLSearchParams;
    try {
      const formData = await c.req.formData();
      params = new URLSearchParams();
      for (const [key, value] of formData.entries()) {
        if (typeof value === 'string') params.append(key, value);
      }
    } catch {
      return c.json({ ok: false, error: 'invalid form body' }, 200);
    }

    let contactEvent;
    try {
      contactEvent = validateMailchimpWebhookBody(params);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`mailchimp-sync inbound webhook: rejected delivery: ${errMsg}`);
      return c.json({ ok: false, error: errMsg }, 200);
    }

    await deps.pendingStore.upsertPending(contactEvent.email, new Date().toISOString());

    try {
      await deps.queue.send({ email: contactEvent.email });
      await deps.pendingStore.updateStatus(contactEvent.email, 'queued');
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`mailchimp-sync inbound webhook: enqueue failed for "${contactEvent.email}": ${errMsg}`);
      await deps.pendingStore.updateStatus(contactEvent.email, 'failed', errMsg);
      return c.json({ ok: false }, 500);
    }

    return c.json({ ok: true }, 200);
  });

  return app;
}
```

Run: `npm test -- src/webhook/inboundRoute.test.ts` — expect PASS (5 tests).

- [ ] **Step 8: Commit**

```bash
git add mailchimp-sync/migrations/0003_create_pending_inbound_syncs.sql mailchimp-sync/src/db/pendingInbound.ts \
        mailchimp-sync/src/db/pendingInbound.test.ts mailchimp-sync/src/webhook/validateMailchimp.ts \
        mailchimp-sync/src/webhook/validateMailchimp.test.ts mailchimp-sync/src/webhook/inboundRoute.ts \
        mailchimp-sync/src/webhook/inboundRoute.test.ts
git commit -m "feat(mailchimp-sync): add inbound Mailchimp webhook ingestion"
```

---

## Task 12: Inbound reads + consumer

**Files:**
- Modify: `mailchimp-sync/src/mailchimp/client.ts` (already has `getMemberInterests` from Task 3 —
  no change needed there)
- Modify: `mailchimp-sync/src/monday/client.ts` (add `findItemIdByEmail`, `setConnectColumn` to the
  `MondayClient` interface and implement both — this is the first task that needs them)
- Modify: `mailchimp-sync/src/consumer/outbound.test.ts`, `mailchimp-sync/src/campaigns/reconcile.test.ts`
  (their `MondayClient` fakes need two more stubs now that the interface has grown again)
- Create: `mailchimp-sync/src/consumer/inbound.ts`
- Test: `mailchimp-sync/src/monday/client.test.ts` (extended)
- Test: `mailchimp-sync/src/consumer/inbound.test.ts`

**Interfaces:**
- Consumes: `MailchimpClient.getMemberInterests` (Task 3), `CampaignItemsStore` (Task 9),
  `reconcileCampaigns` (Task 9), `PendingInboundStore` (Task 11), `QueueMessageLike<T>` (Task 7).
- Produces: `MondayClient.findItemIdByEmail`, `.setConnectColumn` implementations;
  `processInboundBatch(messages, deps)`.

- [ ] **Step 1: Extend the Monday client test with the two remaining methods**

Add to `src/monday/client.test.ts`:

```typescript
describe('HttpMondayClient.findItemIdByEmail', () => {
  it('returns the matching item id', async () => {
    const fetchFn = fakeFetch({ items_page_by_column_values: { items: [{ id: '42' }] } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', fetchFn);
    expect(await client.findItemIdByEmail(123, 'email', 'a@b.com')).toBe('42');
  });

  it('returns null when no item matches', async () => {
    const fetchFn = fakeFetch({ items_page_by_column_values: { items: [] } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', fetchFn);
    expect(await client.findItemIdByEmail(123, 'email', 'nobody@b.com')).toBeNull();
  });
});

describe('HttpMondayClient.setConnectColumn', () => {
  it('writes the full linked-item-ids set as JSON', async () => {
    const fetchFn = fakeFetch({ change_column_value: { id: '42' } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', fetchFn);
    await client.setConnectColumn(123, '42', 'campaigns', ['1', '2']);
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.monday.com/v2',
      expect.objectContaining({ body: expect.stringContaining('"item_ids\\":[1,2]') }),
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails, then implement both methods**

Run: `npm test -- src/monday/client.test.ts` — expect FAIL (methods don't exist).

Add to the `MondayClient` interface in `src/monday/client.ts`:

```typescript
  findItemIdByEmail(boardId: number, emailColumnId: string, email: string): Promise<string | null>;
  setConnectColumn(boardId: number, itemId: string, columnId: string, linkedItemIds: string[]): Promise<void>;
```

Add to `HttpMondayClient` in `src/monday/client.ts`:

```typescript
  // Text-column filtering is supported by Monday's API — donation-rollups hit a wall
  // specifically with board_relation columns, not plain text ones, so this is safe.
  async findItemIdByEmail(boardId: number, emailColumnId: string, email: string): Promise<string | null> {
    const data = await this.graphql<{ items_page_by_column_values: { items: { id: string }[] } }>(
      `query ($boardId: ID!, $columnId: String!, $email: [String!]) {
        items_page_by_column_values(board_id: $boardId, columns: [{ column_id: $columnId, column_values: $email }], limit: 1) {
          items { id }
        }
      }`,
      { boardId, columnId: emailColumnId, email: [email] },
    );
    return data.items_page_by_column_values.items[0]?.id ?? null;
  }

  // Writes the *full current set* of linked items, not a diff — same
  // recompute-the-whole-thing philosophy as donation-rollups' rollup writes. Simpler
  // and self-healing; cheap at the scale of one donor's campaign memberships.
  async setConnectColumn(boardId: number, itemId: string, columnId: string, linkedItemIds: string[]): Promise<void> {
    await this.graphql(
      `mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
        change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id }
      }`,
      { boardId, itemId, columnId, value: JSON.stringify({ item_ids: linkedItemIds.map(Number) }) },
    );
  }
```

Run: `npm test -- src/monday/client.test.ts` — expect PASS (9 tests).

- [ ] **Step 2b: Update the two other files with hand-built `MondayClient` fakes for the grown interface**

The interface just gained `findItemIdByEmail`/`setConnectColumn`. Two existing test files build
`MondayClient` object literals and now need stubs for them too, or `npm run typecheck` fails:

In `src/consumer/outbound.test.ts`, add to the `mondayClient: MondayClient = { ... }` literal:

```typescript
findItemIdByEmail: vi.fn(), setConnectColumn: vi.fn(),
```

In `src/campaigns/reconcile.test.ts`, add the same two stubs to each of the five
`mondayClient: MondayClient = { ... }` literals (one per `it(...)` block).

Run: `npm test && npm run typecheck`
Expected: both suites still PASS; typecheck clean.

- [ ] **Step 3: Write the failing inbound consumer test**

```typescript
// src/consumer/inbound.test.ts
import { describe, it, expect, vi } from 'vitest';
import { processInboundBatch } from './inbound';
import type { MondayClient } from '../monday/client';
import type { MailchimpClient } from '../mailchimp/client';
import type { CampaignItemsStore, CampaignItemRow } from '../db/campaignItems';
import type { PendingInboundStore } from '../db/pendingInbound';
import type { Config, InboundSyncMessage } from '../types';

const CONFIG: Config = {
  monday: { apiUrl: '', donorsBoardId: 111, campaignsBoardId: 999, columns: {
    membershipStatus: 's', membershipTier: 't', memberSince: 'ms', memberUntil: 'mu',
    addr1: 'a1', city: 'c', state: 'st', zip: 'z', email: 'e', totalGiven: 'g', mailchimpCampaigns: 'mc',
  } },
  mailchimp: { apiBaseUrl: '', audienceId: '', mergeFields: {} as never, tags: {} as never },
  lifetimeTierValue: 'Lifetime', activeStatusValue: 'Active',
};

function fakeMessage(email: string): { body: InboundSyncMessage; ack: () => void; retry: () => void } {
  return { body: { email }, ack: vi.fn(), retry: vi.fn() };
}

function fakeMonday(overrides: Partial<MondayClient> = {}): MondayClient {
  return {
    getDonorById: vi.fn(), createCampaignItem: vi.fn(), renameItem: vi.fn(), archiveItem: vi.fn(),
    findItemIdByEmail: vi.fn().mockResolvedValue('donor-1'),
    setConnectColumn: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function fakeMailchimp(overrides: Partial<MailchimpClient> = {}): MailchimpClient {
  return {
    upsertMember: vi.fn(),
    getMemberInterests: vi.fn().mockResolvedValue({ status: 'subscribed', interests: { int1: true, int2: false } }),
    listInterests: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function fakeCampaignItemsStore(rows: CampaignItemRow[] = []): CampaignItemsStore {
  return {
    listActive: vi.fn().mockResolvedValue(rows),
    upsert: vi.fn().mockResolvedValue(undefined),
    markArchived: vi.fn().mockResolvedValue(undefined),
    getByInterestId: vi.fn().mockImplementation(async (id: string) => rows.find((r) => r.interestId === id) ?? null),
  };
}

describe('processInboundBatch', () => {
  it('writes only the subscribed interests\' Monday item ids to the connect column', async () => {
    const message = fakeMessage('a@b.com');
    const mondayClient = fakeMonday();
    const campaignItemsStore = fakeCampaignItemsStore([
      { interestId: 'int1', mondayItemId: 'campaign-1', name: 'Newsletter', archivedAt: null },
      { interestId: 'int2', mondayItemId: 'campaign-2', name: 'Welcome Drip', archivedAt: null },
    ]);
    const pendingStore: PendingInboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn() };

    await processInboundBatch([message], {
      mondayClient, mailchimpClient: fakeMailchimp(), campaignItemsStore, pendingStore, config: CONFIG,
    });

    // int1 is subscribed (true), int2 is not (false) — only campaign-1 gets written.
    expect(mondayClient.setConnectColumn).toHaveBeenCalledWith(111, 'donor-1', 'mc', ['campaign-1']);
    expect(message.ack).toHaveBeenCalled();
  });

  it('skips and acks when the contact no longer exists in Mailchimp', async () => {
    const message = fakeMessage('gone@b.com');
    const mondayClient = fakeMonday();
    const pendingStore: PendingInboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn() };

    await processInboundBatch([message], {
      mondayClient, mailchimpClient: fakeMailchimp({ getMemberInterests: vi.fn().mockResolvedValue(null) }),
      campaignItemsStore: fakeCampaignItemsStore(), pendingStore, config: CONFIG,
    });

    expect(mondayClient.setConnectColumn).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalled();
  });

  it('skips and acks when no Donor item matches the email', async () => {
    const message = fakeMessage('a@b.com');
    const mondayClient = fakeMonday({ findItemIdByEmail: vi.fn().mockResolvedValue(null) });
    const pendingStore: PendingInboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn() };

    await processInboundBatch([message], {
      mondayClient, mailchimpClient: fakeMailchimp({ getMemberInterests: vi.fn().mockResolvedValue({ status: 'subscribed', interests: {} }) }),
      campaignItemsStore: fakeCampaignItemsStore(), pendingStore, config: CONFIG,
    });

    expect(mondayClient.setConnectColumn).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalled();
  });

  it('triggers a one-time reconciliation refresh on an unresolvable interest id, then retries the lookup', async () => {
    const message = fakeMessage('a@b.com');
    const mondayClient = fakeMonday({ createCampaignItem: vi.fn().mockResolvedValue('campaign-new') });
    const mailchimpClient = fakeMailchimp({
      getMemberInterests: vi.fn().mockResolvedValue({ status: 'subscribed', interests: { 'brand-new-int': true } }),
      listInterests: vi.fn().mockResolvedValue([{ categoryId: 'cat1', interestId: 'brand-new-int', name: 'Brand New' }]),
    });
    // Starts untracked; reconcileCampaigns (invoked internally) should create+track it.
    const rows: CampaignItemRow[] = [];
    const campaignItemsStore: CampaignItemsStore = {
      listActive: vi.fn().mockImplementation(async () => rows),
      upsert: vi.fn().mockImplementation(async (row: CampaignItemRow) => { rows.push(row); }),
      markArchived: vi.fn(),
      getByInterestId: vi.fn().mockImplementation(async (id: string) => rows.find((r) => r.interestId === id) ?? null),
    };
    const pendingStore: PendingInboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn() };

    await processInboundBatch([message], { mondayClient, mailchimpClient, campaignItemsStore, pendingStore, config: CONFIG });

    expect(mondayClient.createCampaignItem).toHaveBeenCalledWith(999, 'Brand New');
    expect(mondayClient.setConnectColumn).toHaveBeenCalledWith(111, 'donor-1', 'mc', ['campaign-new']);
  });

  it('retries (does not ack) when Monday lookup throws', async () => {
    const message = fakeMessage('a@b.com');
    const mondayClient = fakeMonday({ findItemIdByEmail: vi.fn().mockRejectedValue(new Error('monday down')) });
    const pendingStore: PendingInboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn() };

    await processInboundBatch([message], {
      mondayClient, mailchimpClient: fakeMailchimp({ getMemberInterests: vi.fn().mockResolvedValue({ status: 'subscribed', interests: {} }) }),
      campaignItemsStore: fakeCampaignItemsStore(), pendingStore, config: CONFIG,
    });

    expect(pendingStore.updateStatus).toHaveBeenCalledWith('a@b.com', 'failed', 'monday down');
    expect(message.retry).toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run to verify it fails, then write `src/consumer/inbound.ts`**

Run: `npm test -- src/consumer/inbound.test.ts` — expect FAIL (module not found).

```typescript
import type { PendingInboundStore } from '../db/pendingInbound';
import type { MondayClient } from '../monday/client';
import type { MailchimpClient } from '../mailchimp/client';
import type { CampaignItemsStore } from '../db/campaignItems';
import type { Config, InboundSyncMessage } from '../types';
import { reconcileCampaigns } from '../campaigns/reconcile';
import type { QueueMessageLike } from './outbound';

export interface InboundConsumerDeps {
  pendingStore: PendingInboundStore;
  mondayClient: MondayClient;
  mailchimpClient: MailchimpClient;
  campaignItemsStore: CampaignItemsStore;
  config: Config;
}

export async function processInboundBatch(
  messages: QueueMessageLike<InboundSyncMessage>[],
  deps: InboundConsumerDeps,
): Promise<void> {
  for (const message of messages) {
    const { email } = message.body;
    try {
      await processOne(email, deps);
      message.ack();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`mailchimp-sync inbound consumer: failed to process "${email}": ${errMsg}`);
      await deps.pendingStore.updateStatus(email, 'failed', errMsg);
      message.retry();
    }
  }
}

async function processOne(email: string, deps: InboundConsumerDeps): Promise<void> {
  const { mondayClient, mailchimpClient, campaignItemsStore, config, pendingStore } = deps;

  const member = await mailchimpClient.getMemberInterests(email);
  if (member === null) {
    await pendingStore.updateStatus(email, 'written', undefined, new Date().toISOString());
    return;
  }

  const subscribedInterestIds = Object.entries(member.interests)
    .filter(([, subscribed]) => subscribed)
    .map(([interestId]) => interestId);

  const campaignItemIds: string[] = [];
  let triedReconcile = false;
  for (const interestId of subscribedInterestIds) {
    let row = await campaignItemsStore.getByInterestId(interestId);
    if (row === null && !triedReconcile) {
      // Genuinely new interest the daily reconciliation cron hasn't picked up yet —
      // refresh the catalog once within this run instead of failing outright.
      await reconcileCampaigns({ mailchimpClient, mondayClient, campaignItemsStore, config });
      triedReconcile = true;
      row = await campaignItemsStore.getByInterestId(interestId);
    }
    if (row !== null) campaignItemIds.push(row.mondayItemId);
  }

  const donorsBoardId = config.monday.donorsBoardId;
  if (donorsBoardId === null) {
    throw new Error('config: monday.donorsBoardId must be set before inbound sync can run');
  }

  const donorItemId = await mondayClient.findItemIdByEmail(donorsBoardId, config.monday.columns.email, email);
  if (donorItemId === null) {
    await pendingStore.updateStatus(email, 'written', undefined, new Date().toISOString());
    return;
  }

  await mondayClient.setConnectColumn(donorsBoardId, donorItemId, config.monday.columns.mailchimpCampaigns, campaignItemIds);
  await pendingStore.updateStatus(email, 'written', undefined, new Date().toISOString());
}
```

Also export `QueueMessageLike` from `src/consumer/outbound.ts` if not already exported (it is, per
Task 7 — no change needed there).

Run: `npm test -- src/consumer/inbound.test.ts` — expect PASS (5 tests).

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add mailchimp-sync/src/monday/client.ts mailchimp-sync/src/monday/client.test.ts \
        mailchimp-sync/src/consumer/inbound.ts mailchimp-sync/src/consumer/inbound.test.ts \
        mailchimp-sync/src/consumer/outbound.test.ts mailchimp-sync/src/campaigns/reconcile.test.ts
git commit -m "feat(mailchimp-sync): add inbound queue consumer

Resolves a contact's subscribed Mailchimp interests to Campaigns-board
item ids and writes the full current set to the Donor's connect
column in one call, refreshing the campaign catalog on-demand when an
interest isn't tracked yet."
```

---

## Task 13: Wire inbound into `index.ts`

**Files:**
- Modify: `mailchimp-sync/src/index.ts`
- Modify: `mailchimp-sync/src/index.test.ts`
- Modify: `mailchimp-sync/test/env.d.ts`
- Modify: `mailchimp-sync/src/consumer/outbound.ts` (export `QueueMessageLike` — already done in
  Task 7; confirm, no change expected)

**Interfaces:**
- Consumes: `createInboundApp` (Task 11), `processInboundBatch` (Task 12).
- Produces: the final `fetch`/`queue` handlers, dispatching on `batch.queue`.

- [ ] **Step 1: Write the failing test**

Add to `src/index.test.ts`:

```typescript
describe('fetch — inbound', () => {
  it('mounts the inbound Mailchimp webhook route', async () => {
    const res = await worker.fetch(
      new Request('https://worker.example/webhooks/mailchimp/audience'), fakeEnv(), {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
  });
});

describe('queue dispatch', () => {
  it('routes an outbound-queue batch to processOutboundBatch (no crash on empty batch)', async () => {
    const env = fakeEnv();
    const batch = { queue: 'mailchimp-sync-outbound', messages: [] } as unknown as MessageBatch<unknown>;
    await expect(worker.queue(batch, env)).resolves.toBeUndefined();
  });

  it('routes an inbound-queue batch to processInboundBatch (no crash on empty batch)', async () => {
    const env = fakeEnv();
    const batch = { queue: 'mailchimp-sync-inbound', messages: [] } as unknown as MessageBatch<unknown>;
    await expect(worker.queue(batch, env)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails, then update `src/index.ts`**

Run: `npm test -- src/index.test.ts` — expect FAIL (`/webhooks/mailchimp/audience` 404s; queue
dispatch on batch.queue doesn't exist yet).

Update `test/env.d.ts`:

```typescript
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    OUTBOUND_QUEUE: Queue<{ donorItemId: string }>;
    INBOUND_QUEUE: Queue<{ email: string }>;
    MONDAY_API_TOKEN: string;
    MONDAY_WEBHOOK_SECRET?: string;
    MAILCHIMP_API_KEY: string;
    MAILCHIMP_WEBHOOK_SECRET?: string;
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}
```

Rewrite `src/index.ts` in full:

```typescript
import { Hono } from 'hono';
import configJson from '../config/svbc.json';
import { validateConfig } from './config';
import { HttpMondayClient } from './monday/client';
import { HttpMailchimpClient } from './mailchimp/client';
import { D1PendingOutboundStore } from './db/pendingOutbound';
import { D1PendingInboundStore } from './db/pendingInbound';
import { D1CampaignItemsStore } from './db/campaignItems';
import { createOutboundApp } from './webhook/outboundRoute';
import { createInboundApp } from './webhook/inboundRoute';
import { processOutboundBatch } from './consumer/outbound';
import { processInboundBatch } from './consumer/inbound';
import { reconcileCampaigns } from './campaigns/reconcile';
import type { Env, OutboundSyncMessage, InboundSyncMessage } from './types';

const config = validateConfig(configJson);

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const app = new Hono();
    app.get('/health', (c) => c.json({ ok: true }));
    app.route('/', createOutboundApp({
      pendingStore: new D1PendingOutboundStore(env.DB),
      queue: { send: (message: OutboundSyncMessage) => env.OUTBOUND_QUEUE.send(message).then(() => undefined) },
      webhookSecret: env.MONDAY_WEBHOOK_SECRET,
    }));
    app.route('/', createInboundApp({
      pendingStore: new D1PendingInboundStore(env.DB),
      queue: { send: (message: InboundSyncMessage) => env.INBOUND_QUEUE.send(message).then(() => undefined) },
      webhookSecret: env.MAILCHIMP_WEBHOOK_SECRET,
    }));
    return app.fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch<OutboundSyncMessage | InboundSyncMessage>, env: Env): Promise<void> {
    const mondayClient = new HttpMondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN);
    const mailchimpClient = new HttpMailchimpClient(config.mailchimp.apiBaseUrl, env.MAILCHIMP_API_KEY, config.mailchimp.audienceId);

    if (batch.queue === 'mailchimp-sync-outbound') {
      await processOutboundBatch(batch.messages as unknown as { body: OutboundSyncMessage; ack(): void; retry(): void }[], {
        pendingStore: new D1PendingOutboundStore(env.DB),
        mondayClient,
        mailchimpClient,
        config,
      });
      return;
    }

    await processInboundBatch(batch.messages as unknown as { body: InboundSyncMessage; ack(): void; retry(): void }[], {
      pendingStore: new D1PendingInboundStore(env.DB),
      mondayClient,
      mailchimpClient,
      campaignItemsStore: new D1CampaignItemsStore(env.DB),
      config,
    });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      reconcileCampaigns({
        mailchimpClient: new HttpMailchimpClient(config.mailchimp.apiBaseUrl, env.MAILCHIMP_API_KEY, config.mailchimp.audienceId),
        mondayClient: new HttpMondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN),
        campaignItemsStore: new D1CampaignItemsStore(env.DB),
        config,
      })
        .then((result) => console.log(`mailchimp-sync reconcile: created ${result.created}, renamed ${result.renamed}, archived ${result.archived}`))
        .catch((err) => console.error(`mailchimp-sync reconcile: run failed: ${(err as Error).message}`)),
    );
  },
};
```

Run: `npm test -- src/index.test.ts` — expect PASS (6 tests).

- [ ] **Step 3: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: every suite from Tasks 1–13 green; typecheck clean.

- [ ] **Step 4: Commit**

```bash
git add mailchimp-sync/src/index.ts mailchimp-sync/src/index.test.ts mailchimp-sync/test/env.d.ts
git commit -m "feat(mailchimp-sync): wire inbound sync into fetch/queue handlers

All three flows are now end-to-end: outbound Donor sync, inbound
campaign-membership sync, and the daily Campaigns reconciliation cron."
```

---

## Task 14: Update documentation

**Files:**
- Create/rewrite: `mailchimp-sync/README.md`
- Modify: `README.md` (root, "Status at a glance" table)

**Interfaces:** None — documentation only.

- [ ] **Step 1: Write `mailchimp-sync/README.md`**

```markdown
# mailchimp-sync

**Status:** Built — repurposed from the never-deployed `membership-reminders` (2026-08-26). Not
deployed; blocked on the same Donors-board prerequisite as everything else downstream of
`salesforce-import`, plus a Mailchimp audience with the merge fields/Interest Categories below.
**Priority:** Post-migration, **time-sensitive** — SVBC's existing Mailchimp newsletter
segmentation (by city, by donation history) is fed from Salesforce today and breaks at
retirement, same urgency as the renewal reminders this Worker's predecessor was built for.
**Owner:** Unassigned.
**Stack:** Hono + TypeScript + D1 + Cloudflare Queues (two pairs) + Cloudflare Cron Trigger.
**Design doc:** [`docs/superpowers/specs/2026-08-26-mailchimp-sync-design.md`](../docs/superpowers/specs/2026-08-26-mailchimp-sync-design.md)

## The ask

Keep Monday.com (the post-migration source of truth for donor data) and Mailchimp in sync, in both
directions, so that:

* The 3-stage new-member welcome drip and the 3-stage renewal reminders (formerly planned as
  Worker-side sends — see the design doc's Decision History) run as Mailchimp Customer Journeys,
  staff-owned, triggered off Member Since / Member Until merge fields this Worker maintains.
* The existing newsletter segments (by city/address, by donation history) keep working after
  Salesforce retires.
* Staff can see, per donor, which Mailchimp campaigns/journeys they're currently part of, via a
  connect-column on the Donor item pointing at an auto-generated "Mailchimp Campaigns" board.

## Data flow

Three independent flows — see the design doc for full sequence diagrams:

1. **Outbound:** Donor column change on Monday → webhook → D1 idempotency → Cloudflare Queue →
   Mailchimp contact upsert (merge fields: Member Since/Until, Tier, Status, Address, Total
   Given; tags: active/lapsed/lifetime-member, has-donated).
2. **Campaign catalog reconciliation:** daily cron diffs Mailchimp's Interest Categories against a
   D1-tracked set of Monday items on the Campaigns board — creates, renames, or archives as
   needed. No webhook exists for "Interest Category changed" in Mailchimp, so this is polling, not
   a reliability fallback.
3. **Inbound:** Mailchimp subscribe/unsubscribe/profile event → webhook → D1 idempotency →
   Cloudflare Queue → resolve the contact's current interests to Campaigns-board item ids → write
   the full current set to the Donor's connect column.

## Prerequisites before this can run against real data

**Mailchimp side (staff task):**
* Create five merge fields in the target audience: `MEMBERSINCE`, `MEMBERUNTIL`, `MTIER`,
  `MSTATUS`, `ADDRESS` (type: Address), `TOTALGIVE`.
* Create one Interest Category (e.g. "Communications") with one Interest per campaign type:
  Newsletter, Welcome Drip, Renewal Reminders, and any others donors should be able to toggle
  independently.
* Build the welcome-drip and renewal-reminder Customer Journeys, each gated on its corresponding
  Interest, triggered off `MEMBERSINCE`/`MEMBERUNTIL` respectively. Recommended renewal cadence:
  42/28/14 days before `MEMBERUNTIL` (carried forward from the original `membership-reminders`
  design).
* Set up an audience webhook (Subscribes/Unsubscribes/Profile updates/Cleaned) pointed at this
  Worker's `/webhooks/mailchimp/audience`, with a secret in the URL.

**Monday side:**
* Donors board columns: Membership Status, Membership Tier, Member Since, Member Until, Address
  (addr1/city/state/zip), Email — written by `salesforce-import`.
* The Total Given / Last Gift rollup columns `donation-rollups` maintains.
* A new connect-column on the Donors board pointed at the Campaigns board (auto-created by this
  Worker's first reconciliation run).
* A webhook subscription (`create_item` + `change_column_value`) on the Donors board, pointed at
  `/webhooks/monday/donors`, with a secret in the URL.
* Fill in every `REPLACE_WITH_*` placeholder in `config/svbc.json` once the above exist.

## Local development

- `npm install` — install dependencies
- `npm test` — run the Vitest suite (D1-backed via `@cloudflare/vitest-plugin`, no live API calls)
- `npm run typecheck` — type-check with no emit
- `npm run dev` — run the Worker locally with `wrangler dev`
- `npm run deploy` — deploy with `wrangler deploy`
- `wrangler secret put MONDAY_API_TOKEN` / `MAILCHIMP_API_KEY` / `MONDAY_WEBHOOK_SECRET` /
  `MAILCHIMP_WEBHOOK_SECRET` — set secrets (never commit them)
- `wrangler d1 create svbc-mailchimp-sync` — provision D1, then fill the real `database_id` into
  `wrangler.jsonc`

## Related follow-on, not in this Worker

A donor-facing "communication preferences" UI in `donor-portal`, letting a donor toggle their own
Mailchimp Interests directly (writing to Mailchimp, not to Monday — this Worker's inbound side
picks up the resulting change on its own). See the design doc's closing section; the natural home
for that work is the existing `feat/donor-portal-comm-prefs` branch/worktree.
```

- [ ] **Step 2: Update the root `README.md` status table**

In `README.md`, replace the `membership-reminders` row (currently: *"Built (merged) — not
deployed; hard-blocked on the Donors board id and column ids..."*) with:

```markdown
| [`mailchimp-sync`](mailchimp-sync/README.md) | Built — repurposed from the never-deployed `membership-reminders` (2026-08-26); not deployed, blocked on the Donors board (same as everything downstream of `salesforce-import`) plus a Mailchimp audience with the required merge fields/Interest Categories | Post-migration, **time-sensitive** — newsletter segmentation and both membership email journeys depend on it once Salesforce retires | Unassigned |
```

Also update the "Build order" section's `membership-reminders` mention (item 2, *"`membership-reminders`
next — it's post-migration but time-sensitive..."*) to say `mailchimp-sync` instead, keeping the same
reasoning (renewal emails/segmentation stop working at Salesforce retirement until this ships).

- [ ] **Step 3: Commit**

```bash
git add mailchimp-sync/README.md README.md
git commit -m "docs(mailchimp-sync): write the Worker README, update root status table"
```

---

## Final verification

- [ ] Run `npm test` and `npm run typecheck` in `mailchimp-sync/` one more time from a clean
  `npm install` to confirm nothing regressed across all 14 tasks.
- [ ] Confirm `git log --oneline` on this branch shows one commit per task, each independently
  revertable.
- [ ] Re-read the design doc's "Deliberately not in this design" section and confirm nothing here
  contradicts it (no email content/timing in this repo, no resync-sweep cron for missed data
  webhooks, no native Monday↔Mailchimp integration running alongside this Worker).
