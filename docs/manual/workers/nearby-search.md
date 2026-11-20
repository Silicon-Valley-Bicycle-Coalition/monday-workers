# nearby-search

[Appendix A](../reference/nearby-search.md) lists this Worker's routes, crons, queues, storage and bindings.

`nearby-search` is configured as the Cloudflare Worker `svbc-nearby-search` (sandbox: `svbc-nearby-search-sandbox`). `wrangler.jsonc` declares no route or custom domain yet, and `workers_dev` is off; the page is meant to be served on a custom domain behind a Cloudflare Access application. No hostname has been assigned yet; add it here when one is. It reaches Monday through the `monday-auth` broker's `SyncToken` entrypoint (the Staff sync app). It is built but not deployed in either environment, and `config/svbc.json` and `config/sandbox.json` still hold `null` / `REPLACE_WITH_*` placeholders. See the root README's [Status at a glance](../../../README.md#status-at-a-glance).

## What it does

It is a staff-only map page that finds People, People (Historical) and Organizations near an address, intersection, or road segment (for example a stretch named in a city construction notice). Confirming a search adds one row per match to a results board in Monday and adds the search's label to each matched person's `Nearby` column, which `mailchimp-sync` turns into a Mailchimp tag. An hourly cron also fills in missing `Lat`/`Lng` on contacts. It replaces the Salesforce bike-lane GIS proximity lookups. If it stops, organizers can't run proximity searches, and new contacts stop getting coordinates.

## Trigger and data flow

| Trigger | Purpose |
|---|---|
| `GET /` | The page (Access required). `?event=<item id>` prefills from an Events row. |
| `POST /api/preview` | Resolve the location and list contacts within the distance. Never writes. |
| `GET /api/boards` | Board picker: main boards in `monday.resultsWorkspaceIds` only |
| `POST /api/confirm` | Re-run the search and queue writes |
| `GET /health` | Returns `ok`. The only route not behind Access. |
| Queue `nearby-search-writes` (+ `-dlq`) | Performs the Monday writes |
| Cron `17 * * * *` (production only) | Geocode backfill |

### A search

1. **Preview.** The typed text resolves through OpenStreetMap: Nominatim for addresses and places, Overpass for streets, limited to `serviceArea`, sent with `osm.userAgent`, and cached 24 hours. A trailing city ("…, San Jose") bounds the street lookup. A street pair whose crossings are more than 0.5 mi apart is refused with a request to name the city. Contacts come from `Lat`/`Lng` on the three source boards; each board's list is cached 5 minutes in the isolate and the Cache API.
2. **Confirm** with a results board and a label (1–60 characters, no commas). The Worker re-runs the search, drops contacts already on that board or already claimed in D1, and queues one message per contact. More than 9,000 is refused. Each confirm is logged in D1 `searches` (who, what, matched, queued).
3. **Consumer**, one message at a time: claims the contact in D1 `result_rows`, adds the label to the person's `Nearby` dropdown (`create_labels_if_missing`), then creates a results-board item named after the contact. Organizations get the row only. On first write to a board it creates the `Nearby contact` and `Nearby search` columns if missing.

### Geocode backfill

Hourly at :17, the Worker geocodes up to `geocode.perRun` contacts that have an address but no coordinates, through the Census `onelineaddress` geocoder, and writes `Lat`/`Lng` to Monday. A no-match is recorded in D1 `geocode_misses` with an address hash and is not retried until the address changes. Census 5xx, 408, 429 or timeouts retry next hour; three in a row end the run. Each write triggers a harmless `mailchimp-sync` merge-field update.

### D1 tables (`DB`)

| Table | Holds |
|---|---|
| `result_rows` | One claim per (board, contact). Stops duplicate rows. |
| `searches` | One row per confirm |
| `geocode_misses` | Addresses Census couldn't match |

## Monday boards and columns

Board and column ids live in [`config/svbc.json`](../../../nearby-search/config/svbc.json) (production) and [`config/sandbox.json`](../../../nearby-search/config/sandbox.json). `validateConfig` rejects placeholders, so the Worker fails loudly until they are filled.

| Board | Columns | Read or write |
|---|---|---|
| People, People (Historical) | `Lat`, `Lng`, name, address columns | Read; `Lat`/`Lng` written by the geocode cron |
| People, People (Historical) | `Nearby` (dropdown, same title on both boards) | Write (add label) |
| Organizations | `Lat`, `Lng`, name, address columns | Read; `Lat`/`Lng` written by the geocode cron |
| Events | Address column | Read, for `?event=` |
| Results boards (any main board in the results workspace) | `Nearby contact` (connect-boards to all three source boards), `Nearby search` (text) | Write: created by the Worker, then one item per match |

Don't rename `Nearby contact` or `Nearby search`; the consumer finds them by title and type. Keep the `Nearby` title identical on both People boards, because `people-reclassification` maps columns by title when it moves people.

## Secrets

The Worker has no secrets. Monday access comes from the `MONDAY_AUTH` service binding. The Access team domain and AUD tag are config values (`access.teamDomain`, `access.aud`), different per environment. See [Accounts and access](../03-accounts-and-access.md).

## Write switch

Key `nearby-search:writes`. See [Operations](../07-operations.md). Set it to `on` before deploying a build that should write.

| | `on` | `hold` / `unknown` | `off` |
|---|---|---|---|
| Preview | Never writes | Never writes | Never writes |
| Confirm | Queues | Queues; the page says rows will appear when writes resume | Queues messages stamped `dropped`; the page says nothing will be added |
| Consumer | Writes | Retries with backoff until the switch changes | Logs a dry run and acks |
| Geocode cron | Writes `Lat`/`Lng` | Skips the hour | Geocodes and records misses, writes nothing to Monday |

## Failure modes

| Symptom | Cause | What to do |
|---|---|---|
| Every request (except `/health`) returns 403 | `access.aud` or `access.teamDomain` doesn't match the Access application. | Copy the AUD tag from the Access application into config and deploy. |
| Search returns "can't find" or asks for a city | OSM couldn't resolve the text, or the street pair crosses in two cities. | Add the city. Check `serviceArea` covers the area. |
| Organization searches return nothing | Organizations have no `Lat`/`Lng` yet. | Wait for the backfill (about organization count / `geocode.perRun` hours), or check the source's `address` block in config isn't `null`. |
| Messages in `nearby-search-writes-dlq` | A write kept failing for ~4 days. The DLQ consumer logs board and contact ids and releases the claim. | Fix the cause, then confirm the same search again on the same board. Only contacts not already there are queued. |
| A contact silently missing from a results board | Monday rejected the write outright (deleted contact, bad value); the message was dropped and the claim released. | Check the contact still exists. Re-confirm. |
| Confirm refused for size | Over 9,000 matches. | Narrow the distance. |
| Geocode cron invocation fails | A Monday error other than an item-level rejection stopped the run. | Read the summary log line (counts by failure class). Monday auth or outage: it retries next hour. |
| A Historical match gets a row and label but no Mailchimp tag | `mailchimp-sync`'s webhook on People (Historical) isn't registered. | See the `mailchimp-sync` chapter. |
| Nearby labels and tags pile up after events | Nothing clears them automatically. | Remove the label in Monday (on items or in column settings); `mailchimp-sync` sets the `Near: …` tag inactive. |

## Operator scripts

None in this directory. Writes are controlled with `node scripts/flags.mjs nearby-search writes on|hold|off --env sandbox|production`.

For a "Find nearby" link on each Events row, add a Formula column to the Events board: `CONCATENATE("https://<host>/?event=", {Item ID})`.

## Changing it

- Key files: `src/routes.ts` (HTTP), `src/search.ts`, `src/locate/` (OSM resolution), `src/consumer.ts` (queue writes and claims), `src/geocode.ts` (cron), `src/access.ts`, `src/page.ts` (the page).
- Copied files: `src/geometry.ts` is a byte-identical copy of `geo-filter/src/geometry.ts` (CI step `geo-geometry-copies`); edit geo-filter's, then copy. `src/flags.ts`, `src/environment.ts` and `src/monday/graphql.ts` are copies too. See [Development](../05-development.md).
- `POST /api/*` requires `application/json` (else 415) and, when the browser sends `Sec-Fetch-Site`, `same-origin` (else 403). Leaflet and turf load from pinned CDN URLs with SRI hashes; update the hash with the version.
- In the Access application, set the cookie's SameSite to Lax or Strict, and add a Bypass policy for `/health` if an uptime check needs it.
- Provisioning (repeat with `-sandbox` names and `--env sandbox`):
  ```sh
  npx wrangler d1 create svbc-nearby-search
  npx wrangler queues create nearby-search-writes
  npx wrangler queues create nearby-search-writes-dlq
  npx wrangler d1 migrations apply svbc-nearby-search --remote
  ```
- Tests: `npm test`, `npm run typecheck`. Deploy: `npm run deploy`, `npm run deploy:sandbox`.
- Before production, work through the README's sandbox checklist (connect column across three boards, Formula link, `create_labels_if_missing`, reclassification moves, SRI, SameSite, cache).

## Further reading

- [`nearby-search/README.md`](../../../nearby-search/README.md), especially [Verify during sandbox rollout](../../../nearby-search/README.md#verify-during-sandbox-rollout)
- [Design](../../../docs/superpowers/specs/2026-11-02-nearby-search-design.md)
- [geo-filter chapter](geo-filter.md) (shares `geometry.ts`)
- [Operations](../07-operations.md), [Troubleshooting](../08-troubleshooting.md)
