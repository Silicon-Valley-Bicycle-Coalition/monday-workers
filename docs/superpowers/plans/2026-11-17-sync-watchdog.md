# Sync Failure Alerting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tell DWK in the private staff Slack channel when a production sync Worker errors, stops running its crons, is left off its expected write switch, or has a queue backlog that isn't draining.

**Architecture:** Errors go through Workers Issues automations configured in the dashboard (Tasks 7–8). Silence is caught by a new `sync-watchdog` Worker (Tasks 1–6). It runs one hourly cron, reads Cloudflare's GraphQL Analytics, Queues API and the production `FLAGS` KV, keeps per-subject state in its own KV, and posts to Slack only on a change of state.

**Tech Stack:** TypeScript Worker, Wrangler ≥ 4.145, Vitest + `@cloudflare/vitest-plugin`, Workers KV. Same `package.json`/`tsconfig.json`/`vitest.config.ts` shape as `contact-roles`.

**Spec:** `docs/superpowers/specs/2026-11-17-sync-failure-alerting-design.md`

## Global Constraints

- Production Workers only alert. Sandbox never posts to the staff channel.
- Alert on state change: post when a subject goes bad, at most once per 24 h while it stays bad, and once on recovery.
- Heartbeat: one line every Monday at 16:00 UTC (the 16:40 run) saying the watchdog ran and how many subjects are healthy.
- No donor data or email addresses in any message or log. Messages name Workers, cron expressions, queues, counts and times only.
- A failed check (API error, KV error) is never "healthy" and never "recovered". It is logged with `console.error` (Workers Issues reports it) and leaves stored state unchanged.
- Slack posting follows `monday-backup/src/alert.ts`: 10-second timeout, failures logged, never thrown.
- No write switch (the Worker writes nothing to Monday). `observability.issues.enabled: true` in both environments.
- `env.sandbox` has `"triggers": { "crons": [] }`, binds `sandbox-FLAGS` (`a80c21a348064e07bb9c1bff16bee1a4`), and reads `config/sandbox.json`.
- Production `FLAGS` id: `1dec1f10ebcc41e7a464179ba2b37628`. Account id: `f323cb191edeb5d30acc4d289427a010`.
- Watchdog cron: `"40 * * * *"`.
- API token permissions: Account Analytics Read and Queues Read. Add Workers Observability Read only if Task 3 has to fall back to it.

## Review Focus

