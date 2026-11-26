# member-map

[Appendix A](../reference/member-map.md) lists this Worker's routes, crons, queues, storage and bindings.

`member-map` runs as the Cloudflare Worker `svbc-member-map` on `map.bikesiliconvalley.org` (sandbox: `svbc-member-map-sandbox` on `map.sandbox.bikesiliconvalley.org`). Both hostnames sit behind Cloudflare Access applications ("SVBC Member Map" and "SVBC Member Map (sandbox)"). It reaches Monday through the `monday-auth` broker's `ReadOnlyToken` entrypoint (the Read-only app) and never writes to Monday.

## What it does

It is a staff-only web map of SVBC members over OpenStreetMap. It shades the Census block groups where membership is thin (population gap, warm-lead gap, or bike lane density), outlines Equity Priority Communities, and shows members, warm leads and organizations as dots that link to their Monday items. Staff use it to pick places for membership drives, events and group rides. If it stops, the map shows stale data or none; no other system depends on it.

## Trigger and data flow

| Trigger | What it does |
|---|---|
| Cron `0 13 * * 2` (Mondays 13:00 UTC, production only; Cloudflare counts 1 as Sunday) | Runs a refresh |
| `POST /api/refresh` (the **Refresh now** button) | Queues a refresh. 202 when queued. 429 if the snapshot is under 10 minutes old or a refresh is already pending. |
| Queue `svbc-member-map-refresh` (`-sandbox`), consumed by the same Worker | Runs the queued refresh, batch size 1, no retries |
| `GET /api/snapshot` | Serves the snapshot from R2, `Cache-Control: private, no-store`. 503 until the first snapshot exists. |
| Any other path | Static page and reference data from `public/` |

Every request is rate limited (120 per minute per client), then must carry a valid Access JWT whose email ends in `@bikesiliconvalley.org`. The Worker checks the JWT itself as well as relying on Access.

A refresh:

1. Reads People, People (Historical) and Organizations through the Read-only token.
2. Geocodes people with an address but blank `Lat`/`Lng` through the Census batch geocoder. Results go into the D1 `geocodes` cache (keyed by item id and an address hash), never back to Monday. At most 5,000 lookups per run, in batches of 1,000, within an 8-minute budget. A `nomatch` is retried after 90 days.
3. Assigns each person to a block group (point in polygon) and counts residents, active members and warm leads per block group.
4. Writes `snapshot.json` to the private R2 bucket `svbc-member-map`.

A button refresh takes minutes, longer than an HTTP request can run, so the request only writes an R2 marker `refresh-pending.json` (conditional put, so only one of two simultaneous clicks wins) and sends a queue message. The consumer deletes the marker when it finishes, whether or not the refresh succeeded. A marker older than 20 minutes is ignored.

## Monday boards and columns

Board ids live in [`config/svbc.json`](../../../member-map/config/svbc.json) (production) and [`config/sandbox.json`](../../../member-map/config/sandbox.json). Read only.

| Board | Columns read |
|---|---|
| People, People (Historical) | `Address`, `City`, `Zip`, `Lat`, `Lng`, `Membership Status`, `Do Not Solicit`, item id and name |
| Organizations | `Lat`, `Lng`, item id and name. Organizations without coordinates are skipped, not geocoded. |

An **active member** has `Membership Status` = `Active`. Any other People item the map can place is a **warm lead** (`Lapsed`, or blank for a never-member).

## Secrets

The Worker has no Monday token; access comes from the `MONDAY_AUTH` service binding. The Access team domain and AUD tag are config values in `config/*.json`, not secrets.

| Name | Purpose | Issued by | Rotate |
|---|---|---|---|
| `ACCESS_DEV_BYPASS` | Local development only, in `.dev.vars`. Set to `1`, it skips the Access check for requests to `localhost`. | You, locally | Never deploy it. Never put it in `wrangler.jsonc` or a Worker secret. |

## Write switch

No write switch. The Worker never writes to Monday. Its only writes are to its own D1 cache and R2 bucket.

## Failure modes

