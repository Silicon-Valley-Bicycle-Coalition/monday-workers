# geo-filter

A one-off "contacts near a point or corridor" advocacy geography filter — **not a Worker**, run
on request per campaign. Generalizes `migration-plan.md`'s Bike-lane GIS proximity design
(originally scoped for bike-route campaigns) into a general utility per its own Unique
Advocacy-Specific Needs section and [GitLab #24](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-migration/-/issues/24)
— "people who live within 1 mile of El Camino Real" or "2 mile radius from Diridon Station" are
just as real an ask as a specific bike route.

See `monday-workers/README.md` for why this deliberately isn't a Cloudflare Worker.

## Three modes

- **`zip`** — exact zip-code match, on the 5-digit ZIP (a ZIP+4 like `95113-1234`, on the board
  or on the command line, matches `95113`). No geometry involved: the geocoding backfill in
  `salesforce-import` already writes Zip directly onto every Donors item.
- **`radius`** — an N-mile radius around a single point (e.g. a transit station, a project's
  center point).
- **`corridor`** — an N-mile buffer around an arbitrary line or polygon: a bike route, a street
  corridor, or any other GeoJSON geometry.

## Usage

```sh
MONDAY_API_TOKEN=... npm run cli -- --board <boardId> --mode zip --zips 95113,95110

MONDAY_API_TOKEN=... npm run cli -- --board <boardId> --mode radius \
  --lat 37.3297 --lng -121.9027 --radius-miles 2

MONDAY_API_TOKEN=... npm run cli -- --board <boardId> --mode corridor \
  --geojson route.geojson --buffer-miles 1
```

`--lat`/`--lng` must be valid coordinates (-90..90 / -180..180) and the mile distances
non-negative numbers; anything else is rejected with an error rather than silently matching
nothing.

Common flags: `--out matches.csv` (default `geo-filter-matches.csv`), and
`--lat-column`/`--lng-column`/`--zip-column` if the target board's columns aren't titled
`Lat`/`Lng`/`Zip` (`salesforce-import`'s defaults). The CSV's `name` is each item's own name
unless `--name-column <title>` points at a different column (e.g. a full-name text column); a
blank cell there falls back to the item name.

Writes a CSV of matched contacts (`id,name,lat,lng,zip`) — any text cell starting with `=`, `+`,
`-`, `@`, tab, or CR gets a leading `'` so a spreadsheet won't run it as a formula — and reports how many contacts were
skipped for missing coordinates (`radius`/`corridor` only — `zip` mode never needs coordinates).

## Getting a corridor's geometry

This tool takes GeoJSON as input; it doesn't fetch it. Two sources, per the original design:

1. **An existing, already-mapped route** — query OpenStreetMap's
   [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API) for the relevant
   `highway=cycleway` (or similar) ways by bounding box, save the result as GeoJSON.
2. **A proposed or not-yet-built project** — its geometry usually only exists on the city's own
   project page (the original Benton Street Bikeway Study case: still in design, not in OSM).
   Digitize it by hand (e.g. trace it in [geojson.io](https://geojson.io)) and save as GeoJSON.

`--geojson` accepts a bare `Geometry`, a `Feature`, or a `FeatureCollection` (the first feature's
geometry is used) — whatever shape either source hands back.

## Development

```sh
npm install
npm test        # vitest — the geometry logic (src/geometry.ts) and flag parsing
                 # (src/args.ts) are unit-tested, no Monday API or network needed
npm run typecheck
```

`src/monday.ts` (the Monday-fetching half) only has stubbed-`fetch` tests for its column
resolution — it's a thin, direct mirror of the same `graphql()`/pagination pattern already proven
elsewhere in this monorepo (e.g. `salesforce-import/scripts/create-letter-settings-board.mjs`),
and needs a real board + token to exercise meaningfully.