1. **A Worker that just went live or was just given a new cron has no history.** Expect no alert until its full gap has passed since the watchdog first saw that subject (an "armed at" time, like `monday-backup`'s watchdog).
2. **The Cloudflare API is down or the token is wrong.** Expect one `console.error` per run, no Slack flood, and no false "recovered" message. Stored state is unchanged.
3. **A missing `FLAGS` key** reads as `off` (repo convention), so a Worker expected `on` alerts. A KV read error is a check failure (point 2), not `off`.
4. **The Slack POST fails.** The state must not record the alert as sent, so the next run retries it.
5. **A cron expression in `wrangler.jsonc` changes** (for example `0 * * * *` → `5 * * * *`) without a config update. The config test fails in CI, so the watchdog never watches a schedule that no longer exists.

---

## File Structure

```
sync-watchdog/
  package.json, tsconfig.json, vitest.config.ts, wrangler.jsonc, README.md
  config/svbc.json            production subjects (watched, notLive, queues)
  config/sandbox.json         sandbox subjects (for manual runs)
  config/coverage.test.ts     cross-checks config against every */wrangler.jsonc
  src/environment.ts          copied from contact-roles/src/environment.ts
  src/config.ts               types + validateConfig()
  src/types.ts                Env
  src/state.ts                SubjectState, decide()  (pure)
  src/cloudflare.ts           CloudflareApi: lastScheduledRun(), queueBacklog()
  src/checks.ts               cronSubjects(), writeSwitchSubjects(), queueSubjects()
  src/alert.ts                postToSlack()
  src/run.ts                  runWatchdog()
  src/index.ts                scheduled() entrypoint
docs/runbooks/sync-alerting.md
```

---

### Task 1: Scaffold the Worker, config and coverage test

**Files:**
- Create: `sync-watchdog/{package.json,tsconfig.json,vitest.config.ts,wrangler.jsonc,README.md}`, `sync-watchdog/src/{environment.ts,config.ts,types.ts}`, `sync-watchdog/config/{svbc.json,sandbox.json,coverage.test.ts}`, `sync-watchdog/src/config.test.ts`
- Modify: `.gitlab-ci.yml` (add a `sync-watchdog` job extending `.worker_job`, running `npm test` and `npm run typecheck`)

**Interfaces:**
- Produces:
  ```ts
  // src/config.ts
  export interface CronWatch { cron: string; maxGapHours: number }
  export interface WatchedWorker { script: string; expectedWrites: 'on' | 'off' | null; crons: CronWatch[] }
  export interface QueueWatch { name: string; maxBacklogAgeHours: number }
  export interface WatchdogConfig {
    accountId: string;
    watched: Record<string, WatchedWorker>;   // key: Worker directory name
    notLive: Record<string, string>;          // key: directory name, value: reason
    queues: QueueWatch[];
  }
  export function validateConfig(raw: unknown): WatchdogConfig;
  // src/types.ts
  export interface Env { ENVIRONMENT?: string; FLAGS: KVNamespace; STATE: KVNamespace;
    CLOUDFLARE_API_TOKEN: string; SLACK_WEBHOOK_URL: string }
  ```

- [ ] **Step 1: Write `config/coverage.test.ts`.** It reads every `../*/wrangler.jsonc` except its own (strip comments with `stripJsonc` from `scripts/check-worker-flags.mjs`) and asserts:
  - `every Worker with production crons is watched or notLive, never both`
  - `every watched cron matches a production cron of that Worker` (same expression set, no extras, none missing)
  - `every maxGapHours is at least the cron's interval and at least its floor`: floor 3 for sub-daily, 30 for daily, 192 for weekly. Use a small `intervalHours(cron)` helper in the test file that handles the five expressions in use: `*/N * * * *`, `M * * * *`, `M H * * *`, `M H * * D`.
  - `every watched expectedWrites is null exactly when the Worker is not in IN_SCOPE` (import `IN_SCOPE` from `scripts/check-worker-flags.mjs`)
  - `every queue name is a production producer queue of some watched Worker`

- [ ] **Step 2: Fill `config/svbc.json`.** Set `accountId`. List `watched` from the live account (`svbc-*` scripts without `-sandbox`) and each one's production crons, with `maxGapHours` = max(2 × interval, floor). Set `expectedWrites` to `"on"` for live in-scope Workers and `null` for `svbc-calendars`, `monday-auth` and `member-map`. Put `dtd-sync`, `nearby-search`, `impact-attribution` and `quickbooks-sync` in `notLive` with the reasons from the spec. List every production main queue from `watched` Workers' `producers` with `maxBacklogAgeHours: 6`. `config/sandbox.json` has the same shape with the `-sandbox` script and queue names.

- [ ] **Step 3: Run the tests and check they pass.** Run: `cd sync-watchdog && npm ci && npm test -- config/`. Expected: PASS. If one fails, fix the config, not the test.

- [ ] **Step 4: Write `src/config.test.ts`.** `validateConfig` rejects a missing `accountId`, a non-positive `maxGapHours`, an `expectedWrites` outside `on|off|null`, and a Worker that is in both `watched` and `notLive`. It accepts both JSON files. Then implement `validateConfig` and run `npm test` (PASS) and `npm run typecheck` (no errors).

- [ ] **Step 5: Commit.** `git add sync-watchdog .gitlab-ci.yml && git commit -m "feat(sync-watchdog): scaffold Worker with config and coverage test"`

---

### Task 2: State and alert decisions (pure)

**Files:** Create `sync-watchdog/src/state.ts`, `sync-watchdog/src/state.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Health = { ok: true } | { ok: false; detail: string };
  export interface SubjectState { armedAt: string; bad: boolean; lastAlertAt: string | null; detail: string | null }
  export type Decision = { post: null | { kind: 'bad' | 'reminder' | 'recovered'; text: string }; next: SubjectState };
  export function decide(subject: string, health: Health, prev: SubjectState | null, now: Date): Decision;
  export function markSent(next: SubjectState, now: Date): SubjectState;  // sets lastAlertAt
  ```

- [ ] **Step 1: Write the failing tests** in `state.test.ts`:
  - `first sight arms the subject and posts nothing even if unhealthy`: `prev=null` gives `next.armedAt=now` and `post=null`.
  - `going bad posts once`: `prev.bad=false` and unhealthy gives `post.kind='bad'` with text containing the subject and detail.
  - `staying bad posts a reminder only after 24 h`: at 23 h `post=null`; at 24 h `post.kind='reminder'`.
  - `recovering posts once`: `prev.bad=true` and ok gives `post.kind='recovered'` and `next.bad=false`.
  - `decide never sets lastAlertAt; only markSent does` (pins Review Focus 4).

- [ ] **Step 2: Run the tests and check they fail.** Run `npm test -- src/state.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement `decide` and `markSent`.** The "armed" grace period belongs to the cron check (Task 4), not here. `decide` only applies the change-of-state and 24-hour rules.

- [ ] **Step 4: Run the tests and check they pass.** Expected: PASS.

- [ ] **Step 5: Commit.** `feat(sync-watchdog): alert-on-change state machine`

---

### Task 3: Cloudflare API client

**Files:** Create `sync-watchdog/src/cloudflare.ts`, `sync-watchdog/src/cloudflare.test.ts`, `sync-watchdog/test/fixtures/{scheduled.json,queue.json}`

**Interfaces:**
- Produces:
  ```ts
  export class CloudflareApiError extends Error {}
  export interface CloudflareApi {
    lastScheduledRun(script: string, cron: string, since: Date): Promise<Date | null>;
    queueBacklog(queueName: string): Promise<{ count: number; oldestAgeHours: number | null }>;
  }
  export function cloudflareApi(accountId: string, token: string, fetcher?: typeof fetch): CloudflareApi;
  ```

- [ ] **Step 1: Confirm the APIs against the live account (spike, no commit).** Create the token first (Task 6, Step 1). Then:
  - Query GraphQL `workersInvocationsScheduled(filter:{scriptName, cron, datetime_geq}, orderBy:[datetime_DESC], limit:1){ datetime cron status }` for `svbc-funraise-sync`. An empty result from a Wrangler OAuth token on 2026-11-17 was inconclusive (that token lacks Analytics Read). If it returns rows, save one as `test/fixtures/scheduled.json`.
  - If the dataset has no `cron` field or returns nothing with the right token, switch `lastScheduledRun` to Workers Observability's query API (filter by `$workers.scriptName` and `$workers.event.cron`), add Workers Observability Read to the token, and note the change in the README.
  - Find the Queues API endpoint that returns backlog count and oldest-message age per queue, and save a sample as `test/fixtures/queue.json`.

- [ ] **Step 2: Write the failing tests** using a stub `fetcher` that serves the fixtures:
  - `lastScheduledRun returns the newest datetime or null when empty`
  - `queueBacklog returns count and oldest age`
  - `non-2xx, GraphQL errors[], or malformed JSON throw CloudflareApiError` (pins Review Focus 2)
  - `requests carry Authorization: Bearer <token> and a 10s timeout`

- [ ] **Step 3: Run the tests and check they fail.** Then implement against the fixture shapes.

- [ ] **Step 4: Run the tests and check they pass.**

- [ ] **Step 5: Commit.** `feat(sync-watchdog): Cloudflare analytics and queues client`

---

### Task 4: Checks

**Files:** Create `sync-watchdog/src/checks.ts`, `sync-watchdog/src/checks.test.ts`

**Interfaces:**
- Consumes: `WatchdogConfig` (Task 1), `CloudflareApi` (Task 3), `Health`, `SubjectState` (Task 2)
- Produces:
  ```ts
  export interface SubjectResult { subject: string; health: Health | 'check-failed'; error?: string }
  export function cronSubjects(cfg: WatchdogConfig, api: CloudflareApi, states: Map<string, SubjectState>, now: Date): Promise<SubjectResult[]>;   // subject `cron:<worker>:<cron>`
  export function writeSwitchSubjects(cfg: WatchdogConfig, flags: KVNamespace): Promise<SubjectResult[]>;  // subject `writes:<worker>`
  export function queueSubjects(cfg: WatchdogConfig, api: CloudflareApi): Promise<SubjectResult[]>;        // subject `queue:<name>`
  ```

- [ ] **Step 1: Write the failing tests:**
  - `cron: no run within maxGapHours is unhealthy with "no run since <iso>"`
  - `cron: a subject armed less than maxGapHours ago is ok even with no runs` (pins Review Focus 1). The reference time is `max(lastRun, armedAt)`.
  - `writes: missing key reads as off and is unhealthy when expected on` (pins Review Focus 3)
  - `writes: value equal to expectedWrites is ok; Workers with expectedWrites null are skipped`
  - `writes: a KV get that throws gives check-failed, not unhealthy` (pins Review Focus 3)
  - `queue: backlog older than maxBacklogAgeHours is unhealthy with count; empty or younger is ok`
  - `any CloudflareApiError gives check-failed for that subject only` (pins Review Focus 2)

- [ ] **Step 2: Run the tests and check they fail.** Then implement. The KV key is `<worker>:writes`, read with `{ cacheTtl: 30 }`.

- [ ] **Step 3: Run the tests and check they pass.**

- [ ] **Step 4: Commit.** `feat(sync-watchdog): cron, write-switch and queue checks`

---

### Task 5: Runner, Slack, heartbeat and entrypoint

**Files:** Create `sync-watchdog/src/{alert.ts,run.ts,index.ts}`, `sync-watchdog/src/run.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4
- Produces:
  ```ts
  // alert.ts
  export async function postToSlack(webhookUrl: string, text: string): Promise<boolean>; // true if 2xx
  // run.ts
  export interface RunDeps { cfg: WatchdogConfig; api: CloudflareApi; flags: KVNamespace; state: KVNamespace;
    slackWebhookUrl: string; now: Date; environment: 'production' | 'sandbox' }
  export async function runWatchdog(deps: RunDeps): Promise<void>;
  ```

- [ ] **Step 1: Write the failing tests** in `run.test.ts`, using Miniflare KV for `state` and `flags`, a stub `api`, and a stubbed global `fetch` for Slack:
  - `posts one message per state change and stores state under key "subject:<subject>"`
  - `a failed Slack POST leaves lastAlertAt unset so the next run posts again` (pins Review Focus 4)
  - `check-failed subjects keep their previous state and log one console.error naming them`
  - `heartbeat posts on Monday at 16:xx UTC only: "sync-watchdog: running, N of M subjects healthy"`
  - `sandbox environment never posts to Slack; it logs the would-be messages instead`
  - Message texts start with `sync-watchdog:` and contain no `@`.

- [ ] **Step 2: Run the tests and check they fail.** Then implement:
  - `alert.ts` follows `monday-backup/src/alert.ts`, returning `false` instead of only logging.
  - `run.ts` collects the three check lists, applies `decide` per subject, and calls `markSent` only after `postToSlack` returns `true`.
  - `index.ts` exports `scheduled(controller, env, ctx)`. It builds deps with `createConfigSelector` and `environmentOf` from `environment.ts`, and uses `now = new Date(controller.scheduledTime)`.

- [ ] **Step 3: Run the tests and check they pass.** Run `npm test` (PASS) and `npm run typecheck` (clean). Also run `node scripts/check-log-safety.mjs` from the repo root (PASS).

- [ ] **Step 4: Commit.** `feat(sync-watchdog): runner, Slack alerts and Monday heartbeat`

---

### Task 6: Provision, deploy and document

**Files:**
- Modify: `sync-watchdog/wrangler.jsonc` (the `STATE` KV ids)
- Create: `docs/runbooks/sync-alerting.md`
- Modify: `README.md` (status table row; replace the "Worth a Slack-automation ping" sentence with a pointer to the runbook; add an automations pointer to "Error monitoring: Workers Issues"; correct `contact-roles`' status to deployed), `CLAUDE.md` (add `sync-watchdog` to the "no write switch" list beside `monday-auth` and `member-map`)

- [ ] **Step 1: DWK creates the account API token** in the dashboard (Account Analytics Read and Queues Read on the SVBC account) and runs `npx wrangler secret put CLOUDFLARE_API_TOKEN` and `npx wrangler secret put SLACK_WEBHOOK_URL` in `sync-watchdog/`. Claude does not handle either value.
- [ ] **Step 2: Create the KV namespaces.** Run `npx wrangler kv namespace create sync-watchdog-state` (and `... sync-watchdog-state-sandbox`), then put both ids in `wrangler.jsonc`.
- [ ] **Step 3: Deploy and trigger one run.** Run `npm run deploy`. Trigger a run from the dashboard (Settings → Trigger Events) or wait for :40. Expected: no Slack message on the first run (everything arms), and no `console.error` in Workers Logs. Before the heartbeat ever fires, sending one manual heartbeat to Slack confirms the webhook works.
- [ ] **Step 4: Write the runbook.** `docs/runbooks/sync-alerting.md` covers: what each message means and the tool to use (`scripts/flags.mjs`, `scripts/redrive-failed.mjs`, Workers Issues); how to move a Worker from `notLive` to `watched`; and the Part 1 automation table (filled in by Task 7).
- [ ] **Step 5: Commit, push and open the merge request.** `docs(sync-watchdog): runbook and README/CLAUDE.md updates`

---

### Task 7: Workers Issues automations (dashboard, created disabled)

- [ ] **Step 1: Create the Chat destination.** In the dashboard (Workers → an Issues page → Automations → destination), create a Chat destination named `staff-slack-private`. DWK pastes the Slack webhook URL; Claude does not enter it.
- [ ] **Step 2: Create the automations, disabled.** For each production script (the 16 `svbc-*` scripts plus `svbc-sync-watchdog`), add an automation with occurrence threshold 1 and recurrence after 24 h of inactivity to `staff-slack-private`, with **Enabled off**. If one automation can't hold both triggers, create two.
- [ ] **Step 3: Record them.** Add the table (script, triggers, destination, enabled) to `docs/runbooks/sync-alerting.md` and commit.

### Task 8: Enable after DWK's triage

- [ ] **Step 1: Wait for DWK's go-ahead.** DWK resolves or archives the understood production issues and says "triage done".
- [ ] **Step 2: Enable every automation from Task 7.** Then check that the next new production issue arrives in the channel, or use the dashboard's test-send if one exists.
- [ ] **Step 3: Update the runbook table** (enabled on, with the date) and commit.
