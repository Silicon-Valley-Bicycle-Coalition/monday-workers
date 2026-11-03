# Member Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A staff-only `member-map` Worker. It serves a Leaflet/OpenStreetMap page that shades
San Mateo and Santa Clara block groups by membership gap, warm-lead gap or bike lane density,
outlines MTC Equity Priority Communities, and plots members, warm leads and organizations at
their exact addresses, each linked to its Monday item.

**Architecture:** A weekly cron reads the People (live + historical) and Organizations boards
through the `monday-auth` broker's `ReadOnlyToken`. It geocodes rows with an address but blank
Lat/Lng through the Census batch geocoder, cached privately in D1. It assigns every point to a
block group, scores the gaps, and writes one `snapshot.json` to a private R2 bucket. Static public
reference data is built offline by a Node script and served as Worker static assets: block-group
shapes carrying ACS population/income, EPC flag, road miles and weighted bike miles; EPC
outlines; bike lanes. Every request, assets included, passes a Cloudflare Access JWT check
before anything is served.

**Tech Stack:** Cloudflare Workers (Hono, D1, R2, static assets, cron), TypeScript 7, vitest,
`jose` (Access JWT), `@turf/*` (geometry), Leaflet 1.9.4 (cdnjs), Node 22.18+ script with
`shapefile`, `fflate` and `mapshaper` for the reference build.

**Spec:** `docs/superpowers/specs/2026-11-02-member-map-design.md`

## Global Constraints

- New Worker directory `member-map/`, Wrangler names `svbc-member-map` and `svbc-member-map-sandbox`.
- Never writes to Monday. Bind `MONDAY_AUTH` → `svbc-monday-auth` / `svbc-monday-auth-sandbox`, entrypoint `ReadOnlyToken`. No `MONDAY_API_TOKEN` secret.
- `member-map/src/monday/graphql.ts` is a byte-identical copy of `monday-backup/src/monday/graphql.ts`. Never edit it; tune through `src/monday/client.ts`.
- Find Monday columns by title through `bareTitle` from `scripts/lib/column-titles.mjs`, never `===` on raw titles.
- SVBC values live in `member-map/config/svbc.json` / `config/sandbox.json` (validated at startup) and `config/reference.json` (reference build + scoring), never in source.
- Coverage: state FIPS `06`, counties San Mateo `081` and Santa Clara `085`.
- Class weights: I = 1.0, II = 0.5, III = 0.2, IV = 1.0 (in `config/reference.json`).
- Road miles: TIGER/Line roads with MTFCC `S1200` or `S1400` only. That excludes freeways (`S1100`) and ramps (`S1630`) per the spec, and also driveways, parking aisles, private roads and alleys. *(Plan call, see Task 5.)*
- Tiny block groups: population < 100 → unscored (`null` class).
- `workers_dev: false` in both environments. `assets.run_worker_first: true`. Every response that carries snapshot data: `Cache-Control: private, no-store`.
- Logs carry counts only, never names, addresses or emails. `node scripts/check-log-safety.mjs` must pass.
- Weekly cron `0 13 * * 1` (Monday 13:00 UTC, early morning Pacific).
- Every strip-imported `.ts` file (`src/score.ts`, `src/reference/lines.ts`) stays strip-only TypeScript: no enums, namespaces or constructor parameter properties.
- Commit after every task from inside this worktree. The pre-commit hook allows linked worktrees.

## Review Focus

1. **Census batch response coordinate order:** the geocoder returns `"lon,lat"`. A swapped parse puts every geocoded member in the ocean. Pinned in Task 7 (`parseBatchResponse` test).
2. **Suppressed ACS income:** the ACS API returns `-666666666` (and other negative sentinels) for a suppressed median. It must become `null` and render "median income not reported", never "$-666,666,666". Pinned in Task 5 (`acsValue` test) and Task 9 (`blockGroupSummary` test).
3. **HTML in Monday item names:** a name like `<img src=x onerror=…>` must render as text in popups, not run. Pinned in Task 9 (`escapeHtml` test).
4. **Static assets reached without the Access JWT:** `index.html`, `app.js` and `/data/*` must 403 like the API does. Without `run_worker_first`, the asset layer would serve them before the Worker runs. Pinned in Task 2 (route test with an asset path).
5. **Junk board Lat/Lng** (`""`, `"0"`, `"abc"`, out-of-range): treated as missing (geocode or unplaced), never plotted at 0,0. Pinned in Task 7 (`boardCoordinates` test).

---

## File Structure

```
member-map/
  package.json  tsconfig.json  vitest.config.ts  wrangler.jsonc  README.md
  config/
    svbc.json  sandbox.json  reference.json  split.test.ts
  migrations/0001_geocodes.sql
  scripts/build-reference.mjs           # offline: writes public/data/*
  public/
    index.html  app.js  styles.css
    js/format.js  js/format.test.js     # pure popup/legend formatting
    data/blockgroups.geojson  data/epc.geojson  data/bikelanes.geojson  data/reference-meta.json
  src/
    index.ts           # Hono app + scheduled()
    environment.ts     # copy of report-digests/src/environment.ts
    config.ts          # validateConfig, MapConfig
    rateLimit.ts       # copy of report-digests/src/rateLimit.ts
    access.ts          # Access JWT gate
    score.ts           # classify(), populationRate()
    assign.ts          # block-group point index
    geocode.ts         # cache, Census batch client, resolveLocations()
    snapshot.ts        # buildSnapshot(), runRefresh()
    monday/graphql.ts  # canonical copy
    monday/client.ts   # readBoard()
    reference/lines.ts # line-length attribution used by the build script
  test/  jsonc.ts (copy from report-digests)  env.d.ts  raw-imports.d.ts (copies)  *.test.ts
```

Repo-level files touched: `.gitlab-ci.yml`, `scripts/check-monday-auth-bindings.mjs`, root
`README.md`, `CLAUDE.md`, `docs/systems-map.html`, `docs/uat/member-map.md`, `docs/uat/README.md`.

---

### Task 1: Scaffold, config and repo wiring

**Files:**
- Create: `member-map/package.json`, `tsconfig.json`, `vitest.config.ts`, `wrangler.jsonc`, `config/svbc.json`, `config/sandbox.json`, `config/reference.json`, `config/split.test.ts`, `src/environment.ts`, `src/config.ts`, `src/config.test.ts`, `src/rateLimit.ts`, `src/monday/graphql.ts`, `test/jsonc.ts`, `test/env.d.ts`, `test/raw-imports.d.ts`
- Modify: `.gitlab-ci.yml` (job `member-map`, job `deploy-sandbox:member-map`, add `member-map/src/monday/graphql.ts` to the `monday-graphql-copies` loop), `scripts/check-monday-auth-bindings.mjs` (`EXPECTED['member-map'] = 'ReadOnlyToken'`)

