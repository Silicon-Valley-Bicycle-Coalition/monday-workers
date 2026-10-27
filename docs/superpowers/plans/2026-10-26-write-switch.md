# Write Switch (off / hold / on) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every in-scope Worker reads a per-Worker KV switch (`on` / `hold` / `off`) and gates every outbound write on it, and every queue consumer retries sink outages for about 4 days before dead-lettering.

**Architecture:** One canonical `flags.ts` (in `member-portal/src/`), copied byte-identical into each Worker. It turns the KV value into a *disposition* per message/cron run and supplies the shared retry delay, two proxies and a redacting skip-logger. In dry-run, a Worker runs its normal logic with **sinks wrapped in a recording proxy** (logs and returns placeholders) and **stores wrapped in a read-only proxy** (forwards reads, drops writes). Business logic is untouched, so a placeholder id can never be persisted. Routes stamp messages `dropped` when the switch is `off` at ingest. A dependency-free `scripts/flags.mjs` flips KV and pauses/resumes queues.

**Tech Stack:** Cloudflare Workers, TypeScript, Hono, D1, Queues, KV, Vitest with `@cloudflare/vitest-plugin`, and Node 22 `.mjs` scripts (no dependencies).

**Spec:** `docs/superpowers/specs/2026-10-26-write-switch-design.md`

## Global Constraints

- KV namespaces: `svbc-worker-flags` (production) and `svbc-worker-flags-sandbox` (sandbox), bound as `FLAGS` at the top level and in `env.sandbox` of every in-scope `wrangler.jsonc`.
- Keys: `<worker>:writes` takes `on` | `hold` | `off`; a missing key or any other value means `off`. `<worker>:log` set to `debug` turns on debug logging; anything else means normal. `<worker>` is the directory name.
- A KV read error is the mode `unknown`: never write; queue messages retry; crons skip and do not advance cursors.
- KV reads use `{ cacheTtl: 30 }`. Read once per request, per queue batch or per cron run, never once per isolate.
- Retry delay is `min(60 × 2^(attempts−1), 3600)` seconds, raised to any longer hint (Retry-After, midnight for a daily limit), with the hinted case capped at 43,200. Main-queue consumers get `max_retries: 100`. DLQ consumers are unchanged.
- Queue and DLQ retention is 14 days (`--message-retention-period-secs 1209600`), set operationally, not in `wrangler.jsonc`.
- The canonical Monday transport `monday-backup/src/monday/graphql.ts` is **not** edited.
- `flags.ts` must be strip-only TypeScript: no enums, namespaces or constructor parameter properties.
- Each Worker keeps the retryable/terminal error classification it has today. Only the delay and `max_retries` change.
- `node scripts/check-log-safety.mjs` stays green. Debug payloads mask names, emails, phones and postal-address fields, and free text logs its length only.
- Type-check with `npm run typecheck` in each Worker, never bare `tsc`. Run Worker tests with the sandbox disabled (workerd port bind).
- Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A message enqueued before this deploy** (no `writeStamp` field) must be treated as live and written under `on`. It must not be dropped. *(Task 3, plus one test per consumer Worker.)*
2. **A dry-run chained write** (funraise/eventbrite `matchDonor` creating People, then Donations) must persist **no** placeholder id. `matched_donor_item_id` must stay null. *(Tasks 3 and 4.)*
3. **funraise's `resolveRecurringGiftItem` swallows errors.** A dry-run Recurring Gifts write must still produce a skip line rather than vanish silently. *(Task 3.)*
4. **`hold → on` where the KV write succeeds but queue resume fails** must exit non-zero, and `status` must then report the mismatch. *(Task 2.)*
5. **Debug redaction of nested PII:** an email inside an array of objects, a phone under a mixed-case key, and a free-text `body` must all come out masked or as length only. *(Task 1.)*

## Deviations from the spec found during inventory (decided here; mention at hand-off)

- **bp-feedback-notify has no queue or D1.** It sends synchronously in the webhook. Under `off` it logs and returns 200. Under `hold`/`unknown` it returns **503** so Monday retries. Monday gives up after its own retry window, so a feedback request fired mid-migration may need re-triggering by hand.
- **benevity-import writes to Monday from its routes** (worklist items, labels, archive). Under `off` the routes run with proxies (seen rows recorded, messages stamped `dropped`). Under `hold`/`unknown` both benevity routes return **503** before any side effect.
- **benevity-import has no poller.** The spec's "benevity's daily job" is a D1 purge, which is unaffected.
- **monday-backup under `off`/`hold`/`unknown` skips the backup run** with a skip line, rather than dry-running a full streaming backup. The watchdog's Slack alerts are gated. Its D1 run records are operational.
- **member-portal letters:** under `off` the letter webhook and the letter cron create **no** `letter_sends` rows. A `queued` row that is never sent would otherwise block that donor's letter for good. Under `hold` both behave normally (the queue is paused).
- **`MondayApiError` has no retryable flag.** Classification stays per Worker, as the spec's own "keep the existing split" allows.
- **During the production load,** donation-rollups' Monday webhooks would hold one message per imported gift. Subscribe rollups' webhooks after the load (as today), or keep rollups `off` during it. Task 15's runbook says so.

---

### Task 1: Canonical `flags.ts` and its drift check

