# funraise-sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `funraise-sync` Cloudflare Worker that replaces Funraise's one-directional, Salesforce-only integration — turning Funraise webhook events (Transaction, Subscription, Pledge, Registration) into Donations/Recurring-Gifts/Registration items on Monday.com.

**Architecture:** A Hono webhook handler validates and dedupes incoming events into D1, matches the donor (external-ID → email → auto-create), and enqueues a reference onto a Cloudflare Queue. A separate queue consumer reads the D1 row, writes the Monday item via GraphQL, and updates D1 status. Queue retry/DLQ handles transient Monday API failures; D1's `event_id` primary key handles webhook replay/duplication, since Funraise's webhook auth is handshake-only with no per-event signature.

**Tech Stack:** Hono + TypeScript + Cloudflare D1 + Cloudflare Queues, Vitest with `@cloudflare/vitest-plugin` for tests that touch D1, `wrangler` for dev/deploy.

**Spec:** [`docs/superpowers/specs/2026-08-22-funraise-sync-design.md`](../specs/2026-08-22-funraise-sync-design.md)

## Global Constraints

- Package versions pinned to match the sibling `membership-reminders` Worker already in this repo: `hono@^4.13.3`, `typescript@^7.0.2`, `vitest@^4.1.11`, `wrangler@^4.125.0`, `@cloudflare/workers-types@^5.20260822.1`. Add `@cloudflare/vitest-plugin@^1.0.0` (new — this is the first Worker in the repo using D1, confirmed on npm as the current, non-deprecated package for this).
- TypeScript: `strict: true`, `noUncheckedIndexedAccess: true`, `target/module: ES2022`, `moduleResolution: Bundler` — matches every existing Worker's `tsconfig.json`.
- No new runtime validation library (no zod, etc.) — hand-rolled validators with descriptive thrown errors, matching `config.ts`'s existing pattern in `membership-reminders`.
- `MONDAY_API_TOKEN` and the fact that Funraise's webhook URL is itself the only credential (no per-event signature — confirmed in the design spec) mean both must be handled as secrets via `wrangler secret put`, never written to `config/svbc.json` or logged.
- PII: the write step only ever forwards fields present in `funraiseSync.columnMap`; an unmapped field is dropped by default. `doNotMigrateFields` is a secondary, explicit denylist, not the primary guarantee.
- Real Funraise payload field names and the real Monday column IDs are unconfirmed (open item in the spec) — every place that needs one reads it from `config/svbc.json`, never hardcoded, so filling in the real mapping later is a config change, not a code change.

---

## File structure

```
funraise-sync/
  wrangler.jsonc                  # Worker + D1 + Queues config
  package.json
  tsconfig.json
  config/svbc.json                # funraiseSync config slice: board ids, column map, matching config
  migrations/0001_create_events.sql
  vitest.config.ts                # @cloudflare/vitest-plugin wiring (D1-backed tests)
  test/apply-migrations.ts        # setup file: applies D1 migrations before tests
  test/env.d.ts                   # types the `env` import inside tests
  src/
    types.ts                      # EntityType, EventStatus, EventRow, FunraiseSyncConfig, Env
    config.ts                     # validateConfig
    config.test.ts
    monday/
      client.ts                  # MondayClient interface + HttpMondayClient (fetch-based)
      client.test.ts
    db/
      events.ts                  # EventStore interface + D1EventStore
      events.test.ts
    webhook/
      validate.ts                 # envelope validation (id, entityType) per request
      validate.test.ts
      route.ts                    # createApp(deps): Hono app — handshake, dedupe, match, enqueue
      route.test.ts
    mapping/
      fieldMap.ts                 # mapToMondayColumns: config-driven, PII-safe
      fieldMap.test.ts
    matching/
      donors.ts                   # matchDonor: external-ID → email → auto-create
      donors.test.ts
    consumer/
      processBatch.ts             # processFunraiseQueueBatch: D1 read, Monday write, status update
      processBatch.test.ts
    index.ts                      # wires real D1/Monday/Queue into createApp + queue() handler
```

One clear responsibility per file: `webhook/route.ts` never talks to Monday directly (it calls `matching/donors.ts`), `consumer/processBatch.ts` never touches raw HTTP (it calls `monday/client.ts`), and `mapping/fieldMap.ts` is pure data transformation with no I/O — each is testable in isolation with fakes for its dependencies.

---

### Task 1: Project scaffold

**Files:**
- Create: `funraise-sync/wrangler.jsonc`
- Create: `funraise-sync/package.json`
- Create: `funraise-sync/tsconfig.json`
- Create: `funraise-sync/migrations/0001_create_events.sql`
- Create: `funraise-sync/vitest.config.ts`
- Create: `funraise-sync/test/apply-migrations.ts`
- Create: `funraise-sync/test/env.d.ts`
- Create: `funraise-sync/src/types.ts`
- Create: `funraise-sync/src/index.ts`
- Test: `funraise-sync/src/index.test.ts`

**Interfaces:**
- Produces: `Env` (from `src/types.ts`) — `{ DB: D1Database; WRITE_QUEUE: Queue<{ eventId: string }>; MONDAY_API_TOKEN: string }`, consumed by every later task's `index.ts` wiring.

- [ ] **Step 1: Create `funraise-sync/package.json`**

```json
{
  "name": "funraise-sync",
  "version": "0.1.0",
  "description": "Funraise webhook → Monday.com Donations/Recurring-Gifts/Registration sync.",
  "main": "src/index.ts",
  "scripts": {
    "test": "vitest run",
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "typecheck": "tsc --noEmit"
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

- [ ] **Step 2: Create `funraise-sync/tsconfig.json`**

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
  "include": ["src", "config", "test"]
}
```

- [ ] **Step 3: Create `funraise-sync/migrations/0001_create_events.sql`**

```sql
CREATE TABLE events (
  event_id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  raw_payload TEXT NOT NULL,
  matched_donor_item_id TEXT,
  monday_item_id TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  error TEXT,
  received_at TEXT NOT NULL,
  written_at TEXT
);
```

- [ ] **Step 4: Create `funraise-sync/wrangler.jsonc`**

```jsonc
{
  "name": "svbc-funraise-sync",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-01",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "svbc-funraise-sync",
      // Replace after running: wrangler d1 create svbc-funraise-sync
      "database_id": "REPLACE_AFTER_WRANGLER_D1_CREATE",
      "migrations_dir": "migrations"
    }
  ],
  "queues": {
    "producers": [{ "queue": "funraise-sync-writes", "binding": "WRITE_QUEUE" }],
    "consumers": [
      {
        "queue": "funraise-sync-writes",
        "max_retries": 3,
        "dead_letter_queue": "funraise-sync-writes-dlq"
      }
    ]
  }
}
```

- [ ] **Step 5: Create `funraise-sync/src/types.ts`**

```typescript
export type EntityType = 'transaction' | 'subscription' | 'pledge' | 'registration';
export type EventStatus = 'received' | 'matched' | 'queued' | 'written' | 'failed';

export interface EventRow {
  eventId: string;
  entityType: EntityType;
  rawPayload: string;
  matchedDonorItemId: string | null;
  mondayItemId: string | null;
  status: EventStatus;
  error: string | null;
  receivedAt: string;
  writtenAt: string | null;
}

export interface MondayBoards {
  'donations:live': number;
  'recurring-gifts': number | null;
  'event-registrations': number | null;
  'people-live': number | null;
}

export interface FunraiseSyncConfig {
  monday: {
    apiUrl: string;
    boards: MondayBoards;
  };
  funraiseSync: {
    columnMap: {
      transaction: Record<string, string>;
      recurringGift: Record<string, string>;
      registration: Record<string, string>;
    };
    donorExternalIdField: string;
    donorExternalIdColumn: string;
    donorEmailColumn: string;
    donorNameField: string;
    donorLinkColumn: string;
    emailFieldPrecedence: string[];
    statusField: string;
    statusValueMap: Record<string, string>;
    doNotMigrateFields: string[];
  };
}

export interface Env {
  DB: D1Database;
  WRITE_QUEUE: Queue<{ eventId: string }>;
  MONDAY_API_TOKEN: string;
}
```