**Interfaces:**
- Produces:
  ```ts
  // src/config.ts
  export interface MapConfig {
    monday: { apiUrl: string; accountUrl: string };
    boards: { peopleLive: number; peopleHistorical: number; organizations: number }; // 0 = placeholder
    columns: { address: string; city: string; zip: string; lat: string; lng: string;
               membershipStatus: string; doNotSolicit: string };            // bare titles
    activeLabel: string;                                                     // "Active"
    geocoder: { url: string; benchmark: string; defaultState: string;
                batchSize: number; maxPerRun: number; retryNoMatchDays: number };
    access: { teamDomain: string; aud: string; allowedEmailDomain: string };
  }
  export function validateConfig(raw: unknown): MapConfig;
  // config/reference.json shape (imported as JSON by src and by the build script)
  // { stateFips: "06", counties: [{name:"San Mateo",fips:"081"},{name:"Santa Clara",fips:"085"}],
  //   acsYear: 2024, tigerYear: 2024, minPopulation: 100,
  //   roadMtfcc: ["S1200","S1400"], bikeClassWeights: {"1":1,"2":0.5,"3":0.2,"4":1} }
  ```
- `src/environment.ts` exports `environmentOf`, `createConfigSelector` exactly as in `report-digests`.

- [ ] **Step 1: Write `package.json`, `tsconfig.json`, `vitest.config.ts`.** Copy `report-digests`' scripts block (`test`, `dev`, `dev:sandbox`, `deploy`, `deploy:sandbox`, `typecheck`) and devDependencies. Add dependencies `hono ^4.13.3`, `jose ^6`, `@turf/boolean-point-in-polygon ^7.2.0`, `@turf/bbox ^7.2.0`, and devDependencies `@turf/turf ^7.2.0`, `shapefile ^0.6.6`, `fflate ^0.8`, `mapshaper ^0.6`. Add script `"build:reference": "node scripts/build-reference.mjs"`, and make `"test": "vitest run && node --test scripts/*.test.mjs"` so CI's `npm test` also runs the build script's tests (Task 5). Until Task 5 adds one, guard that second half with `--test-skip-pattern` or start the directory with an empty passing test file. In vitest set `include: ['src/**/*.test.ts', 'config/**/*.test.ts', 'public/js/**/*.test.js']`. In tsconfig, `include` adds `scripts` only if typecheck passes on the `.mjs`; otherwise leave scripts out.

- [ ] **Step 2: Write `wrangler.jsonc`.** Model it on `report-digests/wrangler.jsonc`, with these exact values:
  - `name: "svbc-member-map"`, `workers_dev: false`, `routes: [{ "pattern": "map.bikesiliconvalley.org", "custom_domain": true }]`
  - `assets: { "directory": "./public", "binding": "ASSETS", "run_worker_first": true }`
  - `d1_databases: [{ "binding": "DB", "database_name": "svbc-member-map", "database_id": "00000000-0000-0000-0000-000000000000", "migrations_dir": "migrations" }]` (placeholder until the operator runs `wrangler d1 create`)
  - `r2_buckets: [{ "binding": "SNAPSHOTS", "bucket_name": "svbc-member-map" }]`
  - `ratelimits: [{ "name": "REQUEST_RATE_LIMITER", "namespace_id": "2093", "simple": { "limit": 120, "period": 60 } }]`
  - `limits: { "cpu_ms": 300000 }`, `triggers.crons: ["0 13 * * 1"]`, observability as in report-digests
  - `services: [{ "binding": "MONDAY_AUTH", "service": "svbc-monday-auth", "entrypoint": "ReadOnlyToken" }]`
  - `env.sandbox`: `vars: { "ENVIRONMENT": "sandbox" }`, `workers_dev: false`, route `map.sandbox.bikesiliconvalley.org`, D1 `svbc-member-map-sandbox`, R2 `svbc-member-map-sandbox`, rate-limit namespace `2094`, the same cron/limits/assets, and the sandbox broker.
  - No `vars.ACCESS_DEV_BYPASS` anywhere. That var only ever lives in `.dev.vars`.

- [ ] **Step 3: Copy files verbatim.** Copy `report-digests/src/environment.ts`, `report-digests/src/rateLimit.ts`, `report-digests/test/jsonc.ts`, `test/env.d.ts`, `test/raw-imports.d.ts`, and `monday-backup/src/monday/graphql.ts` to `member-map/src/monday/graphql.ts`. Run `cmp monday-backup/src/monday/graphql.ts member-map/src/monday/graphql.ts`; expect no output.

- [ ] **Step 4: Write configs.** `config/sandbox.json`: `boards = { peopleLive: 18431577220, peopleHistorical: 18431577228, organizations: 18431577213 }`; `monday.apiUrl "https://api.monday.com/v2"`; `accountUrl "https://bikesiliconvalley.monday.com"`; columns `Address, City, Zip, Lat, Lng, Membership Status, Do Not Solicit`; `activeLabel "Active"`; geocoder `{ url: "https://geocoding.geo.census.gov/geocoder/locations/addressbatch", benchmark: "Public_AR_Current", defaultState: "CA", batchSize: 1000, maxPerRun: 5000, retryNoMatchDays: 90 }`; `access { teamDomain: "", aud: "", allowedEmailDomain: "bikesiliconvalley.org" }`. `config/svbc.json`: the same, with all board ids `0`. Write `config/reference.json` with the values in the Interfaces block.

- [ ] **Step 5: Write the failing tests.**

```ts
// src/config.test.ts
import sandbox from '../config/sandbox.json';
it('accepts the sandbox config', () => expect(validateConfig(sandbox).boards.peopleLive).toBe(18431577220));
it('rejects a missing column title', () => {
  const bad = structuredClone(sandbox); delete (bad.columns as any).lat;
  expect(() => validateConfig(bad)).toThrow(/columns\.lat/);
});
it('rejects a non-https teamDomain when set', () => {
  const bad = structuredClone(sandbox); bad.access.teamDomain = 'http://x.cloudflareaccess.com';
  expect(() => validateConfig(bad)).toThrow(/teamDomain/);
});
it('rejects allowedEmailDomain with an @', () => {
  const bad = structuredClone(sandbox); bad.access.allowedEmailDomain = '@bikesiliconvalley.org';
  expect(() => validateConfig(bad)).toThrow(/allowedEmailDomain/);
});

// config/split.test.ts (pattern from report-digests/config/split.test.ts)
it('both configs validate');
it('sandbox boards are the CRM Sandbox v3 ones', () =>
  expect(sandbox.boards).toEqual({ peopleLive: 18431577220, peopleHistorical: 18431577228, organizations: 18431577213 }));
it('production shares no board id with sandbox, or is a placeholder 0');
it('env.sandbox has its own D1 database_name, R2 bucket_name, rate-limit namespace and route, and the same cron');
it('workers_dev is false in both environments', () => {
  expect(wrangler.workers_dev).toBe(false); expect(sandboxEnv.workers_dev).toBe(false);
});
it('assets run the Worker first in both environments', () => {
  expect((wrangler.assets as Json).run_worker_first).toBe(true);
  expect((sandboxEnv.assets as Json).run_worker_first).toBe(true);
});
it('no ACCESS_DEV_BYPASS var is ever deployed', () => {
  expect(JSON.stringify(wrangler)).not.toContain('ACCESS_DEV_BYPASS');
});
it('production MONDAY_AUTH binds ReadOnlyToken on svbc-monday-auth; sandbox on svbc-monday-auth-sandbox');
```

