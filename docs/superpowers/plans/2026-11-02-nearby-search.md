# nearby-search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A staff-only web page, served by a new `nearby-search` Worker. A staff member types or
prefills a place (address, intersection, place name, or "road between X and Y") and a distance.
The page shows the matching People, People (Historical) and Organizations on a map. After
confirmation, it links them onto a Monday board the organizer picks and labels the people for a
Mailchimp tag.

**Architecture:** One Hono Worker with a few parts:
- Text is parsed into a location query, then resolved to a point or a line through OpenStreetMap
  (Nominatim + Overpass).
- `geo-filter`'s `filterContacts` runs over contacts paged from Monday.
- A confirm request enqueues one message per match on a Cloudflare Queue. The consumer creates
  the board rows and sets a "Nearby" dropdown label on each person.
- An hourly cron geocodes contacts with an address but no Lat/Lng, using the Census geocoder.
- `mailchimp-sync` turns the Nearby labels into Mailchimp tags.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers (D1, Queues, KV `FLAGS`, Cache API,
service binding to `monday-auth`), `@turf/turf` (through geo-filter's geometry), Leaflet 1.9.4
with OSM tiles on the page, vitest with `@cloudflare/vitest-plugin`.

**Spec:** `docs/superpowers/specs/2026-11-02-nearby-search-design.md`

## Global Constraints

- **Staff only.** Every route except `GET /health` requires a valid Cloudflare Access JWT
  (`Cf-Access-Jwt-Assertion`), verified in the Worker. `workers_dev: false`; served on a custom
  domain behind one Access application.
- **Monday access goes through the `MONDAY_AUTH` service binding**, using entrypoint `SyncToken`
  (production `svbc-monday-auth`, sandbox `svbc-monday-auth-sandbox`). No `MONDAY_API_TOKEN`
  secret.
- **Byte-identical copies, never edited in place:**
  - `src/monday/graphql.ts` copies `monday-backup/src/monday/graphql.ts`.
  - `src/flags.ts` copies `member-portal/src/flags.ts`.
  - `src/environment.ts` copies `report-digests/src/environment.ts`.
  - `src/geometry.ts` copies `geo-filter/src/geometry.ts`.
- **Write switch key `nearby-search:writes`.**
  - Preview never writes, whatever the mode.
  - Confirm stamps messages with `stampFor(mode)`. The consumer obeys `messageDisposition`.
  - The geocode cron obeys `runDisposition`.
- **Outage retry policy:** delay `min(60 x 2^(attempts-1), 3600)` s via `retryDelaySeconds`;
  `max_retries: 100` on the main queue; a DLQ.
- **SVBC-specific values live in `config/svbc.json` / `config/sandbox.json`**, validated at
  startup. Placeholders are `REPLACE_WITH_COLUMN_ID` / `null`, and the Worker fails loudly on
  them.
- **No address, email, or name in any `console.*`.** `node scripts/check-log-safety.mjs` must
  pass.
- **OSM usage policy:**
  - Send `User-Agent` from config `osm.userAgent`.
  - Every Nominatim/Overpass response is cached in the Cache API for 24 h.
  - The search is restricted to config `serviceArea` (bbox `[south, west, north, east]` =
    `[36.89, -122.53, 37.71, -121.20]`, Santa Clara + San Mateo counties).
- **Default distances:** 2 miles for an Events prefill, 0.5 miles for anything else. Allowed
  range 0.05–10 miles.
- **Nearby label:** 1–60 chars, no commas, trimmed. The Mailchimp tag is
  `mailchimp.nearbyTagPrefix` + label, and the prefix is `"Near: "`.
- **Organizations get board rows only, never a Nearby label.**
- **People (Historical) get the label, but `mailchimp-sync` doesn't watch that board yet**
  (svbc-monday-workers#83). The confirm step shows: "N of these are Historical and won't get the
  email yet."

## Review Focus

1. **Cross street that never meets the road.** For example, "Stevens Creek Blvd between Saratoga
   Ave and Winchester Blvd" where OSM names it "Saratoga Avenue" but it actually meets as
   "Saratoga-Sunnyvale Road". Expect a `not-found` naming the missing crossing, never a silent
   fallback to a radius. Covered by Task 4's `resolveLocation` tests.
2. **Divided boulevards.** A road split into two one-way carriageways, plus several ways per
   name. Expect the path to still be found between the crossings, ignoring `oneway`. Covered by a
   Task 4 fixture test.
3. **Re-running a search with a wider distance, and queue redelivery.** Expect only new contacts
   to be enqueued and no duplicate board rows. Covered by Task 6 confirm tests and Task 8
   consumer tests.
4. **Contacts with blank, non-numeric, or `0,0` coordinates.** Expect them counted as "skipped,
   no location", never matched. Covered by a Task 5 `toContact` test.
5. **A label with a comma or over 60 chars, or a results board not in the configured
   workspaces.** Expect 400 with a message and nothing enqueued. Covered by Task 6 confirm
   validation tests.

---

### Task 1: Scaffold the Worker and register it with the repo checks

**Files:**
- Create: `nearby-search/package.json`, `tsconfig.json`, `vitest.config.ts`, `wrangler.jsonc`,
  `migrations/0001_init.sql`, `config/svbc.json`, `config/sandbox.json`, `config/split.test.ts`,
  `src/index.ts`, `src/index.test.ts`, `src/config.ts`, `src/config.test.ts`, `src/types.ts`,
  `src/environment.ts` (copy), `src/environment.test.ts` (copy from report-digests),
  `src/flags.ts` (copy), `src/monday/graphql.ts` (copy), `src/geometry.ts` (copy),
  `README.md`.
- Modify:
  - `.gitlab-ci.yml`: add a `nearby-search` `.worker_job` and a `deploy-sandbox:nearby-search`
    job, mirroring `report-digests`.
  - `.gitlab-ci.yml`: add `nearby-search/src/monday/graphql.ts` to `monday-graphql-copies`.
  - `.gitlab-ci.yml`: new job `geo-geometry-copies` (below).
  - `scripts/check-worker-flags.mjs`: add `'nearby-search'` to the Worker list.
  - `scripts/check-monday-auth-bindings.mjs`: add `'nearby-search': 'SyncToken'` to `EXPECTED`.
  - `CLAUDE.md`: add `nearby-search` to the sandbox-environment list and the graphql-copies list.
  - root `README.md`: add a row to the "Status at a glance" table (status: in development).
  - `docs/systems-map.html`: add a row and bump its "as of" date.

**Interfaces:**
- Produces:
  - `type ContactKind = 'person' | 'historical' | 'organization'`
  - `interface SourceBoard { kind: ContactKind; boardId: number; latColumn: string; lngColumn: string; nameColumn: string | null; nearbyColumn: string | null; address: { street: string; city: string; state: string; zip: string } | null }`
    (`nearbyColumn` is null for organizations; `address` is null for a board the geocode cron
    should skip)
  - `interface Config { monday: { apiUrl: string; sources: SourceBoard[]; resultsWorkspaceIds: number[]; eventsBoardId: number; eventsAddressColumn: string }; osm: { nominatimUrl: string; overpassUrl: string; userAgent: string }; serviceArea: [number, number, number, number]; access: { teamDomain: string; aud: string }; geocode: { censusUrl: string; perRun: number } }`
  - `validateConfig(raw: unknown): Config`
  - `configFor(env): Config` (via `createConfigSelector`)
  - `interface Env { DB: D1Database; WRITES: Queue<WriteMessage>; FLAGS: KVNamespace; MONDAY_AUTH: Fetcher; REQUEST_RATE_LIMITER: RateLimit; ENVIRONMENT?: string }`
- Wrangler shape:
  - Name `svbc-nearby-search`, D1 `svbc-nearby-search`.
  - Queue `nearby-search-writes` (`max_retries: 100`, `max_batch_size: 10`, DLQ
    `nearby-search-writes-dlq`).
  - Cron `"17 * * * *"`, `FLAGS` KV (same ids as report-digests).
  - Rate limiter: next free `namespace_id` pair after the highest in the repo (grep), 60/60 s.
  - `limits.cpu_ms: 2000`.
  - The `env.sandbox` mirror uses the `-sandbox` suffixed names and the sandbox broker.
- D1 `0001_init.sql`:
  ```sql
  CREATE TABLE result_rows (board_id TEXT NOT NULL, contact_id TEXT NOT NULL, result_item_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (board_id, contact_id));
  CREATE TABLE searches (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL, label TEXT NOT NULL, query TEXT NOT NULL, miles REAL NOT NULL, matched INTEGER NOT NULL, queued INTEGER NOT NULL, confirmed_by TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE geocode_misses (item_id TEXT PRIMARY KEY, address_hash TEXT NOT NULL, attempted_at TEXT NOT NULL);
  ```

- [ ] **Step 1:** Copy the four shared files byte-for-byte. Copy `environment.test.ts` from
  report-digests.
- [ ] **Step 2: Write failing tests.**
  - `config.test.ts`:
    - `validateConfig` rejects a `REPLACE_WITH_COLUMN_ID` column.
    - It rejects a `serviceArea` whose south ≥ north.
    - It rejects `sources` missing any of the three kinds.
    - It accepts `nearbyColumn: null` only for `organization`.
  - `split.test.ts`, mirroring `member-portal/config/split.test.ts`:
    - Every `sources[].boardId`, `eventsBoardId`, and `resultsWorkspaceIds` value differs
      between the two configs (latent while either side is `null`).
    - `access.aud` differs.
  - `index.test.ts`: `GET /health` returns 200 `ok` without an Access header.
- [ ] **Step 3:** Run `cd nearby-search && npm test`. Expect FAIL (modules missing).
- [ ] **Step 4:** Implement `config.ts`, `types.ts`, `index.ts` (a Hono app with
  `/health` only, plus `queue` and `scheduled` handlers that throw "not implemented" for now),
  `wrangler.jsonc`, the migration, and both config JSONs.
  - Production ids are `null`/placeholder.
  - Sandbox ids come from the sandbox boards in `salesforce-import/data/load/boards.json` where
    present.
- [ ] **Step 5:** Run these and expect all to pass:
  - `npm test && npm run typecheck`
  - `node scripts/check-worker-flags.mjs --strict`
  - `node scripts/check-monday-auth-bindings.mjs`
- [ ] **Step 6:** Add the CI job:
  ```yaml
  geo-geometry-copies:
    stage: test
    rules:
      - changes: ["*/src/geometry.ts", .gitlab-ci.yml]
    script:
      - cmp geo-filter/src/geometry.ts nearby-search/src/geometry.ts
  ```
  Write `README.md`, covering:
  - what the Worker does;
  - the Access application setup (team domain, AUD tag into config);
  - `wrangler d1 migrations apply`;
  - `flags.mjs nearby-search writes on`;
  - the [GL#83](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/83) Historical caveat.
- [ ] **Step 7: Commit.** `feat(nearby-search): scaffold Worker, config, CI registration`

---

### Task 2: Cloudflare Access JWT check

**Files:**
- Create: `nearby-search/src/access.ts`, `src/access.test.ts`

**Interfaces:**
- Produces:
  - `verifyAccessJwt(token: string | null, cfg: Config['access'], fetchCerts?: () => Promise<JsonWebKey[]>, now?: number): Promise<{ email: string } | null>`
  - `requireAccess(): MiddlewareHandler`, which sets `c.set('staffEmail', email)` or returns 403.

- [ ] **Step 1: Write failing tests.** Generate an RS256 key pair in the test with
  `crypto.subtle`, sign tokens, and pass a `fetchCerts` returning the public JWK. Cases:
  - a valid token returns its `email`;
  - the wrong `aud` returns null;
  - `iss` ≠ `https://${teamDomain}` returns null;
  - `exp` in the past returns null;
  - a `kid` not in certs returns null;
  - a null token returns null;
  - the middleware returns 403 on null.
- [ ] **Step 2:** Run `npm test -- src/access.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
  - Certs come from `https://${teamDomain}/cdn-cgi/access/certs` (the `keys` array), cached in
    module scope for 1 h.
  - Verify with `crypto.subtle.importKey('jwk', …, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' })`
    plus `verify`.
  - `aud` may be a string or an array.
  - No dependency.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5: Commit.** `feat(nearby-search): verify Cloudflare Access JWT`

---

### Task 3: Parse pasted text into a location query

**Files:**
- Create: `nearby-search/src/locate/parse.ts`, `src/locate/parse.test.ts`

**Interfaces:**
- Produces:
  - `type LocationQuery = { kind: 'address'; text: string } | { kind: 'place'; text: string } | { kind: 'intersection'; a: string; b: string } | { kind: 'segment'; road: string; from: string; to: string }`
  - `parseLocationText(text: string): LocationQuery | { kind: 'empty' }`
  - `expandStreetName(name: string): string`

- [ ] **Step 1: Write failing tests** (table-driven):
  - `"Stevens Creek Blvd between Saratoga Ave and Winchester Blvd"` →
    `{ kind:'segment', road:'Stevens Creek Boulevard', from:'Saratoga Avenue', to:'Winchester Boulevard' }`
  - `"Stevens Creek Blvd. from Saratoga Ave. to Winchester Blvd."` → the same.
  - `"on Stevens Creek Boulevard, between Saratoga Avenue & Winchester Boulevard"` → the same.
  - `"Bascom Ave & Hamilton Ave"`, `"Bascom Ave and Hamilton Ave"`, `"Bascom Ave at Hamilton Ave"`,
    `"Bascom Ave / Hamilton Ave"`, `"the intersection of Bascom Ave and Hamilton Ave"` →
    `{ kind:'intersection', a:'Bascom Avenue', b:'Hamilton Avenue' }`.
  - `"600 E Meadow Dr, Palo Alto, CA 94306"` → `{ kind:'address', text: <unchanged> }`
    (anything starting with a house number).
  - `"Diridon Station"` → `{ kind:'place', text:'Diridon Station' }`.
  - `"   "` → `{ kind:'empty' }`.
  - Abbreviations: `expandStreetName` maps `St Ave Blvd Rd Dr Ln Ct Pl Pkwy Expy Hwy Way Ter Cir`
    (with or without `.`, any case) to the full word, but only as the last token.
    - `"St James St"` → `"St James Street"`.
    - `"E Meadow Dr"` → `"East Meadow Drive"`: leading `N/S/E/W` expands to a compass word.
- [ ] **Step 2:** Run `npm test -- src/locate/parse.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.** Use regexes in this order: segment (`between…and|&`,
  `from…to`), then intersection (`&`, ` and `, ` at `, `/`), then address
  (`^\d`), else place. Strip leading `on `, `the intersection of `, and trailing punctuation.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5: Commit.** `feat(nearby-search): parse notice text into a location query`

---

### Task 4: Resolve a query to a point or line with OpenStreetMap

**Files:**
- Create: `nearby-search/src/locate/osm.ts`, `src/locate/resolve.ts`,
  `src/locate/resolve.test.ts`, `src/locate/fixtures/*.json` (trimmed real Overpass responses for
  Stevens Creek Blvd and Bascom/Hamilton, saved once by hand)

**Interfaces:**
- Consumes: `LocationQuery` (Task 3), `Config['osm']`, `Config['serviceArea']`.
- Produces:
  - `interface OsmClient { nominatim(q: string): Promise<NominatimHit[]>; overpass(ql: string): Promise<OverpassResponse> }`
  - `createOsmClient(cfg: Config['osm'], cache?: Cache): OsmClient`. It sends the User-Agent,
    caches by URL+body for 24 h, and throws `OsmError` on non-2xx.
  - `type Resolved = { kind: 'point'; lat: number; lng: number; label: string } | { kind: 'line'; geometry: GeoJSON.LineString; label: string; lengthMiles: number } | { kind: 'not-found'; message: string }`
  - `resolveLocation(q: LocationQuery, osm: OsmClient, area: [number, number, number, number]): Promise<Resolved>`

Resolution rules:
- **address / place:** Nominatim `format=jsonv2&limit=1&countrycodes=us&bounded=1&viewbox=west,north,east,south`.
  - `label` = `display_name`.
  - No hit → `not-found: "OpenStreetMap couldn't find '<text>' in Santa Clara or San Mateo County."`
- **intersection:** one Overpass query in the bbox.
  - Fetch `way["highway"]["name"~"^<a>$",i]` and the same for `<b>`, then `node(w.a)(w.b); out;`.
  - First node → point; `label` = `"<a> & <b>"`.
  - None → `not-found: "<a> and <b> don't meet in OpenStreetMap."`
- **segment:** one Overpass query returning `way["highway"]["name"~"^<road>$",i]` with
  `out geom;` plus the crossing nodes for `<from>` and `<to>`, as in the intersection query.
  - A crossing is missing → `not-found` naming that cross street, e.g.
    `"Saratoga Avenue doesn't cross Stevens Creek Boulevard in OpenStreetMap."`
  - Path algorithm, which the test can't pin down:
    - Build an undirected graph from consecutive node pairs of every road way, ignoring
      `oneway`. Edge weight is the haversine distance.
    - Run Dijkstra from each `from` crossing node to each `to` crossing node, and keep the
      shortest.
    - No path → `not-found: "Couldn't follow <road> from <from> to <to>."`
  - `label` = `"<road> from <from> to <to>"`.
- Overpass regex names are escaped (`[.*+?^${}()|[\]\\]`).

- [ ] **Step 1: Write failing tests** with a fake `OsmClient` returning fixtures:
  - The segment fixture returns a LineString whose first and last coordinates equal the two
    crossing nodes. `lengthMiles` is within 5% of the hand-measured value recorded in the fixture
    file's `_note`.
  - The divided-carriageway fixture (two parallel one-way ways) still returns a line.
  - A segment with a missing `from` crossing returns a `not-found` message containing the
    cross-street name.
  - An intersection fixture returns a point equal to the shared node.
  - Nominatim with an empty array returns `not-found`.
  - `createOsmClient` sends the configured User-Agent and serves a second identical request
    from the cache (fake `Cache`).
- [ ] **Step 2:** Run `npm test -- src/locate`. Expect FAIL.
- [ ] **Step 3:** Implement `osm.ts` and `resolve.ts`.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5: Commit.** `feat(nearby-search): resolve locations through Nominatim and Overpass`

---

### Task 5: Monday reads

**Files:**
- Create: `nearby-search/src/monday/client.ts`, `src/monday/client.test.ts`

**Interfaces:**
- Consumes: `MondayGraphQL`/`tokenProviderFor` from `graphql.ts`, `SourceBoard`, and
  `Contact`/`filterContacts` from `geometry.ts`.
- Produces:
  - `interface SourcedContact extends Contact { kind: ContactKind }`
  - `toContact(raw: { id: string; name: string; column_values: { id: string; text: string | null }[] }, src: SourceBoard): SourcedContact`
    - `lat`/`lng` become null when blank, non-finite, or both 0.
    - `zip` is null.
    - `name` is the `nameColumn` text when set and non-blank, else the item name.
  - `interface NearbyMondayClient {`
    - `listContacts(src: SourceBoard): Promise<SourcedContact[]>`: `items_page` with a cursor,
      500 per page.
    - `listBoards(workspaceIds: number[]): Promise<{ id: string; name: string }[]>`: active
      boards only, sorted by name.
    - `getEventAddress(eventsBoardId: number, itemId: string, column: string): Promise<{ name: string; address: string } | null>`
    - `linkedContactIds(boardId: number, connectColumnId: string): Promise<Set<string>>`
    - `findResultColumns(boardId: number): Promise<{ connectColumnId: string; labelColumnId: string } | null>`:
      read-only lookup by the two titles below; null if either is missing. Confirm uses this, so
      a confirm never writes to Monday.
    - `ensureResultColumns(boardId: number, sourceBoardIds: number[]): Promise<{ connectColumnId: string; labelColumnId: string }>`:
      used only by the consumer. Finds the columns by title `"Nearby contact"` (`board_relation`) and `"Nearby search"`
      (`text`), creating them if missing (`create_column` with
      `defaults: JSON.stringify({ boardIds })`; confirm the defaults key against the current API
      docs before relying on it).
    - `createResultRow(boardId: number, name: string, cols: { connectColumnId: string; labelColumnId: string }, contactId: string, label: string): Promise<string>`
    - `addNearbyLabel(itemId: string, boardId: number, columnId: string, label: string): Promise<void>`:
      reads the dropdown text, splits on `", "`, and if the label is absent writes
      `{ labels: [...existing, label] }` with `create_labels_if_missing: true`.
  - `}`
  - `HttpNearbyMondayClient`, with transport options `{ maxAttempts: 3, requestTimeoutMs: 30_000 }`.

- [ ] **Step 1: Write failing tests** (stubbed `fetch`, as in `geo-filter/src/monday.test.ts`):
  - `toContact` with `"0"`/`"0"` gives null coordinates.
  - `toContact` with `""` or `"abc"` gives null coordinates.
  - `toContact` with `"37.33"`/`"-121.89"` gives numbers.
  - `listContacts` follows `cursor` across two pages.
  - `addNearbyLabel` sends no mutation when the label is already present.
  - `addNearbyLabel` sends `labels: ['Old', 'New']` when only `Old` is present.
  - `ensureResultColumns` creates nothing when both titles exist.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expect PASS.
- [ ] **Step 5: Commit.** `feat(nearby-search): Monday reads and result-row writes`

---

### Task 6: Preview and confirm API

**Files:**
- Create: `nearby-search/src/search.ts`, `src/search.test.ts`, `src/routes.ts`,
  `src/routes.test.ts`
- Modify: `src/index.ts` (mount routes behind `requireAccess()` and the rate limiter)

**Interfaces:**
- Consumes: Tasks 2–5, plus `readWriteMode`/`stampFor` from `flags.ts`.
- Produces:
  - `interface PreviewRequest { query?: string; eventItemId?: string; miles: number }`
    (exactly one of `query`/`eventItemId`)
  - `interface Preview { resolved: Resolved; miles: number; matches: { id: string; kind: ContactKind; name: string; lat: number; lng: number }[]; counts: Record<ContactKind, number>; skippedNoLocation: Record<ContactKind, number> }`
  - `runSearch(req: PreviewRequest, deps: { osm: OsmClient; monday: NearbyMondayClient; config: Config }): Promise<Preview>`.
    It maps `Resolved` to geo-filter's `FilterMode` (`radius` / `corridor`) and runs
    `filterContacts` for each source.
  - `interface WriteMessage { boardId: number; label: string; contactId: string; kind: ContactKind; name: string; stamp: WriteStamp }`
  - Routes:
    - `POST /api/preview` (body `PreviewRequest`) → `Preview`, or 422 `{ message }` for
      `not-found`.
    - `POST /api/confirm` (body `PreviewRequest & { boardId: number; label: string }`) →
      `{ queued: number; alreadyOnBoard: number; historical: number }`. It re-runs `runSearch`
      server-side (never trusts a client list), drops contacts in `linkedContactIds` (skipped
      when `findResultColumns` returns null) and in D1 `result_rows`, then sends `WriteMessage`s in `sendBatch` chunks of 100. It inserts a
      `searches` row with `confirmed_by` = Access email.
    - `GET /api/boards` → `listBoards(resultsWorkspaceIds)`.

- [ ] **Step 1: Write failing tests** (fake OSM and Monday clients, Miniflare D1/queue):
  - Preview of a point 1 mile from two people and 3 miles from one, at `miles: 2` → counts
    `person: 2`.
  - Preview with `not-found` → 422 with the message.
  - Validation returns 400, and the queue receives nothing, for:
    - `miles` 0 or 11;
    - `label` `"A, B"`;
    - `label` of 61 chars;
    - `boardId` not in `listBoards`.
  - Confirm twice with the same input → the second returns `queued: 0` (D1 dedupe).
  - Confirm when a contact is already linked on the board → `alreadyOnBoard: 1` and it isn't
    queued.
  - Confirm reports `historical` = number of `historical` matches queued.
  - Under write mode `off`, messages carry the `dropped` stamp. Under `hold`, they are still
    queued.
  - Any `/api/*` route without an Access token → 403.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement `search.ts` and `routes.ts`.
- [ ] **Step 4:** Run. Expect PASS.
- [ ] **Step 5: Commit.** `feat(nearby-search): preview and confirm API`

---

### Task 7: The page

**Files:**
- Create: `nearby-search/src/page.ts` (returns the HTML string), `src/page.test.ts`
- Modify: `src/routes.ts`. `GET /` serves the page. `GET /?event=<itemId>` prefills: the server
  embeds `{ eventItemId, eventName, address, miles: 2 }` as JSON in the page.

Page behavior:
- **Inputs:** a text box (or the prefilled event address, read-only, with the event name), miles
  (default 0.5, or 2 for an event), a board picker from `/api/boards`, and a label (default: the
  chosen board's name, with commas stripped and the text truncated to 60).
- **Preview** button → a Leaflet 1.9.4 map (unpkg, exact version), with:
  - OSM tiles and attribution;
  - the resolved point/line;
  - the search area drawn with `turf.buffer` (turf 7.2.0 from jsDelivr), so the client draws
    the same buffer the server used;
  - pins colored by kind;
  - `resolved.label` as a heading;
  - counts per kind and skipped counts.
- `not-found` shows its message, and nothing else.
- The **Confirm** button stays disabled until a preview succeeds and a board is chosen. Its text
  reads `Add 412 people and 9 organizations to "<board>"`. When there are Historical matches, it
  shows `"N of these are Historical and won't get the email yet."`
- After confirm: `"Queued N. Already on the board: M."` and a link to the board.
- Changing any input clears the preview, so the confirm always matches what was seen.

- [ ] **Step 1: Write failing tests.**
  - `GET /` (with Access) contains `leaflet@1.9.4` and the board-picker element.
  - `GET /?event=123` embeds the event address from the fake Monday client.
  - `GET /?event=999` (unknown) renders the page with an "event not found" notice instead of
    failing.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`. Expect PASS.
- [ ] **Step 5:** Check it by hand with `npm run dev:sandbox` and a test JWT bypass that exists only
  in `index.local.ts`, following `member-portal/src/index.local.ts`, and never deployed. Run
  "Stevens Creek Blvd between Saratoga Ave and Winchester Blvd" at 0.5 mi. The line should run
  along Stevens Creek between those streets, and the buffer should hug it. Take a screenshot for
  the MR.
- [ ] **Step 6:** Document in `README.md` how the Events board gets its "Find nearby" link to
  `/?event=<item id>`.
  - First try a Formula column, `CONCATENATE("https://<host>/?event=", {Item ID})`, and check that
    Monday renders it as a clickable link.
  - If it doesn't, document the fallback: staff open the page and pick the event.
  - Don't add a write to `eventbrite-sync` for this.
- [ ] **Step 7: Commit.** `feat(nearby-search): search page with map confirmation`

---

### Task 8: Queue consumer: write rows and labels

**Files:**
- Create: `nearby-search/src/consumer.ts`, `src/consumer.test.ts`
- Modify: `src/index.ts` (`queue` handler)

**Interfaces:**
- Consumes: `WriteMessage`, `NearbyMondayClient`, `messageDisposition`, `retryDelaySeconds`,
  `MondayApiError`.
- Produces: `handleBatch(batch: MessageBatch<WriteMessage>, deps: { monday: NearbyMondayClient; db: D1Database; config: Config; mode: WriteMode }): Promise<void>`

Per message:
1. `messageDisposition(mode, msg.stamp)`. If `retry`, retry with `retryDelaySeconds`. If
   `dry-run`, call `logSkip` and ack.
2. If a D1 `result_rows` row exists, ack.
3. Call `ensureResultColumns`, memoized per batch per board.
4. `createResultRow` → insert into `result_rows`.
5. If `kind !== 'organization'`, call `addNearbyLabel` on the contact's source board's
   `nearbyColumn`.
6. On `MondayApiError`: a 4xx other than 429 → log the item id and code only, then ack (terminal).
   Anything else → retry with `retryDelaySeconds(attempts, err.retryAfterSeconds)`.

- [ ] **Step 1: Write failing tests:**
  - A live message creates one row and one label.
  - An organization message creates a row and no label call.
  - Redelivery after success → no second `createResultRow`.
  - A `dropped` stamp → no Monday calls.
  - Mode `hold` → `retry` called.
  - A 429 with `retryAfterSeconds: 120` → retry delay ≥ 120.
  - A 400 → ack, no retry.
  - Two messages for the same board → `ensureResultColumns` called once.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expect PASS.
- [ ] **Step 5: Commit.** `feat(nearby-search): queue consumer writes result rows and Nearby labels`

---

### Task 9: Hourly geocode backfill

**Files:**
- Create: `nearby-search/src/geocode.ts`, `src/geocode.test.ts`
- Modify:
  - `src/monday/client.ts`: add `listMissingCoordinates(src: SourceBoard, limit: number): Promise<{ id: string; address: string }[]>`
    (an `items_page` rule: `latColumn` `is_empty`, `address.street` `is_not_empty`; the address
    is the four columns joined with `", "`), and
    `setCoordinates(src: SourceBoard, itemId: string, lat: number, lng: number): Promise<void>`.
  - `src/index.ts` (`scheduled` handler)

**Interfaces:**
- Produces:
  - `geocodeOne(address: string, censusUrl: string, fetcher?: typeof fetch): Promise<{ lat: number; lng: number } | null>`.
    It calls the Census `onelineaddress` endpoint with `benchmark=Public_AR_Current&format=json`
    and reads the first `addressMatches[].coordinates` (`x` = lng, `y` = lat).
  - `runGeocode(deps: { monday: NearbyMondayClient; db: D1Database; config: Config; mode: WriteMode }): Promise<{ geocoded: number; missed: number; skipped: number }>`
- Rules:
  - Process up to `geocode.perRun` (config, default 200) across the sources whose `address` is
    non-null.
  - Skip an item whose `geocode_misses.address_hash` equals the SHA-256 of its current address.
  - A miss upserts `geocode_misses`.
  - `runDisposition(mode)`:
    - `skip` → return all zero;
    - `dry-run` → geocode, log counts, and don't call `setCoordinates`.
  - Logs carry counts only, never addresses.

- [ ] **Step 1: Write failing tests:**
  - `geocodeOne` parses a saved Census response fixture.
  - `geocodeOne` returns null on an empty `addressMatches`.
  - A miss is recorded, and the same address is skipped next run.
  - A changed address (a different hash) is retried.
  - `off` → no `setCoordinates`.
  - `hold` → no Monday calls at all.
  - `perRun: 2` with 5 candidates → 2 processed.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expect PASS.
- [ ] **Step 5:** Note in `README.md` that each write changes a People column, so it triggers a
  `mailchimp-sync` outbound update (merge fields only, harmless). Note that the Organizations
  backfill finishes in roughly (org count ÷ 200) hours.
- [ ] **Step 6: Commit.** `feat(nearby-search): hourly geocode backfill for contacts without coordinates`

---

### Task 10: mailchimp-sync turns Nearby labels into tags

**Files:**
- Modify:
  - `mailchimp-sync/src/types.ts`: `MondayColumnsConfig.nearby: string | null`,
    `Config.mailchimp.nearbyTagPrefix: string`, `DonorRecord.nearby: string[]`.
  - `mailchimp-sync/src/config.ts`: validate both; the prefix must be non-empty.
  - `mailchimp-sync/src/monday/client.ts`: `getDonorById` reads `columns.nearby` when non-null
    and splits its text on `", "`.
  - `mailchimp-sync/src/consumer/mapDonor.ts`:
    - `buildTags` appends `prefix + label` for each `donor.nearby`.
    - The signature becomes `managedTags(config: Config, currentMemberTags: string[] = []): string[]`,
      which adds every `currentMemberTags` entry starting with the prefix.
  - `mailchimp-sync/src/mailchimp/client.ts`:
    `getMemberTagNames(email: string): Promise<string[]>`, via
    `GET /lists/{audience}/members/{hash}/tags?count=1000`; a 404 returns `[]`.
  - `mailchimp-sync/src/consumer/outbound.ts`: when `columns.nearby` is non-null, fetch
    `getMemberTagNames` before `updateMember` and pass it to `managedTags`.
  - `mailchimp-sync/config/svbc.json`, `config/sandbox.json`: `"nearby": null` (production) or
    the sandbox column id, and `"nearbyTagPrefix": "Near: "`.
  - `mailchimp-sync/README.md`: describe the Nearby tags and the People-only limit ([GL#83](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/83)).
  - Matching test files.

- [ ] **Step 1: Write failing tests:**
  - `buildTags` with `nearby: ['Stevens Creek bikeway']` includes `"Near: Stevens Creek bikeway"`.
  - `managedTags(config, ['Near: Old', 'VIP'])` includes `"Near: Old"` and not `"VIP"`.
  - In outbound, a member whose Monday Nearby column dropped `Old` sends `Near: Old` as
    `inactive`.
  - `nearby: null` config → `getMemberTagNames` is never called.
  - `config.test.ts` rejects an empty `nearbyTagPrefix`.
- [ ] **Step 2:** Run `cd mailchimp-sync && npm test`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test && npm run typecheck` and
  `node scripts/check-log-safety.mjs`. Expect PASS.
- [ ] **Step 5: Commit.** `feat(mailchimp-sync): sync the Nearby column as Mailchimp tags`

---

### Task 11: Sandbox rollout check

- [ ] **Step 1:** Run these in order:
  1. Create the Nearby dropdown columns on sandbox People and People (Historical).
  2. Fill in the sandbox config ids.
  3. Apply the D1 migration to the sandbox.
  4. Create the sandbox Access application and put its AUD in `config/sandbox.json`.
  5. `node scripts/flags.mjs nearby-search writes on --env sandbox`.
  6. `npm run deploy:sandbox` (nearby-search and mailchimp-sync).
- [ ] **Step 2:** Run the Stevens Creek search against a sandbox test board.
  - Confirm the row count on the board equals the preview's count.
  - Confirm a sandbox Mailchimp member has `Near: <label>`.
  - Re-run at 1 mile and confirm only new rows appear.
- [ ] **Step 3:** Record the results in the MR description, then commit any config ids:
  `chore(nearby-search): sandbox config`.