- [ ] **Step 6: Create `funraise-sync/src/index.ts`** (temporary minimal health check — Task 10 replaces this with the full wiring)

```typescript
import { Hono } from 'hono';
import type { Env } from './types';

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ ok: true }));

export default {
  fetch: app.fetch,
};
```

- [ ] **Step 7: Create `funraise-sync/vitest.config.ts`**

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

- [ ] **Step 8: Create `funraise-sync/test/apply-migrations.ts`**

```typescript
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

- [ ] **Step 9: Create `funraise-sync/test/env.d.ts`**

```typescript
import type { Env } from '../src/types';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}
```

- [ ] **Step 10: Write the failing test — `funraise-sync/src/index.test.ts`**

```typescript
import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';

describe('scaffold', () => {
  it('applies the events table migration', async () => {
    const result = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='events'"
    ).first();
    expect(result).not.toBeNull();
  });
});
```

- [ ] **Step 11: Install dependencies and run the test**

Run: `cd funraise-sync && npm install && npm test`
Expected: FAIL initially only if `wrangler d1 create` hasn't been run yet against a real account — for local testing, `@cloudflare/vitest-plugin` provisions its own local D1 automatically, so this should PASS once dependencies are installed. If it fails with a binding error, verify `wrangler.jsonc`'s `d1_databases[0].database_id` is present (any placeholder string is fine for local test-only runs).

- [ ] **Step 12: Run typecheck**

Run: `npm run typecheck`
Expected: PASS, no errors.

- [ ] **Step 13: Commit**

```bash
cd funraise-sync
git add wrangler.jsonc package.json tsconfig.json migrations vitest.config.ts test src
git commit -m "feat(funraise-sync): project scaffold with D1-backed test harness"
```

---

### Task 2: Config loading and validation

**Files:**
- Create: `funraise-sync/config/svbc.json`
- Create: `funraise-sync/src/config.ts`
- Test: `funraise-sync/src/config.test.ts`

**Interfaces:**
- Consumes: `FunraiseSyncConfig` (from Task 1's `src/types.ts`)
- Produces: `validateConfig(raw: unknown): FunraiseSyncConfig`, consumed by `src/index.ts` (Task 10) and by every test file that needs a valid config fixture.

- [ ] **Step 1: Create `funraise-sync/config/svbc.json`**

All Funraise field names and Monday column IDs below are placeholders — filled in once `docs/03-monday-migration-mapping.md` (private planning repo) is available. Board ids for `donations:live` and `people-live` are already known from `salesforce-import/config/svbc.json`; `recurring-gifts` and `event-registrations` are `null` there too, so they carry over as `null` here until decided.

```json
{
  "monday": {
    "apiUrl": "https://api.monday.com/v2",
    "boards": {
      "donations:live": 8845443596,
      "recurring-gifts": null,
      "event-registrations": null,
      "people-live": null
    }
  },
  "funraiseSync": {
    "columnMap": {
      "transaction": {
        "amount": "numeric_column_id",
        "description": "text_column_id",
        "status": "status_column_id",
        "createdAt": "date_column_id"
      },
      "recurringGift": {
        "amount": "numeric_column_id",
        "frequency": "text_column_id",
        "status": "status_column_id"
      },
      "registration": {
        "eventName": "text_column_id",
        "registeredAt": "date_column_id"
      }
    },
    "donorExternalIdField": "donor.contactId",
    "donorExternalIdColumn": "funraise__fr_id__c",
    "donorEmailColumn": "email",
    "donorNameField": "donor.name",
    "donorLinkColumn": "connect_boards_column_id",
    "emailFieldPrecedence": ["donor.email"],
    "statusField": "status",
    "statusValueMap": {
      "Posted": "Done"
    },
    "doNotMigrateFields": ["paymentMethod.lastFour", "paymentMethod.expiration"]
  }
}
```

- [ ] **Step 2: Write the failing test — `funraise-sync/src/config.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { validateConfig } from './config';

const validConfig = {
  monday: {
    apiUrl: 'https://api.monday.com/v2',
    boards: {
      'donations:live': 123,
      'recurring-gifts': null,
      'event-registrations': null,
      'people-live': null,
    },
  },
  funraiseSync: {
    columnMap: {
      transaction: { amount: 'numeric_col' },
      recurringGift: { amount: 'numeric_col' },
      registration: { eventName: 'text_col' },
    },
    donorExternalIdField: 'donor.contactId',
    donorExternalIdColumn: 'funraise__fr_id__c',
    donorEmailColumn: 'email',
    donorNameField: 'donor.name',
    donorLinkColumn: 'connect_col',
    emailFieldPrecedence: ['donor.email'],
    statusField: 'status',
    statusValueMap: { Posted: 'Done' },
    doNotMigrateFields: ['paymentMethod.lastFour'],
  },
};