- [ ] **Step 6: Run and see them fail.** `cd member-map && npm install && npm test`. Expect FAIL: `validateConfig` is not defined.

- [ ] **Step 7: Implement `validateConfig(raw: unknown): MapConfig` in `src/config.ts`.** Follow `report-digests/src/config.ts`' style: hand-written `obj`/`str`/`num` helpers and errors naming the path. Board ids are non-negative integers, and `0` is allowed. `teamDomain` may be `""` (Access not set up yet: the gate then refuses every request), and otherwise must start with `https://`.

- [ ] **Step 8: Wire CI and the auth-bindings check.** In `.gitlab-ci.yml`, add a `member-map` job extending `.worker_job`, with rules `"$WORKER_DIR/**/*"` and `scripts/lib/**/*` (as `report-digests` has). Add `deploy-sandbox:member-map` extending `.deploy_sandbox_job` with the same rules. Append `member-map/src/monday/graphql.ts` to the `monday-graphql-copies` loop and to the CLAUDE.md copies sentence. Add `'member-map': 'ReadOnlyToken'` to `EXPECTED` in `scripts/check-monday-auth-bindings.mjs`.

- [ ] **Step 9: Verify.** In `member-map`, run `npm test && npm run typecheck`; expect all pass. From the repo root, run `node scripts/check-monday-auth-bindings.mjs` and `node --test scripts/*.test.mjs`; expect exit 0.

- [ ] **Step 10: Commit.** `git add member-map .gitlab-ci.yml scripts/check-monday-auth-bindings.mjs CLAUDE.md && git commit -m "feat(member-map): scaffold Worker, config split and CI wiring"`

---

### Task 2: Access gate and routes

**Files:**
- Create: `member-map/src/access.ts`, `src/access.test.ts`, `src/index.ts`, `src/index.test.ts`

**Interfaces:**
- Consumes: `MapConfig` (Task 1), `checkRequestRateLimit` (Task 1 copy).
- Produces:
  ```ts
  // src/access.ts
  import type { JWTVerifyGetKey } from 'jose';
  export async function verifyAccess(request: Request, access: MapConfig['access'],
                                     keys: JWTVerifyGetKey): Promise<{ email: string } | null>;
  export function devBypassAllowed(request: Request, env: { ACCESS_DEV_BYPASS?: string }): boolean;
  // src/index.ts
  export interface Env { DB: D1Database; SNAPSHOTS: R2Bucket; ASSETS: Fetcher; MONDAY_AUTH: MondayTokenSource;
                         REQUEST_RATE_LIMITER: RequestRateLimiter; ENVIRONMENT?: string; ACCESS_DEV_BYPASS?: string }
  export function createApp(deps?: { keys?: JWTVerifyGetKey; refresh?: (env: Env) => Promise<void> }): Hono<{ Bindings: Env }>;
  export default { fetch, scheduled };   // scheduled filled in by Task 8
  ```

- [ ] **Step 1: Write the failing tests.** Generate an RS256 key pair in the test with `jose.generateKeyPair`, sign tokens with `new SignJWT`, and pass `async () => publicKey` as `keys`.

```ts
// src/access.test.ts
const access = { teamDomain: 'https://svbc.cloudflareaccess.com', aud: 'aud123', allowedEmailDomain: 'bikesiliconvalley.org' };
it('accepts a valid token for a staff email', async () =>
  expect(await verifyAccess(req(tok({ email: 'pat@bikesiliconvalley.org' })), access, keys)).toEqual({ email: 'pat@bikesiliconvalley.org' }));
it('accepts uppercase domain', ...'Pat@BikeSiliconValley.org' → not null);
it('rejects another domain', ...'pat@gmail.com' → null);
it('rejects a look-alike domain', ...'pat@evilbikesiliconvalley.org' → null);
it('rejects wrong aud', ...aud 'other' → null);
it('rejects wrong issuer', ...iss 'https://other.cloudflareaccess.com' → null);
it('rejects expired', ...exp in the past → null);
it('rejects a missing header', ... → null);
it('rejects everything when teamDomain or aud is empty', ...{...access, aud: ''} → null);
it('dev bypass needs both the var and a localhost URL', () => {
  expect(devBypassAllowed(new Request('http://localhost:8787/'), { ACCESS_DEV_BYPASS: '1' })).toBe(true);
  expect(devBypassAllowed(new Request('https://map.bikesiliconvalley.org/'), { ACCESS_DEV_BYPASS: '1' })).toBe(false);
  expect(devBypassAllowed(new Request('http://localhost:8787/'), {})).toBe(false);
});

// src/index.test.ts (fake ASSETS returns 200 'asset', fake SNAPSHOTS bucket, limiter always succeeds)
it('403s an asset path without a token', async () => expect((await get('/index.html')).status).toBe(403));
it('403s /data/blockgroups.geojson without a token', ... 403);
it('403s /api/snapshot without a token', ... 403);
it('serves an asset with a valid token', ... 200 and body 'asset');
it('/api/snapshot returns the R2 object with private no-store', async () => {
  const res = await get('/api/snapshot', valid); expect(res.status).toBe(200);
  expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  expect(res.headers.get('Content-Type')).toContain('application/json');
});
it('/api/snapshot is 503 before the first build', ... empty bucket → 503);
it('POST /api/refresh starts a refresh and returns 202', ... refresh spy called once);
it('POST /api/refresh is 429 within 10 minutes of the last snapshot', ... uploaded 5 min ago → 429, spy not called);
it('rate-limits before the Access check', ... limiter false → 429);
```

- [ ] **Step 2: Run and see them fail.** `npm test -- src/access.test.ts src/index.test.ts`. Expect FAIL: module not found.

- [ ] **Step 3: Implement `verifyAccess`.** Read header `Cf-Access-Jwt-Assertion`. Return `null` if the header, `teamDomain` or `aud` is missing. Call `jwtVerify(token, keys, { issuer: teamDomain, audience: aud })`. The email check is the lowercased `payload.email` ending with `'@' + allowedEmailDomain.toLowerCase()`. Catch every error and return `null`. In production, `keys` is `createRemoteJWKSet(new URL(teamDomain + '/cdn-cgi/access/certs'))`, memoized per isolate.

