# Member map — Design

**Date:** 2026-11-02
**Status:** Draft design, pre-implementation. Shaped with David W. Keith (DWK) 2026-11-02.
**Worker:** new `member-map` (this repo). Reads Monday; never writes it.

## Intent

SVBC staff choose neighborhoods for membership drives, events and group rides. Today nothing
shows where SVBC is under-represented. This Worker serves a staff-only web map on an
OpenStreetMap base that highlights the **gaps**: neighborhoods where SVBC should be and isn't
yet. It also makes sure **low-income neighborhoods stand out** rather than disappear, because
they benefit most from SVBC's mission.

A staff member opens the map, looks for dark-shaded neighborhoods (especially outlined ones),
clicks one to see its numbers, clicks member dots to open the person in Monday, and checks
whether bike lanes there make a ride workable.

## Goals

1. Two gap layers, both shaded by neighborhood:
   - **Population gap:** many residents, few active members.
   - **Warm-lead gap:** many people SVBC already knows who aren't active members (lapsed members,
     donors and event attendees who aren't members).
2. A **low-income outline** on top of the shading, using MTC's **Equity Priority Communities**
   (EPC), so a shaded, outlined neighborhood reads as the first pick.
3. **Member dots at the exact address.** Clicking a dot opens that person's Monday item, or the
   organization's item for organization dots.
4. A **bike lanes layer** (the lines, by class) for planning rides, from the same sources as
   `svbc-bike-lanes` (see "Bike lane density").
5. A **bike lane density** layer: neighborhoods shaded by **class-weighted bike lane miles per
   mile of road**. Dividing by road miles, not area, keeps density from simply tracking how
   built-up a neighborhood is.
6. A **neighborhood click-through** with its numbers, e.g. *4,200 residents · 6 members ·
   38 warm leads (31 lapsed, 7 never members) · median household income $62k · Equity Priority
   Community · bike facilities on 18% of street miles (weighted; 2.4 mi, 0.3 mi Class IV)*.
7. Coverage is exactly `svbc-bike-lanes`' area: **San Mateo and Santa Clara counties**, using
   Census TIGER boundaries.
8. **Everyone with an address is placed**, including people added since the migration, whose
   Lat/Lng are blank (see "Placing people without coordinates").
9. Data refreshes **weekly**. The page shows when it was last refreshed.

## Non-goals

- Not public, and not for members. Staff only.
- Never writes to Monday.
- No contact-list export. `geo-filter` already produces "people in this area" CSVs.
- Not real-time. Weekly is enough.
- No areas outside the two counties.

## Anti-goals (failure even if it works)

- **Any route that serves addresses without Access.** Exact home addresses are shown on
  purpose, so the protection must be real. That means no open `workers.dev` route, no cacheable
  public response, and no addresses or emails in logs.
- **Low-income areas fading out.** A neighborhood where SVBC knows almost nobody must still show
  as a gap. The population layer is the guard for this; don't add a filter that drops
  neighborhoods with few known people.
- **A map so slow or cluttered that staff stop opening it.**

## Constraints (from the repo's conventions)

- **Stack:** Hono + TypeScript, `wrangler.jsonc`, vitest, `npm run typecheck`, like the other
  Workers. The Worker also serves the static front-end.
- **Monday access:** through the `monday-auth` broker's **Read-only** app: the service binding
  `MONDAY_AUTH` → `ReadOnlyToken`, as `report-digests` and `monday-backup` do. No Monday token
  secret.
- **Monday transport:** a byte-identical copy of `monday-backup/src/monday/graphql.ts` at
  `member-map/src/monday/graphql.ts`, tuned in its own `client.ts`. Add the path to the
  `monday-graphql-copies` CI job.
- **Column titles:** find columns through `bareTitle` (`scripts/lib/column-titles.mjs`), because
  People columns carry 🔒/📜 markers. Add `scripts/lib/**/*` to the Worker's CI job rules.
- **Config, not hardcoding:** board ids, column titles, Monday account slug, county list and
  similar values go in `config/svbc.json`, validated at startup.
- **Sandbox environment:** an `env.sandbox` block, `config/sandbox.json`, `src/environment.ts`
  and `config/split.test.ts`, copied from `member-portal`'s shape. Sandbox reads the sandbox
  boards through `svbc-monday-auth-sandbox`.
- **Log safety:** `scripts/check-log-safety.mjs` must pass. Log counts, never names, addresses
  or emails.
- **OSM tiles:** `tile.openstreetmap.org` with visible attribution and an identifying
  Referer/User-Agent, per OSM's tile usage policy. A handful of staff is well within it.
- **UAT:** add a staff UAT script in `docs/uat/` and a row in the root README's status table.

## Decided

