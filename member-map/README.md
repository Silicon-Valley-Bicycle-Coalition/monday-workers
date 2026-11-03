# member-map

A staff-only web map of SVBC members on an OpenStreetMap base. It shades the neighborhoods
(Census block groups) where SVBC is thin, outlines low-income ones, and puts members on the map at
their exact address, each linking to their Monday item. Design:
[`docs/superpowers/specs/2026-11-02-member-map-design.md`](../docs/superpowers/specs/2026-11-02-member-map-design.md).

It is for staff choosing places for membership drives, events and group rides. It is not public and
not for members. It reads Monday and **never writes it**.

Status: built, **not deployed**. Blocked on the Cloudflare Access setup below (Zero Trust
organization, Google Workspace identity provider, two Access applications), D1 and R2
provisioning, and production board ids in `config/svbc.json`.

## What staff see

One shading at a time (radio buttons):

* **Population gap** (default): few active members per 1,000 residents.
* **Warm-lead gap**: many people SVBC already knows who are not active members.
* **Bike lane density**: class-weighted bike lane miles per mile of road. Low is the gap end.
* **None**.

Layers that combine with any shading (checkboxes):

* **Equity Priority Communities** outline (on): MTC's low-income neighborhoods.
* **Members** (on): active members, one dot per person, popup links to the Monday item.
* **Warm leads** (off): lapsed members and people who were never members.
* **Organizations** (off): linked to their organization item.
* **Bike lanes** (off): the lines, by class.

Clicking a neighborhood shows its residents, members, warm leads (lapsed and never), median
household income, Equity Priority status and bike facility share. The header shows when the data
was last refreshed and how many people had no usable address.

Definitions: an **active member** is a People item with Membership Status `Active`. A **warm lead**
is any other People item the map can place (Lapsed or blank), read from both People boards. Do Not
Solicit people still count; their popup shows the flag. Block groups under `minPopulation`
(100 residents) are left unshaded so parks and industrial land don't read as gaps.

## How it fits together

```
weekly cron ─▶ Monday (ReadOnlyToken): People (live + historical), Organizations
            │   Address, City, Lat, Lng, Zip, Membership Status, Do Not Solicit, item ids
            ├─▶ blank Lat/Lng → Census batch geocoder (private cache; never written to Monday)
            ├─▶ assign each person to a block group (point-in-polygon)
            ├─▶ per block group: residents, active members, warm leads (lapsed / never)
            └─▶ snapshot (points + aggregates + "as of") ──▶ private R2 object

static reference data (built offline, committed as assets):
   block-group shapes (TIGER, simplified) + ACS population + ACS median income
   EPC tract outlines (MTC)      bike facilities by class (MTC + San Jose)
   per-block-group road miles (TIGER, no freeways) + weighted bike lane miles

browser (behind Access) ─▶ Worker ─▶ static page + Leaflet + reference layers
                                  └─▶ /api/snapshot  (private, no-store)
```

Routes (every one sits behind Access **and** a Worker-side check of the Access JWT):

* `GET /api/snapshot`: the weekly snapshot from R2, `Cache-Control: private, no-store`. 503 until
  the first snapshot exists.
* `POST /api/refresh`: starts a refresh now. 202 on start, 429 if the snapshot is under 10 minutes
  old.
* Everything else: the static page and reference data in `public/`.

The cron is `0 13 * * 1` (Mondays 13:00 UTC). Monday access goes through the `monday-auth`
broker's Read-only app (`MONDAY_AUTH` service binding, `ReadOnlyToken`); the Worker holds no
Monday token. It has no queue and no write switch, because it never writes to Monday.

## Config

`config/svbc.json` (production) and `config/sandbox.json`, chosen by `env.ENVIRONMENT` and
validated at startup (`src/config.ts`). `config/split.test.ts` fails if the two share a board id.

| Key | Meaning |
|---|---|
| `monday.apiUrl`, `monday.accountUrl` | Monday API and the account URL used to build item links |
| `boards.peopleLive`, `peopleHistorical`, `organizations` | Board ids. The sandbox file holds the CRM Sandbox ids; `svbc.json` holds `0` placeholders until production ids exist |
| `columns.*` | Column titles (address, city, zip, lat, lng, membership status, do not solicit). Matched with `bareTitle`, so the 🔒/📜 markers don't matter |
| `activeLabel` | Membership Status label that counts as an active member (`Active`) |
| `geocoder.*` | Census batch geocoder URL, benchmark, default state, `batchSize` (1,000), `maxPerRun` (5,000), `retryNoMatchDays` (90) |
| `access.teamDomain`, `access.aud`, `access.allowedEmailDomain` | Cloudflare Access values for the JWT check (below) |

Reference-build settings (counties, ACS/TIGER year, road classes, bike class weights) live in
`config/reference.json`. Class weights: I = 1, IV = 1, II = 0.5, III = 0.2.

## Cloudflare Access setup (prerequisite, operator work)

There is no Access setup today. Do this before any staff testing.

1. Create the Cloudflare Zero Trust organization (team domain) on SVBC's account.
2. Add **Google Workspace** as the identity provider, restricted to `@bikesiliconvalley.org`.
   *(Assumed: SVBC staff sign in with Google Workspace. Use whichever provider staff actually
   use.)*
3. Create two Access applications, one for the production hostname and one for the sandbox
   hostname, each with an Allow policy for emails ending in `@bikesiliconvalley.org`.
4. Put each application's **team domain and AUD** into the Worker's config (production and
   sandbox) for the JWT check.

