# quickbooks-sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `quickbooks-sync` Cloudflare Worker that syncs QuickBooks Online Customers/Invoices/Products to Monday.com boards, and bidirectionally creates a QuickBooks Customer when a new Organization is created on Monday.

**Architecture:** Two independent Hono webhook routes (QuickBooks change-notification, Monday board-automation) feed one D1 database and one Cloudflare Queue. The QuickBooks route dedupes, fetches the real record via the QuickBooks API, and enqueues a `qb-to-monday` message. The Monday route dedupes, skips items already linked in `qb_monday_map`, and enqueues a `monday-to-qb` message. One queue consumer branches on message direction: `qb-to-monday` upserts a Monday item via the identity map (QuickBooks always wins on conflict — it only ever overwrites, Monday never triggers an update back); `monday-to-qb` only ever creates a new QuickBooks Customer, then records the new mapping. QuickBooks OAuth access tokens are refreshed on demand from a D1-stored refresh token.

**Tech Stack:** Hono + TypeScript + Cloudflare D1 + Cloudflare Queues, Vitest with `@cloudflare/vitest-plugin` for tests that touch D1, `wrangler` for dev/deploy.

**Spec:** [`docs/superpowers/specs/2026-08-22-quickbooks-sync-design.md`](../specs/2026-08-22-quickbooks-sync-design.md)

## Global Constraints

- Package versions pinned to match the sibling `funraise-sync` Worker already in this repo: `hono@^4.13.3`, `typescript@^7.0.2`, `vitest@^4.1.11`, `wrangler@^4.125.0`, `@cloudflare/workers-types@^5.20260822.1`, `@cloudflare/vitest-plugin@^1.0.0`.
- TypeScript: `strict: true`, `noUncheckedIndexedAccess: true`, `target/module: ES2022`, `moduleResolution: Bundler` — matches every existing Worker's `tsconfig.json`.
- No new runtime validation library (no zod, etc.) — hand-rolled validators with descriptive thrown errors, matching `funraise-sync/src/config.ts`'s existing pattern.
- `MONDAY_API_TOKEN`, `QB_CLIENT_ID`, `QB_CLIENT_SECRET`, and `QB_WEBHOOK_VERIFIER_TOKEN` are all secrets via `wrangler secret put` — never written to `config/svbc.json` or logged, per the spec's Auth section.
- Monday → QuickBooks only ever **creates** new Customers — an item already linked in `qb_monday_map` is skipped at the webhook handler, never queued as an update. This is the actual mechanism behind the spec's Conflict Policy ("QuickBooks wins"), not just a policy note — there is no code path that pushes a Monday edit as a QuickBooks update.
- All Monday board ids and QuickBooks↔Monday column mappings are config-driven (`config/svbc.json`), never hardcoded — the spec's target-board decision is still open, so every board id starts `null`.
- The exact monday.com automation-webhook payload shape and QuickBooks's webhook signature scheme are both implemented here from current public documentation but unverified against a live account/app — flagged inline at the relevant task, same treatment the spec gives this uncertainty.

---

## File structure

```
quickbooks-sync/
  wrangler.jsonc                        # Worker + D1 + Queues config
  package.json
  tsconfig.json
  config/svbc.json                      # quickbooksSync config slice: board ids, column maps
  migrations/0001_create_tables.sql     # qb_events, monday_events, qb_monday_map, qb_oauth_tokens
  vitest.config.ts
  test/apply-migrations.ts
  test/env.d.ts
  src/
    types.ts                            # EntityType, SyncStatus, row types, Config, Env, QueueMessage
    config.ts                           # validateConfig
    config.test.ts
    db/
      map.ts                            # MapStore + D1MapStore (qb_monday_map)
      map.test.ts
      qbEvents.ts                       # QbEventStore + D1QbEventStore (qb_events)
      qbEvents.test.ts
      mondayEvents.ts                   # MondayEventStore + D1MondayEventStore (monday_events)
      mondayEvents.test.ts
    quickbooks/
      tokenStore.ts                     # QbTokens, TokenStore + D1TokenStore (qb_oauth_tokens)
      tokenStore.test.ts
      client.ts                         # QuickBooksClient + HttpQuickBooksClient (OAuth refresh, getEntity, createCustomer)
      client.test.ts
      webhook/
        validate.ts                     # parseQbNotifications, verifyQbSignature
        validate.test.ts
        route.ts                        # createQbWebhookApp(deps)
        route.test.ts
    monday/
      client.ts                         # MondayClient + HttpMondayClient (createItem, changeColumnValues)
      client.test.ts
      webhook/
        validate.ts                     # isChallengeRequest, validateMondayEvent
        validate.test.ts
        route.ts                        # createMondayWebhookApp(deps)
        route.test.ts
    mapping/
      fieldMap.ts                       # mapQbToMondayColumns, mapMondayToQbCustomerFields, getPath
      fieldMap.test.ts
    consumer/
      processBatch.ts                   # processSyncQueueBatch (both directions)
      processBatch.test.ts
    index.ts                            # wires real D1/QuickBooks/Monday/Queue into both apps + queue() handler
```

One clear responsibility per file: the two webhook routes never call the QuickBooks/Monday API clients directly for anything beyond what their own direction needs (the QuickBooks route only ever reads via `getEntity`; the Monday route never touches either API client at all — it just records the event and enqueues), and `consumer/processBatch.ts` is the only place both API clients and `mapping/fieldMap.ts` meet.

---

### Task 1: Project scaffold

**Files:**
- Create: `quickbooks-sync/wrangler.jsonc`
- Create: `quickbooks-sync/package.json`
- Create: `quickbooks-sync/tsconfig.json`
- Create: `quickbooks-sync/migrations/0001_create_tables.sql`
- Create: `quickbooks-sync/vitest.config.ts`
- Create: `quickbooks-sync/test/apply-migrations.ts`
- Create: `quickbooks-sync/test/env.d.ts`
- Create: `quickbooks-sync/src/types.ts`
- Create: `quickbooks-sync/src/index.ts`
- Test: `quickbooks-sync/src/index.test.ts`

**Interfaces:**
- Produces: `EntityType`, `SyncStatus`, `Env` (from `src/types.ts`) — consumed by every later task.

- [ ] **Step 1: Create `quickbooks-sync/package.json`**

```json
{
  "name": "quickbooks-sync",
  "version": "0.1.0",
  "description": "QuickBooks Online Customers/Invoices/Products ↔ Monday.com sync.",
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

- [ ] **Step 2: Create `quickbooks-sync/tsconfig.json`**

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
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-plugin/types"]
  },
  "include": ["src", "config", "test"]
}
```

`@cloudflare/vitest-plugin/types` (not just `@cloudflare/workers-types`) is required in this array for `tsc --noEmit` to resolve `cloudflare:test`/`cloudflare:workers` in `test/apply-migrations.ts` and any test file that imports from `cloudflare:workers` — confirmed by SDD Task 1's review loop (ledger: 2026-08-22).

- [ ] **Step 3: Create `quickbooks-sync/migrations/0001_create_tables.sql`**

```sql
CREATE TABLE qb_oauth_tokens (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  realm_id TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  access_token_expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE qb_monday_map (
  entity_type TEXT NOT NULL,
  qb_id TEXT NOT NULL,
  monday_item_id TEXT NOT NULL,
  monday_board_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (entity_type, qb_id)
);

CREATE UNIQUE INDEX qb_monday_map_monday_item_idx ON qb_monday_map (entity_type, monday_item_id);

CREATE TABLE qb_events (
  event_id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  qb_id TEXT NOT NULL,
  fetched_payload TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  error TEXT,
  received_at TEXT NOT NULL,
  written_at TEXT
);

CREATE TABLE monday_events (
  event_id TEXT PRIMARY KEY,
  monday_item_id TEXT NOT NULL,
  raw_payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received',
  qb_id TEXT,
  error TEXT,
  received_at TEXT NOT NULL,
  written_at TEXT
);
```

- [ ] **Step 4: Create `quickbooks-sync/wrangler.jsonc`**

```jsonc
{
  "name": "svbc-quickbooks-sync",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-01",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "svbc-quickbooks-sync",
      // Replace after running: wrangler d1 create svbc-quickbooks-sync
      "database_id": "REPLACE_AFTER_WRANGLER_D1_CREATE",
      "migrations_dir": "migrations"
    }
  ],
  "queues": {
    "producers": [{ "queue": "quickbooks-sync-writes", "binding": "SYNC_QUEUE" }],
    "consumers": [
      {
        "queue": "quickbooks-sync-writes",
        "max_retries": 3,
        "dead_letter_queue": "quickbooks-sync-writes-dlq"
      }
    ]
  }
}
```

- [ ] **Step 5: Create `quickbooks-sync/src/types.ts`**

```typescript
export type EntityType = 'customer' | 'invoice' | 'product';
export type SyncStatus = 'received' | 'fetched' | 'queued' | 'written' | 'failed';

export interface QbEventRow {
  eventId: string;
  entityType: EntityType;
  qbId: string;
  fetchedPayload: string | null;
  status: SyncStatus;
  error: string | null;
  receivedAt: string;
  writtenAt: string | null;
}

export interface MondayEventRow {
  eventId: string;
  mondayItemId: string;
  rawPayload: string;
  status: SyncStatus;
  qbId: string | null;
  error: string | null;
  receivedAt: string;
  writtenAt: string | null;
}

export interface MapEntry {
  entityType: EntityType;
  qbId: string;
  mondayItemId: string;
  mondayBoardId: number;
  createdAt: string;
}

export interface MondayBoards {
  customers: number | null;
  invoices: number | null;
  products: number | null;
}

export interface QuickbooksSyncConfig {
  monday: {
    apiUrl: string;
    boards: MondayBoards;
  };
  quickbooksSync: {
    columnMap: {
      customer: Record<string, string>;
      invoice: Record<string, string>;
      product: Record<string, string>;
    };
    itemNameField: {
      customer: string;
      invoice: string;
      product: string;
    };
    linkColumn: {
      invoice: string;
    };
    customerCreateFieldMap: Record<string, string>;
  };
}

export type QueueMessage =
  | { direction: 'qb-to-monday'; eventId: string }
  | { direction: 'monday-to-qb'; eventId: string };

export interface Env {
  DB: D1Database;
  SYNC_QUEUE: Queue<QueueMessage>;
  MONDAY_API_TOKEN: string;
  QB_CLIENT_ID: string;
  QB_CLIENT_SECRET: string;
  QB_WEBHOOK_VERIFIER_TOKEN: string;
}
```

- [ ] **Step 6: Create `quickbooks-sync/src/index.ts`** (temporary minimal health check — Task 15 replaces this with the full wiring)

```typescript
import { Hono } from 'hono';
import type { Env } from './types';

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ ok: true }));

export default {
  fetch: app.fetch,
};
```

- [ ] **Step 7: Create `quickbooks-sync/vitest.config.ts`**

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

- [ ] **Step 8: Create `quickbooks-sync/test/apply-migrations.ts`**

```typescript
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

- [ ] **Step 9: Create `quickbooks-sync/test/env.d.ts`**

Plain ambient script (no top-level `import`/`export`), same reasoning as `funraise-sync/test/env.d.ts`: `@cloudflare/vitest-plugin` types `cloudflare:test`'s `env` export against the global `Cloudflare.Env` namespace, and a top-level `import` would turn this file into a module and break the global-namespace merge.

```typescript
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    SYNC_QUEUE: Queue<{ direction: 'qb-to-monday' | 'monday-to-qb'; eventId: string }>;
    MONDAY_API_TOKEN: string;
    QB_CLIENT_ID: string;
    QB_CLIENT_SECRET: string;
    QB_WEBHOOK_VERIFIER_TOKEN: string;
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}
```

These fields are duplicated from `src/types.ts`'s `Env`/`QueueMessage` rather than imported — keep the two in sync by hand if either changes.

- [ ] **Step 10: Write the failing test — `quickbooks-sync/src/index.test.ts`**

```typescript
import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';

describe('scaffold', () => {
  it('applies all four table migrations', async () => {
    for (const table of ['qb_oauth_tokens', 'qb_monday_map', 'qb_events', 'monday_events']) {
      const result = await env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?1"
      )
        .bind(table)
        .first();
      expect(result, `expected table "${table}" to exist`).not.toBeNull();
    }
  });
});
```

- [ ] **Step 11: Install dependencies and run the test**

Run: `cd quickbooks-sync && npm install && npm test`
Expected: PASS — `@cloudflare/vitest-plugin` provisions its own local D1 automatically, so `wrangler d1 create` isn't needed for local tests. If it fails with a binding error, verify `wrangler.jsonc`'s `d1_databases[0].database_id` is present (any placeholder string is fine for local test-only runs).

- [ ] **Step 12: Run typecheck**

Run: `npm run typecheck`
Expected: PASS, no errors.

- [ ] **Step 13: Commit**

```bash
cd quickbooks-sync
git add wrangler.jsonc package.json tsconfig.json migrations vitest.config.ts test src
git commit -m "feat(quickbooks-sync): project scaffold with D1-backed test harness"
```

---

### Task 2: Config loading and validation

**Files:**
- Create: `quickbooks-sync/config/svbc.json`
- Create: `quickbooks-sync/src/config.ts`
- Test: `quickbooks-sync/src/config.test.ts`

**Interfaces:**
- Consumes: `QuickbooksSyncConfig` (from Task 1's `src/types.ts`)
- Produces: `validateConfig(raw: unknown): QuickbooksSyncConfig`, consumed by `src/index.ts` (Task 15) and by every test file needing a valid config fixture.

- [ ] **Step 1: Create `quickbooks-sync/config/svbc.json`**

All Monday board ids are `null` — per the spec's Open Questions, which existing board(s) Customers should target (Organizations, Donors, or something else) is an explicit open decision for SVBC, and Invoices/Products need new boards created regardless. All QuickBooks field names and Monday column ids below are illustrative placeholders, filled in once SVBC decides.

```json
{
  "monday": {
    "apiUrl": "https://api.monday.com/v2",
    "boards": {
      "customers": null,
      "invoices": null,
      "products": null
    }
  },
  "quickbooksSync": {
    "columnMap": {
      "customer": {
        "DisplayName": "text_column_id",
        "PrimaryEmailAddr.Address": "email_column_id",
        "PrimaryPhone.FreeFormNumber": "phone_column_id"
      },
      "invoice": {
        "DocNumber": "text_column_id",
        "TotalAmt": "numeric_column_id",
        "Balance": "numeric_column_id",
        "DueDate": "date_column_id"
      },
      "product": {
        "Name": "text_column_id",
        "UnitPrice": "numeric_column_id"
      }
    },
    "itemNameField": {
      "customer": "DisplayName",
      "invoice": "DocNumber",
      "product": "Name"
    },
    "linkColumn": {
      "invoice": "connect_boards_column_id"
    },
    "customerCreateFieldMap": {
      "text_column_id": "DisplayName",
      "email_column_id": "PrimaryEmailAddr.Address"
    }
  }
}
```

- [ ] **Step 2: Write the failing test — `quickbooks-sync/src/config.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { validateConfig } from './config';