| Decision | Value |
|---|---|
| Display | Option C from the mockups: gap areas shaded (only gaps, not every neighborhood), plus member dots |
| Neighborhood unit | Census **block group**, the smallest unit with reliable population and income figures |
| Gap layers | Population gap and Warm-lead gap, toggled; Population gap on by default |
| Low-income definition | MTC Equity Priority Communities (current Plan Bay Area set), drawn as a heavy outline. They're defined by census tract, and block groups nest inside tracts |
| Income figure | ACS 5-year median household income per block group, shown in the click-through |
| Population figure | ACS 5-year total population per block group |
| Warm leads | Lapsed members + donors who aren't members + event attendees who aren't members |
| Member dots | Exact address, each linking to its Monday item |
| Organizations | Their Monday items are linkable from the map too |
| Access | Whole app behind **Cloudflare Access**, allowed only for `@bikesiliconvalley.org` identities |
| Coverage | San Mateo + Santa Clara counties, the same as `svbc-bike-lanes` |
| Refresh | Weekly |
| Map library | Leaflet on OpenStreetMap tiles |
| Missing coordinates | Geocoded **privately** by the map each week. Never written back to Monday |
| Bike lane density | Class-weighted bike lane miles ÷ road miles, per block group, using `svbc-bike-lanes`' sources and rules |
| Class weighting | Yes. Classes are weighted by protection (values below are a starting point, kept in config) |
| Cloudflare Access | Not set up yet. Setting it up is part of this project, before staff testing |

## Calls made during design (DWK may override)

- **Worker name `member-map`**, on a staff hostname such as `map.bikesiliconvalley.org`. The
  final hostname is the operator's choice.
- **"Active member" = Membership Status `Active`** on People. Under the 2026-10-09 membership
  rule, a person who gave ≥$1 or volunteered in the last 13 months is a member, so most "donors
  who never joined" are now *lapsed members*. In practice, **warm lead = any People item the map
  can place (board Lat/Lng or a private geocode) whose Membership Status is not `Active`** (Lapsed or blank). The click-through
  splits that count into *lapsed* and *never a member*. Read both People boards
  (`people-live` and `people-historical`), since lapsed people may sit on either.
- **Event attendees count only once they're on People.** Event Registrations rows carry no
  address, so a registrant without a People item can't be placed on a map. Attendees who are on
  People (`eventbrite-sync` links them once they attend) are already covered by the
  "not `Active`" rule. The map doesn't read Event Registrations.
- **Organizations are their own dot layer** (off by default). Membership is per person, so
  organizations don't count toward either gap. Organizations without coordinates are skipped.
- **Warm-lead dots** are an extra toggle, off by default, with the same link-to-Monday popup as
  member dots.
- **Layer defaults:** Population gap on, EPC outline on, Member dots on; Warm-lead gap, Bike lane
  density, Warm-lead dots, Organizations and Bike lanes off. The three shaded layers (two gaps
  and density) are mutually exclusive, one at a time, because stacked fills are unreadable. The
  EPC outline and the dot and line layers combine freely with any of them.
- **Defense in depth on Access:** the Worker verifies the `Cf-Access-Jwt-Assertion` JWT (team
  domain and application AUD from config) on every request. `workers_dev` is `false`, and
  responses carry `Cache-Control: private, no-store`. Access alone is the gate; the JWT check
  covers a misconfigured route.
- **No write switch.** The `FLAGS` off/hold/on switch governs Monday *writes*, and this Worker
  makes none. If the CI check requires every Worker to carry `src/flags.ts`, that is the one
  reason to add it.
- **Do Not Solicit people still count.** The map is for choosing neighborhoods, not contacting
  individuals. Their dot popup shows the flag.
- **Tiny block groups** (under roughly 100 residents, e.g. parks or industrial land) are left
  unshaded so they don't show up as false gaps. The builder may tune the threshold.

## Placing people without coordinates

Lat/Lng on People and Organizations were filled once, by `salesforce-import`, using the U.S.
Census batch geocoder (`geocoding.geo.census.gov/geocoder/locations/addressbatch`). No running
Worker maintains them, so everyone added since cutover has an Address but blank Lat/Lng. Decided:
the map geocodes these itself and **keeps the result private**. Monday is never written.

- Each weekly run collects items with an Address (plus City/Zip) and blank Lat/Lng. Board
  Lat/Lng, when present, always wins.
- It geocodes them with the same Census batch geocoder the migration used, so addresses go
  nowhere new. The service is free, takes up to 10,000 addresses per batch, and needs no key.
- Results are cached in the Worker's private store (D1 or R2), keyed by item id and a hash of the
  normalized address. An unchanged address is never re-sent, and a changed address is looked up
  again. Failed matches are cached too, so they aren't retried every week. The builder sets how
  often a failed match is retried.
- The page states how many people couldn't be placed ("212 people with no usable address"), so a
  thin area isn't mistaken for a real gap.
- Log counts only, never addresses (`check-log-safety.mjs`).

## Bike lane density

Same data and rules as `svbc-bike-lanes` (`_data/bikelanes.js`, `_data/supplementalSources.js`),
so the two never disagree about what exists:

