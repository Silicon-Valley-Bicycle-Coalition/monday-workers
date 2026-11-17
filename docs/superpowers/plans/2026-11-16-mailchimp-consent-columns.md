# mailchimp-sync Consent Columns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An hourly `mailchimp-sync` cron that sets the five Monday Email Consent columns
(Personal, Household on People and People (Historical); Work on Affiliations) to each address's
current Mailchimp status, writing only differences.

**Architecture:** A new `src/consent/` module: a pure planner (`plan.ts`), two readers plus a
writer over `fetch` and the shared GraphQL transport (`sources.ts`), and a run function
(`run.ts`) wired to a second cron trigger in `scheduled()`. Both `plan.ts` and `sources.ts` have
only `import type` relative imports, so the operator script `scripts/consent-plan.mjs` can load
them through Node's type stripping.

**Tech Stack:** TypeScript, Cloudflare Workers cron triggers, Vitest (`@cloudflare/vitest-plugin`),
Monday GraphQL (`src/monday/graphql.ts` transport), Mailchimp Marketing API v3.

**Spec:** `docs/superpowers/specs/2026-11-16-mailchimp-consent-columns-design.md`

## Global Constraints

- Work in `mailchimp-sync/`, branch `feat/mailchimp-consent-sync`. Commands run from `mailchimp-sync/`.
- Type-check with `npm run typecheck`, never bare `tsc`.
- Never log an email address or a person's name; item ids, column ids and counts only. `node ../scripts/check-log-safety.mjs` must pass.
- `src/flags.ts` and `src/monday/graphql.ts` are byte-identical copies; do not edit them.
- `src/consent/plan.ts` and `src/consent/sources.ts`: relative imports are `import type` only (Node type stripping); no enums, namespaces or constructor parameter properties.
- Labels exactly: `Subscribed`, `Unsubscribed`, `Cleaned`, `Not in Mailchimp`. `''` clears a status cell in `change_multiple_column_values` (donation-rollups' precedent).
- Mapping: `subscribed`→Subscribed, `unsubscribed`→Unsubscribed, `cleaned`→Cleaned, `archived`→Cleaned if current is Cleaned else Unsubscribed, `pending`/`transactional`/absent→Not in Mailchimp; blank address with non-blank consent → `''`.
- Sendable targets (capped): `Subscribed`, `Not in Mailchimp`, `''`. Non-sendable (`Unsubscribed`, `Cleaned`) are always written.
- `consent.maxChangesPerRun`: 500 in both configs. `consent.enabled`: `true` sandbox, `false` production.
- Crons: consent `5 * * * *`; Campaigns stays `0 15 * * *`. `limits.cpu_ms`: 1000 in both environments.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Mixed-case or space-padded addresses on Monday (staff-typed) must match Mailchimp's lowercase address, not read as "Not in Mailchimp" → Task 2 test `normalizes case and whitespace`.
2. A short Mailchimp read (member added/removed mid-paging, a 5xx page) must write nothing at all → Task 3 test `throws ConsentShortReadError when a pass reads fewer than total_items`, Task 4 test `a short read writes nothing and alerts`.
3. A config column id that the board doesn't have must fail the board, never plan writes against it → Task 3 test `readBoard throws when a configured column is missing from the board`.
4. One failing Monday write chunk must not stop the rest, and must be counted → Task 3 test `writeConsent isolates a failed chunk item by item`.
5. The daily Campaigns cron must not run the consent sync and vice versa → Task 4 test `scheduled dispatches on event.cron`.

---

### Task 1: Config — the `consent` block

**Files:**
- Modify: `src/types.ts` (add types, `Config.consent`), `src/config.ts` (validate), `config/svbc.json`, `config/sandbox.json`, `config/split.test.ts`
- Test: `src/config.test.ts`

**Interfaces:**
- Produces (in `src/types.ts`):
  ```ts
  export interface ConsentPair { emailColumn: string; consentColumn: string }
  export interface ConsentBoard { name: string; boardId: number; pairs: ConsentPair[] }
  export interface ConsentConfig { enabled: boolean; maxChangesPerRun: number; boards: ConsentBoard[] }
  // Config gains: consent: ConsentConfig
  ```

- [ ] **Step 1: Write failing tests** in `src/config.test.ts`, `describe('consent')`:
  - `validates the consent block`: `validateConfig(production).consent.boards.map(b => b.boardId)` equals `[18437909781, 18437909784, 18437909787]`; `.enabled` is `false`; `.maxChangesPerRun` is `500`.
  - `rejects a missing consent block`, `rejects a board with no pairs`, `rejects a non-positive maxChangesPerRun`, `rejects a non-boolean enabled`: each `expect(() => validateConfig(mutated)).toThrow(/consent/)`.
  In `config/split.test.ts`: `the two configs never share a consent board id` and `sandbox consent is enabled, production starts disabled`.
- [ ] **Step 2: Run** `npm test -- src/config.test.ts config/split.test.ts` — expect FAIL (no `consent`).
- [ ] **Step 3: Implement.** Types above; `consent(raw)` validator in `src/config.ts` (every `name` non-empty string, `boardId` number, `pairs` non-empty with non-empty string ids). Config blocks, names `People`, `People (Historical)`, `Affiliations`:
  - production: `18437909781` [`email_mm8nx6qg`→`color_mm8ntb35`, `email_mm8n2wzk`→`color_mm8nh158`]; `18437909784` [`email_mm8nfyfc`→`color_mm8ngfkm`, `email_mm8np26g`→`color_mm8nz8gk`]; `18437909787` [`email_mm8ndy69`→`color_mm8nb7dq`]; `enabled: false`.
  - sandbox: `18437342592` [`email_mm8h4kkb`→`color_mm8h9ee2`, `email_mm8hj3f8`→`color_mm8hkgaa`]; `18437342607` [`email_mm8h8jbh`→`color_mm8h4dfr`, `email_mm8hzsdg`→`color_mm8hmyx1`]; `18437342615` [`email_mm8h6cxh`→`color_mm8hz58t`]; `enabled: true`.
- [ ] **Step 4: Run** `npm test && npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(mailchimp-sync): consent column config`.

### Task 2: The planner

**Files:**
- Create: `src/consent/plan.ts`
- Test: `src/consent/plan.test.ts`

**Interfaces:**
- Consumes: `ConsentBoard` (Task 1) via `import type`.
- Produces:
  ```ts
  export type ConsentLabel = 'Subscribed' | 'Unsubscribed' | 'Cleaned' | 'Not in Mailchimp';
  export interface ConsentItem { itemId: string; values: Record<string, string> } // column id → text ('' when blank)
  export interface ConsentChange { boardId: number; boardName: string; itemId: string; consentColumn: string; from: string; to: ConsentLabel | '' }
  export interface ConsentWrite { boardId: number; itemId: string; columnValues: Record<string, ConsentLabel | ''> }
  export function normalizeAddress(text: string): string;            // trim + lowercase
  export function desiredLabel(status: string | undefined, current: string): ConsentLabel;
  export function planBoard(board: ConsentBoard, items: readonly ConsentItem[], statuses: ReadonlyMap<string, string>): ConsentChange[];
  export function isSendable(to: ConsentLabel | ''): boolean;
  export function applyGuard(changes: readonly ConsentChange[], max: number): { allowed: ConsentChange[]; held: ConsentChange[]; tripped: boolean };
  export function toWrites(changes: readonly ConsentChange[]): ConsentWrite[]; // one per (boardId, itemId)
  export function summarize(changes: readonly ConsentChange[]): Record<string, number>; // key `${boardName} ${consentColumn}: ${from||'(blank)'} → ${to||'(blank)'}`
  ```
  `statuses` keys are normalized addresses.

- [ ] **Step 1: Write failing tests:**
  - `desiredLabel maps each Mailchimp status`: subscribed→Subscribed, unsubscribed→Unsubscribed, cleaned→Cleaned, pending→Not in Mailchimp, transactional→Not in Mailchimp, undefined→Not in Mailchimp.
  - `archived keeps Cleaned, otherwise Unsubscribed`: `desiredLabel('archived','Cleaned')`→Cleaned; with `'Subscribed'`, `'Unsubscribed'`, `''`, `'Not in Mailchimp'` → Unsubscribed.
  - `planBoard returns only differences`: two pairs, an item already correct yields no change; one stale yields one `ConsentChange` with exact `from`/`to`.
  - `normalizes case and whitespace`: item address `'  Pat@Example.ORG '`, statuses `{ 'pat@example.org' → 'unsubscribed' }` → `to: 'Unsubscribed'`.
  - `clears consent for a blank address`: address `''`, consent `'Subscribed'` → `to: ''`; address `''`, consent `''` → no change.
  - `applyGuard always allows non-sendable changes`: 3 changes to Unsubscribed + 3 to Subscribed with `max: 2` → `allowed` has the 3 Unsubscribed, `held` the 3 Subscribed, `tripped: true`; with `max: 3` → all 6 allowed, `tripped: false`.
  - `toWrites groups an item's columns`: two changes on one item → one write with both `columnValues`.
  - `summarize counts by transition`.
- [ ] **Step 2: Run** `npm test -- src/consent/plan.test.ts` — FAIL.
- [ ] **Step 3: Implement** in `src/consent/plan.ts`. Guard counts only sendable changes against `max` (`tripped` when that count > `max`, and then every sendable change is held).
- [ ] **Step 4: Run** — PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(mailchimp-sync): plan consent column changes`.

### Task 3: Readers and writer

**Files:**
- Create: `src/consent/sources.ts`
- Test: `src/consent/sources.test.ts`

**Interfaces:**
- Consumes: `ConsentBoard` (Task 1), `ConsentItem`, `ConsentWrite` (Task 2), all `import type`.
- Produces:
  ```ts
  export class ConsentShortReadError extends Error {}
  export interface MailchimpListOptions { fetchFn: typeof fetch; apiBaseUrl: string; apiKey: string; audienceId: string; pageSize?: number } // default 1000
  export function readMailchimpStatuses(opts: MailchimpListOptions): Promise<Map<string, string>>; // normalized address → status
  export type GraphQLRequest = <T>(query: string, variables: Record<string, unknown>) => Promise<T>;
  export interface ConsentMonday {
    readBoard(board: ConsentBoard): Promise<ConsentItem[]>;
    writeConsent(writes: readonly ConsentWrite[]): Promise<{ written: number; failedItemIds: string[] }>;
  }
  export function createConsentMonday(request: GraphQLRequest): ConsentMonday;
  ```

- [ ] **Step 1: Write failing tests** (mock `fetchFn` / `request`):
  - `reads both passes, archived included`: default pass returns 2 members (one `Pat@Example.org` subscribed, one cleaned, `total_items: 2`), `status=archived` pass returns 1; map has 3 entries, keys lowercase; requested URLs contain `fields=total_items,members.email_address,members.status`, `count=1000`, and the second `status=archived`. Auth header `Basic` with the key.
  - `pages by offset until total_items`: `pageSize: 2`, total 3 → offsets 0 and 2 requested.
  - `throws ConsentShortReadError when a pass reads fewer than total_items`.
  - `throws on a non-2xx page` (message includes the HTTP status, not the key).
  - `readBoard pages items with only the configured columns`: first call is `boards(ids:…){ items_page(limit: 500 …) }`, cursor follow-up `next_items_page`; variables include every pair's two column ids; an email value is read from `... on EmailValue { email }`, falling back to `text`; null text becomes `''`.
  - `readBoard throws when a configured column is missing from the board`: an item whose `column_values` lacks a configured id → rejects with the column id in the message.
  - `writeConsent aliases up to 25 items per mutation`: 30 writes → 2 requests; each alias is `change_multiple_column_values(board_id, item_id, column_values: JSON string)`; values are labels as `{ "label": "<label>" }`, `''` for clear.
  - `writeConsent isolates a failed chunk item by item`: a chunk request rejects, then per-item retries succeed except one → `failedItemIds` is that one, `written` the rest.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** in `src/consent/sources.ts`. Mailchimp requests use `AbortSignal.timeout(20_000)`; pages run sequentially.
- [ ] **Step 4: Run** — PASS; typecheck.
- [ ] **Step 5: Commit** `feat(mailchimp-sync): read Mailchimp statuses and Monday consent columns`.

### Task 4: The hourly run, write switch, cron wiring

**Files:**
- Create: `src/consent/run.ts`, `src/consent/run.test.ts`
- Modify: `src/writeSwitch.ts` (+ `dryRunConsentMonday`), `src/index.ts` (`scheduled` dispatch), `src/index.test.ts`, `wrangler.jsonc` (crons both envs, `cpu_ms: 1000` both envs), `src/webhook/outboundRoute.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3; `runDisposition` (`src/flags.ts`), `recordingProxy` (`src/flags.ts`), `BatchSkipContext` (`src/writeSwitch.ts`), `sendAlert` (`src/alert.ts`), `MondayGraphQL`, `tokenProviderFor` (`src/monday/graphql.ts`).
- Produces:
  ```ts
  // run.ts
  export const CONSENT_CRON = '5 * * * *';
  export interface ConsentRunDeps { config: Config; monday: ConsentMonday; readStatuses: () => Promise<Map<string, string>>; alert: (text: string) => Promise<void> }
  export interface ConsentRunSummary { outcome: 'disabled' | 'skipped' | 'short-read' | 'done'; mode: WriteMode; items: Record<string, number>; transitions: Record<string, number>; held: number; written: number; failed: number }
  export function runConsentSync(gate: BatchSkipContext, deps: ConsentRunDeps): Promise<ConsentRunSummary>;
  // writeSwitch.ts
  export function dryRunConsentMonday(monday: ConsentMonday, ctx: SkipContext): ConsentMonday; // writeConsent → { written: 0, failedItemIds: [] }
  ```

- [ ] **Step 1: Write failing tests** in `src/consent/run.test.ts` (fake `monday`, `readStatuses`, `alert`):
  - `does nothing while consent is disabled`: `outcome: 'disabled'`, no reads.
  - `skips under hold and unknown`: `outcome: 'skipped'`, no reads.
  - `writes only differences under on` and the summary's `transitions` match `summarize`.
  - `dry-runs under off`: reads and plans, the real `writeConsent` never called, one `"writeSwitch":"skipped"` log line per chunk call.
  - `a short read writes nothing and alerts`: `readStatuses` rejects with `ConsentShortReadError` → `outcome: 'short-read'`, no `readBoard`, `alert` called once.
  - `a tripped cap writes opt-outs, holds the rest, and alerts`: `maxChangesPerRun: 1`, 2 to Subscribed + 1 to Cleaned → `writeConsent` receives only the Cleaned item, `held: 2`, `alert` called once; alert text has counts, no address.
  - `a board read failure fails that board only`: second board's `readBoard` rejects → other boards still written; summary logs the board as failed; the run doesn't throw.
  In `src/index.test.ts`: `scheduled dispatches on event.cron` — `CONSENT_CRON` invokes the consent run and not the Campaigns reconcile; `'0 15 * * *'` the reverse (spy via `vi.mock` of `./consent/run` and `./campaigns/scheduled`).
  In `src/webhook/outboundRoute.test.ts`: `skips a change to a consent column` — a `change_column_value` for `color_mm8ntb35` is acked without enqueueing.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** `runConsentSync` order: enabled → `runDisposition(gate.mode)` → `readStatuses` → each board `readBoard` + `planBoard` → `applyGuard(all, maxChangesPerRun)` → `toWrites(allowed)` → `writeConsent` (through `dryRunConsentMonday` under dry-run, `deliveryId: 'consent-cron'`) → one `console.log(JSON.stringify({ worker: 'mailchimp-sync', event: 'consent-run', environment, ...summary }))`. Alerts are prefixed `mailchimp-sync consent (<environment>):`. In `index.ts`, build the `ConsentMonday` from `new MondayGraphQL(config.monday.apiUrl, tokenProviderFor(env), { maxAttempts: 3, requestTimeoutMs: 20_000 })` and `readStatuses` from `readMailchimpStatuses({ fetchFn: fetch.bind(globalThis), … })`; catch and `console.error` any throw, as the Campaigns branch does. `wrangler.jsonc`: `"crons": ["0 15 * * *", "5 * * * *"]` and `"cpu_ms": 1000` at top level and in `env.sandbox`; update the two comments.
- [ ] **Step 4: Run** `npm test && npm run typecheck && node ../scripts/check-log-safety.mjs` — PASS.
- [ ] **Step 5: Commit** `feat(mailchimp-sync): hourly consent column sync`.

### Task 5: Operator plan script

**Files:**
- Create: `scripts/consent-plan.mjs`

**Interfaces:**
- Consumes: `readMailchimpStatuses`, `createConsentMonday` (Task 3); `planBoard`, `applyGuard`, `summarize` (Task 2); `MondayGraphQL` from `../src/monday/graphql.ts`.

- [ ] **Step 1: Implement** `node scripts/consent-plan.mjs --env sandbox|production` (required flag): reads `config/sandbox.json` or `config/svbc.json`, `MAILCHIMP_API_KEY` and `MONDAY_API_TOKEN` from the environment (exit 2 naming the missing one), runs the read and plan for every configured board regardless of `enabled`, prints items per board, `summarize()` output sorted by key, and what `applyGuard` would hold. Writes nothing; never prints an address. Imports use `.ts` extensions.
- [ ] **Step 2: Verify** `set -a; . ../../monday-migration/.env; set +a; node scripts/consent-plan.mjs --env production` (path from the worktree's location) prints transitions close to the spec's: ~30 Subscribed→Unsubscribed/Cleaned, ~60 Not in Mailchimp→Subscribed, ~50 blank fills, Affiliations 1, **zero** `Unsubscribed → Not in Mailchimp`, ~6,350 archived rows producing no change. Note the wall time.
- [ ] **Step 3: Commit** `feat(mailchimp-sync): read-only consent plan script`.

### Task 6: Column markers and docs

**Files:**
- Modify: `../scripts/mark-read-only-columns.mjs` (`PEOPLE.locked` += `'Personal Email Consent'`, `'Household Email Consent'`; `Affiliations.locked` += `'Work Email Consent'`), its test if one pins the lists
- Modify: `README.md` (new section "Consent columns": what, mapping table, archived rule, guard, alert, `enabled`, plan script, rollout; fix the stale "Not deployed to production" status; hourly cron in the Data flow list), `../README.md` status row, `../docs/uat/mailchimp-sync.md` (one tester step: unsubscribe a sandbox address, see its consent column change within the hour), `../docs/runbooks/migration-hold.md` (hourly consent run under each mode)

- [ ] **Step 1:** Edit; run `node --test ../scripts/*.test.mjs` and `node ../scripts/check-log-safety.mjs` — PASS.
- [ ] **Step 2: Commit** `docs(mailchimp-sync): consent columns`.

### Task 7: Sandbox rollout (operational)

- [ ] **Step 1:** `node ../scripts/check-monday-token-scope.mjs --workspace <sandbox workspace id>` with the Sandbox Integration's token; confirm the sandbox Affiliations board is reachable. If not, subscribe Sandbox Integration to it.
- [ ] **Step 2:** `node scripts/consent-plan.mjs --env sandbox`; record the counts.
- [ ] **Step 3:** `npm run deploy:sandbox`; `node ../scripts/flags.mjs status --env sandbox` shows `mailchimp-sync:writes on`.
- [ ] **Step 4:** After the next `:05`, read the `consent-run` line in Workers Logs (`npx wrangler tail svbc-mailchimp-sync-sandbox` or the dashboard): `outcome: 'done'`, `failed: 0`, its CPU time under 1,000 ms; rerun the plan script — zero transitions.
- [ ] **Step 5:** In the sandbox audience, unsubscribe one address that a sandbox People or Affiliations item holds; after the next `:05`, its consent column says Unsubscribed. Record the date and CPU time in the README.
- [ ] **Step 6:** `node ../scripts/mark-read-only-columns.mjs` against the sandbox workspace (`--apply`).
- [ ] **Step 7: Commit** README update; push the branch and open the MR. Production waits for David (spec, Rollout step 3).