- [ ] **Step 4: Implement `createApp`.** Order of operations: rate limit, then the Access gate (dev bypass, else `verifyAccess`; on failure return `403 'Forbidden'`, logging no identity), then routes:
  - `GET /api/snapshot`: `SNAPSHOTS.get('snapshot.json')`, 503 JSON `{ error: 'no snapshot yet' }` when missing
  - `POST /api/refresh`: 429 if `snapshot.json`'s `uploaded` is under 10 min ago, else `executionCtx.waitUntil(refresh(env))` and 202
  - everything else: `env.ASSETS.fetch(request)`

  Every response from the two API routes sets `Cache-Control: private, no-store`. The default `refresh` is a stub that throws `not implemented` until Task 8.

- [ ] **Step 5: Run and see them pass.** `npm test && npm run typecheck`; expect PASS.

- [ ] **Step 6: Commit.** `git commit -m "feat(member-map): Cloudflare Access JWT gate in front of assets and API"`

---

### Task 3: Gap scoring

**Files:**
- Create: `member-map/src/score.ts`, `src/score.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type GapClass = 0 | 1 | 2 | 3 | null;   // 3 = biggest gap, 0 = no gap (unshaded), null = unscored
  export type Direction = 'low-is-gap' | 'high-is-gap';
  export function classify(values: (number | null)[], direction: Direction): GapClass[];
  export function populationRate(members: number, population: number, minPopulation: number): number | null; // members per 1,000
  export function quantile(sorted: number[], p: number): number;  // linear interpolation, p in [0,1]
  ```

Breaks are computed over the non-null values only. For `low-is-gap`: `v <= q(0.2)` → 3, `<= q(0.4)` → 2, `<= q(0.6)` → 1, else 0. For `high-is-gap`: `v >= q(0.8)` → 3, `>= q(0.6)` → 2, `>= q(0.4)` → 1, else 0, and a value of `0` is always class 0 (no warm leads is never a warm-lead gap). Classes are checked worst-first, so ties at a break take the worse class.

- [ ] **Step 1: Write the failing tests.**

```ts
it('low-is-gap: bottom fifth is 3, top 40% unshaded', () =>
  expect(classify([1,2,3,4,5,6,7,8,9,10], 'low-is-gap')).toEqual([3,3,2,2,1,1,0,0,0,0]));
it('high-is-gap mirrors it', () =>
  expect(classify([1,2,3,4,5,6,7,8,9,10], 'high-is-gap')).toEqual([0,0,0,0,1,1,2,2,3,3]));
it('nulls stay null and do not move the breaks', () =>
  expect(classify([null,1,2,3,4,5,6,7,8,9,10,null], 'low-is-gap')).toEqual([null,3,3,2,2,1,1,0,0,0,0,null]));
it('zero warm leads is never a gap', () =>
  expect(classify([0,0,0,0,0,0,0,0,1,2], 'high-is-gap').slice(0,8)).toEqual([0,0,0,0,0,0,0,0]));
it('many zero-member block groups all land in the worst class', () =>
  expect(classify([0,0,0,0,0,1,2,3,4,5], 'low-is-gap').slice(0,5)).toEqual([3,3,3,3,3]));
it('all-null input', () => expect(classify([null,null], 'low-is-gap')).toEqual([null,null]));
it('populationRate is per 1,000 and null under the minimum', () => {
  expect(populationRate(6, 4200, 100)).toBeCloseTo(1.4286, 4);
  expect(populationRate(3, 99, 100)).toBeNull();
});
```

- [ ] **Step 2: Run, expect FAIL** (module not found).
- [ ] **Step 3: Implement** in strip-only TS (no enums). `quantile` uses the type-7 linear interpolation.
- [ ] **Step 4: Run, expect PASS.** Also run `node --input-type=module -e "await import('./src/score.ts')"` from `member-map`; expect exit 0 (proves the script can strip-import it).
- [ ] **Step 5: Commit** `feat(member-map): quantile gap classes`

---

### Task 4: Line-length attribution helpers

**Files:**
- Create: `member-map/src/reference/lines.ts`, `src/reference/lines.test.ts`

**Interfaces:**
- Produces (GeoJSON types from `geojson`; implementation uses `@turf/turf` `lineSplit`, `polygonToLine`, `along`, `length`, `booleanPointInPolygon`, `bbox`):
  ```ts
  export function lineMiles(coords: [number, number][]): number;   // haversine, R = 3958.8, same as svbc-bike-lanes
  export type Poly = Feature<Polygon | MultiPolygon, { GEOID: string }>;
  export function milesByPolygon(lines: Feature<LineString | MultiLineString>[], polys: Poly[]): Map<string, number>;
  export function dropInside(lines: Feature<LineString | MultiLineString>[], area: Feature<Polygon | MultiPolygon>):
    Feature<LineString>[];                 // pieces whose midpoint lies outside `area`
  export function weightedMiles(byClass: Record<'1'|'2'|'3'|'4', number>, weights: Record<'1'|'2'|'3'|'4', number>): number;
  ```

Algorithm for `milesByPolygon`: for each line, take the polygons whose bbox intersects its bbox.
For each such polygon, split the line by `polygonToLine(polygon)`, and add each piece's
`lineMiles` to that polygon's GEOID when the piece's midpoint (`along` at half its length) is
inside the polygon. A piece is credited only to the polygon it lies in, so every mile is counted
once.

- [ ] **Step 1: Write the failing tests** using two unit squares sharing an edge (`A` = [0,0]–[0.01,0.01], `B` = [0.01,0]–[0.02,0.01]).

