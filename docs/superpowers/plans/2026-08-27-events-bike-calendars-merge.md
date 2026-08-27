# events-widgets + bike-calendars merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse three overlapping SVBC public-calendar deployables (`events-widgets`, `committee-calendars`, and the standalone `bike-calendars` project) into one Cloudflare Worker, `svbc-calendars`, sharing one implementation per data source.

**Architecture:** One Worker (`svbc-calendars/`, renamed from `events-widgets/`) serving `/events` and `/widget` (unchanged, live Eventbrite proxy) plus new `/calendars/:id.ics`, `/calendars`, and `/status.json` routes for the 9 calendar sources. `caches.default` fronts every route; a new KV namespace stores the last-successfully-generated ICS and failure-streak status per source so a source's live fetch failing doesn't error the route — it serves the last-known-good feed instead. A daily Cron Trigger proactively warms all 9 sources regardless of traffic. `committee-calendars` (Worker + D1) is deleted once the merged Worker is verified live.

**Tech Stack:** TypeScript, Cloudflare Workers (no framework — hand-rolled routing, matching `events-widgets`' existing style), Vitest + `@cloudflare/vitest-pool-workers`, `ics` (ICS generation), `ical.js` (ICS parsing for the CivicPlus/Caltrain adapters), Cloudflare KV, Cloudflare Workers Analytics Engine, Cloudflare Web Analytics.

**Spec:** [docs/superpowers/specs/2026-08-27-events-bike-calendars-merge-design.md](../specs/2026-08-27-events-bike-calendars-merge-design.md)

## Global Constraints

- TypeScript with `@cloudflare/workers-types`; Wrangler handles transpilation, no separate build step.
- Tests via Vitest + `@cloudflare/vitest-pool-workers` (miniflare-backed); existing `events-widgets` tests use `globalThis.fetch = vi.fn()` for outbound mocking and `cloudflare:test`'s `createExecutionContext`/`waitOnExecutionContext` for calling the Worker — new route tests follow the same pattern.
- SVBC-specific values (organizer IDs, committee names, body IDs) live in `config/sources.json`, validated at startup — never hardcoded in source (per this repo's config-not-hardcoding convention).
- Secrets (`EVENTBRITE_TOKEN`, `SLACK_WEBHOOK_URL`) are set via `wrangler secret put`, never committed.
- Conventional commits; commit after every task (or every 2-3 steps within a large task).
- All work happens in this worktree (`monday-workers-events-bike-calendars`, branch `feat/events-bike-calendars-merge`) — already created.

---

## Task 1: Rename `events-widgets/` to `svbc-calendars/`

**Files:**
- Rename (git mv): `events-widgets/` → `svbc-calendars/` (every file moves as-is)
- Modify: `svbc-calendars/package.json` (name field)
- Modify: `svbc-calendars/wrangler.jsonc` (name field)

**Interfaces:** None yet — pure rename, no behavior change.

- [ ] **Step 1: Rename the directory with git mv (preserves history)**

```bash
cd /Users/dwk/Developer/gitlab.com/silicon-valley-bicycle-coalition/monday-workers-events-bike-calendars
git mv events-widgets svbc-calendars
```

- [ ] **Step 2: Update the package name**

In `svbc-calendars/package.json`, change:
```json
  "name": "svbc-events-widget",
```
to:
```json
  "name": "svbc-calendars",
```

- [ ] **Step 3: Update the Wrangler Worker name**

In `svbc-calendars/wrangler.jsonc`, change:
```jsonc
  "name": "svbc-events-widgets",
```
to:
```jsonc
  "name": "svbc-calendars",
```

- [ ] **Step 4: Verify existing tests still pass after the rename**

```bash
cd svbc-calendars && npm install && npm test
```
Expected: all existing tests in `test/worker.test.ts` still PASS (nothing about the rename touches behavior).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(svbc-calendars): rename from events-widgets ahead of the bike-calendars merge"
```

---

## Task 2: Shared types and config validation

**Files:**
- Create: `svbc-calendars/src/types.ts`
- Create: `svbc-calendars/src/config.ts`
- Test: `svbc-calendars/src/config.test.ts`

**Interfaces:**
- Produces: `NormalizedEvent`, `SourceConfig` (union of `LegistarSourceConfig | CivicPlusSourceConfig | CaltrainBatacSourceConfig | EventbriteSourceConfig`), `CalendarsConfig`, `Env`, `validateConfig(raw: unknown): CalendarsConfig` — used by every later task.

- [ ] **Step 1: Write the failing test**

`svbc-calendars/src/config.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { validateConfig } from './config';

describe('validateConfig', () => {
  it('accepts a valid mixed-adapter config', () => {
    const raw = {
      sources: [
        { id: 'santa-clara', name: 'Santa Clara', committeeName: 'BPAC', adapter: 'legistar', client: 'santaclara', bodyId: 232 },
        { id: 'campbell', name: 'Campbell', committeeName: 'BPAC', adapter: 'civicplus', domain: 'www.campbellca.gov', catId: 32 },
        { id: 'caltrain-batac', name: 'Caltrain', committeeName: 'BATAC', adapter: 'caltrainBatac', pageUrl: 'https://example.com', titleFilter: 'BATAC' },
        { id: 'eventbrite-public-events', name: 'SVBC Public Events', committeeName: 'SVBC Events', adapter: 'eventbrite', organizerId: '123' },
      ],
    };
    const config = validateConfig(raw);
    expect(config.sources).toHaveLength(4);
    expect(config.sources[3]).toEqual({
      id: 'eventbrite-public-events',
      name: 'SVBC Public Events',
      committeeName: 'SVBC Events',
      adapter: 'eventbrite',
      organizerId: '123',
    });
  });

  it('rejects an unknown adapter name', () => {
    expect(() => validateConfig({ sources: [{ id: 'x', name: 'X', committeeName: 'X', adapter: 'bogus' }] })).toThrow(
      'config: sources[0].adapter must be one of legistar, civicplus, caltrainBatac, eventbrite'
    );
  });

  it('rejects a non-array sources key', () => {
    expect(() => validateConfig({ sources: 'nope' })).toThrow('config: missing required key "sources" (array)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd svbc-calendars && npm test -- src/config.test.ts`
Expected: FAIL — `./config` has no exported member `validateConfig` (module doesn't exist yet).

- [ ] **Step 3: Write `types.ts`**

```ts
export interface NormalizedEvent {
  sourceId: string;
  externalId: string;
  title: string;
  committeeName: string;
  startUtc: string; // ISO 8601, UTC
  endUtc: string | null;
  location: string | null;
  url: string | null;
  description?: string | null;
  // Eventbrite-only fields, populated by src/adapters/eventbrite.ts and consumed only by
  // src/eventsApi.ts (the /events JSON API and /widget HTML) for its richer display — ics.ts
  // ignores all of these when building a calendar's .ics output.
  startLocal?: string;
  endLocal?: string;
  timezone?: string;
  isFree?: boolean;
  onlineEvent?: boolean;
  summary?: string;
  logoUrl?: string | null;
  venueName?: string | null;
  venueCity?: string | null;
  venueAddress?: string | null;
}

export interface LegistarSourceConfig {
  id: string;
  name: string;
  committeeName: string;
  adapter: 'legistar';
  client: string;
  bodyId: number;
}

export interface CivicPlusSourceConfig {
  id: string;
  name: string;
  committeeName: string;
  adapter: 'civicplus';
  domain: string;
  catId: number;
}

export interface CaltrainBatacSourceConfig {
  id: string;
  name: string;
  committeeName: string;
  adapter: 'caltrainBatac';
  pageUrl: string;
  titleFilter: string;
}

export interface EventbriteSourceConfig {
  id: string;
  name: string;
  committeeName: string;
  adapter: 'eventbrite';
  organizerId: string;
}

export type SourceConfig = LegistarSourceConfig | CivicPlusSourceConfig | CaltrainBatacSourceConfig | EventbriteSourceConfig;

export interface CalendarsConfig {
  sources: SourceConfig[];
}

export interface SourceStatus {
  consecutiveFailures: number;
  lastError: string | null;
  lastSuccessAt: string | null;
}

/** Environment bindings declared in wrangler.jsonc, plus secrets. */
export interface Env {
  EVENTBRITE_ORG_ID: string;
  /** /events, /widget edge-cache TTL in seconds (existing behavior, unchanged: 900 = 15 min). */
  CACHE_TTL: string;
  /** /calendars/*.ics, /calendars edge-cache TTL in seconds (new: 86400 = 24h — "nothing needs to be real-time"). */
  CALENDAR_CACHE_TTL: string;
  /** Bump to invalidate the edge cache on deploy. */
  CACHE_VERSION: string;
  /** Cloudflare Web Analytics site token; omit/empty to skip the beacon script. */
  CF_WEB_ANALYTICS_TOKEN?: string;
  /** Eventbrite private OAuth token (set via `wrangler secret put`). */
  EVENTBRITE_TOKEN: string;
  /** Slack incoming-webhook URL for source-failure alerts (set via `wrangler secret put`). */
  SLACK_WEBHOOK_URL: string;
  /** Last-known-good ICS + per-source failure-streak status. */
  CALENDAR_KV: KVNamespace;
  /** Per-route, per-source usage/health metrics. */
  CALENDAR_ANALYTICS: AnalyticsEngineDataset;
}
```

- [ ] **Step 4: Write `config.ts`**

```ts
import type { CalendarsConfig, SourceConfig } from './types';

const VALID_ADAPTERS = ['legistar', 'civicplus', 'caltrainBatac', 'eventbrite'] as const;
type AdapterName = (typeof VALID_ADAPTERS)[number];

function requireString(src: Record<string, unknown>, key: string, index: number): string {
  const value = src[key];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`config: sources[${index}].${key} must be a non-empty string`);
  }
  return value;
}

function requireNumber(src: Record<string, unknown>, key: string, index: number): number {
  const value = src[key];
  if (typeof value !== 'number') {
    throw new Error(`config: sources[${index}].${key} must be a number`);
  }
  return value;
}

function validateSource(raw: unknown, index: number): SourceConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`config: sources[${index}] must be an object`);
  }
  const src = raw as Record<string, unknown>;

  const id = requireString(src, 'id', index);
  const name = requireString(src, 'name', index);
  const committeeName = requireString(src, 'committeeName', index);
  const adapter = requireString(src, 'adapter', index);

  if (!VALID_ADAPTERS.includes(adapter as AdapterName)) {
    throw new Error(`config: sources[${index}].adapter must be one of ${VALID_ADAPTERS.join(', ')}`);
  }

  if (adapter === 'legistar') {
    return { id, name, committeeName, adapter: 'legistar', client: requireString(src, 'client', index), bodyId: requireNumber(src, 'bodyId', index) };
  }
  if (adapter === 'civicplus') {
    return { id, name, committeeName, adapter: 'civicplus', domain: requireString(src, 'domain', index), catId: requireNumber(src, 'catId', index) };
  }
  if (adapter === 'caltrainBatac') {
    return { id, name, committeeName, adapter: 'caltrainBatac', pageUrl: requireString(src, 'pageUrl', index), titleFilter: requireString(src, 'titleFilter', index) };
  }
  return { id, name, committeeName, adapter: 'eventbrite', organizerId: requireString(src, 'organizerId', index) };
}

export function validateConfig(raw: unknown): CalendarsConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('config: expected an object');
  }
  const cfg = raw as Record<string, unknown>;
  if (!Array.isArray(cfg.sources)) {
    throw new Error('config: missing required key "sources" (array)');
  }
  return { sources: cfg.sources.map((s, i) => validateSource(s, i)) };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd svbc-calendars && npm test -- src/config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Add the real `config/sources.json` data file**

Every later task (adapters, the router, the scheduled handler) reads this file — it's the actual 9-source data `validateConfig` validates, ported verbatim from `bike-calendars-implementation/config/sources.json`.

Create `svbc-calendars/config/sources.json`:
```json
{
  "sources": [
    {
      "id": "santa-clara",
      "name": "Santa Clara",
      "committeeName": "Bicycle & Pedestrian Advisory Committee",
      "adapter": "legistar",
      "client": "santaclara",
      "bodyId": 232
    },
    {
      "id": "bart",
      "name": "BART",
      "committeeName": "BART Bicycle Advisory Task Force",
      "adapter": "legistar",
      "client": "bart",
      "bodyId": 182
    },
    {
      "id": "san-jose",
      "name": "San Jose",
      "committeeName": "Bicycle Pedestrian Advisory Committee",
      "adapter": "legistar",
      "client": "sanjose",
      "bodyId": 230
    },
    {
      "id": "cupertino",
      "name": "Cupertino",
      "committeeName": "Bicycle Pedestrian Commission",
      "adapter": "legistar",
      "client": "cupertino",
      "bodyId": 170
    },
    {
      "id": "campbell",
      "name": "Campbell",
      "committeeName": "Bicycle & Pedestrian Advisory Committee",
      "adapter": "civicplus",
      "domain": "www.campbellca.gov",
      "catId": 32
    },
    {
      "id": "saratoga",
      "name": "Saratoga (PEBTAC)",
      "committeeName": "Pedestrian, Equestrian & Bicycle Trails Advisory Committee",
      "adapter": "civicplus",
      "domain": "www.saratoga.ca.us",
      "catId": 34
    },
    {
      "id": "caltrain-batac",
      "name": "Caltrain",
      "committeeName": "Bicycle and Active Transportation Advisory Committee (BATAC)",
      "adapter": "caltrainBatac",
      "pageUrl": "https://www.caltrain.com/about-caltrain/advisory-committees/batac",
      "titleFilter": "Bicycle and Active Transportation Advisory Committee"
    },
    {
      "id": "eventbrite-public-events",
      "name": "SVBC Public Events",
      "committeeName": "SVBC Events — Public Events",
      "adapter": "eventbrite",
      "organizerId": "21763925459"
    },
    {
      "id": "eventbrite-volunteer-opportunities",
      "name": "SVBC Volunteer Opportunities",
      "committeeName": "SVBC Events — Volunteer Opportunities",
      "adapter": "eventbrite",
      "organizerId": "17135810858"
    }
  ]
}
```

- [ ] **Step 7: Verify it validates**

Run:
```bash
cd svbc-calendars && node --input-type=module -e "
import raw from './config/sources.json' with { type: 'json' };
import { validateConfig } from './src/config.ts';
console.log(validateConfig(raw).sources.length);
"
```
Expected: prints `9`. (If your local Node version doesn't support `import ... with { type: 'json' }` for a `.ts` config module directly, run `npm test -- src/config.test.ts` instead as a sanity check that `validateConfig` itself is sound, and trust the count by inspection of the JSON above — it has 9 top-level entries.)

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/config.ts src/config.test.ts config/sources.json
git commit -m "feat(svbc-calendars): add shared types, config validation, and the 9-source config data"
```

---

## Task 3: Move the Legistar, CivicPlus, and Caltrain BATAC adapters from `committee-calendars`

These three adapters are unchanged — only relocated, so their existing tests move with them and don't need rewriting.

**Files:**
- Move (git mv): `committee-calendars/src/adapters/legistar.ts` → `svbc-calendars/src/adapters/legistar.ts`
- Move (git mv): `committee-calendars/src/adapters/legistar.test.ts` → `svbc-calendars/src/adapters/legistar.test.ts`
- Move (git mv): `committee-calendars/src/adapters/civicplus.ts` → `svbc-calendars/src/adapters/civicplus.ts`
- Move (git mv): `committee-calendars/src/adapters/civicplus.test.ts` → `svbc-calendars/src/adapters/civicplus.test.ts`
- Move (git mv): `committee-calendars/src/adapters/caltrainBatac.ts` → `svbc-calendars/src/adapters/caltrainBatac.ts`
- Move (git mv): `committee-calendars/src/adapters/caltrainBatac.test.ts` → `svbc-calendars/src/adapters/caltrainBatac.test.ts`
- Move (git mv): `committee-calendars/src/util/zonedTime.ts` → `svbc-calendars/src/util/zonedTime.ts`
- Move (git mv): `committee-calendars/src/util/zonedTime.test.ts` → `svbc-calendars/src/util/zonedTime.test.ts`
- Move (git mv): `committee-calendars/src/util/toValidUrl.ts` → `svbc-calendars/src/util/toValidUrl.ts`
- Move (git mv): `committee-calendars/src/util/toValidUrl.test.ts` → `svbc-calendars/src/util/toValidUrl.test.ts`
- Move (git mv): `committee-calendars/src/util/parseIcs.ts` → `svbc-calendars/src/util/parseIcs.ts`
- Move (git mv): `committee-calendars/src/util/parseIcs.test.ts` → `svbc-calendars/src/util/parseIcs.test.ts`
- Move (git mv): `committee-calendars/src/util/errorMessage.ts` → `svbc-calendars/src/util/errorMessage.ts`
- Move (git mv): `committee-calendars/src/types/ical.d.ts` → `svbc-calendars/src/types/ical.d.ts`
- Modify: `svbc-calendars/package.json` (add `ical.js` dependency)

**Interfaces:**
- Consumes: `NormalizedEvent`, `LegistarSourceConfig`, `CivicPlusSourceConfig`, `CaltrainBatacSourceConfig` from `./types` (Task 2 — these adapters already import from a sibling `../types`, which now resolves to Task 2's file since the shape is identical field-for-field).
- Produces: `fetchLegistarEvents(source, now): Promise<NormalizedEvent[]>`, `fetchCivicPlusEvents(source): Promise<NormalizedEvent[]>`, `fetchCaltrainBatacEvents(source): Promise<NormalizedEvent[]>` — consumed by Task 5's dispatch.

- [ ] **Step 1: Move the adapter and util files, preserving history**

```bash
cd /Users/dwk/Developer/gitlab.com/silicon-valley-bicycle-coalition/monday-workers-events-bike-calendars
mkdir -p svbc-calendars/src/adapters svbc-calendars/src/util svbc-calendars/src/types
git mv committee-calendars/src/adapters/legistar.ts svbc-calendars/src/adapters/legistar.ts
git mv committee-calendars/src/adapters/legistar.test.ts svbc-calendars/src/adapters/legistar.test.ts
git mv committee-calendars/src/adapters/civicplus.ts svbc-calendars/src/adapters/civicplus.ts
git mv committee-calendars/src/adapters/civicplus.test.ts svbc-calendars/src/adapters/civicplus.test.ts
git mv committee-calendars/src/adapters/caltrainBatac.ts svbc-calendars/src/adapters/caltrainBatac.ts
git mv committee-calendars/src/adapters/caltrainBatac.test.ts svbc-calendars/src/adapters/caltrainBatac.test.ts
git mv committee-calendars/src/util/zonedTime.ts svbc-calendars/src/util/zonedTime.ts
git mv committee-calendars/src/util/zonedTime.test.ts svbc-calendars/src/util/zonedTime.test.ts
git mv committee-calendars/src/util/toValidUrl.ts svbc-calendars/src/util/toValidUrl.ts
git mv committee-calendars/src/util/toValidUrl.test.ts svbc-calendars/src/util/toValidUrl.test.ts
git mv committee-calendars/src/util/parseIcs.ts svbc-calendars/src/util/parseIcs.ts
git mv committee-calendars/src/util/parseIcs.test.ts svbc-calendars/src/util/parseIcs.test.ts
git mv committee-calendars/src/util/errorMessage.ts svbc-calendars/src/util/errorMessage.ts
git mv committee-calendars/src/types/ical.d.ts svbc-calendars/src/types/ical.d.ts
```

- [ ] **Step 2: Add the `ical.js` dependency `parseIcs.ts` needs**

In `svbc-calendars/package.json`, add to `"dependencies"` (create the key if it doesn't exist yet):
```json
  "dependencies": {
    "ical.js": "^2.2.1"
  },
```

- [ ] **Step 3: Install and run the moved tests**

```bash
cd svbc-calendars && npm install && npm test -- src/adapters/legistar.test.ts src/adapters/civicplus.test.ts src/adapters/caltrainBatac.test.ts src/util
```
Expected: PASS — every moved test still passes unchanged; the only thing that moved is the file location, and all their imports (`../types`, `../util/...`) already resolve correctly in the new location because the directory shape mirrors `committee-calendars`'s.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(svbc-calendars): move Legistar, CivicPlus, and Caltrain BATAC adapters from committee-calendars"
```

---

## Task 4: Port the Eventbrite adapter (organizer-scoped, paginated, token as a parameter)

Ports `bike-calendars-implementation/src/lib/adapters/eventbrite.ts`. Two changes from the original: (1) the token is passed as an explicit parameter instead of read from `process.env` (a Worker's `fetch` handler receives `env`, not `process.env`); (2) the mapped event carries the extra widget-display fields (`venueName`, `logoUrl`, `isFree`, etc.) that `/events`/`/widget` need — `ics.ts` (Task 6) simply ignores them.

**Files:**
- Create: `svbc-calendars/src/adapters/eventbrite.ts`
- Test: `svbc-calendars/src/adapters/eventbrite.test.ts`

**Interfaces:**
- Consumes: `EventbriteSourceConfig`, `NormalizedEvent` (Task 2), `toValidUrl` (Task 3).
- Produces: `fetchEventbriteEvents(source: EventbriteSourceConfig, token: string, maxEvents?: number): Promise<NormalizedEvent[]>` — consumed by Task 5's dispatch and Task 11's `eventsApi.ts`.

- [ ] **Step 1: Write the failing test**

`svbc-calendars/src/adapters/eventbrite.test.ts`:
```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchEventbriteEvents } from './eventbrite';
import type { EventbriteSourceConfig } from '../types';

const SOURCE: EventbriteSourceConfig = {
  id: 'eventbrite-public-events',
  name: 'SVBC Public Events',
  committeeName: 'SVBC Events — Public Events',
  adapter: 'eventbrite',
  organizerId: 'org-123',
};

const PAGE_1 = {
  events: [
    {
      id: 'evt-1',
      name: { text: 'Group Ride: Los Gatos Loop' },
      description: { text: 'Subtype: Family Ride' },
      summary: 'A short, family-friendly ride.',
      url: 'https://www.eventbrite.com/e/evt-1',
      is_free: true,
      online_event: false,
      logo: { url: 'https://img.example.com/cropped.jpg', original: { url: 'https://img.example.com/original.jpg' } },
      start: { timezone: 'America/Los_Angeles', local: '2026-10-01T10:00:00', utc: '2026-10-01T17:00:00Z' },
      end: { timezone: 'America/Los_Angeles', local: '2026-10-01T12:00:00', utc: '2026-10-01T19:00:00Z' },
      venue: { name: 'Los Gatos Plaza', address: { city: 'Los Gatos', localized_address_display: 'Los Gatos, CA' } },
    },
  ],
  pagination: { has_more_items: true, continuation: 'cont-token-1' },
};

const PAGE_2 = {
  events: [
    {
      id: 'evt-2',
      name: { text: '', html: '<b>Bike Month Kickoff</b>' },
      description: null,
      summary: null,
      url: 'not a valid url',
      is_free: false,
      online_event: true,
      logo: null,
      start: { timezone: 'America/Los_Angeles', local: '2026-05-01T09:00:00', utc: '2026-05-01T16:00:00Z' },
      end: { timezone: 'America/Los_Angeles', local: '2026-05-01T11:00:00', utc: '2026-05-01T18:00:00Z' },
      venue: null,
    },
  ],
  pagination: { has_more_items: false },
};

describe('fetchEventbriteEvents', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches all pages, normalizes into NormalizedEvent, and carries the widget-display fields', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
      if (String(url).includes('continuation=cont-token-1')) {
        return new Response(JSON.stringify(PAGE_2), { status: 200 });
      }
      expect(String(url)).toBe('https://www.eventbriteapi.com/v3/organizers/org-123/events/?expand=venue&status=live&order_by=start_asc');
      return new Response(JSON.stringify(PAGE_1), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const events = await fetchEventbriteEvents(SOURCE, 'test-token');

    expect(events).toEqual([
      {
        sourceId: 'eventbrite-public-events',
        externalId: 'evt-1',
        title: 'Group Ride: Los Gatos Loop',
        committeeName: 'SVBC Events — Public Events',
        startUtc: '2026-10-01T17:00:00Z',
        endUtc: '2026-10-01T19:00:00Z',
        location: 'Los Gatos, CA',
        url: 'https://www.eventbrite.com/e/evt-1',
        description: 'Subtype: Family Ride',
        startLocal: '2026-10-01T10:00:00',
        endLocal: '2026-10-01T12:00:00',
        timezone: 'America/Los_Angeles',
        isFree: true,
        onlineEvent: false,
        summary: 'A short, family-friendly ride.',
        logoUrl: 'https://img.example.com/original.jpg',
        venueName: 'Los Gatos Plaza',
        venueCity: 'Los Gatos',
        venueAddress: 'Los Gatos, CA',
      },
      {
        sourceId: 'eventbrite-public-events',
        externalId: 'evt-2',
        title: 'Bike Month Kickoff',
        committeeName: 'SVBC Events — Public Events',
        startUtc: '2026-05-01T16:00:00Z',
        endUtc: '2026-05-01T18:00:00Z',
        location: null,
        url: null,
        description: null,
        startLocal: '2026-05-01T09:00:00',
        endLocal: '2026-05-01T11:00:00',
        timezone: 'America/Los_Angeles',
        isFree: false,
        onlineEvent: true,
        summary: null,
        logoUrl: null,
        venueName: null,
        venueCity: null,
        venueAddress: null,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws with a descriptive message on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden', { status: 403, statusText: 'Forbidden' })));
    await expect(fetchEventbriteEvents(SOURCE, 'test-token')).rejects.toThrow('eventbrite: organizer org-123 fetch failed: 403 Forbidden');
  });

  it('stops paginating once maxEvents is reached, without fetching further pages', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(PAGE_1), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const events = await fetchEventbriteEvents(SOURCE, 'test-token', 1);

    expect(events).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caps pagination at 20 pages instead of looping forever', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ events: [{ ...PAGE_1.events[0], id: `evt-${calls}` }], pagination: { has_more_items: true, continuation: `cont-${calls}` } }),
        { status: 200 }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const events = await fetchEventbriteEvents(SOURCE, 'test-token');

    expect(fetchMock).toHaveBeenCalledTimes(20);
    expect(events).toHaveLength(20);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('hit the 20-page cap'));
    errorSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd svbc-calendars && npm test -- src/adapters/eventbrite.test.ts`
Expected: FAIL — `./eventbrite` module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

`svbc-calendars/src/adapters/eventbrite.ts`:
```ts
import type { EventbriteSourceConfig, NormalizedEvent } from '../types';
import { toValidUrl } from '../util/toValidUrl';

interface EventbriteEventRecord {
  id: string;
  name: { text: string; html?: string };
  description?: { text: string | null } | null;
  summary?: string | null;
  url: string;
  is_free: boolean;
  online_event: boolean;
  logo?: { url?: string; original?: { url?: string } } | null;
  start: { timezone: string; local: string; utc: string };
  end: { timezone: string; local: string; utc: string };
  venue?: { name?: string | null; address?: { city?: string | null; localized_address_display?: string | null } | null } | null;
}

interface EventbriteEventsResponse {
  events: EventbriteEventRecord[];
  pagination: { has_more_items: boolean; continuation?: string };
}

const MAX_PAGES = 20;

function organizerEventsUrl(organizerId: string, continuation?: string): string {
  const base = `https://www.eventbriteapi.com/v3/organizers/${organizerId}/events/?expand=venue&status=live&order_by=start_asc`;
  return continuation ? `${base}&continuation=${encodeURIComponent(continuation)}` : base;
}

function toNormalizedEvent(record: EventbriteEventRecord, source: EventbriteSourceConfig): NormalizedEvent {
  return {
    sourceId: source.id,
    externalId: record.id,
    title: record.name.text || record.name.html || 'Untitled',
    committeeName: source.committeeName,
    startUtc: record.start.utc,
    endUtc: record.end.utc,
    location: record.venue?.address?.localized_address_display ?? null,
    url: toValidUrl(record.url),
    description: record.description?.text ?? null,
    startLocal: record.start.local,
    endLocal: record.end.local,
    timezone: record.start.timezone,
    isFree: record.is_free,
    onlineEvent: record.online_event,
    summary: record.summary ?? null,
    logoUrl: record.logo?.original?.url ?? record.logo?.url ?? null,
    venueName: record.venue?.name ?? null,
    venueCity: record.venue?.address?.city ?? null,
    venueAddress: record.venue?.address?.localized_address_display ?? null,
  };
}

export async function fetchEventbriteEvents(source: EventbriteSourceConfig, token: string, maxEvents?: number): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];
  let url: string | null = organizerEventsUrl(source.organizerId);
  let pageCount = 0;

  while (url) {
    pageCount += 1;
    if (pageCount > MAX_PAGES) {
      console.error(`eventbrite: organizer ${source.organizerId} hit the ${MAX_PAGES}-page cap; stopping and returning what's been collected so far`);
      break;
    }

    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) {
      throw new Error(`eventbrite: organizer ${source.organizerId} fetch failed: ${response.status} ${response.statusText}`);
    }
    const body = (await response.json()) as EventbriteEventsResponse;

    for (const record of body.events) {
      events.push(toNormalizedEvent(record, source));
      if (maxEvents !== undefined && events.length >= maxEvents) {
        return events;
      }
    }

    if (body.pagination.has_more_items && body.pagination.continuation) {
      url = organizerEventsUrl(source.organizerId, body.pagination.continuation);
    } else {
      if (body.pagination.has_more_items) {
        console.error(`eventbrite: organizer ${source.organizerId} reported has_more_items with no continuation token; stopping pagination`);
      }
      url = null;
    }
  }

  return events;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd svbc-calendars && npm test -- src/adapters/eventbrite.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/eventbrite.ts src/adapters/eventbrite.test.ts
git commit -m "feat(svbc-calendars): port the organizer-scoped, paginated Eventbrite adapter from bike-calendars"
```

---

## Task 5: Adapter dispatch

**Files:**
- Create: `svbc-calendars/src/adapters/dispatch.ts`
- Test: `svbc-calendars/src/adapters/dispatch.test.ts`

**Interfaces:**
- Consumes: `fetchLegistarEvents`, `fetchCivicPlusEvents`, `fetchCaltrainBatacEvents` (Task 3), `fetchEventbriteEvents` (Task 4), `SourceConfig`, `NormalizedEvent` (Task 2).
- Produces: `type FetchSourceEvents = (source: SourceConfig, now: Date) => Promise<NormalizedEvent[]>`, `createFetchSourceEvents(eventbriteToken: string): FetchSourceEvents` — consumed by Task 8 (`calendarSource.ts`) and Task 13 (`scheduled()`).

Unlike `committee-calendars`'s plain exported `fetchSourceEvents` constant, this is a **factory function** — the Eventbrite branch needs a token that only exists per-request (`env.EVENTBRITE_TOKEN`), so `createFetchSourceEvents` closes over it while keeping the other three adapters' call sites untouched.

- [ ] **Step 1: Write the failing test**

`svbc-calendars/src/adapters/dispatch.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { createFetchSourceEvents } from './dispatch';
import type { EventbriteSourceConfig, LegistarSourceConfig } from '../types';

describe('createFetchSourceEvents', () => {
  it('routes an eventbrite source to fetchEventbriteEvents with the closed-over token', async () => {
    const source: EventbriteSourceConfig = {
      id: 'eventbrite-public-events',
      name: 'SVBC Public Events',
      committeeName: 'SVBC Events',
      adapter: 'eventbrite',
      organizerId: 'org-1',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
        return new Response(JSON.stringify({ events: [], pagination: { has_more_items: false } }), { status: 200 });
      })
    );

    const fetchSourceEvents = createFetchSourceEvents('secret-token');
    const events = await fetchSourceEvents(source, new Date());

    expect(events).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('routes a legistar source to fetchLegistarEvents, ignoring the token', async () => {
    const source: LegistarSourceConfig = { id: 'santa-clara', name: 'Santa Clara', committeeName: 'BPAC', adapter: 'legistar', client: 'santaclara', bodyId: 232 };
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));

    const fetchSourceEvents = createFetchSourceEvents('unused-token');
    const events = await fetchSourceEvents(source, new Date('2026-01-01T00:00:00Z'));

    expect(events).toEqual([]);
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd svbc-calendars && npm test -- src/adapters/dispatch.test.ts`
Expected: FAIL — `./dispatch` module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```ts
import type { NormalizedEvent, SourceConfig } from '../types';
import { fetchLegistarEvents } from './legistar';
import { fetchCivicPlusEvents } from './civicplus';
import { fetchCaltrainBatacEvents } from './caltrainBatac';
import { fetchEventbriteEvents } from './eventbrite';

export type FetchSourceEvents = (source: SourceConfig, now: Date) => Promise<NormalizedEvent[]>;

export function createFetchSourceEvents(eventbriteToken: string): FetchSourceEvents {
  return (source, now) => {
    switch (source.adapter) {
      case 'legistar':
        return fetchLegistarEvents(source, now);
      case 'civicplus':
        return fetchCivicPlusEvents(source);
      case 'caltrainBatac':
        return fetchCaltrainBatacEvents(source);
      case 'eventbrite':
        return fetchEventbriteEvents(source, eventbriteToken);
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd svbc-calendars && npm test -- src/adapters/dispatch.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/dispatch.ts src/adapters/dispatch.test.ts
git commit -m "feat(svbc-calendars): add adapter dispatch with the Eventbrite token closure"
```

---

## Task 6: ICS building

Ports `bike-calendars-implementation/src/lib/ics.ts`'s `buildCalendar` (per-source, not `committee-calendars`'s merged-feed `buildMergedCalendar`).

**Files:**
- Create: `svbc-calendars/src/ics.ts`
- Test: `svbc-calendars/src/ics.test.ts`
- Modify: `svbc-calendars/package.json` (add `ics` dependency)

**Interfaces:**
- Consumes: `NormalizedEvent` (Task 2).
- Produces: `buildCalendar(events: NormalizedEvent[], calName: string): string` — consumed by Task 8.

- [ ] **Step 1: Write the failing test**

`svbc-calendars/src/ics.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildCalendar } from './ics';
import type { NormalizedEvent } from './types';

const EVENT: NormalizedEvent = {
  sourceId: 'santa-clara',
  externalId: '123',
  title: 'Bicycle & Pedestrian Advisory Committee',
  committeeName: 'Bicycle & Pedestrian Advisory Committee',
  startUtc: '2026-11-04T03:00:00.000Z',
  endUtc: null,
  location: '1500 Warburton Ave, Santa Clara, CA',
  url: 'https://santaclara.legistar.com/MeetingDetail.aspx?ID=1',
};

describe('buildCalendar', () => {
  it('produces a VCALENDAR with the given calName and one VEVENT per event', () => {
    const ics = buildCalendar([EVENT], 'Santa Clara BPAC');
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('X-WR-CALNAME:Santa Clara BPAC');
    expect(ics).toContain('UID:santa-clara:123@calendars.bikesiliconvalley.org');
    expect(ics).toContain('SUMMARY:Bicycle & Pedestrian Advisory Committee');
    expect(ics).toContain('LOCATION:1500 Warburton Ave\\, Santa Clara\\, CA');
  });

  it('produces a valid empty calendar when there are no events', () => {
    const ics = buildCalendar([], 'Empty Feed');
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).not.toContain('BEGIN:VEVENT');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd svbc-calendars && npm test -- src/ics.test.ts`
Expected: FAIL — `./ics` module doesn't exist yet.

- [ ] **Step 3: Add the `ics` dependency**

In `svbc-calendars/package.json`, add to `"dependencies"`:
```json
    "ics": "^3.12.0",
```

- [ ] **Step 4: Write the implementation**

`svbc-calendars/src/ics.ts`:
```ts
import { createEvents, type EventAttributes, type DateArray } from 'ics';
import type { NormalizedEvent } from './types';

function toDateArray(isoUtc: string): DateArray {
  const date = new Date(isoUtc);
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes()];
}

// `EventAttributes` types `end`/`duration` as a required discriminated union, but the `ics`
// package's runtime validator allows neither being present — only having *both* is rejected.
// `Partial<EventAttributes>` doesn't distribute cleanly over that union, so this narrows the
// escape hatch to just the `end`/`duration` fields that genuinely need it.
type EventAttributesBuilder = Omit<EventAttributes, 'end' | 'duration' | 'endInputType' | 'endOutputType'> & {
  end?: DateArray;
  endInputType?: 'utc' | 'local';
  endOutputType?: 'utc' | 'local';
};

export function buildCalendar(events: NormalizedEvent[], calName: string): string {
  const attributes: EventAttributes[] = events.map((event) => {
    const attrs: EventAttributesBuilder = {
      uid: `${event.sourceId}:${event.externalId}@calendars.bikesiliconvalley.org`,
      title: event.title,
      start: toDateArray(event.startUtc),
      startInputType: 'utc',
      startOutputType: 'utc',
      calName,
    };
    if (event.endUtc) {
      attrs.end = toDateArray(event.endUtc);
      attrs.endInputType = 'utc';
      attrs.endOutputType = 'utc';
    }
    if (event.location) {
      attrs.location = event.location;
    }
    if (event.url) {
      attrs.url = event.url;
    }
    if (event.description) {
      attrs.description = event.description;
    }
    return attrs as EventAttributes;
  });

  const { error, value } = createEvents(attributes, { calName });
  if (error) {
    throw error;
  }
  return value ?? '';
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd svbc-calendars && npm install && npm test -- src/ics.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/ics.ts src/ics.test.ts
git commit -m "feat(svbc-calendars): add per-source ICS building"
```

---

## Task 7: KV-backed last-known-good store

New code — this is the resilience layer replacing `committee-calendars`'s D1 store and bike-calendars' "re-fetch the currently-published page" fallback.

**Files:**
- Create: `svbc-calendars/src/calendarStore.ts`
- Test: `svbc-calendars/src/calendarStore.test.ts`

**Interfaces:**
- Consumes: `SourceStatus` (Task 2), `KVNamespace` (Cloudflare Workers runtime type).
- Produces: `getLastKnownGoodIcs`, `setLastKnownGoodIcs`, `getSourceStatus`, `recordSourceSuccess`, `recordSourceFailure`, `getAllSourceStatuses` — consumed by Task 8 and Task 12.

- [ ] **Step 1: Write the failing test**

`svbc-calendars/src/calendarStore.test.ts`:
```ts
import { env } from 'cloudflare:workers';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getLastKnownGoodIcs,
  setLastKnownGoodIcs,
  getSourceStatus,
  recordSourceSuccess,
  recordSourceFailure,
  getAllSourceStatuses,
} from './calendarStore';

const KV = () => (env as unknown as { CALENDAR_KV: KVNamespace }).CALENDAR_KV;

describe('calendarStore', () => {
  beforeEach(async () => {
    const kv = KV();
    for (const key of ['ics:santa-clara', 'status:santa-clara', 'status:campbell']) {
      await kv.delete(key);
    }
  });

  it('round-trips the last-known-good ICS for a source', async () => {
    const kv = KV();
    expect(await getLastKnownGoodIcs(kv, 'santa-clara')).toBeNull();
    await setLastKnownGoodIcs(kv, 'santa-clara', 'BEGIN:VCALENDAR\nEND:VCALENDAR');
    expect(await getLastKnownGoodIcs(kv, 'santa-clara')).toBe('BEGIN:VCALENDAR\nEND:VCALENDAR');
  });

  it('defaults to a zeroed status when a source has never been recorded', async () => {
    const kv = KV();
    expect(await getSourceStatus(kv, 'santa-clara')).toEqual({ consecutiveFailures: 0, lastError: null, lastSuccessAt: null });
  });

  it('recordSourceSuccess resets the failure streak', async () => {
    const kv = KV();
    await recordSourceFailure(kv, 'santa-clara', 'boom');
    await recordSourceSuccess(kv, 'santa-clara', '2026-08-27T00:00:00.000Z');
    expect(await getSourceStatus(kv, 'santa-clara')).toEqual({ consecutiveFailures: 0, lastError: null, lastSuccessAt: '2026-08-27T00:00:00.000Z' });
  });

  it('recordSourceFailure increments the streak and returns the new count', async () => {
    const kv = KV();
    expect(await recordSourceFailure(kv, 'santa-clara', 'first failure')).toBe(1);
    expect(await recordSourceFailure(kv, 'santa-clara', 'second failure')).toBe(2);
    expect(await getSourceStatus(kv, 'santa-clara')).toEqual({ consecutiveFailures: 2, lastError: 'second failure', lastSuccessAt: null });
  });

  it('getAllSourceStatuses reads every requested source, defaulting missing ones', async () => {
    const kv = KV();
    await recordSourceFailure(kv, 'santa-clara', 'boom');
    const statuses = await getAllSourceStatuses(kv, ['santa-clara', 'campbell']);
    expect(statuses['santa-clara'].consecutiveFailures).toBe(1);
    expect(statuses['campbell']).toEqual({ consecutiveFailures: 0, lastError: null, lastSuccessAt: null });
  });
});
```

- [ ] **Step 2: Add a local KV binding so `cloudflare:workers`'s `env.CALENDAR_KV` resolves in tests**

In `svbc-calendars/wrangler.jsonc`, add (Task 16 will replace the placeholder `id` with the real provisioned namespace before deploy — miniflare's test runner simulates KV locally regardless of the `id` string):
```jsonc
  "kv_namespaces": [
    {
      "binding": "CALENDAR_KV",
      "id": "placeholder-replaced-in-task-16"
    }
  ],
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd svbc-calendars && npm test -- src/calendarStore.test.ts`
Expected: FAIL — `./calendarStore` module doesn't exist yet.

- [ ] **Step 4: Write the implementation**

`svbc-calendars/src/calendarStore.ts`:
```ts
import type { SourceStatus } from './types';

const DEFAULT_STATUS: SourceStatus = { consecutiveFailures: 0, lastError: null, lastSuccessAt: null };

export async function getLastKnownGoodIcs(kv: KVNamespace, sourceId: string): Promise<string | null> {
  return kv.get(`ics:${sourceId}`);
}

export async function setLastKnownGoodIcs(kv: KVNamespace, sourceId: string, icsText: string): Promise<void> {
  await kv.put(`ics:${sourceId}`, icsText);
}

export async function getSourceStatus(kv: KVNamespace, sourceId: string): Promise<SourceStatus> {
  const raw = await kv.get(`status:${sourceId}`);
  return raw ? (JSON.parse(raw) as SourceStatus) : DEFAULT_STATUS;
}

export async function recordSourceSuccess(kv: KVNamespace, sourceId: string, nowIso: string): Promise<void> {
  const status: SourceStatus = { consecutiveFailures: 0, lastError: null, lastSuccessAt: nowIso };
  await kv.put(`status:${sourceId}`, JSON.stringify(status));
}

export async function recordSourceFailure(kv: KVNamespace, sourceId: string, errorMsg: string): Promise<number> {
  const previous = await getSourceStatus(kv, sourceId);
  const status: SourceStatus = { consecutiveFailures: previous.consecutiveFailures + 1, lastError: errorMsg, lastSuccessAt: previous.lastSuccessAt };
  await kv.put(`status:${sourceId}`, JSON.stringify(status));
  return status.consecutiveFailures;
}

export async function getAllSourceStatuses(kv: KVNamespace, sourceIds: string[]): Promise<Record<string, SourceStatus>> {
  const entries = await Promise.all(sourceIds.map(async (id) => [id, await getSourceStatus(kv, id)] as const));
  return Object.fromEntries(entries);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd svbc-calendars && npm test -- src/calendarStore.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/calendarStore.ts src/calendarStore.test.ts wrangler.jsonc
git commit -m "feat(svbc-calendars): add KV-backed last-known-good ICS and status store"
```

---

## Task 8: Slack failure alert

Unchanged logic between `committee-calendars` and `bike-calendars` — moved from `committee-calendars`, message text kept as-is except the module name in the log line.

**Files:**
- Create: `svbc-calendars/src/alert.ts`
- Test: `svbc-calendars/src/alert.test.ts`

**Interfaces:**
- Produces: `sendFailureAlert(webhookUrl: string, sourceId: string, sourceName: string, consecutiveFailures: number, lastError: string): Promise<void>` — consumed by Task 9.

- [ ] **Step 1: Write the failing test**

`svbc-calendars/src/alert.test.ts`:
```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { sendFailureAlert } from './alert';

describe('sendFailureAlert', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs a Slack message with the source name and error', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(url).toBe('https://hooks.slack.com/services/test');
      const body = JSON.parse(init?.body as string);
      expect(body.text).toContain('Santa Clara');
      expect(body.text).toContain('3 days in a row');
      expect(body.text).toContain('boom');
      return new Response('ok', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await sendFailureAlert('https://hooks.slack.com/services/test', 'santa-clara', 'Santa Clara', 3, 'boom');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips the POST and logs when no webhook URL is configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await sendFailureAlert('', 'santa-clara', 'Santa Clara', 3, 'boom');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Slack alert skipped'));
    errorSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd svbc-calendars && npm test -- src/alert.test.ts`
Expected: FAIL — `./alert` module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

`svbc-calendars/src/alert.ts`:
```ts
export async function sendFailureAlert(
  webhookUrl: string,
  sourceId: string,
  sourceName: string,
  consecutiveFailures: number,
  lastError: string
): Promise<void> {
  if (!webhookUrl) {
    console.error('svbc-calendars: Slack alert skipped, SLACK_WEBHOOK_URL is not configured');
    return;
  }
  const text = `svbc-calendars: source "${sourceName}" (${sourceId}) has failed ${consecutiveFailures} days in a row. Last error: ${lastError}`;
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      console.error(`svbc-calendars: Slack alert POST failed: ${response.status} ${response.statusText}`);
    }
  } catch (err) {
    console.error(`svbc-calendars: Slack alert POST threw: ${err}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd svbc-calendars && npm test -- src/alert.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/alert.ts src/alert.test.ts
git commit -m "feat(svbc-calendars): add Slack failure alerting"
```

---

## Task 9: Per-source calendar orchestration (live fetch, or KV fallback on failure)

New code — the per-request equivalent of `bike-calendars`'s `runSync` loop body, scoped to one source and backed by KV instead of a daily build.

**Files:**
- Create: `svbc-calendars/src/calendarSource.ts`
- Test: `svbc-calendars/src/calendarSource.test.ts`

**Interfaces:**
- Consumes: `SourceConfig`, `Env` (Task 2), `FetchSourceEvents` (Task 5), `buildCalendar` (Task 6), `getLastKnownGoodIcs`/`setLastKnownGoodIcs`/`recordSourceSuccess`/`recordSourceFailure` (Task 7), `sendFailureAlert` (Task 8), `errorMessage` (Task 3).
- Produces: `getSourceCalendar(source: SourceConfig, deps: CalendarSourceDeps): Promise<CalendarResult>` — consumed by Task 12 (`/calendars/:id.ics` route) and Task 13 (`scheduled()`).

- [ ] **Step 1: Write the failing test**

`svbc-calendars/src/calendarSource.test.ts`:
```ts
import { env } from 'cloudflare:workers';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getSourceCalendar } from './calendarSource';
import { getLastKnownGoodIcs, recordSourceFailure } from './calendarStore';
import type { LegistarSourceConfig, NormalizedEvent } from './types';

const KV = () => (env as unknown as { CALENDAR_KV: KVNamespace }).CALENDAR_KV;

const SOURCE: LegistarSourceConfig = { id: 'santa-clara', name: 'Santa Clara', committeeName: 'BPAC', adapter: 'legistar', client: 'santaclara', bodyId: 232 };
const EVENT: NormalizedEvent = { sourceId: 'santa-clara', externalId: '1', title: 'BPAC', committeeName: 'BPAC', startUtc: '2026-11-04T03:00:00.000Z', endUtc: null, location: null, url: null };

describe('getSourceCalendar', () => {
  beforeEach(async () => {
    const kv = KV();
    await kv.delete('ics:santa-clara');
    await kv.delete('status:santa-clara');
  });

  it('on success, builds the ICS, stores it as last-known-good, and resets the failure streak', async () => {
    const kv = KV();
    const fetchSourceEvents = vi.fn(async () => [EVENT]);
    const sendFailureAlert = vi.fn();

    const result = await getSourceCalendar(SOURCE, { kv, fetchSourceEvents, sendFailureAlert, slackWebhookUrl: 'https://hooks.slack.com/x', now: () => new Date('2026-08-27T00:00:00Z') });

    expect(result.servedFromFallback).toBe(false);
    expect(result.ics).toContain('BEGIN:VCALENDAR');
    expect(await getLastKnownGoodIcs(kv, 'santa-clara')).toBe(result.ics);
    expect(sendFailureAlert).not.toHaveBeenCalled();
  });

  it('on failure with a stored fallback, serves the fallback and increments the streak', async () => {
    const kv = KV();
    await kv.put('ics:santa-clara', 'BEGIN:VCALENDAR\nEND:VCALENDAR');
    const fetchSourceEvents = vi.fn(async () => {
      throw new Error('legistar down');
    });
    const sendFailureAlert = vi.fn();

    const result = await getSourceCalendar(SOURCE, { kv, fetchSourceEvents, sendFailureAlert, slackWebhookUrl: 'https://hooks.slack.com/x', now: () => new Date('2026-08-27T00:00:00Z') });

    expect(result.servedFromFallback).toBe(true);
    expect(result.ics).toBe('BEGIN:VCALENDAR\nEND:VCALENDAR');
  });

  it('on failure with no stored fallback, returns a null ics', async () => {
    const kv = KV();
    const fetchSourceEvents = vi.fn(async () => {
      throw new Error('legistar down');
    });

    const result = await getSourceCalendar(SOURCE, { kv, fetchSourceEvents, sendFailureAlert: vi.fn(), slackWebhookUrl: 'https://hooks.slack.com/x', now: () => new Date('2026-08-27T00:00:00Z') });

    expect(result.ics).toBeNull();
    expect(result.servedFromFallback).toBe(false);
  });

  it('sends the Slack alert exactly when the failure streak first reaches 3', async () => {
    const kv = KV();
    await recordSourceFailure(kv, 'santa-clara', 'prior failure 1');
    await recordSourceFailure(kv, 'santa-clara', 'prior failure 2');
    const fetchSourceEvents = vi.fn(async () => {
      throw new Error('third failure');
    });
    const sendFailureAlert = vi.fn();

    await getSourceCalendar(SOURCE, { kv, fetchSourceEvents, sendFailureAlert, slackWebhookUrl: 'https://hooks.slack.com/x', now: () => new Date('2026-08-27T00:00:00Z') });

    expect(sendFailureAlert).toHaveBeenCalledWith('https://hooks.slack.com/x', 'santa-clara', 'Santa Clara', 3, 'third failure');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd svbc-calendars && npm test -- src/calendarSource.test.ts`
Expected: FAIL — `./calendarSource` module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

`svbc-calendars/src/calendarSource.ts`:
```ts
import type { SourceConfig } from './types';
import type { FetchSourceEvents } from './adapters/dispatch';
import { buildCalendar } from './ics';
import { getLastKnownGoodIcs, setLastKnownGoodIcs, recordSourceSuccess, recordSourceFailure } from './calendarStore';
import { sendFailureAlert as realSendFailureAlert } from './alert';
import { errorMessage } from './util/errorMessage';

const FAILURE_ALERT_THRESHOLD = 3;

export interface CalendarResult {
  /** The ICS text to serve, or null if the source has never succeeded and has no fallback. */
  ics: string | null;
  servedFromFallback: boolean;
}

export interface CalendarSourceDeps {
  kv: KVNamespace;
  fetchSourceEvents: FetchSourceEvents;
  sendFailureAlert: typeof realSendFailureAlert;
  slackWebhookUrl: string;
  now: () => Date;
}

export async function getSourceCalendar(source: SourceConfig, deps: CalendarSourceDeps): Promise<CalendarResult> {
  try {
    const events = await deps.fetchSourceEvents(source, deps.now());
    const ics = buildCalendar(events, source.committeeName);
    await setLastKnownGoodIcs(deps.kv, source.id, ics);
    await recordSourceSuccess(deps.kv, source.id, deps.now().toISOString());
    return { ics, servedFromFallback: false };
  } catch (err) {
    const message = errorMessage(err);
    console.error(`svbc-calendars: source "${source.id}" failed: ${message}`);
    const consecutiveFailures = await recordSourceFailure(deps.kv, source.id, message);
    if (consecutiveFailures === FAILURE_ALERT_THRESHOLD) {
      await deps.sendFailureAlert(deps.slackWebhookUrl, source.id, source.name, consecutiveFailures, message);
    }
    const fallback = await getLastKnownGoodIcs(deps.kv, source.id);
    return { ics: fallback, servedFromFallback: fallback !== null };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd svbc-calendars && npm test -- src/calendarSource.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/calendarSource.ts src/calendarSource.test.ts
git commit -m "feat(svbc-calendars): add per-source live-fetch-or-KV-fallback orchestration"
```

---

## Task 10: Staff listing page

Ports `bike-calendars-implementation/src/lib/listing.ts` (`buildListing`, unchanged) plus a new hand-written HTML generator (`buildListingHtml`) replacing the Astro page.

**Files:**
- Create: `svbc-calendars/src/listing.ts`
- Test: `svbc-calendars/src/listing.test.ts`

**Interfaces:**
- Consumes: `CalendarsConfig`, `SourceConfig` (Task 2).
- Produces: `buildListing(config, baseUrl): Listing`, `buildListingHtml(listing: Listing, webAnalyticsToken: string): string` — consumed by Task 12.

- [ ] **Step 1: Write the failing test**

`svbc-calendars/src/listing.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildListing, buildListingHtml } from './listing';
import type { CalendarsConfig } from './types';

const CONFIG: CalendarsConfig = {
  sources: [
    { id: 'santa-clara', name: 'Santa Clara', committeeName: 'Santa Clara BPAC', adapter: 'legistar', client: 'santaclara', bodyId: 232 },
    { id: 'eventbrite-public-events', name: 'SVBC Public Events', committeeName: 'SVBC Events — Public Events', adapter: 'eventbrite', organizerId: '123' },
  ],
};

describe('buildListing', () => {
  it('splits committee sources from Eventbrite sources', () => {
    const listing = buildListing(CONFIG, 'https://committees.bikesiliconvalley.org');
    expect(listing.committees).toEqual([{ id: 'santa-clara', label: 'Santa Clara', href: 'https://committees.bikesiliconvalley.org/calendars/santa-clara.ics' }]);
    expect(listing.events).toEqual([{ id: 'eventbrite-public-events', label: 'SVBC Events — Public Events', href: 'https://committees.bikesiliconvalley.org/calendars/eventbrite-public-events.ics' }]);
  });
});

describe('buildListingHtml', () => {
  it('renders both sections with escaped, linked hrefs', () => {
    const listing = buildListing(CONFIG, 'https://committees.bikesiliconvalley.org');
    const html = buildListingHtml(listing, '');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Santa Clara');
    expect(html).toContain('href="https://committees.bikesiliconvalley.org/calendars/santa-clara.ics"');
    expect(html).not.toContain('cloudflareinsights.com');
  });

  it('includes the Web Analytics beacon when a token is configured', () => {
    const html = buildListingHtml(buildListing(CONFIG, 'https://committees.bikesiliconvalley.org'), 'wa-token-123');
    expect(html).toContain('cloudflareinsights.com/beacon.min.js');
    expect(html).toContain('wa-token-123');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd svbc-calendars && npm test -- src/listing.test.ts`
Expected: FAIL — `./listing` module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

`svbc-calendars/src/listing.ts`:
```ts
import type { CalendarsConfig, SourceConfig } from './types';

export interface ListingRow {
  id: string;
  label: string;
  href: string;
}

export interface Listing {
  committees: ListingRow[];
  events: ListingRow[];
}

export function buildListing(config: CalendarsConfig, baseUrl: string): Listing {
  const toRow = (source: SourceConfig): ListingRow => ({
    id: source.id,
    label: source.adapter === 'eventbrite' ? source.committeeName : source.name,
    href: `${baseUrl}/calendars/${source.id}.ics`,
  });
  return {
    committees: config.sources.filter((s) => s.adapter !== 'eventbrite').map(toRow),
    events: config.sources.filter((s) => s.adapter === 'eventbrite').map(toRow),
  };
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function rowsHtml(rows: ListingRow[]): string {
  return rows.map((row) => `<li>${escapeHtml(row.label)}: <a href="${escapeHtml(row.href)}">${escapeHtml(row.href)}</a></li>`).join('');
}

export function buildListingHtml(listing: Listing, webAnalyticsToken: string): string {
  // No Subresource Integrity hash on this script deliberately: Cloudflare serves
  // beacon.min.js from its own edge and updates it without version pinning, so a pinned SRI
  // hash would break the beacon the next time Cloudflare ships an update. This is the standard,
  // documented way to load Cloudflare Web Analytics.
  const analyticsScript = webAnalyticsToken
    ? `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "${webAnalyticsToken}"}'></script>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SVBC Bike Calendars</title>
${analyticsScript}
</head>
<body>
<h1>SVBC Bike Calendars</h1>
<p>Subscribe to just the calendars you care about. Copy a link below into Google/Apple Calendar, a web page, an email, or a social post.</p>
<h2>Committee Meetings</h2>
<ul>${rowsHtml(listing.committees)}</ul>
<h2>SVBC Events</h2>
<ul>${rowsHtml(listing.events)}</ul>
</body>
</html>`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd svbc-calendars && npm test -- src/listing.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/listing.ts src/listing.test.ts
git commit -m "feat(svbc-calendars): add staff listing page"
```

---

## Task 11: Split `worker.ts` into `eventsApi.ts` and `widget.ts`, fixing the organizer-filter correctness gap

This is the one task that touches already-live, already-tested production code. `worker.ts`'s `fetchEvents` currently fetches org-wide with `page_size` up to 50 and filters by `organizer_id` client-side — with more than ~50 upcoming events across the whole SVBC Eventbrite account, a specific organizer's events past that cutoff are silently dropped. It's replaced with the shared, paginated, organizer-scoped adapter (Task 4), fetching all 3 allowlisted organizers and merging when no `organizer` filter is given. Every other behavior (`EventItem` JSON shape, widget HTML/CSS/JS, CORS, `/widget` query params) is preserved exactly.

**Files:**
- Create: `svbc-calendars/src/eventsApi.ts`
- Create: `svbc-calendars/src/widget.ts`
- Delete: `svbc-calendars/src/worker.ts`
- Modify: `svbc-calendars/test/worker.test.ts` → will be superseded by Task 12's `test/index.test.ts`, but for this task, update its imports to the new modules so it keeps passing standalone (Task 12 does the final consolidation into route-level tests).

**Interfaces:**
- Consumes: `NormalizedEvent`, `Env` (Task 2), `fetchEventbriteEvents` (Task 4).
- Produces: `fetchEventsResponse(env: Env, organizerId: string | null, pageSize: number, cacheTTL: number): Promise<Response>` (from `eventsApi.ts`), `widgetResponse(url: URL, organizerId: string | null): Response` (from `widget.ts`) — both consumed by Task 12's `index.ts`.

- [ ] **Step 1: Write `eventsApi.ts`, porting `worker.ts`'s JSON API logic onto the shared adapter**

`svbc-calendars/src/eventsApi.ts`:
```ts
import type { Env, NormalizedEvent } from './types';
import { fetchEventbriteEvents } from './adapters/eventbrite';

/** Eventbrite organizer IDs allowed via the `organizer` query param. */
export const ALLOWED_ORGANIZERS: string[] = [
  '21763925459', // Silicon Valley Bicycle Coalition (main)
  '17135810858', // Silicon Valley Bicycle Coalition (volunteering)
  '121346572357', // Silicon Valley Bicycle Coalition (bike parking)
];

interface EventVenue {
  name: string;
  city: string;
  address: string;
}

interface EventItem {
  name: string;
  url: string;
  start: { timezone: string; local: string; utc: string };
  end: { timezone: string; local: string; utc: string };
  is_free: boolean;
  online_event: boolean;
  summary: string;
  logo_url: string | null;
  venue: EventVenue | null;
}

interface EventsResponse {
  events: EventItem[];
  total: number;
}

interface ErrorResponse {
  error: string;
  status?: number;
  detail?: string;
}

function jsonResponse(body: EventsResponse | ErrorResponse, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...extraHeaders } });
}

function toEventItem(event: NormalizedEvent): EventItem {
  return {
    name: event.title,
    url: event.url ?? '',
    start: { timezone: event.timezone ?? '', local: event.startLocal ?? '', utc: event.startUtc },
    end: { timezone: event.timezone ?? '', local: event.endLocal ?? '', utc: event.endUtc ?? event.startUtc },
    is_free: event.isFree ?? false,
    online_event: event.onlineEvent ?? false,
    summary: event.summary || event.description?.slice(0, 300) || '',
    logo_url: event.logoUrl ?? null,
    venue: event.venueName ? { name: event.venueName, city: event.venueCity ?? '', address: event.venueAddress ?? '' } : null,
  };
}

/** An ad-hoc EventbriteSourceConfig for organizer-scoped widget fetches (these aren't calendar sources with their own .ics feed — bike parking in particular has none). */
function organizerSource(organizerId: string) {
  return { id: organizerId, name: organizerId, committeeName: '', adapter: 'eventbrite' as const, organizerId };
}

async function fetchOrganizerEvents(organizerId: string, token: string): Promise<NormalizedEvent[]> {
  return fetchEventbriteEvents(organizerSource(organizerId), token, 50);
}

export async function fetchEventsResponse(env: Env, organizerId: string | null, pageSize: number, cacheTTL: number): Promise<Response> {
  let events: NormalizedEvent[];
  try {
    if (organizerId) {
      events = await fetchOrganizerEvents(organizerId, env.EVENTBRITE_TOKEN);
    } else {
      const perOrganizer = await Promise.all(ALLOWED_ORGANIZERS.map((id) => fetchOrganizerEvents(id, env.EVENTBRITE_TOKEN)));
      events = perOrganizer.flat().sort((a, b) => a.startUtc.localeCompare(b.startUtc));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse({ error: 'Eventbrite API error', detail: message }, 502);
  }

  const now = new Date();
  const items = events
    .filter((evt) => new Date(evt.startUtc) > now)
    .slice(0, pageSize)
    .map(toEventItem);

  return jsonResponse({ events: items, total: items.length }, 200, { 'Cache-Control': `public, max-age=${cacheTTL}` });
}
```

- [ ] **Step 2: Write `widget.ts`, moving `worker.ts`'s widget HTML verbatim**

`svbc-calendars/src/widget.ts`:
```ts
export function widgetResponse(url: URL, organizerId: string | null): Response {
  const maxEvents = Math.min(parseInt(url.searchParams.get('max') || '20', 10), 50);
  const showImages = url.searchParams.get('images') !== 'false';
  const showDescriptions = url.searchParams.get('descriptions') !== 'false';
  const layout = url.searchParams.get('layout') === 'grid' ? 'grid' : 'list';

  const html = widgetHTML(maxEvents, showImages, showDescriptions, organizerId, layout);
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

function widgetHTML(
  maxEvents: number,
  showImages: boolean,
  showDescriptions: boolean,
  organizerId: string | null,
  layout: 'list' | 'grid'
): string {
  // Unchanged from events-widgets/src/worker.ts's widgetHTML (styles, card layout, resize
  // postMessage, XSS-safe esc()) — copy that function's body verbatim here, including its full
  // <style> block and inline <script> tags. Only the outbound fetch URL below differs by nothing
  // (still fetches this Worker's own /events with the same query params), so no other line
  // changes.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SVBC Events</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    --svbc-accent: #FCB315;
    --svbc-accent-light: #FEF3D6;
    --svbc-dark: #2C2C2C;
    --svbc-dark-hover: #1a1a1a;
    --svbc-text: #2C2C2C;
    --svbc-text-muted: #6b7280;
    --svbc-border: #e5e7eb;
    --svbc-radius: 10px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    color: var(--svbc-text);
    background: transparent;
    max-width: 720px;
    margin: 0 auto;
    padding: 1rem;
  }
  .svbc-loading { text-align: center; padding: 3rem 1rem; color: var(--svbc-text-muted); font-size: 0.95rem; }
  .svbc-loading-spinner { display: inline-block; width: 28px; height: 28px; border: 3px solid var(--svbc-border); border-top-color: var(--svbc-accent); border-radius: 50%; animation: svbc-spin 0.7s linear infinite; margin-bottom: 0.75rem; }
  @keyframes svbc-spin { to { transform: rotate(360deg); } }
  .svbc-error { text-align: center; padding: 2rem 1rem; color: #b91c1c; background: #fef2f2; border-radius: var(--svbc-radius); font-size: 0.9rem; line-height: 1.5; }
  .svbc-empty { text-align: center; padding: 3rem 1rem; color: var(--svbc-text-muted); font-size: 0.95rem; }
  .svbc-event { border: 1px solid var(--svbc-border); border-radius: var(--svbc-radius); overflow: hidden; margin-bottom: 1.5rem; background: #fff; }
  .svbc-event-header { display: flex; align-items: flex-start; gap: 1rem; padding: 1.25rem 1.5rem; }
  .svbc-date-badge { flex-shrink: 0; width: 54px; text-align: center; background: var(--svbc-accent); border-radius: 8px; padding: 6px 0 8px; }
  .svbc-date-day { display: block; font-size: 1.5rem; font-weight: 700; line-height: 1; color: var(--svbc-text); }
  .svbc-date-month { display: block; font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--svbc-dark); margin-top: 2px; }
  .svbc-event-details { flex: 1; min-width: 0; }
  .svbc-event-title { font-size: 1.15rem; font-weight: 700; line-height: 1.3; margin-bottom: 0.6rem; color: var(--svbc-text); }
  .svbc-meta-row { display: flex; align-items: center; gap: 0.5rem; font-size: 0.88rem; color: var(--svbc-text-muted); line-height: 1.4; margin-bottom: 0.3rem; }
  .svbc-meta-row:last-child { margin-bottom: 0; }
  .svbc-meta-icon { flex-shrink: 0; width: 16px; height: 16px; color: var(--svbc-accent); }
  .svbc-event-img { width: 100%; background: var(--svbc-accent-light); }
  .svbc-event-img img { width: 100%; height: auto; display: block; }
  .svbc-event-body { padding: 1.25rem 1.5rem; }
  .svbc-event-summary { font-size: 0.9rem; color: var(--svbc-text-muted); line-height: 1.6; margin-bottom: 1.25rem; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .svbc-cta { display: inline-block; background: var(--svbc-dark); color: #fff; text-decoration: none; font-size: 0.9rem; font-weight: 600; padding: 0.6rem 1.5rem; border-radius: 6px; transition: background 0.15s ease; }
  .svbc-cta:hover { background: var(--svbc-dark-hover); }
  .svbc-badge { display: inline-block; font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; padding: 2px 7px; border-radius: 4px; margin-left: 0.5rem; vertical-align: middle; }
  .svbc-badge-free { background: var(--svbc-accent-light); color: var(--svbc-dark); }
  .svbc-badge-paid { background: #fef3c7; color: #92400e; }
  .svbc-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1.5rem; }
  @media (max-width: 768px) { .svbc-grid { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 480px) { .svbc-grid { grid-template-columns: 1fr; } }
  .svbc-grid .svbc-event { margin-bottom: 0; display: flex; flex-direction: column; }
  .svbc-grid .svbc-event-img { position: relative; height: 180px; }
  .svbc-grid .svbc-event-img img { height: 100%; object-fit: cover; }
  .svbc-grid .svbc-event-header { padding: 1rem 1.25rem; }
  .svbc-grid .svbc-date-badge { position: absolute; top: 10px; left: 10px; z-index: 1; box-shadow: 0 2px 6px rgba(0,0,0,0.15); }
  .svbc-grid .svbc-event-details { min-width: 0; }
  .svbc-grid .svbc-event-title { font-size: 1.05rem; margin-bottom: 0.5rem; }
  .svbc-grid .svbc-meta-row { font-size: 0.82rem; }
  .svbc-grid .svbc-event-body { padding: 0.75rem 1.25rem 1.25rem; margin-top: auto; }
  .svbc-grid .svbc-event-summary { font-size: 0.85rem; -webkit-line-clamp: 4; margin-bottom: 1rem; }
  body:has(.svbc-grid) { max-width: 1100px; }
</style>
</head>
<body>
<div id="svbc-events"></div>
<script>
(function() {
  var SHOW_IMAGE = ${showImages};
  var SHOW_DESCRIPTION = ${showDescriptions};
  var MAX_EVENTS = ${maxEvents};
  var LAYOUT = "${layout}";

  var SVG_CALENDAR = '<svg class="svbc-meta-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3"/></svg>';
  var SVG_CLOCK = '<svg class="svbc-meta-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/></svg>';
  var SVG_PIN = '<svg class="svbc-meta-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1.5A4.25 4.25 0 0 0 3.75 5.75C3.75 9.25 8 14.5 8 14.5s4.25-5.25 4.25-8.75A4.25 4.25 0 0 0 8 1.5Z"/><circle cx="8" cy="5.75" r="1.5"/></svg>';

  var container = document.getElementById("svbc-events");
  container.innerHTML = '<div class="svbc-loading"><div class="svbc-loading-spinner"></div><div>Loading events\\u2026</div></div>';

  fetch("./events?page_size=" + MAX_EVENTS + "${organizerId ? `&organizer=${organizerId}` : ''}")
    .then(function(res) {
      if (!res.ok) throw new Error("Worker returned " + res.status);
      return res.json();
    })
    .then(function(data) {
      var now = new Date();
      var events = (data.events || []).filter(function(evt) { return new Date(evt.start.utc) > now; });
      if (events.length === 0) {
        container.innerHTML = '<div class="svbc-empty">No upcoming events right now \\u2014 check back soon!</div>';
        return;
      }
      if (LAYOUT === "grid") container.className = "svbc-grid";
      var html = "";
      events.forEach(function(evt) {
        var start = new Date(evt.start.local);
        var end = evt.end ? new Date(evt.end.local) : null;
        var months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
        var fullMonths = ["January","February","March","April","May","June","July","August","September","October","November","December"];
        var fullDays = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
        var month = months[start.getMonth()];
        var day = start.getDate();
        var dateStr = fullDays[start.getDay()] + ", " + fullMonths[start.getMonth()] + " " + day + ", " + start.getFullYear();
        var timeStr = fmtTime(start);
        if (end) timeStr += "-" + fmtTime(end);
        var locationStr = "";
        if (evt.venue && evt.venue.name) {
          locationStr = esc(evt.venue.name);
          if (evt.venue.address) locationStr += " | " + esc(evt.venue.address);
        } else if (evt.online_event) {
          locationStr = "Online Event";
        }
        var badgeHtml = evt.is_free ? '<span class="svbc-badge svbc-badge-free">Free</span>' : '<span class="svbc-badge svbc-badge-paid">Tickets</span>';
        var imgHtml = "";
        if (SHOW_IMAGE && evt.logo_url) {
          imgHtml = '<div class="svbc-event-img"><img src="' + evt.logo_url + '" alt="" loading="lazy"></div>';
        }
        var bodyParts = "";
        if (SHOW_DESCRIPTION && evt.summary) {
          bodyParts += '<div class="svbc-event-summary">' + esc(evt.summary) + '</div>';
        }
        bodyParts += '<a class="svbc-cta" href="' + evt.url + '" target="_blank" rel="noopener">More Information</a>';
        var dateBadge = '<div class="svbc-date-badge"><span class="svbc-date-day">' + day + '</span><span class="svbc-date-month">' + month + '</span></div>';
        if (LAYOUT === "grid") {
          var imgWithBadge = '<div class="svbc-event-img">' + dateBadge;
          if (SHOW_IMAGE && evt.logo_url) {
            imgWithBadge += '<img src="' + evt.logo_url + '" alt="" loading="lazy">';
          }
          imgWithBadge += '</div>';
          html += '<div class="svbc-event">' + imgWithBadge + '<div class="svbc-event-header"><div class="svbc-event-details"><div class="svbc-event-title">' + esc(evt.name) + '</div><div class="svbc-meta-row">' + SVG_CALENDAR + '<span>' + esc(dateStr) + '</span></div><div class="svbc-meta-row">' + SVG_CLOCK + '<span>' + esc(timeStr) + '</span></div>' + (locationStr ? '<div class="svbc-meta-row">' + SVG_PIN + '<span>' + locationStr + '</span></div>' : '') + '</div></div><div class="svbc-event-body">' + bodyParts + '</div></div>';
        } else {
          html += '<div class="svbc-event"><div class="svbc-event-header">' + dateBadge + '<div class="svbc-event-details"><div class="svbc-event-title">' + esc(evt.name) + badgeHtml + '</div><div class="svbc-meta-row">' + SVG_CALENDAR + '<span>' + esc(dateStr) + '</span></div><div class="svbc-meta-row">' + SVG_CLOCK + '<span>' + esc(timeStr) + '</span></div>' + (locationStr ? '<div class="svbc-meta-row">' + SVG_PIN + '<span>' + locationStr + '</span></div>' : '') + '</div></div>' + imgHtml + '<div class="svbc-event-body">' + bodyParts + '</div></div>';
        }
      });
      container.innerHTML = html;
    })
    .catch(function(err) {
      console.error("SVBC Events Widget Error:", err);
      container.innerHTML = '<div class="svbc-error"><strong>Couldn\\'t load events.</strong><br>Check the browser console for details.</div>';
    });

  function fmtTime(d) {
    var h = d.getHours(), m = d.getMinutes();
    var ampm = h >= 12 ? "pm" : "am";
    h = h % 12 || 12;
    return h + ":" + (m < 10 ? "0" : "") + m + ampm;
  }
  function esc(str) {
    if (!str) return "";
    return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }
})();
<\/script>
<script>
(function(){
  function postHeight(){
    var h = document.documentElement.scrollHeight;
    window.parent.postMessage({svbcEventsHeight: h}, "*");
  }
  new ResizeObserver(postHeight).observe(document.body);
  postHeight();
})();
<\/script>
</body>
</html>`;
}
```

- [ ] **Step 3: Delete the old single-file worker**

```bash
cd svbc-calendars
git rm src/worker.ts
```

- [ ] **Step 4: Update `test/worker.test.ts`'s import to the new entrypoint (Task 12 hasn't built `index.ts` yet, so point it at `eventsApi`/`widget` directly for now — Task 12 replaces this file with route-level tests against the real router)**

In `svbc-calendars/test/worker.test.ts`, this test file called `worker.fetch(request, env, ctx)` against the old single default export — that export no longer exists. Rather than patch it twice, delete it now; Task 12 rewrites equivalent (and more complete) coverage as `test/index.test.ts` against the real router, including every case this file had (`/events`, `/`, `/widget`, CORS, cache headers, `page_size` clamping, Eventbrite error propagation, `/widget` query params).

```bash
git rm test/worker.test.ts
```

- [ ] **Step 5: Confirm the package still typechecks (no test runner target yet — `index.ts` doesn't exist until Task 12)**

Run: `cd svbc-calendars && npx tsc --noEmit`
Expected: The only errors are about `src/index.ts` not existing yet if anything still references it (nothing does yet) — `eventsApi.ts` and `widget.ts` typecheck cleanly on their own. If any other file errors, fix it before continuing.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(svbc-calendars): split worker.ts into eventsApi.ts and widget.ts, fix organizer-filter pagination gap"
```

---

## Task 12: Router (`index.ts`) — wires every route together

**Files:**
- Create: `svbc-calendars/src/index.ts`
- Create: `svbc-calendars/test/index.test.ts` (supersedes the deleted `test/worker.test.ts`, keeping every case it had, plus new cases for `/calendars/:id.ics`, `/calendars`, and `/status.json`)

**Interfaces:**
- Consumes: `fetchEventsResponse` (Task 11), `widgetResponse` (Task 11), `getSourceCalendar` (Task 9), `createFetchSourceEvents` (Task 5), `buildListing`/`buildListingHtml` (Task 10), `getAllSourceStatuses` (Task 7), `validateConfig` (Task 2), `sendFailureAlert` (Task 8), `Env` (Task 2).
- Produces: the Worker's default export (`{ fetch, scheduled }`) — `scheduled` is added in Task 13; this task's export has `fetch` only, with `scheduled` a no-op placeholder that Task 13 replaces (not left undefined, since `wrangler.jsonc`'s `triggers.crons` — added in Task 16 — requires the export to exist by deploy time; defining it now as an explicit empty implementation, replaced in full in Task 13, keeps every intermediate commit deployable).

- [ ] **Step 1: Write the failing test**

`svbc-calendars/test/index.test.ts` (full replacement for the old `test/worker.test.ts`; keeps every existing case and adds calendar-route cases):
```ts
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import worker from "../src/index";
import rawConfig from "../config/sources.json";
import { validateConfig } from "../src/config";

const ORIGIN = "http://localhost";
const config = validateConfig(rawConfig);

function req(path: string, opts: { method?: string; origin?: string } = {}): Request {
  return new Request(`http://worker.test${path}`, { method: opts.method ?? "GET", headers: opts.origin ? { Origin: opts.origin } : {} });
}

async function call(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function fakeEventbriteResponse(overrides: Record<string, unknown>[] = []) {
  const events = overrides.length > 0 ? overrides : [
    {
      id: "evt-1",
      name: { text: "Bike to Work Day" },
      url: "https://eventbrite.com/e/123",
      is_free: true,
      online_event: false,
      logo: { url: "https://img.example.com/logo.png", original: { url: "https://img.example.com/logo-original.png" } },
      start: { timezone: "America/Los_Angeles", local: "2099-05-15T08:00:00", utc: "2099-05-15T15:00:00Z" },
      end: { timezone: "America/Los_Angeles", local: "2099-05-15T10:00:00", utc: "2099-05-15T17:00:00Z" },
      summary: "Join us for Bike to Work Day!",
      venue: { name: "City Hall", address: { city: "San Jose", localized_address_display: "200 E Santa Clara St, San Jose, CA" } },
    },
  ];
  return { events, pagination: { has_more_items: false } };
}

const originalFetch = globalThis.fetch;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeAll(() => {
  fetchSpy = vi.fn();
  globalThis.fetch = fetchSpy;
});

beforeEach(async () => {
  const cache = caches.default;
  const version = env.CACHE_VERSION || "0";
  for (const key of [
    `http://worker.test/events?page_size=20&organizer=all&v=${version}`,
    `http://worker.test/events?page_size=50&organizer=all&v=${version}`,
  ]) {
    await cache.delete(new Request(key));
  }
  for (const source of config.sources) {
    await cache.delete(new Request(`http://worker.test/calendars/${source.id}.ics?v=${version}`));
    await env.CALENDAR_KV.delete(`ics:${source.id}`);
    await env.CALENDAR_KV.delete(`status:${source.id}`);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  fetchSpy.mockReset();
});

function mockEventbrite(body = fakeEventbriteResponse()) {
  fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("eventbriteapi.com")) {
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
}

describe("routing (existing events-widgets behavior, preserved)", () => {
  it("GET /events returns 200 with events", async () => {
    mockEventbrite();
    const res = await call(req("/events"));
    expect(res.status).toBe(200);
    const data = await res.json<{ events: unknown[]; total: number }>();
    expect(data.events).toHaveLength(1);
  });

  it("GET / also returns events", async () => {
    mockEventbrite();
    const res = await call(req("/"));
    expect(res.status).toBe(200);
  });

  it("GET /widget returns 200 with text/html", async () => {
    const res = await call(req("/widget"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html;charset=UTF-8");
  });

  it("OPTIONS returns 204 with CORS headers", async () => {
    const res = await call(req("/events", { method: "OPTIONS" }));
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("GET, OPTIONS");
  });

  it("allowed origin is reflected", async () => {
    mockEventbrite();
    const res = await call(req("/events", { origin: "https://www.bikesiliconvalley.org" }));
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://www.bikesiliconvalley.org");
  });

  it("disallowed origin gets wildcard", async () => {
    mockEventbrite();
    const res = await call(req("/events", { origin: "https://evil.com" }));
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("GET /nonexistent returns 404", async () => {
    const res = await call(req("/nonexistent"));
    expect(res.status).toBe(404);
  });

  it("POST /events returns 405", async () => {
    const res = await call(req("/events", { method: "POST" }));
    expect(res.status).toBe(405);
  });

  it("clamps page_size to 50", async () => {
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("eventbriteapi.com")) {
        return new Response(JSON.stringify(fakeEventbriteResponse()), { status: 200 });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });
    const res = await call(req("/events?page_size=999"));
    expect(res.status).toBe(200);
  });

  it("propagates an Eventbrite fetch failure as a 502 error", async () => {
    fetchSpy.mockImplementation(async () => new Response("Unauthorized", { status: 401, statusText: "Unauthorized" }));
    const res = await call(req("/events"));
    expect(res.status).toBe(502);
    const data = await res.json<{ error: string }>();
    expect(data.error).toBe("Eventbrite API error");
  });

  it("/widget respects the max query param", async () => {
    const res = await call(req("/widget?max=5"));
    const html = await res.text();
    expect(html).toContain("var MAX_EVENTS = 5");
  });

  it("/widget respects images=false", async () => {
    const res = await call(req("/widget?images=false"));
    const html = await res.text();
    expect(html).toContain("var SHOW_IMAGE = false");
  });

  it("first request returns X-Cache: MISS, second identical request returns X-Cache: HIT", async () => {
    mockEventbrite();
    const first = await call(req("/events"));
    expect(first.headers.get("X-Cache")).toBe("MISS");

    const second = await call(req("/events"));
    expect(second.headers.get("X-Cache")).toBe("HIT");
  });
});

describe("multi-organizer merge (the fixed correctness gap)", () => {
  it("GET /events with no organizer param fetches and merges all 3 allowlisted organizers", async () => {
    let calls = 0;
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      calls += 1;
      return new Response(JSON.stringify(fakeEventbriteResponse()), { status: 200 });
    });
    const res = await call(req("/events"));
    expect(res.status).toBe(200);
    expect(calls).toBe(3); // one organizer-scoped fetch per allowlisted organizer — cache was cleared in beforeEach, so this is a guaranteed MISS
  });
});

describe("calendars", () => {
  it("GET /calendars/santa-clara.ics returns a live-fetched ICS feed", async () => {
    fetchSpy.mockImplementation(async (url: string | URL) => {
      expect(String(url)).toContain("webapi.legistar.com");
      return new Response("[]", { status: 200 });
    });
    const res = await call(req("/calendars/santa-clara.ics"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/calendar; charset=utf-8");
    expect(await res.text()).toContain("BEGIN:VCALENDAR");
  });

  it("GET /calendars/unknown-source.ics returns 404", async () => {
    const res = await call(req("/calendars/unknown-source.ics"));
    expect(res.status).toBe(404);
  });

  it("GET /calendars returns the staff listing HTML", async () => {
    const res = await call(req("/calendars"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Santa Clara");
  });

  it("GET /status.json returns a status map for every configured source", async () => {
    const res = await call(req("/status.json"));
    expect(res.status).toBe(200);
    const data = await res.json<Record<string, unknown>>();
    expect(Object.keys(data)).toEqual(expect.arrayContaining(["santa-clara", "eventbrite-public-events"]));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd svbc-calendars && npm test -- test/index.test.ts`
Expected: FAIL — `../src/index` module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

`svbc-calendars/src/index.ts`:
```ts
import rawConfig from '../config/sources.json';
import { validateConfig } from './config';
import { createFetchSourceEvents } from './adapters/dispatch';
import { fetchEventsResponse } from './eventsApi';
import { widgetResponse } from './widget';
import { getSourceCalendar } from './calendarSource';
import { buildCalendar } from './ics';
import { buildListing, buildListingHtml } from './listing';
import { getAllSourceStatuses } from './calendarStore';
import { sendFailureAlert } from './alert';
import type { Env } from './types';

const config = validateConfig(rawConfig);

const ALLOWED_ORIGINS: string[] = ['https://www.bikesiliconvalley.org', 'https://bikesiliconvalley.org', 'http://localhost'];

function handleCORS(request: Request, response: Response): Response {
  const origin = request.headers.get('Origin') || '';
  const headers = new Headers(response.headers);
  if (origin === '' || !ALLOWED_ORIGINS.includes(origin)) {
    headers.set('Access-Control-Allow-Origin', '*');
  } else {
    headers.set('Access-Control-Allow-Origin', origin);
  }
  headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(response.body, { status: response.status, headers });
}

/**
 * Cache-aside wrapper shared by every cached route: serve caches.default on a HIT (tagging
 * X-Cache: HIT); on a MISS, call `generate`, tag X-Cache: MISS, and — only for a successful
 * (`ok`) response — write it to the cache in the background via ctx.waitUntil so the response
 * isn't delayed by the cache write. A non-ok response (404, 503) is deliberately never cached,
 * so the next request retries live instead of serving a cached failure for the full TTL.
 */
async function withCache(cacheKey: Request, ttlSeconds: number, ctx: ExecutionContext, generate: () => Promise<Response>): Promise<Response> {
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    const response = new Response(cached.body, cached);
    response.headers.set('X-Cache', 'HIT');
    return response;
  }
  const fresh = await generate();
  const response = new Response(fresh.body, fresh);
  response.headers.set('X-Cache', 'MISS');
  if (fresh.ok) {
    // Set on the response returned to THIS caller too, not just the cached copy — otherwise a
    // MISS response has no Cache-Control while the HIT response served from `cached` on the next
    // request does (it was stored with one), which is an inconsistent, confusing mismatch for
    // any downstream cache/browser respecting standard HTTP caching headers.
    response.headers.set('Cache-Control', `public, max-age=${ttlSeconds}`);
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
}

async function handleCalendarIcs(sourceId: string, env: Env): Promise<Response> {
  const source = config.sources.find((s) => s.id === sourceId);
  if (!source) {
    return new Response('Not found', { status: 404 });
  }
  const result = await getSourceCalendar(source, {
    kv: env.CALENDAR_KV,
    fetchSourceEvents: createFetchSourceEvents(env.EVENTBRITE_TOKEN),
    sendFailureAlert,
    slackWebhookUrl: env.SLACK_WEBHOOK_URL,
    now: () => new Date(),
  });
  if (result.ics === null) {
    return new Response('This calendar has never successfully synced and has no cached fallback.', { status: 503 });
  }
  return new Response(result.ics, {
    status: 200,
    headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'X-Served-From': result.servedFromFallback ? 'fallback' : 'live' },
  });
}

async function handleCalendarListing(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const listing = buildListing(config, url.origin);
  const html = buildListingHtml(listing, env.CF_WEB_ANALYTICS_TOKEN ?? '');
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

// /status.json is deliberately never cached (no withCache wrapping) — its whole purpose is
// reflecting current per-source health, and caching it for the same ~24h TTL as the calendar
// routes would hide a fresh failure from anyone checking it for up to a day.
async function handleStatus(env: Env): Promise<Response> {
  const statuses = await getAllSourceStatuses(env.CALENDAR_KV, config.sources.map((s) => s.id));
  return new Response(JSON.stringify(statuses, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return handleCORS(request, new Response(null, { status: 204 }));
    }
    if (request.method !== 'GET') {
      return handleCORS(request, new Response('Method not allowed', { status: 405 }));
    }

    const url = new URL(request.url);
    const organizerId = url.searchParams.get('organizer');
    const version = env.CACHE_VERSION || '0';

    if (url.pathname === '/widget') {
      return handleCORS(request, widgetResponse(url, organizerId));
    }
    if (url.pathname === '/' || url.pathname === '/events') {
      const pageSize = Math.min(parseInt(url.searchParams.get('page_size') || '20', 10), 50);
      const cacheTTL = parseInt(env.CACHE_TTL || '900', 10);
      const cacheKey = new Request(`${url.origin}/events?page_size=${pageSize}&organizer=${organizerId || 'all'}&v=${version}`, { method: 'GET' });
      return handleCORS(request, await withCache(cacheKey, cacheTTL, ctx, () => fetchEventsResponse(env, organizerId, pageSize, cacheTTL)));
    }
    if (url.pathname === '/calendars') {
      const calendarTTL = parseInt(env.CALENDAR_CACHE_TTL || '86400', 10);
      const cacheKey = new Request(`${url.origin}/calendars?v=${version}`, { method: 'GET' });
      return handleCORS(request, await withCache(cacheKey, calendarTTL, ctx, () => handleCalendarListing(request, env)));
    }
    const icsMatch = /^\/calendars\/([a-z0-9-]+)\.ics$/.exec(url.pathname);
    if (icsMatch) {
      const sourceId = icsMatch[1];
      const calendarTTL = parseInt(env.CALENDAR_CACHE_TTL || '86400', 10);
      const cacheKey = new Request(`${url.origin}/calendars/${sourceId}.ics?v=${version}`, { method: 'GET' });
      return handleCORS(request, await withCache(cacheKey, calendarTTL, ctx, () => handleCalendarIcs(sourceId, env)));
    }
    if (url.pathname === '/status.json') {
      return handleCORS(request, await handleStatus(env));
    }

    return handleCORS(request, new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } }));
  },

  async scheduled(): Promise<void> {
    // Replaced in full by Task 13 — kept as an explicit no-op here so every commit stays
    // deployable once wrangler.jsonc's cron trigger is added in Task 16.
  },
} satisfies ExportedHandler<Env>;
```

Note: `buildCalendar` is listed in this task's "Interfaces: Consumes" for completeness of what this file's dependency graph touches (it's used inside `calendarSource.ts`, which `index.ts` calls into) — do not add `import { buildCalendar } from './ics';` to the actual `index.ts`; nothing in this file calls it directly.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd svbc-calendars && npm test -- test/index.test.ts`
Expected: PASS (every test in every `describe` block above — count them by reading the file, don't hardcode a number here). If the "multi-organizer merge" test's call count isn't exactly 3, check that `ALLOWED_ORGANIZERS` in `eventsApi.ts` still has exactly 3 entries and that the cache was actually cleared in `beforeEach` (a cache hit would short-circuit the fetch entirely and the count would be 0, not a wrong non-zero number — if you see 0, the cache-key clearing loop needs the same key shape the real handler uses; add a log line temporarily to confirm the exact cache key the route constructs, if it doesn't match the manual `beforeEach` list above, adjust the list to match reality — do this by inspection, not by weakening the assertion).

- [ ] **Step 5: Run the full test suite and typecheck**

```bash
cd svbc-calendars
npm test
npx tsc --noEmit
```
Expected: All tests across every file from Tasks 2-12 pass; no type errors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(svbc-calendars): add unified router for events, widget, calendars, and status routes"
```

---

## Task 13: Daily cron — proactively warm every source

New code. Without this, a low-traffic source's KV status/fallback only updates when someone happens to request it — this closes that gap and restores the "guaranteed daily check regardless of traffic" property `committee-calendars`'s cron had.

**Files:**
- Modify: `svbc-calendars/src/index.ts` (replace the `scheduled()` no-op)
- Create: `svbc-calendars/src/scheduled.test.ts`

**Interfaces:**
- Consumes: `getSourceCalendar` (Task 9), `createFetchSourceEvents` (Task 5), `config` (module-level, Task 2/12), `Env` (Task 2).
- Produces: nothing new exported — this task only changes the Worker's `scheduled` handler behavior.

- [ ] **Step 1: Write the failing test**

`svbc-calendars/src/scheduled.test.ts`:
```ts
import { env } from 'cloudflare:workers';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import worker from './index';
import rawConfig from '../config/sources.json';
import { validateConfig } from './config';
import { getLastKnownGoodIcs } from './calendarStore';

const config = validateConfig(rawConfig);

describe('scheduled', () => {
  beforeEach(async () => {
    for (const source of config.sources) {
      await env.CALENDAR_KV.delete(`ics:${source.id}`);
      await env.CALENDAR_KV.delete(`status:${source.id}`);
    }
  });
  afterEach(() => vi.unstubAllGlobals());

  it('warms every configured source into KV', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        if (String(url).includes('eventbriteapi.com')) {
          return new Response(JSON.stringify({ events: [], pagination: { has_more_items: false } }), { status: 200 });
        }
        if (String(url).includes('legistar')) {
          return new Response('[]', { status: 200 });
        }
        // CivicPlus and Caltrain BATAC return ICS/HTML text; an empty body parses to zero events.
        return new Response('', { status: 200 });
      })
    );

    await worker.scheduled!({} as ScheduledController, env, {} as ExecutionContext);

    for (const source of config.sources) {
      expect(await getLastKnownGoodIcs(env.CALENDAR_KV, source.id)).toContain('BEGIN:VCALENDAR');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd svbc-calendars && npm test -- src/scheduled.test.ts`
Expected: FAIL — the current `scheduled()` no-op never writes to KV, so `getLastKnownGoodIcs` returns `null` for every source, not a string containing `BEGIN:VCALENDAR`.

- [ ] **Step 3: Replace the `scheduled()` no-op in `src/index.ts`**

Replace:
```ts
  async scheduled(): Promise<void> {
    // Replaced in full by Task 13 — kept as an explicit no-op here so every commit stays
    // deployable once wrangler.jsonc's cron trigger is added in Task 16.
  },
```
with:
```ts
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const fetchSourceEvents = createFetchSourceEvents(env.EVENTBRITE_TOKEN);
    for (const source of config.sources) {
      await getSourceCalendar(source, {
        kv: env.CALENDAR_KV,
        fetchSourceEvents,
        sendFailureAlert,
        slackWebhookUrl: env.SLACK_WEBHOOK_URL,
        now: () => new Date(),
      });
    }
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd svbc-calendars && npm test -- src/scheduled.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Run the full suite**

```bash
cd svbc-calendars && npm test
```
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/scheduled.test.ts
git commit -m "feat(svbc-calendars): add daily cron to proactively warm every source into KV"
```

---

## Task 14: Workers Analytics Engine — per-route, per-source metrics

**Files:**
- Create: `svbc-calendars/src/metrics.ts`
- Create: `svbc-calendars/src/metrics.test.ts`
- Modify: `svbc-calendars/src/index.ts` (call `recordMetric` from each route)

**Interfaces:**
- Consumes: `Env` (Task 2).
- Produces: `recordMetric(env: Env, point: MetricPoint): void` — consumed by `index.ts`'s route handlers.

- [ ] **Step 1: Write the failing test**

`svbc-calendars/src/metrics.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { recordMetric } from './metrics';
import type { Env } from './types';

describe('recordMetric', () => {
  it('writes a data point with the route, source id, and outcome as blobs and a count as a double', () => {
    const writeDataPoint = vi.fn();
    const env = { CALENDAR_ANALYTICS: { writeDataPoint } } as unknown as Env;

    recordMetric(env, { route: 'calendars.ics', sourceId: 'santa-clara', outcome: 'live' });

    expect(writeDataPoint).toHaveBeenCalledWith({
      blobs: ['calendars.ics', 'santa-clara', 'live'],
      doubles: [1],
      indexes: ['santa-clara'],
    });
  });

  it('does not throw when the binding is missing (e.g. local dev without the dataset configured)', () => {
    const env = {} as Env;
    expect(() => recordMetric(env, { route: 'events', sourceId: 'all', outcome: 'live' })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd svbc-calendars && npm test -- src/metrics.test.ts`
Expected: FAIL — `./metrics` module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

`svbc-calendars/src/metrics.ts`:
```ts
import type { Env } from './types';

export interface MetricPoint {
  route: string;
  sourceId: string;
  outcome: 'live' | 'fallback' | 'error' | 'cache-hit';
}

export function recordMetric(env: Env, point: MetricPoint): void {
  if (!env.CALENDAR_ANALYTICS) {
    return;
  }
  env.CALENDAR_ANALYTICS.writeDataPoint({
    blobs: [point.route, point.sourceId, point.outcome],
    doubles: [1],
    indexes: [point.sourceId],
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd svbc-calendars && npm test -- src/metrics.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire `recordMetric` into `index.ts`'s calendar and events routes**

In `svbc-calendars/src/index.ts`, add the import:
```ts
import { recordMetric } from './metrics';
```
In `handleCalendarIcs`, right before each `return`, add the matching call — after the 404 branch:
```ts
  if (!source) {
    recordMetric(env, { route: 'calendars.ics', sourceId, outcome: 'error' });
    return new Response('Not found', { status: 404 });
  }
```
and after computing `result`:
```ts
  recordMetric(env, { route: 'calendars.ics', sourceId, outcome: result.ics === null ? 'error' : result.servedFromFallback ? 'fallback' : 'live' });
```
(placed before the `if (result.ics === null)` check, so every outcome is recorded exactly once). Note `handleCalendarIcs` only runs on a cache MISS (it's the `generate` callback `withCache` calls) — a cache HIT never reaches these `recordMetric` calls, which is intentional: they track "how often we actually attempted the source," not raw request volume. Cache hits are recorded separately in the next step.

- [ ] **Step 6: Record a `'cache-hit'` metric at each `withCache` call site**

After each of the three `await withCache(...)` calls in `fetch()` (the `/events` branch, the `/calendars` branch, and the `/calendars/:id.ics` branch), check the returned response's `X-Cache` header and record a hit — for example, the `/calendars/:id.ics` branch becomes:
```ts
    const icsMatch = /^\/calendars\/([a-z0-9-]+)\.ics$/.exec(url.pathname);
    if (icsMatch) {
      const sourceId = icsMatch[1];
      const calendarTTL = parseInt(env.CALENDAR_CACHE_TTL || '86400', 10);
      const cacheKey = new Request(`${url.origin}/calendars/${sourceId}.ics?v=${version}`, { method: 'GET' });
      const response = await withCache(cacheKey, calendarTTL, ctx, () => handleCalendarIcs(sourceId, env));
      if (response.headers.get('X-Cache') === 'HIT') {
        recordMetric(env, { route: 'calendars.ics', sourceId, outcome: 'cache-hit' });
      }
      return handleCORS(request, response);
    }
```
Apply the same pattern to the `/events` branch (`route: 'events', sourceId: organizerId || 'all'`) and the `/calendars` branch (`route: 'calendars', sourceId: 'all'`).

- [ ] **Step 7: Run the full suite**

```bash
cd svbc-calendars && npm test
```
Expected: all tests pass — the existing `/calendars/:id.ics` tests in `test/index.test.ts` don't assert on `CALENDAR_ANALYTICS`, so this addition is invisible to them.

- [ ] **Step 8: Commit**

```bash
git add src/metrics.ts src/metrics.test.ts src/index.ts
git commit -m "feat(svbc-calendars): record per-route, per-source metrics to Workers Analytics Engine"
```

---

## Task 15: Cloudflare Web Analytics beacon on public-facing HTML

`buildListingHtml` (Task 10) already accepts and conditionally renders a `webAnalyticsToken`. This task adds the same beacon to the widget HTML and wires the real token through from `env`.

**Files:**
- Modify: `svbc-calendars/src/widget.ts` (accept a token parameter, inject the beacon script)
- Modify: `svbc-calendars/src/index.ts` (pass `env.CF_WEB_ANALYTICS_TOKEN` through to `widgetResponse`)
- Modify: `svbc-calendars/test/index.test.ts` (add one assertion)

**Interfaces:**
- Modifies: `widgetResponse(url: URL, organizerId: string | null, webAnalyticsToken: string): Response` — signature gains a required third parameter; `index.ts`'s one call site updates accordingly.

- [ ] **Step 1: Write the failing test**

Add to `svbc-calendars/test/index.test.ts`, inside the `"routing (existing events-widgets behavior, preserved)"` describe block:
```ts
  it("GET /widget includes the Web Analytics beacon when CF_WEB_ANALYTICS_TOKEN is set", async () => {
    const res = await call(req("/widget"));
    const html = await res.text();
    expect(html).toContain("cloudflareinsights.com/beacon.min.js");
    expect(html).toContain(env.CF_WEB_ANALYTICS_TOKEN);
  });
```

- [ ] **Step 2: Add a test-only `CF_WEB_ANALYTICS_TOKEN` to `wrangler.jsonc`'s vars**

In `svbc-calendars/wrangler.jsonc`, add to `"vars"`:
```jsonc
    "CF_WEB_ANALYTICS_TOKEN": "test-analytics-token-placeholder",
```
(Task 16 documents replacing this with the real Cloudflare Web Analytics site token before the production deploy — this placeholder is what miniflare's test environment reads and what local `wrangler dev` uses; it's not a secret, Web Analytics tokens are meant to be public/client-visible.)

- [ ] **Step 3: Run test to verify it fails**

Run: `cd svbc-calendars && npm test -- test/index.test.ts -t "Web Analytics beacon"`
Expected: FAIL — `widget.ts` doesn't render any beacon script yet.

- [ ] **Step 4: Update `widgetResponse` and `widgetHTML` in `widget.ts` to accept and render the token**

Change the function signatures:
```ts
export function widgetResponse(url: URL, organizerId: string | null, webAnalyticsToken: string): Response {
  const maxEvents = Math.min(parseInt(url.searchParams.get('max') || '20', 10), 50);
  const showImages = url.searchParams.get('images') !== 'false';
  const showDescriptions = url.searchParams.get('descriptions') !== 'false';
  const layout = url.searchParams.get('layout') === 'grid' ? 'grid' : 'list';

  const html = widgetHTML(maxEvents, showImages, showDescriptions, organizerId, layout, webAnalyticsToken);
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

function widgetHTML(
  maxEvents: number,
  showImages: boolean,
  showDescriptions: boolean,
  organizerId: string | null,
  layout: 'list' | 'grid',
  webAnalyticsToken: string
): string {
```
And inside `widgetHTML`'s returned template literal, add the beacon script right after `<title>SVBC Events</title>`:
```ts
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SVBC Events</title>
${webAnalyticsToken ? `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "${webAnalyticsToken}"}'></script>` : ''}
<style>
```
(everything after `<style>` is unchanged from Task 11).

- [ ] **Step 5: Update the one call site in `index.ts`**

```ts
    if (url.pathname === '/widget') {
      return handleCORS(request, widgetResponse(url, organizerId, env.CF_WEB_ANALYTICS_TOKEN ?? ''));
    }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd svbc-calendars && npm test`
Expected: all tests pass, including the new beacon assertion.

- [ ] **Step 7: Commit**

```bash
git add src/widget.ts src/index.ts test/index.test.ts wrangler.jsonc
git commit -m "feat(svbc-calendars): add Cloudflare Web Analytics beacon to the widget"
```

---

## Task 16: Finalize `wrangler.jsonc`, provision Cloudflare resources, update `README.md`/`CLAUDE.md`

**Files:**
- Modify: `svbc-calendars/wrangler.jsonc` (final shape: both custom domains, real KV id, Analytics Engine dataset, cron trigger, `CALENDAR_CACHE_TTL` var)
- Modify: `svbc-calendars/README.md`
- Modify: `svbc-calendars/CLAUDE.md`

**Interfaces:** None — configuration and documentation only.

- [ ] **Step 1: Create the real KV namespace**

```bash
cd svbc-calendars
npx wrangler kv namespace create CALENDAR_KV
```
This prints an `id`. Copy it.

- [ ] **Step 2: Update `wrangler.jsonc` to its final shape**

Replace the whole file:
```jsonc
{
  "name": "svbc-calendars",
  "main": "src/index.ts",
  "account_id": "f323cb191edeb5d30acc4d289427a010", // SVBC Account — forks: replace with your own
  "compatibility_date": "2026-08-27",
  "upload_source_maps": true,
  "workers_dev": false,
  "preview_urls": false,
  "routes": [
    { "pattern": "events.bikesiliconvalley.org", "custom_domain": true },
    { "pattern": "committees.bikesiliconvalley.org", "custom_domain": true }
  ],
  "kv_namespaces": [
    {
      "binding": "CALENDAR_KV",
      "id": "REPLACE_WITH_THE_ID_PRINTED_BY_STEP_1"
    }
  ],
  "analytics_engine_datasets": [
    {
      "binding": "CALENDAR_ANALYTICS",
      "dataset": "svbc_calendars"
    }
  ],
  // The Eventbrite private token and Slack webhook are secrets, NOT in this file:
  //   npx wrangler secret put EVENTBRITE_TOKEN
  //   npx wrangler secret put SLACK_WEBHOOK_URL
  "vars": {
    "EVENTBRITE_ORG_ID": "9974694499",
    "CACHE_TTL": "900", // /events, /widget — 15 min, unchanged from events-widgets
    "CALENDAR_CACHE_TTL": "86400", // /calendars/*.ics, /calendars — 24h, "nothing needs to be real-time"
    "CACHE_VERSION": "1", // reset to 1 for the new merged Worker's cache key space
    "CF_WEB_ANALYTICS_TOKEN": "REPLACE_WITH_THE_REAL_WEB_ANALYTICS_SITE_TOKEN"
  },
  "triggers": {
    // Daily at 13:00 UTC (5am/6am Pacific depending on DST), matching committee-calendars' prior schedule.
    "crons": ["0 13 * * *"]
  },
  "observability": {
    "enabled": true
  }
}
```

Getting the real `CF_WEB_ANALYTICS_TOKEN` requires enabling Web Analytics for `bikesiliconvalley.org` (or its subdomains) in the Cloudflare dashboard (Analytics & Logs → Web Analytics → Add a site) — this is a dashboard action, not a CLI command; do it manually and paste the resulting token in.

- [ ] **Step 3: Set the secrets on the real Worker (skip if this is a dry run without deploy access yet)**

```bash
npx wrangler secret put EVENTBRITE_TOKEN
npx wrangler secret put SLACK_WEBHOOK_URL
```

- [ ] **Step 4: Rewrite `README.md`**

Replace `svbc-calendars/README.md` with these sections, in order, each pulling its facts from the source noted:
1. **Title + one-paragraph summary** — "SVBC Calendars" — Eventbrite widget (unchanged from `events-widgets/README.md`'s summary) plus 9-source ICS calendar feeds and a staff listing page (from `bike-calendars-implementation/README.md`'s "The ask"/"Coverage" sections).
2. **Architecture diagram** — adapt `events-widgets/README.md`'s ASCII diagram, adding a second inbound arrow from `committees.bikesiliconvalley.org` alongside the existing `events.bikesiliconvalley.org` one, both hitting the same Worker box; keep its "Why a proxy?" explanation for `EVENTBRITE_TOKEN` verbatim.
3. **Per-source adapters table** — copy `bike-calendars-implementation/README.md`'s "Per-source adapters" table verbatim (Legistar/CivicPlus/Caltrain/Eventbrite × 9 sources).
4. **How it works** — replace `bike-calendars-implementation/README.md`'s daily-rebuild description with: live per-request fetch, `caches.default` edge cache (TTLs from this task's `wrangler.jsonc`: 900s for `/events`/`/widget`, 86400s for `/calendars/*`), KV last-known-good fallback on a source failing, daily cron warming (Task 13), `/status.json` for live health.
5. **Setup** — copy `events-widgets/README.md`'s "Setup" steps 1-3 (clone/install, `wrangler login`, `wrangler secret put EVENTBRITE_TOKEN`) verbatim, add a 4th: `wrangler secret put SLACK_WEBHOOK_URL`.
6. **Deploy** — `npx wrangler deploy`, note both custom domains from this task's `wrangler.jsonc`.
7. **Widget embed snippet** — copy `events-widgets/README.md`'s Squarespace `<iframe>` embed snippet verbatim (the widget's public embed contract hasn't changed).
8. **Commands** — copy `bike-calendars-implementation/README.md`'s "Commands" list, replacing `astro dev`/`astro build`/`astro check` with `npm run dev`/(no separate build — Wrangler transpiles)/`npm run typecheck`.

- [ ] **Step 5: Rewrite `CLAUDE.md`**

Replace `svbc-calendars/CLAUDE.md`'s "Architecture" section with a bullet per module, one line each: `src/index.ts` (router — CORS, `withCache`, dispatches every route), `src/eventsApi.ts` + `src/widget.ts` (the Eventbrite widget, unchanged behavior), `src/adapters/*` (one file per source platform — Legistar, CivicPlus, Caltrain BATAC, Eventbrite — dispatched via `src/adapters/dispatch.ts`), `src/calendarSource.ts` + `src/calendarStore.ts` (live-fetch-or-KV-fallback orchestration and the KV read/write layer), `src/ics.ts` (ICS building), `src/listing.ts` (staff listing page), `src/metrics.ts` (Workers Analytics Engine), `config/sources.json` (the 9 sources). Replace "Key details" 's Worker-serves-3-routes line with the full route list from Task 12's `index.ts`.

- [ ] **Step 6: Verify locally**

```bash
npm test
npx tsc --noEmit
npm run dev
```
In another terminal:
```bash
curl http://localhost:8787/calendars/santa-clara.ics
curl http://localhost:8787/status.json
curl http://localhost:8787/widget
```
Expected: all three return successfully (the local dev server uses the real `EVENTBRITE_TOKEN`/`SLACK_WEBHOOK_URL` from `.dev.vars` — copy `.dev.vars.example` to `.dev.vars` first if not already present).

- [ ] **Step 7: Commit**

```bash
git add wrangler.jsonc README.md CLAUDE.md
git commit -m "chore(svbc-calendars): finalize Wrangler config, provision KV, update docs"
```

---

## Task 17: Verify and delete `committee-calendars`

**Files:**
- Delete: `committee-calendars/` (entire directory)
- Modify: `.gitlab-ci.yml` (remove its CI job, if one exists — check first)
- Modify: `README.md` (repo root — status table, done together with Task 18 below to avoid two commits touching the same table)

**Interfaces:** None.

- [ ] **Step 1: Confirm `committee-calendars`'s actual live status before touching anything**

```bash
curl -sI https://committees.bikesiliconvalley.org/committees.ics
```
- If this returns `200`, the Worker is genuinely live — the domain repoint in Task 16 (adding `committees.bikesiliconvalley.org` as a route on `svbc-calendars`) must be deployed and verified serving correctly (`curl https://committees.bikesiliconvalley.org/calendars` after deploy) **before** this task deletes `committee-calendars`, or the domain goes dark in between.
- If it returns anything else (DNS failure, 522, etc.), `committee-calendars` was in fact never live with real traffic, matching bike-calendars' design doc rather than this repo's README — proceed directly to deletion once `svbc-calendars` is deployed.

- [ ] **Step 2: Check for a GitLab CI job referencing `committee-calendars`**

```bash
grep -n "committee-calendars" .gitlab-ci.yml
```
If a job exists, remove it in the same commit as the directory deletion below.

- [ ] **Step 3: Delete the directory**

```bash
git rm -r committee-calendars
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove committee-calendars, superseded by svbc-calendars"
```

**D1 database decommission is deliberately NOT part of this task.** `svc-committee-calendars`'s D1 database (`bdadb7de-19b2-4fa8-b74b-cf311093acd9`) stays provisioned until `svbc-calendars` has been confirmed live and stable for a reasonable period — deleting a database is irreversible and unrelated to shipping this merge. Flag it to the user as a manual follow-up once `svbc-calendars` is confirmed healthy in production.

---

## Task 18: Update cross-repo documentation

**Files:**
- Modify: `README.md` (repo root, `monday-workers`) — status table
- Modify: `CLAUDE.md` (repo root, `monday-workers`) — scope note
- Modify: `/Users/dwk/Developer/gitlab.com/silicon-valley-bicycle-coalition/bike-calendars/docs/superpowers/specs/2026-08-26-bike-calendars-design.md` — annotate with the reversal (different repo/worktree — not part of this branch's diff)
- Modify: `/Users/dwk/Developer/gitlab.com/silicon-valley-bicycle-coalition/CLAUDE.md` — workspace-level, remove `bike-calendars`/`bike-calendars-implementation` references (different repo — not part of this branch's diff)

**Interfaces:** None.

- [ ] **Step 1: Update `README.md`'s "Status at a glance" table**

Replace the `events-widgets` and `committee-calendars` rows with one row:
```markdown
| [`svbc-calendars`](svbc-calendars/README.md) | **Live** — serving `events.bikesiliconvalley.org` (Eventbrite widget) and `committees.bikesiliconvalley.org` (9 ICS calendar feeds + staff listing). Merged 2026-08-27 from `events-widgets`, `committee-calendars`, and the standalone `bike-calendars` project (history: see [the merge design doc](docs/superpowers/specs/2026-08-27-events-bike-calendars-merge-design.md)) | Not migration-related; predates this repo |
```

- [ ] **Step 2: Update `CLAUDE.md`'s "What this is" section**

After the existing paragraph, add:
```markdown
Two Workers are an exception to the migration scope above — `svbc-calendars` (Eventbrite widget +
committee/event ICS calendar feeds) predates this repo and serves the public
bikesiliconvalley.org website directly, unrelated to the Salesforce/Monday migration. It's here
for the same reason `events-widgets` originally was: one place to deploy SVBC's Cloudflare
Workers from.
```

- [ ] **Step 3: Commit the `monday-workers` doc updates**

```bash
git add README.md CLAUDE.md
git commit -m "docs: update README status table and CLAUDE.md scope note for the svbc-calendars merge"
```

- [ ] **Step 4: Annotate the original bike-calendars design doc**

In `/Users/dwk/Developer/gitlab.com/silicon-valley-bicycle-coalition/bike-calendars` (a separate repo — this step happens there, not in this worktree), add a note at the top of `docs/superpowers/specs/2026-08-26-bike-calendars-design.md`, right after the existing `**Status:**` line:
```markdown
**Superseded 2026-08-27:** this design's "standalone repo, Astro/Pages, not the monday-workers
Worker+D1 conventions" decision was reversed — see
`monday-workers/docs/superpowers/specs/2026-08-27-events-bike-calendars-merge-design.md` ("Why
this reverses the prior decision"). The goal shifted from "keep this architecturally separate"
to "minimize the number of deployed Workers," which this design's Astro/Pages split worked
against. This project's adapters and config were ported into `monday-workers/svbc-calendars/`;
this repo is archived.
```
```bash
cd /Users/dwk/Developer/gitlab.com/silicon-valley-bicycle-coalition/bike-calendars
git add docs/superpowers/specs/2026-08-26-bike-calendars-design.md
git commit -m "docs: note that this design was superseded by the svbc-calendars merge"
git push
```

- [ ] **Step 5: Update the workspace-level `CLAUDE.md`**

In `/Users/dwk/Developer/gitlab.com/silicon-valley-bicycle-coalition/CLAUDE.md`, remove the `bike-calendars/` and `bike-calendars-implementation/` bullet points from the "Repos here" list (once the cleanup in Task 19 has actually removed those directories — do this step after Task 19, not before, so the doc never claims a directory is gone while it's still on disk).

- [ ] **Step 6: Commit**

```bash
cd /Users/dwk/Developer/gitlab.com/silicon-valley-bicycle-coalition
git diff CLAUDE.md  # confirm the change
# This directory isn't a git repo itself — there's nothing to commit here; save the edited
# CLAUDE.md as-is. (If a future convention adds version control to this workspace root, commit
# it then.)
```

---

## Task 19: Final verification, then clean up the old standalone bike-calendars repo/worktree

**Files:** None new — verification and cleanup of files created before this plan started.

- [ ] **Step 1: Run the full test suite and typecheck one more time from a clean install**

```bash
cd /Users/dwk/Developer/gitlab.com/silicon-valley-bicycle-coalition/monday-workers-events-bike-calendars/svbc-calendars
rm -rf node_modules
npm install
npm test
npx tsc --noEmit
```
Expected: everything passes clean.

- [ ] **Step 2: Deploy and smoke-test**

```bash
npx wrangler deploy
curl https://events.bikesiliconvalley.org/widget
curl https://committees.bikesiliconvalley.org/calendars
curl https://committees.bikesiliconvalley.org/calendars/santa-clara.ics
curl https://committees.bikesiliconvalley.org/status.json
```
Expected: all four return successfully with the expected content type.

- [ ] **Step 3: Check for gitignored files in `bike-calendars-implementation` before removing its worktree**

```bash
cd /Users/dwk/Developer/gitlab.com/silicon-valley-bicycle-coalition
git -C bike-calendars-implementation status --ignored --short | grep '^!!'
```
Anything listed (in particular `.env`, if it holds a real `EVENTBRITE_TOKEN`/`SLACK_WEBHOOK_URL` used only for local dev) — copy it out first; `git worktree remove` deletes gitignored files with the directory and does not warn.

- [ ] **Step 4: Remove the `bike-calendars-implementation` worktree and its local branch**

```bash
git -C bike-calendars worktree remove ../bike-calendars-implementation
git -C bike-calendars branch -d feat/initial-build
```
(This will refuse if `feat/initial-build` isn't fully merged anywhere — it isn't, since this plan hand-ported specific files rather than merging the branch. Use `git -C bike-calendars branch -D feat/initial-build` only after confirming with the user that the branch's remaining, un-ported content — the Astro scaffolding and `trigger/` Worker — is intentionally being discarded, not lost by accident.)

- [ ] **Step 5: Complete Task 18 Step 5 (workspace `CLAUDE.md` cleanup) now that the directories are actually gone**

- [ ] **Step 6: Archive the standalone `bike-calendars` GitLab repo**

This is a GitLab dashboard action (Settings → General → Advanced → Archive project), not a CLI command — do it manually. Recommend archiving rather than deleting, so its history remains reachable. Confirm with the user before archiving, since it's a repo-visibility change on GitLab, not a local file operation.

- [ ] **Step 7: Open the merge request**

```bash
cd /Users/dwk/Developer/gitlab.com/silicon-valley-bicycle-coalition/monday-workers-events-bike-calendars
git push -u origin feat/events-bike-calendars-merge
```
Then open an MR from `feat/events-bike-calendars-merge` into `main` on GitLab, summarizing the merge per the design doc.
