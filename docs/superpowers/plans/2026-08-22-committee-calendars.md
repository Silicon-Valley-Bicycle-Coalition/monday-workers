# committee-calendars Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `committee-calendars` Cloudflare Worker: a daily cron job that pulls Bicycle &
Pedestrian Advisory Committee meeting schedules from 7 city/agency sources across 3 platforms, and
serves them as one merged, subscribable ICS feed at `GET /committees.ics`.

**Architecture:** Hono + TypeScript + D1, no Queue (cron self-heals on the next run). Three
source-fetching adapters (Legistar Web API, CivicPlus `iCalendar.aspx`, a Caltrain-BATAC-specific
page scrape) normalize into a common `NormalizedEvent` shape and write to one D1 `events` table,
replacing each source's future rows on every successful poll. The route serializes ICS from D1 on
each request. A `source_status` table tracks per-source success/failure so one broken source
degrades gracefully instead of taking down the whole feed.

**Tech Stack:** Hono, TypeScript (strict), Cloudflare D1, `ics` (ICS generation), `ical.js` (ICS
parsing), Vitest + `@cloudflare/vitest-plugin` (runs tests inside `workerd` via Miniflare, real D1
migrations applied per test run — not mocked).

**Spec:** [`docs/superpowers/specs/2026-08-22-committee-calendars-design.md`](../specs/2026-08-22-committee-calendars-design.md)
(and the product spec it builds on, `committee-calendars/README.md` (since replaced by `svbc-calendars`; current spec: [`svbc-calendars/README.md`](../../../svbc-calendars/README.md)))

## Global Constraints