```ts
it('lineMiles matches haversine for 0.01° of latitude', () => expect(lineMiles([[0,0],[0,0.01]])).toBeCloseTo(0.6909, 3));
it('a line crossing the shared edge is split between both squares', () => {
  const m = milesByPolygon([line([[0.005,0.005],[0.015,0.005]])], [A, B]);
  expect(m.get('A')).toBeCloseTo(lineMiles([[0.005,0.005],[0.01,0.005]]), 4);
  expect(m.get('B')).toBeCloseTo(lineMiles([[0.01,0.005],[0.015,0.005]]), 4);
});
it('totals equal the line length when fully covered', ...sum of map ≈ lineMiles(whole));
it('a line lying along the shared edge is counted at most once', ...sum ≤ its length + 1e-9);
it('a line outside every polygon adds nothing', ...map.size === 0);
it('handles MultiLineString');
it('dropInside removes only the part inside the area', ...returns piece from x=0.01 to 0.015 for area A);
it('weightedMiles applies the class weights', () =>
  expect(weightedMiles({ '1': 1, '2': 2, '3': 5, '4': 1 }, { '1': 1, '2': 0.5, '3': 0.2, '4': 1 })).toBeCloseTo(4, 6));
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** (strip-only TS).
- [ ] **Step 4: Run, expect PASS.** Also run `node --input-type=module -e "await import('./src/reference/lines.ts')"`; expect exit 0.
- [ ] **Step 5: Commit** `feat(member-map): split bike and road lengths at block-group edges`

---

### Task 5: Reference data build

**Files:**
- Create: `member-map/src/reference/types.ts` (exports `BlockGroupProps` below, for Task 8), `member-map/scripts/build-reference.mjs`, `scripts/acs.mjs` + `scripts/acs.test.mjs` (pure ACS parsing), and the generated `public/data/blockgroups.geojson`, `public/data/epc.geojson`, `public/data/bikelanes.geojson`, `public/data/reference-meta.json` (committed: all public data)

**Interfaces:**
- Consumes: `config/reference.json`, `lineMiles`/`milesByPolygon`/`dropInside`/`weightedMiles` (Task 4), `classify` (Task 3)
- Produces:
  ```ts
  // public/data/blockgroups.geojson: FeatureCollection<Polygon|MultiPolygon, BlockGroupProps>
  interface BlockGroupProps {
    GEOID: string;                 // 12-digit block group id
    population: number;            // ACS B01003_001E
    medianIncome: number | null;   // ACS B19013_001E; negative sentinel → null
    epc: boolean;                  // the tract (GEOID.slice(0, 11)) is an MTC Equity Priority Community
    roadMiles: number;
    bikeMiles: { '1': number; '2': number; '3': number; '4': number };
    weightedBikeMiles: number;
    bikeDensity: number | null;    // weightedBikeMiles / roadMiles; null when roadMiles === 0
    bikeClass: GapClass;           // classify(bikeDensity over all BGs, 'low-is-gap')
  }
  // public/data/bikelanes.geojson: FeatureCollection<LineString, { class: 1|2|3|4 }>
  // public/data/epc.geojson: FeatureCollection<Polygon|MultiPolygon, { tract: string }>
  // public/data/reference-meta.json: { builtAt: string; sources: { name: string; url: string; vintage: string }[] }
  // scripts/acs.mjs
  export function acsValue(raw: string | number | null): number | null;   // negative or non-numeric → null
  export function parseAcsRows(json: string[][]): Map<string, { population: number; medianIncome: number | null }>; // key = state+county+tract+block group
  ```

**Sources** (the script pages ArcGIS queries with `resultOffset`/`resultRecordCount` until `exceededTransferLimit` is false):
- Block groups: `https://www2.census.gov/geo/tiger/GENZ{tigerYear}/shp/cb_{tigerYear}_06_bg_500k.zip`, filtered to `COUNTYFP ∈ {081, 085}`.
- ACS: `https://api.census.gov/data/{acsYear}/acs/acs5?get=B01003_001E,B19013_001E&for=block%20group:*&in=state:06&in=county:{fips}&in=tract:*`, one call per county.
- Roads: `https://www2.census.gov/geo/tiger/TIGER{tigerYear}/ROADS/tl_{tigerYear}_06{fips}_roads.zip`, keeping `MTFCC ∈ roadMtfcc`.
- San Jose boundary: `cb_{tigerYear}_06_place_500k.zip`, `GEOID = 0668000`.
- Bike, MTC: `https://services3.arcgis.com/i2dkYWmb4wHvYPda/arcgis/rest/services/regional_bike_facilities/FeatureServer/0/query`, envelope = the two counties' combined bbox, `outFields=class,OBJECTID`, `outSR=4326`, deduplicated by `OBJECTID`.
- Bike, San Jose: `https://geo.sanjoseca.gov/server/rest/services/OPN/OPN_OpenDataService/MapServer/418/query`, `where=STATUS='Existing'`, class from `EXISTINGBIKEWAYCLASS` via the `classMapping` in `svbc-bike-lanes/_data/supplementalSources.js` (port the whole San Jose entry, including any other classes it maps).
- EPC: MTC's current Plan Bay Area "Equity Priority Communities" layer on `opendata.mtc.ca.gov`. Find the FeatureServer URL and the tract-id and EPC-flag fields from the dataset page, and record them in `reference-meta.json`.

**Plan call:** roads are limited to `S1200` (secondary) and `S1400` (local) rather than "everything except `S1100`/`S1630`". TIGER also carries driveways, parking-lot roads, private roads and alleys (`S1740`, `S1780`, `S1730`), which would inflate the denominator. This is the same reason the spec gives for preferring TIGER over OSM.

- [ ] **Step 1: Write the failing `scripts/acs.test.mjs`** (`node:test`).

```js
test('suppressed income becomes null', () => assert.equal(acsValue('-666666666'), null));
test('other negative sentinels become null', () => assert.equal(acsValue('-222222222'), null));
test('numbers parse', () => assert.equal(acsValue('62000'), 62000));
test('rows key by full block-group GEOID', () => {
  const m = parseAcsRows([['B01003_001E','B19013_001E','state','county','tract','block group'],
                          ['4200','-666666666','06','085','500100','1']]);
  assert.deepEqual(m.get('060855001001'), { population: 4200, medianIncome: null });
});
```

- [ ] **Step 2: Run `node --test scripts/acs.test.mjs`, expect FAIL.**
- [ ] **Step 3: Implement `scripts/acs.mjs`; run, expect PASS.**
- [ ] **Step 4: Implement `scripts/build-reference.mjs`.** Download zips with `fetch`, unzip with `fflate`, read with `shapefile.read`. Join ACS and EPC. Remove MTC pieces inside San Jose with `dropInside`, then add San Jose's lines. Run `milesByPolygon` per class and for roads, and apply `weightedMiles` and `classify`. Simplify the polygons with mapshaper (`-simplify 15% keep-shapes planar`, topology-preserving, so neighbors share edges) and the bike lines with `-simplify 30%`. Round coordinates to 6 decimals. Write the four files. Print a summary: block-group count, total population, road miles, bike miles per class, count of EPC block groups.
- [ ] **Step 5: Run `npm run build:reference`.** Expected sanity ranges:
  - block groups: 1,400–1,800
  - total population: 2.4M–2.9M
  - EPC block groups: more than 0 and fewer than half
  - total bike miles per class: within 10% of the latest totals in `../../svbc-bike-lanes/_data/history.json` (sibling repo; open it and compare)
  - largest file under 8 MB

  If the bike totals differ by more than 10%, investigate before continuing. Note that `svbc-bike-lanes`' own MTC query (`_data/bikelanes.js` `queryBikeFacilities`) doesn't page, so it may be the one undercounting. Report the comparison either way.
