# donor-portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Work happens in a new git worktree (`monday-workers-donor-portal`, branch `feat/donor-portal`, off `main`) — create it via superpowers:using-git-worktrees before Task 1 if it doesn't already exist.

**Goal:** Build the `donor-portal` Cloudflare Worker: a public-facing, read-only self-service
portal where donors log in via a passwordless email magic link to see their donation history and
membership/discount benefits.

**Architecture:** A Hono app with two D1-backed stores (single-use magic-link tokens, sessions) and
a third for per-email rate-limit tracking. `POST /login` resolves the email against Monday's Donors
board, issues a hashed single-use token, and emails a link via Resend — always returning the same
generic response regardless of match, to guard against email enumeration. `GET /auth/callback`
verifies the token once, then mints a session covering every Donor item id matched at request time
(a session may cover more than one person, since a shared email can match multiple Donor items).
`GET /portal` reads only the session's resolved id set — it never re-derives "whose data" from a
client-supplied id or email — and renders each matched donor's history under its own name header.

**Tech Stack:** Hono + TypeScript + Cloudflare D1, Cloudflare's Rate Limiting binding (wrapped behind
an interface so tests don't depend on its local simulation), Resend for email, Vitest with
`@cloudflare/vitest-plugin` for D1-backed tests, `wrangler` for dev/deploy.

**Spec:** [`docs/superpowers/specs/2026-08-22-donor-portal-design.md`](../specs/2026-08-22-donor-portal-design.md)

## Global Constraints

- Package versions pinned to match the sibling `funraise-sync`/`membership-reminders` Workers:
  `hono@^4.13.3`, `typescript@^7.0.2`, `vitest@^4.1.11`, `wrangler@^4.125.0`,
  `@cloudflare/workers-types@^5.20260822.1`, `@cloudflare/vitest-plugin@^1.0.0` (this Worker uses D1,
  same as `funraise-sync`).
- TypeScript: `strict: true`, `noUncheckedIndexedAccess: true`, `target/module: ES2022`,
  `moduleResolution: Bundler` — matches every existing Worker's `tsconfig.json`.
- No new runtime validation library — hand-rolled validators with descriptive thrown errors,
  matching `config.ts`'s existing pattern in `membership-reminders`/`funraise-sync`.
- `MONDAY_API_TOKEN` and `RESEND_API_KEY` are secrets via `wrangler secret put`, never written to
  `config/svbc.json` or logged.
- **Never accept a donor item id or email as a client-supplied parameter for "whose data to
  show."** Every read is scoped server-side from the id set attached to the verified session
  (spec: Multi-donor-match session model).
- **Token/session hashing:** only a SHA-256 hash of a token is ever stored in D1, never the raw
  value (spec: Token/session hashing).
- **Email-enumeration guard:** a matching email, a non-matching email, and a rate-limited request
  must all produce the exact same response. No branch in `routes.ts` may vary the response based on
  match state (spec: Error handling).
- **Rate limiting is per-IP *and* per-email**, and the platform Rate Limiting binding is wrapped
  behind the `IpRateLimiter` interface (Task 6) so unit tests use a fake, never a real binding
  simulation — the same boundary-mocking approach already used for the Monday API and Resend
  clients in this repo.
- Real Monday board/column IDs are placeholders in `config/svbc.json` until the Membership/Discount
  columns exist in production (spec: Monday board/column IDs) — every place that needs one reads
  config, never hardcodes.
- All donor-sourced or Monday-sourced text rendered into HTML (names, discount terms, donation
  descriptions) must go through the shared `escapeHtml()` helper in `src/views.ts` — never
  interpolated into a template literal unescaped.
- This Worker is being wired to send real Resend email in v1, unlike `membership-reminders`'s
  deferred stub — going live also requires the non-code steps in the spec's Pre-launch checklist
  (domain verification, real column IDs, a dedicated Monday integration token). This plan builds
  the code; it doesn't complete that checklist.

---

## File structure

```
donor-portal/
  wrangler.jsonc                  # Worker + D1 + Rate Limiting config
  package.json
  tsconfig.json
  config/svbc.json                # board/column placeholders, Resend from-address, TTLs, rate limits
  migrations/0001_create_auth_tables.sql
  vitest.config.ts                # @cloudflare/vitest-plugin wiring (D1-backed tests)
  test/apply-migrations.ts        # setup file: applies D1 migrations before tests
  test/env.d.ts                   # types the `env` import inside tests
  src/
    types.ts                      # Config, Env, and all cross-file data shapes
    config.ts                     # validateConfig
    config.test.ts
    crypto/
      hash.ts                    # sha256Hex
      hash.test.ts
      token.ts                   # generateToken
      token.test.ts
    db/
      tokens.ts                  # MagicLinkTokenStore + D1MagicLinkTokenStore
      tokens.test.ts
      sessions.ts                # SessionStore + D1SessionStore
      sessions.test.ts
      loginAttempts.ts           # LoginAttemptStore + D1LoginAttemptStore
      loginAttempts.test.ts
    ratelimit.ts                  # IpRateLimiter + checkLoginRateLimit (combined IP+email)
    ratelimit.test.ts
    monday/
      client.ts                  # MondayClient interface + HttpMondayClient
      client.test.ts
    email/
      resend.ts                  # EmailSender interface + ResendEmailSender
      resend.test.ts
    auth/
      requestLogin.ts             # email -> lookup -> token -> send email (enumeration-safe)
      requestLogin.test.ts
      verifyLogin.ts              # token -> consume -> new session
      verifyLogin.test.ts
    portal/
      loadPortalData.ts           # per-donor Monday reads + shared discount list
      loadPortalData.test.ts
    views.ts                      # server-rendered HTML fragments (manual escapeHtml, no templating lib)
    views.test.ts
    routes.ts                     # createApp(deps): the Hono app, wired to fakes in tests
    routes.test.ts
    index.ts                      # wires real D1/Monday/Resend/RateLimiter into createApp
```

One clear responsibility per file: `routes.ts` never talks to Monday or D1 directly (it calls
`auth/requestLogin.ts`, `auth/verifyLogin.ts`, `portal/loadPortalData.ts`), `ratelimit.ts` never
touches Monday, and `views.ts` is pure rendering with no I/O — each is testable in isolation with
fakes for its dependencies.

---

### Task 1: Project scaffold

**Files:**
- Create: `donor-portal/wrangler.jsonc`
- Create: `donor-portal/package.json`
- Create: `donor-portal/tsconfig.json`
- Create: `donor-portal/migrations/0001_create_auth_tables.sql`
- Create: `donor-portal/vitest.config.ts`
- Create: `donor-portal/test/apply-migrations.ts`
- Create: `donor-portal/test/env.d.ts`
- Create: `donor-portal/src/types.ts`
- Create: `donor-portal/src/index.ts`
- Test: `donor-portal/src/index.test.ts`

**Interfaces:**
- Produces: `Env`, `Config`, `MondayColumns`, `DonorMatch`, `DonationRecord`, `DonorPortalData`,
  `DiscountOrganization`, `PortalView` (all from `src/types.ts`) — consumed by every later task.

- [ ] **Step 1: Create `donor-portal/package.json`**

```json
{
  "name": "donor-portal",
  "version": "0.1.0",
  "description": "Public-facing donor self-service portal: donation history and membership/discount benefits via passwordless email login.",
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

- [ ] **Step 2: Create `donor-portal/tsconfig.json`**

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

- [ ] **Step 3: Create `donor-portal/migrations/0001_create_auth_tables.sql`**

```sql
CREATE TABLE magic_link_tokens (
  token_hash TEXT PRIMARY KEY,
  donor_item_ids TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE sessions (
  session_hash TEXT PRIMARY KEY,
  donor_item_ids TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  attempted_at TEXT NOT NULL
);

CREATE INDEX idx_login_attempts_email_time ON login_attempts (email, attempted_at);
```

- [ ] **Step 4: Create `donor-portal/wrangler.jsonc`**

```jsonc
{
  "name": "svbc-donor-portal",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-01",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "svbc-donor-portal",
      // Replace after running: wrangler d1 create svbc-donor-portal
      "database_id": "REPLACE_AFTER_WRANGLER_D1_CREATE",
      "migrations_dir": "migrations"
    }
  ],
  "ratelimits": [
    {
      // Verify this binding's config shape (key name, "simple" vs another rule type) against
      // Cloudflare's current Rate Limiting for Workers docs before deploy. Wrapped behind the
      // IpRateLimiter interface (src/ratelimit.ts) specifically so that verification is isolated
      // to one small area and never touches test code.
      "name": "LOGIN_RATE_LIMITER",
      "namespace_id": "1001",
      "simple": { "limit": 10, "period": 60 }
    }
  ],
  "observability": {
    "enabled": true
  }
}
```

- [ ] **Step 5: Create `donor-portal/src/types.ts`**

```typescript
export interface MondayColumns {
  donorEmail: string;
  membershipStatus: string;
  membershipTier: string;
  dollarDonated: string;
  donationDonorLink: string;
  donationAmount: string;
  donationDate: string;
  donationDescription: string;
  discountOffered: string;
  discountActive: string;
}

export interface Config {
  monday: {
    apiUrl: string;
    donorsBoardId: number | null;
    donationsBoardId: number | null;
    organizationsBoardId: number | null;
    columns: MondayColumns;
  };
  resend: {
    fromAddress: string;
    fromName: string;
  };
  auth: {
    magicLinkTtlMinutes: number;
    sessionTtlHours: number;
    portalBaseUrl: string;
  };
  rateLimit: {
    emailWindowSeconds: number;
    emailMaxAttempts: number;
  };
}

export interface DonorMatch {
  id: string;
  name: string;
}

export interface DonationRecord {
  date: string;
  amount: string;
  description: string;
}

