# salesforce-import

**Status:** Decided — one-time custom import, not Monday's live Salesforce sync connector.
**Priority:** Blocking. This is the central pre-migration engineering deliverable.
**Owner:** Unassigned — needs an owner and an explicit time budget (see Risks in the plan).
**Language:** TypeScript, per the plan's standing language policy. **Runtime: decided 2026-08-22 —
a plain Node.js 20+ CLI, not a Cloudflare Worker.** A one-time, long-running batch job has no use
for Worker execution limits, and the local filesystem is the right home for extracts, caches, and
resume ledgers. ESM, run via `tsx`, Monday GraphQL via plain `fetch` — no Hono, no D1.

**Implementation design:** `docs/11-salesforce-import-design.md` (private planning repo) — the
approved pipeline architecture (extract → geocode → transform → load → validate), board topology,
and the 2026-08-22 volume-scoping decisions summarized below.

**Full technical requirements:** `docs/05-migration-script-requirements.md` (private planning repo).
This README is the build/architecture overview; that document is the authoritative source-system
inventory, field-transformation spec, and blocking-decision list — it supersedes and significantly
expands the scope described below, following the full org-customization audit in
`docs/04-org-customization-inventory.md` (private planning repo).
**Read `04` and `05` before starting this build** — the org holds over 1.2 million records across
20 managed packages, not the roughly 100k across 5 integrations this plan originally assumed, and
several sections below are now incomplete on their own (flagged where relevant).

## The ask

Move SVBC's Salesforce/NPSP data into Monday.com once, cleanly, with dedup and relational
integrity resolved by SVBC's own tested logic rather than trusted to a vendor connector. Not a
live sync — Salesforce is being fully retired once the subscription lapses in October, so there's
no ongoing two-way-sync requirement to build for.

## Usage

**Prerequisites:**

* `sf` CLI authenticated to the org (extract shells out to it for the export).
* `MONDAY_API_TOKEN` env var, issued to a **dedicated integration user** per the repo's
  least-privilege policy — not a personal admin token.
* Optional `GOOGLE_MAPS_API_KEY` for the geocode fallback (Census batch geocoder needs no key).
* A fresh Mailchimp audience export CSV (consent system of record — see "Blocking preconditions").

**Run sequence:**

```sh
npm run cli -- extract --consent path/to/mailchimp-export.csv   # refuses while Funraise sync errors exist
npm run cli -- geocode
npm run cli -- transform            # fails on assertion violations; read data/transform/report.json
npm run cli -- load --dry-run       # prints the full per-board plan, writes nothing
npm run cli -- load                 # idempotent; re-run to retry failures only
npm run cli -- validate             # reconciliation + data/validate/sample.csv for the admin
```

**Sandbox week:** set `monday.boardSuffix` to `" (sandbox)"` in config, and delete `data/load/`
between full rehearsals. A run against a partial `payloads.ndjson` (e.g. a partial extract, not
`load --limit N`, which only caps items per board and never drops a board from the run) can create
connect columns without board defaults if a link's target board has zero payloads that run, and a
later full run does not retroactively patch them — run a full `--dry-run` first, and delete
`data/load/` between sandbox rehearsals rather than layering partial runs on top of each other.

**Cutover:** freeze Funraise sync first (doc 03 §7), delete `data/load/` (boards.json + the
ledger) — sandbox board ids and ledger entries left over from rehearsals would otherwise redirect
writes to the sandbox boards or suppress them entirely, since the ledger would report those items
as already loaded — re-run `extract` fresh, then keep `data/` as the migration audit artifact
alongside the backup archive.

## Why not the live connector

Monday's native Salesforce sync connector was the original plan. Rejected because: its dedup
behavior is an unverified vendor black box; rollback under a live bidirectional sync is messy;
board build-out would have to happen on the same timeline as data cutover. The custom import
decouples all three — see "Migration Method" in the plan for the full reasoning.

## Blocking preconditions