For step 4: set `access.teamDomain` (for example `https://svbc.cloudflareaccess.com`) and
`access.aud` (the application's Audience tag, shown on its overview page) in `config/svbc.json`
for the production application and in `config/sandbox.json` for the sandbox one. **Until both are
set, every request gets a 403**, which is deliberate: a misconfigured route never serves
addresses. `workers_dev` is `false`, so the only way in is the custom domain, which the Access
application covers.

Hostnames are in `wrangler.jsonc`: `map.bikesiliconvalley.org` and
`map.sandbox.bikesiliconvalley.org`. Forks: change them, `account_id`, and the Access values.

## Provisioning

Nothing here runs against Cloudflare until an operator does it. Production commands drop the
`-sandbox` suffix and `--env sandbox`.

```sh
cd member-map
npx wrangler d1 create svbc-member-map-sandbox        # put the id in wrangler.jsonc env.sandbox
npx wrangler d1 migrations apply svbc-member-map-sandbox --remote --env sandbox
npx wrangler r2 bucket create svbc-member-map-sandbox
npm run deploy:sandbox
```

Then, signed in through Access in a browser on `map.sandbox.bikesiliconvalley.org`, trigger the
first snapshot with the **Refresh now** button on the page's "No data yet" screen, or with
`POST /api/refresh` (for example from the browser console:
`fetch('/api/refresh', { method: 'POST' })`). Without it the page shows no data until the weekly
cron fires (Mondays). Production needs the real board ids in `config/svbc.json` first.

## Local development

```sh
cd member-map
npm install
echo 'ACCESS_DEV_BYPASS=1' > .dev.vars     # git-ignored
npx wrangler r2 object put svbc-member-map/snapshot.json --file test/fixtures/snapshot.json --local
npm run dev
```

`ACCESS_DEV_BYPASS=1` skips the Access check **only for requests whose URL host is localhost**.
`npm run dev` passes `--infer-origin-from-routes=false` so `request.url` stays `localhost` instead
of the route's hostname. Never put `ACCESS_DEV_BYPASS` in `wrangler.jsonc` or a deployed secret.
Plain `npm run dev` is the production config; use `npm run dev:sandbox` for the sandbox one.

```sh
npm test            # vitest run, plus the reference-build script tests
npm run typecheck   # wrangler types --include-runtime=false && tsc --noEmit
```

## Geocoding

Lat/Lng on People and Organizations were filled once by `salesforce-import`, so anyone added since
cutover has an address but no coordinates. Each run geocodes those itself, **privately**: nothing
is written back to Monday. Board Lat/Lng always wins when present.

* Service: the Census batch geocoder, the same one the migration used (no key, no new third party).
* Cache: D1 table `geocodes`, keyed by item id and a hash of the normalized address. An unchanged
  address is never re-sent; a changed one is looked up again.
* A failed match (`nomatch`) is retried after 90 days (`geocoder.retryNoMatchDays`), not weekly.
* At most 5,000 lookups per run (`maxPerRun`), in batches of 1,000 (`batchSize`). A large backlog
  clears over several weeks of runs or manual refreshes. A failed batch is not cached, so it is
  retried.

## Reference data

`public/data/` holds the block groups, Equity Priority outline and bike lanes, built offline and
committed (all public data). Sources and vintages are recorded in
`public/data/reference-meta.json`.

```sh
npm run build:reference     # downloads into member-map/.cache/reference/ (git-ignored), rewrites public/data/
```

Re-run it when the Census (ACS and TIGER, each autumn or winter) or MTC publish a new release, then
commit the result. Notes on the sources:

* **Population and income** come from the Census **summary-file tables** (B01003, B19013) rather
  than api.census.gov, which now requires a key.
* **Equity Priority Communities** are MTC's Plan Bay Area 2050+ set, from two layers: ACS 2018-2022
  (2020 tracts) and ACS 2014-2018 (2010 tracts, carried onto 2020 tracts). Block groups nest in
  tracts, so each block group takes its tract's status.
* **Roads** (the density denominator) are TIGER **MTFCC S1200 and S1400** only: ordinary streets.
  Freeways, ramps and driveways are out.
* **Bike lanes** are MTC's regional bike facilities, except inside San Jose, where **San Jose's own
  bikeways layer replaces MTC**. Segments are split at block-group edges so each mile counts once.

**Bike miles differ from `svbc-bike-lanes`.** Measured in the 2026-11-02 build, MTC miles inside
the two counties by class (I / II / III) are 171 / 602 / 347, against 229 / 764 / 439 in
`svbc-bike-lanes`' history (25% / 21% / 21% lower). That report sums whole features inside each
county's bounding box, which pulls in features from neighboring counties and counts the overlap
between the two boxes twice. This build clips to the legal county boundaries and counts each mile
once, so expect different totals. (With San Jose's own layer replacing MTC there, the in-county totals are 221 / 710 / 429 / 76 miles
for Class I / II / III / IV. Of that, 218 / 709 / 429 / 76 is credited to block groups; the rest
runs along the shoreline and county edge, where the block-group boundaries stop short of the
county boundary.)

## Privacy

* The map shows **exact home addresses** on purpose. The protection is Access: no `workers.dev`
  route, an Access policy limited to `@bikesiliconvalley.org`, a Worker-side JWT check on every
  request, and `Cache-Control: private, no-store` on the snapshot.
* The snapshot (names, locations, item ids) lives in a private R2 bucket and is served only through
  the Worker. It is not in the repo, and `test/fixtures/snapshot.json` is fake data.
* Logs carry counts and error names, never names, addresses or emails
  (`node ../scripts/check-log-safety.mjs`).
* Addresses leave Cloudflare only to the Census geocoder the migration already used.
* Every request is rate limited (120 per minute per client) before the Access check.