export interface DonorPortalData {
  id: string;
  name: string;
  membershipStatus: string;
  membershipTier: string;
  totalDonated: string;
  donations: DonationRecord[];
}

export interface DiscountOrganization {
  name: string;
  discountOffered: string;
}

export interface PortalView {
  donors: DonorPortalData[];
  discounts: DiscountOrganization[];
}

export interface Env {
  DB: D1Database;
  MONDAY_API_TOKEN: string;
  RESEND_API_KEY: string;
  LOGIN_RATE_LIMITER: RateLimit;
}
```

- [ ] **Step 6: Create `donor-portal/src/index.ts`** (temporary minimal health check — Task 15 replaces this with the full wiring)

```typescript
import { Hono } from 'hono';
import type { Env } from './types';

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ ok: true }));

export default {
  fetch: app.fetch,
};
```

- [ ] **Step 7: Create `donor-portal/vitest.config.ts`**

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

- [ ] **Step 8: Create `donor-portal/test/apply-migrations.ts`**

```typescript
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

- [ ] **Step 9: Create `donor-portal/test/env.d.ts`**

Ambient script (no top-level `import`/`export`), same reasoning as `funraise-sync`'s: this merges
into the global `Cloudflare.Env` namespace that `@cloudflare/workers-types` declares, which is what
`cloudflare:test`/`cloudflare:workers`'s `env` export is typed against.

```typescript
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    MONDAY_API_TOKEN: string;
    RESEND_API_KEY: string;
    LOGIN_RATE_LIMITER: RateLimit;
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}
```

- [ ] **Step 10: Write the failing test — `donor-portal/src/index.test.ts`**

```typescript
import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';

describe('scaffold', () => {
  it('applies the auth tables migration', async () => {
    const tokens = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='magic_link_tokens'"
    ).first();
    const sessions = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'"
    ).first();
    const attempts = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='login_attempts'"
    ).first();
    expect(tokens).not.toBeNull();
    expect(sessions).not.toBeNull();
    expect(attempts).not.toBeNull();
  });
});
```

- [ ] **Step 11: Install dependencies and run the test**

Run: `cd donor-portal && npm install && npm test`
Expected: PASS — `@cloudflare/vitest-plugin` provisions its own local D1 and applies the migration
automatically. If it fails with a binding error, confirm `wrangler.jsonc`'s `d1_databases[0].database_id`
is present (any placeholder string is fine for local test-only runs).

- [ ] **Step 12: Run typecheck**

Run: `npm run typecheck`
Expected: PASS, no errors.

- [ ] **Step 13: Commit**

```bash
cd donor-portal
git add wrangler.jsonc package.json tsconfig.json migrations vitest.config.ts test src
git commit -m "feat(donor-portal): project scaffold with D1-backed test harness"
```

---

### Task 2: Config loading and validation

**Files:**
- Create: `donor-portal/config/svbc.json`
- Create: `donor-portal/src/config.ts`
- Test: `donor-portal/src/config.test.ts`

**Interfaces:**
- Consumes: `Config`, `MondayColumns` (Task 1's `src/types.ts`)
- Produces: `validateConfig(raw: unknown): Config`, consumed by `src/index.ts` (Task 15) and every
  test file that needs a valid config fixture.

- [ ] **Step 1: Create `donor-portal/config/svbc.json`**

Board ids and column ids are placeholders — the Membership Status/Tier columns (Donors board) and
Discount Offered/Active columns (Organizations board) don't exist in production Monday yet (spec:
Monday board/column IDs). Filling in real ids later is a config edit, not a code change.

```json
{
  "monday": {
    "apiUrl": "https://api.monday.com/v2",
    "donorsBoardId": null,
    "donationsBoardId": null,
    "organizationsBoardId": null,
    "columns": {
      "donorEmail": "REPLACE_WITH_COLUMN_ID",
      "membershipStatus": "REPLACE_WITH_COLUMN_ID",
      "membershipTier": "REPLACE_WITH_COLUMN_ID",
      "dollarDonated": "REPLACE_WITH_COLUMN_ID",
      "donationDonorLink": "REPLACE_WITH_COLUMN_ID",
      "donationAmount": "REPLACE_WITH_COLUMN_ID",
      "donationDate": "REPLACE_WITH_COLUMN_ID",
      "donationDescription": "REPLACE_WITH_COLUMN_ID",
      "discountOffered": "REPLACE_WITH_COLUMN_ID",
      "discountActive": "REPLACE_WITH_COLUMN_ID"
    }
  },
  "resend": {
    "fromAddress": "login@mail.bikesiliconvalley.org",
    "fromName": "SVBC Donor Portal"
  },
  "auth": {
    "magicLinkTtlMinutes": 15,
    "sessionTtlHours": 24,
    "portalBaseUrl": "https://portal.bikesiliconvalley.org"
  },
  "rateLimit": {
    "emailWindowSeconds": 900,
    "emailMaxAttempts": 5
  }
}
```

- [ ] **Step 2: Write the failing test — `donor-portal/src/config.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { validateConfig } from './config';

const validConfig = {
  monday: {
    apiUrl: 'https://api.monday.com/v2',
    donorsBoardId: null,
    donationsBoardId: null,
    organizationsBoardId: null,
    columns: {
      donorEmail: 'email_col',
      membershipStatus: 'status_col',
      membershipTier: 'tier_col',
      dollarDonated: 'donated_col',
      donationDonorLink: 'link_col',
      donationAmount: 'amount_col',
      donationDate: 'date_col',
      donationDescription: 'desc_col',
      discountOffered: 'offer_col',
      discountActive: 'active_col',
    },
  },
  resend: { fromAddress: 'login@example.org', fromName: 'Test Portal' },
  auth: { magicLinkTtlMinutes: 15, sessionTtlHours: 24, portalBaseUrl: 'https://example.org' },
  rateLimit: { emailWindowSeconds: 900, emailMaxAttempts: 5 },
};

describe('validateConfig', () => {
  it('returns the config unchanged when valid', () => {
    expect(validateConfig(validConfig)).toEqual(validConfig);
  });

  it('throws when a top-level key is missing', () => {
    const { resend, ...missing } = validConfig;
    expect(() => validateConfig(missing)).toThrow(/resend/);
  });

  it('throws when monday.columns is missing a column', () => {
    const { donorEmail, ...missingEmail } = validConfig.monday.columns;
    const broken = { ...validConfig, monday: { ...validConfig.monday, columns: missingEmail } };
    expect(() => validateConfig(broken)).toThrow(/donorEmail/);
  });

  it('throws when resend is missing a key', () => {
    const { fromName, ...rest } = validConfig.resend;
    const broken = { ...validConfig, resend: rest };
    expect(() => validateConfig(broken)).toThrow(/fromName/);
  });

  it('throws when auth is missing a key', () => {
    const { portalBaseUrl, ...rest } = validConfig.auth;
    const broken = { ...validConfig, auth: rest };
    expect(() => validateConfig(broken)).toThrow(/portalBaseUrl/);
  });

  it('throws when rateLimit is missing a key', () => {
    const { emailMaxAttempts, ...rest } = validConfig.rateLimit;
    const broken = { ...validConfig, rateLimit: rest };
    expect(() => validateConfig(broken)).toThrow(/emailMaxAttempts/);
  });

  it('throws when monday is null', () => {
    expect(() => validateConfig({ ...validConfig, monday: null })).toThrow(/monday/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- config.test.ts`
Expected: FAIL — `validateConfig` is not defined.

- [ ] **Step 4: Write `donor-portal/src/config.ts`**

```typescript
import type { Config, MondayColumns } from './types';

const REQUIRED_TOP_LEVEL = ['monday', 'resend', 'auth', 'rateLimit'] as const;

const REQUIRED_COLUMNS: (keyof MondayColumns)[] = [
  'donorEmail',
  'membershipStatus',
  'membershipTier',
  'dollarDonated',
  'donationDonorLink',
  'donationAmount',
  'donationDate',
  'donationDescription',
  'discountOffered',
  'discountActive',
];

const REQUIRED_RESEND_KEYS = ['fromAddress', 'fromName'] as const;
const REQUIRED_AUTH_KEYS = ['magicLinkTtlMinutes', 'sessionTtlHours', 'portalBaseUrl'] as const;
const REQUIRED_RATE_LIMIT_KEYS = ['emailWindowSeconds', 'emailMaxAttempts'] as const;

function requireObject(cfg: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = cfg[key];
  if (typeof value !== 'object' || value === null) {
    throw new Error(`config: missing required key "${key}"`);
  }
  return value as Record<string, unknown>;
}

function requireKeys(obj: Record<string, unknown>, prefix: string, keys: readonly string[]): void {
  for (const key of keys) {
    if (!(key in obj)) {
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

  const monday = requireObject(cfg, 'monday');
  const columns = requireObject(monday, 'columns');
  requireKeys(columns, 'monday.columns', REQUIRED_COLUMNS);

  const resend = requireObject(cfg, 'resend');
  requireKeys(resend, 'resend', REQUIRED_RESEND_KEYS);

  const auth = requireObject(cfg, 'auth');
  requireKeys(auth, 'auth', REQUIRED_AUTH_KEYS);

  const rateLimit = requireObject(cfg, 'rateLimit');
  requireKeys(rateLimit, 'rateLimit', REQUIRED_RATE_LIMIT_KEYS);

  return cfg as unknown as Config;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- config.test.ts`
Expected: PASS, all 7 assertions.

- [ ] **Step 6: Commit**

```bash
git add config/svbc.json src/config.ts src/config.test.ts
git commit -m "feat(donor-portal): config loading and validation"
```

---

### Task 3: Token crypto primitives