~~**Fix the 157 live Funraise→Salesforce sync errors before running any export.**~~
**Resolved 2026-08-22** — the error log is cleared to 0: the supporter sync had self-healed in
late July, and the lasting damage (27 donor-less donations back to 2023, 3 missing yearly
subscriptions) was repaired directly in Salesforce. The extract gate this script enforces now
passes; any new `funraise__Error__c` row is a fresh failure worth immediate attention. Full
detail: `docs/12-funraise-sync-error-fix.md` (private planning repo). Note the original
case-sensitivity root-cause theory was corrected — collisions were exact-value inserts of new
supporter records for existing Contacts.

**New, from the org-customization audit — also gate the build on these before finalizing scope
(status as of 2026-08-21 — two of three resolved):**

* ~~**Click & Pledge (2014–2022 legacy donation history) disposition**~~ **Resolved: migrate** all
  6,235 transactions into the Donations board as historical records — now in this script's scope.
  See `05` §1d.
* ~~**Mailchimp consent staleness**~~ **Resolved: Mailchimp is the consent system of record.**
  Live query confirmed the `MC4SF` sync's last write was 2025-10-20 — dead for ten months. This
  script must **not** write Salesforce's opt-out flags as authoritative; consent imports from a
  fresh Mailchimp export at cutover. See `05` §1g.
* ~~**Membership board scope**~~ **Resolved 2026-08-21 — the script's scope is now final.** No
  new board: 4 member-level columns on Donors (Status/Tier/Since/Until, for 10,270 members with
  Lifetime normalization) and 3 per-term columns on the linked Donation items (Term Start/End,
  Type), matched via the 100%-filled `Opportunity__c` link with a 1:1 assertion. Full mapping in
  `05` §2; the renewal emails become the new `membership-reminders` Worker.

**Also added to scope by the 2026-08-21 decisions** (details in `05` §1a/§1b/§1i/§1j and the
plan's Decisions Needed): Sponsorship/Grants/Contracts Opportunity history (3,613 + 125 + 478
records — the record-type count query proved these are real, not greenfield); volunteer history
2014–2020 as historical records; the recent ~2-year slice of Tasks/EmailMessages onto the Donors'
Activities board; `Secondary_Email__c` as its own labeled column on Person items, with its own
**Secondary Email Consent** status (Mailchimp consent is tracked per email address, not per
person); and a `ContactHistory` flat export (68,831 rows) into the backup archive.

## Data flow

```
Salesforce (svbc org, 00Di0000000b4YQEAY, Enterprise Edition, NPSP)
  │  read via Salesforce API or a clean CLI export (sf CLI / MCP)
  ▼
Import script
  │  person/org classification, partner-type reconciliation,
  │  relational linking (donation → contact → household),
  │  duplicate matching (~1,000+ known dupes), geocoding backfill
  ▼
Monday.com (bikesiliconvalley.monday.com) — written once, via API
```

Salesforce is **read-only** throughout — the script never writes back. This is what makes rollback
trivial: if validation fails, Salesforce is simply untouched and still authoritative.

## What the script must resolve, in one pass

* **Person/organization split** — `npe01__SYSTEM_AccountType__c`: `One-to-One Individual` (49,749)
  → People board, blank (2,090) → Organizations board. Ignore Account Record Type — unused, zero
  records. See `docs/03-monday-migration-mapping.md` §5 (private planning repo).
* **Partner-type reconciliation** — cascade `Type` → `Type_2__c` → `Industry`; ~1,212 organizations
  have none of the three set and need the Pre-Migration Deliverables' manual classification pass
  completed before the script can consume it.
* **Stakeholder Type for individuals** — the same classification need, widened to all 49,749
  people (Individual Donor / City or Agency Staff / Elected Official / Partner Org Contact), per
  Unique Advocacy-Specific Needs.