**Files:**
- Create: `member-portal/src/flags.ts`
- Test: `member-portal/src/flags.test.ts`
- Create: `scripts/check-worker-flags.mjs`
- Test: `scripts/check-worker-flags.test.mjs`
- Modify: `scripts/check-log-safety.mjs` (add `redactPayload` to `ALLOWED_WRAPPERS`)
- Modify: `.gitlab-ci.yml` (new job `worker-flags-copies`)

**Interfaces:**
- Produces (all exported from `flags.ts`):
  - `type WriteMode = 'on' | 'hold' | 'off' | 'unknown'`
  - `type LogLevel = 'debug' | 'normal'`
  - `interface FlagsBindings { FLAGS?: KVNamespace }`
  - `readWriteMode(env: FlagsBindings, worker: string): Promise<WriteMode>`: a missing binding or a thrown get → `'unknown'`; `null`/unrecognized → `'off'`.
  - `readLogLevel(env: FlagsBindings, worker: string): Promise<LogLevel>`: any error → `'normal'`.
  - `interface WriteStamp { writeStamp?: 'dropped' }`
  - `stampFor(mode: WriteMode): WriteStamp`: `'off'` → `{ writeStamp: 'dropped' }`; otherwise `{}`.
  - `type MessageDisposition = 'write' | 'dry-run' | 'retry'`
  - `messageDisposition(mode: WriteMode, body: WriteStamp): MessageDisposition`
  - `type RunDisposition = 'run' | 'dry-run' | 'skip'`
  - `runDisposition(mode: WriteMode): RunDisposition`
  - `retryDelaySeconds(attempts: number | undefined, hintSeconds?: number): number`
  - `interface SkipContext { worker: string; environment: string; mode: WriteMode; logLevel: LogLevel; deliveryId: string; piiKeys: readonly string[] }`
  - `logSkip(ctx: SkipContext, sink: string, operation: string, payload: unknown): void`
  - `logDebug(ctx: SkipContext, step: string, data?: unknown): void`
  - `redactPayload(value: unknown, piiKeys: readonly string[]): unknown`
  - `recordingProxy<T extends object>(target: T, sink: string, placeholders: { [K in keyof T]?: T[K] extends (...a: infer A) => infer R ? (...a: A) => Awaited<R> : never }, ctx: SkipContext): T`
  - `readOnlyProxy<T extends object>(target: T, writes: readonly (keyof T)[]): T`
  - `const DEFAULT_PII_KEYS: readonly string[]`, matched case-insensitively as substrings: `name`, `email`, `phone`, `address`, `street`, `city`, `zip`, `postal`.
  - `const FREE_TEXT_KEYS: readonly string[]`: `body`, `text`, `html`, `message`, `description`, `note`.

- [ ] **Step 1: Write the failing tests** in `member-portal/src/flags.test.ts`:

```ts
describe('readWriteMode', () => {
  it('maps KV values, fails closed', async () => {
    expect(await readWriteMode(kv({ 'x:writes': 'on' }), 'x')).toBe('on');
    expect(await readWriteMode(kv({ 'x:writes': 'hold' }), 'x')).toBe('hold');
    expect(await readWriteMode(kv({ 'x:writes': 'ON' }), 'x')).toBe('off');
    expect(await readWriteMode(kv({}), 'x')).toBe('off');
    expect(await readWriteMode({}, 'x')).toBe('unknown');
    expect(await readWriteMode(throwingKv(), 'x')).toBe('unknown');
  });
  it('reads with cacheTtl 30', async () => { /* spy on get → called with ('x:writes', { cacheTtl: 30 }) */ });
});
describe('messageDisposition', () => {
  it.each([
    ['on', {}, 'write'], ['on', { writeStamp: 'dropped' }, 'dry-run'],
    ['off', {}, 'dry-run'], ['hold', {}, 'retry'], ['unknown', {}, 'retry'],
    ['hold', { writeStamp: 'dropped' }, 'dry-run'],
  ])('%s + %o → %s', (mode, body, want) => expect(messageDisposition(mode, body)).toBe(want));
});
it('runDisposition', () => {
  expect(runDisposition('on')).toBe('run'); expect(runDisposition('off')).toBe('dry-run');
  expect(runDisposition('hold')).toBe('skip'); expect(runDisposition('unknown')).toBe('skip');
});
it('retryDelaySeconds', () => {
  expect([1, 2, 3, 7, 8, 100].map((n) => retryDelaySeconds(n))).toEqual([60, 120, 240, 3600, 3600, 3600]);
  expect(retryDelaySeconds(undefined)).toBe(60);
  expect(retryDelaySeconds(1, 7200)).toBe(7200);
  expect(retryDelaySeconds(1, 99_999)).toBe(43_200);
});
it('stampFor', () => { expect(stampFor('off')).toEqual({ writeStamp: 'dropped' }); expect(stampFor('hold')).toEqual({}); });
describe('redactPayload', () => {
  it('masks PII keys at any depth and free text by length', () => {
    expect(redactPayload({ itemId: 5, amount: 25, donor: [{ Email: 'a@b.org', PhoneNumber: '555' }], body: 'hello' }, DEFAULT_PII_KEYS))
      .toEqual({ itemId: 5, amount: 25, donor: [{ Email: '<masked:7>', PhoneNumber: '<masked:3>' }], body: '<text:5>' });
  });
  it('masks address-shaped strings under non-PII keys', () => {
    expect(redactPayload({ column_values: '{"x":"a@b.org"}' }, DEFAULT_PII_KEYS)).toEqual({ column_values: '{"x":"<email>"}' });
  });
});
describe('recordingProxy', () => {
  it('logs and returns the placeholder for listed methods, passes the rest through', async () => { /* createItem → {id:'dry-run-1'}, no call on target; findItem passes through */ });
  it('numbers placeholders per proxy: dry-run-1, dry-run-2', async () => {});
});
it('readOnlyProxy drops listed writes (resolves undefined), forwards reads', async () => {});
it('logSkip prints one JSON line with worker/environment/mode/deliveryId/sink/operation and a redacted payload', () => {});
it('logDebug is silent unless logLevel is debug', () => {});
```

