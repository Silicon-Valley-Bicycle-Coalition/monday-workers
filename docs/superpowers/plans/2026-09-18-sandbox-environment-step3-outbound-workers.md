# Sandbox Environment, Step 3: mailchimp-sync, quickbooks-sync, monday-backup, benevity-import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The four remaining migration Workers gain a `sandbox` Wrangler environment. Three of
them emit data outside Monday — `mailchimp-sync` (a Mailchimp audience), `quickbooks-sync` (a
QuickBooks company), `monday-backup` (a Google Drive folder and a Slack channel) — and their
sandbox configs point every one of those sinks at a sandbox-only target, guarded by a split test.
`benevity-import` is inbound-only and gets the split so it can coexist with production.

**Architecture:** Same shape as steps 1 and 2 (`donor-portal`, `funraise-sync`,
`donation-rollups`, all on `main`): `src/environment.ts` (verbatim copy) selects
`config/sandbox.json` or `config/svbc.json` at request time from the `ENVIRONMENT` var;
`wrangler.jsonc` gains `env.sandbox` with its own D1, `-sandbox` queues, and vars; a
`config/split.test.ts` asserts the two configs never share an id or a sink and that `env.sandbox`
shares no resource with the top level. Per-Worker specifics: `mailchimp-sync`'s sandbox config
names a distinct audience id and a sandbox "Mailchimp Campaigns" board that this plan creates;
`quickbooks-sync` moves its hardcoded API host into config so the sandbox targets Intuit's
sandbox host; `monday-backup`'s sandbox file names a distinct Drive folder; `benevity-import`'s
current `svbc.json` (already sandbox ids) becomes `sandbox.json` and `svbc.json` becomes a
placeholder file. None of the four is deployed today, so there is no live move — the operator
runbook at the end provisions the sandbox deployments only.

**Tech Stack:** Hono + TypeScript strict (`noUncheckedIndexedAccess`), Wrangler 4.x
(`wrangler.jsonc` with `env.*`), D1, Queues, Vitest with `@cloudflare/vitest-plugin` (tests run
inside workerd; file contents are read via Vite `?raw`). Commands run from each Worker's own
directory: `npm test`, `npm run typecheck`. Monday.com GraphQL API (`API-Version: 2026-01`) for
the one live task.