* **Volume ceiling — verified 2026-08-22, redesigned 2026-08-25.** Monday's limit is a hard
  [10,000 items per board on Basic/Standard/Pro](https://support.monday.com/hc/en-us/articles/4404058746642-Item-and-subitem-limits-per-board)
  (100k on Enterprise), and the org this was built for is on Pro. That caps not just People but
  Donations: full donation history (~54k records including Click & Pledge) is 5x over. Two
  decisions follow, both now final: **(1) Donations is ONE board with archive-in-place** —
  archived items don't count toward the ceiling and remain readable by id (though they reject
  all writes and their connect columns read empty while archived, verified live 2026-08-25), so
  `transform` flags every gift older than the retention window (`donationsActiveFiscalYears`,
  default current + previous fiscal year) and `load` walks fiscal years oldest-first in a
  create → link (both directions, including event-registrations' Payment links) → archive loop,
  keeping the active count bounded while total history is unbounded. Script-computed rollup
  columns (Lifetime Giving, First Gift, Gift Count) on every Donor item keep stewardship totals
  visible without paging history. This replaced the earlier era-split multi-board design —
  see `docs/20-donation-history-architecture.md` (private planning repo) for the full design,
  the verified archive-behavior facts, and what maintains the rollups post-migration.
  **(2) The People inclusion rule is written:** any contact with a
  real relationship — ever a donor, member, event registrant (Funraise or Eventbrite), volunteer, Funraise supporter, or
  org-affiliated (~12–15k of 50,086) — split as People (live, active since ~2019) + People
  (Historical). Email-list-only contacts stay in Mailchimp (the consent system of record) and the
  backup archive, not Monday. Original sizing queries:
  `docs/11-salesforce-import-design.md` (private planning repo).
* **Duplicate matching** — ~1,000+ known duplicates; build and validate matching logic against
  sandbox copies repeatedly until merges reliably match SVBC's own judgment. **Keep the
  personal/professional-email case separate** — that's not a duplicate to merge (see Decisions
  Needed: Personal/professional email entity handling), and running it through general dedup logic
  would be a data-loss mistake.
* **Geocoding backfill** — run Donors' addresses through the **US Census Bureau batch geocoder**
  first (free, no key, batches up to 10,000 — chunk larger lists), fall back unmatched addresses to
  the **Google Maps Geocoding API** (~$5/1,000; the old $200/month platform credit ended March
  2025, replaced by per-SKU free tiers — currently 10,000 free geocoding calls/month on the
  Essentials tier, likely covering the whole fallback set — confirm current terms at signup). Capture `lat`/`lng`, **city**, and **zip code** from whichever geocoder
  resolves the address — all three are needed downstream (Map View, bike-lane proximity, the
  per-contact bike-lane map, local news links, advocacy geography filtering). Nominatim was
  considered and ruled out for this step specifically (1 req/sec usage-policy cap, unsuited to a
  bulk one-time run).
