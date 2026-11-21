# Staff Status Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A staff-only page at `status.bikesiliconvalley.org` that shows SVBC's own syncs (from `sync-watchdog`), Cloudflare's platform status, and each SaaS vendor's status with a link to its official page.

**Architecture:** `sync-watchdog` gains one KV write per run (`snapshot:latest`). A new `status-page` Worker, behind Cloudflare Access, reads that snapshot through a KV binding and, on each request, fetches the vendor and Cloudflare status feeds in parallel (3 s timeout, 60 s edge cache). It renders one server-side HTML page with no client JS.

**Tech Stack:** TypeScript Cloudflare Worker (plain `fetch` handler, no Hono), `jose` for the Access JWT, vitest, Wrangler 4.

**Spec:** `docs/superpowers/specs/2026-11-20-status-page-design.md`

## Global Constraints

- Never render "operational"/"Running" for something that wasn't checked: timeout, non-2xx, non-JSON, a missing snapshot subject or a stale snapshot all mean **unknown** ("Couldn't check").
- One failed feed affects only its own row; the `fetch` handler never throws on a feed error.
- No secrets, no `MONDAY_AUTH` binding, no write switch; not added to `check-worker-flags.mjs`'s `IN_SCOPE`.
- Access JWT verified by the Worker on every route (fonts and CSS included), RS256 only; 403 logs no identity. Never `console.*` the Access email (`check-log-safety`).
- `workers_dev: false`, `preview_urls: false`; routes `status.bikesiliconvalley.org` / `status.sandbox.bikesiliconvalley.org` (`custom_domain: true`).
- Rate-limit `namespace_id`s **2103** (production) and **2104** (sandbox); the highest in use today is 2102.
- `WATCHDOG_STATE` KV ids: production `fd4cd11d203d4b7fbdf2dd1bbc0bce4a`, sandbox `e82a6053131d4fd6a90d7cf7e8c852d6` (the `sync-watchdog` STATE namespaces).
- Times shown in `America/Los_Angeles`, as "10:41 AM" / "4 hours ago".
- Every state has an icon **and** a word: ✓ Operational / Running, ⚠ Degraded / Maintenance / Paused / Backed up, ✕ Outage / Not running, ? Couldn't check, – No public status page / Status page only.
- Snapshot stale after **2 hours**. Feed timeout **3000 ms**. Feed cache **60 s**. Page `<meta http-equiv="refresh" content="120">`.
- Banner counts: sync rows in Not running / Paused / Backed up; Cloudflare components and vendors at Outage; plus one line when the watchdog snapshot is stale or missing *(plan's call: the spec lists "Couldn't check" as row-only, but a silent watchdog hides every sync problem, so it earns one banner line)*. Degraded, Maintenance and row-level Couldn't check stay off the banner.
- Colours, type and spacing from `docs/design-system/tokens.json`; fonts self-hosted, never Google Fonts.

## Review Focus

1. **A vendor URL that answers 200 with HTML** (as `status.eventbrite.com` redirects to an event listing) must show Couldn't check, not Operational. → Task 3, `parses non-JSON 200 as unknown`.
2. **A feed that hangs** must not hold the page past the timeout; the other rows still render. → Task 3, `times out a hanging feed as unknown`.
3. **A Worker in the status-page config but absent from the snapshot** (a new Worker, or the sandbox snapshot) must show Couldn't check, not Running. → Task 5, `missing subject is unknown`.
4. **Incident titles and watchdog details containing `<`, `&` or quotes** (vendor-controlled text) must be escaped. → Task 6, `escapes vendor text`.
5. **A configured Cloudflare component that's been renamed or removed** from cloudflarestatus must show Couldn't check rather than silently disappearing. → Task 4, `configured component missing from feed is unknown`.

---

## File Structure

```
sync-watchdog/src/run.ts            modify: write snapshot:latest after the alert loop
sync-watchdog/src/run.test.ts       modify: snapshot tests
sync-watchdog/README.md             modify: document the snapshot key

status-page/
  package.json, tsconfig.json, vitest.config.ts, wrangler.jsonc, README.md
  test/jsonc.ts, test/raw-imports.d.ts          copied from member-map/test/
  config/svbc.json, config/sandbox.json
  config/split.test.ts                          prod/sandbox separation
  config/coverage.test.ts                       syncs list vs sync-watchdog/config/svbc.json
  src/environment.ts                            byte copy of member-map/src/environment.ts
  src/access.ts, src/access.test.ts             copied from member-map, StatusConfig type
  src/rateLimit.ts                              copied from member-map, comment adjusted
  src/config.ts, src/config.test.ts             StatusConfig + validateConfig
  src/types.ts                                  Level, Incident, row/section types
  src/feeds/fetchJson.ts (+ .test.ts)           timeout + edge cache + JSON-or-unknown
  src/feeds/statuspage.ts (+ .test.ts)          Atlassian Statuspage summary.json
  src/feeds/slack.ts (+ .test.ts)
  src/feeds/google.ts (+ .test.ts)
  src/feeds/fixtures/*.json                     recorded feed samples
  src/vendors.ts (+ .test.ts)                   config vendor → VendorRow
  src/cloudflare.ts (+ .test.ts)                summary → CloudflareSection
  src/syncs.ts (+ .test.ts)                     snapshot → SyncSection
  src/banner.ts (+ .test.ts)                    sections → attention items
  src/render.ts (+ .test.ts)                    PageModel → HTML; styles.css text
  src/fonts.ts, src/fontData.ts, src/OFL-*.txt  self-hosted fonts
  src/index.ts (+ .test.ts)                     fetch handler: rate limit → Access → route

scripts/build-font-modules.mjs     modify: add status-page target
.github/workers.json               modify: roster entry
.gitlab-ci.yml                     modify: test + deploy-sandbox jobs
README.md                          modify: Status at a glance row
```

---

### Task 1: `sync-watchdog` writes `snapshot:latest`

**Files:**
- Modify: `sync-watchdog/src/run.ts`
- Modify: `sync-watchdog/src/run.test.ts`
- Modify: `sync-watchdog/README.md`

**Interfaces:**
- Produces (KV key `snapshot:latest` in the STATE namespace, JSON):
  ```ts
  export interface WatchdogSnapshot {
    runAt: string; // ISO, deps.now
    subjects: { subject: string; status: 'ok' | 'bad' | 'check-failed'; detail?: string }[];
  }
  export const SNAPSHOT_KEY = 'snapshot:latest';
  ```
  `detail` is `health.detail` for `bad` and `error` for `check-failed`; absent for `ok`. Subject names unchanged: `cron:<worker>:<cron>`, `writes:<worker>`, `queue:<name>`.

- [ ] **Step 1: Write the failing tests** in `run.test.ts`, using the file's existing `deps()`, `armAll()` and `env.STATE`:
  - `writes a snapshot of every subject`: after `runWatchdog(deps())` with all healthy, `JSON.parse(await env.STATE.get('snapshot:latest'))` equals `{ runAt: TUESDAY.toISOString(), subjects: SUBJECTS.map(s => ({ subject: s, status: 'ok' })) }` (order-insensitive compare).
  - `snapshot carries bad detail and check-failed error`: api whose `lastScheduledRun` throws `new Error('boom')` and FLAGS `funraise-sync:writes` = `hold` → cron subject `{ status: 'check-failed', detail: 'boom' }`, writes subject `{ status: 'bad', detail: 'writes are hold, expected on' }`.
  - `a failed snapshot write doesn't stop alerts`: wrap `env.STATE` so `put('snapshot:latest', …)` rejects; a bad subject still posts to Slack, and `errors` contains a line starting `sync-watchdog: snapshot write failed`.
  - `sandbox writes a snapshot too`: `environment: 'sandbox'` → key present.

- [ ] **Step 2: Run to verify failure**

  Run: `cd sync-watchdog && npm test -- src/run.test.ts`
  Expected: the four new tests FAIL (key is null).

- [ ] **Step 3: Implement** — export `WatchdogSnapshot` and `SNAPSHOT_KEY` from `run.ts`; after the per-subject loop and before the heartbeat, build the snapshot from `results` and `await state.put(SNAPSHOT_KEY, …)` inside try/catch, logging `sync-watchdog: snapshot write failed: <err.name>` on error.

- [ ] **Step 4: Run tests and typecheck**

  Run: `cd sync-watchdog && npm test && npm run typecheck`
  Expected: all PASS.

- [ ] **Step 5: Document** — README "Bindings and secrets" → under `STATE`, add: "also `snapshot:latest`, every subject's result and the run time, written each run and read by `status-page`".

- [ ] **Step 6: Commit**

  ```bash
  git add sync-watchdog
  git commit -m "feat(sync-watchdog): write snapshot:latest each run for the status page"
  ```

---

### Task 2: `status-page` skeleton — config, environment, Access gate

**Files:** create `status-page/{package.json,tsconfig.json,vitest.config.ts,wrangler.jsonc}`, `test/jsonc.ts`, `test/raw-imports.d.ts`, `config/{svbc,sandbox}.json`, `config/split.test.ts`, `src/{environment,access,rateLimit,config,types,index}.ts` and their tests.

**Interfaces:**
- Produces `src/types.ts`:
  ```ts
  export type Level = 'operational' | 'degraded' | 'maintenance' | 'outage' | 'unknown' | 'link-only';
  export interface Incident { name: string; url: string }
  ```
- Produces `src/config.ts`:
  ```ts
  export type FeedSpec =
    | { kind: 'statuspage'; url: string }               // base URL; /api/v2/summary.json appended
    | { kind: 'slack'; url: string }
    | { kind: 'google'; url: string; products: string[] } // affected_products[].title values
    | { kind: 'none' };
  export interface VendorSpec { name: string; usedFor: string; statusPageUrl: string | null; feed: FeedSpec }
  export interface SyncSpec { label: string; description: string; worker: string; queues: string[] }
  export interface StatusConfig {
    access: { teamDomain: string; aud: string; allowedEmailDomain: string }; // teamDomain "" = refuse all
    timezone: string;
    feedTimeoutMs: number; feedCacheSeconds: number; snapshotMaxAgeHours: number;
    syncs: SyncSpec[];
    hiddenWorkers: Record<string, string>; // watchdog-watched Workers deliberately not shown → reason
    cloudflare: { statusPageUrl: string; components: string[] };
    vendors: VendorSpec[];
  }
  export function validateConfig(raw: unknown): StatusConfig;
  ```
- Produces `src/index.ts`: `export interface Env { WATCHDOG_STATE: KVNamespace; REQUEST_RATE_LIMITER: RateLimit; ENVIRONMENT?: string; ACCESS_DEV_BYPASS?: string }` and `export function createHandler(deps?: AppDeps)` where `AppDeps = { keys?: JWTVerifyGetKey; accessOverride?: StatusConfig['access']; now?: () => Date }`. In this task the only route is `GET /` returning 200 `ok`; Task 6 replaces it.

- [ ] **Step 1: Copy the scaffolding**
  - `package.json`: name `status-page`, scripts `test` (`vitest run`), `dev`, `dev:sandbox`, `deploy`, `deploy:sandbox`, `typecheck`, exactly as in `member-map/package.json`; deps `jose ^6`; devDeps `@cloudflare/workers-types`, `typescript`, `vitest`, `wrangler` at member-map's versions. `npm install` to make the lockfile.
  - `tsconfig.json` and `vitest.config.ts` from member-map (vitest include `src/**/*.test.ts`, `config/**/*.test.ts`; no Workers pool).
  - `test/jsonc.ts`, `test/raw-imports.d.ts` from `member-map/test/`.
  - `src/environment.ts`: byte copy of `member-map/src/environment.ts`.
  - `src/access.ts`: `member-map/src/access.ts` with `MapConfig` → `StatusConfig`. `src/access.test.ts`: copy member-map's, same type swap.
  - `src/rateLimit.ts`: member-map's, comment rewritten for this Worker's surface (`/`, `/styles.css`, `/fonts/*`).

- [ ] **Step 2: Write `wrangler.jsonc`** — name `svbc-status-page`, `main: src/index.ts`, account `f323cb191edeb5d30acc4d289427a010`, `compatibility_date` `2026-08-01`, `workers_dev: false`, `preview_urls: false`, `upload_source_maps: true`, `observability.enabled: true`, route `status.bikesiliconvalley.org`, `kv_namespaces: [{ binding: WATCHDOG_STATE, id: <prod> }]`, `ratelimits: [{ name: REQUEST_RATE_LIMITER, namespace_id: "2103", simple: { limit: 60, period: 60 } }]`, no `triggers`. `env.sandbox`: name `svbc-status-page-sandbox`, `vars.ENVIRONMENT: "sandbox"`, route `status.sandbox.bikesiliconvalley.org`, sandbox KV id, namespace `2104`, the same comment that no `ACCESS_DEV_BYPASS` belongs here.

- [ ] **Step 3: Write `config/svbc.json`**:
  - `access`: `{ "teamDomain": "", "aud": "", "allowedEmailDomain": "bikesiliconvalley.org" }` (filled when the Access app exists; README step).
  - `timezone` `America/Los_Angeles`, `feedTimeoutMs` 3000, `feedCacheSeconds` 60, `snapshotMaxAgeHours` 2.
  - `syncs` (one per watched Worker except `monday-auth`; labels are drafts the builder may polish, keeping them free of Worker/cron jargon):

    | worker | label | queues |
    |---|---|---|
    | funraise-sync | Funraise donations → Monday | funraise-sync-writes |
    | eventbrite-sync | Eventbrite orders → Monday | eventbrite-sync-writes |
    | mailchimp-sync | Mailchimp ↔ Monday | mailchimp-sync-outbound, mailchimp-sync-inbound |
    | benevity-import | Benevity gifts → Monday | benevity-import-writes |
    | donation-rollups | Giving totals on People | donation-rollups-recompute |
    | contact-roles | Contact roles on People | — |
    | people-reclassification | Member/donor reclassification | — |
    | report-digests | Scheduled report emails | — |
    | monday-backup | Monday backups | — |
    | member-portal | Member portal | member-portal-change-requests, member-portal-letter-emails |
    | member-map | Member map refresh | svbc-member-map-refresh |
    | bp-feedback-notify | Bike plan feedback alerts | — |
    | svbc-calendars | Website event calendars | — |

    Each gets a one-sentence `description` of what staff would notice if it stopped.
  - `hiddenWorkers`: `{ "monday-auth": "plumbing; its failure shows as the syncs that depend on it" }`.
  - `cloudflare`: `statusPageUrl` `https://www.cloudflarestatus.com`, `components` `["Workers", "Workers KV", "D1", "Queues", "R2", "Email Routing", "Access", "Authoritative DNS", "CDN/Cache", "San Jose, United States - (SJC)"]`.
  - `vendors`, in this order:

    | name | usedFor | statusPageUrl | feed |
    |---|---|---|---|
    | Monday.com | CRM | https://status.monday.com | statuspage https://status.monday.com |
    | Funraise | Online donations | https://status.funraise.org | statuspage https://status.funraise.org |
    | Eventbrite | Event tickets | https://www.eventbrite.com/help/ | none |
    | Mailchimp | Email newsletters | https://status.mailchimp.com | none |
    | Google Workspace | Email, Drive, Calendar | https://www.google.com/appsstatus/dashboard/ | google https://www.google.com/appsstatus/dashboard/incidents.json, products Gmail, Google Drive, Google Calendar, Google Meet |
    | Slack | Staff chat | https://slack-status.com | slack https://slack-status.com/api/v2.0.0/current |
    | Box | Files | https://status.box.com | statuspage https://status.box.com |
    | Zoom | Meetings | https://www.zoomstatus.com | statuspage https://www.zoomstatus.com |
    | QuickBooks | Accounting | https://status.quickbooks.intuit.com | statuspage https://status.quickbooks.intuit.com |
    | Zapier | Automations | https://status.zapier.com | statuspage https://status.zapier.com |
    | Squarespace | Website | https://status.squarespace.com | statuspage https://status.squarespace.com |
    | Benevity | Workplace giving | null | none |
    | Double the Donation | Matching gifts | null | none |
    | Windfall | Donor research | null | none |

  `config/sandbox.json`: identical except `access` (own `aud`, also `""` until created).

- [ ] **Step 4: Write the failing tests**
  - `src/config.test.ts`: both shipped configs validate; rejects a vendor with `feed.kind: 'statuspage'` and a non-`https://` url; rejects `feedTimeoutMs: 0`; rejects a sync with empty `label`; `statusPageUrl: null` allowed only when `feed.kind === 'none'`.
  - `config/split.test.ts` (shape of member-map's): sandbox and production have different route patterns, KV ids, rate-limit namespace ids; `env.sandbox.vars.ENVIRONMENT === 'sandbox'`; neither env has `ACCESS_DEV_BYPASS`; production `aud` differs from sandbox `aud` unless both are `""`.
  - `src/index.test.ts`: no `Cf-Access-Jwt-Assertion` → 403; valid token (sign with a local RS256 key, pass `keys` + `accessOverride` like member-map's index tests) → 200; `ACCESS_DEV_BYPASS=1` on `http://localhost/` → 200, on `https://status.bikesiliconvalley.org/` → 403; rate limiter returning `{ success: false }` → 429 before the Access check.

- [ ] **Step 5: Run to verify failure** — `cd status-page && npm test` → FAIL (modules missing).

- [ ] **Step 6: Implement** `validateConfig` (same helper style as `member-map/src/config.ts`) and `createHandler` (rate limit → Access or dev bypass → route; unknown path → 404). Default export `{ fetch: createHandler().fetch }`.

- [ ] **Step 7: Verify** — `npm test && npm run typecheck` → PASS.

- [ ] **Step 8: Commit** — `git add status-page && git commit -m "feat(status-page): skeleton with config, sandbox split and Access gate"`

---

### Task 3: Feed fetching and vendor parsers

**Files:** create `src/feeds/{fetchJson,statuspage,slack,google}.ts` + tests, `src/feeds/fixtures/`, `src/vendors.ts` + test.

**Interfaces:**
- Consumes: `Level`, `Incident`, `VendorSpec`, `FeedSpec` (Task 2).
- Produces:
  ```ts
  // fetchJson.ts — never throws
  export type FetchResult = { ok: true; json: unknown } | { ok: false; reason: string };
  export async function fetchJson(url: string, opts: { timeoutMs: number; cacheSeconds: number }): Promise<FetchResult>;
  // statuspage.ts
  export interface StatuspageSummary { indicator: string; components: { name: string; status: string }[];
    incidents: { name: string; shortlink: string; componentNames: string[] }[];
    maintenances: { name: string; shortlink: string; status: string; componentNames: string[] }[] }
  export function parseStatuspage(json: unknown): StatuspageSummary | null; // null = malformed
  export function indicatorLevel(indicator: string): Level;   // none→operational, minor→degraded, major|critical→outage, maintenance→maintenance, else unknown
  export function componentLevel(status: string): Level;      // operational, degraded_performance→degraded, partial_outage|major_outage→outage, under_maintenance→maintenance, else unknown
  // slack.ts
  export function parseSlack(json: unknown): { level: Level; incidents: Incident[] } | null;
  // google.ts
  export function parseGoogle(json: unknown, products: string[]): { level: Level; incidents: Incident[] } | null;
  // vendors.ts
  export interface VendorRow { name: string; usedFor: string; statusPageUrl: string | null; level: Level; incidents: Incident[] }
  export async function vendorRow(spec: VendorSpec, opts: { timeoutMs: number; cacheSeconds: number }): Promise<VendorRow>;
  ```
- Mapping rules the tests pin:
  - `fetchJson`: `fetch(url, { signal: AbortSignal.timeout(timeoutMs), cf: { cacheTtl: cacheSeconds, cacheEverything: true } })`; non-2xx → `{ ok: false, reason: 'http <status>' }`; JSON parse failure → `reason: 'not json'`; abort → `reason: 'timeout'`; any other throw → `reason: err.name`. Each failure logs `status-page: feed <url host> failed: <reason>`.
  - Slack: `status === 'ok'` → operational with no incidents. Otherwise each `active_incidents[]` maps by `type`: `outage` → outage, `incident` → degraded, `notice` → listed without changing the level. Level is the worst of them. `Incident` = `{ name: title, url }`.
  - Google: only incidents with no `end` whose `affected_products[].title` intersects `products`. `status_impact` `SERVICE_OUTAGE` → outage, `SERVICE_DISRUPTION` → degraded, `SERVICE_INFORMATION` → listed, level unchanged. Name = first line of `external_desc` with `**Summary:**` stripped, else `service_name`. URL = `https://www.google.com/appsstatus/dashboard/` + `uri`.
  - Statuspage vendor row: `indicatorLevel(indicator)`, incidents = all unresolved `incidents` (vendors aren't component-filtered).
  - `feed.kind === 'none'` → `level: 'link-only'`, no fetch.
  - Any `fetchJson` failure or `null` parse → `level: 'unknown'`.

- [ ] **Step 1: Record fixtures** — save `status.monday.com/api/v2/summary.json`, Cloudflare's `summary.json` (currently Workers/Queues `degraded_performance` plus an incident), Slack `current`, and Google `incidents.json` into `src/feeds/fixtures/`. Hand-edit copies: `slack-outage.json` (one `outage` + one `notice`), `google-open.json` (one open `SERVICE_OUTAGE` affecting Gmail, one open affecting only `Google Workspace Studio`).

- [ ] **Step 2: Write the failing tests**
  - `fetchJson.test.ts` (stub `fetch` with `vi.stubGlobal`): `returns json on 200`; `parses non-JSON 200 as unknown` (body `<!doctype html>` → `{ ok: false, reason: 'not json' }`); `http 503 is a failure`; `times out a hanging feed as unknown` (fetch returns a promise that resolves only on `init.signal` abort; `timeoutMs: 20` → `reason: 'timeout'` within 500 ms); `passes cacheTtl` (asserts `init.cf.cacheTtl === 60`).
  - `statuspage.test.ts`: Monday fixture → indicator `none`, `indicatorLevel` → `operational`; Cloudflare fixture → component `Queues` → `componentLevel('degraded_performance') === 'degraded'`; `parseStatuspage({})` → null; every indicator/component status in the mapping above.
  - `slack.test.ts`: `ok` fixture → operational, `[]`; `slack-outage.json` → `outage`, 2 incidents; `{}` → null.
  - `google.test.ts`: real fixture with all incidents ended → operational; `google-open.json` with `['Gmail']` → `outage`, 1 incident, url starts `https://www.google.com/appsstatus/dashboard/incidents/`; with `['Google Meet']` → operational.
  - `vendors.test.ts`: `kind: 'none'` → `link-only` with no `fetch` call; a statuspage spec whose fetch 500s → `unknown`; the summary URL requested is `<url>/api/v2/summary.json`.

- [ ] **Step 3: Run to verify failure** — `npm test -- src/feeds src/vendors.test.ts` → FAIL.

- [ ] **Step 4: Implement** the five modules to the interfaces above.

- [ ] **Step 5: Verify** — `npm test && npm run typecheck` → PASS.

- [ ] **Step 6: Commit** — `git commit -m "feat(status-page): vendor status feeds with timeout and edge cache"`

---

### Task 4: Cloudflare section

**Files:** create `src/cloudflare.ts`, `src/cloudflare.test.ts`.

**Interfaces:**
- Consumes: `fetchJson`, `parseStatuspage`, `componentLevel` (Task 3).
- Produces:
  ```ts
  export interface CloudflareSection { statusPageUrl: string; components: { name: string; level: Level }[]; incidents: Incident[] }
  export async function cloudflareSection(cfg: StatusConfig['cloudflare'], opts: { timeoutMs: number; cacheSeconds: number }): Promise<CloudflareSection>;
  ```
  `components` is in config order. `incidents` = unresolved incidents, plus maintenances with `status === 'in_progress'`, whose `componentNames` include a configured component, as `{ name, url: shortlink }`. On fetch or parse failure every configured component is `unknown` and `incidents` is `[]`.

- [ ] **Step 1: Write the failing tests** (stub `fetch` to serve the Task 3 fixture or a variant):
  - `filters to configured components`: config `['Workers','Queues','D1']` → exactly those three, Queues `degraded`.
  - `configured component missing from feed is unknown`: config includes `'Workers KV Legacy'` → that row `unknown`.
  - `only incidents touching configured components`: fixture incident on `Network` is excluded with config `['Workers']`; a variant incident listing `Workers` is included with its shortlink.
  - `in-progress maintenance on SJC is listed; scheduled is not`.
  - `feed failure makes every component unknown`.

- [ ] **Step 2: Run to verify failure** — `npm test -- src/cloudflare.test.ts` → FAIL.
- [ ] **Step 3: Implement** `cloudflareSection`.
- [ ] **Step 4: Verify** — `npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(status-page): Cloudflare components and incidents"`

---

### Task 5: SVBC syncs section from the watchdog snapshot

**Files:** create `src/syncs.ts`, `src/syncs.test.ts`, `config/coverage.test.ts`; modify `.github/workers.json` (Task 7 adds the entry; this task needs `extraPaths` to include `sync-watchdog/config/**`, note it there).

**Interfaces:**
- Consumes: `SyncSpec`, `StatusConfig` (Task 2); snapshot shape `WatchdogSnapshot` (Task 1) — redeclare the interface locally in `syncs.ts` with a comment pointing at `sync-watchdog/src/run.ts`; don't import across Workers.
- Produces:
  ```ts
  export type SyncState = 'running' | 'not-running' | 'paused' | 'backed-up' | 'unknown';
  export interface SyncRow { label: string; description: string; state: SyncState; details: string[]; lastRunAt: string | null }
  export interface SyncSection { runAt: string | null; stale: boolean; rows: SyncRow[] }
  export async function syncSection(kv: KVNamespace, syncs: SyncSpec[], maxAgeHours: number, now: Date): Promise<SyncSection>;
  export function rollUp(spec: SyncSpec, snapshot: WatchdogSnapshot): SyncRow; // exported for tests
  ```
- Roll-up rules:
  - Subjects for a spec: every snapshot subject starting `cron:<worker>:`, plus `writes:<worker>` if present, plus `queue:<q>` for each of `spec.queues`. Only the `queue:` subjects are *expected*: cron subjects can't be predicted from this config, and Workers whose watchdog `expectedWrites` is `null` (`member-map`, `svbc-calendars`) have no `writes:` subject.
  - State precedence: any bad `cron:` → `not-running`; else any bad `queue:` → `backed-up`; else bad `writes:` → `paused`; else any `check-failed`, an expected `queue:` subject missing, or **no subject at all** for the worker → `unknown`; else `running`.
  - `details`: the `detail` of every non-ok subject.
  - `lastRunAt`: the ISO timestamp from a bad cron detail matching `/^no run since (\S+)$/`, else null.
  - Stale: key missing, unparseable, or `now − runAt > maxAgeHours` → `stale: true`, every row `unknown` with empty `details`, `runAt` as found (or null).

- [ ] **Step 1: Write the failing tests**
  - `all ok is running`.
  - `bad cron is not-running with lastRunAt` (detail `no run since 2026-11-20T14:00:00.000Z` → `lastRunAt` that ISO).
  - `bad queue is backed-up`; `bad writes is paused` (`writes are hold, expected on` in `details`).
  - `cron beats queue beats writes` when all three are bad.
  - `missing subject is unknown` (spec with `queues: ['x']`, snapshot without `queue:x`); `worker with no subjects at all is unknown`; `cron-only worker with no writes subject is running` (e.g. `svbc-calendars`).
  - `check-failed is unknown`.
  - `stale snapshot makes every row unknown` (runAt 2 h 1 min before now); `missing key is stale with runAt null`; `garbage JSON is stale`.
  - `config/coverage.test.ts`: import `../../sync-watchdog/config/svbc.json`. Every key of its `watched` is in `syncs[].worker` or `hiddenWorkers` and not both. Every `syncs[].worker` is in `watched`. Every watchdog `queues[].name` appears in exactly one `syncs[].queues`. Run it against `config/svbc.json`, and the worker checks against `sandbox.json`.

- [ ] **Step 2: Run to verify failure** — `npm test -- src/syncs.test.ts config/coverage.test.ts` → FAIL.
- [ ] **Step 3: Implement** `syncSection` and `rollUp`.
- [ ] **Step 4: Verify** — `npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(status-page): SVBC syncs from the watchdog snapshot"`

---

### Task 6: Banner, page rendering, fonts, routes

**Files:** create `src/banner.ts` (+test), `src/render.ts` (+test), `src/fonts.ts`, `src/fontData.ts`, `src/OFL-Manrope.txt`, `src/OFL-Poppins.txt`; modify `src/index.ts`, `src/index.test.ts`, `scripts/build-font-modules.mjs`.

**Interfaces:**
- Consumes: `SyncSection` (Task 5), `CloudflareSection` (Task 4), `VendorRow` (Task 3), `StatusConfig` (Task 2).
- Produces:
  ```ts
  // banner.ts
  export function attentionItems(m: { syncs: SyncSection; cloudflare: CloudflareSection; vendors: VendorRow[] }): string[];
  // render.ts
  export interface PageModel { syncs: SyncSection; cloudflare: CloudflareSection; vendors: VendorRow[]; checkedAt: Date }
  export function renderPage(model: PageModel, timezone: string): string;
  export const STYLES_CSS: string;
  // fonts.ts — same shape as svbc-calendars/src/fonts.ts
  export const FONT_FACE_CSS: string;
  export function fontResponse(pathname: string): Response | null;
  ```
- Banner text, one item per line:
  - stale watchdog → `The sync watchdog hasn't reported since <time>` (or `…hasn't reported yet` when `runAt` is null);
  - otherwise each sync row in not-running / paused / backed-up → `<label>: not running` / `paused` / `backed up`;
  - each Cloudflare component at outage → `Cloudflare <name>: outage`;
  - each vendor at outage → `<name>: outage`.
  - Empty list → the page shows "All systems normal".

- [ ] **Step 1: Add the font target** — in `scripts/build-font-modules.mjs` `TARGETS`, add `{ out: 'status-page/src/fontData.ts', faces: { Manrope: { weights: [500], subsets: ['latin'] }, Poppins: { weights: [400, 600], subsets: ['latin'] } } }`. Run `node scripts/build-font-modules.mjs` and confirm `status-page/src/fontData.ts` and the OFL files appear. Copy `svbc-calendars/src/fonts.ts` to `status-page/src/fonts.ts`, comment adjusted.

- [ ] **Step 2: Write the failing tests**
  - `banner.test.ts`: all healthy → `[]`; a degraded Cloudflare component and an `unknown` vendor → `[]`; a paused sync → `['Mailchimp ↔ Monday: paused']`; a stale snapshot → one watchdog line and no per-sync lines; a vendor outage → `['Slack: outage']`.
  - `render.test.ts`:
    - `shows All systems normal when nothing needs attention`.
    - `lists attention items in the banner`.
    - `every state has a word, not just a colour`: rendered rows contain `Operational`, `Degraded`, `Not running`, `Couldn't check`, `No public status page`.
    - `escapes vendor text`: incident name `<script>alert(1)</script> & "x"` appears only escaped.
    - `times in Pacific`: `checkedAt` `2026-11-20T18:41:00Z` → `Checked 10:41 AM`; a sync `lastRunAt` 4 hours earlier → `last ran 4 hours ago`.
    - `has a 120 s refresh and no script tags`.
    - `sync details sit in a details element`.
    - `link-only vendor with a statusPageUrl shows Status page link; null shows No public status page`.
  - `index.test.ts` (extend): `GET /` with valid Access and stubbed `fetch` + fake KV → 200 `text/html` with `Cache-Control: private, no-store` and a CSP of `default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'`. `GET /styles.css` → `text/css`. `GET /fonts/<a real name>.woff2` → `font/woff2`. All three → 403 without Access. `GET /` when every feed rejects → still 200.

- [ ] **Step 3: Run to verify failure** — `npm test` → FAIL.

- [ ] **Step 4: Implement**
  - `renderPage`: the layout in the spec's sketch. Black header bar with "SVBC System Status" and "Checked <time>". Banner. Three sections in order (SVBC syncs with "watchdog checked <time>", Cloudflare with a link to its status page, Services we use). Each vendor row: name, `usedFor`, state word, "Status page ↗" link or "No public status page", incidents linked beneath. Escape every interpolated string through one `esc()` helper. Relative times through `Intl.RelativeTimeFormat`, clock times through `Intl.DateTimeFormat` with `timeZone`.
  - `STYLES_CSS`: `FONT_FACE_CSS` plus tokens from `docs/design-system/tokens.json` (svbc-black header, sand/white sections, semantic colours flipping under `prefers-color-scheme: dark`). Headings in Manrope 500, body in Poppins.
  - `index.ts` routes: `GET /` → in parallel `syncSection(env.WATCHDOG_STATE, …)`, `cloudflareSection(…)`, `Promise.all(vendors.map(vendorRow))` → `renderPage`. `GET /styles.css` → `STYLES_CSS` (`Cache-Control: private, max-age=300`). `GET /fonts/*` → `fontResponse`. Everything goes through the Access gate from Task 2. `now` comes from `deps.now ?? (() => new Date())`.

- [ ] **Step 5: Verify** — `npm test && npm run typecheck` → PASS; `node scripts/check-log-safety.mjs` → no findings.

- [ ] **Step 6: Look at it** — `.dev.vars` with `ACCESS_DEV_BYPASS=1`, `npm run dev`, open `http://localhost:8787/` in the browser pane, screenshot in light and dark. Expect three sections. Cloudflare's live feed currently shows Workers/Queues degraded on rows, not in the banner. The syncs section shows the watchdog as not reported, because local KV is empty.

- [ ] **Step 7: Commit** — `git commit -m "feat(status-page): render the status page with banner and self-hosted fonts"`

---

### Task 7: Repo integration and README

**Files:** modify `.github/workers.json`, `.gitlab-ci.yml`, `README.md`; create `status-page/README.md`.

- [ ] **Step 1: CI roster** — `.github/workers.json`: `{ "dir": "status-page", "extraPaths": ["sync-watchdog/config/**", "scripts/build-font-modules.mjs"], "sandbox": {} }` in alphabetical position. `.gitlab-ci.yml`: a `status-page:` job extending `.worker_job` and a `deploy-sandbox:status-page:` job extending `.deploy_sandbox_job`, both shaped like `member-map`'s, with `sync-watchdog/config/**/*` in `changes`.

- [ ] **Step 2: Verify the roster** — `node scripts/ci-changed-workers.mjs` (as `.github/workflows/workers.yml` invokes it) lists `status-page`, and `node scripts/check-rate-limit-namespaces.mjs` passes.

- [ ] **Step 3: `status-page/README.md`** — the standard per-Worker sections: what it shows and why (link the spec); data flow (watchdog snapshot, feeds); config fields; **Cloudflare Access setup** (copy member-map's steps: two Access applications for `status.` and `status.sandbox.`, allow `@bikesiliconvalley.org`, then set `access.teamDomain` `https://bikesiliconvalley.cloudflareaccess.com` and each `aud` in config); adding a vendor (Statuspage vs link-only); local dev with `ACCESS_DEV_BYPASS`; deploy commands; "no secrets, no write switch".

- [ ] **Step 4: Root README** — a "Status at a glance" row: `status-page` — "Built, not deployed. Staff status page (vendor + Cloudflare status, SVBC syncs from sync-watchdog's snapshot); needs the Access applications before deploy." Also extend `sync-watchdog`'s row with "writes `snapshot:latest` for status-page".

- [ ] **Step 5: Full verification** — `cd status-page && npm test && npm run typecheck`; `cd ../sync-watchdog && npm test && npm run typecheck`; `node scripts/check-log-safety.mjs`; `node --test scripts/*.test.mjs`. All PASS.

- [ ] **Step 6: Commit** — `git commit -m "chore(status-page): CI roster, README and status table"`

---

## Not in this plan (operator steps after merge)

- Create the two Access applications and fill `access.teamDomain` / `aud` (status-page README).
- `npm run deploy:sandbox`, check `status.sandbox.bikesiliconvalley.org` behind Access, then `npm run deploy`.
- Deploy `sync-watchdog` so production starts writing `snapshot:latest`. Deploy it **before** status-page, or the syncs section will say the watchdog hasn't reported for up to an hour.