- [ ] **Step 2: Run** `cd member-portal && npm test -- src/flags.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement `member-portal/src/flags.ts`** to the interfaces above. `messageDisposition`: a `dropped` stamp → `'dry-run'`; otherwise `on` → `write`, `off` → `dry-run`, `hold`/`unknown` → `retry`. `redactPayload` replaces masked strings with `<masked:LEN>`, free text with `<text:LEN>`, and runs every other string through the same email regex member-portal's `redactEmails` uses, emitting `<email>`. `logSkip` writes `console.log(JSON.stringify({ writeSwitch: 'skipped', ... }))`. Its payload goes through `redactPayload` with `ctx.piiKeys` only at debug level; at normal level it logs only the method name and argument count. The file opens with a comment naming it the canonical copy and saying "edit here, then copy".

- [ ] **Step 4: Run** `cd member-portal && npm test -- src/flags.test.ts && npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Write `scripts/check-worker-flags.test.mjs`** (Node test runner): `findDrift(canonical, copies)` returns a list of differing paths; `flagsIds(wranglerText)` returns `{ production, sandbox }` ids from a JSONC string; `checkIds(list)` reports any Worker whose ids differ from the first.

- [ ] **Step 6: Implement `scripts/check-worker-flags.mjs`.**
  - Export `IN_SCOPE`: benevity-import, bp-feedback-notify, donation-rollups, email-log, eventbrite-sync, funraise-sync, mailchimp-sync, member-portal, monday-backup, people-reclassification, quickbooks-sync.
  - Run as a script, it cmp's each `<w>/src/flags.ts` against `member-portal/src/flags.ts` and compares the `FLAGS` ids in every `<w>/wrangler.jsonc`.
  - A Worker that doesn't yet have the file or binding is reported as "pending", not as a failure, until a `--strict` flag is passed.
  - Exit 1 on any drift.

- [ ] **Step 7: Add the CI job `worker-flags-copies`** (stage test; rules: changes to `*/src/flags.ts`, `*/wrangler.jsonc`, `scripts/check-worker-flags.mjs`, `.gitlab-ci.yml`). It runs `node scripts/check-worker-flags.mjs --strict` and `node --input-type=module -e "await import('./member-portal/src/flags.ts')"`. Then add `'redactPayload'` to `ALLOWED_WRAPPERS` in `scripts/check-log-safety.mjs`.

- [ ] **Step 8: Run** `node --test scripts/*.test.mjs && node scripts/check-log-safety.mjs`. Expected: PASS.

- [ ] **Step 9: Commit** `feat(flags): canonical write-switch module and drift check`.

### Task 2: KV namespaces and the operator CLI

**Files:**
- Create: `scripts/flags.mjs`
- Test: `scripts/flags.test.mjs`
- Modify: `member-portal/wrangler.jsonc` (add `kv_namespaces: [{ binding: "FLAGS", id: … }]` at the top level and in `env.sandbox`); this is the single source `flags.mjs` reads ids from

**Interfaces:**
- Consumes: `IN_SCOPE` from `scripts/check-worker-flags.mjs`.
- Produces:
  - CLI `node scripts/flags.mjs <worker|all> writes <on|hold|off> --env <production|sandbox>`
  - `node scripts/flags.mjs <worker> log <debug|normal> --env …`
  - `node scripts/flags.mjs status --env …`
  - `node scripts/flags.mjs retention --env …`
  - Exported pure functions `queuesFor(worker, env): string[]` (main queues only), `dlqsFor(worker, env): string[]`, and `planWrites(worker, mode, env): Step[]`, where `Step = { kind: 'kv-put' | 'pause' | 'resume', target: string, value?: string }`.

- [ ] **Step 1: Create the namespaces** (an operator action against the live account; confirm with the user before running): `npx wrangler kv namespace create svbc-worker-flags` and `npx wrangler kv namespace create svbc-worker-flags-sandbox`. Write both ids into `member-portal/wrangler.jsonc`.

- [ ] **Step 2: Write the failing tests** in `scripts/flags.test.mjs`:

```js
test('queuesFor maps the production and sandbox queue names', () => {
  assert.deepEqual(queuesFor('mailchimp-sync', 'production'), ['mailchimp-sync-outbound', 'mailchimp-sync-inbound']);
  assert.deepEqual(queuesFor('funraise-sync', 'sandbox'), ['funraise-sync-writes-sandbox']);
  assert.deepEqual(dlqsFor('funraise-sync', 'sandbox'), ['funraise-sync-writes-sandbox-dlq']);
  assert.deepEqual(queuesFor('bp-feedback-notify', 'production'), []);
});
test('planWrites orders KV before pause and before resume', () => {
  assert.deepEqual(planWrites('funraise-sync', 'hold', 'production').map((s) => s.kind), ['kv-put', 'pause']);
  assert.deepEqual(planWrites('funraise-sync', 'on', 'production').map((s) => s.kind), ['kv-put', 'resume']);
  assert.deepEqual(planWrites('funraise-sync', 'off', 'production').map((s) => s.kind), ['kv-put', 'resume']);
});
test('rejects a missing --env, an unknown worker and an unknown mode', () => { /* parseArgs throws with a usage message */ });
test('a failed step after a successful kv-put exits non-zero and names the mismatch', () => { /* inject a runner that fails on pause */ });
```

- [ ] **Step 3: Implement `scripts/flags.mjs`** with the queue map below. Sandbox names insert `-sandbox` before any `-dlq`. The runner shells out to `npx wrangler kv key put --namespace-id <id> --remote <key> <value>`, `kv key get`, and `npx wrangler queues pause-delivery|resume-delivery|info|update`. The runner is injectable for tests. `status` prints one row per Worker: mode, log level, and paused/backlog per queue. A row is marked `MISMATCH` when the mode is `on`/`off` while a queue is paused, or `hold` while a queue is delivering. `retention` runs `wrangler queues update <q> --message-retention-period-secs 1209600` for every main queue and DLQ.

| Worker | Main queues (production) |
|---|---|
| benevity-import | `benevity-import-writes` |
| donation-rollups | `donation-rollups-recompute` |
| email-log | `email-log-writes` |
| eventbrite-sync | `eventbrite-sync-writes` |
| funraise-sync | `funraise-sync-writes` |
| mailchimp-sync | `mailchimp-sync-outbound`, `mailchimp-sync-inbound` |
| member-portal | `member-portal-change-requests`, `member-portal-letter-emails` |
| quickbooks-sync | `quickbooks-sync-writes` |
| bp-feedback-notify, monday-backup, people-reclassification | none |

- [ ] **Step 4: Run** `node --test scripts/flags.test.mjs`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(scripts): flags.mjs operator CLI for the write switch`.

### Task 3: funraise-sync

**Files:**
- Create: `funraise-sync/src/flags.ts` (copy of canonical)
- Modify: `funraise-sync/wrangler.jsonc` (FLAGS in both envs; main consumer `max_retries: 100`)
- Modify: `funraise-sync/test/env.d.ts`, `funraise-sync/config/split.test.ts` (FLAGS ids differ between envs)
- Modify: `funraise-sync/src/webhook/route.ts` (stamp at enqueue)
- Modify: `funraise-sync/src/consumer/processBatch.ts` (disposition, proxies, shared retry delay; remove the local `retryDelaySeconds`)
- Modify: `funraise-sync/src/scheduled.ts`, `funraise-sync/src/index.ts`
- Test: `funraise-sync/src/consumer/processBatch.test.ts`, `funraise-sync/src/scheduled.test.ts`, `funraise-sync/src/webhook/route.test.ts` (or the existing route test file)
- Modify: `funraise-sync/README.md` (Deploy section: the switch)

**Interfaces:**
- Consumes: everything from Task 1.
- Produces: `const WORKER = 'funraise-sync'` in `src/index.ts`; `FunraiseQueueMessage` becomes `{ entityType; entityId } & WriteStamp`.

Per-Worker classification:
- **Sinks to record:** `MondayClient.createItem` → placeholder `'dry-run-N'` id in the client's return shape; `MondayClient.changeColumnValues` → `undefined`.
- **Store writes dropped in dry-run (consumer and poller):** every `EventStore`/`SubscriptionStore` mutator (`updateStatusByEntity`, `upsert`, `claimCreate`, `releaseCreate`), **except** `setCursor` under `off` in the poller.

- [ ] **Step 1: Write the failing tests:**
  - **route:** with KV `off` → the sent message has `writeStamp: 'dropped'` and the event row is still upserted; with KV `on` → no stamp.
  - **consumer:**
    - `off` → the Donations `createItem` is not called on the real client, every store mutator call count is 0, `ack` is called, and a `writeSwitch: 'skipped'` line is logged.
    - **Review Focus 2:** in `off` with no donor match, the People create is recorded, `matched_donor_item_id` is never written, and the Donations write is recorded with the placeholder link.
    - **Review Focus 3:** in `off`, the recurring path logs a skip for `Recurring Gifts`.
    - `on` + `dropped` → same as `off`.
    - `hold` → `retry({ delaySeconds: 60 })` on attempt 1, with no process call.
    - **Review Focus 1:** `on` + an unstamped legacy body → writes.
    - A retryable Monday failure on attempt 8 → `retry({ delaySeconds: 3600 })`.
  - **scheduled:**
    - `hold` → `pollSubscriptions` not called and the cursor unchanged.
    - `unknown` → same.
    - `off` → the poll runs with recording sinks, the cursor **advances**, and no subscription row is written.
    - `on` → as today.

- [ ] **Step 2: Run** `cd funraise-sync && npm test`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement.** The route reads the mode once per request and spreads `stampFor(mode)` into the message. `queue()` reads mode and log level once per batch. For each message, `messageDisposition` selects real deps (`write`), proxied deps (`dry-run`, then ack), or `retry({ delaySeconds: retryDelaySeconds(message.attempts) })`. Existing error handling stays as it is, using the shared `retryDelaySeconds`. `dispatchScheduled` takes `runDisposition`; under `dry-run` it passes proxied deps whose store forwards `setCursor`. The purge cron is unaffected (operational).

- [ ] **Step 4: Run** `npm test && npm run typecheck && node ../scripts/check-worker-flags.mjs`. Expected: PASS, with funraise-sync not drifting.

- [ ] **Step 5: Commit** `feat(funraise-sync): write switch and 4-day outage retry`.

### Task 4: eventbrite-sync

Same shape as Task 3. **Files:** `src/flags.ts` (copy), `wrangler.jsonc`, `test/env.d.ts`, `config/split.test.ts`, `src/webhook/route.ts`, `src/consumer/processBatch.ts`, `src/index.ts`, tests beside each, `README.md`. There is no cron.

- **Sinks to record:** `createItem` (placeholder id) and `changeColumnValues` on the Monday client. The Eventbrite client is read-only and passes through.
- **Store writes dropped:** `OrderStore.updateStatus`, `recordDelivery` (the consumer never calls it, but list it anyway).
- `OrderQueueMessage` becomes `{ orderId; action } & WriteStamp`.
- The missing-token check stays ahead of the disposition.

- [ ] **Step 1: Tests:**
  - route stamps under `off`;
  - consumer: `off` → no real Monday call, zero store writes, ack;
  - `matchDonor` People create recorded with `matched_donor_item_id` never written (Review Focus 2);
  - `hold` → retry at 60 s;
  - an unstamped legacy message under `on` writes;
  - attempt 8 retry delay is 3600.
- [ ] **Step 2:** Run `cd eventbrite-sync && npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement as in Task 3. `WORKER = 'eventbrite-sync'`, `max_retries: 100`.
- [ ] **Step 4:** Run `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(eventbrite-sync): write switch and 4-day outage retry`.