* **Local News link** — derived from the geocoded city, no extra lookup: San Jose →
  [sanjosespotlight.com](https://sanjosespotlight.com/); Santa Clara/Cupertino/Campbell/Saratoga →
  [civicdigest.org](https://civicdigest.org); everywhere else →
  [localnewsmatters.org](https://localnewsmatters.org/). Apply to both Donors and Events.
* **Events from both platforms on one pair of boards** (2026-09-08, per `migration-plan.md`'s
  Eventbrite addendum) — Events ← `funraise__Fundraising_Event__c` **and** `eb4sf__Eventbrite_Event__c`
  (the "Events Made Easy" managed package, ~284 events since 2025); Event Registrations ←
  `funraise__Fundraising_Event_Registration__c` **and** `eb4sf__Eventbrite_Attendee__c` (~6.3k). A
  **Source** status column (Funraise / Eventbrite) tells the rows apart and the platform ids ride
  along as text (**Funraise Event ID**, **Eventbrite ID**, **Eventbrite Attendee ID**) so the
  post-migration Eventbrite Worker can upsert idempotently. Shared closed vocabularies: **Event
  Status** (Upcoming / Completed / Canceled / Draft), **Program** from the Eventbrite organizer
  account suffix (Public / Volunteering / Bike Parking / Group Rides / Private, Fundraiser for
  Funraise), **Attendance** (Registered / Attended / No Show / Canceled — mirrors the production
  Event Participation board; the import never sets No Show) and **Role** (Volunteer for the
  volunteering organizer's events, else Participant). Dropped: the two Funraise test events,
  Eventbrite drafts nobody registered for, and attendees Eventbrite itself deleted (`validate`
  adds those back when reconciling `eventbriteAttendees`). Registering for an event on or after
  `peopleActiveSinceISO` makes a Contact a *live* Person, not just an included one.
* **Field mapping** — Donations ← Opportunity, Recurring Gifts ← `funraise__Subscription__c`
  (Pledge folds in as columns — confirmed 1:1 duplicate, do not create a separate Pledges board),
  People ← Contact, Organizations ← Account, Events / Event Registrations ← both event platforms
  (previous bullet). Full column-by-column mapping, status-value
  mapping (`Posted` is the real success stage, not `Closed Won`), and the do-not-migrate list
  (payment-method PII, `funraise__Error__c`, `_Display__c` formula fields, test events, the
  `Redacted` subscription) are all in
  `docs/03-monday-migration-mapping.md` (private planning repo) — treat
  that document as the authoritative field mapping for this script, not a summary of it.
* **Double the Donation / 360MatchPro fields** — identify the actual custom fields 360MatchPro
  created on Contact/Opportunity (company name, match status, likely match amount — unconfirmed)
  and carry them into Donations/Donors as **Employer Match Status** and **Employer Name**.

## Write failures during the run

A one-time batch job doesn't get the Cloudflare Queue treatment the other Workers in this plan now
use (see `../README.md`'s Reliability section) — a Queue is built for an ongoing stream of events,
not a run that happens once and is already validated by repeated sandbox dry-runs. What it needs
instead, inside the script itself: **retry-with-backoff on each individual Monday API write**, and
a **log of which records failed** after retries are exhausted, so a partial run can be resumed
against just the failures rather than restarted from zero (and re-triggering the dedup logic
against records that already landed correctly). Treat any unresolved write failure as a blocker on
declaring the migration complete, the same way the Validation section below treats a relational-
integrity failure — a donation that silently failed to write is not different in kind from one that
imported with corrupted data.

## Validation

Dry-run against sandbox board copies repeatedly during sandbox week — cheap and repeatable, unlike
a live sync. Build the stratified validation-sample script (Accounts, Donations, Event
Participation, proportional sizing, ~300 records total, floor of 30 per category) so the office
admin can run it live during cutover weekend. Rollback threshold: 5% of the sample showing a core
relational-integrity failure (broken donation→contact→household links, duplicate-merge corruption,
failed-to-migrate records) — pending Deanna's sign-off.

## Sources

* `docs/01-funraise-pipeline-current-state.md` (private planning repo)
* `docs/02-entity-field-inventory.md` (private planning repo)
* `docs/03-monday-migration-mapping.md` (private planning repo)
* `docs/04-org-customization-inventory.md` (private planning repo)
* `docs/05-migration-script-requirements.md` (private planning repo) — authoritative for this build
* [Census Geocoder (US Census Bureau)](https://geocoding.geo.census.gov/geocoder/)
* [Bulk Geocode with US Census (Hands-On Data Visualization)](https://handsondataviz.org/bulk-geocode.html)
* [Geocoding API Usage and Billing (Google)](https://developers.google.com/maps/documentation/geocoding/usage-and-billing)
* [Nominatim Usage Policy (OpenStreetMap Foundation)](https://operations.osmfoundation.org/policies/nominatim/)
* Plan sections: Migration Method, Data Inventory, Pre-Migration Deliverables, Sequencing &
  Validation, Cutover Safeguards — `migration-plan.md` (private planning repo)