const validConfig = {
  monday: {
    apiUrl: 'https://api.monday.com/v2',
    boards: { customers: null, invoices: null, products: null },
  },
  quickbooksSync: {
    columnMap: {
      customer: { DisplayName: 'text_col' },
      invoice: { DocNumber: 'text_col' },
      product: { Name: 'text_col' },
    },
    itemNameField: { customer: 'DisplayName', invoice: 'DocNumber', product: 'Name' },
    linkColumn: { invoice: 'connect_col' },
    customerCreateFieldMap: { text_col: 'DisplayName' },
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
    const { customers: _drop, ...boards } = validConfig.monday.boards;
    const broken = { ...validConfig, monday: { ...validConfig.monday, boards } };
    expect(() => validateConfig(broken)).toThrow(/customers/);
  });

  it('throws when quickbooksSync is missing', () => {
    const { quickbooksSync, ...missing } = validConfig;
    expect(() => validateConfig(missing)).toThrow(/quickbooksSync/);
  });

  it('throws when a required quickbooksSync key is missing', () => {
    const { linkColumn, ...rest } = validConfig.quickbooksSync;
    const broken = { ...validConfig, quickbooksSync: rest };
    expect(() => validateConfig(broken)).toThrow(/linkColumn/);
  });

  it('throws when columnMap is missing an entity key', () => {
    const { customer, ...columnMap } = validConfig.quickbooksSync.columnMap;
    const broken = {
      ...validConfig,
      quickbooksSync: { ...validConfig.quickbooksSync, columnMap },
    };
    expect(() => validateConfig(broken)).toThrow(/columnMap.customer/);
  });

  it('throws when itemNameField is missing an entity key', () => {
    const { invoice, ...itemNameField } = validConfig.quickbooksSync.itemNameField;
    const broken = {
      ...validConfig,
      quickbooksSync: { ...validConfig.quickbooksSync, itemNameField },
    };
    expect(() => validateConfig(broken)).toThrow(/itemNameField.invoice/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- config.test.ts`
Expected: FAIL — `validateConfig` is not defined.

- [ ] **Step 4: Write `quickbooks-sync/src/config.ts`**

```typescript
import type { QuickbooksSyncConfig } from './types';

const REQUIRED_BOARD_KEYS = ['customers', 'invoices', 'products'] as const;
const REQUIRED_QUICKBOOKS_SYNC_KEYS = [
  'columnMap',
  'itemNameField',
  'linkColumn',
  'customerCreateFieldMap',
] as const;
const REQUIRED_ENTITY_KEYS = ['customer', 'invoice', 'product'] as const;

export function validateConfig(raw: unknown): QuickbooksSyncConfig {
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

  if (typeof cfg.quickbooksSync !== 'object' || cfg.quickbooksSync === null) {
    throw new Error('config: missing required key "quickbooksSync"');
  }
  const quickbooksSync = cfg.quickbooksSync as Record<string, unknown>;

  for (const key of REQUIRED_QUICKBOOKS_SYNC_KEYS) {
    if (!(key in quickbooksSync)) {
      throw new Error(`config: missing required key "quickbooksSync.${key}"`);
    }
  }

  if (typeof quickbooksSync.columnMap !== 'object' || quickbooksSync.columnMap === null) {
    throw new Error('config: missing required key "quickbooksSync.columnMap"');
  }
  const columnMap = quickbooksSync.columnMap as Record<string, unknown>;
  for (const key of REQUIRED_ENTITY_KEYS) {
    if (!(key in columnMap)) {
      throw new Error(`config: missing required key "quickbooksSync.columnMap.${key}"`);
    }
  }

  if (typeof quickbooksSync.itemNameField !== 'object' || quickbooksSync.itemNameField === null) {
    throw new Error('config: missing required key "quickbooksSync.itemNameField"');
  }
  const itemNameField = quickbooksSync.itemNameField as Record<string, unknown>;
  for (const key of REQUIRED_ENTITY_KEYS) {
    if (!(key in itemNameField)) {
      throw new Error(`config: missing required key "quickbooksSync.itemNameField.${key}"`);
    }
  }

  return cfg as unknown as QuickbooksSyncConfig;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- config.test.ts`
Expected: PASS, all 7 assertions.

- [ ] **Step 6: Commit**

```bash
git add config/svbc.json src/config.ts src/config.test.ts
git commit -m "feat(quickbooks-sync): config loading and validation"
```

---

### Task 3: D1 identity map store (`qb_monday_map`)

**Files:**
- Create: `quickbooks-sync/src/db/map.ts`
- Test: `quickbooks-sync/src/db/map.test.ts`

**Interfaces:**
- Consumes: `EntityType`, `MapEntry` (from `src/types.ts`)
- Produces: `MapStore` interface, `D1MapStore` class — consumed by `monday/webhook/route.ts` (Task 13) and `consumer/processBatch.ts` (Task 14).

- [ ] **Step 1: Write the failing test — `quickbooks-sync/src/db/map.test.ts`**

```typescript
import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1MapStore } from './map';

describe('D1MapStore', () => {
  it('creates a mapping and reads it back by qbId and by mondayItemId', async () => {
    const store = new D1MapStore(env.DB);
    await store.createMapping({
      entityType: 'customer',
      qbId: 'qb-1',
      mondayItemId: 'item-1',
      mondayBoardId: 111,
      createdAt: '2026-08-22T00:00:00.000Z',
    });

    const byQbId = await store.getByQbId('customer', 'qb-1');
    expect(byQbId).toEqual({
      entityType: 'customer',
      qbId: 'qb-1',
      mondayItemId: 'item-1',
      mondayBoardId: 111,
      createdAt: '2026-08-22T00:00:00.000Z',
    });

    const byMondayItemId = await store.getByMondayItemId('customer', 'item-1');
    expect(byMondayItemId).toEqual(byQbId);
  });

  it('returns null for an unknown qbId or mondayItemId', async () => {
    const store = new D1MapStore(env.DB);
    expect(await store.getByQbId('customer', 'does-not-exist')).toBeNull();
    expect(await store.getByMondayItemId('customer', 'does-not-exist')).toBeNull();
  });

  it('does not cross-match entity types sharing the same id', async () => {
    const store = new D1MapStore(env.DB);
    await store.createMapping({
      entityType: 'customer',
      qbId: 'shared-id',
      mondayItemId: 'item-a',
      mondayBoardId: 1,
      createdAt: '2026-08-22T00:00:00.000Z',
    });
    expect(await store.getByQbId('invoice', 'shared-id')).toBeNull();
  });

  it('upserts on a second createMapping call for the same entityType/qbId', async () => {
    const store = new D1MapStore(env.DB);
    await store.createMapping({
      entityType: 'product',
      qbId: 'qb-2',
      mondayItemId: 'item-2',
      mondayBoardId: 1,
      createdAt: '2026-08-22T00:00:00.000Z',
    });
    await store.createMapping({
      entityType: 'product',
      qbId: 'qb-2',
      mondayItemId: 'item-2-moved',
      mondayBoardId: 2,
      createdAt: '2026-08-22T01:00:00.000Z',
    });

    const result = await store.getByQbId('product', 'qb-2');
    expect(result?.mondayItemId).toBe('item-2-moved');
    expect(result?.mondayBoardId).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- map.test.ts`
Expected: FAIL — `./map` module not found.

- [ ] **Step 3: Write `quickbooks-sync/src/db/map.ts`**

```typescript
import type { EntityType, MapEntry } from '../types';

export interface MapStore {
  getByQbId(entityType: EntityType, qbId: string): Promise<MapEntry | null>;
  getByMondayItemId(entityType: EntityType, mondayItemId: string): Promise<MapEntry | null>;
  createMapping(entry: MapEntry): Promise<void>;
}

interface D1MapRecord {
  entity_type: EntityType;
  qb_id: string;
  monday_item_id: string;
  monday_board_id: number;
  created_at: string;
}

function toMapEntry(record: D1MapRecord): MapEntry {
  return {
    entityType: record.entity_type,
    qbId: record.qb_id,
    mondayItemId: record.monday_item_id,
    mondayBoardId: record.monday_board_id,
    createdAt: record.created_at,
  };
}

const SELECT_COLUMNS = 'entity_type, qb_id, monday_item_id, monday_board_id, created_at';

export class D1MapStore implements MapStore {
  constructor(private db: D1Database) {}

  async getByQbId(entityType: EntityType, qbId: string): Promise<MapEntry | null> {
    const record = await this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM qb_monday_map WHERE entity_type = ?1 AND qb_id = ?2`)
      .bind(entityType, qbId)
      .first<D1MapRecord>();
    return record === null ? null : toMapEntry(record);
  }

  async getByMondayItemId(entityType: EntityType, mondayItemId: string): Promise<MapEntry | null> {
    const record = await this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM qb_monday_map WHERE entity_type = ?1 AND monday_item_id = ?2`)
      .bind(entityType, mondayItemId)
      .first<D1MapRecord>();
    return record === null ? null : toMapEntry(record);
  }

  async createMapping(entry: MapEntry): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO qb_monday_map (entity_type, qb_id, monday_item_id, monday_board_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (entity_type, qb_id) DO UPDATE SET
           monday_item_id = excluded.monday_item_id,
           monday_board_id = excluded.monday_board_id`
      )
      .bind(entry.entityType, entry.qbId, entry.mondayItemId, entry.mondayBoardId, entry.createdAt)
      .run();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- map.test.ts`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/db/map.ts src/db/map.test.ts
git commit -m "feat(quickbooks-sync): D1 identity map store (qb_monday_map)"
```

---

### Task 4: D1 QuickBooks event store (`qb_events`)

**Files:**
- Create: `quickbooks-sync/src/db/qbEvents.ts`
- Test: `quickbooks-sync/src/db/qbEvents.test.ts`

**Interfaces:**
- Consumes: `EntityType`, `SyncStatus`, `QbEventRow` (from `src/types.ts`)
- Produces: `QbEventStore` interface, `D1QbEventStore` class, `NewQbEvent`, `QbEventStatusPatch` — consumed by `quickbooks/webhook/route.ts` (Task 11), `consumer/processBatch.ts` (Task 14), and `index.ts` (Task 15).

- [ ] **Step 1: Write the failing test — `quickbooks-sync/src/db/qbEvents.test.ts`**

```typescript
import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1QbEventStore } from './qbEvents';

describe('D1QbEventStore', () => {
  it('inserts a new event and reads it back', async () => {
    const store = new D1QbEventStore(env.DB);
    const result = await store.insertEvent({
      eventId: 'evt-1',
      entityType: 'customer',
      qbId: 'qb-1',
      receivedAt: '2026-08-22T00:00:00.000Z',
    });
    expect(result).toBe('inserted');

    const row = await store.getEvent('evt-1');
    expect(row).toEqual({
      eventId: 'evt-1',
      entityType: 'customer',
      qbId: 'qb-1',
      fetchedPayload: null,
      status: 'received',
      error: null,
      receivedAt: '2026-08-22T00:00:00.000Z',
      writtenAt: null,
    });
  });

  it('reports duplicate on a second insert with the same event id', async () => {
    const store = new D1QbEventStore(env.DB);
    await store.insertEvent({
      eventId: 'evt-2',
      entityType: 'customer',
      qbId: 'qb-2',
      receivedAt: '2026-08-22T00:00:00.000Z',
    });
    const second = await store.insertEvent({
      eventId: 'evt-2',
      entityType: 'customer',
      qbId: 'qb-2',
      receivedAt: '2026-08-22T00:00:01.000Z',
    });
    expect(second).toBe('duplicate');
  });

  it('updates status and patch fields, then clears error on the next update', async () => {
    const store = new D1QbEventStore(env.DB);
    await store.insertEvent({
      eventId: 'evt-3',
      entityType: 'invoice',
      qbId: 'qb-3',
      receivedAt: '2026-08-22T00:00:00.000Z',
    });

    await store.updateStatus('evt-3', 'failed', { error: 'boom' });
    let row = await store.getEvent('evt-3');
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('boom');

    await store.updateStatus('evt-3', 'fetched', { fetchedPayload: '{"Id":"qb-3"}' });
    row = await store.getEvent('evt-3');
    expect(row?.status).toBe('fetched');
    expect(row?.fetchedPayload).toBe('{"Id":"qb-3"}');
    expect(row?.error).toBeNull();

    await store.updateStatus('evt-3', 'written', { writtenAt: '2026-08-22T01:00:00.000Z' });
    row = await store.getEvent('evt-3');
    expect(row?.status).toBe('written');
    expect(row?.writtenAt).toBe('2026-08-22T01:00:00.000Z');
    expect(row?.fetchedPayload).toBe('{"Id":"qb-3"}');
  });

  it('returns null for an unknown event id', async () => {
    const store = new D1QbEventStore(env.DB);
    expect(await store.getEvent('does-not-exist')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- qbEvents.test.ts`
Expected: FAIL — `./qbEvents` module not found.

- [ ] **Step 3: Write `quickbooks-sync/src/db/qbEvents.ts`**

```typescript
import type { EntityType, QbEventRow, SyncStatus } from '../types';

export interface NewQbEvent {
  eventId: string;
  entityType: EntityType;
  qbId: string;
  receivedAt: string;
}

export interface QbEventStatusPatch {
  fetchedPayload?: string;
  error?: string;
  writtenAt?: string;
}

export interface QbEventStore {
  insertEvent(row: NewQbEvent): Promise<'inserted' | 'duplicate'>;
  updateStatus(eventId: string, status: SyncStatus, patch?: QbEventStatusPatch): Promise<void>;
  getEvent(eventId: string): Promise<QbEventRow | null>;
}

interface D1QbEventRecord {
  event_id: string;
  entity_type: EntityType;
  qb_id: string;
  fetched_payload: string | null;
  status: SyncStatus;
  error: string | null;
  received_at: string;
  written_at: string | null;
}

function toQbEventRow(record: D1QbEventRecord): QbEventRow {
  return {
    eventId: record.event_id,
    entityType: record.entity_type,
    qbId: record.qb_id,
    fetchedPayload: record.fetched_payload,
    status: record.status,
    error: record.error,
    receivedAt: record.received_at,
    writtenAt: record.written_at,
  };
}

export class D1QbEventStore implements QbEventStore {
  constructor(private db: D1Database) {}

  async insertEvent(row: NewQbEvent): Promise<'inserted' | 'duplicate'> {
    const result = await this.db
      .prepare(
        `INSERT INTO qb_events (event_id, entity_type, qb_id, status, received_at)
         VALUES (?1, ?2, ?3, 'received', ?4)
         ON CONFLICT (event_id) DO NOTHING`
      )
      .bind(row.eventId, row.entityType, row.qbId, row.receivedAt)
      .run();
    return result.meta.changes > 0 ? 'inserted' : 'duplicate';
  }

  async updateStatus(eventId: string, status: SyncStatus, patch: QbEventStatusPatch = {}): Promise<void> {
    await this.db
      .prepare(
        `UPDATE qb_events SET
           status = ?2,
           fetched_payload = COALESCE(?3, fetched_payload),
           error = ?4,
           written_at = COALESCE(?5, written_at)
         WHERE event_id = ?1`
      )
      .bind(eventId, status, patch.fetchedPayload ?? null, patch.error ?? null, patch.writtenAt ?? null)
      .run();
  }

  async getEvent(eventId: string): Promise<QbEventRow | null> {
    const record = await this.db
      .prepare(
        `SELECT event_id, entity_type, qb_id, fetched_payload, status, error, received_at, written_at
         FROM qb_events WHERE event_id = ?1`
      )
      .bind(eventId)
      .first<D1QbEventRecord>();
    return record === null ? null : toQbEventRow(record);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- qbEvents.test.ts`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/db/qbEvents.ts src/db/qbEvents.test.ts
git commit -m "feat(quickbooks-sync): D1 QuickBooks event store with dedup-by-event-id"
```

---

### Task 5: D1 Monday event store (`monday_events`)

**Files:**
- Create: `quickbooks-sync/src/db/mondayEvents.ts`
- Test: `quickbooks-sync/src/db/mondayEvents.test.ts`

**Interfaces:**
- Consumes: `SyncStatus`, `MondayEventRow` (from `src/types.ts`)
- Produces: `MondayEventStore` interface, `D1MondayEventStore` class, `NewMondayEvent`, `MondayEventStatusPatch` — consumed by `monday/webhook/route.ts` (Task 13), `consumer/processBatch.ts` (Task 14), and `index.ts` (Task 15).

- [ ] **Step 1: Write the failing test — `quickbooks-sync/src/db/mondayEvents.test.ts`**

```typescript
import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1MondayEventStore } from './mondayEvents';

describe('D1MondayEventStore', () => {
  it('inserts a new event and reads it back', async () => {
    const store = new D1MondayEventStore(env.DB);
    const result = await store.insertEvent({
      eventId: 'item-1',
      mondayItemId: 'item-1',
      rawPayload: '{"text_col":"Acme"}',
      receivedAt: '2026-08-22T00:00:00.000Z',
    });
    expect(result).toBe('inserted');

    const row = await store.getEvent('item-1');
    expect(row).toEqual({
      eventId: 'item-1',
      mondayItemId: 'item-1',
      rawPayload: '{"text_col":"Acme"}',
      status: 'received',
      qbId: null,
      error: null,
      receivedAt: '2026-08-22T00:00:00.000Z',
      writtenAt: null,
    });
  });

  it('reports duplicate on a second insert with the same event id', async () => {
    const store = new D1MondayEventStore(env.DB);
    await store.insertEvent({
      eventId: 'item-2',
      mondayItemId: 'item-2',
      rawPayload: '{}',
      receivedAt: '2026-08-22T00:00:00.000Z',
    });
    const second = await store.insertEvent({
      eventId: 'item-2',
      mondayItemId: 'item-2',
      rawPayload: '{}',
      receivedAt: '2026-08-22T00:00:01.000Z',
    });
    expect(second).toBe('duplicate');
  });

  it('updates status and records the new QuickBooks id once created', async () => {
    const store = new D1MondayEventStore(env.DB);
    await store.insertEvent({
      eventId: 'item-3',
      mondayItemId: 'item-3',
      rawPayload: '{}',
      receivedAt: '2026-08-22T00:00:00.000Z',
    });

    await store.updateStatus('item-3', 'failed', { error: 'boom' });
    let row = await store.getEvent('item-3');
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('boom');

    await store.updateStatus('item-3', 'written', { qbId: 'qb-99', writtenAt: '2026-08-22T01:00:00.000Z' });
    row = await store.getEvent('item-3');
    expect(row?.status).toBe('written');
    expect(row?.qbId).toBe('qb-99');
    expect(row?.writtenAt).toBe('2026-08-22T01:00:00.000Z');
    expect(row?.error).toBeNull();
  });

  it('returns null for an unknown event id', async () => {
    const store = new D1MondayEventStore(env.DB);
    expect(await store.getEvent('does-not-exist')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- mondayEvents.test.ts`
Expected: FAIL — `./mondayEvents` module not found.

- [ ] **Step 3: Write `quickbooks-sync/src/db/mondayEvents.ts`**

```typescript
import type { MondayEventRow, SyncStatus } from '../types';

export interface NewMondayEvent {
  eventId: string;
  mondayItemId: string;
  rawPayload: string;
  receivedAt: string;
}

export interface MondayEventStatusPatch {
  qbId?: string;
  error?: string;
  writtenAt?: string;
}

export interface MondayEventStore {
  insertEvent(row: NewMondayEvent): Promise<'inserted' | 'duplicate'>;
  updateStatus(eventId: string, status: SyncStatus, patch?: MondayEventStatusPatch): Promise<void>;
  getEvent(eventId: string): Promise<MondayEventRow | null>;
}

interface D1MondayEventRecord {
  event_id: string;
  monday_item_id: string;
  raw_payload: string;
  status: SyncStatus;
  qb_id: string | null;
  error: string | null;
  received_at: string;
  written_at: string | null;
}

function toMondayEventRow(record: D1MondayEventRecord): MondayEventRow {
  return {
    eventId: record.event_id,
    mondayItemId: record.monday_item_id,
    rawPayload: record.raw_payload,
    status: record.status,
    qbId: record.qb_id,
    error: record.error,
    receivedAt: record.received_at,
    writtenAt: record.written_at,
  };
}

export class D1MondayEventStore implements MondayEventStore {
  constructor(private db: D1Database) {}

  async insertEvent(row: NewMondayEvent): Promise<'inserted' | 'duplicate'> {
    const result = await this.db
      .prepare(
        `INSERT INTO monday_events (event_id, monday_item_id, raw_payload, status, received_at)
         VALUES (?1, ?2, ?3, 'received', ?4)
         ON CONFLICT (event_id) DO NOTHING`
      )
      .bind(row.eventId, row.mondayItemId, row.rawPayload, row.receivedAt)
      .run();
    return result.meta.changes > 0 ? 'inserted' : 'duplicate';
  }

  async updateStatus(eventId: string, status: SyncStatus, patch: MondayEventStatusPatch = {}): Promise<void> {
    await this.db
      .prepare(
        `UPDATE monday_events SET
           status = ?2,
           qb_id = COALESCE(?3, qb_id),
           error = ?4,
           written_at = COALESCE(?5, written_at)
         WHERE event_id = ?1`
      )
      .bind(eventId, status, patch.qbId ?? null, patch.error ?? null, patch.writtenAt ?? null)
      .run();
  }

  async getEvent(eventId: string): Promise<MondayEventRow | null> {
    const record = await this.db
      .prepare(
        `SELECT event_id, monday_item_id, raw_payload, status, qb_id, error, received_at, written_at
         FROM monday_events WHERE event_id = ?1`
      )
      .bind(eventId)
      .first<D1MondayEventRecord>();
    return record === null ? null : toMondayEventRow(record);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- mondayEvents.test.ts`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/db/mondayEvents.ts src/db/mondayEvents.test.ts
git commit -m "feat(quickbooks-sync): D1 Monday event store with dedup-by-event-id"
```

---

### Task 6: D1 OAuth token store (`qb_oauth_tokens`)

**Files:**
- Create: `quickbooks-sync/src/quickbooks/tokenStore.ts`
- Test: `quickbooks-sync/src/quickbooks/tokenStore.test.ts`

**Interfaces:**
- Produces: `QbTokens`, `TokenStore` interface, `D1TokenStore` class — consumed by `quickbooks/client.ts` (Task 7) and `index.ts` (Task 15).

- [ ] **Step 1: Write the failing test — `quickbooks-sync/src/quickbooks/tokenStore.test.ts`**

```typescript
import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1TokenStore } from './tokenStore';

describe('D1TokenStore', () => {
  it('returns null before any tokens are saved', async () => {
    const store = new D1TokenStore(env.DB);
    expect(await store.getTokens()).toBeNull();
  });

  it('saves and reads back tokens', async () => {
    const store = new D1TokenStore(env.DB);
    await store.saveTokens({
      realmId: 'realm-1',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      accessTokenExpiresAt: '2026-08-22T01:00:00.000Z',
    });

    expect(await store.getTokens()).toEqual({
      realmId: 'realm-1',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      accessTokenExpiresAt: '2026-08-22T01:00:00.000Z',
    });
  });

  it('overwrites the single stored row on a second save', async () => {
    const store = new D1TokenStore(env.DB);
    await store.saveTokens({
      realmId: 'realm-1',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      accessTokenExpiresAt: '2026-08-22T01:00:00.000Z',
    });
    await store.saveTokens({
      realmId: 'realm-1',
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      accessTokenExpiresAt: '2026-08-22T02:00:00.000Z',
    });

    expect(await store.getTokens()).toEqual({
      realmId: 'realm-1',
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      accessTokenExpiresAt: '2026-08-22T02:00:00.000Z',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tokenStore.test.ts`
Expected: FAIL — `./tokenStore` module not found.

- [ ] **Step 3: Write `quickbooks-sync/src/quickbooks/tokenStore.ts`**

```typescript
export interface QbTokens {
  realmId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
}

export interface TokenStore {
  getTokens(): Promise<QbTokens | null>;
  saveTokens(tokens: QbTokens): Promise<void>;
}

interface D1TokenRecord {
  realm_id: string;
  access_token: string;
  refresh_token: string;
  access_token_expires_at: string;
}

export class D1TokenStore implements TokenStore {
  constructor(private db: D1Database) {}

  async getTokens(): Promise<QbTokens | null> {
    const record = await this.db
      .prepare(
        'SELECT realm_id, access_token, refresh_token, access_token_expires_at FROM qb_oauth_tokens WHERE id = 1'
      )
      .first<D1TokenRecord>();
    if (record === null) return null;
    return {
      realmId: record.realm_id,
      accessToken: record.access_token,
      refreshToken: record.refresh_token,
      accessTokenExpiresAt: record.access_token_expires_at,
    };
  }

  async saveTokens(tokens: QbTokens): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO qb_oauth_tokens (id, realm_id, access_token, refresh_token, access_token_expires_at, updated_at)
         VALUES (1, ?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (id) DO UPDATE SET
           realm_id = excluded.realm_id,
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           access_token_expires_at = excluded.access_token_expires_at,
           updated_at = excluded.updated_at`
      )
      .bind(tokens.realmId, tokens.accessToken, tokens.refreshToken, tokens.accessTokenExpiresAt, new Date().toISOString())
      .run();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tokenStore.test.ts`
Expected: PASS, all 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/quickbooks/tokenStore.ts src/quickbooks/tokenStore.test.ts
git commit -m "feat(quickbooks-sync): D1 OAuth token store"
```

---

### Task 7: QuickBooks API client (OAuth-aware fetch + create)

**Files:**
- Create: `quickbooks-sync/src/quickbooks/client.ts`
- Test: `quickbooks-sync/src/quickbooks/client.test.ts`

**Interfaces:**
- Consumes: `TokenStore`, `QbTokens` (Task 6); `EntityType` (Task 1)
- Produces: `QuickBooksClient` interface, `HttpQuickBooksClient` class — consumed by `quickbooks/webhook/route.ts` (Task 11), `consumer/processBatch.ts` (Task 14), and `index.ts` (Task 15).

- [ ] **Step 1: Write the failing test — `quickbooks-sync/src/quickbooks/client.test.ts`**

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { HttpQuickBooksClient } from './client';
import type { TokenStore, QbTokens } from './tokenStore';

function fakeTokenStore(overrides: Partial<TokenStore> = {}): TokenStore {
  return {
    getTokens: vi.fn().mockResolvedValue(null),
    saveTokens: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function mockFetchSequence(responses: Array<{ ok: boolean; status?: number; json: unknown }>) {
  const fetchMock = vi.fn();
  for (const r of responses) {
    fetchMock.mockResolvedValueOnce({ ok: r.ok, status: r.status ?? 200, json: async () => r.json });
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const validTokens: QbTokens = {
  realmId: 'realm-1',
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
};

describe('HttpQuickBooksClient', () => {
  it('fetches an entity using a cached, unexpired access token', async () => {
    const tokenStore = fakeTokenStore({ getTokens: vi.fn().mockResolvedValue(validTokens) });
    const fetchMock = mockFetchSequence([{ ok: true, json: { Customer: { Id: '1', DisplayName: 'Acme' } } }]);
    const client = new HttpQuickBooksClient(tokenStore, 'client-id', 'client-secret');

    const result = await client.getEntity('customer', '1');

    expect(result).toEqual({ Id: '1', DisplayName: 'Acme' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://quickbooks.api.intuit.com/v3/company/realm-1/customer/1');
    expect(tokenStore.saveTokens).not.toHaveBeenCalled();
  });

  it('fetches an invoice using the "Item" path segment for a product', async () => {
    const tokenStore = fakeTokenStore({ getTokens: vi.fn().mockResolvedValue(validTokens) });
    const fetchMock = mockFetchSequence([{ ok: true, json: { Item: { Id: '5', Name: 'Widget' } } }]);
    const client = new HttpQuickBooksClient(tokenStore, 'client-id', 'client-secret');

    const result = await client.getEntity('product', '5');

    expect(result).toEqual({ Id: '5', Name: 'Widget' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://quickbooks.api.intuit.com/v3/company/realm-1/item/5');
  });

  it('refreshes an expired access token before fetching', async () => {
    const expiredTokens: QbTokens = { ...validTokens, accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString() };
    const tokenStore = fakeTokenStore({ getTokens: vi.fn().mockResolvedValue(expiredTokens) });
    const fetchMock = mockFetchSequence([
      { ok: true, json: { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 } },
      { ok: true, json: { Customer: { Id: '1' } } },
    ]);
    const client = new HttpQuickBooksClient(tokenStore, 'client-id', 'client-secret');

    const result = await client.getEntity('customer', '1');

    expect(result).toEqual({ Id: '1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer');
    expect(tokenStore.saveTokens).toHaveBeenCalledWith({
      realmId: 'realm-1',
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      accessTokenExpiresAt: expect.any(String),
    });
    // second call uses the refreshed token
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer access-2');
  });

  it('throws when no tokens have been stored yet', async () => {
    const tokenStore = fakeTokenStore({ getTokens: vi.fn().mockResolvedValue(null) });
    const client = new HttpQuickBooksClient(tokenStore, 'client-id', 'client-secret');
    await expect(client.getEntity('customer', '1')).rejects.toThrow(/no OAuth tokens stored/);
  });

  it('creates a customer', async () => {
    const tokenStore = fakeTokenStore({ getTokens: vi.fn().mockResolvedValue(validTokens) });
    const fetchMock = mockFetchSequence([{ ok: true, json: { Customer: { Id: '99' } } }]);
    const client = new HttpQuickBooksClient(tokenStore, 'client-id', 'client-secret');

    const result = await client.createCustomer({ DisplayName: 'New Co' });

    expect(result).toEqual({ id: '99' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://quickbooks.api.intuit.com/v3/company/realm-1/customer');
    expect(JSON.parse(init.body)).toEqual({ DisplayName: 'New Co' });
  });

  it('throws on a non-OK API response', async () => {
    const tokenStore = fakeTokenStore({ getTokens: vi.fn().mockResolvedValue(validTokens) });
    mockFetchSequence([{ ok: false, status: 500, json: {} }]);
    const client = new HttpQuickBooksClient(tokenStore, 'client-id', 'client-secret');
    await expect(client.getEntity('invoice', '1')).rejects.toThrow(/HTTP 500/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- client.test.ts` (from `src/quickbooks/`)
Expected: FAIL — `./client` module not found.

- [ ] **Step 3: Write `quickbooks-sync/src/quickbooks/client.ts`**

```typescript
import type { EntityType } from '../types';
import type { QbTokens, TokenStore } from './tokenStore';

export interface QuickBooksClient {
  getEntity(entityType: EntityType, qbId: string): Promise<Record<string, unknown>>;
  createCustomer(fields: Record<string, unknown>): Promise<{ id: string }>;
}

const QB_ENTITY_PATH: Record<EntityType, string> = {
  customer: 'customer',
  invoice: 'invoice',
  product: 'item',
};

const QB_API_BASE = 'https://quickbooks.api.intuit.com/v3/company';
const QB_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

interface RefreshResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export class HttpQuickBooksClient implements QuickBooksClient {
  constructor(
    private tokenStore: TokenStore,
    private clientId: string,
    private clientSecret: string
  ) {}

  private async getValidAccessToken(): Promise<{ realmId: string; accessToken: string }> {
    const tokens = await this.tokenStore.getTokens();
    if (tokens === null) {
      throw new Error('quickbooks: no OAuth tokens stored — run the initial authorization handshake first');
    }
    if (new Date(tokens.accessTokenExpiresAt).getTime() > Date.now() + 60_000) {
      return { realmId: tokens.realmId, accessToken: tokens.accessToken };
    }
    const refreshed = await this.refresh(tokens);
    return { realmId: refreshed.realmId, accessToken: refreshed.accessToken };
  }

  private async refresh(tokens: QbTokens): Promise<QbTokens> {
    const basicAuth = btoa(`${this.clientId}:${this.clientSecret}`);
    const response = await fetch(QB_TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken }),
    });
    if (!response.ok) {
      throw new Error(`quickbooks oauth refresh: HTTP ${response.status}`);
    }
    const json = (await response.json()) as RefreshResponse;
    const refreshedTokens: QbTokens = {
      realmId: tokens.realmId,
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      accessTokenExpiresAt: new Date(Date.now() + json.expires_in * 1000).toISOString(),
    };
    await this.tokenStore.saveTokens(refreshedTokens);
    return refreshedTokens;
  }

  async getEntity(entityType: EntityType, qbId: string): Promise<Record<string, unknown>> {
    const { realmId, accessToken } = await this.getValidAccessToken();
    const path = QB_ENTITY_PATH[entityType];
    const response = await fetch(`${QB_API_BASE}/${realmId}/${path}/${qbId}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`quickbooks API: HTTP ${response.status} fetching ${entityType} ${qbId}`);
    }
    const json = (await response.json()) as Record<string, unknown>;
    const entityKey = path.charAt(0).toUpperCase() + path.slice(1);
    return json[entityKey] as Record<string, unknown>;
  }

  async createCustomer(fields: Record<string, unknown>): Promise<{ id: string }> {
    const { realmId, accessToken } = await this.getValidAccessToken();
    const response = await fetch(`${QB_API_BASE}/${realmId}/customer`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(fields),
    });
    if (!response.ok) {
      throw new Error(`quickbooks API: HTTP ${response.status} creating customer`);
    }
    const json = (await response.json()) as { Customer: { Id: string } };
    return { id: json.Customer.Id };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- client.test.ts`
Expected: PASS, all 6 tests.

- [ ] **Step 5: Note the initial-authorization gap (manual, not automated — see Task 15 Step 7)**

`getValidAccessToken` only ever *refreshes* an existing token; it never performs the initial OAuth authorization-code exchange. That first `qb_oauth_tokens` row has to be seeded once, by hand, via Intuit's OAuth 2.0 Playground (a hosted tool that walks through the interactive consent screen and hands back an initial access+refresh token pair) — not by writing an `/oauth/callback` route in this Worker. Building a full authorize-redirect flow would be scope for a multi-tenant, self-service integration; SVBC connecting its own single QuickBooks company is a one-time, one-admin action better done via Intuit's existing tool. Covered as a manual provisioning step in Task 15.

- [ ] **Step 6: Commit**

```bash
git add src/quickbooks/client.ts src/quickbooks/client.test.ts
git commit -m "feat(quickbooks-sync): QuickBooks API client with OAuth token refresh"
```

---

### Task 8: Monday GraphQL client

**Files:**
- Create: `quickbooks-sync/src/monday/client.ts`
- Test: `quickbooks-sync/src/monday/client.test.ts`

**Interfaces:**
- Produces: `MondayItem`, `MondayClient` interface, `HttpMondayClient` class — consumed by `consumer/processBatch.ts` (Task 14) and `index.ts` (Task 15).

This client is simpler than `funraise-sync`'s: identity linkage here comes entirely from `qb_monday_map` (Task 3), never from searching a board by column value, so there's no `findItemByColumnValue` method to build.

- [ ] **Step 1: Write the failing test — `quickbooks-sync/src/monday/client.test.ts`**

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
  it('creates an item', async () => {
    const fetchMock = mockFetchOnce({ data: { create_item: { id: '456' } } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');

    const item = await client.createItem(999, 'Acme Co', { text_col: 'Acme Co' });

    expect(item).toEqual({ id: '456' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.monday.com/v2');
    expect(init.headers.Authorization).toBe('token-123');
    const body = JSON.parse(init.body);
    expect(body.variables.itemName).toBe('Acme Co');
    expect(JSON.parse(body.variables.columnValues)).toEqual({ text_col: 'Acme Co' });
  });

  it('changes column values on an existing item', async () => {
    const fetchMock = mockFetchOnce({ data: { change_multiple_column_values: { id: '456' } } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');

    await client.changeColumnValues(999, '456', { text_col: 'Updated' });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.variables.itemId).toBe('456');
    expect(JSON.parse(body.variables.columnValues)).toEqual({ text_col: 'Updated' });
  });

  it('throws on a non-OK HTTP response', async () => {
    mockFetchOnce({}, false);
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');
    await expect(client.createItem(1, 'x', {})).rejects.toThrow(/HTTP 500/);
  });

  it('throws on a GraphQL errors array', async () => {
    mockFetchOnce({ errors: [{ message: 'Board not found' }] });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');
    await expect(client.createItem(1, 'x', {})).rejects.toThrow(/Board not found/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- client.test.ts` (from `src/monday/`)
Expected: FAIL — `./client` module not found.

- [ ] **Step 3: Write `quickbooks-sync/src/monday/client.ts`**

```typescript
export interface MondayItem {
  id: string;
}

export interface MondayClient {
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
Expected: PASS, all 4 tests.

- [ ] **Step 5: Verify the GraphQL shape against Monday's live API before deploy**

Same caveat `funraise-sync`'s equivalent client carries: these mutations are written from current Monday API v2 knowledge, not verified against a live account from this environment. Before relying on this in production, run one real call from `wrangler dev` against a test board and confirm `create_item`/`change_multiple_column_values` and `API-Version` are still correct for SVBC's account.

- [ ] **Step 6: Commit**

```bash
git add src/monday/client.ts src/monday/client.test.ts
git commit -m "feat(quickbooks-sync): Monday GraphQL client"
```

---

### Task 9: Config-driven field mapping

**Files:**
- Create: `quickbooks-sync/src/mapping/fieldMap.ts`
- Test: `quickbooks-sync/src/mapping/fieldMap.test.ts`

**Interfaces:**
- Consumes: `EntityType`, `QuickbooksSyncConfig` (from `src/types.ts`)
- Produces: `mapQbToMondayColumns(entityType, qbRecord, config)`, `mapMondayToQbCustomerFields(mondayColumnValues, config)`, `getPath(obj, path)` — consumed by `consumer/processBatch.ts` (Task 14).

- [ ] **Step 1: Write the failing test — `quickbooks-sync/src/mapping/fieldMap.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { mapQbToMondayColumns, mapMondayToQbCustomerFields } from './fieldMap';
import type { QuickbooksSyncConfig } from '../types';

const config: QuickbooksSyncConfig = {
  monday: {
    apiUrl: 'https://api.monday.com/v2',
    boards: { customers: 1, invoices: 2, products: 3 },
  },
  quickbooksSync: {
    columnMap: {
      customer: { DisplayName: 'text_col', 'PrimaryEmailAddr.Address': 'email_col' },
      invoice: { DocNumber: 'text_col', TotalAmt: 'numeric_col' },
      product: { Name: 'text_col' },
    },
    itemNameField: { customer: 'DisplayName', invoice: 'DocNumber', product: 'Name' },
    linkColumn: { invoice: 'connect_col' },
    customerCreateFieldMap: { text_col: 'DisplayName', email_col: 'PrimaryEmailAddr.Address' },
  },
};

describe('mapQbToMondayColumns', () => {
  it('maps mapped fields to their Monday column ids', () => {
    const result = mapQbToMondayColumns('customer', { DisplayName: 'Acme Co' }, config);
    expect(result).toEqual({ text_col: 'Acme Co' });
  });

  it('drops any field not present in columnMap', () => {
    const result = mapQbToMondayColumns('customer', { DisplayName: 'Acme Co', SyncToken: '3' }, config);
    expect(result).not.toHaveProperty('SyncToken');
    expect(Object.keys(result)).toEqual(['text_col']);
  });

  it('supports dot-path field lookup for nested QuickBooks fields', () => {
    const result = mapQbToMondayColumns(
      'customer',
      { DisplayName: 'Acme Co', PrimaryEmailAddr: { Address: 'a@acme.com' } },
      config
    );
    expect(result).toEqual({ text_col: 'Acme Co', email_col: 'a@acme.com' });
  });

  it('omits a column entirely when the source field is absent', () => {
    const result = mapQbToMondayColumns('invoice', { DocNumber: '1001' }, config);
    expect(result).toEqual({ text_col: '1001' });
  });
});

describe('mapMondayToQbCustomerFields', () => {
  it('maps flat Monday column values to top-level QuickBooks fields', () => {
    const result = mapMondayToQbCustomerFields({ text_col: 'New Co' }, config);
    expect(result).toEqual({ DisplayName: 'New Co' });
  });

  it('builds a nested QuickBooks field from a dot-path target', () => {
    const result = mapMondayToQbCustomerFields({ email_col: 'new@co.com' }, config);
    expect(result).toEqual({ PrimaryEmailAddr: { Address: 'new@co.com' } });
  });

  it('combines flat and nested fields from one payload', () => {
    const result = mapMondayToQbCustomerFields({ text_col: 'New Co', email_col: 'new@co.com' }, config);
    expect(result).toEqual({ DisplayName: 'New Co', PrimaryEmailAddr: { Address: 'new@co.com' } });
  });

  it('drops a mapped column that has no value in the payload', () => {
    const result = mapMondayToQbCustomerFields({ text_col: 'New Co' }, config);
    expect(result).not.toHaveProperty('PrimaryEmailAddr');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- fieldMap.test.ts`
Expected: FAIL — `./fieldMap` module not found.

- [ ] **Step 3: Write `quickbooks-sync/src/mapping/fieldMap.ts`**

```typescript
import type { EntityType, QuickbooksSyncConfig } from '../types';

export function getPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (typeof acc !== 'object' || acc === null) return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cursor = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    if (typeof cursor[key] !== 'object' || cursor[key] === null) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
}

export function mapQbToMondayColumns(
  entityType: EntityType,
  qbRecord: Record<string, unknown>,
  config: QuickbooksSyncConfig
): Record<string, unknown> {
  const fields = config.quickbooksSync.columnMap[entityType];
  const result: Record<string, unknown> = {};
  for (const [qbField, mondayColumnId] of Object.entries(fields)) {
    const value = getPath(qbRecord, qbField);
    if (value === undefined) continue;
    result[mondayColumnId] = value;
  }
  return result;
}

export function mapMondayToQbCustomerFields(
  mondayColumnValues: Record<string, unknown>,
  config: QuickbooksSyncConfig
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [mondayColumnId, qbField] of Object.entries(config.quickbooksSync.customerCreateFieldMap)) {
    const value = mondayColumnValues[mondayColumnId];
    if (value === undefined) continue;
    setPath(result, qbField, value);
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- fieldMap.test.ts`
Expected: PASS, all 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/mapping
git commit -m "feat(quickbooks-sync): config-driven field mapping (QB<->Monday)"
```

---

### Task 10: QuickBooks webhook — signature verification + payload parsing

**Files:**
- Create: `quickbooks-sync/src/quickbooks/webhook/validate.ts`
- Test: `quickbooks-sync/src/quickbooks/webhook/validate.test.ts`

**Interfaces:**
- Consumes: `EntityType` (from `src/types.ts`)
- Produces: `QbChangeNotification`, `parseQbNotifications(body: unknown): QbChangeNotification[]`, `verifyQbSignature(rawBody, signatureHeader, verifierToken): Promise<boolean>` — consumed by `quickbooks/webhook/route.ts` (Task 11).

QuickBooks's webhook payload carries no data, only "this entity id changed" (per the spec). Intuit's documented shape is an `eventNotifications` array, each with a `realmId` and a `dataChangeEvent.entities` array of `{ name, id, operation, lastUpdated }`. There is no single dedicated notification-id field in that shape — `eventId` here is derived from `realmId:name:id:lastUpdated`, the most specific combination the payload actually provides. **Known limitation:** if the same entity were updated twice with an identical `lastUpdated` timestamp, those two notifications would dedupe together; no better id is available in the documented payload.

Intuit signs each delivery with an `intuit-signature` header: HMAC-SHA256 of the raw request body, keyed by the app's Webhooks Verifier Token, base64-encoded. This is verified as a real signature (unlike `funraise-sync`'s handshake-only auth) — but as with every external API detail in this plan, confirm it against Intuit's current docs before deploy; this is implemented from established, long-standing QuickBooks webhook documentation, not a live test against SVBC's actual app.

- [ ] **Step 1: Write the failing test — `quickbooks-sync/src/quickbooks/webhook/validate.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { parseQbNotifications, verifyQbSignature } from './validate';

describe('parseQbNotifications', () => {
  it('parses a single entity notification', () => {
    const body = {
      eventNotifications: [
        {
          realmId: '123',
          dataChangeEvent: {
            entities: [{ name: 'Customer', id: '60', operation: 'Update', lastUpdated: '2026-08-22T00:00:00.000Z' }],
          },
        },
      ],
    };
    expect(parseQbNotifications(body)).toEqual([
      { eventId: '123:Customer:60:2026-08-22T00:00:00.000Z', entityType: 'customer', qbId: '60', realmId: '123' },
    ]);
  });

  it('parses multiple entities across multiple notifications', () => {
    const body = {
      eventNotifications: [
        {
          realmId: '123',
          dataChangeEvent: {
            entities: [
              { name: 'Invoice', id: '1', operation: 'Create', lastUpdated: '2026-08-22T00:00:00.000Z' },
              { name: 'Item', id: '9', operation: 'Update', lastUpdated: '2026-08-22T00:01:00.000Z' },
            ],
          },
        },
      ],
    };
    const result = parseQbNotifications(body);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ entityType: 'invoice', qbId: '1' });
    expect(result[1]).toMatchObject({ entityType: 'product', qbId: '9' });
  });

  it('ignores entity names outside this Worker\'s scope', () => {
    const body = {
      eventNotifications: [
        {
          realmId: '123',
          dataChangeEvent: {
            entities: [{ name: 'Payment', id: '1', operation: 'Create', lastUpdated: '2026-08-22T00:00:00.000Z' }],
          },
        },
      ],
    };
    expect(parseQbNotifications(body)).toEqual([]);
  });

  it('throws when eventNotifications is missing', () => {
    expect(() => parseQbNotifications({})).toThrow(/eventNotifications/);
  });
});

describe('verifyQbSignature', () => {
  const verifierToken = 'test-verifier-token';
  const rawBody = '{"eventNotifications":[]}';

  async function computeExpectedSignature(body: string, token: string): Promise<string> {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
    ]);
    const signatureBytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
    return btoa(String.fromCharCode(...new Uint8Array(signatureBytes)));
  }

  it('returns true for a correctly signed body', async () => {
    const signature = await computeExpectedSignature(rawBody, verifierToken);
    expect(await verifyQbSignature(rawBody, signature, verifierToken)).toBe(true);
  });

  it('returns false for a wrong signature', async () => {
    expect(await verifyQbSignature(rawBody, 'not-the-right-signature', verifierToken)).toBe(false);
  });

  it('returns false when the header is missing', async () => {
    expect(await verifyQbSignature(rawBody, undefined, verifierToken)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- validate.test.ts` (from `src/quickbooks/webhook/`)
Expected: FAIL — `./validate` module not found.

- [ ] **Step 3: Write `quickbooks-sync/src/quickbooks/webhook/validate.ts`**

```typescript
import type { EntityType } from '../../types';

export interface QbChangeNotification {
  eventId: string;
  entityType: EntityType;
  qbId: string;
  realmId: string;
}

const QB_ENTITY_NAME_TO_TYPE: Record<string, EntityType> = {
  Customer: 'customer',
  Invoice: 'invoice',
  Item: 'product',
};

export function parseQbNotifications(body: unknown): QbChangeNotification[] {
  if (typeof body !== 'object' || body === null) {
    throw new Error('quickbooks webhook: payload must be a JSON object');
  }
  const payload = body as Record<string, unknown>;
  const notifications = payload.eventNotifications;
  if (!Array.isArray(notifications)) {
    throw new Error('quickbooks webhook: missing "eventNotifications" array');
  }

  const result: QbChangeNotification[] = [];
  for (const notification of notifications) {
    if (typeof notification !== 'object' || notification === null) continue;
    const { realmId, dataChangeEvent } = notification as Record<string, unknown>;
    if (typeof realmId !== 'string' || typeof dataChangeEvent !== 'object' || dataChangeEvent === null) continue;

    const entities = (dataChangeEvent as Record<string, unknown>).entities;
    if (!Array.isArray(entities)) continue;

    for (const entity of entities) {
      if (typeof entity !== 'object' || entity === null) continue;
      const { name, id, lastUpdated } = entity as Record<string, unknown>;
      if (typeof name !== 'string' || typeof id !== 'string' || typeof lastUpdated !== 'string') continue;

      const entityType = QB_ENTITY_NAME_TO_TYPE[name];
      if (entityType === undefined) continue;

      result.push({
        eventId: `${realmId}:${name}:${id}:${lastUpdated}`,
        entityType,
        qbId: id,
        realmId,
      });
    }
  }
  return result;
}

export async function verifyQbSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  verifierToken: string
): Promise<boolean> {
  if (!signatureHeader) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(verifierToken),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const computed = btoa(String.fromCharCode(...new Uint8Array(signatureBytes)));
  return computed === signatureHeader;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- validate.test.ts`
Expected: PASS, all 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/quickbooks/webhook/validate.ts src/quickbooks/webhook/validate.test.ts
git commit -m "feat(quickbooks-sync): QuickBooks webhook signature verification and payload parsing"
```

---

### Task 11: QuickBooks webhook route

**Files:**
- Create: `quickbooks-sync/src/quickbooks/webhook/route.ts`
- Test: `quickbooks-sync/src/quickbooks/webhook/route.test.ts`

**Interfaces:**
- Consumes: `QbEventStore` (Task 4), `QuickBooksClient` (Task 7), `parseQbNotifications`, `verifyQbSignature` (Task 10)
- Produces: `createQbWebhookApp(deps: QbWebhookDeps): Hono`, `QbWebhookDeps`, `QueueLike` — consumed by `index.ts` (Task 15).

- [ ] **Step 1: Write the failing test — `quickbooks-sync/src/quickbooks/webhook/route.test.ts`**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createQbWebhookApp } from './route';
import { verifyQbSignature } from './validate';
import type { QbEventStore } from '../../db/qbEvents';
import type { QuickBooksClient } from '../client';

function fakeEventStore(overrides: Partial<QbEventStore> = {}): QbEventStore {
  return {
    insertEvent: vi.fn().mockResolvedValue('inserted'),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    getEvent: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function fakeQuickBooksClient(overrides: Partial<QuickBooksClient> = {}): QuickBooksClient {
  return {
    getEntity: vi.fn().mockResolvedValue({ Id: '60', DisplayName: 'Acme' }),
    createCustomer: vi.fn(),
    ...overrides,
  };
}

const verifierToken = 'test-verifier-token';

async function signedBody(payload: unknown): Promise<{ body: string; signature: string }> {
  const body = JSON.stringify(payload);
  const signature = await verifyQbSignatureHelper(body);
  return { body, signature };
}

// Reuses the exact algorithm verifyQbSignature checks against, so tests sign requests the same way Intuit would.
async function verifyQbSignatureHelper(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(verifierToken),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(signatureBytes)));
}

const notificationPayload = {
  eventNotifications: [
    {
      realmId: '123',
      dataChangeEvent: {
        entities: [{ name: 'Customer', id: '60', operation: 'Update', lastUpdated: '2026-08-22T00:00:00.000Z' }],
      },
    },
  ],
};

describe('createQbWebhookApp', () => {
  it('rejects a request with an invalid signature', async () => {
    const eventStore = fakeEventStore();
    const app = createQbWebhookApp({
      qbEventStore: eventStore,
      quickBooksClient: fakeQuickBooksClient(),
      queue: { send: vi.fn() },
      verifierToken,
    });

    const res = await app.request('/webhooks/quickbooks', {
      method: 'POST',
      body: JSON.stringify(notificationPayload),
      headers: { 'intuit-signature': 'wrong-signature' },
    });

    expect(res.status).toBe(401);
    expect(eventStore.insertEvent).not.toHaveBeenCalled();
  });

  it('dedupes, fetches, and enqueues a new notification', async () => {
    const { body, signature } = await signedBody(notificationPayload);
    const eventStore = fakeEventStore();
    const getEntity = vi.fn().mockResolvedValue({ Id: '60', DisplayName: 'Acme' });
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const app = createQbWebhookApp({
      qbEventStore: eventStore,
      quickBooksClient: fakeQuickBooksClient({ getEntity }),
      queue,
      verifierToken,
    });

    const res = await app.request('/webhooks/quickbooks', {
      method: 'POST',
      body,
      headers: { 'intuit-signature': signature },
    });

    expect(res.status).toBe(200);
    expect(eventStore.insertEvent).toHaveBeenCalledWith({
      eventId: '123:Customer:60:2026-08-22T00:00:00.000Z',
      entityType: 'customer',
      qbId: '60',
      receivedAt: expect.any(String),
    });
    expect(getEntity).toHaveBeenCalledWith('customer', '60');
    expect(eventStore.updateStatus).toHaveBeenCalledWith(
      '123:Customer:60:2026-08-22T00:00:00.000Z',
      'fetched',
      { fetchedPayload: JSON.stringify({ Id: '60', DisplayName: 'Acme' }) }
    );
    expect(queue.send).toHaveBeenCalledWith({ direction: 'qb-to-monday', eventId: '123:Customer:60:2026-08-22T00:00:00.000Z' });
    expect(eventStore.updateStatus).toHaveBeenCalledWith('123:Customer:60:2026-08-22T00:00:00.000Z', 'queued');
  });

  it('short-circuits on a duplicate notification without fetching or enqueueing', async () => {
    const { body, signature } = await signedBody(notificationPayload);
    const eventStore = fakeEventStore({ insertEvent: vi.fn().mockResolvedValue('duplicate') });
    const getEntity = vi.fn();
    const queue = { send: vi.fn() };
    const app = createQbWebhookApp({
      qbEventStore: eventStore,
      quickBooksClient: fakeQuickBooksClient({ getEntity }),
      queue,
      verifierToken,
    });

    const res = await app.request('/webhooks/quickbooks', { method: 'POST', body, headers: { 'intuit-signature': signature } });

    expect(res.status).toBe(200);
    expect(getEntity).not.toHaveBeenCalled();
    expect(queue.send).not.toHaveBeenCalled();
  });

  it('marks the event failed when the QuickBooks fetch throws, without crashing the request', async () => {
    const { body, signature } = await signedBody(notificationPayload);
    const eventStore = fakeEventStore();
    const getEntity = vi.fn().mockRejectedValue(new Error('quickbooks API: HTTP 500 fetching customer 60'));
    const queue = { send: vi.fn() };
    const app = createQbWebhookApp({
      qbEventStore: eventStore,
      quickBooksClient: fakeQuickBooksClient({ getEntity }),
      queue,
      verifierToken,
    });

    const res = await app.request('/webhooks/quickbooks', { method: 'POST', body, headers: { 'intuit-signature': signature } });

    expect(res.status).toBe(200);
    expect(eventStore.updateStatus).toHaveBeenCalledWith(
      '123:Customer:60:2026-08-22T00:00:00.000Z',
      'failed',
      { error: 'quickbooks API: HTTP 500 fetching customer 60' }
    );
    expect(queue.send).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- route.test.ts` (from `src/quickbooks/webhook/`)
Expected: FAIL — `./route` module not found.

- [ ] **Step 3: Write `quickbooks-sync/src/quickbooks/webhook/route.ts`**

```typescript
import { Hono } from 'hono';
import type { QbEventStore } from '../../db/qbEvents';
import type { QueueMessage } from '../../types';
import type { QuickBooksClient } from '../client';
import { parseQbNotifications, verifyQbSignature } from './validate';

export interface QueueLike {
  send(message: QueueMessage): Promise<void>;
}

export interface QbWebhookDeps {
  qbEventStore: QbEventStore;
  quickBooksClient: QuickBooksClient;
  queue: QueueLike;
  verifierToken: string;
}

export function createQbWebhookApp(deps: QbWebhookDeps) {
  const app = new Hono();

  app.post('/webhooks/quickbooks', async (c) => {
    const rawBody = await c.req.text();
    const signature = c.req.header('intuit-signature');
    const valid = await verifyQbSignature(rawBody, signature, deps.verifierToken);
    if (!valid) {
      return c.body(null, 401);
    }

    let notifications;
    try {
      notifications = parseQbNotifications(JSON.parse(rawBody));
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 200);
    }

    for (const notification of notifications) {
      const insertResult = await deps.qbEventStore.insertEvent({
        eventId: notification.eventId,
        entityType: notification.entityType,
        qbId: notification.qbId,
        receivedAt: new Date().toISOString(),
      });

      if (insertResult === 'duplicate') continue;

      try {
        const record = await deps.quickBooksClient.getEntity(notification.entityType, notification.qbId);
        await deps.qbEventStore.updateStatus(notification.eventId, 'fetched', {
          fetchedPayload: JSON.stringify(record),
        });
        await deps.queue.send({ direction: 'qb-to-monday', eventId: notification.eventId });
        await deps.qbEventStore.updateStatus(notification.eventId, 'queued');
      } catch (err) {
        await deps.qbEventStore.updateStatus(notification.eventId, 'failed', {
          error: (err as Error).message,
        });
      }
    }

    return c.json({ ok: true }, 200);
  });

  return app;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- route.test.ts`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/quickbooks/webhook/route.ts src/quickbooks/webhook/route.test.ts
git commit -m "feat(quickbooks-sync): QuickBooks webhook route (verify, dedup, fetch, enqueue)"
```

---

### Task 12: Monday webhook — payload validation

**Files:**
- Create: `quickbooks-sync/src/monday/webhook/validate.ts`
- Test: `quickbooks-sync/src/monday/webhook/validate.test.ts`

**Interfaces:**
- Produces: `MondayItemCreatedEvent`, `isChallengeRequest(body): boolean`, `validateMondayEvent(body): MondayItemCreatedEvent` — consumed by `monday/webhook/route.ts` (Task 13).

Per the spec's "Monday-side webhook mechanism (unconfirmed)" note, the exact automation-recipe payload shape isn't confirmed against a live account. This implements two things known to be true of monday.com's webhook subscriptions generally: (1) a `{ "challenge": "..." }` verification handshake on subscription setup that must be echoed back, and (2) an `event` object carrying at minimum the created item's id (`pulseId`) and its board id — confirm the actual field names against a real automation recipe before deploy, per the spec.

- [ ] **Step 1: Write the failing test — `quickbooks-sync/src/monday/webhook/validate.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { isChallengeRequest, validateMondayEvent } from './validate';

describe('isChallengeRequest', () => {
  it('recognizes a challenge payload', () => {
    expect(isChallengeRequest({ challenge: 'abc123' })).toBe(true);
  });

  it('rejects a non-challenge payload', () => {
    expect(isChallengeRequest({ event: {} })).toBe(false);
    expect(isChallengeRequest(null)).toBe(false);
  });
});

describe('validateMondayEvent', () => {
  it('extracts mondayItemId, boardId, and columnValues from a valid event', () => {
    const result = validateMondayEvent({
      event: { pulseId: 123456, boardId: 789, columnValues: { text_col: 'Acme Co' } },
    });
    expect(result).toEqual({ mondayItemId: '123456', boardId: 789, columnValues: { text_col: 'Acme Co' } });
  });

  it('defaults columnValues to an empty object when absent', () => {
    const result = validateMondayEvent({ event: { pulseId: 1, boardId: 2 } });
    expect(result.columnValues).toEqual({});
  });

  it('throws when the body has no "event" object', () => {
    expect(() => validateMondayEvent({})).toThrow(/missing "event"/);
  });

  it('throws when pulseId is missing', () => {
    expect(() => validateMondayEvent({ event: { boardId: 2 } })).toThrow(/pulseId/);
  });

  it('throws when boardId is missing', () => {
    expect(() => validateMondayEvent({ event: { pulseId: 1 } })).toThrow(/boardId/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- validate.test.ts` (from `src/monday/webhook/`)
Expected: FAIL — `./validate` module not found.

- [ ] **Step 3: Write `quickbooks-sync/src/monday/webhook/validate.ts`**

```typescript
export interface MondayItemCreatedEvent {
  mondayItemId: string;
  boardId: number;
  columnValues: Record<string, unknown>;
}

export function isChallengeRequest(body: unknown): body is { challenge: string } {
  return typeof body === 'object' && body !== null && typeof (body as Record<string, unknown>).challenge === 'string';
}

export function validateMondayEvent(body: unknown): MondayItemCreatedEvent {
  if (typeof body !== 'object' || body === null) {
    throw new Error('monday webhook: payload must be a JSON object');
  }
  const event = (body as Record<string, unknown>).event;
  if (typeof event !== 'object' || event === null) {
    throw new Error('monday webhook: missing "event" object');
  }

  const { pulseId, boardId, columnValues } = event as Record<string, unknown>;
  if (typeof pulseId !== 'number' && typeof pulseId !== 'string') {
    throw new Error('monday webhook: event missing "pulseId"');
  }
  if (typeof boardId !== 'number') {
    throw new Error('monday webhook: event missing "boardId"');
  }

  return {
    mondayItemId: String(pulseId),
    boardId,
    columnValues: (typeof columnValues === 'object' && columnValues !== null ? columnValues : {}) as Record<
      string,
      unknown
    >,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- validate.test.ts`
Expected: PASS, all 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/monday/webhook/validate.ts src/monday/webhook/validate.test.ts
git commit -m "feat(quickbooks-sync): Monday webhook payload validation"
```

---

### Task 13: Monday webhook route

**Files:**
- Create: `quickbooks-sync/src/monday/webhook/route.ts`
- Test: `quickbooks-sync/src/monday/webhook/route.test.ts`

**Interfaces:**
- Consumes: `MondayEventStore` (Task 5), `MapStore` (Task 3), `isChallengeRequest`, `validateMondayEvent` (Task 12), `QuickbooksSyncConfig` (Task 1), `QueueLike` (Task 11)
- Produces: `createMondayWebhookApp(deps: MondayWebhookDeps): Hono`, `MondayWebhookDeps` — consumed by `index.ts` (Task 15).

This is the only place the spec's Conflict Policy is actually enforced: an item already present in `qb_monday_map` is a Monday-side *edit*, not a create, and is silently skipped here rather than queued — there is no code path anywhere in this Worker that turns a Monday edit into a QuickBooks update.

- [ ] **Step 1: Write the failing test — `quickbooks-sync/src/monday/webhook/route.test.ts`**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createMondayWebhookApp } from './route';
import type { MondayEventStore } from '../../db/mondayEvents';
import type { MapStore } from '../../db/map';
import type { QuickbooksSyncConfig } from '../../types';

const config: QuickbooksSyncConfig = {
  monday: { apiUrl: 'https://api.monday.com/v2', boards: { customers: 789, invoices: null, products: null } },
  quickbooksSync: {
    columnMap: { customer: {}, invoice: {}, product: {} },
    itemNameField: { customer: 'DisplayName', invoice: 'DocNumber', product: 'Name' },
    linkColumn: { invoice: 'connect_col' },
    customerCreateFieldMap: {},
  },
};

function fakeMondayEventStore(overrides: Partial<MondayEventStore> = {}): MondayEventStore {
  return {
    insertEvent: vi.fn().mockResolvedValue('inserted'),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    getEvent: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function fakeMapStore(overrides: Partial<MapStore> = {}): MapStore {
  return {
    getByQbId: vi.fn().mockResolvedValue(null),
    getByMondayItemId: vi.fn().mockResolvedValue(null),
    createMapping: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('createMondayWebhookApp', () => {
  it('echoes the challenge on subscription verification', async () => {
    const app = createMondayWebhookApp({
      mondayEventStore: fakeMondayEventStore(),
      mapStore: fakeMapStore(),
      queue: { send: vi.fn() },
      config,
    });

    const res = await app.request('/webhooks/monday', {
      method: 'POST',
      body: JSON.stringify({ challenge: 'abc123' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'abc123' });
  });

  it('ignores an event from a board other than the configured Customers board', async () => {
    const mondayEventStore = fakeMondayEventStore();
    const app = createMondayWebhookApp({
      mondayEventStore,
      mapStore: fakeMapStore(),
      queue: { send: vi.fn() },
      config,
    });

    const res = await app.request('/webhooks/monday', {
      method: 'POST',
      body: JSON.stringify({ event: { pulseId: 1, boardId: 999 } }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect((await res.json<{ ignored: boolean }>()).ignored).toBe(true);
    expect(mondayEventStore.insertEvent).not.toHaveBeenCalled();
  });

  it('skips an item already linked in qb_monday_map instead of queueing an update', async () => {
    const mondayEventStore = fakeMondayEventStore();
    const mapStore = fakeMapStore({
      getByMondayItemId: vi.fn().mockResolvedValue({
        entityType: 'customer',
        qbId: 'qb-1',
        mondayItemId: '1',
        mondayBoardId: 789,
        createdAt: '2026-08-22T00:00:00.000Z',
      }),
    });
    const queue = { send: vi.fn() };
    const app = createMondayWebhookApp({ mondayEventStore, mapStore, queue, config });

    const res = await app.request('/webhooks/monday', {
      method: 'POST',
      body: JSON.stringify({ event: { pulseId: 1, boardId: 789 } }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect((await res.json<{ alreadyLinked: boolean }>()).alreadyLinked).toBe(true);
    expect(mondayEventStore.insertEvent).not.toHaveBeenCalled();
    expect(queue.send).not.toHaveBeenCalled();
  });

  it('dedupes and enqueues a genuinely new Customer item', async () => {
    const mondayEventStore = fakeMondayEventStore();
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const app = createMondayWebhookApp({ mondayEventStore, mapStore: fakeMapStore(), queue, config });

    const res = await app.request('/webhooks/monday', {
      method: 'POST',
      body: JSON.stringify({ event: { pulseId: 42, boardId: 789, columnValues: { text_col: 'New Co' } } }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(mondayEventStore.insertEvent).toHaveBeenCalledWith({
      eventId: '42',
      mondayItemId: '42',
      rawPayload: JSON.stringify({ text_col: 'New Co' }),
      receivedAt: expect.any(String),
    });
    expect(queue.send).toHaveBeenCalledWith({ direction: 'monday-to-qb', eventId: '42' });
    expect(mondayEventStore.updateStatus).toHaveBeenCalledWith('42', 'queued');
  });

  it('short-circuits on a duplicate item event without enqueueing', async () => {
    const mondayEventStore = fakeMondayEventStore({ insertEvent: vi.fn().mockResolvedValue('duplicate') });
    const queue = { send: vi.fn() };
    const app = createMondayWebhookApp({ mondayEventStore, mapStore: fakeMapStore(), queue, config });

    const res = await app.request('/webhooks/monday', {
      method: 'POST',
      body: JSON.stringify({ event: { pulseId: 42, boardId: 789 } }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect((await res.json<{ duplicate: boolean }>()).duplicate).toBe(true);
    expect(queue.send).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- route.test.ts` (from `src/monday/webhook/`)
Expected: FAIL — `./route` module not found.

- [ ] **Step 3: Write `quickbooks-sync/src/monday/webhook/route.ts`**

```typescript
import { Hono } from 'hono';
import type { MapStore } from '../../db/map';
import type { MondayEventStore } from '../../db/mondayEvents';
import type { QuickbooksSyncConfig } from '../../types';
import type { QueueLike } from '../../quickbooks/webhook/route';
import { isChallengeRequest, validateMondayEvent } from './validate';

export interface MondayWebhookDeps {
  mondayEventStore: MondayEventStore;
  mapStore: MapStore;
  queue: QueueLike;
  config: QuickbooksSyncConfig;
}

export function createMondayWebhookApp(deps: MondayWebhookDeps) {
  const app = new Hono();

  app.post('/webhooks/monday', async (c) => {
    const body = await c.req.json();

    if (isChallengeRequest(body)) {
      return c.json({ challenge: body.challenge }, 200);
    }

    let event;
    try {
      event = validateMondayEvent(body);
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 200);
    }

    if (event.boardId !== deps.config.monday.boards.customers) {
      return c.json({ ok: true, ignored: true }, 200);
    }

    const existing = await deps.mapStore.getByMondayItemId('customer', event.mondayItemId);
    if (existing !== null) {
      return c.json({ ok: true, alreadyLinked: true }, 200);
    }

    const insertResult = await deps.mondayEventStore.insertEvent({
      eventId: event.mondayItemId,
      mondayItemId: event.mondayItemId,
      rawPayload: JSON.stringify(event.columnValues),
      receivedAt: new Date().toISOString(),
    });

    if (insertResult === 'duplicate') {
      return c.json({ ok: true, duplicate: true }, 200);
    }

    try {
      await deps.queue.send({ direction: 'monday-to-qb', eventId: event.mondayItemId });
      await deps.mondayEventStore.updateStatus(event.mondayItemId, 'queued');
    } catch (err) {
      await deps.mondayEventStore.updateStatus(event.mondayItemId, 'failed', {
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
git add src/monday/webhook/route.ts src/monday/webhook/route.test.ts
git commit -m "feat(quickbooks-sync): Monday webhook route (challenge, board filter, link-skip, enqueue)"
```

---

### Task 14: Queue consumer (both directions)

**Files:**
- Create: `quickbooks-sync/src/consumer/processBatch.ts`
- Test: `quickbooks-sync/src/consumer/processBatch.test.ts`

**Interfaces:**
- Consumes: `QbEventStore` (Task 4), `MondayEventStore` (Task 5), `MapStore` (Task 3), `MondayClient` (Task 8), `QuickBooksClient` (Task 7), `mapQbToMondayColumns`, `mapMondayToQbCustomerFields`, `getPath` (Task 9), `QuickbooksSyncConfig`, `QueueMessage` (Task 1)
- Produces: `processSyncQueueBatch(messages, deps): Promise<void>`, `QueueMessageLike<T>`, `ConsumerDeps` — consumed by `index.ts` (Task 15).

This is the only file that touches both API clients and the field-mapping module — the single place `qb-to-monday` upserts (create-or-update, QuickBooks always wins) and `monday-to-qb` creates (never updates) actually happen.

- [ ] **Step 1: Write the failing test — `quickbooks-sync/src/consumer/processBatch.test.ts`**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { processSyncQueueBatch, type QueueMessageLike } from './processBatch';
import type { QbEventStore } from '../db/qbEvents';
import type { MondayEventStore } from '../db/mondayEvents';
import type { MapStore } from '../db/map';
import type { MondayClient } from '../monday/client';
import type { QuickBooksClient } from '../quickbooks/client';
import type { QbEventRow, MondayEventRow, QueueMessage, QuickbooksSyncConfig } from '../types';

const config: QuickbooksSyncConfig = {
  monday: { apiUrl: 'https://api.monday.com/v2', boards: { customers: 111, invoices: 222, products: 333 } },
  quickbooksSync: {
    columnMap: {
      customer: { DisplayName: 'text_col' },
      invoice: { DocNumber: 'text_col', TotalAmt: 'numeric_col' },
      product: { Name: 'text_col' },
    },
    itemNameField: { customer: 'DisplayName', invoice: 'DocNumber', product: 'Name' },
    linkColumn: { invoice: 'connect_col' },
    customerCreateFieldMap: { text_col: 'DisplayName' },
  },
};

function qbEventRow(overrides: Partial<QbEventRow> = {}): QbEventRow {
  return {
    eventId: 'evt-1',
    entityType: 'customer',
    qbId: 'qb-1',
    fetchedPayload: JSON.stringify({ Id: 'qb-1', DisplayName: 'Acme Co' }),
    status: 'queued',
    error: null,
    receivedAt: '2026-08-22T00:00:00.000Z',
    writtenAt: null,
    ...overrides,
  };
}

function mondayEventRow(overrides: Partial<MondayEventRow> = {}): MondayEventRow {
  return {
    eventId: '42',
    mondayItemId: '42',
    rawPayload: JSON.stringify({ text_col: 'New Co' }),
    status: 'queued',
    qbId: null,
    error: null,
    receivedAt: '2026-08-22T00:00:00.000Z',
    writtenAt: null,
    ...overrides,
  };
}

function fakeQbEventStore(overrides: Partial<QbEventStore> = {}): QbEventStore {
  return {
    insertEvent: vi.fn(),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    getEvent: vi.fn().mockResolvedValue(qbEventRow()),
    ...overrides,
  };
}

function fakeMondayEventStore(overrides: Partial<MondayEventStore> = {}): MondayEventStore {
  return {
    insertEvent: vi.fn(),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    getEvent: vi.fn().mockResolvedValue(mondayEventRow()),
    ...overrides,
  };
}

function fakeMapStore(overrides: Partial<MapStore> = {}): MapStore {
  return {
    getByQbId: vi.fn().mockResolvedValue(null),
    getByMondayItemId: vi.fn().mockResolvedValue(null),
    createMapping: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function fakeMondayClient(overrides: Partial<MondayClient> = {}): MondayClient {
  return {
    createItem: vi.fn().mockResolvedValue({ id: 'item-new' }),
    changeColumnValues: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function fakeQuickBooksClient(overrides: Partial<QuickBooksClient> = {}): QuickBooksClient {
  return {
    getEntity: vi.fn(),
    createCustomer: vi.fn().mockResolvedValue({ id: 'qb-new' }),
    ...overrides,
  };
}

function fakeMessage(message: QueueMessage): QueueMessageLike<QueueMessage> & { ack: any; retry: any } {
  return { body: message, ack: vi.fn(), retry: vi.fn() };
}

describe('processSyncQueueBatch — qb-to-monday', () => {
  it('creates a new Monday item and records the mapping when none exists yet', async () => {
    const qbEventStore = fakeQbEventStore();
    const mapStore = fakeMapStore();
    const createItem = vi.fn().mockResolvedValue({ id: 'item-1' });
    const mondayClient = fakeMondayClient({ createItem });
    const message = fakeMessage({ direction: 'qb-to-monday', eventId: 'evt-1' });

    await processSyncQueueBatch([message], {
      qbEventStore,
      mondayEventStore: fakeMondayEventStore(),
      mapStore,
      mondayClient,
      quickBooksClient: fakeQuickBooksClient(),
      config,
    });

    expect(createItem).toHaveBeenCalledWith(111, 'Acme Co', { text_col: 'Acme Co' });
    expect(mapStore.createMapping).toHaveBeenCalledWith({
      entityType: 'customer',
      qbId: 'qb-1',
      mondayItemId: 'item-1',
      mondayBoardId: 111,
      createdAt: expect.any(String),
    });
    expect(qbEventStore.updateStatus).toHaveBeenCalledWith('evt-1', 'written', { writtenAt: expect.any(String) });
    expect(message.ack).toHaveBeenCalled();
  });

  it('updates the existing Monday item instead of creating a duplicate', async () => {
    const mapStore = fakeMapStore({
      getByQbId: vi.fn().mockResolvedValue({
        entityType: 'customer',
        qbId: 'qb-1',
        mondayItemId: 'item-existing',
        mondayBoardId: 111,
        createdAt: '2026-08-22T00:00:00.000Z',
      }),
    });
    const changeColumnValues = vi.fn().mockResolvedValue(undefined);
    const createItem = vi.fn();
    const mondayClient = fakeMondayClient({ changeColumnValues, createItem });
    const message = fakeMessage({ direction: 'qb-to-monday', eventId: 'evt-1' });

    await processSyncQueueBatch([message], {
      qbEventStore: fakeQbEventStore(),
      mondayEventStore: fakeMondayEventStore(),
      mapStore,
      mondayClient,
      quickBooksClient: fakeQuickBooksClient(),
      config,
    });

    expect(changeColumnValues).toHaveBeenCalledWith(111, 'item-existing', { text_col: 'Acme Co' });
    expect(createItem).not.toHaveBeenCalled();
    expect(mapStore.createMapping).not.toHaveBeenCalled();
  });

  it('links an invoice to its customer via qb_monday_map when the customer is already mapped', async () => {
    const qbEventStore = fakeQbEventStore({
      getEvent: vi.fn().mockResolvedValue(
        qbEventRow({
          entityType: 'invoice',
          qbId: 'inv-1',
          fetchedPayload: JSON.stringify({ DocNumber: '1001', TotalAmt: 250, CustomerRef: { value: 'qb-1' } }),
        })
      ),
    });
    const mapStore = fakeMapStore({
      getByQbId: vi.fn(async (entityType: string, qbId: string) => {
        if (entityType === 'customer' && qbId === 'qb-1') {
          return { entityType: 'customer', qbId: 'qb-1', mondayItemId: 'cust-item-1', mondayBoardId: 111, createdAt: '' };
        }
        return null;
      }),
    });
    const createItem = vi.fn().mockResolvedValue({ id: 'inv-item-1' });
    const mondayClient = fakeMondayClient({ createItem });
    const message = fakeMessage({ direction: 'qb-to-monday', eventId: 'evt-1' });

    await processSyncQueueBatch([message], {
      qbEventStore,
      mondayEventStore: fakeMondayEventStore(),
      mapStore,
      mondayClient,
      quickBooksClient: fakeQuickBooksClient(),
      config,
    });

    expect(createItem).toHaveBeenCalledWith(222, '1001', {
      text_col: '1001',
      numeric_col: 250,
      connect_col: { item_ids: [111] },
    });
  });

  it('marks the qb_events row failed and retries the message on a Monday write failure', async () => {
    const qbEventStore = fakeQbEventStore();
    const mondayClient = fakeMondayClient({ createItem: vi.fn().mockRejectedValue(new Error('monday API: HTTP 500')) });
    const message = fakeMessage({ direction: 'qb-to-monday', eventId: 'evt-1' });

    await processSyncQueueBatch([message], {
      qbEventStore,
      mondayEventStore: fakeMondayEventStore(),
      mapStore: fakeMapStore(),
      mondayClient,
      quickBooksClient: fakeQuickBooksClient(),
      config,
    });

    expect(qbEventStore.updateStatus).toHaveBeenCalledWith('evt-1', 'failed', { error: 'monday API: HTTP 500' });
    expect(message.retry).toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('fails and retries when the qb_events row is missing', async () => {
    const qbEventStore = fakeQbEventStore({ getEvent: vi.fn().mockResolvedValue(null) });
    const message = fakeMessage({ direction: 'qb-to-monday', eventId: 'missing-evt' });

    await processSyncQueueBatch([message], {
      qbEventStore,
      mondayEventStore: fakeMondayEventStore(),
      mapStore: fakeMapStore(),
      mondayClient: fakeMondayClient(),
      quickBooksClient: fakeQuickBooksClient(),
      config,
    });

    expect(message.retry).toHaveBeenCalled();
    expect(qbEventStore.updateStatus).toHaveBeenCalledWith('missing-evt', 'failed', { error: expect.any(String) });
  });
});

describe('processSyncQueueBatch — monday-to-qb', () => {
  it('creates a QuickBooks customer and records the new mapping', async () => {
    const mondayEventStore = fakeMondayEventStore();
    const mapStore = fakeMapStore();
    const createCustomer = vi.fn().mockResolvedValue({ id: 'qb-new' });
    const quickBooksClient = fakeQuickBooksClient({ createCustomer });
    const message = fakeMessage({ direction: 'monday-to-qb', eventId: '42' });

    await processSyncQueueBatch([message], {
      qbEventStore: fakeQbEventStore(),
      mondayEventStore,
      mapStore,
      mondayClient: fakeMondayClient(),
      quickBooksClient,
      config,
    });

    expect(createCustomer).toHaveBeenCalledWith({ DisplayName: 'New Co' });
    expect(mapStore.createMapping).toHaveBeenCalledWith({
      entityType: 'customer',
      qbId: 'qb-new',
      mondayItemId: '42',
      mondayBoardId: 111,
      createdAt: expect.any(String),
    });
    expect(mondayEventStore.updateStatus).toHaveBeenCalledWith('42', 'written', {
      qbId: 'qb-new',
      writtenAt: expect.any(String),
    });
    expect(message.ack).toHaveBeenCalled();
  });

  it('marks the monday_events row failed and retries on a QuickBooks create failure', async () => {
    const mondayEventStore = fakeMondayEventStore();
    const quickBooksClient = fakeQuickBooksClient({
      createCustomer: vi.fn().mockRejectedValue(new Error('quickbooks API: HTTP 500 creating customer')),
    });
    const message = fakeMessage({ direction: 'monday-to-qb', eventId: '42' });

    await processSyncQueueBatch([message], {
      qbEventStore: fakeQbEventStore(),
      mondayEventStore,
      mapStore: fakeMapStore(),
      mondayClient: fakeMondayClient(),
      quickBooksClient,
      config,
    });

    expect(mondayEventStore.updateStatus).toHaveBeenCalledWith('42', 'failed', {
      error: 'quickbooks API: HTTP 500 creating customer',
    });
    expect(message.retry).toHaveBeenCalled();
  });

  it('fails and retries when the monday_events row is missing', async () => {
    const mondayEventStore = fakeMondayEventStore({ getEvent: vi.fn().mockResolvedValue(null) });
    const message = fakeMessage({ direction: 'monday-to-qb', eventId: 'missing-item' });

    await processSyncQueueBatch([message], {
      qbEventStore: fakeQbEventStore(),
      mondayEventStore,
      mapStore: fakeMapStore(),
      mondayClient: fakeMondayClient(),
      quickBooksClient: fakeQuickBooksClient(),
      config,
    });

    expect(message.retry).toHaveBeenCalled();
    expect(mondayEventStore.updateStatus).toHaveBeenCalledWith('missing-item', 'failed', { error: expect.any(String) });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- processBatch.test.ts`
Expected: FAIL — `./processBatch` module not found.

- [ ] **Step 3: Write `quickbooks-sync/src/consumer/processBatch.ts`**

```typescript
import type { MapStore } from '../db/map';
import type { MondayEventStore } from '../db/mondayEvents';
import type { QbEventStore } from '../db/qbEvents';
import { getPath, mapMondayToQbCustomerFields, mapQbToMondayColumns } from '../mapping/fieldMap';
import type { MondayClient } from '../monday/client';
import type { QuickBooksClient } from '../quickbooks/client';
import type { EntityType, MondayBoards, QueueMessage, QuickbooksSyncConfig } from '../types';

export interface QueueMessageLike<T> {
  body: T;
  ack(): void;
  retry(): void;
}

export interface ConsumerDeps {
  qbEventStore: QbEventStore;
  mondayEventStore: MondayEventStore;
  mapStore: MapStore;
  mondayClient: MondayClient;
  quickBooksClient: QuickBooksClient;
  config: QuickbooksSyncConfig;
}

const BOARD_KEY_FOR_ENTITY: Record<EntityType, keyof MondayBoards> = {
  customer: 'customers',
  invoice: 'invoices',
  product: 'products',
};

export async function processSyncQueueBatch(
  messages: QueueMessageLike<QueueMessage>[],
  deps: ConsumerDeps
): Promise<void> {
  for (const message of messages) {
    try {
      if (message.body.direction === 'qb-to-monday') {
        await processQbToMonday(message.body.eventId, deps);
      } else {
        await processMondayToQb(message.body.eventId, deps);
      }
      message.ack();
    } catch (err) {
      const error = (err as Error).message;
      if (message.body.direction === 'qb-to-monday') {
        await deps.qbEventStore.updateStatus(message.body.eventId, 'failed', { error });
      } else {
        await deps.mondayEventStore.updateStatus(message.body.eventId, 'failed', { error });
      }
      message.retry();
    }
  }
}

async function processQbToMonday(eventId: string, deps: ConsumerDeps): Promise<void> {
  const event = await deps.qbEventStore.getEvent(eventId);
  if (event === null) {
    throw new Error(`quickbooks-sync consumer: no qb_events row for "${eventId}"`);
  }

  const boardKey = BOARD_KEY_FOR_ENTITY[event.entityType];
  const boardId = deps.config.monday.boards[boardKey];
  if (boardId === null) {
    throw new Error(`config: monday.boards.${boardKey} is not configured`);
  }

  const record = JSON.parse(event.fetchedPayload ?? '{}') as Record<string, unknown>;
  const columnValues = mapQbToMondayColumns(event.entityType, record, deps.config);

  if (event.entityType === 'invoice') {
    const customerRef = record.CustomerRef as { value?: string } | undefined;
    if (customerRef?.value) {
      const customerMapping = await deps.mapStore.getByQbId('customer', customerRef.value);
      if (customerMapping) {
        columnValues[deps.config.quickbooksSync.linkColumn.invoice] = {
          item_ids: [Number(customerMapping.mondayItemId)],
        };
      }
    }
  }

  const existing = await deps.mapStore.getByQbId(event.entityType, event.qbId);
  const itemNameValue = getPath(record, deps.config.quickbooksSync.itemNameField[event.entityType]);
  const itemName = typeof itemNameValue === 'string' && itemNameValue.length > 0 ? itemNameValue : event.qbId;

  if (existing) {
    await deps.mondayClient.changeColumnValues(boardId, existing.mondayItemId, columnValues);
  } else {
    const created = await deps.mondayClient.createItem(boardId, itemName, columnValues);
    await deps.mapStore.createMapping({
      entityType: event.entityType,
      qbId: event.qbId,
      mondayItemId: created.id,
      mondayBoardId: boardId,
      createdAt: new Date().toISOString(),
    });
  }

  await deps.qbEventStore.updateStatus(eventId, 'written', { writtenAt: new Date().toISOString() });
}

async function processMondayToQb(eventId: string, deps: ConsumerDeps): Promise<void> {
  const event = await deps.mondayEventStore.getEvent(eventId);
  if (event === null) {
    throw new Error(`quickbooks-sync consumer: no monday_events row for "${eventId}"`);
  }

  const customersBoardId = deps.config.monday.boards.customers;
  if (customersBoardId === null) {
    throw new Error('config: monday.boards.customers is not configured');
  }

  const columnValues = JSON.parse(event.rawPayload) as Record<string, unknown>;
  const qbFields = mapMondayToQbCustomerFields(columnValues, deps.config);
  const created = await deps.quickBooksClient.createCustomer(qbFields);

  await deps.mapStore.createMapping({
    entityType: 'customer',
    qbId: created.id,
    mondayItemId: event.mondayItemId,
    mondayBoardId: customersBoardId,
    createdAt: new Date().toISOString(),
  });

  await deps.mondayEventStore.updateStatus(eventId, 'written', {
    qbId: created.id,
    writtenAt: new Date().toISOString(),
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- processBatch.test.ts`
Expected: PASS, all 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/consumer
git commit -m "feat(quickbooks-sync): queue consumer (qb-to-monday upsert, monday-to-qb create)"
```

---

### Task 15: Wire the real Worker entry point

**Files:**
- Modify: `quickbooks-sync/src/index.ts`
- Test: `quickbooks-sync/src/index.test.ts` (extend the Task 1 file)

**Interfaces:**
- Consumes: everything produced by Tasks 2–14 (`validateConfig`, `D1QbEventStore`, `D1MondayEventStore`, `D1MapStore`, `D1TokenStore`, `HttpQuickBooksClient`, `HttpMondayClient`, `createQbWebhookApp`, `createMondayWebhookApp`, `processSyncQueueBatch`)

- [ ] **Step 1: Extend the failing test — append to `quickbooks-sync/src/index.test.ts`**

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

- [ ] **Step 3: Rewrite `quickbooks-sync/src/index.ts`**

```typescript
import { Hono } from 'hono';
import rawConfig from '../config/svbc.json';
import { validateConfig } from './config';
import { processSyncQueueBatch } from './consumer/processBatch';
import { D1MapStore } from './db/map';
import { D1MondayEventStore } from './db/mondayEvents';
import { D1QbEventStore } from './db/qbEvents';
import { HttpMondayClient } from './monday/client';
import { createMondayWebhookApp } from './monday/webhook/route';
import { HttpQuickBooksClient } from './quickbooks/client';
import { D1TokenStore } from './quickbooks/tokenStore';
import { createQbWebhookApp } from './quickbooks/webhook/route';
import type { Env, QueueMessage } from './types';

const config = validateConfig(rawConfig);

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const mapStore = new D1MapStore(env.DB);
    const mondayClient = new HttpMondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN);
    const quickBooksClient = new HttpQuickBooksClient(new D1TokenStore(env.DB), env.QB_CLIENT_ID, env.QB_CLIENT_SECRET);

    const app = new Hono();
    app.route(
      '/',
      createQbWebhookApp({
        qbEventStore: new D1QbEventStore(env.DB),
        quickBooksClient,
        queue: env.SYNC_QUEUE,
        verifierToken: env.QB_WEBHOOK_VERIFIER_TOKEN,
      })
    );
    app.route(
      '/',
      createMondayWebhookApp({
        mondayEventStore: new D1MondayEventStore(env.DB),
        mapStore,
        queue: env.SYNC_QUEUE,
        config,
      })
    );

    return app.fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    await processSyncQueueBatch(batch.messages, {
      qbEventStore: new D1QbEventStore(env.DB),
      mondayEventStore: new D1MondayEventStore(env.DB),
      mapStore: new D1MapStore(env.DB),
      mondayClient: new HttpMondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN),
      quickBooksClient: new HttpQuickBooksClient(new D1TokenStore(env.DB), env.QB_CLIENT_ID, env.QB_CLIENT_SECRET),
      config,
    });
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS, every test file in the project (scaffold, config, map, qbEvents, mondayEvents, tokenStore, quickbooks client, monday client, fieldMap, quickbooks validate, quickbooks route, monday validate, monday route, processBatch, index).

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/index.test.ts
git commit -m "feat(quickbooks-sync): wire real D1/QuickBooks/Monday/Queue implementations into the Worker entry point"
```

- [ ] **Step 7: Provision real infrastructure (manual, one-time, against SVBC's Cloudflare and Intuit accounts)**

Not part of the automated test suite — run these once before the first `wrangler deploy`:

```bash
wrangler d1 create svbc-quickbooks-sync
wrangler queues create quickbooks-sync-writes
wrangler queues create quickbooks-sync-writes-dlq
wrangler secret put MONDAY_API_TOKEN
wrangler secret put QB_CLIENT_ID
wrangler secret put QB_CLIENT_SECRET
wrangler secret put QB_WEBHOOK_VERIFIER_TOKEN
```

Then, paste the resulting `database_id` into `wrangler.jsonc`. Beyond the standard secrets, this Worker needs three things no other Worker in this repo needs:

1. **Register a QuickBooks app** in the Intuit Developer dashboard, get a Client ID/Secret, and set up the webhooks subscription (Customer, Invoice, Item) pointing at this Worker's `/webhooks/quickbooks` URL — configure the Webhooks Verifier Token there too, matching `QB_WEBHOOK_VERIFIER_TOKEN`.
2. **Obtain the initial OAuth tokens** via Intuit's OAuth 2.0 Playground (per Task 7 Step 5) — a one-time interactive consent flow against SVBC's real QuickBooks company — then seed the `qb_oauth_tokens` row directly:
   ```bash
   wrangler d1 execute svbc-quickbooks-sync --remote --command \
     "INSERT INTO qb_oauth_tokens (id, realm_id, access_token, refresh_token, access_token_expires_at, updated_at) VALUES (1, '<realm id>', '<access token>', '<refresh token>', '<iso timestamp ~1hr out>', '<now>')"
   ```
3. **Complete the QuickBooks production-key assessment questionnaire** (per the spec's Auth section) before this Worker can use real production data — sandbox keys work for every step above and for the whole build.
4. **Configure a monday.com board automation** on the Customers board (once its board id is decided — the spec's open Board mapping question) — "when an item is created, send a webhook" pointing at this Worker's `/webhooks/monday` URL.

- [ ] **Step 8: Manual smoke test with `wrangler dev`**

Run: `npm run dev`, then in a second terminal, exercise the Monday-side path (doesn't require live QuickBooks credentials, since it only enqueues — the actual QuickBooks write in Task 14 would fail against a real API without step 7's tokens, which is expected until they're provisioned):

```bash
curl -X POST http://localhost:8787/webhooks/monday \
  -H 'Content-Type: application/json' \
  -d '{"challenge":"smoke-test-123"}'
```

Expected: `{"challenge":"smoke-test-123"}` — confirms the local D1 + Queue + Hono wiring runs end to end before any real QuickBooks/Monday credentials are involved.

- [ ] **Step 9: Note the outstanding manual follow-up (not code, don't skip)**

Set up a native Slack automation that pings on a message landing in `quickbooks-sync-writes-dlq`, per the root README's reliability guidance — a dashboard configuration step, not a code change, and not covered by this plan's automated tasks.

---

## Self-Review

**Spec coverage:**
- Architecture (two webhook routes → shared D1/Queue → one consumer) — Tasks 1, 4, 5, 11, 13, 14, 15.
- Scope asymmetry (Customers bidirectional; Invoices/Products QuickBooks→Monday only) — enforced structurally: only the Customers board triggers the Monday webhook route (Task 13), and `processMondayToQb` (Task 14) only ever creates Customers.
- Identity linkage via `qb_monday_map`, no email/name matching — Task 3.
- `qb_events`/`monday_events` schemas and dedup-by-event-id — Tasks 1, 4, 5.
- Conflict Policy ("QuickBooks wins", Monday→QuickBooks only creates) — Task 13's already-linked skip, Task 14's create-only `processMondayToQb`, called out explicitly in both.
- Auth & QuickBooks production keys (OAuth refresh, production-key assessment as a pre-launch step) — Tasks 6, 7, 15 (Step 7).
- Monday-side webhook mechanism (unconfirmed, challenge handshake) — Task 12, flagged inline.
- Config-driven field mapping (board ids, column maps, all `null`/placeholder until SVBC decides) — Tasks 2, 9.
- Error handling & reliability (Queue retry/DLQ, malformed payload returns 200/401, DLQ Slack ping) — Tasks 11, 13, 14, 15 (Step 9).
- Testing (unit tests per module, D1 via `@cloudflare/vitest-plugin`, no live QuickBooks/Monday calls in CI) — every task.
- Open items (target boards, production-key assessment, Monday webhook payload shape, real field mapping) — carried as explicit `null`/placeholder config values and inline comments, never hardcoded or silently assumed.

**Placeholder scan:** No "TBD"/"implement later" in any step. `config/svbc.json`'s QuickBooks field names and Monday column ids are intentionally illustrative placeholders — this is the spec's approved config-stub design, not an unresolved plan gap, and every consumer of those values reads them from config rather than hardcoding them.

**Type consistency:** `EntityType`, `SyncStatus`, `QbEventRow`, `MondayEventRow`, `MapEntry`, `MondayBoards`, `QuickbooksSyncConfig`, `QueueMessage`, and `Env` are defined once in Task 1's `src/types.ts` and referenced with the same names and shapes in every later task — checked across Tasks 3–5 (stores), 6–8 (clients), 9 (mapping), 10–13 (webhooks), 14 (consumer), and 15 (wiring). `QueueLike` (Task 11) is reused unmodified by `monday/webhook/route.ts` (Task 13) rather than redefined.