**Spec:** [`docs/superpowers/specs/2026-09-18-sandbox-environment-design.md`](../specs/2026-09-18-sandbox-environment-design.md) — read "Design" §1–§5 (especially §3's `mailchimp-sync`, `quickbooks-sync`, `monday-backup` paragraphs) before starting. This plan is the spec's "Rollout order" step 3. Reference implementations: `donor-portal/` (email sink), `funraise-sync/` and `donation-rollups/` (Monday-only, on `main`).

## Global Constraints

- **Environment names:** `ENVIRONMENT` unset or `"production"` → production; `"sandbox"` →
  sandbox; anything else throws.
- **Sandbox Worker names** are derived by Wrangler (`svbc-<worker>-sandbox`); never set `name`
  inside `env.sandbox`.
- **Queue names:** production name + `-sandbox`; dead-letter queues `<name>-sandbox-dlq`.
- **Sandbox D1 names:** `svbc-<worker>-sandbox`, `database_id: "REPLACE_AFTER_WRANGLER_D1_CREATE"`
  until provisioned.
- **Sinks that must differ between the two configs:** `mailchimp.audienceId`
  (`REPLACE_WITH_AUDIENCE_ID` vs `REPLACE_WITH_SANDBOX_AUDIENCE_ID` until staff create them);
  `quickbooks.apiBaseUrl` (`https://quickbooks.api.intuit.com/v3/company` vs
  `https://sandbox-quickbooks.api.intuit.com/v3/company`); `destinationParentFolderId`
  (`REPLACE_WITH_DRIVE_FOLDER_ID` vs `REPLACE_WITH_SANDBOX_DRIVE_FOLDER_ID`).
- **Sandbox boards (CRM Sandbox workspace `17141226`):** People `18428131737`, Donations
  `18428131791`, Organizations `18428131727`, Affiliations `18431270120`, Benevity Uploads
  `18431270204`. Known People columns: Membership Status `color_mm6jbkns`, Membership Tier
  `color_mm6jhs7g`, Member Since `date_mm6jv5gt`, Member Until `date_mm6jq0va`, Address
  `text_mm6j66ah`, City `text_mm6jbmkr`, Zip `text_mm6jrhv7`, Personal Email `email_mm6j5e9q`,
  Lifetime Giving `numeric_mm6j7y8j`. The People board has **no State column** and **no
  Mailchimp Campaigns connect column** (Task 2 creates the latter); the workspace has **no
  Mailchimp Campaigns board** (Task 2 creates it).
- **`config/svbc.json` is production** and after this plan holds no sandbox id in any Worker.
- **Worktree:** all work happens in
  `/Users/dwk/Developer/gitlab.com/silicon-valley-bicycle-coalition/monday-workers-sandbox-env-3`
  on branch `feat/sandbox-environment-step3` (branched from `main` at `263e22f`). `node_modules`
  is installed only in `funraise-sync/`; Task 1 installs the four target Workers.
- **Commits:** conventional, scoped per Worker or unscoped for cross-Worker work; one per task;
  each ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- **Never commit** `worker-configuration.d.ts` (gitignored).
- **Bash sandbox:** `npm test` (miniflare socket) and `npm run typecheck` (`wrangler types` log
  write) hit EPERM — re-run those two with `dangerouslyDisableSandbox: true`. Nothing else needs it.

---

### Task 1: Shared plumbing in all four Workers

Five identical files created in each of `mailchimp-sync/`, `quickbooks-sync/`, `monday-backup/`,
`benevity-import/` — twenty files, one dispatch, one commit.

**Files (in each Worker):**
- Create: `src/environment.ts`, `src/environment.test.ts`, `test/jsonc.ts`, `test/jsonc.test.ts`, `test/raw-imports.d.ts`

**Interfaces:**
- Produces (per Worker): `environmentOf`, `createConfigSelector<T>`, `queueBaseName`, `parseJsonc`, the `*?raw` declaration.

- [ ] **Step 1: Install and baseline**

Run in each of the four Worker directories:

```bash
npm ci && npm test
```

Expected: every suite passes before any change. Note each Worker's passing count for the report.

- [ ] **Step 2: Write the failing tests (identical in all four)**

`src/environment.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { environmentOf, createConfigSelector, queueBaseName } from './environment';

describe('environmentOf', () => {
  it('is production when ENVIRONMENT is unset', () => {
    expect(environmentOf({})).toBe('production');
  });

  it('is production when ENVIRONMENT is an empty string or "production"', () => {
    expect(environmentOf({ ENVIRONMENT: '' })).toBe('production');
    expect(environmentOf({ ENVIRONMENT: 'production' })).toBe('production');
  });

  it('is sandbox when ENVIRONMENT is "sandbox"', () => {
    expect(environmentOf({ ENVIRONMENT: 'sandbox' })).toBe('sandbox');
  });

  it('throws on any other value rather than guessing', () => {
    expect(() => environmentOf({ ENVIRONMENT: 'staging' })).toThrow('ENVIRONMENT');
    expect(() => environmentOf({ ENVIRONMENT: 'Sandbox' })).toThrow('ENVIRONMENT');
  });
});

describe('createConfigSelector', () => {
  it('validates and returns the production source when ENVIRONMENT is unset', () => {
    const validate = vi.fn((raw: unknown) => ({ validated: raw }));
    const configFor = createConfigSelector({ production: { id: 'prod' }, sandbox: { id: 'sb' }, validate });

    expect(configFor({})).toEqual({ validated: { id: 'prod' } });
    expect(validate).toHaveBeenCalledWith({ id: 'prod' });
  });

  it('validates and returns the sandbox source when ENVIRONMENT is "sandbox"', () => {
    const validate = vi.fn((raw: unknown) => ({ validated: raw }));
    const configFor = createConfigSelector({ production: { id: 'prod' }, sandbox: { id: 'sb' }, validate });

    expect(configFor({ ENVIRONMENT: 'sandbox' })).toEqual({ validated: { id: 'sb' } });
    expect(validate).toHaveBeenCalledWith({ id: 'sb' });
  });

  it('memoizes per environment — validate runs once per environment, not per call', () => {
    const validate = vi.fn((raw: unknown) => ({ validated: raw }));
    const configFor = createConfigSelector({ production: { id: 'prod' }, sandbox: { id: 'sb' }, validate });

    const first = configFor({});
    const second = configFor({});
    configFor({ ENVIRONMENT: 'sandbox' });
    configFor({ ENVIRONMENT: 'sandbox' });

    expect(first).toBe(second);
    expect(validate).toHaveBeenCalledTimes(2);
  });

  it('does not memoize a failed validation, so a later call throws again', () => {
    const validate = vi.fn(() => {
      throw new Error('config: bad');
    });
    const configFor = createConfigSelector({ production: {}, sandbox: {}, validate });

    expect(() => configFor({})).toThrow('config: bad');
    expect(() => configFor({})).toThrow('config: bad');
    expect(validate).toHaveBeenCalledTimes(2);
  });
});

describe('queueBaseName', () => {
  it('strips exactly one trailing -sandbox', () => {
    expect(queueBaseName('mailchimp-sync-outbound-sandbox')).toBe('mailchimp-sync-outbound');
    expect(queueBaseName('benevity-import-writes-sandbox')).toBe('benevity-import-writes');
  });

  it('returns production names unchanged', () => {
    expect(queueBaseName('quickbooks-sync-writes')).toBe('quickbooks-sync-writes');
  });

  it('does not touch a dead-letter queue name — the suffix must be at the very end', () => {
    expect(queueBaseName('mailchimp-sync-inbound-sandbox-dlq')).toBe('mailchimp-sync-inbound-sandbox-dlq');
  });

  it('does not strip -sandbox from the middle of a name', () => {
    expect(queueBaseName('a-sandbox-b')).toBe('a-sandbox-b');
  });
});
```

`test/jsonc.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseJsonc } from './jsonc';

describe('parseJsonc', () => {
  it('parses plain JSON', () => {
    expect(parseJsonc('{"a": 1, "b": [true, null]}')).toEqual({ a: 1, b: [true, null] });
  });

  it('strips line and block comments outside strings', () => {
    expect(parseJsonc('{\n  // c\n  "a": 1, /* d */ "b": 2\n}')).toEqual({ a: 1, b: 2 });
  });

  it('keeps // inside strings, such as URLs', () => {
    expect(parseJsonc('{"u": "https://api.monday.com/v2" // trailing\n}')).toEqual({ u: 'https://api.monday.com/v2' });
  });

  it('keeps escaped quotes inside strings', () => {
    expect(parseJsonc('{"s": "say \\"hi\\" // not a comment"}')).toEqual({ s: 'say "hi" // not a comment' });
  });

  it('tolerates trailing commas', () => {
    expect(parseJsonc('{"a": [1, 2,], "b": {"c": 1,},}')).toEqual({ a: [1, 2], b: { c: 1 } });
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

In each Worker: `npm test -- src/environment.test.ts test/jsonc.test.ts`
Expected: FAIL — unresolved imports.

- [ ] **Step 4: Write the implementations (identical in all four)**

`src/environment.ts`:

```ts
// Which deployment this isolate is: production (the default — the top level of wrangler.jsonc)
// or sandbox (`wrangler deploy --env sandbox`, which sets the ENVIRONMENT var). The sandbox is a
// permanent parallel environment that runs against the CRM Sandbox boards and must never emit
// data to a donor or a vendor's production account — see
// ../docs/superpowers/specs/2026-09-18-sandbox-environment-design.md.
export type Environment = 'production' | 'sandbox';

// The one var this module reads. Declared as its own interface so the entrypoint's full Env can
// be passed in and tests can pass a bare object.
export interface EnvironmentBindings {
  ENVIRONMENT?: string;
}

export function environmentOf(env: EnvironmentBindings): Environment {
  const value = env.ENVIRONMENT;
  if (value === undefined || value === '' || value === 'production') return 'production';
  if (value === 'sandbox') return 'sandbox';
  // Fail closed: an unrecognized name could be a typo'd "sandbox" about to hit production ids.
  throw new Error(`ENVIRONMENT var must be "sandbox" or unset (production); got "${value}"`);
}

export interface ConfigSources<T> {
  production: unknown;
  sandbox: unknown;
  validate: (raw: unknown) => T;
}

// Returns a `configFor(env)` function. Config was previously a module-scope import of one JSON
// file; with two files the choice can only happen once `env` is in hand (a handler), so this
// memoizes per environment to keep validation at once-per-isolate rather than once-per-request.
// A throwing validation is not memoized: the next request throws again, matching the existing
// "fail loudly on placeholder config" behavior.
export function createConfigSelector<T>(sources: ConfigSources<T>): (env: EnvironmentBindings) => T {
  const memo = new Map<Environment, T>();
  return (env) => {
    const environment = environmentOf(env);
    if (memo.has(environment)) return memo.get(environment) as T;
    const config = sources.validate(environment === 'sandbox' ? sources.sandbox : sources.production);
    memo.set(environment, config);
    return config;
  };
}

const SANDBOX_QUEUE_SUFFIX = '-sandbox';

// Sandbox queues are the production names plus "-sandbox" (wrangler.jsonc env.sandbox.queues).
// The queue router compares against this so one router serves both environments. Strips exactly
// one trailing suffix and nothing else, so "…-sandbox-dlq" never matches a consumer branch.
export function queueBaseName(queueName: string): string {
  return queueName.endsWith(SANDBOX_QUEUE_SUFFIX) ? queueName.slice(0, -SANDBOX_QUEUE_SUFFIX.length) : queueName;
}
```

`test/jsonc.ts`:

```ts
// Minimal JSONC reader for tests: strips // and /* */ comments outside string literals and
// removes trailing commas, then hands the result to JSON.parse. Enough for wrangler.jsonc; not
// a general parser.
export function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\' && next !== undefined) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}
```

`test/raw-imports.d.ts`:

```ts
// Vite serves `?raw` imports as the file's text. Used by config/split.test.ts to read
// wrangler.jsonc inside the Workers test runtime, where node:fs is unavailable.
declare module '*?raw' {
  const text: string;
  export default text;
}
```

- [ ] **Step 5: Run the tests and typecheck in all four**

In each: `npm test -- src/environment.test.ts test/jsonc.test.ts && npm run typecheck`
Expected: PASS (12 + 5 cases); typecheck clean. `benevity-import/test/env.d.ts` uses a
`declare global` augmentation; the new `.d.ts` beside it is a plain module declaration and needs
no change.

- [ ] **Step 6: Commit**

From the repo root:

```bash
git add mailchimp-sync/src/environment.ts mailchimp-sync/src/environment.test.ts mailchimp-sync/test/jsonc.ts mailchimp-sync/test/jsonc.test.ts mailchimp-sync/test/raw-imports.d.ts quickbooks-sync/src/environment.ts quickbooks-sync/src/environment.test.ts quickbooks-sync/test/jsonc.ts quickbooks-sync/test/jsonc.test.ts quickbooks-sync/test/raw-imports.d.ts monday-backup/src/environment.ts monday-backup/src/environment.test.ts monday-backup/test/jsonc.ts monday-backup/test/jsonc.test.ts monday-backup/test/raw-imports.d.ts benevity-import/src/environment.ts benevity-import/src/environment.test.ts benevity-import/test/jsonc.ts benevity-import/test/jsonc.test.ts benevity-import/test/raw-imports.d.ts
git commit -m "feat: add environment selection and JSONC test helpers to the four remaining Workers

Verbatim copies of donor-portal's environment.ts, test/jsonc.ts, and test/raw-imports.d.ts
in mailchimp-sync, quickbooks-sync, monday-backup, and benevity-import.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Create the sandbox "Mailchimp Campaigns" board and the People connect column (live)

`mailchimp-sync` reconciles Mailchimp Interest Categories onto a "Mailchimp Campaigns" board and
writes a donor's interests to a connect column on the People board. Neither exists in the CRM
Sandbox workspace. This task creates both. Sandbox workspace only.

**Files:** none. Output: a board id and a column id for Task 3.

- [ ] **Step 1: Idempotency check**

From `mailchimp-sync/` (token from the private planning repo's `.env`; never print it):

```bash
MONDAY_API_TOKEN="$(grep '^MONDAY_API_TOKEN=' ../../monday-migration/.env | cut -d= -f2-)"; curl -s https://api.monday.com/v2 -H "Authorization: $MONDAY_API_TOKEN" -H "Content-Type: application/json" -H "API-Version: 2026-01" -d '{"query":"{ boards(workspace_ids:[17141226], limit: 50) { id name } }"}'
```

Expected: the sandbox board list, with **no** board named `Mailchimp Campaigns (sandbox)`. If it
exists, note its id and skip Step 2. (Add `api.monday.com` to `allowed_domains` if refused.)

- [ ] **Step 2: Create the board**

```bash
MONDAY_API_TOKEN="$(grep '^MONDAY_API_TOKEN=' ../../monday-migration/.env | cut -d= -f2-)"; curl -s https://api.monday.com/v2 -H "Authorization: $MONDAY_API_TOKEN" -H "Content-Type: application/json" -H "API-Version: 2026-01" -d '{"query":"mutation { create_board(board_name: \"Mailchimp Campaigns (sandbox)\", board_kind: public, workspace_id: 17141226, description: \"One item per Mailchimp Interest (newsletter, welcome drip, renewal reminders…), kept in step with the sandbox Mailchimp audience by the mailchimp-sync sandbox Worker. Sandbox twin of the production Mailchimp Campaigns board.\") { id } }"}'
```

Expected: `{"data":{"create_board":{"id":"<BOARD_ID>"}}}`. Record it. Then delete Monday's
auto-seeded placeholder items: query `{ boards(ids:[<BOARD_ID>]) { items_page(limit: 10) { items { id name } } } }` and `delete_item(item_id: …)` each (the same cleanup
`donor-portal/scripts/create-letter-settings-board.mjs` does).

- [ ] **Step 3: Create the connect column on the sandbox People board**

```bash
MONDAY_API_TOKEN="$(grep '^MONDAY_API_TOKEN=' ../../monday-migration/.env | cut -d= -f2-)"; curl -s https://api.monday.com/v2 -H "Authorization: $MONDAY_API_TOKEN" -H "Content-Type: application/json" -H "API-Version: 2026-01" -d '{"query":"mutation { create_column(board_id: 18428131737, title: \"Mailchimp Campaigns\", description: \"Which Mailchimp interests this person is subscribed to. Written by the mailchimp-sync integration from Mailchimp; edits are overwritten.\", column_type: board_relation, defaults: \"{\\\"boardIds\\\":[<BOARD_ID>]}\") { id } }"}'
```

(Substitute the board id from Step 2 for `<BOARD_ID>`.) Expected:
`{"data":{"create_column":{"id":"board_relation_…"}}}`. Record it.

- [ ] **Step 4: Verify**

Re-run the Step 1 query (the new board appears once) and
`{ boards(ids:[18428131737]) { columns(ids:["<COLUMN_ID>"]) { id title type settings_str } } }`
(type `board_relation`, settings naming `<BOARD_ID>`).

No commit.

---

### Task 3: mailchimp-sync — `config/sandbox.json`

**Files:**
- Create: `mailchimp-sync/config/sandbox.json`

`config/svbc.json` already holds only placeholders and stays as it is.

- [ ] **Step 1: Write `config/sandbox.json`**

Substitute Task 2's ids where marked.

```json
{
  "monday": {
    "apiUrl": "https://api.monday.com/v2",
    "donorsBoardId": 18428131737,
    "campaignsBoardId": <Task 2 board id, as a number>,
    "columns": {
      "membershipStatus": "color_mm6jbkns",
      "membershipTier": "color_mm6jhs7g",
      "memberSince": "date_mm6jv5gt",
      "memberUntil": "date_mm6jq0va",
      "addr1": "text_mm6j66ah",
      "city": "text_mm6jbmkr",
      "state": "REPLACE_WITH_COLUMN_ID",
      "zip": "text_mm6jrhv7",
      "email": "email_mm6j5e9q",
      "totalGiven": "numeric_mm6j7y8j",
      "mailchimpCampaigns": "<Task 2 column id>"
    }
  },
  "mailchimp": {
    "apiBaseUrl": "https://REPLACE_WITH_DC.api.mailchimp.com/3.0",
    "audienceId": "REPLACE_WITH_SANDBOX_AUDIENCE_ID",
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

Why: the sandbox People board has no State column, so `state` stays a placeholder (the ADDRESS
merge field carries an empty state in the sandbox; documented in Task 14). The sandbox Mailchimp
audience does not exist yet (staff prerequisite, Task 15), so `audienceId` is a sandbox-specific
placeholder that the split test can tell apart from production's; `apiBaseUrl`'s data-center
placeholder is the same in both because both audiences live in one Mailchimp account.

- [ ] **Step 2: Verify it validates**

Run: `npm test && npm run typecheck`
Expected: PASS; typecheck clean (`resolveJsonModule` is on in this Worker's `tsconfig.json`; nothing
imports `sandbox.json` yet, so this only proves the file is well-formed JSON — Task 5's split test
proves it validates).

- [ ] **Step 3: Commit**

```bash
git add config/sandbox.json
git commit -m "feat(mailchimp-sync): add config/sandbox.json for the CRM Sandbox People board and a sandbox audience placeholder

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: mailchimp-sync — select config per environment; route both queue name sets

**Files:**
- Modify: `mailchimp-sync/src/index.ts`
- Modify: `mailchimp-sync/src/types.ts` (`Env`)
- Modify: `mailchimp-sync/test/env.d.ts`
- Modify: `mailchimp-sync/src/index.test.ts`

**Interfaces:**
- Consumes: `createConfigSelector`, `queueBaseName` (Task 1); `config/sandbox.json` (Task 3).
- Produces: `Env.ENVIRONMENT?: string`.

- [ ] **Step 1: Write the failing tests**

Append to `src/index.test.ts` (it already imports `worker`, `fakeEnv`, `fakeMessage`, `vi`):

```ts
describe('request-time config selection', () => {
  it('serves /health under the sandbox environment', async () => {
    const res = await worker.fetch(new Request('https://worker.example/health'), fakeEnv({ ENVIRONMENT: 'sandbox' }), {} as ExecutionContext);
    expect(res.status).toBe(200);
  });

  it('refuses an unknown ENVIRONMENT value instead of guessing a config', async () => {
    await expect(
      worker.fetch(new Request('https://worker.example/health'), fakeEnv({ ENVIRONMENT: 'staging' }), {} as ExecutionContext)
    ).rejects.toThrow('ENVIRONMENT');
  });

  it('routes the sandbox-suffixed queue names to the same consumers', async () => {
    const emptyBatch = (queue: string) => ({ queue, messages: [], retryAll: vi.fn(), ackAll: vi.fn() }) as unknown as MessageBatch<unknown>;
    await expect(worker.queue(emptyBatch('mailchimp-sync-outbound-sandbox'), fakeEnv({ ENVIRONMENT: 'sandbox' }))).resolves.toBeUndefined();
    await expect(worker.queue(emptyBatch('mailchimp-sync-inbound-sandbox'), fakeEnv({ ENVIRONMENT: 'sandbox' }))).resolves.toBeUndefined();
    await expect(worker.queue(emptyBatch('mailchimp-sync-outbound-sandbox-dlq'), fakeEnv({ ENVIRONMENT: 'sandbox' }))).rejects.toThrow('unknown queue');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- src/index.test.ts`
Expected: the second and third cases FAIL (no `ENVIRONMENT` handling; `-sandbox` names hit the
"unknown queue" throw).

- [ ] **Step 3: Extend `Env`**

In `src/types.ts`, add to `export interface Env` as its last member:

```ts
  // Set only by wrangler.jsonc's env.sandbox.vars. Unset = production. See src/environment.ts.
  ENVIRONMENT?: string;
```

In `test/env.d.ts`, add `ENVIRONMENT?: string;` as the last member of `interface Env`.

- [ ] **Step 4: Rewire `src/index.ts`**

Replace

```ts
import configJson from '../config/svbc.json';
```

with

```ts
import productionConfig from '../config/svbc.json';
import sandboxConfig from '../config/sandbox.json';
import { createConfigSelector, queueBaseName } from './environment';
```

Replace `const config = validateConfig(configJson);` with

```ts
// One config per environment, chosen at request time from env.ENVIRONMENT and validated once
// per isolate — see src/environment.ts and config/split.test.ts. In the sandbox, mailchimp.audienceId
// names the sandbox audience; the split test is what keeps that id off the production file.
const configFor = createConfigSelector({ production: productionConfig, sandbox: sandboxConfig, validate: validateConfig });
```

Add `const config = configFor(env);` as the first statement of `fetch`, of `queue`, and of
`scheduled`. In `queue`, replace the two comparisons:

```ts
    const queueName = queueBaseName(batch.queue);

    if (queueName === 'mailchimp-sync-outbound') {
```

and

```ts
    if (queueName === 'mailchimp-sync-inbound') {
```

The trailing `throw new Error(\`unknown queue: ${batch.queue}\`)` keeps the original name.
`configJson` no longer appears.

- [ ] **Step 5: Suite, typecheck, commit**

Run: `npm test && npm run typecheck`
Expected: all PASS; typecheck clean.

```bash
git add src/index.ts src/types.ts test/env.d.ts src/index.test.ts
git commit -m "feat(mailchimp-sync): select config by ENVIRONMENT and route the sandbox queue names

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: mailchimp-sync — `env.sandbox`, deploy script, split test

**Files:**
- Modify: `mailchimp-sync/wrangler.jsonc`, `mailchimp-sync/package.json`
- Create: `mailchimp-sync/config/split.test.ts`

- [ ] **Step 1: Add `env.sandbox`** (last top-level member; comma after `observability`):

```jsonc
  // ── Sandbox environment ───────────────────────────────────────────────────────────────────
  // `wrangler deploy --env sandbox` (npm run deploy:sandbox) deploys svbc-mailchimp-sync-sandbox
  // against the CRM Sandbox People board and the *sandbox* Mailchimp audience named in
  // config/sandbox.json (selected by the ENVIRONMENT var). Rule: inbound data only, no outbound
  // data — the sandbox may only upsert into the sandbox audience; config/split.test.ts fails if
  // the two configs ever share an audience id. Everything here is non-inheritable in Wrangler and
  // deliberately restated. Design: docs/superpowers/specs/2026-09-18-sandbox-environment-design.md.
  // Secrets exist twice — `wrangler secret put <NAME> --env sandbox` for MONDAY_API_TOKEN,
  // MAILCHIMP_API_KEY (may be the same account key), MONDAY_WEBHOOK_SECRET, MAILCHIMP_WEBHOOK_SECRET.
  "env": {
    "sandbox": {
      "vars": { "ENVIRONMENT": "sandbox" },
      "d1_databases": [
        {
          "binding": "DB",
          "database_name": "svbc-mailchimp-sync-sandbox",
          // Replace after running: wrangler d1 create svbc-mailchimp-sync-sandbox
          "database_id": "REPLACE_AFTER_WRANGLER_D1_CREATE",
          "migrations_dir": "migrations"
        }
      ],
      "queues": {
        "producers": [
          { "queue": "mailchimp-sync-outbound-sandbox", "binding": "OUTBOUND_QUEUE" },
          { "queue": "mailchimp-sync-inbound-sandbox", "binding": "INBOUND_QUEUE" }
        ],
        "consumers": [
          {
            "queue": "mailchimp-sync-outbound-sandbox",
            "max_retries": 3,
            "max_concurrency": 1,
            "dead_letter_queue": "mailchimp-sync-outbound-sandbox-dlq"
          },
          {
            "queue": "mailchimp-sync-inbound-sandbox",
            "max_retries": 3,
            "max_concurrency": 1,
            "dead_letter_queue": "mailchimp-sync-inbound-sandbox-dlq"
          }
        ]
      },
      "triggers": {
        "crons": ["0 15 * * *"]
      },
      "observability": {
        "enabled": true
      }
    }
  }
```

- [ ] **Step 2: Script.** In `package.json` `scripts`, after `"deploy": "wrangler deploy",` add `"deploy:sandbox": "wrangler deploy --env sandbox",`.

- [ ] **Step 3: Dry-run both**

```bash
npx wrangler deploy --env sandbox --dry-run --outdir "$TMPDIR/mc-sb" && npx wrangler deploy --dry-run --outdir "$TMPDIR/mc-prod"
```

Expected: both exit 0.

- [ ] **Step 4: Split test.** Create `config/split.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import production from './svbc.json';
import sandbox from './sandbox.json';
import wranglerText from '../wrangler.jsonc?raw';
import { parseJsonc } from '../test/jsonc';
import { validateConfig } from '../src/config';
import { queueBaseName } from '../src/environment';

// Guards the "inbound only, no outbound data" rule at the repo level for this Worker's one
// outbound sink (the Mailchimp audience) and keeps the sandbox and production deployments apart.
// See the design doc docs/superpowers/specs/2026-09-18-sandbox-environment-design.md §3 and §5.

const PLACEHOLDER = 'REPLACE_WITH_COLUMN_ID';

type Json = Record<string, unknown>;
const get = (obj: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((o, key) => (o as Json | undefined)?.[key], obj);

const wrangler = parseJsonc(wranglerText) as Json;
const sandboxEnv = get(wrangler, 'env.sandbox') as Json;

describe('config split: the Mailchimp sink', () => {
  it('the sandbox audience id is never the production audience id', () => {
    expect(typeof sandbox.mailchimp.audienceId).toBe('string');
    expect(sandbox.mailchimp.audienceId).not.toBe('');
    expect(sandbox.mailchimp.audienceId).not.toBe(production.mailchimp.audienceId);
  });

  it('the sandbox audience placeholder is unmistakably the sandbox one until staff fill it in', () => {
    if (sandbox.mailchimp.audienceId.startsWith('REPLACE_WITH_')) {
      expect(sandbox.mailchimp.audienceId).toBe('REPLACE_WITH_SANDBOX_AUDIENCE_ID');
    }
    if (production.mailchimp.audienceId.startsWith('REPLACE_WITH_')) {
      expect(production.mailchimp.audienceId).toBe('REPLACE_WITH_AUDIENCE_ID');
    }
  });

  it('merge fields and tags are the same in both — they name Mailchimp fields, not ids', () => {
    expect(sandbox.mailchimp.mergeFields).toEqual(production.mailchimp.mergeFields);
    expect(sandbox.mailchimp.tags).toEqual(production.mailchimp.tags);
  });
});

describe('config split: Monday ids', () => {
  it('sandbox board ids are the CRM Sandbox boards and production has none yet', () => {
    expect(sandbox.monday.donorsBoardId).toBe(18428131737);
    expect(typeof sandbox.monday.campaignsBoardId).toBe('number');
    expect(sandbox.monday.campaignsBoardId).toBeGreaterThan(0);
    expect(production.monday.donorsBoardId).toBeNull();
    expect(production.monday.campaignsBoardId).toBeNull();
  });

  it('no real sandbox column id appears in production', () => {
    const sb = sandbox.monday.columns as Record<string, string>;
    const prod = production.monday.columns as Record<string, string>;
    let real = 0;
    for (const [key, id] of Object.entries(sb)) {
      if (id === PLACEHOLDER) continue;
      real += 1;
      expect(prod[key], `monday.columns.${key}`).not.toBe(id);
    }
    expect(real).toBeGreaterThanOrEqual(10);
  });

  it('both shipped configs validate', () => {
    expect(() => validateConfig(sandbox)).not.toThrow();
    expect(() => validateConfig(production)).not.toThrow();
  });
});

describe('wrangler.jsonc env.sandbox', () => {
  it('sets only the ENVIRONMENT var, and never at the top level', () => {
    expect(sandboxEnv.vars).toEqual({ ENVIRONMENT: 'sandbox' });
    expect((wrangler.vars as Json | undefined)?.ENVIRONMENT).toBeUndefined();
  });

  it('uses sandbox-suffixed queue names that map back to the production queues', () => {
    const prodProducers = ((wrangler.queues as Json).producers as { queue: string }[]).map((p) => p.queue);
    const sbQueues = sandboxEnv.queues as Json;
    for (const producer of sbQueues.producers as { queue: string }[]) {
      expect(producer.queue.endsWith('-sandbox')).toBe(true);
      expect(prodProducers).toContain(queueBaseName(producer.queue));
    }
    for (const consumer of sbQueues.consumers as { queue: string; dead_letter_queue: string }[]) {
      expect(consumer.queue.endsWith('-sandbox')).toBe(true);
      expect(consumer.dead_letter_queue).toBe(`${consumer.queue}-dlq`);
    }
  });

  it('has its own D1 database, never production’s', () => {
    const prodDb = (wrangler.d1_databases as Json[])[0]!;
    const sbDb = (sandboxEnv.d1_databases as Json[])[0]!;
    expect(sbDb.database_name).toBe('svbc-mailchimp-sync-sandbox');
    expect(sbDb.database_name).not.toBe(prodDb.database_name);
    const bothPlaceholders = sbDb.database_id === 'REPLACE_AFTER_WRANGLER_D1_CREATE' && prodDb.database_id === sbDb.database_id;
    expect(bothPlaceholders || sbDb.database_id !== prodDb.database_id).toBe(true);
  });

  it('keeps the same cron schedule as production and derives its own name', () => {
    expect((sandboxEnv.triggers as Json).crons).toEqual((wrangler.triggers as Json).crons);
    expect(sandboxEnv.name).toBeUndefined();
    expect(wrangler.name).toBe('svbc-mailchimp-sync');
  });
});
```

Run: `npm test -- config/split.test.ts` — expected PASS, 10 cases.

- [ ] **Step 5: Suite, typecheck, commit**

```bash
git add wrangler.jsonc package.json config/split.test.ts
git commit -m "feat(mailchimp-sync): add the sandbox Wrangler environment and the config split test

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: quickbooks-sync — move the QuickBooks API host into config

**Files:**
- Modify: `quickbooks-sync/src/types.ts` (`QuickbooksSyncConfig`)
- Modify: `quickbooks-sync/src/config.ts`
- Modify: `quickbooks-sync/src/quickbooks/client.ts`
- Modify: `quickbooks-sync/src/quickbooks/client.test.ts`
- Modify: `quickbooks-sync/src/index.ts` (two constructor calls)
- Modify: `quickbooks-sync/config/svbc.json`
- Modify: `quickbooks-sync/src/config.test.ts` (if it exists; else create the two cases in a new file)

**Interfaces:**
- Produces: `config.quickbooks.apiBaseUrl: string`; `new HttpQuickBooksClient(tokenStore, clientId, clientSecret, apiBaseUrl)`.

- [ ] **Step 1: Failing tests**

In `src/quickbooks/client.test.ts`, every `new HttpQuickBooksClient(tokenStore, 'client-id', 'client-secret')`
becomes `new HttpQuickBooksClient(tokenStore, 'client-id', 'client-secret', 'https://quickbooks.api.intuit.com/v3/company')`
(six sites), so the existing URL assertions keep passing. Add one case:

```ts
  it('builds entity URLs from the configured API base, so the sandbox host is a config change', async () => {
    const tokenStore = fakeTokenStore({ getTokens: vi.fn().mockResolvedValue(validTokens) });
    const fetchMock = mockFetchSequence([{ ok: true, json: { Customer: { Id: '1' } } }]);
    const client = new HttpQuickBooksClient(tokenStore, 'client-id', 'client-secret', 'https://sandbox-quickbooks.api.intuit.com/v3/company');

    await client.getEntity('customer', '1');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://sandbox-quickbooks.api.intuit.com/v3/company/realm-1/customer/1');
  });
```

In `src/config.test.ts` (create it if absent, importing `validateConfig` from `./config` and `rawConfig` from `../config/svbc.json`):

```ts
  it('requires quickbooks.apiBaseUrl to be an https URL', () => {
    const base = JSON.parse(JSON.stringify(rawConfig)) as Record<string, any>;
    expect(validateConfig(base).quickbooks.apiBaseUrl).toBe('https://quickbooks.api.intuit.com/v3/company');
    base.quickbooks.apiBaseUrl = 'http://quickbooks.api.intuit.com/v3/company';
    expect(() => validateConfig(base)).toThrow('quickbooks.apiBaseUrl');
    delete base.quickbooks;
    expect(() => validateConfig(base)).toThrow('quickbooks');
  });
```

- [ ] **Step 2: Run to verify they fail** — `npm test -- src/quickbooks/client.test.ts src/config.test.ts`; expected FAIL (extra constructor arg ignored → URLs unchanged; `quickbooks` key missing).

- [ ] **Step 3: Implement**

`src/types.ts` — add to `QuickbooksSyncConfig` after `monday`:

```ts
  quickbooks: {
    // QuickBooks Online Accounting API base (…/v3/company). Production is
    // https://quickbooks.api.intuit.com/v3/company; the sandbox environment points at Intuit's
    // sandbox host so a sandbox deploy can never create a Customer in the real company.
    apiBaseUrl: string;
  };
```

`src/config.ts` — after the `monday.boards` loop, add:

```ts
  const quickbooks = requireObject(cfg.quickbooks, 'quickbooks');
  if (typeof quickbooks.apiBaseUrl !== 'string' || !/^https:\/\/[^/]+\/v3\/company$/.test(quickbooks.apiBaseUrl)) {
    throw new Error('config: "quickbooks.apiBaseUrl" must be an https URL ending in /v3/company (the QuickBooks Accounting API base)');
  }
```

`src/quickbooks/client.ts` — delete the `const QB_API_BASE = …;` line; add a fourth constructor
parameter `private apiBaseUrl: string` and replace the two `${QB_API_BASE}` usages with
`${this.apiBaseUrl}`. `QB_TOKEN_URL` stays (Intuit's OAuth endpoint is the same for both).

`src/index.ts` — both `new HttpQuickBooksClient(new D1TokenStore(env.DB), env.QB_CLIENT_ID, env.QB_CLIENT_SECRET)`
become `new HttpQuickBooksClient(new D1TokenStore(env.DB), env.QB_CLIENT_ID, env.QB_CLIENT_SECRET, config.quickbooks.apiBaseUrl)`.

`config/svbc.json` — add after the `monday` object:

```json
  "quickbooks": {
    "apiBaseUrl": "https://quickbooks.api.intuit.com/v3/company"
  },
```

- [ ] **Step 4: Suite, typecheck, commit**

```bash
git add src/types.ts src/config.ts src/quickbooks/client.ts src/quickbooks/client.test.ts src/index.ts config/svbc.json src/config.test.ts
git commit -m "feat(quickbooks-sync): move the QuickBooks API host into config

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: quickbooks-sync — `config/sandbox.json` and config selection

**Files:**
- Create: `quickbooks-sync/config/sandbox.json`
- Modify: `quickbooks-sync/src/index.ts`, `src/types.ts` (`Env`), `test/env.d.ts`
- Create: `quickbooks-sync/src/index.test.ts`

- [ ] **Step 1: `config/sandbox.json`** — copy `config/svbc.json` and change exactly one value:
`quickbooks.apiBaseUrl` → `https://sandbox-quickbooks.api.intuit.com/v3/company`. Board ids stay
`null` (the CRM Sandbox has no Customers/Invoices/Products boards; those are a post-cutover
decision), column placeholders stay as they are.

- [ ] **Step 2: Failing test.** Create `src/index.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import worker from './index';

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

describe('worker entry point', () => {
  it('exposes fetch and queue handlers', () => {
    expect(typeof worker.fetch).toBe('function');
    expect(typeof worker.queue).toBe('function');
  });

  it('refuses an unknown ENVIRONMENT value before routing anything', async () => {
    await expect(
      worker.fetch(new Request('https://worker.example/health'), { ...env, ENVIRONMENT: 'staging' } as unknown as import('./types').Env, ctx)
    ).rejects.toThrow('ENVIRONMENT');
  });
});
```

Run: `npm test -- src/index.test.ts` — expected: second case FAILS.

- [ ] **Step 3: Wire.** In `src/index.ts` replace the config import with the production/sandbox
pair plus `import { createConfigSelector } from './environment';`, replace the module-scope
validation with `const configFor = createConfigSelector({ production: productionConfig, sandbox: sandboxConfig, validate: validateConfig });`
(same comment as Task 4's), and add `const config = configFor(env);` as the first statement of
`fetch` and of `queue`. Add `ENVIRONMENT?: string;` (with the standard comment) to `Env` in
`src/types.ts` and to `test/env.d.ts`.

- [ ] **Step 4: Suite, typecheck, commit**

```bash
git add config/sandbox.json src/index.ts src/types.ts test/env.d.ts src/index.test.ts
git commit -m "feat(quickbooks-sync): add config/sandbox.json on Intuit's sandbox host and select config by ENVIRONMENT

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: quickbooks-sync — `env.sandbox`, deploy script, split test

**Files:**
- Modify: `quickbooks-sync/wrangler.jsonc`, `quickbooks-sync/package.json`
- Create: `quickbooks-sync/config/split.test.ts`

- [ ] **Step 1: Add `env.sandbox`** (last top-level member):

```jsonc
  // ── Sandbox environment ───────────────────────────────────────────────────────────────────
  // `wrangler deploy --env sandbox` (npm run deploy:sandbox) deploys svbc-quickbooks-sync-sandbox
  // against Intuit's *sandbox* host (config/sandbox.json quickbooks.apiBaseUrl, selected by the
  // ENVIRONMENT var) with the sandbox app's development keys. Rule: inbound data only, no
  // outbound data — a sandbox deploy can only create Customers in the sandbox company, and
  // config/split.test.ts fails if the two configs ever share the host. Everything here is
  // non-inheritable in Wrangler and deliberately restated.
  // Design: docs/superpowers/specs/2026-09-18-sandbox-environment-design.md.
  // Secrets exist twice — `wrangler secret put <NAME> --env sandbox` for MONDAY_API_TOKEN,
  // QB_CLIENT_ID and QB_CLIENT_SECRET (the sandbox app's *development* keys — production keys
  // are refused by the sandbox host), QB_WEBHOOK_VERIFIER_TOKEN, MONDAY_WEBHOOK_SECRET.
  "env": {
    "sandbox": {
      "vars": { "ENVIRONMENT": "sandbox" },
      "d1_databases": [
        {
          "binding": "DB",
          "database_name": "svbc-quickbooks-sync-sandbox",
          // Replace after running: wrangler d1 create svbc-quickbooks-sync-sandbox
          "database_id": "REPLACE_AFTER_WRANGLER_D1_CREATE",
          "migrations_dir": "migrations"
        }
      ],
      "queues": {
        "producers": [{ "queue": "quickbooks-sync-writes-sandbox", "binding": "SYNC_QUEUE" }],
        "consumers": [
          {
            "queue": "quickbooks-sync-writes-sandbox",
            "max_retries": 3,
            "max_concurrency": 1,
            "dead_letter_queue": "quickbooks-sync-writes-sandbox-dlq"
          }
        ]
      },
      "observability": {
        "enabled": true
      }
    }
  }
```

(No cron: the top level has none.)

- [ ] **Step 2: Script** — add `"deploy:sandbox": "wrangler deploy --env sandbox",` after `"deploy"`.

- [ ] **Step 3: Dry-run both** — `npx wrangler deploy --env sandbox --dry-run --outdir "$TMPDIR/qb-sb" && npx wrangler deploy --dry-run --outdir "$TMPDIR/qb-prod"`; both exit 0.

- [ ] **Step 4: Split test.** Create `config/split.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import production from './svbc.json';
import sandbox from './sandbox.json';
import wranglerText from '../wrangler.jsonc?raw';
import { parseJsonc } from '../test/jsonc';
import { validateConfig } from '../src/config';
import { queueBaseName } from '../src/environment';

// Guards the "inbound only, no outbound data" rule for this Worker's one outbound sink (the
// QuickBooks company behind quickbooks.apiBaseUrl) and keeps the two deployments apart.
// See the design doc docs/superpowers/specs/2026-09-18-sandbox-environment-design.md §3 and §5.

type Json = Record<string, unknown>;
const get = (obj: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((o, key) => (o as Json | undefined)?.[key], obj);

const wrangler = parseJsonc(wranglerText) as Json;
const sandboxEnv = get(wrangler, 'env.sandbox') as Json;

describe('config split: the QuickBooks sink', () => {
  it('the sandbox targets Intuit’s sandbox host and production the real one', () => {
    expect(sandbox.quickbooks.apiBaseUrl).toBe('https://sandbox-quickbooks.api.intuit.com/v3/company');
    expect(production.quickbooks.apiBaseUrl).toBe('https://quickbooks.api.intuit.com/v3/company');
  });

  it('everything else is identical — the sink is the only difference until Monday boards exist', () => {
    const strip = (c: unknown) => JSON.stringify({ ...(c as Json), quickbooks: undefined });
    expect(strip(sandbox)).toBe(strip(production));
    expect(production.monday.boards).toEqual({ customers: null, invoices: null, products: null });
  });

  it('both shipped configs validate', () => {
    expect(() => validateConfig(sandbox)).not.toThrow();
    expect(() => validateConfig(production)).not.toThrow();
  });
});

describe('wrangler.jsonc env.sandbox', () => {
  it('sets only the ENVIRONMENT var, and never at the top level', () => {
    expect(sandboxEnv.vars).toEqual({ ENVIRONMENT: 'sandbox' });
    expect((wrangler.vars as Json | undefined)?.ENVIRONMENT).toBeUndefined();
  });

  it('uses sandbox-suffixed queue names that map back to the production queues', () => {
    const prodProducers = ((wrangler.queues as Json).producers as { queue: string }[]).map((p) => p.queue);
    const sbQueues = sandboxEnv.queues as Json;
    for (const producer of sbQueues.producers as { queue: string }[]) {
      expect(producer.queue.endsWith('-sandbox')).toBe(true);
      expect(prodProducers).toContain(queueBaseName(producer.queue));
    }
    for (const consumer of sbQueues.consumers as { queue: string; dead_letter_queue: string }[]) {
      expect(consumer.queue.endsWith('-sandbox')).toBe(true);
      expect(consumer.dead_letter_queue).toBe(`${consumer.queue}-dlq`);
    }
  });

  it('has its own D1 database, never production’s', () => {
    const prodDb = (wrangler.d1_databases as Json[])[0]!;
    const sbDb = (sandboxEnv.d1_databases as Json[])[0]!;
    expect(sbDb.database_name).toBe('svbc-quickbooks-sync-sandbox');
    expect(sbDb.database_name).not.toBe(prodDb.database_name);
    const bothPlaceholders = sbDb.database_id === 'REPLACE_AFTER_WRANGLER_D1_CREATE' && prodDb.database_id === sbDb.database_id;
    expect(bothPlaceholders || sbDb.database_id !== prodDb.database_id).toBe(true);
  });

  it('derives its own name and has no cron, like production', () => {
    expect(sandboxEnv.name).toBeUndefined();
    expect(wrangler.name).toBe('svbc-quickbooks-sync');
    expect(sandboxEnv.triggers).toBeUndefined();
    expect(wrangler.triggers).toBeUndefined();
  });
});
```

Run: `npm test -- config/split.test.ts` — expected PASS, 7 cases.

- [ ] **Step 5: Suite, typecheck, commit**

```bash
git add wrangler.jsonc package.json config/split.test.ts
git commit -m "feat(quickbooks-sync): add the sandbox Wrangler environment and the config split test

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: monday-backup — `config/backup.sandbox.json` and config selection

**Files:**
- Create: `monday-backup/config/backup.sandbox.json`
- Modify: `monday-backup/src/index.ts`, `src/types.ts` (`Env`), `test/env.d.ts`
- Create: `monday-backup/src/index.test.ts`

- [ ] **Step 1: `config/backup.sandbox.json`**

```json
{
  "destinationParentFolderId": "REPLACE_WITH_SANDBOX_DRIVE_FOLDER_ID",
  "excludeBoardIds": []
}
```

- [ ] **Step 2: Failing test.** Create `src/index.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import worker from './index';

describe('worker entry point', () => {
  it('exposes fetch and scheduled handlers', () => {
    expect(typeof worker.fetch).toBe('function');
    expect(typeof worker.scheduled).toBe('function');
  });

  it('refuses an unknown ENVIRONMENT value instead of running a backup with a guessed config', async () => {
    await expect(
      worker.scheduled({ scheduledTime: Date.now(), cron: '0 9 * * *' } as ScheduledController, { ...env, ENVIRONMENT: 'staging' } as unknown as import('./types').Env)
    ).rejects.toThrow('ENVIRONMENT');
  });
});
```

Run: `npm test -- src/index.test.ts` — expected: second case FAILS.

- [ ] **Step 3: Wire.** In `src/index.ts`:

```ts
import productionConfig from '../config/backup.json';
import sandboxConfig from '../config/backup.sandbox.json';
import { createConfigSelector } from './environment';
```

replace `const config = validateConfig(rawConfig);` with the selector (`configFor`, same comment
as Task 4's but naming `destinationParentFolderId` as the sink), and inside `scheduled` add
`const config = configFor(env);` as the first statement (the `/health` app needs no config).
Add `ENVIRONMENT?: string;` to `Env` in `src/types.ts` and to `test/env.d.ts`.

- [ ] **Step 4: Suite, typecheck, commit**

```bash
git add config/backup.sandbox.json src/index.ts src/types.ts test/env.d.ts src/index.test.ts
git commit -m "feat(monday-backup): add config/backup.sandbox.json and select config by ENVIRONMENT

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: monday-backup — `env.sandbox`, deploy script, split test

**Files:**
- Modify: `monday-backup/wrangler.jsonc`, `monday-backup/package.json`
- Create: `monday-backup/config/split.test.ts`

- [ ] **Step 1: Add `env.sandbox`** (last top-level member):

```jsonc
  // ── Sandbox environment ───────────────────────────────────────────────────────────────────
  // `wrangler deploy --env sandbox` (npm run deploy:sandbox) deploys svbc-monday-backup-sandbox,
  // which snapshots every board its *sandbox* token can see (a user scoped to the CRM Sandbox
  // workspace) into the Drive folder named in config/backup.sandbox.json, alerting a sandbox
  // Slack channel. Rule: inbound data only, no outbound data — the Drive folder and Slack channel
  // are staff-only sinks, and config/split.test.ts fails if the two configs ever share the folder.
  // Design: docs/superpowers/specs/2026-09-18-sandbox-environment-design.md.
  // Secrets exist twice — `wrangler secret put <NAME> --env sandbox` for MONDAY_API_TOKEN (the
  // sandbox-workspace-scoped user), GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
  // (a service account shared only into the sandbox folder), SLACK_WEBHOOK_URL (#crm-sandbox).
  "env": {
    "sandbox": {
      "vars": { "ENVIRONMENT": "sandbox" },
      "workers_dev": false,
      "preview_urls": false,
      "d1_databases": [
        {
          "binding": "DB",
          "database_name": "svbc-monday-backup-sandbox",
          // Replace after running: wrangler d1 create svbc-monday-backup-sandbox
          "database_id": "REPLACE_AFTER_WRANGLER_D1_CREATE",
          "migrations_dir": "migrations"
        }
      ],
      "triggers": {
        "crons": ["0 9 * * *"]
      },
      "observability": { "enabled": true }
    }
  }
```

- [ ] **Step 2: Script** — add `"deploy:sandbox": "wrangler deploy --env sandbox",` after `"deploy"`.

- [ ] **Step 3: Dry-run both** — `npx wrangler deploy --env sandbox --dry-run --outdir "$TMPDIR/mb-sb" && npx wrangler deploy --dry-run --outdir "$TMPDIR/mb-prod"`; both exit 0.

- [ ] **Step 4: Split test.** Create `config/split.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import production from './backup.json';
import sandbox from './backup.sandbox.json';
import wranglerText from '../wrangler.jsonc?raw';
import { parseJsonc } from '../test/jsonc';
import { validateConfig } from '../src/config';

// Guards the "inbound only, no outbound data" rule for this Worker's sinks (the Drive folder in
// config; the Slack webhook is a per-environment secret) and keeps the two deployments apart.
// See the design doc docs/superpowers/specs/2026-09-18-sandbox-environment-design.md §3 and §5.

type Json = Record<string, unknown>;
const get = (obj: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((o, key) => (o as Json | undefined)?.[key], obj);

const wrangler = parseJsonc(wranglerText) as Json;
const sandboxEnv = get(wrangler, 'env.sandbox') as Json;

describe('config split: the Drive sink', () => {
  it('the sandbox folder is never the production folder', () => {
    expect(typeof sandbox.destinationParentFolderId).toBe('string');
    expect(sandbox.destinationParentFolderId).not.toBe('');
    expect(sandbox.destinationParentFolderId).not.toBe(production.destinationParentFolderId);
  });

  it('the sandbox folder placeholder is unmistakably the sandbox one until an operator fills it in', () => {
    if (sandbox.destinationParentFolderId.startsWith('REPLACE_WITH_')) {
      expect(sandbox.destinationParentFolderId).toBe('REPLACE_WITH_SANDBOX_DRIVE_FOLDER_ID');
    }
    if (production.destinationParentFolderId.startsWith('REPLACE_WITH_')) {
      expect(production.destinationParentFolderId).toBe('REPLACE_WITH_DRIVE_FOLDER_ID');
    }
  });

  it('both shipped configs validate', () => {
    expect(() => validateConfig(sandbox)).not.toThrow();
    expect(() => validateConfig(production)).not.toThrow();
  });
});

describe('wrangler.jsonc env.sandbox', () => {
  it('sets only the ENVIRONMENT var, and never at the top level', () => {
    expect(sandboxEnv.vars).toEqual({ ENVIRONMENT: 'sandbox' });
    expect((wrangler.vars as Json | undefined)?.ENVIRONMENT).toBeUndefined();
  });

  it('stays cron-only with no public surface, like production', () => {
    expect(sandboxEnv.workers_dev).toBe(false);
    expect(sandboxEnv.preview_urls).toBe(false);
    expect(sandboxEnv.routes).toBeUndefined();
    expect((sandboxEnv.triggers as Json).crons).toEqual((wrangler.triggers as Json).crons);
  });

  it('has its own D1 database, never production’s', () => {
    const prodDb = (wrangler.d1_databases as Json[])[0]!;
    const sbDb = (sandboxEnv.d1_databases as Json[])[0]!;
    expect(sbDb.database_name).toBe('svbc-monday-backup-sandbox');
    expect(sbDb.database_name).not.toBe(prodDb.database_name);
    const bothPlaceholders = sbDb.database_id === 'REPLACE_AFTER_WRANGLER_D1_CREATE' && prodDb.database_id === sbDb.database_id;
    expect(bothPlaceholders || sbDb.database_id !== prodDb.database_id).toBe(true);
  });

  it('derives its own name', () => {
    expect(sandboxEnv.name).toBeUndefined();
    expect(wrangler.name).toBe('svbc-monday-backup');
  });
});
```

Run: `npm test -- config/split.test.ts` — expected PASS, 7 cases. (The production D1 id is
`REPLACE_WITH_D1_DATABASE_ID`, a different placeholder string, so the D1 case is live today.)

- [ ] **Step 5: Suite, typecheck, commit**

```bash
git add wrangler.jsonc package.json config/split.test.ts
git commit -m "feat(monday-backup): add the sandbox Wrangler environment and the config split test

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: benevity-import — `config/sandbox.json`, production placeholders in `svbc.json`

**Files:**
- Create: `benevity-import/config/sandbox.json`
- Modify: `benevity-import/config/svbc.json`

- [ ] **Step 1: `cp config/svbc.json config/sandbox.json`**

- [ ] **Step 2: Rewrite `config/svbc.json`:**

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
    "minDonationDate": "2026-09-16",
    "donationsColumns": {
      "donor": "REPLACE_WITH_COLUMN_ID",
      "matchedBy": "REPLACE_WITH_COLUMN_ID",
      "amount": "REPLACE_WITH_COLUMN_ID",
      "date": "REPLACE_WITH_COLUMN_ID",
      "disbursementDate": "REPLACE_WITH_COLUMN_ID",
      "fiscalYearEnding": "REPLACE_WITH_COLUMN_ID",
      "status": "REPLACE_WITH_COLUMN_ID",
      "giftType": "REPLACE_WITH_COLUMN_ID",
      "anonymousDonor": "REPLACE_WITH_COLUMN_ID",
      "transactionId": "REPLACE_WITH_COLUMN_ID"
    },
    "organizationsNameColumn": "name",
    "peopleColumns": {
      "personalEmail": "REPLACE_WITH_COLUMN_ID",
      "householdEmail": "REPLACE_WITH_COLUMN_ID",
      "employer": "REPLACE_WITH_COLUMN_ID"
    },
    "affiliationsColumns": {
      "person": "REPLACE_WITH_COLUMN_ID",
      "organization": "REPLACE_WITH_COLUMN_ID",
      "workEmail": "REPLACE_WITH_COLUMN_ID"
    },
    "uploadsBoard": {
      "fileColumn": "REPLACE_WITH_COLUMN_ID",
      "worklistGroupId": "REPLACE_WITH_GROUP_ID",
      "worklistColumns": {
        "reason": "REPLACE_WITH_COLUMN_ID",
        "name": "name",
        "email": "REPLACE_WITH_COLUMN_ID",
        "company": "REPLACE_WITH_COLUMN_ID",
        "amount": "REPLACE_WITH_COLUMN_ID",
        "date": "REPLACE_WITH_COLUMN_ID"
      }
    },
    "organizationAliases": {},
    "rawRowRetentionDays": 90,
    "unresolvedRowRetentionDays": 365
  }
}
```

(`validateConfig` accepts null board ids and any non-empty string for column and group ids;
`"name"` is Monday's fixed name-column id and stays.)

- [ ] **Step 3: Verify** — `npm test && npm run typecheck` — PASS (the current `index.test.ts` still imports and validates at module scope; Task 12 changes that).

- [ ] **Step 4: Commit**

```bash
git add config/sandbox.json config/svbc.json
git commit -m "feat(benevity-import): split config into sandbox.json and a production-only svbc.json

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: benevity-import — select config per environment

**Files:**
- Modify: `benevity-import/src/index.ts`, `src/types.ts` (`Env`), `test/env.d.ts`, `src/index.test.ts`

- [ ] **Step 1: Replace the tests.** In `src/index.test.ts`, replace the case
"loads and validates config/svbc.json at import time without throwing" with:

```ts
  it('refuses an unknown ENVIRONMENT value instead of guessing a config', async () => {
    await expect(
      worker.scheduled({ scheduledTime: Date.now(), cron: '15 9 * * *' } as ScheduledController, { ...env, ENVIRONMENT: 'staging' } as unknown as import('./types').Env)
    ).rejects.toThrow('ENVIRONMENT');
  });

  it('runs the scheduled purge under the sandbox config (regression guard for the request-time config switch)', async () => {
    await expect(
      worker.scheduled({ scheduledTime: Date.now(), cron: '15 9 * * *' } as ScheduledController, { ...env, ENVIRONMENT: 'sandbox' } as unknown as import('./types').Env)
    ).resolves.toBeUndefined();
  });
```

and add `import { env } from 'cloudflare:workers';` to the imports. Run `npm test -- src/index.test.ts`; the first new case FAILS.

- [ ] **Step 2: Wire.** In `src/index.ts`: the production/sandbox import pair plus
`import { createConfigSelector } from './environment';`; the selector replaces the module-scope
validation (same comment as Task 4's); `const config = configFor(env);` first in `fetch`, `queue`,
and `scheduled`. Add `ENVIRONMENT?: string;` to `Env` in `src/types.ts` and inside the
`declare global { namespace Cloudflare { interface Env { … } } }` block in `test/env.d.ts`.

- [ ] **Step 3: Suite, typecheck, commit**

```bash
git add src/index.ts src/types.ts test/env.d.ts src/index.test.ts
git commit -m "feat(benevity-import): select config by ENVIRONMENT at request time

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: benevity-import — `env.sandbox`, deploy script, split test

**Files:**
- Modify: `benevity-import/wrangler.jsonc`, `benevity-import/package.json`
- Create: `benevity-import/config/split.test.ts`

- [ ] **Step 1: Add `env.sandbox`** (last top-level member):

```jsonc
  // ── Sandbox environment ───────────────────────────────────────────────────────────────────
  // `wrangler deploy --env sandbox` (npm run deploy:sandbox) deploys svbc-benevity-import-sandbox
  // against the CRM Sandbox boards (config/sandbox.json, selected by the ENVIRONMENT var). This
  // Worker writes only to Monday, so the split exists so sandbox and production can coexist.
  // Everything here is non-inheritable in Wrangler and deliberately restated.
  // Design: docs/superpowers/specs/2026-09-18-sandbox-environment-design.md.
  // Secrets exist twice — `wrangler secret put <NAME> --env sandbox` for MONDAY_API_TOKEN and
  // BENEVITY_WEBHOOK_SECRET.
  "env": {
    "sandbox": {
      "vars": { "ENVIRONMENT": "sandbox" },
      "d1_databases": [
        {
          "binding": "DB",
          "database_name": "svbc-benevity-import-sandbox",
          // Replace after running: wrangler d1 create svbc-benevity-import-sandbox
          "database_id": "REPLACE_AFTER_WRANGLER_D1_CREATE",
          "migrations_dir": "migrations"
        }
      ],
      "queues": {
        "producers": [{ "queue": "benevity-import-writes-sandbox", "binding": "WRITE_QUEUE" }],
        "consumers": [
          {
            "queue": "benevity-import-writes-sandbox",
            "max_retries": 3,
            "max_concurrency": 1,
            "dead_letter_queue": "benevity-import-writes-sandbox-dlq"
          }
        ]
      },
      "triggers": {
        "crons": ["15 9 * * *"]
      },
      "observability": {
        "enabled": true
      }
    }
  }
```

- [ ] **Step 2: Script** — add `"deploy:sandbox": "wrangler deploy --env sandbox",` after `"deploy"`.

- [ ] **Step 3: Dry-run both** — `npx wrangler deploy --env sandbox --dry-run --outdir "$TMPDIR/bv-sb" && npx wrangler deploy --dry-run --outdir "$TMPDIR/bv-prod"`; both exit 0.

- [ ] **Step 4: Split test.** Create `config/split.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import production from './svbc.json';
import sandbox from './sandbox.json';
import wranglerText from '../wrangler.jsonc?raw';
import { parseJsonc } from '../test/jsonc';
import { validateConfig } from '../src/config';
import { queueBaseName } from '../src/environment';

// Keeps the sandbox and production deployments apart at the repo level: sandbox.json is the
// real, complete CRM Sandbox config; svbc.json is production and may hold no sandbox id.
// See the design doc docs/superpowers/specs/2026-09-18-sandbox-environment-design.md §5.

type Json = Record<string, unknown>;
const get = (obj: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((o, key) => (o as Json | undefined)?.[key], obj);

const wrangler = parseJsonc(wranglerText) as Json;
const sandboxEnv = get(wrangler, 'env.sandbox') as Json;

const BOARD_KEYS = ['donations', 'organizations', 'people', 'affiliations', 'benevityUploads'];

describe('config split: board and column ids', () => {
  it.each(BOARD_KEYS)('monday.boards.%s is a real sandbox id and null in production', (key) => {
    const sb = (sandbox.monday.boards as Record<string, unknown>)[key];
    const prod = (production.monday.boards as Record<string, unknown>)[key];
    expect(typeof sb).toBe('number');
    expect(sb).toBeGreaterThan(0);
    expect(prod === null || prod !== sb).toBe(true);
  });

  it('sandbox.json targets the CRM Sandbox Donations, People, and Uploads boards', () => {
    expect(sandbox.monday.boards.donations).toBe(18428131791);
    expect(sandbox.monday.boards.people).toBe(18428131737);
    expect(sandbox.monday.boards.benevityUploads).toBe(18431270204);
  });

  it('no sandbox column or group id string-appears anywhere in production', () => {
    const ids = new Set<string>();
    const collect = (value: unknown): void => {
      if (typeof value === 'string' && /^[a-z_]+_mm[0-9a-z]+$/.test(value)) ids.add(value);
      else if (value !== null && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach(collect);
    };
    collect(sandbox.benevityImport);
    expect(ids.size).toBeGreaterThan(15);
    const productionText = JSON.stringify(production);
    for (const id of ids) {
      expect(productionText, id).not.toContain(`"${id}"`);
    }
  });

  it('both shipped configs validate', () => {
    expect(() => validateConfig(sandbox)).not.toThrow();
    expect(() => validateConfig(production)).not.toThrow();
  });
});

describe('wrangler.jsonc env.sandbox', () => {
  it('sets only the ENVIRONMENT var, and never at the top level', () => {
    expect(sandboxEnv.vars).toEqual({ ENVIRONMENT: 'sandbox' });
    expect((wrangler.vars as Json | undefined)?.ENVIRONMENT).toBeUndefined();
  });

  it('uses sandbox-suffixed queue names that map back to the production queues', () => {
    const prodProducers = ((wrangler.queues as Json).producers as { queue: string }[]).map((p) => p.queue);
    const sbQueues = sandboxEnv.queues as Json;
    for (const producer of sbQueues.producers as { queue: string }[]) {
      expect(producer.queue.endsWith('-sandbox')).toBe(true);
      expect(prodProducers).toContain(queueBaseName(producer.queue));
    }
    for (const consumer of sbQueues.consumers as { queue: string; dead_letter_queue: string }[]) {
      expect(consumer.queue.endsWith('-sandbox')).toBe(true);
      expect(consumer.dead_letter_queue).toBe(`${consumer.queue}-dlq`);
    }
  });

  it('has its own D1 database, never production’s', () => {
    const prodDb = (wrangler.d1_databases as Json[])[0]!;
    const sbDb = (sandboxEnv.d1_databases as Json[])[0]!;
    expect(sbDb.database_name).toBe('svbc-benevity-import-sandbox');
    expect(sbDb.database_name).not.toBe(prodDb.database_name);
    const bothPlaceholders = sbDb.database_id === 'REPLACE_AFTER_WRANGLER_D1_CREATE' && prodDb.database_id === sbDb.database_id;
    expect(bothPlaceholders || sbDb.database_id !== prodDb.database_id).toBe(true);
  });

  it('keeps the same cron schedule as production and derives its own name', () => {
    expect((sandboxEnv.triggers as Json).crons).toEqual((wrangler.triggers as Json).crons);
    expect(sandboxEnv.name).toBeUndefined();
    expect(wrangler.name).toBe('svbc-benevity-import');
  });
});
```

Run: `npm test -- config/split.test.ts` — expected PASS, 12 cases (5 + 3 + 4). The sandbox id set
is 23 (10 donation + 3 people + 3 affiliation + 1 file column + 1 group id + 5 worklist columns,
with the fixed `name` columns excluded by the regex).

- [ ] **Step 5: Suite, typecheck, commit**

```bash
git add wrangler.jsonc package.json config/split.test.ts
git commit -m "feat(benevity-import): add the sandbox Wrangler environment and the config split test

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: Documentation

**Files:**
- Modify: `mailchimp-sync/README.md`, `quickbooks-sync/README.md`, `monday-backup/README.md`, `benevity-import/README.md`
- Modify: `README.md` (root — four status rows), `CLAUDE.md` (root)
- Modify: `docs/superpowers/specs/2026-09-18-sandbox-environment-design.md` (status line; two §3 notes)

- [ ] **Step 1: Worker READMEs.** Insert each block as a new `## Sandbox environment — inbound only, no outbound data` section immediately **before** the section named:

`mailchimp-sync/README.md`, before `## Local development`:

```markdown
## Sandbox environment — inbound only, no outbound data

`npm run deploy:sandbox` deploys `svbc-mailchimp-sync-sandbox` (`wrangler.jsonc` `env.sandbox`)
against the CRM Sandbox People board and a **sandbox Mailchimp audience**, from
`config/sandbox.json` (chosen at request time by the `ENVIRONMENT` var — `src/environment.ts`).
Its own D1, queues (`mailchimp-sync-outbound-sandbox`, `mailchimp-sync-inbound-sandbox`, each
with a `-dlq`), and secrets. The rule for this Worker: the sandbox may upsert contacts and
reconcile interests only in the sandbox audience — `config/split.test.ts` fails if the two
configs ever share `mailchimp.audienceId`, and the Mailchimp API key cannot enforce it (keys
are account-scoped), so that test is the guard. Sandbox-specific facts: the sandbox People board
has no State column, so `monday.columns.state` stays a placeholder and the ADDRESS merge field
carries an empty state; the sandbox "Mailchimp Campaigns (sandbox)" board and the People
board's "Mailchimp Campaigns" connect column were created 2026-09-18 by the step 3 plan's Task 2.
Staff prerequisites before the first sandbox deploy (the step 3 plan's Task 15): the sandbox
audience with the six merge fields and the Interest Category, and its webhook pointed at the
sandbox Worker. `npm run deploy:sandbox` fails until `env.sandbox.d1_databases[0].database_id`
is replaced with the id `wrangler d1 create` prints. Design:
`../docs/superpowers/specs/2026-09-18-sandbox-environment-design.md`.
```

`quickbooks-sync/README.md`, before `## Open question before starting`:

```markdown
## Sandbox environment — inbound only, no outbound data

`npm run deploy:sandbox` deploys `svbc-quickbooks-sync-sandbox` (`wrangler.jsonc` `env.sandbox`)
against **Intuit's sandbox host** — `config/sandbox.json`'s `quickbooks.apiBaseUrl` is
`https://sandbox-quickbooks.api.intuit.com/v3/company`, chosen at request time by the
`ENVIRONMENT` var (`src/environment.ts`); the host moved out of `src/quickbooks/client.ts` into
config for exactly this. A sandbox company is reachable only with the app's *development* keys,
so `QB_CLIENT_ID`/`QB_CLIENT_SECRET` and the seeded token pair are different secrets per
environment (`wrangler secret put … --env sandbox`), and a production key presented to the sandbox
host fails authentication. `config/split.test.ts` fails if the two configs ever share the host.
Own D1 and queue (`quickbooks-sync-writes-sandbox` and its `-dlq`). Monday board ids are `null`
in both configs until the Customers/Invoices/Products boards exist. Staff prerequisites (the step 3
plan's Task 15): an Intuit sandbox company, development keys, a token pair seeded via the OAuth
Playground, and a webhook subscription. `npm run deploy:sandbox` fails until
`env.sandbox.d1_databases[0].database_id` is replaced with the id `wrangler d1 create` prints.
Design: `../docs/superpowers/specs/2026-09-18-sandbox-environment-design.md`.
```

`monday-backup/README.md`, before `## Retention`:

```markdown
## Sandbox environment — inbound only, no outbound data

`npm run deploy:sandbox` deploys `svbc-monday-backup-sandbox` (`wrangler.jsonc` `env.sandbox`),
which snapshots every board its **sandbox token** can see — mint it from a user whose only
access is the CRM Sandbox workspace, and the snapshot is the sandbox and nothing else — into the
Drive folder in `config/backup.sandbox.json` (chosen at request time by the `ENVIRONMENT` var,
`src/environment.ts`), alerting `#crm-sandbox` through the sandbox `SLACK_WEBHOOK_URL`. Both
sinks are staff-only; `config/split.test.ts` fails if the two configs ever share the folder id.
Own D1, same daily cron, no public surface. Secrets exist twice (`wrangler secret put … --env
sandbox`): the sandbox Monday token, a service account shared only into the sandbox folder, the
sandbox Slack webhook. `npm run deploy:sandbox` fails until `env.sandbox.d1_databases[0].database_id`
is replaced with the id `wrangler d1 create` prints. Design:
`../docs/superpowers/specs/2026-09-18-sandbox-environment-design.md`.
```

`benevity-import/README.md`, before `## Related changes elsewhere`:

```markdown
## Sandbox environment — inbound only, no outbound data

`npm run deploy:sandbox` deploys `svbc-benevity-import-sandbox` (`wrangler.jsonc` `env.sandbox`)
against the CRM Sandbox boards in `config/sandbox.json`, chosen at request time by the
`ENVIRONMENT` var (`src/environment.ts`); `config/svbc.json` is production and holds
placeholders until cutover. Own D1, queue (`benevity-import-writes-sandbox` and its `-dlq`), cron,
and secrets (`wrangler secret put … --env sandbox`). This Worker writes only to Monday, so the
split exists so the two deployments can coexist. `config/split.test.ts` fails if any of the
sandbox column ids appears in `config/svbc.json`. The Benevity Uploads board webhook must point at
the sandbox Worker's `/webhooks/monday/benevity-upload` route (see "Data flow") with the sandbox
`BENEVITY_WEBHOOK_SECRET`. `npm run deploy:sandbox` fails until
`env.sandbox.d1_databases[0].database_id` is replaced with the id `wrangler d1 create` prints.
Design: `../docs/superpowers/specs/2026-09-18-sandbox-environment-design.md`.
```

Also in `benevity-import/README.md` "Monday targets", change "All ids in `config/svbc.json`,
validated at startup, none hardcoded:" to "All ids in `config/sandbox.json` (the CRM Sandbox) or
`config/svbc.json` (production, placeholders until cutover), validated at first request, none
hardcoded:". Then `grep -n 'svbc.json' benevity-import/README.md` and fix any other hit that
describes the file as holding sandbox ids. (If the Data flow section names the webhook route
differently from `/webhooks/monday/benevity-upload`, use the route the code actually mounts — check
`src/webhook/route.ts` — in the inserted text.)

- [ ] **Step 2: Root `README.md`.** Append to each Status cell (keep each row on one line):

- `quickbooks-sync`, after "…the Intuit app-review question resolved": `. Has a **sandbox environment** (`npm run deploy:sandbox`) on Intuit's sandbox host, with the API host now in config — see [the sandbox design](docs/superpowers/specs/2026-09-18-sandbox-environment-design.md)`
- `mailchimp-sync`, after "…merge fields/Interest Categories": `. Has a **sandbox environment** (`npm run deploy:sandbox`, `config/sandbox.json`) that may only write to a sandbox audience — see [the sandbox design](docs/superpowers/specs/2026-09-18-sandbox-environment-design.md)`
- `monday-backup`, after "…scoped to the destination Drive folder": `. Has a **sandbox environment** (`npm run deploy:sandbox`, `config/backup.sandbox.json`) that snapshots the sandbox workspace into a separate Drive folder — see [the sandbox design](docs/superpowers/specs/2026-09-18-sandbox-environment-design.md)`
- `benevity-import`, after "…(see its README)": `. Has a **sandbox environment** (`npm run deploy:sandbox`, `config/sandbox.json`) — see [the sandbox design](docs/superpowers/specs/2026-09-18-sandbox-environment-design.md)`

- [ ] **Step 3: Root `CLAUDE.md`.** In the sandbox paragraph, change
"Workers that run against the sandbox (`donor-portal`, `funraise-sync`, `donation-rollups` today; `mailchimp-sync`, `quickbooks-sync`, `monday-backup`, `benevity-import` next) carry a"
to "Every migration Worker (`donor-portal`, `funraise-sync`, `donation-rollups`, `mailchimp-sync`, `quickbooks-sync`, `monday-backup`, `benevity-import`; not `svbc-calendars`) carries a".
In the Commands block, change the `deploy:sandbox` comment to
`# wrangler deploy --env sandbox — every migration Worker has an env.sandbox block`.

- [ ] **Step 4: Spec.** Change the `**Status:**` line to:
`**Status:** Approved and implemented — rollout steps 1–3 landed 2026-09-18 (donor-portal; funraise-sync and donation-rollups; mailchimp-sync, quickbooks-sync, monday-backup, benevity-import). Live provisioning per Worker follows each step's plan runbook.`
In §3's `quickbooks-sync` paragraph, after "validated as a URL." add: "The client takes the base as a constructor argument (`HttpQuickBooksClient(tokenStore, clientId, clientSecret, apiBaseUrl)`)." In §3's `mailchimp-sync` paragraph, append: "The sandbox also needs its own "Mailchimp Campaigns (sandbox)" board and a People connect column pointed at it — created 2026-09-18 (step 3 plan, Task 2)."

- [ ] **Step 5: Commit**

From the repo root:

```bash
git add mailchimp-sync/README.md quickbooks-sync/README.md monday-backup/README.md benevity-import/README.md README.md CLAUDE.md docs/superpowers/specs/2026-09-18-sandbox-environment-design.md
git commit -m "docs: document the sandbox environments of the four remaining Workers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 15: Provision and verify (operator runbook)

None of these four Workers is deployed today, so there is nothing to move or delete. This
provisions the sandbox deployments. Every step that needs a vendor account, a secret, or a
Cloudflare login is a human action; stop and hand off at the first one you cannot complete.
`wrangler` runs outside the Bash sandbox (`dangerouslyDisableSandbox: true`).

**Staff prerequisites (human), per Worker:**

- `mailchimp-sync`: an "SVBC Sandbox" audience with the six merge fields (`MEMBERSINCE`,
  `MEMBERUNTIL`, `MTIER`, `MSTATUS`, `ADDRESS`, `TOTALGIVE`) and the Interest Category; its id
  into `config/sandbox.json` `mailchimp.audienceId` and the data-center prefix into `apiBaseUrl`
  (both files share the DC); an audience webhook pointed at the sandbox Worker's
  `/webhooks/mailchimp/audience?secret=…` with "API" events unchecked.
- `quickbooks-sync`: an Intuit sandbox company under SVBC's developer account, the app's
  development keys, a token pair seeded via the OAuth Playground into the sandbox D1 (same manual
  step as production), and a webhook subscription to the sandbox Worker's `/webhooks/quickbooks`
  route.
- `monday-backup`: a "CRM Sandbox backups" Drive folder shared with a service account; its id into
  `config/backup.sandbox.json`; a `#crm-sandbox` Slack incoming webhook.
- All four: the shared sandbox Monday integration user (workspace `17141226` only, member seat)
  and its token.

**benevity-import first:** its production D1 already exists (`wrangler.jsonc` carries the real id,
provisioned 2026-09-18) and its README status was stale. Run `npx wrangler deployments list --name
svbc-benevity-import`; if a deployment exists, do not provision a plain sandbox first deploy —
follow the design doc's §9 move (as step 2 did for funraise-sync and donation-rollups). Do not run
`wrangler d1 create svbc-benevity-import`; only the sandbox database is new.

**Cloudflare, per Worker, from its directory:**

```bash
npx wrangler d1 create svbc-<worker>-sandbox      # paste the id into env.sandbox.d1_databases[0].database_id — the sandbox database only — production D1s that already exist (benevity-import) are not recreated
npx wrangler d1 migrations apply svbc-<worker>-sandbox --remote --env sandbox
npx wrangler queues create <queue>-sandbox && npx wrangler queues create <queue>-sandbox-dlq   # each producer queue (mailchimp has two)
npx wrangler secret put <NAME> --env sandbox      # each secret listed in that Worker's env.sandbox comment; the operator types the values
npm test && npm run typecheck && npm run deploy:sandbox
```

`monday-backup` has no queues. Commit the four `database_id` edits (and the two config-file
sink ids once staff supply them) as `chore: point the step 3 Workers' env.sandbox at the provisioned D1s`.

**Register the Monday webhooks** at the sandbox URLs: `mailchimp-sync` on the People board
(`create_item` + `change_column_value`, `/webhooks/monday/donors?secret=…`), `benevity-import` on
the Benevity Uploads board (`18431270204`, `/webhooks/monday/benevity-upload?secret=…` — confirm the route in its
README), `quickbooks-sync` only once its Monday boards exist.

**Verify:** `mailchimp-sync` — change Membership Status on one sandbox People item and confirm the
contact appears in the **sandbox** audience and not the production one (check both); unsubscribe
it in Mailchimp and confirm the People connect column updates. `quickbooks-sync` — create a
Customer through the Monday route (once boards exist) and confirm it appears in the Intuit
**sandbox** company. `monday-backup` — it has no public surface in either environment, so watch
the 09:00 UTC run with `npx wrangler tail --env sandbox` from `monday-backup/` and confirm a dated
folder appears under the sandbox Drive folder containing only sandbox boards. `benevity-import` — drop a small CSV on
the sandbox Uploads board and confirm the gifts land on the sandbox Donations board.

Record the outcome per Worker in the root README status rows (`Sandbox provisioned and verified
<YYYY-MM-DD>`).