| Symptom | Cause | What to do |
|---|---|---|
| Every request returns 403 | `access.teamDomain` or `access.aud` in config doesn't match the Access application, or the user's email isn't on `bikesiliconvalley.org`. A misconfigured check fails closed by design. | Compare `access.aud` with the Audience tag on the Access application's overview page in Zero Trust. Fix config and deploy. |
| Page says "No data yet" / `/api/snapshot` returns 503 | No snapshot in R2 yet (new environment, or the bucket was emptied). | Click **Refresh now**, or wait for Monday's cron. |
| **Refresh now** returns 429 | A snapshot is under 10 minutes old, or a refresh is pending. | Wait. A stuck marker expires after 20 minutes. |
| `member-map: refresh failed: <error name>` in logs, failed run in Cron Events or queue metrics | Monday read failed (auth, outage), Census geocoder failed, or the run hit a limit. Not retried. | Read the error name. For Monday auth errors, see the `monday-auth` chapter. Click **Refresh now** once fixed. |
| Header shows many people with no usable address | Geocode backlog over 5,000, Census `nomatch`, or the 8-minute budget ran out. | Several refreshes clear a backlog. Bad addresses need fixing on the People item. |
| Counts or shading look wrong after a column rename | Columns are found by bare title from config. | Update `columns.*` in config, or restore the title. |
| Bike miles differ from the older `svbc-bike-lanes` report | This build clips to legal county boundaries and counts each mile once. | Expected. See the README's "Reference data" section. |

## Operator scripts

| Script | When | Command |
|---|---|---|
| `build-reference.mjs` (with `acs.mjs`, `bike-classes.mjs`) | When the Census (ACS, TIGER) or MTC publish a new release. Downloads to `.cache/reference/` and rewrites `public/data/`; commit the result. Settings are in `config/reference.json`. | `cd member-map && npm run build:reference` |
| First snapshot in a new environment | After provisioning, signed in through Access | Click **Refresh now**, or run `fetch('/api/refresh', { method: 'POST' })` in the browser console |

## Changing it

- Key files: `src/index.ts` (routes, cron, queue consumer), `src/snapshot.ts` (refresh), `src/geocode.ts`, `src/assign.ts`, `src/score.ts`, `src/access.ts` (JWT check), `public/` (the page).
- `src/monday/graphql.ts` is a byte-identical copy of the canonical transport. See [Development](../05-development.md).
- Local development needs `.dev.vars` with `ACCESS_DEV_BYPASS=1` and a local fixture snapshot:
  ```sh
  npx wrangler r2 object put svbc-member-map/snapshot.json --file test/fixtures/snapshot.json --local
  npm run dev
  ```
  `npm run dev` passes `--infer-origin-from-routes=false` so the URL host stays `localhost` and the bypass applies.
- Tests: `npm test` (Vitest plus the reference-build script tests), `npm run typecheck`.
- Deploy: CI deploys the sandbox, then production, on merges to `main` that touch `member-map/` ([chapter 6](../06-ci-and-deploy.md#what-deploys-when)). By hand: `npm run deploy:sandbox`, `npm run deploy`.
- D1 migrations: `npx wrangler d1 migrations apply svbc-member-map --remote` (sandbox: `svbc-member-map-sandbox --remote --env sandbox`).
- Privacy: the map shows exact home addresses on purpose. The protections are Access, no `workers.dev` route, the Worker-side JWT check, and `no-store` on the snapshot. Keep all four. Logs must carry counts and error names only.

## Further reading

- [`member-map/README.md`](../../../member-map/README.md), especially [Cloudflare Access setup](../../../member-map/README.md#cloudflare-access-setup-prerequisite-operator-work) and [Privacy](../../../member-map/README.md#privacy)
- [Staff UAT script](../../../docs/uat/member-map.md)
- [Design](../../../docs/superpowers/specs/2026-11-02-member-map-design.md)
- [Accounts and access](../03-accounts-and-access.md) (Cloudflare Zero Trust), [Troubleshooting](../08-troubleshooting.md)
