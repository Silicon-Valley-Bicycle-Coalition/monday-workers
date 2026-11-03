# nearby-search: find people and organizations near a place

Date: 2026-11-02. Status: design, not built.

## Why

Where someone lives predicts whether they'll show up:

* **Events.** People who live near an event are more likely to come, so SVBC wants to send them
  a different invitation than the general list gets.
* **Advocacy.** People who live near a bike lane or intersection project are more likely to
  show up at the council meeting about it, so they get a targeted ask. These projects usually
  cover a **stretch of road** ("Stevens Creek Blvd between Saratoga Ave and Winchester Blvd"),
  not a single point.

`geo-filter/` already has the geometry for this: ZIP, radius-around-a-point, and
buffer-around-a-line ("corridor") searches over the Lat/Lng columns `salesforce-import`
geocoded. But it's a developer CLI. It takes raw coordinates or hand-traced GeoJSON, searches
one board, and writes a CSV. The people who need these lists are staff and volunteer
organizers, not developers, and the list has to end up in Monday and Mailchimp, not in a file.

## Goals

* An organizer starts from the project's or event's item in Monday and gets to a nearby list
  without coordinates, GeoJSON, a terminal, or a token.
* **The input is whatever text they already have:**
  * Events: the venue address the Events board already holds (`eventbrite-sync` writes
    `addressColumn`/`cityColumn`). No typing.
  * Infrastructure projects: text copied from the city's notice PDF. That's an address, an
    intersection ("Bascom Ave & Hamilton Ave"), or a road segment ("X between Y and Z", "X from
    Y to Z").
* Searches cover People, **People (Historical)**, and Organizations. Lapsed supporters who still
  live nearby are worth reaching. *SVBC's decision.*
* **The organizer always sees the result on a map and confirms before anything is written.**
  The map shows the resolved point or line, the search area, pins for the matches, and counts
  ("412 people, 9 organizations"). Nothing goes to Monday or Mailchimp until they confirm.
* **Results land in two places:**
  1. **The project's or event's own Monday board.** That board already exists, created by staff.
     The matches are added to it as items that **link** to the People/Organizations items, so
     contacts are never duplicated. Staff work the list there (calls, RSVPs).
  2. **Mailchimp.** Each matched person gets a tag named for the project or event, so the
     organizer can send a different invitation to that tag.
* OpenStreetMap is the source for turning text into geometry. That means place lookup and
  following the named road between its two cross streets.

## Non-goals

* Sending the email. The organizer sends it from Mailchimp to the tag.
* Parsing the PDF itself. The organizer copies the relevant line.
* Arbitrary hand-drawn shapes. The geo-filter CLI with `--geojson` stays the escape hatch for
  odd cases.
* Re-geocoding the People board on demand. Search uses the stored Lat/Lng.

## Anti-goals

These would make it a failure even if it technically works:

* **A wrong guess applied without being seen.** If the tool resolves the wrong "Stevens Creek"
  and silently tags 3,000 people in Mailchimp, it has done harm. The map confirmation is not
  optional, and the page must make a bad resolution obvious: show the resolved line on the map
  and name the street and cross streets it matched.
* **Destroying work in progress.** Re-running a search, for example with a wider distance, adds
  new matches and leaves existing rows alone. It never removes rows an organizer has been calling
  through, and never resets a status they set.
* **Becoming an email path around opt-outs.** Mailchimp's own unsubscribe state and the
  `do-not-solicit` tag still govern who gets mail. Nearby people who've opted out may still
  appear on the Monday board, since organizers may want to know they're there. Mailchimp just
  won't mail them.

## Decided shape

These were agreed with SVBC in conversation, or are my calls where marked.

* **A new Worker, `nearby-search`, in this repo, serving a small staff web page.**
  It sits behind **Cloudflare Access** (available to SVBC for staff tools through Project
  Galileo; see `member-portal/README.md` on why Access fits staff tools and not the donor
  portal). *My call.*
* **Staff only.** One Access policy for SVBC staff. No volunteer access, so no role-based
  limits on what the page shows (exact home-location pins are fine). Record the Access identity
  of whoever confirms a write in the Worker's D1 log, for auditing. *SVBC's decision on access;
  the audit log is my call.*
* **Monday entry point: a link on the Events item** that opens the page with the venue address
  prefilled. For infrastructure projects, the organizer opens the page directly and pastes text.
  A link column or button is enough; a Monday marketplace app or board view is not needed.
  *My call.*
* **The organizer picks the results board on the page, every time.** The page lists boards the
  Staff sync token can see (filtered to a configured workspace or folder so the list is short)
  and shows the chosen board's name in the confirmation step. No per-item "results board" column
  and no remembered choice. *SVBC's decision.*
* **Text → geometry, via OpenStreetMap:**
  * Address or place → point: Nominatim.
  * Intersection → point: where the two named ways meet in OSM road data (Overpass).
  * "X between/from Y and/to Z" → line: find road X and the points where Y and Z cross it, then
    take the part of X between those two crossings as the corridor line (Overpass for the ways).
  * The search area is limited to SVBC's service area (Santa Clara / San Mateo counties) so
    short street names resolve locally.
  * Respect the public Nominatim/Overpass usage policies: identifying User-Agent, about one
    request a second, cache results. Volume is a handful of searches a week.
* **The geometry is geo-filter's.** Radius and corridor matching reuse
  `geo-filter/src/geometry.ts` (`filterContacts`), copied byte-identical with a CI drift check
  like `graphql.ts`/`flags.ts`, or extracted. Builder's choice, but don't fork the math.
* **Distance:** the organizer picks a distance in miles. Defaults are *my call*: 2 miles for
  events, 0.5 miles for a corridor.
* **Writing results:**
  * Project/event board: one item per match, with a connect column to the People, People
    (Historical), or Organizations item. Dedupe on the linked item id, so a re-run adds only new
    matches. `people-reclassification` can move a person between People and People (Historical)
    later, so dedupe must survive that move (Monday keeps the item id across a board move;
    verify).
  * Mailchimp: a new **"Nearby" tag column** on People (a Monday tags or dropdown column holding
    search labels like `near: Stevens Creek bikeway`). `mailchimp-sync` gains support for syncing
    that column's values as Mailchimp tags. Today its tags are a fixed config set
    (`MailchimpTagsConfig`: active/lapsed/lifetime/has-donated/do-not-solicit), so this is a real
    change to `mailchimp-sync`, not just config. *My call on the mechanism.* The alternative,
    nearby-search calling Mailchimp itself, would give a second Worker Mailchimp credentials.
  * The Nearby column goes on People (Historical) too. But `mailchimp-sync` watches the People
    board only (its README, "People board only"), so until it's extended, Historical matches get
    the board row and no Mailchimp tag. The confirmation step says so plainly: "N of these are
    Historical and won't get the email yet." Extending `mailchimp-sync` to Historical is tracked
    as a separate issue ([#83](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/work_items/83)).
  * Organizations get the board rows only, no Mailchimp tag. Orgs are a call list, not an email
    audience.
* **Repo conventions apply:** `config/*.json` for board/column ids, a sandbox environment
  (`env.sandbox`, `config/sandbox.json`, split test), the `FLAGS` write switch
  (`nearby-search:writes`), Monday access through a `monday-auth` service binding (Staff sync
  token), the canonical `graphql.ts` transport copy, and log-safety (no addresses or emails in
  logs).

## Known gaps to close as part of this

* **Organizations may have no coordinates.** `salesforce-import` geocoded People/Donors
  addresses. Check whether the Organizations board has Lat/Lng. If not, it needs a geocoding
  pass (Census batch geocoder, as the import used) before org search returns anything.
* **New people need geocoding.** Contacts created after the migration (Funraise, Eventbrite,
  portal sign-ups) won't have Lat/Lng and so will never appear in searches. Something has to
  geocode new or changed addresses: a cron in this Worker or a step in the writers. The page
  should also report how many contacts were skipped for missing coordinates, as geo-filter
  already does.

## Left to the builder

* Page framework and map library (Leaflet with OSM tiles is the obvious fit).
* Exact phrasing patterns the segment parser accepts, plus the fallback when parsing fails. The
  minimum fallback is a single address/intersection search with a clear message.
* Whether a project/event board's item columns (name, link, status) are created by the Worker or
  set up by staff from a template.
* How the search label/tag name is derived (from the item name by default), and how and when
  tags are cleared after an event or project ends.
* Whether the corridor matcher needs the line simplified for long roads.
