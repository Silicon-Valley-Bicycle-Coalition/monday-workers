# geo-filter

[Appendix A](../reference/geo-filter.md) lists this Worker's routes, crons, queues, storage and bindings.

`geo-filter` is not a deployed Worker. It is a small Node.js command-line tool (TypeScript, run with `tsx`) that an operator runs on request for a campaign. It has no Cloudflare resources and no `monday-auth` binding: it reads Monday with a `MONDAY_API_TOKEN` from the operator's shell, and it never writes to Monday. Its output is a CSV file on the operator's machine.

## What it does

It answers "which contacts are near here?" for advocacy campaigns, for example everyone within a mile of El Camino Real or two miles of Diridon Station. It reads one Monday board and writes the matching contacts to a CSV. Nothing runs on a schedule, so nothing breaks if it isn't used. For staff self-service on a map, see [nearby-search](nearby-search.md), which shares this tool's geometry code.

## Trigger and data flow

Trigger: run by an operator. No cron, webhook, queue or storage.

1. Parse and validate flags (`src/args.ts`). Bad coordinates or negative distances are rejected rather than silently matching nothing.
2. Read every item on `--board` through the Monday API, finding the `Lat`, `Lng` and `Zip` columns by bare title (`src/monday.ts`).
3. Filter (`src/geometry.ts`) by one of three modes:
   - **`zip`** — exact match on the 5-digit ZIP. ZIP+4 values match their 5-digit prefix, and a ZIP that lost leading zeros (`2134`) matches `02134`. No coordinates needed.
   - **`radius`** — within N miles of one point.
   - **`corridor`** — within an N-mile buffer of a GeoJSON line or polygon.
4. Write `id,name,lat,lng,zip` to the output CSV (default `geo-filter-matches.csv`), and report how many contacts were skipped for missing coordinates (`radius` and `corridor` only). Cells starting with `=`, `+`, `-`, `@`, tab or CR get a leading `'` so spreadsheets don't run them as formulas.

## Monday boards and columns

There is no config file. The board is whatever `--board` names, usually People. Columns are read only:

| Column (default title) | Override flag | Used by |
|---|---|---|
| `Lat`, `Lng` | `--lat-column`, `--lng-column` | `radius`, `corridor` |
| `Zip` | `--zip-column` | `zip`, and the CSV |
| Item name | `--name-column <title>` (blank cells fall back to the item name) | The CSV |

`salesforce-import` filled `Lat`, `Lng` and `Zip` at migration. Contacts added since then have coordinates only if something else geocoded them (for example the `nearby-search` geocode cron, once it runs).

## Secrets

| Name | Purpose | Issued by | Rotate |
|---|---|---|---|
| `MONDAY_API_TOKEN` (operator shell) | Read the board | The operator's own personal Monday token, from `.env.production` or `.env.sandbox`. Never an integration user's token ([chapter 3](../03-accounts-and-access.md#mondaycom)). | With that user's token |

## Write switch

None. It is not a Worker, and it never writes to Monday.

## Failure modes

| Symptom | Cause | What to do |
|---|---|---|
| `geo-filter: --board <boardId> and --mode zip\|radius\|corridor are required` | Missing flag. | Add it. |
| Error naming a column | The board's column isn't titled `Lat`/`Lng`/`Zip`. | Pass `--lat-column`, `--lng-column` or `--zip-column`. |
| Many contacts skipped for missing coordinates | Contacts added after migration have no `Lat`/`Lng`. | Use `zip` mode, or geocode them first. |
| Corridor matches nothing | The GeoJSON is the wrong shape or coordinates are swapped. | `--geojson` takes a Geometry, Feature or FeatureCollection (first feature used). GeoJSON is `[lng, lat]`. Check it in geojson.io. |
| Monday 401 or 403 | Token missing, expired, or can't see a private board. | Use a token whose user can open the board. |

## Operator scripts

The tool itself is the script. Run from `geo-filter/`:

```sh
MONDAY_API_TOKEN=... npm run cli -- --board <boardId> --mode zip --zips 95113,95110

MONDAY_API_TOKEN=... npm run cli -- --board <boardId> --mode radius \
  --lat 37.3297 --lng -121.9027 --radius-miles 2

MONDAY_API_TOKEN=... npm run cli -- --board <boardId> --mode corridor \
  --geojson route.geojson --buffer-miles 1
```

Add `--out <file>.csv` to name the output. The CSV contains contact names and locations; store and share it accordingly.

**Getting a corridor.** The tool doesn't fetch geometry. For an existing route, query OpenStreetMap's Overpass API for the ways and save as GeoJSON. For a proposed project that isn't in OSM, trace it by hand in geojson.io.

## Changing it

- Key files: `src/cli.ts`, `src/args.ts` (flags), `src/geometry.ts` (zip, radius, corridor logic), `src/monday.ts` (board read), `src/csv.ts`.
- `src/geometry.ts` is the **canonical** copy. `nearby-search/src/geometry.ts` must stay byte-identical (CI step `geo-geometry-copies`): edit this one, then copy it over.
- `src/monday/graphql.ts` is a byte-identical copy of the shared transport; this CLI uses its defaults. `src/monday.ts` imports `bareTitle` from `scripts/lib/column-titles.mjs`. See [Development](../05-development.md).
- Tests: `npm test` (geometry and flag parsing need no network), `npm run typecheck` (a plain `tsc --noEmit`; there is no Wrangler config).
- No deploy.

## Further reading

- [`geo-filter/README.md`](../../../geo-filter/README.md)
- [nearby-search chapter](nearby-search.md)
- Root README, ["Status at a glance"](../../../README.md#status-at-a-glance), on why this is deliberately not a Worker
- [Development](../05-development.md)