**Files:**
- Create: `donor-portal/src/crypto/hash.ts`
- Test: `donor-portal/src/crypto/hash.test.ts`
- Create: `donor-portal/src/crypto/token.ts`
- Test: `donor-portal/src/crypto/token.test.ts`

**Interfaces:**
- Produces: `sha256Hex(input: string): Promise<string>`, `generateToken(): string` — consumed by
  `db/tokens.ts` and `db/sessions.ts` tests (as fixtures), and by `auth/requestLogin.ts` /
  `auth/verifyLogin.ts` (Tasks 10, 11).

- [ ] **Step 1: Write the failing test — `donor-portal/src/crypto/hash.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { sha256Hex } from './hash';

describe('sha256Hex', () => {
  it('matches the known SHA-256 test vector for the empty string', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'.slice(0, 64)
    );
  });

  it('matches the known SHA-256 test vector for "abc"', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'.slice(0, 64)
    );
  });

  it('is deterministic for the same input', async () => {
    expect(await sha256Hex('same-input')).toBe(await sha256Hex('same-input'));
  });

  it('produces different hashes for different inputs', async () => {
    expect(await sha256Hex('input-a')).not.toBe(await sha256Hex('input-b'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- hash.test.ts`
Expected: FAIL — `./hash` module not found.

- [ ] **Step 3: Write `donor-portal/src/crypto/hash.ts`**

```typescript
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- hash.test.ts`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Write the failing test — `donor-portal/src/crypto/token.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { generateToken } from './token';

describe('generateToken', () => {
  it('returns a 64-character lowercase hex string', () => {
    expect(generateToken()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns a different value on each call', () => {
    expect(generateToken()).not.toBe(generateToken());
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test -- token.test.ts`
Expected: FAIL — `./token` module not found.

- [ ] **Step 7: Write `donor-portal/src/crypto/token.ts`**

```typescript
export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npm test -- token.test.ts`
Expected: PASS, both tests.

- [ ] **Step 9: Commit**

```bash
git add src/crypto
git commit -m "feat(donor-portal): token hashing and generation primitives"
```

---

### Task 4: D1 magic-link token store

**Files:**
- Create: `donor-portal/src/db/tokens.ts`
- Test: `donor-portal/src/db/tokens.test.ts`

**Interfaces:**
- Produces: `MagicLinkTokenStore` interface, `D1MagicLinkTokenStore` class — consumed by
  `auth/requestLogin.ts` (Task 10), `auth/verifyLogin.ts` (Task 11), and `index.ts` (Task 15).

- [ ] **Step 1: Write the failing test — `donor-portal/src/db/tokens.test.ts`**

```typescript
import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1MagicLinkTokenStore } from './tokens';

describe('D1MagicLinkTokenStore', () => {
  it('consumes a valid, unexpired token exactly once', async () => {
    const store = new D1MagicLinkTokenStore(env.DB);
    await store.createToken({
      tokenHash: 'hash-1',
      donorItemIds: ['donor-1', 'donor-2'],
      expiresAt: '2026-08-22T01:00:00.000Z',
    });

    const first = await store.consumeToken('hash-1', '2026-08-22T00:30:00.000Z');
    expect(first).toEqual(['donor-1', 'donor-2']);

    const second = await store.consumeToken('hash-1', '2026-08-22T00:31:00.000Z');
    expect(second).toBeNull();
  });

  it('returns null for an expired token', async () => {
    const store = new D1MagicLinkTokenStore(env.DB);
    await store.createToken({
      tokenHash: 'hash-2',
      donorItemIds: ['donor-3'],
      expiresAt: '2026-08-22T01:00:00.000Z',
    });

    const result = await store.consumeToken('hash-2', '2026-08-22T02:00:00.000Z');
    expect(result).toBeNull();
  });

  it('returns null for an unknown token hash', async () => {
    const store = new D1MagicLinkTokenStore(env.DB);
    expect(await store.consumeToken('does-not-exist', '2026-08-22T00:00:00.000Z')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tokens.test.ts`
Expected: FAIL — `./tokens` module not found.

- [ ] **Step 3: Write `donor-portal/src/db/tokens.ts`**

```typescript
export interface NewMagicLinkToken {
  tokenHash: string;
  donorItemIds: string[];
  expiresAt: string;
}

export interface MagicLinkTokenStore {
  createToken(params: NewMagicLinkToken): Promise<void>;
  consumeToken(tokenHash: string, nowISO: string): Promise<string[] | null>;
}

export class D1MagicLinkTokenStore implements MagicLinkTokenStore {
  constructor(private db: D1Database) {}

  async createToken(params: NewMagicLinkToken): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO magic_link_tokens (token_hash, donor_item_ids, expires_at)
         VALUES (?1, ?2, ?3)`
      )
      .bind(params.tokenHash, JSON.stringify(params.donorItemIds), params.expiresAt)
      .run();
  }

  async consumeToken(tokenHash: string, nowISO: string): Promise<string[] | null> {
    const claim = await this.db
      .prepare(
        `UPDATE magic_link_tokens SET used_at = ?2
         WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2`
      )
      .bind(tokenHash, nowISO)
      .run();

    if (claim.meta.changes === 0) {
      return null;
    }

    const row = await this.db
      .prepare(`SELECT donor_item_ids FROM magic_link_tokens WHERE token_hash = ?1`)
      .bind(tokenHash)
      .first<{ donor_item_ids: string }>();

    return row === null ? null : (JSON.parse(row.donor_item_ids) as string[]);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tokens.test.ts`
Expected: PASS, all 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/db/tokens.ts src/db/tokens.test.ts
git commit -m "feat(donor-portal): D1 single-use magic-link token store"
```

---

### Task 5: D1 session store

**Files:**
- Create: `donor-portal/src/db/sessions.ts`
- Test: `donor-portal/src/db/sessions.test.ts`

**Interfaces:**
- Produces: `SessionStore` interface, `D1SessionStore` class — consumed by
  `auth/verifyLogin.ts` (Task 11), `routes.ts` (Task 14), and `index.ts` (Task 15).

- [ ] **Step 1: Write the failing test — `donor-portal/src/db/sessions.test.ts`**

```typescript
import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1SessionStore } from './sessions';

describe('D1SessionStore', () => {
  it('creates a session and reads back its donor item ids while unexpired', async () => {
    const store = new D1SessionStore(env.DB);
    await store.createSession({
      sessionHash: 'session-1',
      donorItemIds: ['donor-1', 'donor-2'],
      expiresAt: '2026-08-23T00:00:00.000Z',
    });

    const result = await store.getSession('session-1', '2026-08-22T12:00:00.000Z');
    expect(result).toEqual(['donor-1', 'donor-2']);
  });

  it('returns null once the session has expired', async () => {
    const store = new D1SessionStore(env.DB);
    await store.createSession({
      sessionHash: 'session-2',
      donorItemIds: ['donor-3'],
      expiresAt: '2026-08-22T00:00:00.000Z',
    });

    expect(await store.getSession('session-2', '2026-08-23T00:00:00.000Z')).toBeNull();
  });

  it('returns null for an unknown session hash', async () => {
    const store = new D1SessionStore(env.DB);
    expect(await store.getSession('does-not-exist', '2026-08-22T00:00:00.000Z')).toBeNull();
  });

  it('deletes a session so it can no longer be read', async () => {
    const store = new D1SessionStore(env.DB);
    await store.createSession({
      sessionHash: 'session-4',
      donorItemIds: ['donor-4'],
      expiresAt: '2026-08-23T00:00:00.000Z',
    });

    await store.deleteSession('session-4');

    expect(await store.getSession('session-4', '2026-08-22T12:00:00.000Z')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- sessions.test.ts`
Expected: FAIL — `./sessions` module not found.

- [ ] **Step 3: Write `donor-portal/src/db/sessions.ts`**

```typescript
export interface NewSession {
  sessionHash: string;
  donorItemIds: string[];
  expiresAt: string;
}

export interface SessionStore {
  createSession(params: NewSession): Promise<void>;
  getSession(sessionHash: string, nowISO: string): Promise<string[] | null>;
  deleteSession(sessionHash: string): Promise<void>;
}

export class D1SessionStore implements SessionStore {
  constructor(private db: D1Database) {}

  async createSession(params: NewSession): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO sessions (session_hash, donor_item_ids, expires_at)
         VALUES (?1, ?2, ?3)`
      )
      .bind(params.sessionHash, JSON.stringify(params.donorItemIds), params.expiresAt)
      .run();
  }

  async getSession(sessionHash: string, nowISO: string): Promise<string[] | null> {
    const row = await this.db
      .prepare(`SELECT donor_item_ids FROM sessions WHERE session_hash = ?1 AND expires_at > ?2`)
      .bind(sessionHash, nowISO)
      .first<{ donor_item_ids: string }>();
    return row === null ? null : (JSON.parse(row.donor_item_ids) as string[]);
  }

  async deleteSession(sessionHash: string): Promise<void> {
    await this.db.prepare(`DELETE FROM sessions WHERE session_hash = ?1`).bind(sessionHash).run();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- sessions.test.ts`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/db/sessions.ts src/db/sessions.test.ts
git commit -m "feat(donor-portal): D1 session store"
```

---

### Task 6: D1 per-email login-attempt store

**Files:**
- Create: `donor-portal/src/db/loginAttempts.ts`
- Test: `donor-portal/src/db/loginAttempts.test.ts`

**Interfaces:**
- Produces: `LoginAttemptStore` interface, `D1LoginAttemptStore` class — consumed by
  `ratelimit.ts` (Task 7) and `index.ts` (Task 15).

- [ ] **Step 1: Write the failing test — `donor-portal/src/db/loginAttempts.test.ts`**

```typescript
import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1LoginAttemptStore } from './loginAttempts';

describe('D1LoginAttemptStore', () => {
  it('counts only attempts recorded after the given cutoff', async () => {
    const store = new D1LoginAttemptStore(env.DB);
    await store.recordAttempt('donor@example.org', '2026-08-22T00:00:00.000Z');
    await store.recordAttempt('donor@example.org', '2026-08-22T00:05:00.000Z');
    await store.recordAttempt('donor@example.org', '2026-08-22T00:20:00.000Z');

    const count = await store.countRecentAttempts('donor@example.org', '2026-08-22T00:04:00.000Z');
    expect(count).toBe(2);
  });

  it('is case-insensitive on email', async () => {
    const store = new D1LoginAttemptStore(env.DB);
    await store.recordAttempt('Mixed.Case@Example.org', '2026-08-22T01:00:00.000Z');

    const count = await store.countRecentAttempts('mixed.case@example.org', '2026-08-22T00:59:00.000Z');
    expect(count).toBe(1);
  });

  it('does not count attempts for a different email', async () => {
    const store = new D1LoginAttemptStore(env.DB);
    await store.recordAttempt('other@example.org', '2026-08-22T02:00:00.000Z');

    const count = await store.countRecentAttempts('nobody@example.org', '2026-08-22T01:59:00.000Z');
    expect(count).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- loginAttempts.test.ts`
Expected: FAIL — `./loginAttempts` module not found.

- [ ] **Step 3: Write `donor-portal/src/db/loginAttempts.ts`**

```typescript
export interface LoginAttemptStore {
  recordAttempt(email: string, attemptedAtISO: string): Promise<void>;
  countRecentAttempts(email: string, sinceISO: string): Promise<number>;
}

export class D1LoginAttemptStore implements LoginAttemptStore {
  constructor(private db: D1Database) {}

  async recordAttempt(email: string, attemptedAtISO: string): Promise<void> {
    await this.db
      .prepare(`INSERT INTO login_attempts (email, attempted_at) VALUES (?1, ?2)`)
      .bind(email.toLowerCase(), attemptedAtISO)
      .run();
  }

  async countRecentAttempts(email: string, sinceISO: string): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) as count FROM login_attempts WHERE email = ?1 AND attempted_at > ?2`)
      .bind(email.toLowerCase(), sinceISO)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- loginAttempts.test.ts`
Expected: PASS, all 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/db/loginAttempts.ts src/db/loginAttempts.test.ts
git commit -m "feat(donor-portal): D1 per-email login-attempt store"
```

