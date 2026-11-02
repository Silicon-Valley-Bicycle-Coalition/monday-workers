# nearby-search

A staff-only page that finds **People, People (Historical) and Organizations near an address, an
intersection or a road segment** and shows them on a map. Confirming a search queues the matches
onto a results board in Monday, one row per contact, and adds the search's label to each matched
person's **Nearby** column, which `mailchimp-sync` turns into a Mailchimp tag. Design:
[`docs/superpowers/specs/2026-11-02-nearby-search-design.md`](../docs/superpowers/specs/2026-11-02-nearby-search-design.md).

**Status: built, not yet deployed. Sandbox rollout is pending** (D1/queues, the Access application,
real board and column ids in `config/sandbox.json`, the write switch, and the checklist under
[Verify during sandbox rollout](#verify-during-sandbox-rollout)).

## How a search works

1. **Preview** (`POST /api/preview`). The organizer types an address, a place, an intersection
   ("Bascom Ave & Hamilton Ave") or a segment pasted from a city notice ("Stevens Creek Blvd
   between Saratoga Ave and Winchester Blvd, San Jose") and a distance in miles. The text resolves
   through OpenStreetMap (Nominatim for addresses and places, Overpass for streets), limited to
   `serviceArea` and sent with an identifying `osm.userAgent`; every OSM answer is cached for 24
   hours. The page shows what it matched, labelled with OSM's own street names ("South Bascom
   Avenue & East Hamilton Avenue"), on a map with every contact within the distance. Preview never
   writes anything.
   * A trailing place on any part of the text ("…, San Jose", "… in Campbell") is taken as the
     city: it's looked up in Nominatim (`"<city>, CA"`) and its bounding box, clipped to the
     service area, bounds the street lookup.
   * A street pair whose crossings fall more than 0.5 mi apart (the same two names in two cities)
     is refused with a message asking for the city, never silently picked. Anything else that
     can't be found is a message saying what's missing.
   * Contacts come from the Lat/Lng columns on the source boards; a contact without coordinates
     is counted as skipped.
2. **Confirm** (`POST /api/confirm`), with a results board and a label (1-60 characters, no
   commas, since commas separate dropdown labels and tags). The Worker re-runs the search itself
   (the preview in the browser is only a picture), drops contacts already linked on that board or
   already recorded in D1, and queues one message per remaining contact. A search that would queue
   more than 9,000 is refused with a request to narrow the distance. Each confirm is recorded in
   the D1 `searches` table (who, what, how many matched and how many were actually sent).
3. **Queue consumer** writes, one message at a time:
   * for a person (People or People (Historical)), adds the label to the contact's Nearby
     dropdown column (`create_labels_if_missing`), then
   * creates a results-board item **named after the contact**, with the "Nearby contact" column
     linking the contact and the "Nearby search" column holding the label.

   Organizations get the row only, no label.

### Columns created on the results board

On the first write to a board, the consumer creates whichever of these two columns is missing.
They're found again by title and type, so don't rename them.

| Title | Type | Holds |
|---|---|---|
| Nearby contact | `board_relation`, connected to People, People (Historical) and Organizations | the matched contact |
| Nearby search | `text` | the search's label |

The board picker offers only main boards in `monday.resultsWorkspaceIds`, never a source board or
the Events board.

### Duplicates, claims and dead letters

A contact is claimed in D1 (`result_rows`, keyed by board and contact) before its row is written,
so a double confirm or a redelivered message can't create two rows. A claim left by a delivery that
died mid-write is taken over after 10 minutes, after checking the board for a row that did land.

A message that Monday rejects outright (a deleted contact, a bad column value) is dropped and its
claim released. One that keeps failing for other reasons retries with the shared outage backoff
(`max_retries: 100`, about four days) and then lands in the dead-letter queue, whose consumer
logs the board and contact ids and releases the claim. **Operator action for a dead letter:**
fix the cause, then confirm the same search again on the same board. Only the contacts not
already on the board are queued.

## Monday prerequisites

* **A Nearby dropdown column on People and on People (Historical), with the same title on
  both.** It must be a *dropdown* (the consumer writes labels with `create_labels_if_missing`).
  `people-reclassification` moves people between the two boards and maps columns by title, so a
  different title loses the labels on a move. Put each board's column id in `nearbyColumn`.
* **Lat and Lng columns on Organizations** (as on People and People (Historical)). Until the
  geocode backfill fills them, an organization search returns nothing.
* **An `address` block in config for each board the cron should geocode** (street, city, state
  and zip column ids). A source with `address: null` is never geocoded.
* A results workspace (`monday.resultsWorkspaceIds`) holding the boards organizers pick from.
* The Events board id and its address column, for the `?event=` link below.

## Geocode backfill (hourly cron)

At `17 * * * *` the Worker geocodes a bounded batch (`geocode.perRun`) of contacts that have an
address but no coordinates, using the US Census `onelineaddress` geocoder (`geocode.censusUrl`).
One budget is shared across the sources in config order.

* No match, or a Census 4xx other than 408/429, is a **miss**: recorded in `geocode_misses` with a
  hash of the address and not retried until that address changes.
* A Census 5xx, 408, 429, timeout or unreadable answer says nothing about the address: the item is
  retried next hour, and three in a row end the run.
* A Monday write rejected for that item (deleted, bad value) skips it; any other Monday error
  stops the run and fails the cron invocation.
* The run logs one summary line of counts, with failures counted by class (`census5xx`,
  `timeout`, `mondayTerminal`, …), never an address.

Side effects: each write changes Lat/Lng on a People item, which triggers a `mailchimp-sync`
outbound update (merge fields only, harmless). The Organizations backfill takes roughly
(organization count / `geocode.perRun`) hours, then the cron has nothing left to do.

## Write switch

Every Monday write is gated on `nearby-search:writes` in the shared `FLAGS` KV namespace (see the
root `CLAUDE.md` and `docs/runbooks/migration-hold.md`). A missing key means `off`.

| | `on` | `hold` / `unknown` | `off` |
|---|---|---|---|
| Preview | never writes | never writes | never writes |
| Confirm | queues | queues (the page says rows appear when writes resume) | queues messages stamped `dropped` (the page says nothing will be added) |
| Consumer | writes | retries with backoff until the switch changes | logs a dry run and acks |
| Geocode cron | writes Lat/Lng | skips the hour | geocodes and records misses, writes nothing to Monday |

Turn it on **before** deploying a build that should write:

```sh
node scripts/flags.mjs nearby-search writes on --env sandbox
```

## After an event: clearing labels and tags

Nothing clears a Nearby label automatically. When a campaign is over, remove the label in Monday
(edit the dropdown on the People items, or delete the label from the column's settings);
`mailchimp-sync` sees the change and sends the matching `Near: …` tag `inactive` in Mailchimp. The
results board is the organizer's to keep or archive.

## Known caveat: People (Historical) and Mailchimp (#83)

The Nearby column goes on People (Historical) as well as People, but `mailchimp-sync` watches the
People board only. Until it is extended
([#83](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/work_items/83)),
a Historical match gets its results-board row and label but no Mailchimp tag, so no email; the
confirmation step says so.

## "Find nearby" link on the Events board

The page opens prefilled from an Events row at `/?event=<item id>` (2 miles by default). To put a
link on each row without touching `eventbrite-sync`, add a **Formula** column to the Events board:

```
CONCATENATE("https://<host>/?event=", {Item ID})
```

If Monday doesn't render that as a clickable link (see the checklist), staff open the page
directly (`https://<host>/`) and type the event's address, or put the item id in the URL.

## Access and security

* Every route except `GET /health` sits behind Cloudflare Access; the Worker also verifies the
  Access JWT itself (`access.teamDomain`, `access.aud`). Requests are rate-limited (60 a minute).
* `POST /api/*` must be `application/json` (else 415) and, when the browser sends
  `Sec-Fetch-Site`, `same-origin` (else 403).
* Leaflet and turf load from pinned CDN URLs with SRI (sha384) hashes.
* Monday access is the `monday-auth` broker's `SyncToken` entrypoint (`MONDAY_AUTH` service
  binding); the Worker holds no Monday token.
* Point and corridor matching is `src/geometry.ts`, a byte-identical copy of
  `geo-filter/src/geometry.ts` (CI job `geo-geometry-copies`). Edit geo-filter's, then copy it.
  `src/flags.ts`, `src/environment.ts` and `src/monday/graphql.ts` are byte-identical copies too.

### Cloudflare Access setup

1. In Cloudflare One, add a self-hosted Access application for the Worker's hostname with a policy
   that allows only SVBC staff.
2. Copy the team domain (`<team>.cloudflareaccess.com`) into `access.teamDomain`, and the
   application's **AUD tag** into `access.aud`. Each environment is its own Access application
   with its own AUD tag.
3. Exclude `/health` from the application (a Bypass policy for that path) if an uptime check needs it.
4. Under the application's cookie settings, set **SameSite** to **Lax** or **Strict**, so a
   cross-site request doesn't carry the Access cookie.

## Config

`config/svbc.json` and `config/sandbox.json` (chosen by the `ENVIRONMENT` var) hold the board and
column ids. They ship with `null` / `REPLACE_WITH_*` placeholders, and `validateConfig` rejects a
placeholder, so a search fails loudly until every id is wired. Sandbox and production must use
different board ids and a different `access.aud` (`config/split.test.ts`).

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

## Verify during sandbox rollout

These depend on Monday or browser behaviour that no unit test can prove. Check each on the
sandbox boards before production:

- [ ] `create_column` with `column_type: board_relation` and `defaults: {"boardIds": [...]}`
      creates a "Nearby contact" column connected to all three source boards.
- [ ] One connect column accepts `item_ids` from different boards (a People, a People (Historical)
      and an Organizations item on the same results board).
- [ ] The Events board **Formula** link (`CONCATENATE(...)`) renders as a clickable link.
- [ ] `change_column_value` with `create_labels_if_missing: true` adds a new label to the Nearby
      dropdown on both People boards.
- [ ] A Nearby label survives a `people-reclassification` move between People and People
      (Historical), and the results-board link still points at the moved item.
- [ ] The page loads Leaflet and turf with their SRI hashes (no integrity errors in the console).
- [ ] The Access application's cookie is SameSite Lax or Strict.

## Commands

```sh
npm test            # vitest run
npm run typecheck   # wrangler types && tsc --noEmit
npm run dev         # wrangler dev (npm run dev:sandbox for the sandbox config)
```