- [ ] **Step 6: Commit** the script, the tests and the generated `public/data/*`: `feat(member-map): reference data build (block groups, ACS, EPC, roads, bike lanes)`

---

### Task 6: Monday board reader

**Files:**
- Create: `member-map/src/monday/client.ts`, `src/monday/client.test.ts`

**Interfaces:**
- Consumes: `MondayGraphQL`, `tokenProviderFor`, `MONDAY_API_VERSION` (graphql.ts copy); `bareTitle` (`../../../scripts/lib/column-titles.mjs`); `MapConfig['columns']`
- Produces:
  ```ts
  export type BoardKey = 'peopleLive' | 'peopleHistorical' | 'organizations';
  export interface BoardRecord {
    itemId: string; boardId: number; board: BoardKey; name: string;
    address: string | null; city: string | null; zip: string | null;
    lat: string | null; lng: string | null;
    membershipStatus: string | null;   // null on Organizations (column absent) or blank
    doNotSolicit: boolean;             // false when the column is absent
  }
  export interface MapMondayClient { readBoard(board: BoardKey, boardId: number, columns: MapConfig['columns']): Promise<BoardRecord[]> }
  export class HttpMondayClient implements MapMondayClient { constructor(apiUrl: string, token: string | TokenProvider, options?: MondayGraphQLOptions) }
  ```

Transport options: `{ maxAttempts: 4, requestTimeoutMs: 30_000 }`, as in report-digests (a cron
with no queue behind it). Read the board's columns once, then page `items_page(limit: 500)` /
`next_items_page`, requesting only the resolved column ids. `address`, `city`, `zip`, `lat` and
`lng` are required on every board: a missing one throws `member-map: board <id> has no "<title>"
column`. `membershipStatus` and `doNotSolicit` are optional. A checkbox's `text` is `"v"` when
checked.

- [ ] **Step 1: Write the failing tests** with a fake transport (pattern: `report-digests/test/fakeMonday.ts`).

```ts
it('matches columns through bareTitle (🔒 Lat → Lat)', ...record.lat === '37.33');
it('pages until the cursor is null', ...3 pages × 2 items → 6 records);
it('blank text is null', ...address '' → null);
it('Organizations without Membership Status/Do Not Solicit read as null/false');
it('Do Not Solicit "v" → true');
it('throws naming the board when Lat is missing', ...rejects /has no "Lat" column/);
```

- [ ] **Step 2: Run, expect FAIL. Step 3: Implement. Step 4: Run, expect PASS** (`npm test && npm run typecheck`).
- [ ] **Step 5: Commit** `feat(member-map): read People and Organizations for the map`

---

### Task 7: Private geocoding

**Files:**
- Create: `member-map/migrations/0001_geocodes.sql`, `src/geocode.ts`, `src/geocode.test.ts`

**Interfaces:**
- Consumes: `BoardRecord` (Task 6), `MapConfig['geocoder']`
- Produces:
  ```ts
  export interface LatLng { lat: number; lng: number }
  export interface GeocodeRow { itemId: string; addressHash: string; status: 'match' | 'nomatch';
                                lat: number | null; lng: number | null; geocodedAt: string }
  export interface GeocodeStore { getMany(itemIds: string[]): Promise<Map<string, GeocodeRow>>; putMany(rows: GeocodeRow[]): Promise<void> }
  export class D1GeocodeStore implements GeocodeStore { constructor(db: D1Database) }
  export interface BatchInput { id: string; street: string; city: string; state: string; zip: string }
  export interface Geocoder { geocode(rows: BatchInput[]): Promise<Map<string, LatLng | null>> }
  export class CensusGeocoder implements Geocoder { constructor(cfg: MapConfig['geocoder']) }
  export function boardCoordinates(lat: string | null, lng: string | null): LatLng | null;
  export function normalizeAddress(r: Pick<BoardRecord, 'address' | 'city' | 'zip'>): string | null;
  export async function addressHash(normalized: string): Promise<string>;         // SHA-256 hex via crypto.subtle
  export function buildBatchCsv(rows: BatchInput[]): string;
  export function parseBatchResponse(csv: string): Map<string, LatLng | null>;
  export async function resolveLocations(records: BoardRecord[], store: GeocodeStore, geocoder: Geocoder,
      cfg: MapConfig['geocoder'], now: Date): Promise<{ located: Map<string, LatLng>; unplaced: number; geocoded: number }>;
  ```

`migrations/0001_geocodes.sql`:
```sql
CREATE TABLE geocodes (
  item_id      TEXT PRIMARY KEY,
  address_hash TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('match', 'nomatch')),
  lat          REAL,
  lng          REAL,
  geocoded_at  TEXT NOT NULL
);
```

Rules for `resolveLocations`, per record:
1. Valid board coordinates win, with no lookup.
2. Otherwise, with no usable address, the record is unplaced.
3. Otherwise a cache row with the same hash and status `match` is used.
4. A cache row with the same hash and status `nomatch`, younger than `retryNoMatchDays`, is unplaced and not re-sent.
5. Anything else is queued for geocoding.

Send at most `maxPerRun` queued records, in batches of `batchSize`. Records beyond the cap are
unplaced this run and are tried first next run, since the cache doesn't have them yet. Write every
result (match or nomatch) to the store. A batch that throws is logged as a count and its records
count as unplaced. The run continues.

`boardCoordinates` validity: both values parse as finite numbers, lat is in [-90, 90], lng is in
[-180, 180], and the point is not 0,0.

`normalizeAddress`: `null` when the address is blank. Otherwise trim and lowercase the address,
city and zip, collapse whitespace, cut the zip to 5 digits, and join with `|`.

Census batch format: request lines are `id,street,city,state,zip`, with fields quoted per
RFC 4180, as a multipart `addressFile` (`batch.csv`) plus field `benchmark`. Response lines are
`"id","input","Match"|"No_Match"|"Tie","Exact"|"Non_Exact","matched address","lon,lat","tigerId","side"`.

- [ ] **Step 1: Write the failing tests.**