- **7 sources, 3 adapters** — Legistar (Santa Clara, BART, San Jose, Cupertino), CivicPlus
  (Campbell, Saratoga), and a Caltrain-BATAC-specific page scrape. VTA is explicitly out of scope
  (see spec's Platform confirmation section) — do not add it back without new evidence a real
  feed exists.
- **No Node-specific APIs** (`fs`, `Buffer`, `require`) — this runs in `workerd`, not Node. Use
  Web-standard `fetch`, `atob`, `Intl`, `crypto` only.
- **Config, not hardcoding** — all 7 source definitions live in `config/sources.json`, validated at
  startup by `src/config.ts`. No SVBC-specific IDs/domains inline in adapter code.
- **A cron write only advances `source_status` after the D1 write commits**, never before — matches
  every other cron-polled Worker in this repo (see `../../../README.md`'s Reliability section).
- **One flaky source degrades only its own committee's data, never the whole feed** — `/committees.ics`
  must always return 200 with whatever is in D1, including an empty calendar on a fresh deploy.
- **TDD**: write the failing test before the implementation for every task below, run it to see it
  fail for the expected reason, then implement.
- Follow `funraise-sync`'s established conventions exactly where this plan doesn't say otherwise:
  hand-rolled `validateConfig`-style validation (no schema library), dependency-injected classes
  implementing a small interface (no framework DI container), `errorMessage(err: unknown): string`
  for error normalization, colocated `*.test.ts` files, `@cloudflare/vitest-plugin`'s
  `cloudflareTest` + `readD1Migrations` + `applyD1Migrations` test harness.

---

## Task 1: Project scaffolding

**Files:**
- Create: `committee-calendars/package.json`
- Create: `committee-calendars/tsconfig.json`
- Create: `committee-calendars/vitest.config.ts`
- Create: `committee-calendars/wrangler.jsonc`
- Create: `committee-calendars/migrations/0001_create_events.sql`
- Create: `committee-calendars/test/apply-migrations.ts`
- Create: `committee-calendars/test/env.d.ts`
- Create: `committee-calendars/src/types.ts`
- Create: `committee-calendars/src/util/errorMessage.ts`

**Interfaces:**
- Produces: `NormalizedEvent`, `SourceConfig` (union of `LegistarSourceConfig` |
  `CivicPlusSourceConfig` | `CaltrainBatacSourceConfig`), `CommitteeCalendarsConfig`, `Env` — all
  from `src/types.ts`. Produces `errorMessage(err: unknown): string` from
  `src/util/errorMessage.ts`. Every later task imports these.

- [ ] **Step 1: Create the worktree**

```bash
cd /Users/dwk/Developer/gitlab.com/silicon-valley-bicycle-coalition/monday-workers
git worktree add ../monday-workers-committee-calendars -b feat/committee-calendars main
cd ../monday-workers-committee-calendars/committee-calendars
```

(The `committee-calendars/README.md` requirements doc and this plan already exist on `main` and
will be present in the new worktree.)

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "committee-calendars",
  "version": "0.1.0",
  "description": "Merged ICS feed of Bicycle & Pedestrian Advisory Committee meetings across Santa Clara County.",
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
    "hono": "^4.13.3",
    "ics": "^3.12.0",
    "ical.js": "^2.2.1"
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

- [ ] **Step 3: Write `tsconfig.json`** (identical shape to `funraise-sync`'s)

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

- [ ] **Step 4: Write `wrangler.jsonc`**

```jsonc
{
  "name": "svbc-committee-calendars",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-01",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "svbc-committee-calendars",
      // Replace after running: wrangler d1 create svbc-committee-calendars
      "database_id": "REPLACE_AFTER_WRANGLER_D1_CREATE",
      "migrations_dir": "migrations"
    }
  ],
  "triggers": {
    // Daily at 13:00 UTC (5am/6am Pacific depending on DST) — adjust if a different time is preferred.
    "crons": ["0 13 * * *"]
  },
  "observability": {
    "enabled": true
  }
}
```

- [ ] **Step 5: Write the D1 migration**

```sql
-- migrations/0001_create_events.sql
CREATE TABLE events (
  id TEXT PRIMARY KEY,              -- source_id || ':' || external_id
  source_id TEXT NOT NULL,
  title TEXT NOT NULL,
  committee_name TEXT NOT NULL,
  start_utc TEXT NOT NULL,
  end_utc TEXT,
  location TEXT,
  url TEXT,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE source_status (
  source_id TEXT PRIMARY KEY,
  last_success_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
```

- [ ] **Step 6: Write `vitest.config.ts`** (identical shape to `funraise-sync`'s)

```ts
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

- [ ] **Step 7: Write `test/apply-migrations.ts`**

```ts
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

- [ ] **Step 8: Write `test/env.d.ts`**

```ts
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    SLACK_WEBHOOK_URL: string;
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}
```

- [ ] **Step 9: Write `src/types.ts`**

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

export type SourceConfig = LegistarSourceConfig | CivicPlusSourceConfig | CaltrainBatacSourceConfig;

export interface CommitteeCalendarsConfig {
  sources: SourceConfig[];
}

export interface Env {
  DB: D1Database;
  SLACK_WEBHOOK_URL: string;
}
```

- [ ] **Step 10: Write `src/util/errorMessage.ts`**

```ts
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

- [ ] **Step 11: Install dependencies and verify the scaffold compiles**

```bash
npm install
npm run typecheck
npm test
```

Expected: `typecheck` passes with no errors; `test` reports no test files found (none written yet)
but exits 0.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "chore(committee-calendars): scaffold project (package.json, tsconfig, D1 migration, test harness)"
```

---

## Task 2: Config loader and real source list

**Files:**
- Create: `committee-calendars/config/sources.json`
- Create: `committee-calendars/src/config.ts`
- Test: `committee-calendars/src/config.test.ts`

**Interfaces:**
- Consumes: `SourceConfig`, `CommitteeCalendarsConfig` from `src/types.ts` (Task 1).
- Produces: `validateConfig(raw: unknown): CommitteeCalendarsConfig`. Task 13 (`src/index.ts`)
  calls this on the imported `config/sources.json`.

- [ ] **Step 1: Write `config/sources.json`** — the real, live-verified 7 sources (see the design
  spec's Platform confirmation section for how each was confirmed)

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
    }
  ]
}
```

- [ ] **Step 2: Write the failing test** `src/config.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { validateConfig } from './config';
import rawConfig from '../config/sources.json';

describe('validateConfig', () => {
  it('accepts the real config/sources.json with all 7 sources', () => {
    const config = validateConfig(rawConfig);
    expect(config.sources).toHaveLength(7);
    expect(config.sources.map((s) => s.id)).toEqual([
      'santa-clara',
      'bart',
      'san-jose',
      'cupertino',
      'campbell',
      'saratoga',
      'caltrain-batac',
    ]);
  });

  it('rejects a non-object', () => {
    expect(() => validateConfig(null)).toThrow('config: expected an object');
    expect(() => validateConfig('nope')).toThrow('config: expected an object');
  });

  it('rejects a missing "sources" array', () => {
    expect(() => validateConfig({})).toThrow('config: missing required key "sources" (array)');
  });

  it('rejects a source missing a required common field', () => {
    expect(() => validateConfig({ sources: [{ name: 'x', committeeName: 'y', adapter: 'legistar' }] })).toThrow(
      'config: sources[0].id must be a non-empty string'
    );
  });

  it('rejects an unknown adapter value', () => {
    expect(() =>
      validateConfig({ sources: [{ id: 'x', name: 'x', committeeName: 'x', adapter: 'bogus' }] })
    ).toThrow('config: sources[0].adapter must be one of legistar, civicplus, caltrainBatac');
  });

  it('rejects a legistar source missing bodyId', () => {
    expect(() =>
      validateConfig({
        sources: [{ id: 'x', name: 'x', committeeName: 'x', adapter: 'legistar', client: 'x' }],
      })
    ).toThrow('config: sources[0].bodyId must be a number');
  });

  it('rejects a civicplus source missing catId', () => {
    expect(() =>
      validateConfig({
        sources: [{ id: 'x', name: 'x', committeeName: 'x', adapter: 'civicplus', domain: 'x' }],
      })
    ).toThrow('config: sources[0].catId must be a number');
  });

  it('rejects a caltrainBatac source missing titleFilter', () => {
    expect(() =>
      validateConfig({
        sources: [
          { id: 'x', name: 'x', committeeName: 'x', adapter: 'caltrainBatac', pageUrl: 'https://x' },
        ],
      })
    ).toThrow('config: sources[0].titleFilter must be a non-empty string');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- src/config.test.ts`
Expected: FAIL — `Cannot find module './config'` (file doesn't exist yet).

- [ ] **Step 4: Write `src/config.ts`**

```ts
import type { CommitteeCalendarsConfig, SourceConfig } from './types';

const VALID_ADAPTERS = ['legistar', 'civicplus', 'caltrainBatac'] as const;
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
    return {
      id,
      name,
      committeeName,
      adapter: 'legistar',
      client: requireString(src, 'client', index),
      bodyId: requireNumber(src, 'bodyId', index),
    };
  }

  if (adapter === 'civicplus') {
    return {
      id,
      name,
      committeeName,
      adapter: 'civicplus',
      domain: requireString(src, 'domain', index),
      catId: requireNumber(src, 'catId', index),
    };
  }

  return {
    id,
    name,
    committeeName,
    adapter: 'caltrainBatac',
    pageUrl: requireString(src, 'pageUrl', index),
    titleFilter: requireString(src, 'titleFilter', index),
  };
}

export function validateConfig(raw: unknown): CommitteeCalendarsConfig {
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

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- src/config.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add config/sources.json src/config.ts src/config.test.ts
git commit -m "feat(committee-calendars): add config loader and the 7 live-verified sources"
```

---

## Task 3: Timezone conversion utility

**Files:**
- Create: `committee-calendars/src/util/zonedTime.ts`
- Test: `committee-calendars/src/util/zonedTime.test.ts`

**Interfaces:**
- Produces: `zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute:
  number, timeZone: string): Date`. Consumed by `src/adapters/legistar.ts` (Task 5) to convert
  Legistar's naive Pacific-local `EventDate` + `EventTime` into a UTC instant.

- [ ] **Step 1: Write the failing test** `src/util/zonedTime.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { zonedTimeToUtc } from './zonedTime';

describe('zonedTimeToUtc', () => {
  it('converts a winter (PST, UTC-8) local time correctly', () => {
    // Jan 29, 2026, 7:00 PM Pacific Standard Time -> Jan 30, 2026, 03:00 UTC
    const result = zonedTimeToUtc(2026, 1, 29, 19, 0, 'America/Los_Angeles');
    expect(result.toISOString()).toBe('2026-01-30T03:00:00.000Z');
  });

  it('converts a summer (PDT, UTC-7) local time correctly', () => {
    // Aug 24, 2026, 6:30 PM Pacific Daylight Time -> Aug 25, 2026, 01:30 UTC
    const result = zonedTimeToUtc(2026, 8, 24, 18, 30, 'America/Los_Angeles');
    expect(result.toISOString()).toBe('2026-08-25T01:30:00.000Z');
  });

  it('resumes PST correctly the week after the November DST transition', () => {
    // DST ends Nov 1, 2026 in the US. Nov 9, 2026, 5:00 PM PST -> Nov 10, 2026, 01:00 UTC.
    const result = zonedTimeToUtc(2026, 11, 9, 17, 0, 'America/Los_Angeles');
    expect(result.toISOString()).toBe('2026-11-10T01:00:00.000Z');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/util/zonedTime.test.ts`
Expected: FAIL — `Cannot find module './zonedTime'`.

- [ ] **Step 3: Write `src/util/zonedTime.ts`**

```ts
function getTimeZoneOffsetMinutes(instant: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = formatter.formatToParts(instant);
  const get = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) {
      throw new Error(`zonedTime: missing "${type}" part from Intl.DateTimeFormat output`);
    }
    return Number(part.value);
  };
  const hour = get('hour');
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour === 24 ? 0 : hour, get('minute'), get('second'));
  return (asUtc - instant.getTime()) / 60000;
}

/**
 * Converts a naive wall-clock time in `timeZone` to the UTC instant it represents,
 * correctly accounting for that zone's DST offset at that specific date.
 */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const offsetMinutes = getTimeZoneOffsetMinutes(utcGuess, timeZone);
  return new Date(utcGuess.getTime() - offsetMinutes * 60000);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/util/zonedTime.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/util/zonedTime.ts src/util/zonedTime.test.ts
git commit -m "feat(committee-calendars): add DST-aware local-to-UTC time conversion"
```

---

## Task 4: ICS parsing utility

**Files:**
- Create: `committee-calendars/src/types/ical.d.ts` (ambient module declaration — `ical.js` ships
  no bundled or `@types/*` TypeScript definitions; this declares only the surface used below)
- Create: `committee-calendars/src/util/parseIcs.ts`
- Test: `committee-calendars/src/util/parseIcs.test.ts`

**Interfaces:**
- Produces: `ParsedIcsEvent {uid, summary, startUtc, endUtc, location, url}` and
  `parseIcsEvents(icsText: string): ParsedIcsEvent[]`. Consumed by `src/adapters/civicplus.ts`
  (Task 6) and `src/adapters/caltrainBatac.ts` (Task 7).

- [ ] **Step 1: Write the ambient type declaration** `src/types/ical.d.ts`

```ts
declare module 'ical.js' {
  export function parse(input: string): unknown;

  export class Component {
    constructor(jCal: unknown);
    getAllSubcomponents(name: string): Component[];
    getFirstPropertyValue(name: string): unknown;
  }

  export class Time {
    toJSDate(): Date;
  }

  export class Timezone {
    constructor(component: Component);
    tzid: string;
  }

  export class Event {
    constructor(component: Component);
    uid: string;
    summary: string;
    startDate: Time;
    endDate: Time | null;
  }

  export const TimezoneService: {
    register(tzid: string, timezone: Timezone): void;
  };
}
```

- [ ] **Step 2: Write the failing test** `src/util/parseIcs.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { parseIcsEvents } from './parseIcs';

// Shaped like the real CivicPlus (Campbell/Saratoga) feed output: a VTIMEZONE block,
// TZID-qualified DTSTART/DTEND.
const CIVICPLUS_FIXTURE = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//CivicPlus//iCalendar//EN
BEGIN:VTIMEZONE
TZID:America/Los_Angeles
BEGIN:DAYLIGHT
TZOFFSETFROM:-0800
TZOFFSETTO:-0700
TZNAME:PDT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0700
TZOFFSETTO:-0800
TZNAME:PST
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:campbell-bpac-2026-11-19@campbellca.gov
DTSTAMP:20260101T000000Z
DTSTART;TZID=America/Los_Angeles:20261119T170000
DTEND;TZID=America/Los_Angeles:20261119T180000
SUMMARY:Bicycle and Pedestrian Advisory Committee Meeting
LOCATION:Council Chamber\\, 70 N First St\\, Campbell\\, CA 95008
URL:https://www.campbellca.gov/calendar.aspx?EID=1234
END:VEVENT
END:VCALENDAR`;

// Shaped like the real caltrain.com embedded data:text/calendar output: no VTIMEZONE, DTSTART
// already UTC ('Z' suffix), no LOCATION/URL.
const CALTRAIN_FIXTURE = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:Spatie calendar-links
BEGIN:VEVENT
UID:eaafd89e85503a83d5c4455522fbbe8e
SUMMARY:JPB Bicycle and Active Transportation Advisory Committee (BATAC)
DTSTAMP:20260918T004500Z
DTSTART:20260918T004500Z
DTEND:20260918T004500Z
END:VEVENT
END:VCALENDAR`;

describe('parseIcsEvents', () => {
  it('resolves a VTIMEZONE-qualified DTSTART/DTEND to the correct UTC instant', () => {
    const events = parseIcsEvents(CIVICPLUS_FIXTURE);
    expect(events).toEqual([
      {
        uid: 'campbell-bpac-2026-11-19@campbellca.gov',
        summary: 'Bicycle and Pedestrian Advisory Committee Meeting',
        startUtc: '2026-11-20T01:00:00.000Z',
        endUtc: '2026-11-20T02:00:00.000Z',
        location: 'Council Chamber, 70 N First St, Campbell, CA 95008',
        url: 'https://www.campbellca.gov/calendar.aspx?EID=1234',
      },
    ]);
  });

  it('parses a bare UTC DTSTART with no VTIMEZONE and null location/url', () => {
    const events = parseIcsEvents(CALTRAIN_FIXTURE);
    expect(events).toEqual([
      {
        uid: 'eaafd89e85503a83d5c4455522fbbe8e',
        summary: 'JPB Bicycle and Active Transportation Advisory Committee (BATAC)',
        startUtc: '2026-09-18T00:45:00.000Z',
        endUtc: '2026-09-18T00:45:00.000Z',
        location: null,
        url: null,
      },
    ]);
  });

  it('returns an empty array for a calendar with no VEVENTs', () => {
    expect(parseIcsEvents('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR')).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- src/util/parseIcs.test.ts`
Expected: FAIL — `Cannot find module './parseIcs'`.

- [ ] **Step 4: Write `src/util/parseIcs.ts`**

```ts
import ICAL from 'ical.js';

export interface ParsedIcsEvent {
  uid: string;
  summary: string;
  startUtc: string;
  endUtc: string | null;
  location: string | null;
  url: string | null;
}

export function parseIcsEvents(icsText: string): ParsedIcsEvent[] {
  const jcal = ICAL.parse(icsText);
  const component = new ICAL.Component(jcal);

  for (const vtimezone of component.getAllSubcomponents('vtimezone')) {
    const timezone = new ICAL.Timezone(vtimezone);
    ICAL.TimezoneService.register(timezone.tzid, timezone);
  }

  return component.getAllSubcomponents('vevent').map((vevent) => {
    const event = new ICAL.Event(vevent);
    return {
      uid: event.uid,
      summary: event.summary,
      startUtc: event.startDate.toJSDate().toISOString(),
      endUtc: event.endDate ? event.endDate.toJSDate().toISOString() : null,
      location: (vevent.getFirstPropertyValue('location') as string | null) ?? null,
      url: (vevent.getFirstPropertyValue('url') as string | null) ?? null,
    };
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/util/parseIcs.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/types/ical.d.ts src/util/parseIcs.ts src/util/parseIcs.test.ts
git commit -m "feat(committee-calendars): add shared ICS parser (ical.js) with VTIMEZONE support"
```

---

## Task 5: Legistar adapter

**Files:**
- Create: `committee-calendars/src/adapters/legistar.ts`
- Test: `committee-calendars/src/adapters/legistar.test.ts`

**Interfaces:**
- Consumes: `LegistarSourceConfig`, `NormalizedEvent` from `src/types.ts`. `zonedTimeToUtc` from
  `src/util/zonedTime.ts` (Task 3).
- Produces: `fetchLegistarEvents(source: LegistarSourceConfig, now: Date):
  Promise<NormalizedEvent[]>`. Consumed by `src/adapters/dispatch.ts` (Task 11).

- [ ] **Step 1: Write the failing test** `src/adapters/legistar.test.ts`

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchLegistarEvents } from './legistar';
import type { LegistarSourceConfig } from '../types';

// Real record shape, captured live from https://webapi.legistar.com/v1/cupertino/events
// filtered to EventBodyId=170 (Cupertino's Bicycle Pedestrian Commission).
const CUPERTINO_FIXTURE = [
  {
    EventId: 5259,
    EventGuid: 'F5F59B1E-E717-4ED2-BF8D-0BFC4C74FF90',
    EventLastModifiedUtc: '2025-11-25T18:52:21.703',
    EventRowVersion: 'AAAAAAC1d1c=',
    EventBodyId: 170,
    EventBodyName: 'Bicycle Pedestrian Commission',
    EventDate: '2026-01-29T00:00:00',
    EventTime: '7:00 PM',
    EventVideoStatus: 'Public',
    EventAgendaStatusId: 10,
    EventAgendaStatusName: 'Final',
    EventMinutesStatusId: 9,
    EventMinutesStatusName: 'Draft',
    EventLocation: '10185 North Stelling Road, Quinlan Conference Room and via Teleconference',
    EventAgendaFile: null,
    EventMinutesFile: null,
    EventAgendaLastPublishedUTC: null,
    EventMinutesLastPublishedUTC: null,
    EventComment: 'Special Meeting',
    EventVideoPath: null,
    EventMedia: '3662',
    EventInSiteURL: 'https://cupertino.legistar.com/MeetingDetail.aspx?LEGID=5259&GID=341&G=74359C04-A5F0-4CB2-A97A-0032996BB90E',
    EventItems: [],
  },
];

const SOURCE: LegistarSourceConfig = {
  id: 'cupertino',
  name: 'Cupertino',
  committeeName: 'Bicycle Pedestrian Commission',
  adapter: 'legistar',
  client: 'cupertino',
  bodyId: 170,
};

describe('fetchLegistarEvents', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches, filters by body and date, and normalizes into NormalizedEvent', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      expect(String(url)).toContain('https://webapi.legistar.com/v1/cupertino/events?%24filter=');
      expect(String(url)).toContain('EventBodyId%20eq%20170');
      expect(String(url)).toContain("EventDate%20ge%20datetime'2026-01-01'");
      return new Response(JSON.stringify(CUPERTINO_FIXTURE), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const events = await fetchLegistarEvents(SOURCE, new Date('2026-01-01T00:00:00.000Z'));

    expect(events).toEqual([
      {
        sourceId: 'cupertino',
        externalId: '5259',
        title: 'Bicycle Pedestrian Commission',
        committeeName: 'Bicycle Pedestrian Commission',
        startUtc: '2026-01-30T03:00:00.000Z', // 7:00 PM PST on 2026-01-29 -> UTC
        endUtc: null,
        location: '10185 North Stelling Road, Quinlan Conference Room and via Teleconference',
        url: 'https://cupertino.legistar.com/MeetingDetail.aspx?LEGID=5259&GID=341&G=74359C04-A5F0-4CB2-A97A-0032996BB90E',
      },
    ]);
  });

  it('throws with a descriptive message on a non-OK response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('server error', { status: 500, statusText: 'Internal Server Error' }))
    );

    await expect(fetchLegistarEvents(SOURCE, new Date('2026-01-01T00:00:00.000Z'))).rejects.toThrow(
      'legistar: cupertino events fetch failed: 500 Internal Server Error'
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/adapters/legistar.test.ts`
Expected: FAIL — `Cannot find module './legistar'`.

- [ ] **Step 3: Write `src/adapters/legistar.ts`**

```ts
import type { LegistarSourceConfig, NormalizedEvent } from '../types';
import { zonedTimeToUtc } from '../util/zonedTime';

interface LegistarEventRecord {
  EventId: number;
  EventDate: string; // e.g. "2026-01-29T00:00:00", naive Pacific-local
  EventTime: string; // e.g. "7:00 PM"
  EventLocation: string | null;
  EventInSiteURL: string | null;
}

const TIME_PATTERN = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})/;

function parseEventTime(eventTime: string): { hour: number; minute: number } {
  const match = TIME_PATTERN.exec(eventTime.trim());
  if (!match) {
    return { hour: 0, minute: 0 };
  }
  const [, hourStr, minuteStr, meridiem] = match;
  let hour = Number(hourStr) % 12;
  if (meridiem?.toUpperCase() === 'PM') {
    hour += 12;
  }
  return { hour, minute: Number(minuteStr) };
}

function parseEventDate(eventDate: string, eventId: number): { year: number; month: number; day: number } {
  const match = DATE_PATTERN.exec(eventDate);
  if (!match) {
    throw new Error(`legistar: unparseable EventDate "${eventDate}" for event ${eventId}`);
  }
  const [, yearStr, monthStr, dayStr] = match;
  return { year: Number(yearStr), month: Number(monthStr), day: Number(dayStr) };
}

export async function fetchLegistarEvents(source: LegistarSourceConfig, now: Date): Promise<NormalizedEvent[]> {
  const isoDate = now.toISOString().slice(0, 10);
  const filter = `EventBodyId eq ${source.bodyId} and EventDate ge datetime'${isoDate}'`;
  const url = `https://webapi.legistar.com/v1/${source.client}/events?$filter=${encodeURIComponent(filter)}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`legistar: ${source.client} events fetch failed: ${response.status} ${response.statusText}`);
  }
  const records = (await response.json()) as LegistarEventRecord[];

  return records.map((record) => {
    const { year, month, day } = parseEventDate(record.EventDate, record.EventId);
    const { hour, minute } = parseEventTime(record.EventTime);
    const startUtc = zonedTimeToUtc(year, month, day, hour, minute, 'America/Los_Angeles');
    return {
      sourceId: source.id,
      externalId: String(record.EventId),
      title: source.committeeName,
      committeeName: source.committeeName,
      startUtc: startUtc.toISOString(),
      endUtc: null,
      location: record.EventLocation,
      url: record.EventInSiteURL,
    };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/adapters/legistar.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/legistar.ts src/adapters/legistar.test.ts
git commit -m "feat(committee-calendars): add Legistar Web API adapter"
```

---

## Task 6: CivicPlus adapter

**Files:**
- Create: `committee-calendars/src/adapters/civicplus.ts`
- Test: `committee-calendars/src/adapters/civicplus.test.ts`

**Interfaces:**
- Consumes: `CivicPlusSourceConfig`, `NormalizedEvent` from `src/types.ts`. `parseIcsEvents` from
  `src/util/parseIcs.ts` (Task 4).
- Produces: `fetchCivicPlusEvents(source: CivicPlusSourceConfig): Promise<NormalizedEvent[]>`.
  Consumed by `src/adapters/dispatch.ts` (Task 11).

- [ ] **Step 1: Write the failing test** `src/adapters/civicplus.test.ts`

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchCivicPlusEvents } from './civicplus';
import type { CivicPlusSourceConfig } from '../types';

// Shaped like the real feed at https://www.campbellca.gov/common/modules/iCalendar/iCalendar.aspx?catID=32&feed=calendar
const CAMPBELL_FIXTURE = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//CivicPlus//iCalendar//EN
BEGIN:VTIMEZONE
TZID:America/Los_Angeles
BEGIN:DAYLIGHT
TZOFFSETFROM:-0800
TZOFFSETTO:-0700
TZNAME:PDT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0700
TZOFFSETTO:-0800
TZNAME:PST
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:campbell-bpac-2026-11-19@campbellca.gov
DTSTAMP:20260101T000000Z
DTSTART;TZID=America/Los_Angeles:20261119T170000
DTEND;TZID=America/Los_Angeles:20261119T180000
SUMMARY:Bicycle and Pedestrian Advisory Committee Meeting
LOCATION:Council Chamber\\, 70 N First St\\, Campbell\\, CA 95008
URL:https://www.campbellca.gov/calendar.aspx?EID=1234
END:VEVENT
END:VCALENDAR`;

const SOURCE: CivicPlusSourceConfig = {
  id: 'campbell',
  name: 'Campbell',
  committeeName: 'Bicycle & Pedestrian Advisory Committee',
  adapter: 'civicplus',
  domain: 'www.campbellca.gov',
  catId: 32,
};

describe('fetchCivicPlusEvents', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches the iCalendar.aspx feed and normalizes into NormalizedEvent', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe('https://www.campbellca.gov/common/modules/iCalendar/iCalendar.aspx?catID=32&feed=calendar');
      return new Response(CAMPBELL_FIXTURE, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const events = await fetchCivicPlusEvents(SOURCE);

    expect(events).toEqual([
      {
        sourceId: 'campbell',
        externalId: 'campbell-bpac-2026-11-19@campbellca.gov',
        title: 'Bicycle and Pedestrian Advisory Committee Meeting',
        committeeName: 'Bicycle & Pedestrian Advisory Committee',
        startUtc: '2026-11-20T01:00:00.000Z',
        endUtc: '2026-11-20T02:00:00.000Z',
        location: 'Council Chamber, 70 N First St, Campbell, CA 95008',
        url: 'https://www.campbellca.gov/calendar.aspx?EID=1234',
      },
    ]);
  });

  it('throws with a descriptive message on a non-OK response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404, statusText: 'Not Found' }))
    );

    await expect(fetchCivicPlusEvents(SOURCE)).rejects.toThrow(
      'civicplus: www.campbellca.gov catID=32 fetch failed: 404 Not Found'
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/adapters/civicplus.test.ts`
Expected: FAIL — `Cannot find module './civicplus'`.

- [ ] **Step 3: Write `src/adapters/civicplus.ts`**

```ts
import type { CivicPlusSourceConfig, NormalizedEvent } from '../types';
import { parseIcsEvents } from '../util/parseIcs';

export async function fetchCivicPlusEvents(source: CivicPlusSourceConfig): Promise<NormalizedEvent[]> {
  const url = `https://${source.domain}/common/modules/iCalendar/iCalendar.aspx?catID=${source.catId}&feed=calendar`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`civicplus: ${source.domain} catID=${source.catId} fetch failed: ${response.status} ${response.statusText}`);
  }
  const icsText = await response.text();

  return parseIcsEvents(icsText).map((parsed) => ({
    sourceId: source.id,
    externalId: parsed.uid,
    title: parsed.summary,
    committeeName: source.committeeName,
    startUtc: parsed.startUtc,
    endUtc: parsed.endUtc,
    location: parsed.location,
    url: parsed.url,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/adapters/civicplus.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/civicplus.ts src/adapters/civicplus.test.ts
git commit -m "feat(committee-calendars): add CivicPlus iCalendar.aspx adapter"
```

---

## Task 7: Caltrain BATAC adapter

**Files:**
- Create: `committee-calendars/src/adapters/caltrainBatac.ts`
- Test: `committee-calendars/src/adapters/caltrainBatac.test.ts`

**Interfaces:**
- Consumes: `CaltrainBatacSourceConfig`, `NormalizedEvent` from `src/types.ts`. `parseIcsEvents`
  from `src/util/parseIcs.ts` (Task 4).
- Produces: `fetchCaltrainBatacEvents(source: CaltrainBatacSourceConfig):
  Promise<NormalizedEvent[]>`. Consumed by `src/adapters/dispatch.ts` (Task 11).

- [ ] **Step 1: Write the failing test** `src/adapters/caltrainBatac.test.ts`

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchCaltrainBatacEvents } from './caltrainBatac';
import type { CaltrainBatacSourceConfig } from '../types';

// Both base64 blobs below are real, captured live from the "Add to calendar" buttons on
// https://www.caltrain.com/about-caltrain/advisory-committees/batac — one BATAC meeting (should
// be kept) and one Finance Committee meeting (should be filtered out by titleFilter), exactly as
// they appear side by side in that page's shared upcoming-JPB-meetings widget.
const PAGE_FIXTURE = `<html><body>
<div class="meeting-card">
  <h3><a href="/meetings/2026/09/jpb-bicycle-and-active-transportation-advisory-committee-batac">JPB Bicycle and Active Transportation Advisory Committee (BATAC)</a></h3>
  <p><a href="/meetings/2026/09/17">September 17 2026</a> <a href="data:text/calendar;charset=utf8;base64,QkVHSU46VkNBTEVOREFSDQpWRVJTSU9OOjIuMA0KUFJPRElEOlNwYXRpZSBjYWxlbmRhci1saW5rcw0KQkVHSU46VkVWRU5UDQpVSUQ6ZWFhZmQ4OWU4NTUwM2E4M2Q1YzQ0NTU1MjJmYmJlOGUNClNVTU1BUlk6SlBCIEJpY3ljbGUgYW5kIEFjdGl2ZSBUcmFuc3BvcnRhdGlvbiBBZHZpc29yeSBDb21taXR0ZWUgKEJBVEFDKQ0KRFRTVEFNUDoyMDI2MDkxOFQwMDQ1MDBaDQpEVFNUQVJUOjIwMjYwOTE4VDAwNDUwMFoNCkRURU5EOjIwMjYwOTE4VDAwNDUwMFoNCkVORDpWRVZFTlQNCkVORDpWQ0FMRU5EQVI=">Add to calendar</a></p>
</div>
<div class="meeting-card">
  <h3><a href="/meetings/2026/08/jpb-finance-committee">JPB Finance Committee</a></h3>
  <p><a href="/meetings/2026/08/19">August 19 2026</a> <a href="data:text/calendar;charset=utf8;base64,QkVHSU46VkNBTEVOREFSDQpWRVJTSU9OOjIuMA0KUFJPRElEOlNwYXRpZSBjYWxlbmRhci1saW5rcw0KQkVHSU46VkVWRU5UDQpVSUQ6OWQ0NzE1Mjg5MWY0Yzc1YWYwNjExOTQ2YjA3ZTMxNmYNClNVTU1BUlk6IEpQQiBGaW5hbmNlIENvbW1pdHRlZQ0KRFRTVEFNUDoyMDI2MDgyNFQyMTMwMDBaDQpEVFNUQVJUOjIwMjYwODI0VDIxMzAwMFoNCkRURU5EOjIwMjYwODI0VDIxMzAwMFoNCkVORDpWRVZFTlQNCkVORDpWQ0FMRU5EQVI=">Add to calendar</a></p>
</div>
</body></html>`;

const SOURCE: CaltrainBatacSourceConfig = {
  id: 'caltrain-batac',
  name: 'Caltrain',
  committeeName: 'Bicycle and Active Transportation Advisory Committee (BATAC)',
  adapter: 'caltrainBatac',
  pageUrl: 'https://www.caltrain.com/about-caltrain/advisory-committees/batac',
  titleFilter: 'Bicycle and Active Transportation Advisory Committee',
};

describe('fetchCaltrainBatacEvents', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('extracts, decodes, and title-filters embedded data:text/calendar links', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe('https://www.caltrain.com/about-caltrain/advisory-committees/batac');
      return new Response(PAGE_FIXTURE, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const events = await fetchCaltrainBatacEvents(SOURCE);

    // Only the BATAC meeting survives the title filter; the Finance Committee one is dropped.
    expect(events).toEqual([
      {
        sourceId: 'caltrain-batac',
        externalId: 'eaafd89e85503a83d5c4455522fbbe8e',
        title: 'JPB Bicycle and Active Transportation Advisory Committee (BATAC)',
        committeeName: 'Bicycle and Active Transportation Advisory Committee (BATAC)',
        startUtc: '2026-09-18T00:45:00.000Z',
        endUtc: null, // DTEND == DTSTART in the source data (no real duration given) -> treated as unknown
        location: null,
        url: 'https://www.caltrain.com/about-caltrain/advisory-committees/batac',
      },
    ]);
  });

  it('throws with a descriptive message on a non-OK response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('server error', { status: 503, statusText: 'Service Unavailable' }))
    );

    await expect(fetchCaltrainBatacEvents(SOURCE)).rejects.toThrow(
      'caltrainBatac: page fetch failed: 503 Service Unavailable'
    );
  });

  it('returns an empty array when the page has no matching data-uri links', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html><body>no meetings</body></html>', { status: 200 })));
    expect(await fetchCaltrainBatacEvents(SOURCE)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/adapters/caltrainBatac.test.ts`
Expected: FAIL — `Cannot find module './caltrainBatac'`.

- [ ] **Step 3: Write `src/adapters/caltrainBatac.ts`**

```ts
import type { CaltrainBatacSourceConfig, NormalizedEvent } from '../types';
import { parseIcsEvents } from '../util/parseIcs';

const DATA_URI_PATTERN = /data:text\/calendar;charset=utf8;base64,([A-Za-z0-9+/=]+)/g;

export async function fetchCaltrainBatacEvents(source: CaltrainBatacSourceConfig): Promise<NormalizedEvent[]> {
  const response = await fetch(source.pageUrl);
  if (!response.ok) {
    throw new Error(`caltrainBatac: page fetch failed: ${response.status} ${response.statusText}`);
  }
  const html = await response.text();

  const events: NormalizedEvent[] = [];
  for (const match of html.matchAll(DATA_URI_PATTERN)) {
    const base64 = match[1];
    if (!base64) {
      continue;
    }
    const icsText = atob(base64);
    for (const parsed of parseIcsEvents(icsText)) {
      if (!parsed.summary.includes(source.titleFilter)) {
        continue;
      }
      events.push({
        sourceId: source.id,
        externalId: parsed.uid,
        title: parsed.summary,
        committeeName: source.committeeName,
        startUtc: parsed.startUtc,
        endUtc: parsed.endUtc === parsed.startUtc ? null : parsed.endUtc,
        location: parsed.location,
        url: source.pageUrl,
      });
    }
  }
  return events;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/adapters/caltrainBatac.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/caltrainBatac.ts src/adapters/caltrainBatac.test.ts
git commit -m "feat(committee-calendars): add Caltrain BATAC embedded-ICS scrape adapter"
```

---

## Task 8: D1 event store

**Files:**
- Create: `committee-calendars/src/db/events.ts`
- Test: `committee-calendars/src/db/events.test.ts`

**Interfaces:**
- Consumes: `NormalizedEvent` from `src/types.ts`. Applies against the real `events` /
  `source_status` tables from `migrations/0001_create_events.sql` (Task 1) via the
  `@cloudflare/vitest-plugin` D1 test harness — no mocking, a real (Miniflare) D1 instance.
- Produces: `EventStore` interface and `D1EventStore` implementing it:
  - `replaceSourceEvents(sourceId: string, events: NormalizedEvent[], todayUtc: string): Promise<void>`
  - `recordSourceSuccess(sourceId: string, nowUtc: string): Promise<void>`
  - `recordSourceFailure(sourceId: string, errorMessage: string): Promise<number>` (returns the new
    `consecutive_failures` count)
  - `getFutureEvents(nowUtc: string): Promise<NormalizedEvent[]>`
  Consumed by `src/sync.ts` (Task 11) and `src/route.ts` (Task 12).

- [ ] **Step 1: Write the failing test** `src/db/events.test.ts`

```ts
import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1EventStore } from './events';
import type { NormalizedEvent } from '../types';

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    sourceId: 'campbell',
    externalId: 'evt-1',
    title: 'BPAC Meeting',
    committeeName: 'Bicycle & Pedestrian Advisory Committee',
    startUtc: '2026-09-01T00:00:00.000Z',
    endUtc: '2026-09-01T01:00:00.000Z',
    location: 'Council Chamber',
    url: 'https://example.com/1',
    ...overrides,
  };
}

describe('D1EventStore', () => {
  it('replaceSourceEvents inserts events retrievable by getFutureEvents', async () => {
    const store = new D1EventStore(env.DB);
    await store.replaceSourceEvents('campbell', [event()], '2026-08-01T00:00:00.000Z');

    const future = await store.getFutureEvents('2026-08-01T00:00:00.000Z');
    expect(future).toEqual([event()]);
  });

  it('replaceSourceEvents drops a future event that stopped being returned (cancelled meeting)', async () => {
    const store = new D1EventStore(env.DB);
    await store.replaceSourceEvents(
      'campbell',
      [event({ externalId: 'evt-1' }), event({ externalId: 'evt-2', startUtc: '2026-09-15T00:00:00.000Z' })],
      '2026-08-01T00:00:00.000Z'
    );
    // Next day's poll no longer returns evt-2 (it was cancelled).
    await store.replaceSourceEvents('campbell', [event({ externalId: 'evt-1' })], '2026-08-02T00:00:00.000Z');

    const future = await store.getFutureEvents('2026-08-01T00:00:00.000Z');
    expect(future.map((e) => e.externalId)).toEqual(['evt-1']);
  });

  it('replaceSourceEvents never touches another source\'s events', async () => {
    const store = new D1EventStore(env.DB);
    await store.replaceSourceEvents('campbell', [event({ sourceId: 'campbell', externalId: 'c-1' })], '2026-08-01T00:00:00.000Z');
    await store.replaceSourceEvents('saratoga', [event({ sourceId: 'saratoga', externalId: 's-1' })], '2026-08-01T00:00:00.000Z');
    await store.replaceSourceEvents('campbell', [], '2026-08-02T00:00:00.000Z'); // campbell now has zero events

    const future = await store.getFutureEvents('2026-08-01T00:00:00.000Z');
    expect(future.map((e) => e.sourceId)).toEqual(['saratoga']);
  });

  it('getFutureEvents excludes events before the given instant and orders by start ascending', async () => {
    const store = new D1EventStore(env.DB);
    await store.replaceSourceEvents(
      'campbell',
      [
        event({ externalId: 'past', startUtc: '2026-01-01T00:00:00.000Z' }),
        event({ externalId: 'later', startUtc: '2026-10-01T00:00:00.000Z' }),
        event({ externalId: 'sooner', startUtc: '2026-09-01T00:00:00.000Z' }),
      ],
      '2025-12-01T00:00:00.000Z' // todayUtc predates all three so the delete step doesn't remove 'past'
    );

    const future = await store.getFutureEvents('2026-08-01T00:00:00.000Z');
    expect(future.map((e) => e.externalId)).toEqual(['sooner', 'later']);
  });

  it('recordSourceSuccess resets a failure streak', async () => {
    const store = new D1EventStore(env.DB);
    await store.recordSourceFailure('bart', 'boom');
    await store.recordSourceFailure('bart', 'boom again');
    await store.recordSourceSuccess('bart', '2026-08-01T00:00:00.000Z');

    const third = await store.recordSourceFailure('bart', 'boom a third time');
    expect(third).toBe(1); // streak reset by the intervening success
  });

  it('recordSourceFailure increments and returns the running consecutive_failures count', async () => {
    const store = new D1EventStore(env.DB);
    expect(await store.recordSourceFailure('bart', 'first')).toBe(1);
    expect(await store.recordSourceFailure('bart', 'second')).toBe(2);
    expect(await store.recordSourceFailure('bart', 'third')).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/db/events.test.ts`
Expected: FAIL — `Cannot find module './events'`.

- [ ] **Step 3: Write `src/db/events.ts`**

```ts
import type { NormalizedEvent } from '../types';

export interface EventStore {
  replaceSourceEvents(sourceId: string, events: NormalizedEvent[], todayUtc: string): Promise<void>;
  recordSourceSuccess(sourceId: string, nowUtc: string): Promise<void>;
  recordSourceFailure(sourceId: string, errorMessage: string): Promise<number>;
  getFutureEvents(nowUtc: string): Promise<NormalizedEvent[]>;
}

interface D1EventRow {
  id: string;
  source_id: string;
  title: string;
  committee_name: string;
  start_utc: string;
  end_utc: string | null;
  location: string | null;
  url: string | null;
  last_seen_at: string;
}

function toNormalizedEvent(row: D1EventRow): NormalizedEvent {
  return {
    sourceId: row.source_id,
    externalId: row.id.slice(row.source_id.length + 1),
    title: row.title,
    committeeName: row.committee_name,
    startUtc: row.start_utc,
    endUtc: row.end_utc,
    location: row.location,
    url: row.url,
  };
}

export class D1EventStore implements EventStore {
  constructor(private db: D1Database) {}

  async replaceSourceEvents(sourceId: string, events: NormalizedEvent[], todayUtc: string): Promise<void> {
    const statements = [
      this.db.prepare(`DELETE FROM events WHERE source_id = ?1 AND start_utc >= ?2`).bind(sourceId, todayUtc),
      ...events.map((event) =>
        this.db
          .prepare(
            `INSERT INTO events (id, source_id, title, committee_name, start_utc, end_utc, location, url, last_seen_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT (id) DO UPDATE SET
               title = excluded.title,
               committee_name = excluded.committee_name,
               start_utc = excluded.start_utc,
               end_utc = excluded.end_utc,
               location = excluded.location,
               url = excluded.url,
               last_seen_at = excluded.last_seen_at`
          )
          .bind(
            `${sourceId}:${event.externalId}`,
            sourceId,
            event.title,
            event.committeeName,
            event.startUtc,
            event.endUtc,
            event.location,
            event.url,
            todayUtc
          )
      ),
    ];
    await this.db.batch(statements);
  }

  async recordSourceSuccess(sourceId: string, nowUtc: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO source_status (source_id, last_success_at, consecutive_failures, last_error)
         VALUES (?1, ?2, 0, NULL)
         ON CONFLICT (source_id) DO UPDATE SET
           last_success_at = ?2,
           consecutive_failures = 0,
           last_error = NULL`
      )
      .bind(sourceId, nowUtc)
      .run();
  }

  async recordSourceFailure(sourceId: string, errorMessage: string): Promise<number> {
    const result = await this.db
      .prepare(
        `INSERT INTO source_status (source_id, last_success_at, consecutive_failures, last_error)
         VALUES (?1, NULL, 1, ?2)
         ON CONFLICT (source_id) DO UPDATE SET
           consecutive_failures = source_status.consecutive_failures + 1,
           last_error = ?2
         RETURNING consecutive_failures`
      )
      .bind(sourceId, errorMessage)
      .first<{ consecutive_failures: number }>();
    if (result === null) {
      throw new Error(`db: recordSourceFailure returned no row for source "${sourceId}"`);
    }
    return result.consecutive_failures;
  }

  async getFutureEvents(nowUtc: string): Promise<NormalizedEvent[]> {
    const result = await this.db
      .prepare(`SELECT * FROM events WHERE start_utc >= ?1 ORDER BY start_utc ASC`)
      .bind(nowUtc)
      .all<D1EventRow>();
    return result.results.map(toNormalizedEvent);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/db/events.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/events.ts src/db/events.test.ts
git commit -m "feat(committee-calendars): add D1 event store with source-scoped replace and failure tracking"
```

---

## Task 9: ICS serialization

**Files:**
- Create: `committee-calendars/src/ics.ts`
- Test: `committee-calendars/src/ics.test.ts`

**Interfaces:**
- Consumes: `NormalizedEvent` from `src/types.ts`.
- Produces: `buildMergedCalendar(events: NormalizedEvent[]): string`. Consumed by `src/route.ts`
  (Task 12).

- [ ] **Step 1: Write the failing test** `src/ics.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { buildMergedCalendar } from './ics';
import type { NormalizedEvent } from './types';

describe('buildMergedCalendar', () => {
  it('produces a valid VCALENDAR with one VEVENT per input, using UTC start/end', () => {
    const events: NormalizedEvent[] = [
      {
        sourceId: 'campbell',
        externalId: 'evt-1',
        title: 'Bicycle and Pedestrian Advisory Committee Meeting',
        committeeName: 'Bicycle & Pedestrian Advisory Committee',
        startUtc: '2026-11-20T01:00:00.000Z',
        endUtc: '2026-11-20T02:00:00.000Z',
        location: 'Council Chamber, 70 N First St, Campbell, CA 95008',
        url: 'https://www.campbellca.gov/calendar.aspx?EID=1234',
      },
    ];

    const ics = buildMergedCalendar(events);

    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('UID:campbell:evt-1@committee-calendars.bikesiliconvalley.org');
    expect(ics).toContain('DTSTART:20261120T010000Z');
    expect(ics).toContain('DTEND:20261120T020000Z');
    expect(ics).toContain('SUMMARY:Bicycle and Pedestrian Advisory Committee Meeting');
    expect(ics).toContain('URL:https://www.campbellca.gov/calendar.aspx?EID=1234');
    expect(ics).toContain('LOCATION:Council Chamber\\, 70 N First St\\, Campbell\\, CA 95008');
  });

  it('omits DTEND when endUtc is null, rather than fabricating a duration', () => {
    const events: NormalizedEvent[] = [
      {
        sourceId: 'cupertino',
        externalId: '5259',
        title: 'Bicycle Pedestrian Commission',
        committeeName: 'Bicycle Pedestrian Commission',
        startUtc: '2026-01-30T03:00:00.000Z',
        endUtc: null,
        location: null,
        url: null,
      },
    ];

    const ics = buildMergedCalendar(events);
    expect(ics).toContain('DTSTART:20260130T030000Z');
    expect(ics).not.toContain('DTEND:');
  });

  it('produces an empty-but-valid calendar for zero events', () => {
    const ics = buildMergedCalendar([]);
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('END:VCALENDAR');
    expect(ics).not.toContain('BEGIN:VEVENT');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/ics.test.ts`
Expected: FAIL — `Cannot find module './ics'` (this repo's `./ics.ts` doesn't exist yet — the
import in the test refers to the file being created in this task, not the `ics` npm package,
which is a separate import inside `src/ics.ts` itself).

- [ ] **Step 3: Write `src/ics.ts`**

```ts
import { createEvents, type EventAttributes, type DateArray } from 'ics';
import type { NormalizedEvent } from './types';

function toDateArray(isoUtc: string): DateArray {
  const date = new Date(isoUtc);
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes()];
}

export function buildMergedCalendar(events: NormalizedEvent[]): string {
  const attributes: EventAttributes[] = events.map((event) => {
    const attrs: EventAttributes = {
      uid: `${event.sourceId}:${event.externalId}@committee-calendars.bikesiliconvalley.org`,
      title: event.title,
      start: toDateArray(event.startUtc),
      startInputType: 'utc',
      startOutputType: 'utc',
      calName: 'SVBC Committee Calendars',
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
    return attrs;
  });

  const { error, value } = createEvents(attributes);
  if (error) {
    throw error;
  }
  return value ?? '';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/ics.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ics.ts src/ics.test.ts
git commit -m "feat(committee-calendars): add merged ICS serialization"
```

---

## Task 10: Slack failure alert

**Files:**
- Create: `committee-calendars/src/alert.ts`
- Test: `committee-calendars/src/alert.test.ts`

**Interfaces:**
- Produces: `sendFailureAlert(webhookUrl: string, sourceId: string, sourceName: string,
  consecutiveFailures: number, lastError: string): Promise<void>`. Consumed by `src/sync.ts`
  (Task 11).

- [ ] **Step 1: Write the failing test** `src/alert.test.ts`

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { sendFailureAlert } from './alert';

describe('sendFailureAlert', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs a JSON message to the webhook URL with the source and error details', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendFailureAlert('https://hooks.slack.example/T000/B000/xyz', 'bart', 'BART', 3, 'fetch failed: 500');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://hooks.slack.example/T000/B000/xyz');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.text).toContain('BART');
    expect(body.text).toContain('bart');
    expect(body.text).toContain('3 days in a row');
    expect(body.text).toContain('fetch failed: 500');
  });

  it('does not throw when the webhook POST itself fails (logs and returns)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad request', { status: 400 })));
    await expect(sendFailureAlert('https://hooks.slack.example/T000/B000/xyz', 'bart', 'BART', 3, 'boom')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/alert.test.ts`
Expected: FAIL — `Cannot find module './alert'`.

- [ ] **Step 3: Write `src/alert.ts`**

```ts
export async function sendFailureAlert(
  webhookUrl: string,
  sourceId: string,
  sourceName: string,
  consecutiveFailures: number,
  lastError: string
): Promise<void> {
  const text = `committee-calendars: source "${sourceName}" (${sourceId}) has failed ${consecutiveFailures} days in a row. Last error: ${lastError}`;
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    console.error(`committee-calendars: Slack alert POST failed: ${response.status} ${response.statusText}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/alert.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/alert.ts src/alert.test.ts
git commit -m "feat(committee-calendars): add Slack failure-streak alert"
```

---

## Task 11: Cron sync orchestration

**Files:**
- Create: `committee-calendars/src/adapters/dispatch.ts`
- Create: `committee-calendars/src/sync.ts`
- Test: `committee-calendars/src/sync.test.ts`

**Interfaces:**
- Consumes: `EventStore` from `src/db/events.ts` (Task 8), `SourceConfig`,
  `CommitteeCalendarsConfig`, `NormalizedEvent` from `src/types.ts`, `sendFailureAlert` from
  `src/alert.ts` (Task 10), `errorMessage` from `src/util/errorMessage.ts` (Task 1), the three
  adapter fetch functions from Tasks 5–7.
- Produces: `FetchSourceEvents` type and `fetchSourceEvents` (the real dispatcher, from
  `dispatch.ts`); `SyncDeps` and `syncAllSources(deps: SyncDeps): Promise<void>` (from `sync.ts`).
  Consumed by `src/index.ts` (Task 13).

- [ ] **Step 1: Write `src/adapters/dispatch.ts`** (pure wiring — real adapters, no test file; its
  behavior is exercised end-to-end by `test/integration.test.ts` in Task 14 and unit-tested per
  adapter in Tasks 5–7)

```ts
import type { NormalizedEvent, SourceConfig } from '../types';
import { fetchLegistarEvents } from './legistar';
import { fetchCivicPlusEvents } from './civicplus';
import { fetchCaltrainBatacEvents } from './caltrainBatac';

export type FetchSourceEvents = (source: SourceConfig, now: Date) => Promise<NormalizedEvent[]>;

export const fetchSourceEvents: FetchSourceEvents = (source, now) => {
  switch (source.adapter) {
    case 'legistar':
      return fetchLegistarEvents(source, now);
    case 'civicplus':
      return fetchCivicPlusEvents(source);
    case 'caltrainBatac':
      return fetchCaltrainBatacEvents(source);
  }
};
```

- [ ] **Step 2: Write the failing test** `src/sync.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest';
import { syncAllSources } from './sync';
import type { EventStore } from './db/events';
import type { CommitteeCalendarsConfig, LegistarSourceConfig, NormalizedEvent } from './types';

function fakeEventStore(): EventStore & {
  replaced: Array<{ sourceId: string; count: number; todayUtc: string }>;
  successes: string[];
  failures: Array<{ sourceId: string; message: string }>;
} {
  const replaced: Array<{ sourceId: string; count: number; todayUtc: string }> = [];
  const successes: string[] = [];
  const failures: Array<{ sourceId: string; message: string }> = [];
  const failureCounts = new Map<string, number>();

  return {
    replaced,
    successes,
    failures,
    async replaceSourceEvents(sourceId, events, todayUtc) {
      replaced.push({ sourceId, count: events.length, todayUtc });
    },
    async recordSourceSuccess(sourceId) {
      successes.push(sourceId);
      failureCounts.set(sourceId, 0);
    },
    async recordSourceFailure(sourceId, message) {
      failures.push({ sourceId, message });
      const next = (failureCounts.get(sourceId) ?? 0) + 1;
      failureCounts.set(sourceId, next);
      return next;
    },
    async getFutureEvents() {
      return [];
    },
  };
}

const SOURCE_A: LegistarSourceConfig = {
  id: 'a',
  name: 'Source A',
  committeeName: 'Committee A',
  adapter: 'legistar',
  client: 'a',
  bodyId: 1,
};
const SOURCE_B: LegistarSourceConfig = {
  id: 'b',
  name: 'Source B',
  committeeName: 'Committee B',
  adapter: 'legistar',
  client: 'b',
  bodyId: 2,
};

const CONFIG: CommitteeCalendarsConfig = { sources: [SOURCE_A, SOURCE_B] };
const NOW = new Date('2026-08-22T00:00:00.000Z');

describe('syncAllSources', () => {
  it('writes each successful source\'s events and records success', async () => {
    const eventStore = fakeEventStore();
    const events: NormalizedEvent[] = [
      { sourceId: 'a', externalId: '1', title: 't', committeeName: 'c', startUtc: NOW.toISOString(), endUtc: null, location: null, url: null },
    ];
    const fetchSourceEvents = vi.fn(async (source) => (source.id === 'a' ? events : []));

    await syncAllSources({ eventStore, config: CONFIG, slackWebhookUrl: 'https://hooks.example', now: NOW, fetchSourceEvents });

    expect(eventStore.replaced).toEqual([
      { sourceId: 'a', count: 1, todayUtc: NOW.toISOString() },
      { sourceId: 'b', count: 0, todayUtc: NOW.toISOString() },
    ]);
    expect(eventStore.successes).toEqual(['a', 'b']);
    expect(eventStore.failures).toEqual([]);
  });

  it('isolates one source\'s failure — the other source still syncs', async () => {
    const eventStore = fakeEventStore();
    const fetchSourceEvents = vi.fn(async (source) => {
      if (source.id === 'a') {
        throw new Error('a is down');
      }
      return [];
    });

    await syncAllSources({ eventStore, config: CONFIG, slackWebhookUrl: 'https://hooks.example', now: NOW, fetchSourceEvents });

    expect(eventStore.failures).toEqual([{ sourceId: 'a', message: 'a is down' }]);
    expect(eventStore.successes).toEqual(['b']);
    expect(eventStore.replaced).toEqual([{ sourceId: 'b', count: 0, todayUtc: NOW.toISOString() }]);
  });

  it('fires exactly one Slack alert the moment a source first reaches 3 consecutive failures', async () => {
    const eventStore = fakeEventStore();
    // Fail 'a' twice already before this run starts.
    await eventStore.recordSourceFailure('a', 'first');
    await eventStore.recordSourceFailure('a', 'second');

    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const fetchSourceEvents = vi.fn(async (source) => {
      if (source.id === 'a') {
        throw new Error('third failure');
      }
      return [];
    });

    await syncAllSources({ eventStore, config: CONFIG, slackWebhookUrl: 'https://hooks.example', now: NOW, fetchSourceEvents });

    expect(fetchMock).toHaveBeenCalledTimes(1); // the Slack webhook POST
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://hooks.example');

    vi.unstubAllGlobals();
  });

  it('does not re-alert on a 4th consecutive failure', async () => {
    const eventStore = fakeEventStore();
    await eventStore.recordSourceFailure('a', 'first');
    await eventStore.recordSourceFailure('a', 'second');
    await eventStore.recordSourceFailure('a', 'third');

    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const fetchSourceEvents = vi.fn(async (source) => {
      if (source.id === 'a') {
        throw new Error('fourth failure');
      }
      return [];
    });

    await syncAllSources({ eventStore, config: CONFIG, slackWebhookUrl: 'https://hooks.example', now: NOW, fetchSourceEvents });

    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- src/sync.test.ts`
Expected: FAIL — `Cannot find module './sync'`.

- [ ] **Step 4: Write `src/sync.ts`**

```ts
import type { EventStore } from './db/events';
import type { CommitteeCalendarsConfig } from './types';
import type { FetchSourceEvents } from './adapters/dispatch';
import { sendFailureAlert } from './alert';
import { errorMessage } from './util/errorMessage';

const FAILURE_ALERT_THRESHOLD = 3;

export interface SyncDeps {
  eventStore: EventStore;
  config: CommitteeCalendarsConfig;
  slackWebhookUrl: string;
  now: Date;
  fetchSourceEvents: FetchSourceEvents;
}

export async function syncAllSources(deps: SyncDeps): Promise<void> {
  const todayUtc = deps.now.toISOString();

  for (const source of deps.config.sources) {
    try {
      const events = await deps.fetchSourceEvents(source, deps.now);
      await deps.eventStore.replaceSourceEvents(source.id, events, todayUtc);
      await deps.eventStore.recordSourceSuccess(source.id, todayUtc);
    } catch (err) {
      const message = errorMessage(err);
      console.error(`committee-calendars sync: source "${source.id}" failed: ${message}`);
      const consecutiveFailures = await deps.eventStore.recordSourceFailure(source.id, message);
      if (consecutiveFailures === FAILURE_ALERT_THRESHOLD) {
        await sendFailureAlert(deps.slackWebhookUrl, source.id, source.name, consecutiveFailures, message);
      }
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/sync.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/adapters/dispatch.ts src/sync.ts src/sync.test.ts
git commit -m "feat(committee-calendars): add per-source-isolated cron sync with failure-threshold alerting"
```

---

## Task 12: HTTP route

**Files:**
- Create: `committee-calendars/src/route.ts`
- Test: `committee-calendars/src/route.test.ts`

**Interfaces:**
- Consumes: `EventStore` from `src/db/events.ts` (Task 8), `buildMergedCalendar` from `src/ics.ts`
  (Task 9).
- Produces: `AppDeps` and `createApp(deps: AppDeps): Hono`. Consumed by `src/index.ts` (Task 13).

- [ ] **Step 1: Write the failing test** `src/route.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { createApp } from './route';
import type { EventStore } from './db/events';
import type { NormalizedEvent } from './types';

function fakeEventStore(events: NormalizedEvent[]): EventStore {
  return {
    async replaceSourceEvents() {},
    async recordSourceSuccess() {},
    async recordSourceFailure() {
      return 1;
    },
    async getFutureEvents() {
      return events;
    },
  };
}

describe('GET /committees.ics', () => {
  it('returns a merged ICS calendar with the correct content-type and cache-control headers', async () => {
    const events: NormalizedEvent[] = [
      { sourceId: 'campbell', externalId: '1', title: 'BPAC Meeting', committeeName: 'BPAC', startUtc: '2026-09-01T00:00:00.000Z', endUtc: null, location: null, url: null },
    ];
    const app = createApp({ eventStore: fakeEventStore(events), now: () => new Date('2026-08-22T00:00:00.000Z') });

    const response = await app.request('/committees.ics');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
    const body = await response.text();
    expect(body).toContain('BEGIN:VCALENDAR');
    expect(body).toContain('SUMMARY:BPAC Meeting');
  });

  it('returns a valid empty calendar when D1 has zero rows (fresh deploy)', async () => {
    const app = createApp({ eventStore: fakeEventStore([]), now: () => new Date('2026-08-22T00:00:00.000Z') });

    const response = await app.request('/committees.ics');

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('BEGIN:VCALENDAR');
    expect(body).not.toContain('BEGIN:VEVENT');
  });

  it('answers /health', async () => {
    const app = createApp({ eventStore: fakeEventStore([]), now: () => new Date() });
    const response = await app.request('/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/route.test.ts`
Expected: FAIL — `Cannot find module './route'`.

- [ ] **Step 3: Write `src/route.ts`**

```ts
import { Hono } from 'hono';
import type { EventStore } from './db/events';
import { buildMergedCalendar } from './ics';

export interface AppDeps {
  eventStore: EventStore;
  now: () => Date;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true }));

  app.get('/committees.ics', async (c) => {
    const nowUtc = deps.now().toISOString();
    const events = await deps.eventStore.getFutureEvents(nowUtc);
    const calendar = buildMergedCalendar(events);
    c.header('Content-Type', 'text/calendar; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=3600');
    return c.body(calendar);
  });

  return app;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/route.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/route.ts src/route.test.ts
git commit -m "feat(committee-calendars): add GET /committees.ics route"
```

---

## Task 13: Wire the Worker entrypoint

**Files:**
- Create: `committee-calendars/src/index.ts`

**Interfaces:**
- Consumes: `validateConfig` (Task 2), `createApp` (Task 12), `D1EventStore` (Task 8),
  `syncAllSources` (Task 11), `fetchSourceEvents` (Task 11's `dispatch.ts`), `Env` (Task 1).
- Produces: the Worker's default export (`fetch` + `scheduled` handlers) — this is what
  `wrangler dev`/`wrangler deploy` actually run. No dedicated test file, matching
  `funraise-sync/src/index.ts` (thin wiring only, exercised by the integration test in Task 14 and
  by `npm run typecheck`).

- [ ] **Step 1: Write `src/index.ts`**

```ts
import rawConfig from '../config/sources.json';
import { validateConfig } from './config';
import { createApp } from './route';
import { D1EventStore } from './db/events';
import { syncAllSources } from './sync';
import { fetchSourceEvents } from './adapters/dispatch';
import type { Env } from './types';

const config = validateConfig(rawConfig);

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const app = createApp({
      eventStore: new D1EventStore(env.DB),
      now: () => new Date(),
    });
    return app.fetch(request, env, ctx);
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await syncAllSources({
      eventStore: new D1EventStore(env.DB),
      config,
      slackWebhookUrl: env.SLACK_WEBHOOK_URL,
      now: new Date(),
      fetchSourceEvents,
    });
  },
};
```

- [ ] **Step 2: Verify the whole project typechecks and the full test suite passes**

```bash
npm run typecheck
npm test
```

Expected: both exit 0. `typecheck` confirms `src/index.ts` wires every dependency with matching
types (this is where a mismatched signature between tasks would surface). `test` should show all
suites from Tasks 2–12 passing (config, zonedTime, parseIcs, legistar, civicplus, caltrainBatac,
events, ics, alert, sync, route — no `index.test.ts`, matching `funraise-sync`'s convention).

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(committee-calendars): wire Worker entrypoint (fetch + scheduled handlers)"
```

---

## Task 14: End-to-end integration test

**Files:**
- Create: `committee-calendars/test/integration.test.ts`

**Interfaces:**
- Consumes: `D1EventStore` (Task 8), `syncAllSources` (Task 11), `createApp` (Task 12). Exercises
  the real D1 migrations from `migrations/0001_create_events.sql` (Task 1) via the same
  `cloudflare:workers` `env` used in `src/db/events.test.ts` — no mocking of D1 in this task, only
  the network-facing `fetchSourceEvents` function is faked (this test is about the D1/route
  wiring, not re-testing each adapter's HTTP parsing, which Tasks 5–7 already cover).

- [ ] **Step 1: Write the failing test** `test/integration.test.ts`

```ts
import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1EventStore } from '../src/db/events';
import { syncAllSources } from '../src/sync';
import { createApp } from '../src/route';
import type { CommitteeCalendarsConfig, LegistarSourceConfig, NormalizedEvent } from '../src/types';

const SOURCE: LegistarSourceConfig = {
  id: 'test-source',
  name: 'Test Source',
  committeeName: 'Test Committee',
  adapter: 'legistar',
  client: 'test',
  bodyId: 1,
};
const CONFIG: CommitteeCalendarsConfig = { sources: [SOURCE] };

describe('committee-calendars integration', () => {
  it('serves an empty-but-valid calendar before cron has ever run', async () => {
    const eventStore = new D1EventStore(env.DB);
    const app = createApp({ eventStore, now: () => new Date('2026-08-22T00:00:00.000Z') });

    const response = await app.request('/committees.ics');

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('BEGIN:VCALENDAR');
    expect(body).not.toContain('BEGIN:VEVENT');
  });

  it('a cron write is immediately visible on the next route request', async () => {
    const eventStore = new D1EventStore(env.DB);
    const now = new Date('2026-08-22T00:00:00.000Z');
    const events: NormalizedEvent[] = [
      {
        sourceId: 'test-source',
        externalId: '42',
        title: 'Test Committee Meeting',
        committeeName: 'Test Committee',
        startUtc: '2026-09-01T00:00:00.000Z',
        endUtc: null,
        location: null,
        url: null,
      },
    ];

    await syncAllSources({
      eventStore,
      config: CONFIG,
      slackWebhookUrl: 'https://hooks.example',
      now,
      fetchSourceEvents: async () => events,
    });

    const app = createApp({ eventStore, now: () => now });
    const response = await app.request('/committees.ics');
    const body = await response.text();
    expect(body).toContain('SUMMARY:Test Committee Meeting');
  });

  it('a meeting that disappears from the source (cancelled) is gone from the feed the next cron run', async () => {
    const eventStore = new D1EventStore(env.DB);
    const day1 = new Date('2026-08-23T00:00:00.000Z');
    const day2 = new Date('2026-08-24T00:00:00.000Z');
    const event: NormalizedEvent = {
      sourceId: 'test-source',
      externalId: 'cancel-me',
      title: 'Meeting That Gets Cancelled',
      committeeName: 'Test Committee',
      startUtc: '2026-09-15T00:00:00.000Z',
      endUtc: null,
      location: null,
      url: null,
    };

    await syncAllSources({
      eventStore,
      config: CONFIG,
      slackWebhookUrl: 'https://hooks.example',
      now: day1,
      fetchSourceEvents: async () => [event],
    });
    let app = createApp({ eventStore, now: () => day1 });
    expect(await (await app.request('/committees.ics')).text()).toContain('Meeting That Gets Cancelled');

    // Day 2's poll no longer returns it.
    await syncAllSources({
      eventStore,
      config: CONFIG,
      slackWebhookUrl: 'https://hooks.example',
      now: day2,
      fetchSourceEvents: async () => [],
    });
    app = createApp({ eventStore, now: () => day2 });
    expect(await (await app.request('/committees.ics')).text()).not.toContain('Meeting That Gets Cancelled');
  });

  it('a failing source does not prevent other sources\' events from being served', async () => {
    const eventStore = new D1EventStore(env.DB);
    const now = new Date('2026-08-22T00:00:00.000Z');
    const workingSource: LegistarSourceConfig = { ...SOURCE, id: 'working-source' };
    const brokenSource: LegistarSourceConfig = { ...SOURCE, id: 'broken-source' };
    const workingEvent: NormalizedEvent = {
      sourceId: 'working-source',
      externalId: '1',
      title: 'Still Works',
      committeeName: 'Test Committee',
      startUtc: '2026-09-01T00:00:00.000Z',
      endUtc: null,
      location: null,
      url: null,
    };

    await syncAllSources({
      eventStore,
      config: { sources: [workingSource, brokenSource] },
      slackWebhookUrl: 'https://hooks.example',
      now,
      fetchSourceEvents: async (source) => {
        if (source.id === 'broken-source') {
          throw new Error('simulated outage');
        }
        return [workingEvent];
      },
    });

    const app = createApp({ eventStore, now: () => now });
    const body = await (await app.request('/committees.ics')).text();
    expect(body).toContain('SUMMARY:Still Works');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/integration.test.ts`
Expected: at least one FAIL if any prior task's file is missing or mismatched — this is the first
point every piece is exercised together. Given Tasks 1–13 are already complete at this point, the
expected initial state is actually already passing; if it does, skip straight to Step 3 rather than
forcing an artificial failure — the point of writing it first here is design clarity, not a
literal red state, since every dependency already exists from prior tasks.

- [ ] **Step 3: Run the full suite one more time**

```bash
npm test
npm run typecheck
```

Expected: all tests across every task pass; typecheck is clean.

- [ ] **Step 4: Commit**

```bash
git add test/integration.test.ts
git commit -m "test(committee-calendars): add end-to-end cron-write to route-read integration test"
```

---

## Task 15: Deploy prep and README follow-through

**Files:**
- Modify: `committee-calendars/wrangler.jsonc` (no code change — this step is about the manual
  `wrangler` commands needed before a real deploy can happen, documented here so they aren't lost)

**Interfaces:** None — this task has no code interfaces; it's the manual bridge between "tests
pass locally" and "this is actually deployed."

- [ ] **Step 1: Create the D1 database and secret** (run once, by whoever deploys; not run by the
  implementer as part of this plan — record the commands here so they aren't lost)

```bash
wrangler d1 create svbc-committee-calendars
# copy the returned database_id into wrangler.jsonc's d1_databases[0].database_id
wrangler d1 migrations apply svbc-committee-calendars --remote
wrangler secret put SLACK_WEBHOOK_URL
```

- [ ] **Step 2: Local smoke test**

```bash
npm run dev
curl http://localhost:8787/committees.ics
```

Expected: a 200 response with `BEGIN:VCALENDAR`/`END:VCALENDAR` (likely empty, since `wrangler dev`
doesn't run the cron trigger automatically — that's expected; it confirms the route and D1 binding
work end-to-end against a local Miniflare D1 instance).

- [ ] **Step 3: Update `committee-calendars/README.md`'s Status line** once deployed, from
  "Decided — build (scoped 2026-08-22)" to a "Shipped" or "Live" status noting the deploy date and
  the actual `calendar.bikesiliconvalley.org` (or whatever the real deployed route is) URL —
  deferred until deploy actually happens, not part of this implementation plan's code tasks.

No commit for this task — it's operational, not code.
