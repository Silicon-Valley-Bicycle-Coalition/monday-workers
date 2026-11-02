# nearby-search

A staff-only page that finds **People, People (Historical) and Organizations near an address or a
road segment** and shows them on a map. Confirming a search queues the matches onto a results
board in Monday, so an organizer can work the list (and the Nearby column on each contact records
that it was matched). Design:
[`docs/superpowers/specs/2026-11-02-nearby-search-design.md`](../docs/superpowers/specs/2026-11-02-nearby-search-design.md).

**Status: scaffold.** This directory holds the config, D1 migration, Wrangler shape, `/health`
route and CI registration. The geocoder, the search, the map page and the write queue arrive in
the following tasks of the implementation plan.

## How it works

* Addresses and intersections resolve through OpenStreetMap (Nominatim and Overpass), limited to
  `serviceArea` in config and sent with an identifying `osm.userAgent`.
* Contacts come from the Lat/Lng columns on the source boards. An hourly cron (`17 * * * *`)
  geocodes a bounded batch (`geocode.perRun`) of contacts that have an address but no coordinates
  (US Census `onelineaddress`, `geocode.censusUrl`). One budget is shared across the sources in
  config order. An address Census cannot match is recorded in `geocode_misses` with a hash and is
  not retried until that address changes; a Census error or timeout is not a miss (the item is
  retried next hour, and three errors in a row end the run). `off` geocodes but writes nothing to
  Monday; `hold` skips the run.

### Geocode backfill side effects

* Each write changes the Lat and Lng columns on a People item, which triggers a `mailchimp-sync`
  outbound update for that contact. It carries merge fields only, so it is harmless.
* The Organizations backfill finishes in roughly (organization count / `geocode.perRun`) hours,
  200 per hour by default, then the cron has nothing left to do.
* Point and corridor matching is `src/geometry.ts`, a byte-identical copy of
  `geo-filter/src/geometry.ts` (CI job `geo-geometry-copies`). Edit geo-filter's, then copy it.
* Every route except `GET /health` will sit behind Cloudflare Access (planned).
* Monday access is the `monday-auth` broker's `SyncToken` entrypoint (`MONDAY_AUTH` service
  binding); the Worker holds no Monday token.

## "Find nearby" link on the Events board

The page opens prefilled from an Events row at `/?event=<item id>` (2 miles by default). To put a
link on each row without touching `eventbrite-sync`, add a **Formula** column to the Events board:

```
CONCATENATE("https://<host>/?event=", {Item ID})
```

Whether Monday renders that formula result as a clickable link is **unverified until tried on a
live board**. If it does not, the fallback is for staff to open the page directly
(`https://<host>/`), type the event's address, or paste the event row's item id into the URL.

## Config

`config/svbc.json` and `config/sandbox.json` (chosen by the `ENVIRONMENT` var) hold the board and
column ids. They ship with `null` / `REPLACE_WITH_*` placeholders, and `validateConfig` rejects a
placeholder, so a search fails loudly until every id is wired. Sandbox and production must use
different board ids and a different `access.aud` (`config/split.test.ts`).

## Cloudflare Access setup (planned)

1. In Cloudflare One, add a self-hosted Access application for the Worker's hostname with a policy
   that allows only SVBC staff.
2. Copy the team domain (`<team>.cloudflareaccess.com`) into `access.teamDomain`, and the
   application's **AUD tag** into `access.aud`. Each environment is its own Access application
   with its own AUD tag.
3. Exclude `/health` from the application (a Bypass policy for that path) if an uptime check needs it.

## Provisioning and deploy

```sh
cd nearby-search
npx wrangler d1 create svbc-nearby-search            # then paste database_id into wrangler.jsonc
npx wrangler queues create nearby-search-writes
npx wrangler queues create nearby-search-writes-dlq
npx wrangler d1 migrations apply svbc-nearby-search --remote
npm run deploy
```

Repeat with the `-sandbox` names and `--env sandbox` / `npm run deploy:sandbox` for the sandbox.

## Write switch (planned: the write path lands in a later task)

Every Monday write is gated on `nearby-search:writes` in the shared `FLAGS` KV namespace. A
missing key means `off`, so turn it on **before** deploying a build that should write:

```sh
node scripts/flags.mjs nearby-search writes on --env sandbox
```

## Known caveat: People (Historical) and Mailchimp (#83)

The Nearby column goes on People (Historical) as well as People, but `mailchimp-sync` watches the
People board only. Until it is extended
([#83](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/work_items/83)),
a Historical match gets its results-board row but no Mailchimp tag, so no email; the confirmation
step says so.

## Commands

```sh
npm test            # vitest run
npm run typecheck   # wrangler types && tsc --noEmit
npm run dev         # wrangler dev (npm run dev:sandbox for the sandbox config)
```