```ts
it('boardCoordinates rejects junk', () => {
  for (const [a, b] of [['',''],['0','0'],['abc','-121.9'],['95','-121.9'],['37.3','-200']])
    expect(boardCoordinates(a, b)).toBeNull();
  expect(boardCoordinates('37.33', '-121.89')).toEqual({ lat: 37.33, lng: -121.89 });
});
it('parseBatchResponse reads "lon,lat" in that order', () => {
  const m = parseBatchResponse('"17","1 Main St, San Jose, CA, 95113","Match","Exact","1 MAIN ST, SAN JOSE, CA, 95113","-121.8863,37.3382","123","L"\n');
  expect(m.get('17')).toEqual({ lat: 37.3382, lng: -121.8863 });
});
it('No_Match and Tie are null', ...both → null);
it('buildBatchCsv quotes a comma in the street', () =>
  expect(buildBatchCsv([{ id: '1', street: '10 A St, Apt 2', city: 'San Jose', state: 'CA', zip: '95113' }]))
    .toBe('1,"10 A St, Apt 2",San Jose,CA,95113\n'));
it('normalizeAddress cuts ZIP+4 and is case-insensitive', () =>
  expect(normalizeAddress({ address: ' 1  Main St ', city: 'SAN JOSE', zip: '95113-1234' })).toBe('1 main st|san jose|95113'));
it('board coordinates win and are never sent', ...geocoder spy not called);
it('an unchanged cached address is not re-sent', ...cache hit with same hash → no geocode, located);
it('a changed address is re-geocoded', ...cache hash differs → sent once, store updated);
it('a recent nomatch is not retried; an old one is', ...89 days → not sent; 91 days → sent);
it('respects maxPerRun and batchSize', ...12 queued, maxPerRun 10, batchSize 4 → batches [4,4,2], 2 unplaced);
it('a failing batch leaves its records unplaced and the run continues');
it('no address and no coordinates → unplaced, not sent');
```

- [ ] **Step 2: Run, expect FAIL. Step 3: Implement. Step 4: Run, expect PASS.**
- [ ] **Step 5: Run `node ../scripts/check-log-safety.mjs`** from `member-map`; expect exit 0.
- [ ] **Step 6: Commit** `feat(member-map): private Census geocoding for rows without Lat/Lng`

---

### Task 8: Snapshot build, cron and refresh

**Files:**
- Create: `member-map/src/assign.ts`, `src/assign.test.ts`, `src/snapshot.ts`, `src/snapshot.test.ts`
- Modify: `src/index.ts` (real `refresh`, `scheduled`)

**Interfaces:**
- Consumes: `classify`, `populationRate`, `GapClass` (Task 3); `MapMondayClient`, `BoardRecord`, `BoardKey` (Task 6); `resolveLocations`, `GeocodeStore`, `Geocoder`, `LatLng` (Task 7); `BlockGroupProps` (Task 5); `config/reference.json`
- Produces:
  ```ts
  // src/assign.ts
  export interface BlockGroupIndex { find(lng: number, lat: number): string | null }
  export function buildIndex(fc: FeatureCollection<Polygon | MultiPolygon, { GEOID: string }>): BlockGroupIndex; // bbox grid + point-in-polygon
  // src/snapshot.ts
  export type PointKind = 'member' | 'lapsed' | 'never' | 'org';
  export interface SnapshotPoint { id: string; boardId: number; name: string; lat: number; lng: number; kind: PointKind; dns: boolean }
  export interface BlockGroupCounts { members: number; lapsed: number; never: number; popClass: GapClass; leadClass: GapClass }
  export interface Snapshot { asOf: string; accountUrl: string; unplaced: number; outsideArea: number;
                              blockGroups: Record<string, BlockGroupCounts>; points: SnapshotPoint[] }
  export function kindOf(r: BoardRecord, activeLabel: string): PointKind;
  export function buildSnapshot(records: BoardRecord[], located: Map<string, LatLng>, unplaced: number,
      index: BlockGroupIndex, reference: BlockGroupProps[], cfg: MapConfig, minPopulation: number, now: Date): Snapshot;
  export async function runRefresh(deps: { monday: MapMondayClient; store: GeocodeStore; geocoder: Geocoder;
      assets: Fetcher; bucket: R2Bucket; config: MapConfig; now: Date }): Promise<Snapshot>;
  ```

`kindOf`: Organizations → `org`. Membership Status equal to `activeLabel` → `member`. `Lapsed`
→ `lapsed`. Anything else (blank included) → `never`.

Counts per block group: `members` = `member` points, `lapsed`, `never`. Organizations are not
counted. Every GEOID in the reference data appears, zero-filled.

`popClass` = `classify(populationRate(members, population, minPopulation), 'low-is-gap')`.
`leadClass` = `classify(lapsed + never, 'high-is-gap')`, also `null` where population <
`minPopulation`.

A located point outside every block group still appears in `points`, adds 1 to `outsideArea`,
and counts nowhere.

`runRefresh` skips any board whose id is `0` (logs `member-map: <board> board id not configured`).
It reads `/data/blockgroups.geojson` with `assets.fetch('https://assets.local/data/blockgroups.geojson')`,
writes `snapshot.json` to R2 with `httpMetadata.contentType = 'application/json'`, and logs
counts only: records, located, geocoded, unplaced, outsideArea.

- [ ] **Step 1: Write the failing tests.**