describe('validateConfig', () => {
  it('returns the config unchanged when valid', () => {
    expect(validateConfig(validConfig)).toEqual(validConfig);
  });

  it('throws when monday is missing', () => {
    const { monday, ...missing } = validConfig;
    expect(() => validateConfig(missing)).toThrow(/monday/);
  });

  it('throws when a required board key is missing', () => {
    const { 'donations:live': _drop, ...boards } = validConfig.monday.boards;
    const broken = { ...validConfig, monday: { ...validConfig.monday, boards } };
    expect(() => validateConfig(broken)).toThrow(/donations:live/);
  });

  it('throws when funraiseSync is missing', () => {
    const { funraiseSync, ...missing } = validConfig;
    expect(() => validateConfig(missing)).toThrow(/funraiseSync/);
  });

  it('throws when a required funraiseSync key is missing', () => {
    const { donorEmailColumn, ...rest } = validConfig.funraiseSync;
    const broken = { ...validConfig, funraiseSync: rest };
    expect(() => validateConfig(broken)).toThrow(/donorEmailColumn/);
  });

  it('throws when columnMap is missing an entity key', () => {
    const { transaction, ...columnMap } = validConfig.funraiseSync.columnMap;
    const broken = {
      ...validConfig,
      funraiseSync: { ...validConfig.funraiseSync, columnMap },
    };
    expect(() => validateConfig(broken)).toThrow(/columnMap.transaction/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- config.test.ts`
Expected: FAIL — `validateConfig` is not defined.

- [ ] **Step 4: Write `funraise-sync/src/config.ts`**

```typescript
import type { FunraiseSyncConfig } from './types';

const REQUIRED_BOARD_KEYS = ['donations:live', 'recurring-gifts', 'event-registrations', 'people-live'] as const;

const REQUIRED_FUNRAISE_SYNC_KEYS = [
  'donorExternalIdField',
  'donorExternalIdColumn',
  'donorEmailColumn',
  'donorNameField',
  'donorLinkColumn',
  'emailFieldPrecedence',
  'statusField',
  'statusValueMap',
  'doNotMigrateFields',
] as const;

const REQUIRED_COLUMN_MAP_KEYS = ['transaction', 'recurringGift', 'registration'] as const;

export function validateConfig(raw: unknown): FunraiseSyncConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('config: expected an object');
  }
  const cfg = raw as Record<string, unknown>;

  if (typeof cfg.monday !== 'object' || cfg.monday === null) {
    throw new Error('config: missing required key "monday"');
  }
  const monday = cfg.monday as Record<string, unknown>;

  if (typeof monday.boards !== 'object' || monday.boards === null) {
    throw new Error('config: missing required key "monday.boards"');
  }
  const boards = monday.boards as Record<string, unknown>;
  for (const key of REQUIRED_BOARD_KEYS) {
    if (!(key in boards)) {
      throw new Error(`config: missing required key "monday.boards.${key}"`);
    }
  }

  if (typeof cfg.funraiseSync !== 'object' || cfg.funraiseSync === null) {
    throw new Error('config: missing required key "funraiseSync"');
  }
  const funraiseSync = cfg.funraiseSync as Record<string, unknown>;

  for (const key of REQUIRED_FUNRAISE_SYNC_KEYS) {
    if (!(key in funraiseSync)) {
      throw new Error(`config: missing required key "funraiseSync.${key}"`);
    }
  }

  if (typeof funraiseSync.columnMap !== 'object' || funraiseSync.columnMap === null) {
    throw new Error('config: missing required key "funraiseSync.columnMap"');
  }
  const columnMap = funraiseSync.columnMap as Record<string, unknown>;
  for (const key of REQUIRED_COLUMN_MAP_KEYS) {
    if (!(key in columnMap)) {
      throw new Error(`config: missing required key "funraiseSync.columnMap.${key}"`);
    }
  }

  return cfg as unknown as FunraiseSyncConfig;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- config.test.ts`
Expected: PASS, all 6 assertions.

- [ ] **Step 6: Commit**

```bash
git add config/svbc.json src/config.ts src/config.test.ts
git commit -m "feat(funraise-sync): config loading and validation"
```

---

### Task 3: D1 event store

**Files:**
- Create: `funraise-sync/src/db/events.ts`
- Test: `funraise-sync/src/db/events.test.ts`

**Interfaces:**
- Consumes: `EntityType`, `EventStatus`, `EventRow` (from `src/types.ts`)
- Produces: `EventStore` interface, `D1EventStore` class, `NewEvent`, `EventStatusPatch` types — consumed by `webhook/route.ts` (Task 8), `consumer/processBatch.ts` (Task 9), and `index.ts` (Task 10).

- [ ] **Step 1: Write the failing test — `funraise-sync/src/db/events.test.ts`**

```typescript
import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1EventStore } from './events';

describe('D1EventStore', () => {
  it('inserts a new event and reads it back', async () => {
    const store = new D1EventStore(env.DB);
    const result = await store.insertEvent({
      eventId: 'evt-1',
      entityType: 'transaction',
      rawPayload: '{"amount":100}',
      receivedAt: '2026-08-22T00:00:00.000Z',
    });
    expect(result).toBe('inserted');

    const row = await store.getEvent('evt-1');
    expect(row).toEqual({
      eventId: 'evt-1',
      entityType: 'transaction',
      rawPayload: '{"amount":100}',
      matchedDonorItemId: null,
      mondayItemId: null,
      status: 'received',
      error: null,
      receivedAt: '2026-08-22T00:00:00.000Z',
      writtenAt: null,
    });
  });

  it('reports duplicate on a second insert with the same event id', async () => {
    const store = new D1EventStore(env.DB);
    await store.insertEvent({
      eventId: 'evt-2',
      entityType: 'transaction',
      rawPayload: '{}',
      receivedAt: '2026-08-22T00:00:00.000Z',
    });
    const second = await store.insertEvent({
      eventId: 'evt-2',
      entityType: 'transaction',
      rawPayload: '{}',
      receivedAt: '2026-08-22T00:00:01.000Z',
    });
    expect(second).toBe('duplicate');
  });

  it('updates status and patch fields, then clears error on the next update', async () => {
    const store = new D1EventStore(env.DB);
    await store.insertEvent({
      eventId: 'evt-3',
      entityType: 'transaction',
      rawPayload: '{}',
      receivedAt: '2026-08-22T00:00:00.000Z',
    });

    await store.updateStatus('evt-3', 'failed', { error: 'boom' });
    let row = await store.getEvent('evt-3');
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('boom');

    await store.updateStatus('evt-3', 'written', { mondayItemId: 'item-9', writtenAt: '2026-08-22T01:00:00.000Z' });
    row = await store.getEvent('evt-3');
    expect(row?.status).toBe('written');
    expect(row?.mondayItemId).toBe('item-9');
    expect(row?.writtenAt).toBe('2026-08-22T01:00:00.000Z');
    expect(row?.error).toBeNull();
  });

  it('returns null for an unknown event id', async () => {
    const store = new D1EventStore(env.DB);
    expect(await store.getEvent('does-not-exist')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- events.test.ts`
Expected: FAIL — `./events` module not found.

- [ ] **Step 3: Write `funraise-sync/src/db/events.ts`**

```typescript
import type { EntityType, EventRow, EventStatus } from '../types';

export interface NewEvent {
  eventId: string;
  entityType: EntityType;
  rawPayload: string;
  receivedAt: string;
}

export interface EventStatusPatch {
  matchedDonorItemId?: string;
  mondayItemId?: string;
  error?: string;
  writtenAt?: string;
}

export interface EventStore {
  insertEvent(row: NewEvent): Promise<'inserted' | 'duplicate'>;
  updateStatus(eventId: string, status: EventStatus, patch?: EventStatusPatch): Promise<void>;
  getEvent(eventId: string): Promise<EventRow | null>;
}

interface D1EventRecord {
  event_id: string;
  entity_type: EntityType;
  raw_payload: string;
  matched_donor_item_id: string | null;
  monday_item_id: string | null;
  status: EventStatus;
  error: string | null;
  received_at: string;
  written_at: string | null;
}

function toEventRow(record: D1EventRecord): EventRow {
  return {
    eventId: record.event_id,
    entityType: record.entity_type,
    rawPayload: record.raw_payload,
    matchedDonorItemId: record.matched_donor_item_id,
    mondayItemId: record.monday_item_id,
    status: record.status,
    error: record.error,
    receivedAt: record.received_at,
    writtenAt: record.written_at,
  };
}

export class D1EventStore implements EventStore {
  constructor(private db: D1Database) {}

  async insertEvent(row: NewEvent): Promise<'inserted' | 'duplicate'> {
    const result = await this.db
      .prepare(
        `INSERT INTO events (event_id, entity_type, raw_payload, status, received_at)
         VALUES (?1, ?2, ?3, 'received', ?4)
         ON CONFLICT (event_id) DO NOTHING`
      )
      .bind(row.eventId, row.entityType, row.rawPayload, row.receivedAt)
      .run();
    return result.meta.changes > 0 ? 'inserted' : 'duplicate';
  }

  async updateStatus(eventId: string, status: EventStatus, patch: EventStatusPatch = {}): Promise<void> {
    await this.db
      .prepare(
        `UPDATE events SET
           status = ?2,
           matched_donor_item_id = COALESCE(?3, matched_donor_item_id),
           monday_item_id = COALESCE(?4, monday_item_id),
           error = ?5,
           written_at = COALESCE(?6, written_at)
         WHERE event_id = ?1`
      )
      .bind(
        eventId,
        status,
        patch.matchedDonorItemId ?? null,
        patch.mondayItemId ?? null,
        patch.error ?? null,
        patch.writtenAt ?? null
      )
      .run();
  }

  async getEvent(eventId: string): Promise<EventRow | null> {
    const record = await this.db
      .prepare(
        `SELECT event_id, entity_type, raw_payload, matched_donor_item_id, monday_item_id, status, error, received_at, written_at
         FROM events WHERE event_id = ?1`
      )
      .bind(eventId)
      .first<D1EventRecord>();
    return record === null ? null : toEventRow(record);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- events.test.ts`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/db
git commit -m "feat(funraise-sync): D1 event store with dedup-by-event-id"
```

---

### Task 4: Monday GraphQL client

**Files:**
- Create: `funraise-sync/src/monday/client.ts`
- Test: `funraise-sync/src/monday/client.test.ts`

**Interfaces:**
- Produces: `MondayClient` interface, `MondayItem`, `HttpMondayClient` — consumed by `matching/donors.ts` (Task 7), `consumer/processBatch.ts` (Task 9), and `index.ts` (Task 10).

- [ ] **Step 1: Write the failing test — `funraise-sync/src/monday/client.test.ts`**

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
  it('finds an item by column value', async () => {
    const fetchMock = mockFetchOnce({
      data: { items_page_by_column_values: { items: [{ id: '123' }] } },
    });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');

    const item = await client.findItemByColumnValue(999, 'email', 'a@example.com');

    expect(item).toEqual({ id: '123' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.monday.com/v2');
    expect(init.headers.Authorization).toBe('token-123');
    const body = JSON.parse(init.body);
    expect(body.variables).toEqual({
      boardId: 999,
      columns: [{ column_id: 'email', column_values: ['a@example.com'] }],
    });
  });

  it('returns null when no item matches', async () => {
    mockFetchOnce({ data: { items_page_by_column_values: { items: [] } } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');
    expect(await client.findItemByColumnValue(999, 'email', 'nobody@example.com')).toBeNull();
  });

  it('creates an item', async () => {
    const fetchMock = mockFetchOnce({ data: { create_item: { id: '456' } } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');

    const item = await client.createItem(999, 'Jane Donor', { email: 'jane@example.com' });

    expect(item).toEqual({ id: '456' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.variables.itemName).toBe('Jane Donor');
    expect(JSON.parse(body.variables.columnValues)).toEqual({ email: 'jane@example.com' });
  });

  it('changes column values on an existing item', async () => {
    const fetchMock = mockFetchOnce({ data: { change_multiple_column_values: { id: '456' } } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');

    await client.changeColumnValues(999, '456', { status: 'Done' });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.variables.itemId).toBe('456');
  });

  it('throws on a non-OK HTTP response', async () => {
    mockFetchOnce({}, false);
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');
    await expect(client.findItemByColumnValue(1, 'x', 'y')).rejects.toThrow(/HTTP 500/);
  });

  it('throws on a GraphQL errors array', async () => {
    mockFetchOnce({ errors: [{ message: 'Board not found' }] });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');
    await expect(client.findItemByColumnValue(1, 'x', 'y')).rejects.toThrow(/Board not found/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- client.test.ts`
Expected: FAIL — `./client` module not found.

- [ ] **Step 3: Write `funraise-sync/src/monday/client.ts`**

```typescript
export interface MondayItem {
  id: string;
}

export interface MondayClient {
  findItemByColumnValue(boardId: number, columnId: string, value: string): Promise<MondayItem | null>;
  createItem(boardId: number, itemName: string, columnValues: Record<string, unknown>): Promise<MondayItem>;
  changeColumnValues(boardId: number, itemId: string, columnValues: Record<string, unknown>): Promise<void>;
}

const MONDAY_API_VERSION = '2026-01';

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
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
    return json.data as T;
  }

  async findItemByColumnValue(boardId: number, columnId: string, value: string): Promise<MondayItem | null> {
    const data = await this.graphql<{ items_page_by_column_values: { items: MondayItem[] } }>(
      `query ($boardId: ID!, $columns: [ItemsPageByColumnValuesQuery!]!) {
        items_page_by_column_values(board_id: $boardId, columns: $columns) {
          items { id }
        }
      }`,
      { boardId, columns: [{ column_id: columnId, column_values: [value] }] }
    );
    const items = data.items_page_by_column_values.items;
    return items.length > 0 ? (items[0] as MondayItem) : null;
  }

  async createItem(boardId: number, itemName: string, columnValues: Record<string, unknown>): Promise<MondayItem> {
    const data = await this.graphql<{ create_item: MondayItem }>(
      `mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
        create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues) {
          id
        }
      }`,
      { boardId, itemName, columnValues: JSON.stringify(columnValues) }
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
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- client.test.ts`
Expected: PASS, all 6 tests.

- [ ] **Step 5: Verify the GraphQL shape against Monday's live API before deploy**

These queries are written from current Monday API v2 knowledge but not verified against a live account from this environment. Before relying on this in production, run one real call from `wrangler dev` (or Monday's API playground) against a test board and confirm `items_page_by_column_values` and `API-Version` are still correct for SVBC's account — note this explicitly in the PR description as a manual verification step, not an automated one.

- [ ] **Step 6: Commit**

```bash
git add src/monday
git commit -m "feat(funraise-sync): Monday GraphQL client"
```

---

### Task 5: Webhook payload envelope validation

**Files:**
- Create: `funraise-sync/src/webhook/validate.ts`
- Test: `funraise-sync/src/webhook/validate.test.ts`

**Interfaces:**
- Consumes: `EntityType` (from `src/types.ts`)
- Produces: `validateEnvelope(entityTypeParam: string, body: unknown): ValidatedEnvelope`, `ValidatedEnvelope`, `isEntityType` — consumed by `webhook/route.ts` (Task 8).

- [ ] **Step 1: Write the failing test — `funraise-sync/src/webhook/validate.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { validateEnvelope, isEntityType } from './validate';

describe('isEntityType', () => {
  it('accepts the four known entity types', () => {
    expect(isEntityType('transaction')).toBe(true);
    expect(isEntityType('subscription')).toBe(true);
    expect(isEntityType('pledge')).toBe(true);
    expect(isEntityType('registration')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isEntityType('donation')).toBe(false);
  });
});

describe('validateEnvelope', () => {
  it('returns the event id, entity type, and raw payload when valid', () => {
    const result = validateEnvelope('transaction', { id: 'evt-1', amount: 100 });
    expect(result).toEqual({ eventId: 'evt-1', entityType: 'transaction', raw: { id: 'evt-1', amount: 100 } });
  });

  it('throws on an unknown entity type', () => {
    expect(() => validateEnvelope('donation', { id: 'evt-1' })).toThrow(/unknown entity type "donation"/);
  });

  it('throws when the body is not an object', () => {
    expect(() => validateEnvelope('transaction', 'not-an-object')).toThrow(/must be a JSON object/);
  });

  it('throws when the body is null', () => {
    expect(() => validateEnvelope('transaction', null)).toThrow(/must be a JSON object/);
  });

  it('throws when id is missing', () => {
    expect(() => validateEnvelope('transaction', { amount: 100 })).toThrow(/missing a non-empty "id"/);
  });

  it('throws when id is an empty string', () => {
    expect(() => validateEnvelope('transaction', { id: '' })).toThrow(/missing a non-empty "id"/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- validate.test.ts`
Expected: FAIL — `./validate` module not found.

- [ ] **Step 3: Write `funraise-sync/src/webhook/validate.ts`**

```typescript
import type { EntityType } from '../types';

const VALID_ENTITY_TYPES: readonly EntityType[] = ['transaction', 'subscription', 'pledge', 'registration'];

export interface ValidatedEnvelope {
  eventId: string;
  entityType: EntityType;
  raw: Record<string, unknown>;
}

export function isEntityType(value: string): value is EntityType {
  return (VALID_ENTITY_TYPES as readonly string[]).includes(value);
}

export function validateEnvelope(entityTypeParam: string, body: unknown): ValidatedEnvelope {
  if (!isEntityType(entityTypeParam)) {
    throw new Error(`funraise webhook: unknown entity type "${entityTypeParam}"`);
  }
  if (typeof body !== 'object' || body === null) {
    throw new Error('funraise webhook: payload must be a JSON object');
  }
  const raw = body as Record<string, unknown>;
  const eventId = raw.id;
  if (typeof eventId !== 'string' || eventId.length === 0) {
    throw new Error('funraise webhook: payload missing a non-empty "id" field');
  }
  return { eventId, entityType: entityTypeParam, raw };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- validate.test.ts`
Expected: PASS, all 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/webhook/validate.ts src/webhook/validate.test.ts
git commit -m "feat(funraise-sync): webhook payload envelope validation"
```

---

### Task 6: Config-driven field mapping

**Files:**
- Create: `funraise-sync/src/mapping/fieldMap.ts`
- Test: `funraise-sync/src/mapping/fieldMap.test.ts`

**Interfaces:**
- Consumes: `EntityType`, `FunraiseSyncConfig` (from `src/types.ts`)
- Produces: `mapToMondayColumns(entityType, rawPayload, config): Record<string, unknown>` — consumed by `consumer/processBatch.ts` (Task 9).

- [ ] **Step 1: Write the failing test — `funraise-sync/src/mapping/fieldMap.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { mapToMondayColumns } from './fieldMap';
import type { FunraiseSyncConfig } from '../types';

const config: FunraiseSyncConfig = {
  monday: {
    apiUrl: 'https://api.monday.com/v2',
    boards: { 'donations:live': 1, 'recurring-gifts': null, 'event-registrations': null, 'people-live': null },
  },
  funraiseSync: {
    columnMap: {
      transaction: { amount: 'numeric_col', status: 'status_col', 'paymentMethod.lastFour': 'leaked_col' },
      recurringGift: { amount: 'numeric_col' },
      registration: { eventName: 'text_col' },
    },
    donorExternalIdField: 'donor.contactId',
    donorExternalIdColumn: 'funraise_id_col',
    donorEmailColumn: 'email_col',
    donorNameField: 'donor.name',
    donorLinkColumn: 'connect_col',
    emailFieldPrecedence: ['donor.email'],
    statusField: 'status',
    statusValueMap: { Posted: 'Done' },
    doNotMigrateFields: ['paymentMethod.lastFour'],
  },
};

describe('mapToMondayColumns', () => {
  it('maps mapped fields to their Monday column ids', () => {
    const result = mapToMondayColumns('transaction', { amount: 100, status: 'Posted' }, config);
    expect(result).toEqual({ numeric_col: 100, status_col: 'Done' });
  });

  it('drops any field not present in columnMap', () => {
    const result = mapToMondayColumns('transaction', { amount: 100, secretField: 'nope' }, config);
    expect(result).not.toHaveProperty('secretField');
    expect(Object.keys(result)).toEqual(['numeric_col']);
  });

  it('drops a doNotMigrateFields entry even if present in columnMap', () => {
    const result = mapToMondayColumns('transaction', { amount: 100, paymentMethod: { lastFour: '1234' } }, config);
    expect(result).not.toHaveProperty('leaked_col');
  });

  it('applies statusValueMap only to the configured statusField, leaving unmapped values as-is', () => {
    const result = mapToMondayColumns('transaction', { amount: 100, status: 'Refunded' }, config);
    expect(result.status_col).toBe('Refunded');
  });

  it('routes subscription and pledge through the recurringGift map', () => {
    const result = mapToMondayColumns('subscription', { amount: 50 }, config);
    expect(result).toEqual({ numeric_col: 50 });
  });

  it('supports dot-path field lookup', () => {
    const nestedConfig: FunraiseSyncConfig = {
      ...config,
      funraiseSync: {
        ...config.funraiseSync,
        columnMap: { ...config.funraiseSync.columnMap, transaction: { 'donor.email': 'email_col' } },
      },
    };
    const result = mapToMondayColumns('transaction', { donor: { email: 'a@example.com' } }, nestedConfig);
    expect(result).toEqual({ email_col: 'a@example.com' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- fieldMap.test.ts`
Expected: FAIL — `./fieldMap` module not found.

- [ ] **Step 3: Write `funraise-sync/src/mapping/fieldMap.ts`**

```typescript
import type { EntityType, FunraiseSyncConfig } from '../types';

function getPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (typeof acc !== 'object' || acc === null) return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

type ColumnMapKey = keyof FunraiseSyncConfig['funraiseSync']['columnMap'];

const ENTITY_MAP_KEY: Record<EntityType, ColumnMapKey> = {
  transaction: 'transaction',
  subscription: 'recurringGift',
  pledge: 'recurringGift',
  registration: 'registration',
};

export function mapToMondayColumns(
  entityType: EntityType,
  rawPayload: Record<string, unknown>,
  config: FunraiseSyncConfig
): Record<string, unknown> {
  const mapKey = ENTITY_MAP_KEY[entityType];
  const { columnMap, doNotMigrateFields, statusField, statusValueMap } = config.funraiseSync;
  const fields = columnMap[mapKey];

  const result: Record<string, unknown> = {};
  for (const [funraiseField, mondayColumnId] of Object.entries(fields)) {
    if (doNotMigrateFields.includes(funraiseField)) continue;

    let value = getPath(rawPayload, funraiseField);
    if (value === undefined) continue;

    if (funraiseField === statusField && typeof value === 'string') {
      value = statusValueMap[value] ?? value;
    }

    result[mondayColumnId] = value;
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- fieldMap.test.ts`
Expected: PASS, all 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/mapping
git commit -m "feat(funraise-sync): config-driven field mapping with PII guarantee"
```

---

### Task 7: Donor matching

**Files:**
- Create: `funraise-sync/src/matching/donors.ts`
- Test: `funraise-sync/src/matching/donors.test.ts`

**Interfaces:**
- Consumes: `MondayClient`, `MondayItem` (Task 4); `FunraiseSyncConfig` (Task 1)
- Produces: `matchDonor(mondayClient, config, rawPayload): Promise<DonorMatchResult>`, `DonorMatchResult` — consumed by `webhook/route.ts` (Task 8).

- [ ] **Step 1: Write the failing test — `funraise-sync/src/matching/donors.test.ts`**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { matchDonor } from './donors';
import type { MondayClient, MondayItem } from '../monday/client';
import type { FunraiseSyncConfig } from '../types';

const config: FunraiseSyncConfig = {
  monday: {
    apiUrl: 'https://api.monday.com/v2',
    boards: { 'donations:live': 1, 'recurring-gifts': null, 'event-registrations': null, 'people-live': 42 },
  },
  funraiseSync: {
    columnMap: { transaction: {}, recurringGift: {}, registration: {} },
    donorExternalIdField: 'donor.contactId',
    donorExternalIdColumn: 'funraise_id_col',
    donorEmailColumn: 'email_col',
    donorNameField: 'donor.name',
    donorLinkColumn: 'connect_col',
    emailFieldPrecedence: ['donor.email'],
    statusField: 'status',
    statusValueMap: {},
    doNotMigrateFields: [],
  },
};

function fakeMondayClient(overrides: Partial<MondayClient> = {}): MondayClient {
  return {
    findItemByColumnValue: vi.fn().mockResolvedValue(null),
    createItem: vi.fn().mockResolvedValue({ id: 'new-item' } satisfies MondayItem),
    changeColumnValues: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('matchDonor', () => {
  it('matches by external id first, without checking email', async () => {
    const findItemByColumnValue = vi.fn().mockResolvedValue({ id: 'donor-1' });
    const client = fakeMondayClient({ findItemByColumnValue });

    const result = await matchDonor(client, config, { donor: { contactId: 'fr-1', email: 'a@example.com' } });

    expect(result).toEqual({ donorItemId: 'donor-1', created: false });
    expect(findItemByColumnValue).toHaveBeenCalledTimes(1);
    expect(findItemByColumnValue).toHaveBeenCalledWith(42, 'funraise_id_col', 'fr-1');
  });

  it('falls back to email match when external id has no match', async () => {
    const findItemByColumnValue = vi
      .fn()
      .mockResolvedValueOnce(null) // external id lookup
      .mockResolvedValueOnce({ id: 'donor-2' }); // email lookup
    const client = fakeMondayClient({ findItemByColumnValue });

    const result = await matchDonor(client, config, { donor: { contactId: 'fr-2', email: 'b@example.com' } });

    expect(result).toEqual({ donorItemId: 'donor-2', created: false });
    expect(findItemByColumnValue).toHaveBeenNthCalledWith(2, 42, 'email_col', 'b@example.com');
  });

  it('auto-creates a new donor when neither external id nor email match', async () => {
    const createItem = vi.fn().mockResolvedValue({ id: 'donor-new' });
    const client = fakeMondayClient({ createItem });

    const result = await matchDonor(client, config, {
      donor: { contactId: 'fr-3', email: 'c@example.com', name: 'Casey Donor' },
    });

    expect(result).toEqual({ donorItemId: 'donor-new', created: true });
    expect(createItem).toHaveBeenCalledWith(42, 'Casey Donor', {
      email_col: 'c@example.com',
      funraise_id_col: 'fr-3',
    });
  });

  it('falls back to "Unknown Donor" when no name field is present', async () => {
    const createItem = vi.fn().mockResolvedValue({ id: 'donor-new' });
    const client = fakeMondayClient({ createItem });

    await matchDonor(client, config, { donor: { contactId: 'fr-4', email: 'd@example.com' } });

    expect(createItem).toHaveBeenCalledWith(42, 'Unknown Donor', expect.any(Object));
  });

  it('throws when the Donors board is not configured', async () => {
    const client = fakeMondayClient();
    const unconfigured = { ...config, monday: { ...config.monday, boards: { ...config.monday.boards, 'people-live': null } } };
    await expect(matchDonor(client, unconfigured, { donor: { email: 'x@example.com' } })).rejects.toThrow(
      /people-live.*not configured/
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- donors.test.ts`
Expected: FAIL — `./donors` module not found.

- [ ] **Step 3: Write `funraise-sync/src/matching/donors.ts`**

```typescript
import type { MondayClient } from '../monday/client';
import type { FunraiseSyncConfig } from '../types';

export interface DonorMatchResult {
  donorItemId: string;
  created: boolean;
}

function getPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (typeof acc !== 'object' || acc === null) return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

export async function matchDonor(
  mondayClient: MondayClient,
  config: FunraiseSyncConfig,
  rawPayload: Record<string, unknown>
): Promise<DonorMatchResult> {
  const donorsBoardId = config.monday.boards['people-live'];
  if (donorsBoardId === null) {
    throw new Error('config: monday.boards.people-live is not configured');
  }

  const { donorExternalIdField, donorExternalIdColumn, donorEmailColumn, donorNameField, emailFieldPrecedence } =
    config.funraiseSync;

  const externalId = getPath(rawPayload, donorExternalIdField);
  if (typeof externalId === 'string' && externalId.length > 0) {
    const existing = await mondayClient.findItemByColumnValue(donorsBoardId, donorExternalIdColumn, externalId);
    if (existing) return { donorItemId: existing.id, created: false };
  }

  for (const emailField of emailFieldPrecedence) {
    const email = getPath(rawPayload, emailField);
    if (typeof email === 'string' && email.length > 0) {
      const existing = await mondayClient.findItemByColumnValue(donorsBoardId, donorEmailColumn, email);
      if (existing) return { donorItemId: existing.id, created: false };
    }
  }

  const primaryEmail = emailFieldPrecedence
    .map((field) => getPath(rawPayload, field))
    .find((value): value is string => typeof value === 'string' && value.length > 0);
  const donorName = getPath(rawPayload, donorNameField);

  const created = await mondayClient.createItem(
    donorsBoardId,
    typeof donorName === 'string' && donorName.length > 0 ? donorName : 'Unknown Donor',
    {
      ...(primaryEmail ? { [donorEmailColumn]: primaryEmail } : {}),
      ...(typeof externalId === 'string' && externalId.length > 0 ? { [donorExternalIdColumn]: externalId } : {}),
    }
  );

  return { donorItemId: created.id, created: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- donors.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/matching
git commit -m "feat(funraise-sync): donor matching (external id, email, auto-create)"
```

---

### Task 8: Webhook route

**Files:**
- Create: `funraise-sync/src/webhook/route.ts`
- Test: `funraise-sync/src/webhook/route.test.ts`

**Interfaces:**
- Consumes: `EventStore` (Task 3), `MondayClient` (Task 4), `validateEnvelope` (Task 5), `matchDonor` (Task 7), `FunraiseSyncConfig` (Task 1)
- Produces: `createApp(deps: AppDeps): Hono`, `AppDeps`, `QueueLike` — consumed by `index.ts` (Task 10).

- [ ] **Step 1: Write the failing test — `funraise-sync/src/webhook/route.test.ts`**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createApp } from './route';
import type { EventStore } from '../db/events';
import type { MondayClient } from '../monday/client';
import type { FunraiseSyncConfig } from '../types';

const config: FunraiseSyncConfig = {
  monday: {
    apiUrl: 'https://api.monday.com/v2',
    boards: { 'donations:live': 1, 'recurring-gifts': null, 'event-registrations': null, 'people-live': 42 },
  },
  funraiseSync: {
    columnMap: { transaction: {}, recurringGift: {}, registration: {} },
    donorExternalIdField: 'donor.contactId',
    donorExternalIdColumn: 'funraise_id_col',
    donorEmailColumn: 'email_col',
    donorNameField: 'donor.name',
    donorLinkColumn: 'connect_col',
    emailFieldPrecedence: ['donor.email'],
    statusField: 'status',
    statusValueMap: {},
    doNotMigrateFields: [],
  },
};

function fakeEventStore(overrides: Partial<EventStore> = {}): EventStore {
  return {
    insertEvent: vi.fn().mockResolvedValue('inserted'),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    getEvent: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function fakeMondayClient(overrides: Partial<MondayClient> = {}): MondayClient {
  return {
    findItemByColumnValue: vi.fn().mockResolvedValue({ id: 'donor-1' }),
    createItem: vi.fn().mockResolvedValue({ id: 'donor-1' }),
    changeColumnValues: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('createApp', () => {
  it('echoes x-hook-secret on a handshake request without touching the event store', async () => {
    const eventStore = fakeEventStore();
    const app = createApp({ eventStore, mondayClient: fakeMondayClient(), config, queue: { send: vi.fn() } });

    const res = await app.request('/webhooks/funraise/transaction', {
      method: 'POST',
      headers: { 'x-hook-secret': 'abc123' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-hook-secret')).toBe('abc123');
    expect(eventStore.insertEvent).not.toHaveBeenCalled();
  });

  it('rejects an unknown entity type without inserting', async () => {
    const eventStore = fakeEventStore();
    const app = createApp({ eventStore, mondayClient: fakeMondayClient(), config, queue: { send: vi.fn() } });

    const res = await app.request('/webhooks/funraise/donation', {
      method: 'POST',
      body: JSON.stringify({ id: 'evt-1' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(false);
    expect(eventStore.insertEvent).not.toHaveBeenCalled();
  });

  it('dedupes, matches, and enqueues a new event', async () => {
    const eventStore = fakeEventStore();
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const mondayClient = fakeMondayClient();
    const app = createApp({ eventStore, mondayClient, config, queue });

    const res = await app.request('/webhooks/funraise/transaction', {
      method: 'POST',
      body: JSON.stringify({ id: 'evt-1', donor: { contactId: 'fr-1' } }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(eventStore.insertEvent).toHaveBeenCalledWith({
      eventId: 'evt-1',
      entityType: 'transaction',
      rawPayload: JSON.stringify({ id: 'evt-1', donor: { contactId: 'fr-1' } }),
      receivedAt: expect.any(String),
    });
    expect(eventStore.updateStatus).toHaveBeenCalledWith('evt-1', 'matched', { matchedDonorItemId: 'donor-1' });
    expect(queue.send).toHaveBeenCalledWith({ eventId: 'evt-1' });
    expect(eventStore.updateStatus).toHaveBeenCalledWith('evt-1', 'queued');
  });

  it('short-circuits on a duplicate event without matching or enqueueing', async () => {
    const eventStore = fakeEventStore({ insertEvent: vi.fn().mockResolvedValue('duplicate') });
    const queue = { send: vi.fn() };
    const mondayClient = fakeMondayClient();
    const app = createApp({ eventStore, mondayClient, config, queue });

    const res = await app.request('/webhooks/funraise/transaction', {
      method: 'POST',
      body: JSON.stringify({ id: 'evt-1' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect((await res.json()).duplicate).toBe(true);
    expect(mondayClient.findItemByColumnValue).not.toHaveBeenCalled();
    expect(queue.send).not.toHaveBeenCalled();
  });

  it('marks the event failed when matching throws, without crashing the request', async () => {
    const eventStore = fakeEventStore();
    const mondayClient = fakeMondayClient({
      findItemByColumnValue: vi.fn().mockRejectedValue(new Error('monday API: HTTP 500')),
    });
    const queue = { send: vi.fn() };
    const app = createApp({ eventStore, mondayClient, config, queue });

    const res = await app.request('/webhooks/funraise/transaction', {
      method: 'POST',
      body: JSON.stringify({ id: 'evt-1', donor: { contactId: 'fr-1' } }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(eventStore.updateStatus).toHaveBeenCalledWith('evt-1', 'failed', { error: 'monday API: HTTP 500' });
    expect(queue.send).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- route.test.ts`
Expected: FAIL — `./route` module not found.

- [ ] **Step 3: Write `funraise-sync/src/webhook/route.ts`**

```typescript
import { Hono } from 'hono';
import type { EventStore } from '../db/events';
import type { MondayClient } from '../monday/client';
import type { FunraiseSyncConfig } from '../types';
import { validateEnvelope } from './validate';
import { matchDonor } from '../matching/donors';

export interface QueueLike {
  send(message: { eventId: string }): Promise<void>;
}

export interface AppDeps {
  eventStore: EventStore;
  mondayClient: MondayClient;
  config: FunraiseSyncConfig;
  queue: QueueLike;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.post('/webhooks/funraise/:entityType', async (c) => {
    const incomingSecret = c.req.header('x-hook-secret');
    if (incomingSecret) {
      c.header('x-hook-secret', incomingSecret);
      return c.body(null, 200);
    }

    const entityTypeParam = c.req.param('entityType');
    let envelope;
    try {
      const body = await c.req.json();
      envelope = validateEnvelope(entityTypeParam, body);
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 200);
    }

    const insertResult = await deps.eventStore.insertEvent({
      eventId: envelope.eventId,
      entityType: envelope.entityType,
      rawPayload: JSON.stringify(envelope.raw),
      receivedAt: new Date().toISOString(),
    });

    if (insertResult === 'duplicate') {
      return c.json({ ok: true, duplicate: true }, 200);
    }

    try {
      const match = await matchDonor(deps.mondayClient, deps.config, envelope.raw);
      await deps.eventStore.updateStatus(envelope.eventId, 'matched', {
        matchedDonorItemId: match.donorItemId,
      });
      await deps.queue.send({ eventId: envelope.eventId });
      await deps.eventStore.updateStatus(envelope.eventId, 'queued');
    } catch (err) {
      await deps.eventStore.updateStatus(envelope.eventId, 'failed', {
        error: (err as Error).message,
      });
    }

    return c.json({ ok: true }, 200);
  });

  return app;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- route.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/webhook/route.ts src/webhook/route.test.ts
git commit -m "feat(funraise-sync): webhook route (handshake, dedup, match, enqueue)"
```

---

### Task 9: Queue consumer

**Files:**
- Create: `funraise-sync/src/consumer/processBatch.ts`
- Test: `funraise-sync/src/consumer/processBatch.test.ts`

**Interfaces:**
- Consumes: `EventStore` (Task 3), `MondayClient` (Task 4), `mapToMondayColumns` (Task 6), `FunraiseSyncConfig` (Task 1)
- Produces: `processFunraiseQueueBatch(messages, deps): Promise<void>`, `QueueMessageLike<T>`, `FunraiseQueueMessage`, `ProcessBatchDeps` — consumed by `index.ts` (Task 10).

- [ ] **Step 1: Write the failing test — `funraise-sync/src/consumer/processBatch.test.ts`**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { processFunraiseQueueBatch, type QueueMessageLike, type FunraiseQueueMessage } from './processBatch';
import type { EventStore } from '../db/events';
import type { MondayClient } from '../monday/client';
import type { EventRow, FunraiseSyncConfig } from '../types';

const config: FunraiseSyncConfig = {
  monday: {
    apiUrl: 'https://api.monday.com/v2',
    boards: { 'donations:live': 111, 'recurring-gifts': 222, 'event-registrations': 333, 'people-live': 42 },
  },
  funraiseSync: {
    columnMap: {
      transaction: { amount: 'numeric_col' },
      recurringGift: { amount: 'numeric_col' },
      registration: { eventName: 'text_col' },
    },
    donorExternalIdField: 'donor.contactId',
    donorExternalIdColumn: 'funraise_id_col',
    donorEmailColumn: 'email_col',
    donorNameField: 'donor.name',
    donorLinkColumn: 'connect_col',
    emailFieldPrecedence: ['donor.email'],
    statusField: 'status',
    statusValueMap: {},
    doNotMigrateFields: [],
  },
};

function eventRow(overrides: Partial<EventRow> = {}): EventRow {
  return {
    eventId: 'evt-1',
    entityType: 'transaction',
    rawPayload: JSON.stringify({ amount: 100 }),
    matchedDonorItemId: 'donor-1',
    mondayItemId: null,
    status: 'queued',
    error: null,
    receivedAt: '2026-08-22T00:00:00.000Z',
    writtenAt: null,
    ...overrides,
  };
}

function fakeMessage(eventId: string): QueueMessageLike<FunraiseQueueMessage> & { ack: any; retry: any } {
  return { body: { eventId }, ack: vi.fn(), retry: vi.fn() };
}

describe('processFunraiseQueueBatch', () => {
  it('writes a matched event to Monday, links the donor, and marks it written', async () => {
    const eventStore: EventStore = {
      insertEvent: vi.fn(),
      updateStatus: vi.fn().mockResolvedValue(undefined),
      getEvent: vi.fn().mockResolvedValue(eventRow()),
    };
    const createItem = vi.fn().mockResolvedValue({ id: 'item-1' });
    const mondayClient: MondayClient = {
      findItemByColumnValue: vi.fn(),
      createItem,
      changeColumnValues: vi.fn(),
    };
    const message = fakeMessage('evt-1');

    await processFunraiseQueueBatch([message], { eventStore, mondayClient, config });

    expect(createItem).toHaveBeenCalledWith(111, 'Funraise transaction', {
      numeric_col: 100,
      connect_col: { item_ids: [1] },
    });
    expect(eventStore.updateStatus).toHaveBeenCalledWith('evt-1', 'written', {
      mondayItemId: 'item-1',
      writtenAt: expect.any(String),
    });
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('uses the description field as the item name when present', async () => {
    const eventStore: EventStore = {
      insertEvent: vi.fn(),
      updateStatus: vi.fn().mockResolvedValue(undefined),
      getEvent: vi.fn().mockResolvedValue(
        eventRow({ rawPayload: JSON.stringify({ amount: 50, description: 'Monthly gift' }) })
      ),
    };
    const createItem = vi.fn().mockResolvedValue({ id: 'item-2' });
    const mondayClient: MondayClient = { findItemByColumnValue: vi.fn(), createItem, changeColumnValues: vi.fn() };

    await processFunraiseQueueBatch([fakeMessage('evt-1')], { eventStore, mondayClient, config });

    expect(createItem).toHaveBeenCalledWith(111, 'Monthly gift', expect.any(Object));
  });

  it('routes subscription and pledge to the recurring-gifts board', async () => {
    const eventStore: EventStore = {
      insertEvent: vi.fn(),
      updateStatus: vi.fn().mockResolvedValue(undefined),
      getEvent: vi.fn().mockResolvedValue(eventRow({ entityType: 'pledge' })),
    };
    const createItem = vi.fn().mockResolvedValue({ id: 'item-3' });
    const mondayClient: MondayClient = { findItemByColumnValue: vi.fn(), createItem, changeColumnValues: vi.fn() };

    await processFunraiseQueueBatch([fakeMessage('evt-1')], { eventStore, mondayClient, config });

    expect(createItem).toHaveBeenCalledWith(222, expect.any(String), expect.any(Object));
  });

  it('marks the event failed and retries the message on a Monday write failure', async () => {
    const eventStore: EventStore = {
      insertEvent: vi.fn(),
      updateStatus: vi.fn().mockResolvedValue(undefined),
      getEvent: vi.fn().mockResolvedValue(eventRow()),
    };
    const mondayClient: MondayClient = {
      findItemByColumnValue: vi.fn(),
      createItem: vi.fn().mockRejectedValue(new Error('monday API: HTTP 500')),
      changeColumnValues: vi.fn(),
    };
    const message = fakeMessage('evt-1');

    await processFunraiseQueueBatch([message], { eventStore, mondayClient, config });

    expect(eventStore.updateStatus).toHaveBeenCalledWith('evt-1', 'failed', { error: 'monday API: HTTP 500' });
    expect(message.retry).toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('fails and retries when the D1 row is missing', async () => {
    const eventStore: EventStore = {
      insertEvent: vi.fn(),
      updateStatus: vi.fn().mockResolvedValue(undefined),
      getEvent: vi.fn().mockResolvedValue(null),
    };
    const mondayClient: MondayClient = { findItemByColumnValue: vi.fn(), createItem: vi.fn(), changeColumnValues: vi.fn() };
    const message = fakeMessage('missing-evt');

    await processFunraiseQueueBatch([message], { eventStore, mondayClient, config });

    expect(message.retry).toHaveBeenCalled();
    expect(eventStore.updateStatus).toHaveBeenCalledWith('missing-evt', 'failed', { error: expect.any(String) });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- processBatch.test.ts`
Expected: FAIL — `./processBatch` module not found.

- [ ] **Step 3: Write `funraise-sync/src/consumer/processBatch.ts`**

```typescript
import type { EventStore } from '../db/events';
import type { MondayClient } from '../monday/client';
import type { EntityType, FunraiseSyncConfig } from '../types';
import { mapToMondayColumns } from '../mapping/fieldMap';

export interface QueueMessageLike<T> {
  body: T;
  ack(): void;
  retry(): void;
}

export interface FunraiseQueueMessage {
  eventId: string;
}

export interface ProcessBatchDeps {
  eventStore: EventStore;
  mondayClient: MondayClient;
  config: FunraiseSyncConfig;
}

type BoardKey = keyof FunraiseSyncConfig['monday']['boards'];

const BOARD_FOR_ENTITY: Record<EntityType, BoardKey> = {
  transaction: 'donations:live',
  subscription: 'recurring-gifts',
  pledge: 'recurring-gifts',
  registration: 'event-registrations',
};

export async function processFunraiseQueueBatch(
  messages: QueueMessageLike<FunraiseQueueMessage>[],
  deps: ProcessBatchDeps
): Promise<void> {
  for (const message of messages) {
    try {
      await processOne(message.body.eventId, deps);
      message.ack();
    } catch (err) {
      await deps.eventStore.updateStatus(message.body.eventId, 'failed', {
        error: (err as Error).message,
      });
      message.retry();
    }
  }
}

async function processOne(eventId: string, deps: ProcessBatchDeps): Promise<void> {
  const event = await deps.eventStore.getEvent(eventId);
  if (event === null) {
    throw new Error(`funraise-sync consumer: no event row for "${eventId}"`);
  }

  const boardKey = BOARD_FOR_ENTITY[event.entityType];
  const boardId = deps.config.monday.boards[boardKey];
  if (boardId === null) {
    throw new Error(`config: monday.boards["${boardKey}"] is not configured`);
  }

  const rawPayload = JSON.parse(event.rawPayload) as Record<string, unknown>;
  const columnValues = mapToMondayColumns(event.entityType, rawPayload, deps.config);
  if (event.matchedDonorItemId) {
    columnValues[deps.config.funraiseSync.donorLinkColumn] = {
      item_ids: [Number(event.matchedDonorItemId)],
    };
  }

  const item = await deps.mondayClient.createItem(boardId, describeItemName(event.entityType, rawPayload), columnValues);

  await deps.eventStore.updateStatus(eventId, 'written', {
    mondayItemId: item.id,
    writtenAt: new Date().toISOString(),
  });
}

function describeItemName(entityType: EntityType, rawPayload: Record<string, unknown>): string {
  const description = rawPayload.description;
  return typeof description === 'string' && description.length > 0 ? description : `Funraise ${entityType}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- processBatch.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/consumer
git commit -m "feat(funraise-sync): queue consumer writes matched events to Monday"
```

---

### Task 10: Wire the real Worker entry point

**Files:**
- Modify: `funraise-sync/src/index.ts`
- Test: `funraise-sync/src/index.test.ts` (extend the Task 1 file)

**Interfaces:**
- Consumes: everything produced by Tasks 2–9 (`validateConfig`, `D1EventStore`, `HttpMondayClient`, `createApp`, `processFunraiseQueueBatch`)

- [ ] **Step 1: Extend the failing test — append to `funraise-sync/src/index.test.ts`**

```typescript
import worker from './index';

describe('worker entry point', () => {
  it('exposes fetch and queue handlers', () => {
    expect(typeof worker.fetch).toBe('function');
    expect(typeof worker.queue).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- index.test.ts`
Expected: FAIL — `worker.queue` is undefined (current `index.ts` only exports `fetch`).

- [ ] **Step 3: Rewrite `funraise-sync/src/index.ts`**

```typescript
import rawConfig from '../config/svbc.json';
import { validateConfig } from './config';
import { createApp } from './webhook/route';
import { D1EventStore } from './db/events';
import { HttpMondayClient } from './monday/client';
import { processFunraiseQueueBatch, type FunraiseQueueMessage } from './consumer/processBatch';
import type { Env } from './types';

const config = validateConfig(rawConfig);

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const app = createApp({
      eventStore: new D1EventStore(env.DB),
      mondayClient: new HttpMondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN),
      config,
      queue: env.WRITE_QUEUE,
    });
    return app.fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch<FunraiseQueueMessage>, env: Env): Promise<void> {
    await processFunraiseQueueBatch(batch.messages, {
      eventStore: new D1EventStore(env.DB),
      mondayClient: new HttpMondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN),
      config,
    });
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS, every test file in the project (scaffold, config, events, client, validate, fieldMap, donors, route, processBatch, index).

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/index.test.ts
git commit -m "feat(funraise-sync): wire real D1/Monday/Queue implementations into the Worker entry point"
```

- [ ] **Step 7: Provision real infrastructure (manual, one-time, against SVBC's Cloudflare account)**

Not part of the automated test suite — run these once before the first `wrangler deploy`, then paste the resulting `database_id` into `wrangler.jsonc`:

```bash
wrangler d1 create svbc-funraise-sync
wrangler queues create funraise-sync-writes
wrangler queues create funraise-sync-writes-dlq
wrangler secret put MONDAY_API_TOKEN
```

- [ ] **Step 8: Manual smoke test with `wrangler dev`**

Run: `npm run dev`, then in a second terminal:

```bash
curl -X POST http://localhost:8787/webhooks/funraise/transaction \
  -H 'Content-Type: application/json' \
  -d '{"id":"smoke-1","amount":100,"donor":{"contactId":"fr-smoke","email":"smoke@example.org"}}'
```

Expected: `{"ok":true}` — confirms the full local D1 + Queue + Hono wiring runs end to end before any real Monday credentials are involved. Real Monday writes still need a working `MONDAY_API_TOKEN` and confirmed board/column ids from Step 7 of Task 4's verification note.

- [ ] **Step 9: Note the outstanding manual follow-up (not code, don't skip)**

Set up a native Slack automation that pings on a message landing in `funraise-sync-writes-dlq`, per the root README's reliability guidance — this is a Monday/Cloudflare dashboard configuration step, not a code change, and isn't covered by this plan's automated tasks.

---

## Self-Review

**Spec coverage:**
- Architecture (webhook handler → D1 → Queue → consumer) — Tasks 1, 3, 8, 9, 10.
- Entity routing (Transaction/Subscription+Pledge/Registration → boards) — Task 9 (`BOARD_FOR_ENTITY`), config in Task 2.
- Donor matching (external id → email → auto-create) — Task 7.
- D1 `events` schema and dedup-by-`event_id` — Tasks 1, 3.
- Config-driven field mapping + PII guarantee — Tasks 2, 6.
- Webhook auth (handshake-only, URL-as-credential, dedup makes replay harmless) — Task 8 (handshake echo), Task 3 (dedup).
- Error handling & reliability (Queue retry/DLQ, malformed payload returns 200, DLQ Slack ping) — Tasks 9, 10 (Step 9).
- Testing (unit tests per module, D1 via `@cloudflare/vitest-plugin`, no live Funraise/Monday calls in CI) — every task.
- Open items (Registration board, real field names) — carried as explicit `null`/placeholder config values, never hardcoded.

**Placeholder scan:** No "TBD"/"implement later" in any step. `config/svbc.json`'s Funraise field names and Monday column IDs are intentionally illustrative placeholders — this is the spec's approved config-stub design, not an unresolved plan gap, and every consumer of those values reads them from config rather than hardcoding them.

**Type consistency:** `EventStore`, `MondayClient`, `FunraiseSyncConfig`, `EntityType`, and `EventRow` are defined once (Tasks 1, 3, 4) and referenced with the same names and shapes in every later task — checked across Tasks 7, 8, 9, 10.