### Task 5: quickbooks-sync

**Files:** `src/flags.ts` (copy), `wrangler.jsonc`, `test/env.d.ts`, `config/split.test.ts`, `src/quickbooks/webhook/route.ts`, `src/monday/webhook/route.ts`, `src/consumer/processBatch.ts`, `src/types.ts` (`QueueMessage & WriteStamp`), `src/index.ts`, tests, `README.md`.

- **Sinks to record:** Monday `createItem` (placeholder id), Monday `changeColumnValues`, QuickBooks `createCustomer` (placeholder `{ Id: 'dry-run-N' }` in the client's return shape). `getEntity` passes through, which leaves token refresh (operational) live.
- **Store writes dropped:**
  - `QbEventStore.updateStatus`
  - `MondayEventStore.updateStatus`, `markCreateSent`, `bumpCreateAttempt`
  - `MapStore.createMapping`, `repointMapping`
- **Not proxied:** `D1TokenStore` (operational).
- The `TerminalError` → ack path is unchanged.

- [ ] **Step 1: Tests:**
  - both routes stamp under `off`;
  - consumer `off` for each direction → zero real sink calls, zero store writes (including `markCreateSent`), ack;
  - `hold` → retry at 60 s;
  - a `TerminalError` under `on` still acks;
  - an unstamped legacy message under `on` writes;
  - attempt 8 delay is 3600.
- [ ] **Step 2:** Run `cd quickbooks-sync && npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement. `WORKER = 'quickbooks-sync'`, `max_retries: 100`.
- [ ] **Step 4:** Run `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(quickbooks-sync): write switch and 4-day outage retry`.

### Task 6: benevity-import

**Files:** `src/flags.ts` (copy), `wrangler.jsonc`, `test/env.d.ts`, `config/split.test.ts`, `src/webhook/route.ts`, `src/consumer/processBatch.ts` (`BenevityQueueMessage & WriteStamp`), `src/index.ts`, `src/util/sendBatch.ts` (carry the stamp), tests, `README.md`.

- **Routes** (`/webhooks/monday/benevity-upload`, `/webhooks/monday/benevity-retry`):
  - The challenge echo always works.
  - `hold`/`unknown` → `503` before any store or Monday call.
  - `off` → the upload route runs with a recording Monday proxy (`createItem`, `changeColumnValues`, `archiveItem`) and a store proxy that drops only `disbursements.claimWorklistItemId`. Seen rows (uploads, disbursements, rows) are recorded, and messages are stamped `dropped`.
  - `off` on the retry route → log a skip and return 200, doing nothing.
- **Consumer:**
  - Sinks to record: the same three Monday methods.
  - Store writes dropped: `RowStore.updateStatus`, `requeueRow`, `requeueDisbursementRows`, and `DisbursementStore.claimWorklistItemId`.

- [ ] **Step 1: Tests:**
  - upload route `hold` → 503 and no `createUpload` call;
  - upload route `off` → rows upserted, messages stamped, the worklist `createItem` recorded rather than called;
  - retry route `off` → 200 with no requeue;
  - consumer `off` → no real Monday call, zero row-status writes;
  - `hold` → retry at 60 s;
  - an unstamped legacy message under `on` writes;
  - attempt 8 delay is 3600.
- [ ] **Step 2:** Run `cd benevity-import && npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement. `WORKER = 'benevity-import'`, `max_retries: 100`.
- [ ] **Step 4:** Run `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(benevity-import): write switch and 4-day outage retry`.

### Task 7: donation-rollups

**Files:** `src/flags.ts` (copy), `wrangler.jsonc`, `test/env.d.ts`, `config/split.test.ts`, `src/webhook/route.ts`, `src/types.ts` (`RecomputeQueueMessage & WriteStamp`), `src/consumer/processBatch.ts`, `src/custodian/custodian.ts` (`runDuty` and `scheduled` gating), `src/custodian/routes.ts`, `src/index.ts`, tests, `README.md`.

- **Sinks to record:**
  - Monday `changeColumnValues`, `setItemDescription`, `createItem` (placeholder id), `archiveItem`, `createUpdate`.
  - The internal `RECOMPUTE_QUEUE.send`/`sendBatch` calls from the consumer and custodian. In dry-run, wrap the queue binding with a recording proxy so fan-out isn't enqueued.
- **Store writes dropped in dry-run:** every mutator on the pending, links, gifts, recomputes, affiliations, volunteer and annual-summary stores, plus `gifts.recordRun`. The derived projections are not refreshed by a dry run either; the next live run refreshes them.
- **Custodian:**
  - `scheduled()` and `POST /custodian/run/:duty` take `runDisposition`.
  - `skip` → HTTP 409 `{ ok:false, mode }` on the route, and a log-only skip in the cron.
  - `dry-run` → proxied deps.
- **Retry:** the consumer keeps `NonRetryableError`, the D1-quota midnight and the `MondayRateLimitError` paths, but passes their delay as the `hintSeconds` argument of the shared `retryDelaySeconds`. Remove the local transient delay function.

- [ ] **Step 1: Tests:**
  - route stamps under `off`;
  - consumer `off` → no Monday call, no store mutator call, no `RECOMPUTE_QUEUE.send`, ack;
  - `hold` → retry at 60 s;
  - a D1 quota error under `on` → retry with the midnight hint (> 3600 allowed);
  - an unstamped legacy message under `on` writes;
  - custodian cron `hold` → no duty runs;
  - custodian `off` → duty runs with recording sinks and `recordRun` is not called;
  - route `/custodian/run/sweep` under `hold` → 409.
- [ ] **Step 2:** Run `cd donation-rollups && npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement. `WORKER = 'donation-rollups'`, `max_retries: 100` on `donation-rollups-recompute` only.
- [ ] **Step 4:** Run `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(donation-rollups): write switch and 4-day outage retry`.

### Task 8: mailchimp-sync

**Files:** `src/flags.ts` (copy), `wrangler.jsonc`, `test/env.d.ts`, `config/split.test.ts`, `src/webhook/outboundRoute.ts`, `src/webhook/inboundRoute.ts`, `src/types.ts` (both messages `& WriteStamp`), `src/consumer/outbound.ts`, `src/consumer/inbound.ts`, `src/consumer/backoff.ts` (delegate the base delay to the shared `retryDelaySeconds`, keeping `rateLimitHintSeconds` as the hint), `src/campaigns/reconcile.ts`, `src/index.ts`, tests, `README.md`.

- **Sinks to record:**
  - Mailchimp `updateMember`, `unsubscribeMember`.
  - Monday `setConnectColumn`, `createCampaignItem` (placeholder id), `renameItem`, `archiveItem`.
  - The DLQ alert `sendAlert` is **not** gated, because DLQs stay live.
- **Store writes dropped:** both pending stores' `updateStatus`/`upsertPending` when called from consumers, `dnsLog.record`, `campaignItemsStore.claim`/`upsert`/`markArchived`.
- `PII keys += ['email']` (already in the defaults). Inbound message bodies carry an email: the skip line's `deliveryId` uses `memberId(email)`, never the address.
- The reconcile cron and the inline reconcile from `inbound.ts` take the same disposition as their caller.

- [ ] **Step 1: Tests:**
  - both routes stamp under `off`;
  - outbound `off` → no Mailchimp call, no `dnsLog.record`, ack;
  - inbound `off` → the skip line contains `<member ` and no `@`;
  - `hold` → retry at 60 s;
  - `MailchimpPermanentError` under `on` still acks;
  - a 429 with Retry-After 7200 → delay 7200;
  - cron `hold` → reconcile not called;
  - an unstamped legacy message under `on` writes.
- [ ] **Step 2:** Run `cd mailchimp-sync && npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement. `WORKER = 'mailchimp-sync'`, `max_retries: 100` on both main queues.
- [ ] **Step 4:** Run `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mailchimp-sync): write switch and 4-day outage retry`.

### Task 9: email-log

**Files:** `src/flags.ts` (copy), `wrangler.jsonc`, `test/env.d.ts`, `config/split.test.ts`, `src/inbound/handleEmail.ts` (stamp at `queue.send`), `src/inbound/extract.ts` (`LogQueueMessage & WriteStamp`), `src/consumer/processBatch.ts`, `src/index.ts`, tests, `README.md`.

- **Sinks to record:** Monday `createItem` (placeholder id), covering both the Activity item and IT Requests `raiseAlert`; `ReplySender.sendUnmatched`, `sendNoAddress`, `sendNotLogged`.
- **Store writes dropped:** `markLogged`, `recordError`, `recordAlert`. `claim` happens in `handleEmail` and stays live, because it is the seen row.
- `setReject` is operational and stays live.
- `FREE_TEXT_KEYS` already covers `body`. Add `subject` to this Worker's `piiKeys`.

- [ ] **Step 1: Tests:**
  - `handleEmail` under `off` claims and sends a stamped message;
  - consumer `off` → no `createItem`, no reply sent, no `markLogged`, ack;
  - the skip line logs `body` and `subject` as lengths only;
  - `hold` → retry at 60 s;
  - an unstamped legacy message under `on` writes;
  - attempt 8 delay is 3600.
- [ ] **Step 2:** Run `cd email-log && npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement. `WORKER = 'email-log'`, `max_retries: 100` on `email-log-writes`.
- [ ] **Step 4:** Run `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(email-log): write switch and 4-day outage retry`.

### Task 10: member-portal

**Files:** `wrangler.jsonc` (FLAGS was already added in Task 2; set `max_retries: 100` on both main consumers), `test/env.d.ts`, `config/split.test.ts`, `src/routes.ts`, `src/views.ts` (an "unavailable" view in every locale in `src/i18n`), `src/changeRequests/processBatch.ts`, `src/letters/processLetterSendBatch.ts`, `src/letters/triggerLetterSend.ts`, `src/letters/runLetterCron.ts`, `src/queueRetry.ts` (re-export the shared `retryDelaySeconds` and delete the local one), `src/index.ts`, tests, `README.md`.

- **Routes under `off`/`hold`/`unknown`:**
  - `POST /` (login request), both change-request POSTs and card regenerate render the unavailable page with HTTP **503**.
  - Every GET still works.
  - `POST /auth/callback` and `POST /logout` stay live (operational).
- **Letters webhook:**
  - `off` → log a skip and return 200, creating no `letter_sends` row.
  - `hold` → normal (row + enqueue; the queue is paused).
  - `unknown` → 503.
- **Letter cron:** `runDisposition`, where `dry-run` and `skip` both mean "don't run" (it only enqueues). The purge steps stay live (operational).
- **Consumers:**
  - Sinks to record: `createChangeRequestItem` (placeholder id), `sendLetterReadyEmail`, `sendLoginEmail`.
  - Store writes dropped: `markWritten`, `claimForSending`, `releaseClaim`, `markSent`, `markSkipped`. `tokenStore.createToken` is skipped in dry-run so no live magic link is minted for an unsent email.
- Messages `& WriteStamp`. Both enqueue sites stamp.

- [ ] **Step 1: Tests:**
  - `POST /` under `hold` → 503 with the unavailable page, and `sendLoginEmail` not called;
  - a GET portal page under `off` still renders;
  - letters webhook `off` → 200 and `createQueued` not called;
  - letters webhook `hold` → row created and enqueued;
  - letter cron under `off` → `triggerLetterSend` not called;
  - change-request consumer `off` → no `createChangeRequestItem`, no `markWritten`, ack;
  - letter consumer `off` → no email, no token minted, ack;
  - `hold` → retry at 60 s;
  - an unstamped legacy message under `on` writes.
- [ ] **Step 2:** Run `cd member-portal && npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement. `WORKER = 'member-portal'`.
- [ ] **Step 4:** Run `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(member-portal): write switch, unavailable page, 4-day outage retry`.

### Task 11: bp-feedback-notify

**Files:** `src/flags.ts` (copy), `wrangler.jsonc`, `config/split.test.ts`, `src/index.ts`, `src/index.test.ts`, `README.md`.

- The challenge echo is always live.
- `off` → log a skip (the payload goes through `redactPayload`; `organizerEmail` is masked) and return 200, with no send and no `writeSendStatus`.
- `hold`/`unknown` → 503, with no send.
- `on` → as today.
- The vitest config is plain Node. Tests pass a fake `FLAGS` with `get: vi.fn()`.

- [ ] **Step 1: Tests:**
  - `off` → 200, `EMAIL.send` not called, `writeSendStatus` not called, and the log has no `@`;
  - `hold` → 503 with no send;
  - a missing `FLAGS` binding → 503;
  - `on` → sends as today.
- [ ] **Step 2:** Run `cd bp-feedback-notify && npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement. `WORKER = 'bp-feedback-notify'`.
- [ ] **Step 4:** Run `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(bp-feedback-notify): write switch`.

### Task 12: monday-backup

**Files:** `src/flags.ts` (copy), `wrangler.jsonc`, `src/env.ts`, `test/env.d.ts`, `config/split.test.ts` (if present; otherwise add a FLAGS-split assertion to `src/index.test.ts`), `src/index.ts`, `src/watchdog.ts`, tests, `README.md`.

- Backup cron: `runDisposition('run')` → as today. Anything else → one skip line and return, with no D1 run row, so the watchdog does not count it as a failure.
- Watchdog: always computes, but its `sendFailureAlert` calls go through a recording proxy unless the mode is `on`.

- [ ] **Step 1: Tests:**
  - backup cron `hold` → `runBackup` not called;
  - `off` → not called and a skip line is logged;
  - watchdog `off` with a stale snapshot → no Slack fetch and a skip line is logged;
  - `on` → as today.
- [ ] **Step 2:** Run `cd monday-backup && npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement. `WORKER = 'monday-backup'`.
- [ ] **Step 4:** Run `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(monday-backup): write switch`.

### Task 13: people-reclassification (replace DRY_RUN)

**Files:** `src/flags.ts` (copy), delete `src/dryRun.ts` and `src/dryRun.test.ts`, `wrangler.jsonc` (remove `DRY_RUN` from both `vars` blocks; add FLAGS), `config/split.test.ts` (vars now `{ENVIRONMENT:'sandbox'}` and none), `src/types.ts`, `test/env.d.ts`, `src/index.ts`, `src/routes.ts`, `src/routes.test.ts`, `README.md` (rewrite the sandbox rollout steps around `flags.mjs`); then switch `.gitlab-ci.yml`'s `worker-flags-copies` job to `--strict`.

- Cron: `run` → `dryRun: false`; `dry-run` → `dryRun: true`; `skip` → no pass.
- `POST /reclassify/run`:
  - no `?dryRun` → the mode decides (`skip` → 409);
  - `?dryRun=true` → a forced dry pass in any mode except `unknown`;
  - `?dryRun=false` → **400** `"dryRun=false is no longer accepted; use scripts/flags.mjs"`.
- `/reclassify/status` reports `mode` in place of `dryRunDefault`.
- `RoutesDeps.defaultDryRun` is replaced by `mode(): Promise<WriteMode>`.
- The pass, ledger and `dry_run` column are unchanged.

- [ ] **Step 1: Tests:**
  - routes: `?dryRun=false` → 400; mode `on` with no param → `runPass` with `dryRun:false`; mode `off` → `dryRun:true`; mode `hold` → 409; `?dryRun=true` with mode `on` → `dryRun:true`; status returns `mode`;
  - cron `hold` → `runPass` not called;
  - split test: `DRY_RUN` absent from both envs.
- [ ] **Step 2:** Run `cd people-reclassification && npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement. `WORKER = 'people-reclassification'`. Remove every `isDryRun` import.
- [ ] **Step 4:** Run `npm test && npm run typecheck && node ../scripts/check-worker-flags.mjs --strict`. Expected: PASS for all 11 Workers.
- [ ] **Step 5:** Commit `feat(people-reclassification): replace DRY_RUN with the write switch`.

### Task 14: Documentation

**Files:**
- Modify: `README.md` (new section "Write switch: off / hold / on", covering modes, keys, `flags.mjs` usage, outage retry, the "set `on` before deploying" rule)
- Modify: `CLAUDE.md` (Architecture: the cursor-invariant exception under `off`; outage retry; the `flags.ts` copy rule, alongside graphql.ts's)
- Modify: `docs/systems-map.html` (add the mode to the state table; bump the "as of" date)
- Create: `docs/runbooks/migration-hold.md`

- [ ] **Step 1: Write the runbook.** Contents:
  - before the load: turn off the Salesforce integrations (Funraise → Salesforce pause control), `flags.mjs retention --env production`, `flags.mjs all writes hold --env production`, `flags.mjs status`;
  - keep donation-rollups `off`, or its webhooks unsubscribed, during the load;
  - after `validate`: `flags.mjs all writes on`, then watch backlog depth in `status` until every queue reads 0.
- [ ] **Step 2:** Run `node scripts/check-log-safety.mjs`. Expected: PASS. Spot-read every changed doc for stale `DRY_RUN` mentions with `grep -rn DRY_RUN --include=*.md .`; only historical mentions may remain.
- [ ] **Step 3:** Commit `docs: write switch, outage retry and migration hold runbook`.

### Task 15: Sandbox rollout and hold rehearsal (operator; confirm each live step with the user)

- [ ] **Step 1:** Run `node scripts/flags.mjs retention --env sandbox`. Expected: every sandbox queue and DLQ reports a 1209600 s retention.
- [ ] **Step 2:** For each Worker currently writing in the sandbox (funraise-sync, donation-rollups, benevity-import, bp-feedback-notify, member-portal, mailchimp-sync, quickbooks-sync, monday-backup, eventbrite-sync): `node scripts/flags.mjs <w> writes on --env sandbox` **before** deploying. Then `npm run deploy:sandbox` in each, with the sandbox disabled for wrangler.
- [ ] **Step 3:** Rehearse with funraise-sync:
  1. `writes hold`.
  2. Fire the Funraise Test-button delivery.
  3. `status` shows backlog ≥ 1 and paused.
  4. `writes on`.
  5. Confirm the Donations item lands and the backlog reads 0.
  6. `writes off`, fire again, and confirm a `writeSwitch: 'skipped'` line and no item.
  7. `writes on`.
  8. Remove the test items, as in the README's earlier proofs.
- [ ] **Step 4:** Record the rehearsal in `funraise-sync/README.md` and in the root status table. Commit `docs: sandbox write-switch rehearsal`.