- **Sources:** MTC Regional Bike Facilities (ArcGIS FeatureServer, Classes I–III) for both
  counties. **Within San Jose, San Jose's own Bikeways layer replaces MTC entirely**, because it's
  complete and includes Class IV, which MTC lacks. Any other city-level Class IV supplements that
  `svbc-bike-lanes` adds are carried over the same way.
- **Length:** haversine polyline length in miles, as in the report.
- **Attribution (one deliberate change):** the report assigns each whole segment to a city by its
  midpoint. Block groups are far smaller than cities, so the map **splits segments at block-group
  edges** and credits each piece to the block group it lies in. Every mile is still counted
  exactly once, including along the county line.
- **Road miles (the denominator):** Census TIGER/Line roads for the two counties, the same source
  family as the block groups, split at block-group edges the same way. **Freeways and ramps are
  excluded** (MTFCC `S1100` and `S1630`), since bikes can't use them. Including them would
  penalize neighborhoods beside a freeway. *(Calls made in design: TIGER over OSM roads, because
  OSM mixes in driveways and parking aisles; and the exact MTFCC exclusions.)*
- **Class weights** (in config, starting values, a design call):

  | Class | Weight |
  |---|---|
  | I: off-street path | 1.0 |
  | IV: separated bikeway | 1.0 |
  | II: striped lane | 0.5 |
  | III: signed route | 0.2 |

- **Score:** Σ(weight × bike lane miles) ÷ road miles, shown as a percentage. Off-street Class I
  paths aren't on roads, so a trail-rich block group can exceed 100%. That's accurate: there's
  more riding there. The click-through shows the weighted percentage plus raw miles by class.
- **Shading:** low density is the "gap" end, consistent with the other layers.
- **Refresh:** the bike facilities and road data change slowly. They're built with the
  reference data and may move into the weekly cron if that's simple (builder's choice).

## Cloudflare Access setup (prerequisite, operator work)

There's no Access setup today. Before any staff testing:

1. Create the Cloudflare Zero Trust organization (team domain) on SVBC's account.
2. Add **Google Workspace** as the identity provider, restricted to `@bikesiliconvalley.org`.
   *(Assumed: SVBC staff sign in with Google Workspace. Use whichever provider staff actually
   use.)*
3. Create two Access applications, one for the production hostname and one for the sandbox
   hostname, each with an Allow policy for emails ending in `@bikesiliconvalley.org`.
4. Put each application's **team domain and AUD** into the Worker's config (production and
   sandbox) for the JWT check.

Document these steps in the Worker's README (and its `DEPLOY.md`, if it has one), so another org's
fork can repeat them. Putting `svbc-bike-lanes` behind Access is tracked as its own task in that
repo.

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

- **Reference data build:** a local script (e.g. `member-map/scripts/build-reference.mjs`) pulls
  TIGER/cartographic-boundary block groups for the two counties, ACS 5-year B01003 (population)
  and B19013 (median household income), MTC's EPC layer and MTC's regional bike facilities.
  It simplifies the geometry and writes compact files (GeoJSON or TopoJSON) served as Worker
  static assets. All of it is public data, so committing it is fine. Re-run it when the Census
  or MTC publish new releases. Bike lanes may also go into the weekly refresh instead, if that's
  simple.
- **Snapshot:** built by the weekly cron, stored privately (R2 is the expected fit, since a few
  thousand points with names may exceed KV's comfortable size) and served only through the
  Worker. A manual "refresh now" route for staff is the builder's choice.
- **Monday links:** `https://<account>.monday.com/boards/<boardId>/pulses/<itemId>`, with the
  account slug from config.

## Gap scoring

- **Population gap:** active members per 1,000 residents. Lower means a bigger gap. Built: ranked,
  not value breaks, with ties (above all the many block groups with no members) broken by
  population, since the first sandbox snapshot put 1,087 of 1,672 block groups in the darkest class.
- **Warm-lead gap:** warm-lead count. Higher means a bigger gap. (Optionally warm leads per
  active member; the builder may try both on real data and pick the clearer one.)
- **Shading:** a few classes (e.g. quantiles across the two counties). The "no gap" class is left
  unshaded, so the map points at places rather than painting everything. The builder picks the
  breaks from real data. The legend explains them in plain words.

## What's left to the builder

- The exact R2/KV choice, file formats, simplification tolerance and asset layout.
- Clustering versus canvas-rendered dots, if dot density hurts performance.
- Class breaks and colors (accessible in light and dark mode, with orange for gaps and a
  contrasting outline for EPC).
- Reading the EPC and bike-facility layers from MTC's ArcGIS endpoints (the same family
  `svbc-bike-lanes` uses in `_data/bikelanes.js`).
- Test shape. At minimum: the scoring (including weighted bike lane density and the San Jose
  replacement rule), segment splitting at block-group edges, the geocode cache (unchanged address
  not re-sent; changed address re-geocoded; board Lat/Lng wins), block-group assignment (including points on boundaries
  and outside the two counties), Access JWT rejection, snapshot building from fixture board
  pages, and the config split test.