```ts
// assign.test.ts (two squares from Task 4's fixture)
it('finds the containing block group', () => expect(idx.find(0.005, 0.005)).toBe('A'));
it('returns null outside', () => expect(idx.find(1, 1)).toBeNull());
it('handles MultiPolygon and holes', ...point in a hole → null);

// snapshot.test.ts
it('kindOf maps Active/Lapsed/blank/org', ...);
it('counts members, lapsed and never per block group; orgs not counted');
it('every reference GEOID appears, zero-filled');
it('a block group under 100 residents has null popClass and leadClass');
it('a 4,200-resident block group with 0 members is a population gap', ...popClass 3 when others have members);
it('points outside every block group count in outsideArea, not in blockGroups');
it('unplaced is passed through');
it('asOf is now.toISOString() and accountUrl comes from config');
it('runRefresh skips board id 0 and writes snapshot.json to the bucket', ...fake bucket put called once with JSON);
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement `assign.ts` and `snapshot.ts`.** Then, in `src/index.ts`, replace the `refresh` stub with `runRefresh` wired to `HttpMondayClient(cfg.monday.apiUrl, tokenProviderFor(env))`, `D1GeocodeStore(env.DB)`, `CensusGeocoder(cfg.geocoder)`, `env.ASSETS` and `env.SNAPSHOTS`. `scheduled` calls the same function through `ctx.waitUntil`.
- [ ] **Step 4: Run, expect PASS** (`npm test && npm run typecheck`, plus `node ../scripts/check-log-safety.mjs`).
- [ ] **Step 5: Commit** `feat(member-map): weekly snapshot of member points and gap classes`

---

### Task 9: The map page

**Files:**
- Create: `member-map/public/index.html`, `public/app.js`, `public/styles.css`, `public/js/format.js`, `public/js/format.test.js`, `test/fixtures/snapshot.json` (synthetic: about 30 points with made-up names across a few real GEOIDs, including one `<b>x</b>` name; no real people)

**Interfaces:**
- Consumes: `GET /api/snapshot` (`Snapshot`, Task 8), `/data/*.geojson` (Task 5)
- Produces (`public/js/format.js`, plain ES module):
  ```js
  export function escapeHtml(s) {}                           // & < > " '
  export function mondayUrl(accountUrl, boardId, itemId) {}  // `${accountUrl}/boards/${boardId}/pulses/${itemId}`
  export function blockGroupSummary(props, counts) {}        // string; see test
  export function statusLine(snapshot) {}                    // "Data as of Nov 2, 2026 · 212 people with no usable address"
  ```

Page behavior:
- Leaflet 1.9.4 from cdnjs with SRI `integrity` and `crossorigin`, and `preferCanvas: true`.
- OSM tiles from `https://tile.openstreetmap.org/{z}/{x}/{y}.png` with attribution `© OpenStreetMap contributors` and `maxZoom: 19`, starting fit to the two counties.
- A layer panel with a radio group "Shading": Population gap (default) / Warm-lead gap / Bike lane density / None.
- Checkboxes: Equity Priority Communities (on), Members (on), Warm leads (off), Organizations (off), Bike lanes (off).
- Fill colors for classes 1–3: `#fdd0a2`, `#fd8d3c`, `#d94801` at 0.6 opacity. Class 0 or `null`: no fill, a hairline grey border only.
- EPC: a `#5b21b6` 3px outline, no fill.
- Dots (radius 4): members `#1d4ed8`, warm leads `#0f766e`, organizations `#15803d` square markers.
- Bike lanes by class: I `#166534`, IV `#16a34a`, II `#65a30d`, III `#a3a3a3` dashed.
- A legend explains the current shading in plain words, e.g. "Darker = fewer members per resident. Unshaded: no gap, or under 100 residents." The status line sits at the top.
- Block-group click → popup with `blockGroupSummary`. Dot click → popup with the escaped name, the kind label ("Member", "Lapsed member", "Never a member", "Organization"), "Do Not Solicit" when `dns`, and an "Open in Monday" link (`target="_blank" rel="noopener"`).
- Every string from Monday passes through `escapeHtml`.
- A snapshot 503 shows "No data yet. The first weekly refresh hasn't run." with a "Refresh now" button that POSTs `/api/refresh`.
- Phone width: the panel collapses behind a button. No horizontal scroll.

- [ ] **Step 1: Write the failing `public/js/format.test.js`** (vitest).

```js
it('escapes HTML in names', () => expect(escapeHtml('<img src=x onerror="a()">')).toBe('&lt;img src=x onerror=&quot;a()&quot;&gt;'));
it('builds the Monday link', () =>
  expect(mondayUrl('https://bikesiliconvalley.monday.com', 18431577220, '123')).toBe('https://bikesiliconvalley.monday.com/boards/18431577220/pulses/123'));
it('summarizes a block group', () => expect(blockGroupSummary(
  { population: 4200, medianIncome: 62000, epc: true, roadMiles: 10, weightedBikeMiles: 1.8, bikeDensity: 0.18,
    bikeMiles: { '1': 0.5, '2': 1.2, '3': 0.4, '4': 0.3 } },
  { members: 6, lapsed: 31, never: 7 }))
  .toBe('4,200 residents · 6 members · 38 warm leads (31 lapsed, 7 never members) · median household income $62k · Equity Priority Community · bike facilities on 18% of street miles (weighted; 2.4 mi, 0.3 mi Class IV)'));
it('suppressed income reads "median income not reported"', ...medianIncome null);
it('no roads reads "no street miles"', ...bikeDensity null);
it('statusLine', () => expect(statusLine({ asOf: '2026-11-02T13:00:00Z', unplaced: 212 }))
  .toBe('Data as of Nov 2, 2026 · 212 people with no usable address'));
```

- [ ] **Step 2: Run `npm test -- public/js`, expect FAIL.**
- [ ] **Step 3: Implement `format.js`, then `index.html`, `styles.css` and `app.js`.** Set colors as CSS custom properties on `:root`, with a dark-mode panel under `prefers-color-scheme: dark`. The map tiles stay light.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Verify in the browser.** Create a fixture snapshot from the test data. Then:
  ```bash
  npx wrangler r2 object put svbc-member-map/snapshot.json --file test/fixtures/snapshot.json --local
  ```
  Run `npm run dev` with `ACCESS_DEV_BYPASS=1` in `.dev.vars`, open `http://localhost:8787/`, and confirm:
  - each shading option renders and the legend changes
  - a block-group popup shows the summary line
  - a dot popup links to Monday
  - a name containing `<b>x</b>` shows literally
  - at 375px width there's no horizontal scroll

  Take a screenshot for the MR.
- [ ] **Step 6: Commit** `feat(member-map): Leaflet map with gap shading, EPC outline, dots and bike lanes`

---

### Task 10: Documentation and deployment notes

**Files:**
- Create: `member-map/README.md`, `docs/uat/member-map.md`
- Modify: root `README.md` (status table row; the sandbox Workers list), `CLAUDE.md` (sandbox Worker list; graphql copies list if not done in Task 1; note `member-map` carries no write switch because it never writes), `docs/systems-map.html` (one row, "as of" date), `docs/uat/README.md` (index entry)

- [ ] **Step 1: Write `member-map/README.md`.** Cover:
  - what it is and who it's for
  - the layers
  - data flow (the diagram from the spec)
  - config keys
  - a link to the reference build and when to re-run it
  - **Cloudflare Access setup**: spec steps 1–4 verbatim, plus where the team domain and AUD go (`config/*.json` `access`)
  - **Provisioning**: `npx wrangler d1 create svbc-member-map[-sandbox]` (put the ids in `wrangler.jsonc`), `npx wrangler d1 migrations apply ... --remote [--env sandbox]`, `npx wrangler r2 bucket create svbc-member-map[-sandbox]`, `npm run deploy:sandbox`, then `POST /api/refresh` from a signed-in browser
  - local dev with `ACCESS_DEV_BYPASS=1` in `.dev.vars` (localhost only)
  - the privacy notes: exact addresses, Access-only, no logs of PII, geocoding sends addresses only to the Census geocoder the migration already used
- [ ] **Step 2: Write `docs/uat/member-map.md`** in the style of `docs/uat/report-digests.md` (if it doesn't exist, use `docs/uat/member-portal.md`). It's a plain-language script for a staff tester: sign in, switch shadings, open a neighborhood, open a member in Monday, confirm a non-staff Google account is refused.
- [ ] **Step 3: Update the root README status row**: "Built, not deployed. Blocked on the Cloudflare Access setup (Zero Trust org, Google Workspace IdP, two Access applications), D1/R2 provisioning, and production board ids". Also update `CLAUDE.md` and `docs/systems-map.html`.
- [ ] **Step 4: Verify.** `cd member-map && npm test && npm run typecheck`; from the root, `node scripts/check-log-safety.mjs && node scripts/check-monday-auth-bindings.mjs`; all exit 0.
- [ ] **Step 5: Commit** `docs(member-map): README, Access setup, UAT script, status rows`