---

### Task 7: Combined IP + email rate limiting

**Files:**
- Create: `donor-portal/src/ratelimit.ts`
- Test: `donor-portal/src/ratelimit.test.ts`

**Interfaces:**
- Consumes: `LoginAttemptStore` (Task 6)
- Produces: `IpRateLimiter` interface, `checkLoginRateLimit(ip, email, deps, now): Promise<boolean>`
  — consumed by `routes.ts` (Task 14) and `index.ts` (Task 15).

- [ ] **Step 1: Write the failing test — `donor-portal/src/ratelimit.test.ts`**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { checkLoginRateLimit } from './ratelimit';
import type { IpRateLimiter } from './ratelimit';
import type { LoginAttemptStore } from './db/loginAttempts';

function fakeAttemptStore(recentCount: number): LoginAttemptStore {
  return {
    recordAttempt: vi.fn().mockResolvedValue(undefined),
    countRecentAttempts: vi.fn().mockResolvedValue(recentCount),
  };
}

function fakeIpLimiter(success: boolean): IpRateLimiter {
  return { limit: vi.fn().mockResolvedValue({ success }) };
}

const config = { emailWindowSeconds: 900, emailMaxAttempts: 5 };
const now = new Date('2026-08-22T00:30:00.000Z');

describe('checkLoginRateLimit', () => {
  it('allows the request when both the IP and email are under their limits', async () => {
    const attemptStore = fakeAttemptStore(2);
    const ipLimiter = fakeIpLimiter(true);

    const allowed = await checkLoginRateLimit('1.2.3.4', 'donor@example.org', { ipLimiter, attemptStore, config }, now);

    expect(allowed).toBe(true);
    expect(attemptStore.recordAttempt).toHaveBeenCalledWith('donor@example.org', now.toISOString());
  });

  it('denies the request when the IP limiter reports failure', async () => {
    const attemptStore = fakeAttemptStore(0);
    const ipLimiter = fakeIpLimiter(false);

    const allowed = await checkLoginRateLimit('1.2.3.4', 'donor@example.org', { ipLimiter, attemptStore, config }, now);

    expect(allowed).toBe(false);
  });

  it('denies the request once the email has reached its attempt ceiling', async () => {
    const attemptStore = fakeAttemptStore(5);
    const ipLimiter = fakeIpLimiter(true);

    const allowed = await checkLoginRateLimit('1.2.3.4', 'donor@example.org', { ipLimiter, attemptStore, config }, now);

    expect(allowed).toBe(false);
  });

  it('always records the attempt, even when the request is denied', async () => {
    const attemptStore = fakeAttemptStore(5);
    const ipLimiter = fakeIpLimiter(true);

    await checkLoginRateLimit('1.2.3.4', 'donor@example.org', { ipLimiter, attemptStore, config }, now);

    expect(attemptStore.recordAttempt).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- ratelimit.test.ts`
Expected: FAIL — `./ratelimit` module not found.

- [ ] **Step 3: Write `donor-portal/src/ratelimit.ts`**

```typescript
import type { LoginAttemptStore } from './db/loginAttempts';

export interface IpRateLimiter {
  limit(key: string): Promise<{ success: boolean }>;
}

export interface RateLimitConfig {
  emailWindowSeconds: number;
  emailMaxAttempts: number;
}

export interface RateLimitDeps {
  ipLimiter: IpRateLimiter;
  attemptStore: LoginAttemptStore;
  config: RateLimitConfig;
}

export async function checkLoginRateLimit(
  ip: string,
  email: string,
  deps: RateLimitDeps,
  now: Date
): Promise<boolean> {
  const nowISO = now.toISOString();
  await deps.attemptStore.recordAttempt(email, nowISO);

  const ipResult = await deps.ipLimiter.limit(ip);
  if (!ipResult.success) {
    return false;
  }

  const sinceISO = new Date(now.getTime() - deps.config.emailWindowSeconds * 1000).toISOString();
  const recentCount = await deps.attemptStore.countRecentAttempts(email, sinceISO);

  return recentCount <= deps.config.emailMaxAttempts;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- ratelimit.test.ts`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ratelimit.ts src/ratelimit.test.ts
git commit -m "feat(donor-portal): combined IP + email login rate limiting"
```

---

### Task 8: Monday GraphQL client

**Files:**
- Create: `donor-portal/src/monday/client.ts`
- Test: `donor-portal/src/monday/client.test.ts`

**Interfaces:**
- Consumes: `DonorMatch`, `DonorPortalData`, `DonationRecord`, `DiscountOrganization`, `Config`
  (Task 1's `src/types.ts`)
- Produces: `MondayClient` interface, `HttpMondayClient` class — consumed by
  `auth/requestLogin.ts` (Task 10), `portal/loadPortalData.ts` (Task 12), and `index.ts` (Task 15).

- [ ] **Step 1: Write the failing test — `donor-portal/src/monday/client.test.ts`**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { HttpMondayClient } from './client';
import type { MondayColumns } from '../types';

const columns: MondayColumns = {
  donorEmail: 'email_col',
  membershipStatus: 'status_col',
  membershipTier: 'tier_col',
  dollarDonated: 'donated_col',
  donationDonorLink: 'link_col',
  donationAmount: 'amount_col',
  donationDate: 'date_col',
  donationDescription: 'desc_col',
  discountOffered: 'offer_col',
  discountActive: 'active_col',
};

function fetchReturning(body: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  });
}

describe('HttpMondayClient.findDonorsByEmail', () => {
  it('returns every matching donor item', async () => {
    const fetchMock = fetchReturning({
      data: {
        boards: [{ items_page: { items: [{ id: '1', name: 'Jane' }, { id: '2', name: 'Jane Also' }] } }],
      },
    });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, fetchMock);

    const matches = await client.findDonorsByEmail('shared@example.org');

    expect(matches).toEqual([
      { id: '1', name: 'Jane' },
      { id: '2', name: 'Jane Also' },
    ]);
  });

  it('returns an empty array when nothing matches', async () => {
    const fetchMock = fetchReturning({ data: { boards: [{ items_page: { items: [] } }] } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, fetchMock);

    expect(await client.findDonorsByEmail('nobody@example.org')).toEqual([]);
  });
});

describe('HttpMondayClient.getDonorPortalData', () => {
  it('combines the donor item fields with its linked donations', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            items: [
              {
                id: 'donor-1',
                name: 'Jane Donor',
                column_values: [
                  { id: 'status_col', text: 'Active' },
                  { id: 'tier_col', text: 'Member' },
                  { id: 'donated_col', text: '500' },
                ],
              },
            ],
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            boards: [
              {
                items_page: {
                  cursor: null,
                  items: [
                    {
                      id: 'donation-1',
                      column_values: [
                        { id: 'amount_col', text: '100' },
                        { id: 'date_col', text: '2026-01-01' },
                        { id: 'desc_col', text: 'Annual gift' },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        }),
      });

    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, fetchMock);

    const data = await client.getDonorPortalData('donor-1');

    expect(data).toEqual({
      id: 'donor-1',
      name: 'Jane Donor',
      membershipStatus: 'Active',
      membershipTier: 'Member',
      totalDonated: '500',
      donations: [{ amount: '100', date: '2026-01-01', description: 'Annual gift' }],
    });
  });
});

describe('HttpMondayClient.getDiscountOrganizations', () => {
  it('returns only organizations with an active discount', async () => {
    const fetchMock = fetchReturning({
      data: {
        boards: [
          {
            items_page: {
              cursor: null,
              items: [
                { id: 'org-1', name: 'Local Bikes', column_values: [{ id: 'offer_col', text: '10% off' }] },
              ],
            },
          },
        ],
      },
    });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, fetchMock);

    const orgs = await client.getDiscountOrganizations();

    expect(orgs).toEqual([{ name: 'Local Bikes', discountOffered: '10% off' }]);
  });
});

describe('HttpMondayClient error handling', () => {
  it('throws on a non-OK HTTP response', async () => {
    const fetchMock = fetchReturning({}, false);
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, fetchMock);
    await expect(client.findDonorsByEmail('x@example.org')).rejects.toThrow(/HTTP 500/);
  });

  it('throws on a GraphQL errors array', async () => {
    const fetchMock = fetchReturning({ errors: [{ message: 'Board not found' }] });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, fetchMock);
    await expect(client.findDonorsByEmail('x@example.org')).rejects.toThrow(/Board not found/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- client.test.ts`
Expected: FAIL — `./client` module not found.

- [ ] **Step 3: Write `donor-portal/src/monday/client.ts`**

NOTE inline: the `query_params.rules` shape for filtering by a connect-board column's linked item
id, and for a checkbox column's boolean value, are written from current Monday API v2 knowledge but
not verified against a live account — verify both against a real Donations/Organizations board
before deploy (same caveat already flagged in `membership-reminders/src/monday.ts`).

```typescript
import type { Config, DiscountOrganization, DonationRecord, DonorMatch, DonorPortalData, MondayColumns } from '../types';

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

export interface MondayClient {
  findDonorsByEmail(email: string): Promise<DonorMatch[]>;
  getDonorPortalData(donorItemId: string): Promise<DonorPortalData>;
  getDiscountOrganizations(): Promise<DiscountOrganization[]>;
}

export class HttpMondayClient implements MondayClient {
  constructor(
    private apiUrl: string,
    private apiToken: string,
    private columns: MondayColumns,
    private donorsBoardId: number,
    private donationsBoardId: number,
    private organizationsBoardId: number,
    private fetchFn: typeof fetch = fetch
  ) {}

  private async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await this.fetchFn(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.apiToken,
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

  async findDonorsByEmail(email: string): Promise<DonorMatch[]> {
    const query = `
      query ($boardId: ID!) {
        boards(ids: [$boardId]) {
          items_page(
            limit: 25,
            query_params: {
              rules: [{ column_id: "${this.columns.donorEmail}", compare_value: ["${email}"], operator: any_of }]
            }
          ) {
            items { id name }
          }
        }
      }
    `;
    const data = await this.request<{ boards: { items_page: { items: MondayItem[] } }[] }>(query, {
      boardId: this.donorsBoardId,
    });
    const items = data.boards[0]?.items_page.items ?? [];
    return items.map((item) => ({ id: item.id, name: item.name }));
  }

  async getDonorPortalData(donorItemId: string): Promise<DonorPortalData> {
    const donorQuery = `
      query ($itemId: ID!) {
        items(ids: [$itemId]) {
          id
          name
          column_values(ids: ["${this.columns.membershipStatus}", "${this.columns.membershipTier}", "${this.columns.dollarDonated}"]) {
            id
            text
          }
        }
      }
    `;
    const donorData = await this.request<{ items: MondayItem[] }>(donorQuery, { itemId: donorItemId });
    const donorItem = donorData.items[0];
    if (!donorItem) {
      throw new Error(`monday: donor item "${donorItemId}" not found`);
    }

    const donations = await this.getDonationsForDonor(donorItemId);

    return {
      id: donorItem.id,
      name: donorItem.name,
      membershipStatus: columnText(donorItem, this.columns.membershipStatus),
      membershipTier: columnText(donorItem, this.columns.membershipTier),
      totalDonated: columnText(donorItem, this.columns.dollarDonated),
      donations,
    };
  }

  private async getDonationsForDonor(donorItemId: string): Promise<DonationRecord[]> {
    const columnIds = JSON.stringify([this.columns.donationAmount, this.columns.donationDate, this.columns.donationDescription]);
    const firstPageQuery = `
      query ($boardId: ID!) {
        boards(ids: [$boardId]) {
          items_page(
            limit: 500,
            query_params: {
              rules: [{ column_id: "${this.columns.donationDonorLink}", compare_value: ["${donorItemId}"], operator: any_of }]
            }
          ) {
            cursor
            items { id column_values(ids: ${columnIds}) { id text } }
          }
        }
      }
    `;
    const nextPageQuery = `
      query ($cursor: String!) {
        next_items_page(cursor: $cursor, limit: 500) {
          cursor
          items { id column_values(ids: ${columnIds}) { id text } }
        }
      }
    `;

    const firstData = await this.request<{
      boards: { items_page: { cursor: string | null; items: MondayItem[] } }[];
    }>(firstPageQuery, { boardId: this.donationsBoardId });
    const firstPage = firstData.boards[0]?.items_page;
    const allItems: MondayItem[] = [...(firstPage?.items ?? [])];
    let cursor = firstPage?.cursor ?? null;

    while (cursor) {
      const nextData = await this.request<{
        next_items_page: { cursor: string | null; items: MondayItem[] };
      }>(nextPageQuery, { cursor });
      allItems.push(...nextData.next_items_page.items);
      cursor = nextData.next_items_page.cursor;
    }

    return allItems.map((item) => ({
      amount: columnText(item, this.columns.donationAmount),
      date: columnText(item, this.columns.donationDate),
      description: columnText(item, this.columns.donationDescription),
    }));
  }

  async getDiscountOrganizations(): Promise<DiscountOrganization[]> {
    const query = `
      query ($boardId: ID!) {
        boards(ids: [$boardId]) {
          items_page(
            limit: 500,
            query_params: {
              rules: [{ column_id: "${this.columns.discountActive}", compare_value: ["true"], operator: any_of }]
            }
          ) {
            cursor
            items { id name column_values(ids: ["${this.columns.discountOffered}"]) { id text } }
          }
        }
      }
    `;
    const data = await this.request<{ boards: { items_page: { cursor: string | null; items: MondayItem[] } }[] }>(
      query,
      { boardId: this.organizationsBoardId }
    );
    const items = data.boards[0]?.items_page.items ?? [];
    return items.map((item) => ({
      name: item.name,
      discountOffered: columnText(item, this.columns.discountOffered),
    }));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- client.test.ts`
Expected: PASS, all 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/monday
git commit -m "feat(donor-portal): Monday GraphQL client"
```

---

### Task 9: Resend email sender

**Files:**
- Create: `donor-portal/src/email/resend.ts`
- Test: `donor-portal/src/email/resend.test.ts`

**Interfaces:**
- Produces: `EmailSender` interface, `ResendEmailSender` class — consumed by
  `auth/requestLogin.ts` (Task 10) and `index.ts` (Task 15).

- [ ] **Step 1: Write the failing test — `donor-portal/src/email/resend.test.ts`**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { ResendEmailSender } from './resend';

describe('ResendEmailSender', () => {
  it('POSTs to the Resend API with the login link and from-address', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    const sender = new ResendEmailSender('re_test_key', 'login@example.org', 'Test Portal', fetchMock);

    await sender.sendLoginEmail({ to: 'donor@example.org', loginUrl: 'https://portal.example.org/auth/callback?token=abc' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer re_test_key' }),
      })
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.from).toBe('Test Portal <login@example.org>');
    expect(body.to).toEqual(['donor@example.org']);
    expect(body.html).toContain('https://portal.example.org/auth/callback?token=abc');
  });

  it('throws with the response body when Resend returns a non-OK status', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 422, text: async () => 'invalid from address' });
    const sender = new ResendEmailSender('re_test_key', 'login@example.org', 'Test Portal', fetchMock);

    await expect(sender.sendLoginEmail({ to: 'donor@example.org', loginUrl: 'https://x' })).rejects.toThrow(
      /HTTP 422.*invalid from address/
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- resend.test.ts`
Expected: FAIL — `./resend` module not found.

- [ ] **Step 3: Write `donor-portal/src/email/resend.ts`**

```typescript
export interface SendLoginEmailParams {
  to: string;
  loginUrl: string;
}

export interface EmailSender {
  sendLoginEmail(params: SendLoginEmailParams): Promise<void>;
}

export class ResendEmailSender implements EmailSender {
  constructor(
    private apiKey: string,
    private fromAddress: string,
    private fromName: string,
    private fetchFn: typeof fetch = fetch
  ) {}

  async sendLoginEmail(params: SendLoginEmailParams): Promise<void> {
    const response = await this.fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        from: `${this.fromName} <${this.fromAddress}>`,
        to: [params.to],
        subject: 'Your SVBC donor portal login link',
        html: `<p>Click below to log in to the donor portal. This link expires soon and can only be used once.</p><p><a href="${params.loginUrl}">Log in</a></p>`,
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`resend: HTTP ${response.status}: ${body}`);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- resend.test.ts`
Expected: PASS, both tests.

- [ ] **Step 5: Commit**

```bash
git add src/email
git commit -m "feat(donor-portal): Resend email sender"
```

---

### Task 10: requestLogin orchestration

**Files:**
- Create: `donor-portal/src/auth/requestLogin.ts`
- Test: `donor-portal/src/auth/requestLogin.test.ts`

**Interfaces:**
- Consumes: `MondayClient` (Task 8), `MagicLinkTokenStore` (Task 4), `EmailSender` (Task 9),
  `sha256Hex`, `generateToken` (Task 3)
- Produces: `requestLogin(email, deps): Promise<void>`, `RequestLoginDeps` — consumed by
  `routes.ts` (Task 14).

- [ ] **Step 1: Write the failing test — `donor-portal/src/auth/requestLogin.test.ts`**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { requestLogin } from './requestLogin';
import type { MondayClient } from '../monday/client';
import type { MagicLinkTokenStore } from '../db/tokens';
import type { EmailSender } from '../email/resend';

function fakeMonday(matches: { id: string; name: string }[]): MondayClient {
  return {
    findDonorsByEmail: vi.fn().mockResolvedValue(matches),
    getDonorPortalData: vi.fn(),
    getDiscountOrganizations: vi.fn(),
  };
}

function fakeTokenStore(): MagicLinkTokenStore {
  return { createToken: vi.fn().mockResolvedValue(undefined), consumeToken: vi.fn() };
}

function fakeEmailSender(): EmailSender {
  return { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
}

const baseDeps = {
  portalBaseUrl: 'https://portal.example.org',
  magicLinkTtlMinutes: 15,
  now: () => new Date('2026-08-22T00:00:00.000Z'),
};

describe('requestLogin', () => {
  it('does nothing when no donor matches the email', async () => {
    const monday = fakeMonday([]);
    const tokenStore = fakeTokenStore();
    const emailSender = fakeEmailSender();

    await requestLogin('nobody@example.org', { monday, tokenStore, emailSender, ...baseDeps });

    expect(tokenStore.createToken).not.toHaveBeenCalled();
    expect(emailSender.sendLoginEmail).not.toHaveBeenCalled();
  });

  it('creates a token covering every matched donor and emails a link containing it', async () => {
    const monday = fakeMonday([
      { id: 'donor-1', name: 'Jane' },
      { id: 'donor-2', name: 'Jane Also' },
    ]);
    const tokenStore = fakeTokenStore();
    const emailSender = fakeEmailSender();

    await requestLogin('shared@example.org', { monday, tokenStore, emailSender, ...baseDeps });

    expect(tokenStore.createToken).toHaveBeenCalledTimes(1);
    const call = (tokenStore.createToken as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.donorItemIds).toEqual(['donor-1', 'donor-2']);
    expect(call.expiresAt).toBe('2026-08-22T00:15:00.000Z');
    expect(call.tokenHash).toMatch(/^[0-9a-f]{64}$/);

    expect(emailSender.sendLoginEmail).toHaveBeenCalledTimes(1);
    const emailCall = (emailSender.sendLoginEmail as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(emailCall.to).toBe('shared@example.org');
    expect(emailCall.loginUrl).toMatch(/^https:\/\/portal\.example\.org\/auth\/callback\?token=[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- requestLogin.test.ts`
Expected: FAIL — `./requestLogin` module not found.

- [ ] **Step 3: Write `donor-portal/src/auth/requestLogin.ts`**

```typescript
import type { MondayClient } from '../monday/client';
import type { MagicLinkTokenStore } from '../db/tokens';
import type { EmailSender } from '../email/resend';
import { sha256Hex } from '../crypto/hash';
import { generateToken } from '../crypto/token';

export interface RequestLoginDeps {
  monday: MondayClient;
  tokenStore: MagicLinkTokenStore;
  emailSender: EmailSender;
  portalBaseUrl: string;
  magicLinkTtlMinutes: number;
  now: () => Date;
}

export async function requestLogin(email: string, deps: RequestLoginDeps): Promise<void> {
  const matches = await deps.monday.findDonorsByEmail(email);
  if (matches.length === 0) {
    return;
  }

  const rawToken = generateToken();
  const tokenHash = await sha256Hex(rawToken);
  const now = deps.now();
  const expiresAt = new Date(now.getTime() + deps.magicLinkTtlMinutes * 60_000).toISOString();

  await deps.tokenStore.createToken({
    tokenHash,
    donorItemIds: matches.map((match) => match.id),
    expiresAt,
  });

  const loginUrl = `${deps.portalBaseUrl}/auth/callback?token=${rawToken}`;
  await deps.emailSender.sendLoginEmail({ to: email, loginUrl });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- requestLogin.test.ts`
Expected: PASS, both tests.

- [ ] **Step 5: Commit**

```bash
git add src/auth/requestLogin.ts src/auth/requestLogin.test.ts
git commit -m "feat(donor-portal): enumeration-safe login request orchestration"
```

---

### Task 11: verifyLogin orchestration

**Files:**
- Create: `donor-portal/src/auth/verifyLogin.ts`
- Test: `donor-portal/src/auth/verifyLogin.test.ts`

**Interfaces:**
- Consumes: `MagicLinkTokenStore` (Task 4), `SessionStore` (Task 5), `sha256Hex`, `generateToken`
  (Task 3)
- Produces: `verifyLogin(rawToken, deps): Promise<string | null>`, `VerifyLoginDeps` — consumed by
  `routes.ts` (Task 14).

- [ ] **Step 1: Write the failing test — `donor-portal/src/auth/verifyLogin.test.ts`**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { verifyLogin } from './verifyLogin';
import type { MagicLinkTokenStore } from '../db/tokens';
import type { SessionStore } from '../db/sessions';

const now = () => new Date('2026-08-22T00:00:00.000Z');

describe('verifyLogin', () => {
  it('creates a session covering the token’s donor item ids and returns a session token', async () => {
    const tokenStore: MagicLinkTokenStore = {
      createToken: vi.fn(),
      consumeToken: vi.fn().mockResolvedValue(['donor-1', 'donor-2']),
    };
    const sessionStore: SessionStore = {
      createSession: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn(),
      deleteSession: vi.fn(),
    };

    const sessionToken = await verifyLogin('raw-token', { tokenStore, sessionStore, sessionTtlHours: 24, now });

    expect(sessionToken).toMatch(/^[0-9a-f]{64}$/);
    expect(sessionStore.createSession).toHaveBeenCalledTimes(1);
    const call = (sessionStore.createSession as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.donorItemIds).toEqual(['donor-1', 'donor-2']);
    expect(call.expiresAt).toBe('2026-08-23T00:00:00.000Z');
    expect(call.sessionHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns null and creates no session when the token is invalid or already used', async () => {
    const tokenStore: MagicLinkTokenStore = { createToken: vi.fn(), consumeToken: vi.fn().mockResolvedValue(null) };
    const sessionStore: SessionStore = {
      createSession: vi.fn(),
      getSession: vi.fn(),
      deleteSession: vi.fn(),
    };

    const result = await verifyLogin('bad-token', { tokenStore, sessionStore, sessionTtlHours: 24, now });

    expect(result).toBeNull();
    expect(sessionStore.createSession).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- verifyLogin.test.ts`
Expected: FAIL — `./verifyLogin` module not found.

- [ ] **Step 3: Write `donor-portal/src/auth/verifyLogin.ts`**

```typescript
import type { MagicLinkTokenStore } from '../db/tokens';
import type { SessionStore } from '../db/sessions';
import { sha256Hex } from '../crypto/hash';
import { generateToken } from '../crypto/token';

export interface VerifyLoginDeps {
  tokenStore: MagicLinkTokenStore;
  sessionStore: SessionStore;
  sessionTtlHours: number;
  now: () => Date;
}

export async function verifyLogin(rawToken: string, deps: VerifyLoginDeps): Promise<string | null> {
  const tokenHash = await sha256Hex(rawToken);
  const now = deps.now();
  const donorItemIds = await deps.tokenStore.consumeToken(tokenHash, now.toISOString());
  if (donorItemIds === null) {
    return null;
  }

  const rawSessionToken = generateToken();
  const sessionHash = await sha256Hex(rawSessionToken);
  const expiresAt = new Date(now.getTime() + deps.sessionTtlHours * 3_600_000).toISOString();

  await deps.sessionStore.createSession({ sessionHash, donorItemIds, expiresAt });

  return rawSessionToken;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- verifyLogin.test.ts`
Expected: PASS, both tests.

- [ ] **Step 5: Commit**

```bash
git add src/auth/verifyLogin.ts src/auth/verifyLogin.test.ts
git commit -m "feat(donor-portal): magic-link verification and session creation"
```

---

### Task 12: Portal data loader

**Files:**
- Create: `donor-portal/src/portal/loadPortalData.ts`
- Test: `donor-portal/src/portal/loadPortalData.test.ts`

**Interfaces:**
- Consumes: `MondayClient` (Task 8), `PortalView`, `DonorPortalData`, `DiscountOrganization`
  (Task 1's `src/types.ts`)
- Produces: `loadPortalData(donorItemIds, monday): Promise<PortalView>` — consumed by
  `routes.ts` (Task 14).

- [ ] **Step 1: Write the failing test — `donor-portal/src/portal/loadPortalData.test.ts`**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { loadPortalData } from './loadPortalData';
import type { MondayClient } from '../monday/client';
import type { DonorPortalData } from '../types';

function donor(id: string, name: string): DonorPortalData {
  return { id, name, membershipStatus: 'Active', membershipTier: 'Member', totalDonated: '100', donations: [] };
}

describe('loadPortalData', () => {
  it('fetches each donor id independently and one shared discount list', async () => {
    const monday: MondayClient = {
      findDonorsByEmail: vi.fn(),
      getDonorPortalData: vi
        .fn()
        .mockImplementation((id: string) => Promise.resolve(donor(id, id === 'donor-1' ? 'Jane' : 'Jane Also'))),
      getDiscountOrganizations: vi.fn().mockResolvedValue([{ name: 'Local Bikes', discountOffered: '10% off' }]),
    };

    const result = await loadPortalData(['donor-1', 'donor-2'], monday);

    expect(result.donors).toEqual([donor('donor-1', 'Jane'), donor('donor-2', 'Jane Also')]);
    expect(result.discounts).toEqual([{ name: 'Local Bikes', discountOffered: '10% off' }]);
    expect(monday.getDiscountOrganizations).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- loadPortalData.test.ts`
Expected: FAIL — `./loadPortalData` module not found.

- [ ] **Step 3: Write `donor-portal/src/portal/loadPortalData.ts`**

```typescript
import type { MondayClient } from '../monday/client';
import type { PortalView } from '../types';

export async function loadPortalData(donorItemIds: string[], monday: MondayClient): Promise<PortalView> {
  const [donors, discounts] = await Promise.all([
    Promise.all(donorItemIds.map((id) => monday.getDonorPortalData(id))),
    monday.getDiscountOrganizations(),
  ]);

  return { donors, discounts };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- loadPortalData.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/portal
git commit -m "feat(donor-portal): portal data loader"
```

---

### Task 13: Server-rendered views

**Files:**
- Create: `donor-portal/src/views.ts`
- Test: `donor-portal/src/views.test.ts`

**Interfaces:**
- Consumes: `PortalView`, `DonorPortalData`, `DiscountOrganization` (Task 1's `src/types.ts`)
- Produces: `loginFormView()`, `checkEmailView()`, `errorView(message)`, `portalView(data)` — each
  returning a string — consumed by `routes.ts` (Task 14).

- [ ] **Step 1: Write the failing test — `donor-portal/src/views.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { checkEmailView, errorView, loginFormView, portalView } from './views';
import type { PortalView } from './types';

describe('loginFormView', () => {
  it('renders a form posting to /login with an email field', () => {
    const html = loginFormView();
    expect(html).toContain('action="/login"');
    expect(html).toContain('name="email"');
  });
});

describe('checkEmailView', () => {
  it('renders the same generic message regardless of caller state', () => {
    const html = checkEmailView();
    expect(html).toContain('check your email');
  });
});

describe('errorView', () => {
  it('renders the given message, escaped', () => {
    const html = errorView('<script>alert(1)</script>');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('portalView', () => {
  const data: PortalView = {
    donors: [
      {
        id: 'donor-1',
        name: 'Jane Donor',
        membershipStatus: 'Active',
        membershipTier: 'Member',
        totalDonated: '500',
        donations: [{ date: '2026-01-01', amount: '100', description: 'Annual gift' }],
      },
      {
        id: 'donor-2',
        name: 'Jane Also',
        membershipStatus: 'Active',
        membershipTier: 'Lifetime',
        totalDonated: '2500',
        donations: [],
      },
    ],
    discounts: [{ name: 'Local Bikes', discountOffered: '10% off' }],
  };

  it('renders each donor under its own name header, never a single merged view', () => {
    const html = portalView(data);
    expect(html).toContain('Jane Donor');
    expect(html).toContain('Jane Also');
    expect(html).toContain('Annual gift');
    expect(html).toContain('Local Bikes');
  });

  it('escapes donor-sourced text instead of rendering it raw', () => {
    const maliciousData: PortalView = {
      donors: [
        {
          id: 'donor-3',
          name: '<img src=x onerror=alert(1)>',
          membershipStatus: 'Active',
          membershipTier: 'Member',
          totalDonated: '0',
          donations: [],
        },
      ],
      discounts: [],
    };
    const html = portalView(maliciousData);
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- views.test.ts`
Expected: FAIL — `./views` module not found.

- [ ] **Step 3: Write `donor-portal/src/views.ts`**

No templating library — plain template literals with a shared escape helper, so escaping behavior
is fully explicit and doesn't depend on a dependency's internal semantics.

```typescript
import type { PortalView } from './types';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function loginFormView(): string {
  return `
    <h1>SVBC Donor Portal</h1>
    <p>Enter your email to receive a login link.</p>
    <form action="/login" method="post">
      <input type="email" name="email" required />
      <button type="submit">Send login link</button>
    </form>
  `;
}

export function checkEmailView(): string {
  return `
    <h1>Check your email</h1>
    <p>If that address is on file, a login link is on its way. It expires soon and can only be used once.</p>
  `;
}

export function errorView(message: string): string {
  return `
    <h1>Something went wrong</h1>
    <p>${escapeHtml(message)}</p>
    <p><a href="/login">Request a new login link</a></p>
  `;
}

function donationRow(donation: PortalView['donors'][number]['donations'][number]): string {
  return `
    <tr>
      <td>${escapeHtml(donation.date)}</td>
      <td>${escapeHtml(donation.amount)}</td>
      <td>${escapeHtml(donation.description)}</td>
    </tr>
  `;
}

function donorSection(donor: PortalView['donors'][number]): string {
  return `
    <section>
      <h2>${escapeHtml(donor.name)}</h2>
      <p>Membership: ${escapeHtml(donor.membershipStatus)} (${escapeHtml(donor.membershipTier)})</p>
      <p>Total donated: ${escapeHtml(donor.totalDonated)}</p>
      <table>
        <thead>
          <tr><th>Date</th><th>Amount</th><th>Description</th></tr>
        </thead>
        <tbody>
          ${donor.donations.map(donationRow).join('')}
        </tbody>
      </table>
    </section>
  `;
}

function discountRow(discount: PortalView['discounts'][number]): string {
  return `<li>${escapeHtml(discount.name)}: ${escapeHtml(discount.discountOffered)}</li>`;
}

export function portalView(data: PortalView): string {
  return `
    <h1>Your donor portal</h1>
    ${data.donors.map(donorSection).join('')}
    <section>
      <h2>Bike shop discounts</h2>
      <ul>
        ${data.discounts.map(discountRow).join('')}
      </ul>
    </section>
    <form action="/logout" method="post"><button type="submit">Log out</button></form>
  `;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- views.test.ts`
Expected: PASS, all 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/views.ts src/views.test.ts
git commit -m "feat(donor-portal): server-rendered, auto-escaped portal views"
```

---

### Task 14: Hono routes

**Files:**
- Create: `donor-portal/src/routes.ts`
- Test: `donor-portal/src/routes.test.ts`

**Interfaces:**
- Consumes: `MondayClient` (Task 8), `MagicLinkTokenStore` (Task 4), `SessionStore` (Task 5),
  `EmailSender` (Task 9), `IpRateLimiter`, `checkLoginRateLimit` (Task 7), `requestLogin` (Task 10),
  `verifyLogin` (Task 11), `loadPortalData` (Task 12), the view functions (Task 13), `sha256Hex`
  (Task 3), `Config`, `LoginAttemptStore`
- Produces: `createApp(deps): Hono app`, `AppDeps` — consumed by `index.ts` (Task 15).

- [ ] **Step 1: Write the failing test — `donor-portal/src/routes.test.ts`**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createApp } from './routes';
import type { AppDeps } from './routes';
import type { MondayClient } from './monday/client';
import type { MagicLinkTokenStore } from './db/tokens';
import type { SessionStore } from './db/sessions';
import type { LoginAttemptStore } from './db/loginAttempts';
import type { EmailSender } from './email/resend';
import type { Config } from './types';

function inMemoryTokenStore(): MagicLinkTokenStore {
  const rows = new Map<string, { donorItemIds: string[]; expiresAt: string; usedAt: string | null }>();
  return {
    async createToken(params) {
      rows.set(params.tokenHash, { donorItemIds: params.donorItemIds, expiresAt: params.expiresAt, usedAt: null });
    },
    async consumeToken(tokenHash, nowISO) {
      const row = rows.get(tokenHash);
      if (!row || row.usedAt !== null || row.expiresAt <= nowISO) return null;
      row.usedAt = nowISO;
      return row.donorItemIds;
    },
  };
}

function inMemorySessionStore(): SessionStore {
  const rows = new Map<string, { donorItemIds: string[]; expiresAt: string }>();
  return {
    async createSession(params) {
      rows.set(params.sessionHash, { donorItemIds: params.donorItemIds, expiresAt: params.expiresAt });
    },
    async getSession(sessionHash, nowISO) {
      const row = rows.get(sessionHash);
      return !row || row.expiresAt <= nowISO ? null : row.donorItemIds;
    },
    async deleteSession(sessionHash) {
      rows.delete(sessionHash);
    },
  };
}

function inMemoryAttemptStore(): LoginAttemptStore {
  return { recordAttempt: vi.fn().mockResolvedValue(undefined), countRecentAttempts: vi.fn().mockResolvedValue(0) };
}

function fakeMonday(matchesByEmail: Record<string, { id: string; name: string }[]>): MondayClient {
  return {
    findDonorsByEmail: vi.fn().mockImplementation((email: string) => Promise.resolve(matchesByEmail[email] ?? [])),
    getDonorPortalData: vi.fn().mockImplementation((id: string) =>
      Promise.resolve({ id, name: `Donor ${id}`, membershipStatus: 'Active', membershipTier: 'Member', totalDonated: '0', donations: [] })
    ),
    getDiscountOrganizations: vi.fn().mockResolvedValue([]),
  };
}

const config: Config = {
  monday: { apiUrl: 'x', donorsBoardId: 1, donationsBoardId: 2, organizationsBoardId: 3, columns: {} as never },
  resend: { fromAddress: 'a@example.org', fromName: 'Test' },
  auth: { magicLinkTtlMinutes: 15, sessionTtlHours: 24, portalBaseUrl: 'https://portal.example.org' },
  rateLimit: { emailWindowSeconds: 900, emailMaxAttempts: 5 },
};

function makeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    monday: fakeMonday({}),
    tokenStore: inMemoryTokenStore(),
    sessionStore: inMemorySessionStore(),
    attemptStore: inMemoryAttemptStore(),
    emailSender: { sendLoginEmail: vi.fn().mockResolvedValue(undefined) },
    ipLimiter: { limit: vi.fn().mockResolvedValue({ success: true }) },
    config,
    now: () => new Date('2026-08-22T00:00:00.000Z'),
    ...overrides,
  };
}

function extractToken(loginUrl: string): string {
  return new URL(loginUrl).searchParams.get('token') as string;
}

describe('POST /login', () => {
  it('returns the identical response for a matching and a non-matching email', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const appMatching = createApp(makeDeps({ monday }));
    const appNonMatching = createApp(makeDeps({ monday }));

    const matchingRes = await appMatching.request('/login', {
      method: 'POST',
      body: new URLSearchParams({ email: 'donor@example.org' }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const nonMatchingRes = await appNonMatching.request('/login', {
      method: 'POST',
      body: new URLSearchParams({ email: 'nobody@example.org' }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    expect(await matchingRes.text()).toBe(await nonMatchingRes.text());
    expect(matchingRes.status).toBe(nonMatchingRes.status);
  });
});

describe('full login flow', () => {
  it('logs a donor in via the emailed link and renders their own name on the portal', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const deps = makeDeps({ monday, emailSender });
    const app = createApp(deps);

    await app.request('/login', {
      method: 'POST',
      body: new URLSearchParams({ email: 'donor@example.org' }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const loginUrl = (emailSender.sendLoginEmail as ReturnType<typeof vi.fn>).mock.calls[0][0].loginUrl;
    const token = extractToken(loginUrl);

    const callbackRes = await app.request(`/auth/callback?token=${token}`);
    expect(callbackRes.status).toBe(302);
    const setCookie = callbackRes.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('session=');

    const sessionCookie = setCookie.split(';')[0];
    const portalRes = await app.request('/portal', { headers: { cookie: sessionCookie } });
    const portalHtml = await portalRes.text();
    expect(portalHtml).toContain('Donor donor-1');
  });

  it('rejects a second use of the same magic-link token', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const deps = makeDeps({ monday, emailSender });
    const app = createApp(deps);

    await app.request('/login', {
      method: 'POST',
      body: new URLSearchParams({ email: 'donor@example.org' }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const loginUrl = (emailSender.sendLoginEmail as ReturnType<typeof vi.fn>).mock.calls[0][0].loginUrl;
    const token = extractToken(loginUrl);

    const first = await app.request(`/auth/callback?token=${token}`);
    expect(first.status).toBe(302);

    const second = await app.request(`/auth/callback?token=${token}`);
    const secondBody = await second.text();
    expect(secondBody).toContain('expired or was already used');
  });
});

describe('GET /portal without a session', () => {
  it('redirects to /login', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/portal');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });
});

describe('POST /login rate limiting', () => {
  it('still returns the generic response when the IP limiter denies the request', async () => {
    const monday = fakeMonday({ 'donor@example.org': [{ id: 'donor-1', name: 'Jane' }] });
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const ipLimiter = { limit: vi.fn().mockResolvedValue({ success: false }) };
    const app = createApp(makeDeps({ monday, emailSender, ipLimiter }));

    const res = await app.request('/login', {
      method: 'POST',
      body: new URLSearchParams({ email: 'donor@example.org' }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    expect(res.status).toBe(200);
    expect(emailSender.sendLoginEmail).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- routes.test.ts`
Expected: FAIL — `./routes` module not found.

- [ ] **Step 3: Write `donor-portal/src/routes.ts`**

```typescript
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { MondayClient } from './monday/client';
import type { MagicLinkTokenStore } from './db/tokens';
import type { SessionStore } from './db/sessions';
import type { LoginAttemptStore } from './db/loginAttempts';
import type { EmailSender } from './email/resend';
import type { IpRateLimiter } from './ratelimit';
import type { Config } from './types';
import { checkLoginRateLimit } from './ratelimit';
import { requestLogin } from './auth/requestLogin';
import { verifyLogin } from './auth/verifyLogin';
import { loadPortalData } from './portal/loadPortalData';
import { checkEmailView, errorView, loginFormView, portalView } from './views';
import { sha256Hex } from './crypto/hash';

export interface AppDeps {
  monday: MondayClient;
  tokenStore: MagicLinkTokenStore;
  sessionStore: SessionStore;
  attemptStore: LoginAttemptStore;
  emailSender: EmailSender;
  ipLimiter: IpRateLimiter;
  config: Config;
  now: () => Date;
}

const SESSION_COOKIE = 'session';

export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true }));

  app.get('/login', (c) => c.html(loginFormView()));

  app.post('/login', async (c) => {
    const body = await c.req.parseBody();
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const ip = c.req.header('cf-connecting-ip') ?? 'unknown';

    if (email.length > 0) {
      const allowed = await checkLoginRateLimit(
        ip,
        email,
        { ipLimiter: deps.ipLimiter, attemptStore: deps.attemptStore, config: deps.config.rateLimit },
        deps.now()
      );
      if (allowed) {
        await requestLogin(email, {
          monday: deps.monday,
          tokenStore: deps.tokenStore,
          emailSender: deps.emailSender,
          portalBaseUrl: deps.config.auth.portalBaseUrl,
          magicLinkTtlMinutes: deps.config.auth.magicLinkTtlMinutes,
          now: deps.now,
        });
      }
    }

    return c.html(checkEmailView());
  });

  app.get('/auth/callback', async (c) => {
    const token = c.req.query('token');
    if (!token) {
      return c.html(errorView('This link is invalid. Please request a new one.'));
    }

    const sessionToken = await verifyLogin(token, {
      tokenStore: deps.tokenStore,
      sessionStore: deps.sessionStore,
      sessionTtlHours: deps.config.auth.sessionTtlHours,
      now: deps.now,
    });

    if (sessionToken === null) {
      return c.html(errorView('This link has expired or was already used. Please request a new one.'));
    }

    setCookie(c, SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: deps.config.auth.sessionTtlHours * 3600,
    });
    return c.redirect('/portal');
  });

  app.get('/portal', async (c) => {
    const sessionToken = getCookie(c, SESSION_COOKIE);
    if (!sessionToken) {
      return c.redirect('/login');
    }

    const sessionHash = await sha256Hex(sessionToken);
    const donorItemIds = await deps.sessionStore.getSession(sessionHash, deps.now().toISOString());
    if (donorItemIds === null) {
      return c.redirect('/login');
    }

    const data = await loadPortalData(donorItemIds, deps.monday);
    return c.html(portalView(data));
  });

  app.post('/logout', async (c) => {
    const sessionToken = getCookie(c, SESSION_COOKIE);
    if (sessionToken) {
      await deps.sessionStore.deleteSession(await sha256Hex(sessionToken));
    }
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.redirect('/login');
  });

  return app;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- routes.test.ts`
Expected: PASS, all 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/routes.ts src/routes.test.ts
git commit -m "feat(donor-portal): Hono routes wiring login, callback, portal, logout"
```

---

### Task 15: Real wiring

**Files:**
- Modify: `donor-portal/src/index.ts`

**Interfaces:**
- Consumes: everything produced by Tasks 1–14.
- Produces: the deployed Worker's `fetch` handler.

- [ ] **Step 1: Replace `donor-portal/src/index.ts` with the full wiring**

```typescript
import rawConfig from '../config/svbc.json';
import { validateConfig } from './config';
import { createApp } from './routes';
import { D1MagicLinkTokenStore } from './db/tokens';
import { D1SessionStore } from './db/sessions';
import { D1LoginAttemptStore } from './db/loginAttempts';
import { HttpMondayClient } from './monday/client';
import { ResendEmailSender } from './email/resend';
import type { Env } from './types';

const config = validateConfig(rawConfig);

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (config.monday.donorsBoardId === null || config.monday.donationsBoardId === null || config.monday.organizationsBoardId === null) {
      throw new Error('config: monday board ids must be set before this Worker can serve requests');
    }

    const app = createApp({
      monday: new HttpMondayClient(
        config.monday.apiUrl,
        env.MONDAY_API_TOKEN,
        config.monday.columns,
        config.monday.donorsBoardId,
        config.monday.donationsBoardId,
        config.monday.organizationsBoardId
      ),
      tokenStore: new D1MagicLinkTokenStore(env.DB),
      sessionStore: new D1SessionStore(env.DB),
      attemptStore: new D1LoginAttemptStore(env.DB),
      emailSender: new ResendEmailSender(env.RESEND_API_KEY, config.resend.fromAddress, config.resend.fromName),
      ipLimiter: { limit: (key: string) => env.LOGIN_RATE_LIMITER.limit({ key }) },
      config,
      now: () => new Date(),
    });
    return app.fetch(request, env, ctx);
  },
};
```

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: PASS, every test file from Tasks 1–14 (the wiring itself has no dedicated test — it has
no branch logic beyond the board-id guard, so it's covered by `routes.test.ts` exercising
`createApp` directly with fakes).

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS, no errors.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(donor-portal): wire real D1/Monday/Resend/rate-limiter into the app"
```

- [ ] **Step 5: Update the Worker's status in the repo-level README**

Modify `../README.md`'s status table row for `donor-portal` from "Decided — build" to reflect that
v1 is code-complete but not yet deployed (still blocked on the Pre-launch checklist in the spec:
domain verification, real Monday column ids, dedicated integration token). Do not mark it live
until those are actually done.

```bash
cd ..
git add README.md
git commit -m "docs(donor-portal): note v1 is code-complete, pending pre-launch checklist"
```

---

## After this plan

This plan builds and tests the Worker's code. It does **not** complete the spec's Pre-launch
checklist — provisioning `mail.bikesiliconvalley.org` and verifying it in Resend, confirming the
real Membership/Discount column ids once the sandbox board exists, and minting the dedicated
least-privilege Monday integration token. None of those are code tasks, and this Worker cannot
safely go live without them.
