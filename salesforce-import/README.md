# salesforce-import

**Status:** Decided — one-time custom import, not Monday's live Salesforce sync connector.
**Priority:** Blocking. This is the central pre-migration engineering deliverable.
**Owner:** Unassigned — needs an owner and an explicit time budget (see Risks in the plan).
**Language:** TypeScript, per the plan's standing language policy. **Runtime:** Node.js script or a
Cloudflare Worker is still open ("same shape as the other builds in this plan"); pick one before
starting, since a one-time, long-running batch job may fit a plain Node script (no Worker
execution-time limits to work around) better than a Worker. Decide and update this README once
chosen — either way, write it in TypeScript.

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

## Why not the live connector

Monday's native Salesforce sync connector was the original plan. Rejected because: its dedup
behavior is an unverified vendor black box; rollback under a live bidirectional sync is messy;
board build-out would have to happen on the same timeline as data cutover. The custom import
decouples all three — see "Migration Method" in the plan for the full reasoning.

## Blocking preconditions

**Fix the 157 live Funraise→Salesforce sync errors before running any export.** Root cause: a
case-sensitive unique-index collision on `Contact.Primary_Email__c`. ~11 supporters and their
donations are currently missing from Salesforce entirely and will silently be missing from the
import too if this isn't reconciled first. Full detail:
`docs/01-funraise-pipeline-current-state.md` §5 (private planning repo).
This is listed first in the plan's Decisions Needed for a reason — treat it as a hard gate on
starting the import build, not a parallel task.

**New, from the org-customization audit — also gate the build on these before finalizing scope:**

* **Click & Pledge (2014–2022 legacy donation history) disposition** — migrate, archive, or drop?
  A second, previously-undiscovered donation platform with 6,235 transactions and no live sync to
  maintain, but a real decision with a real cost either way. See `05` §1d.
* **Mailchimp consent staleness** — the Salesforce-side Mailchimp sync (`MC4SF`, 540,000+ records)
  has written nothing since 2025-10-19. If Mailchimp is the real system of record for email
  consent, Salesforce's opt-out flags may be stale by ~10 months — **do not write opt-out fields to
  Monday until this is confirmed.** See `05` §1g.
* **Membership board scope** — `Membership__c` (20,510 records, second-largest object in the org)
  has no field mapping or board design anywhere in this plan yet. See `05` §1e–§2.

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
* **Volume ceiling** — Monday's board ceiling (~10k items, ~20k on higher tiers) is far below
  50,086 Salesforce Contacts. Do not load all Contacts. Scope the People board to
  Funraise-attributed (1,993) and otherwise-active people; confirm the exact inclusion rule before
  building — it's currently a plan-level constraint, not yet a written rule. **Also verify the
  ceiling itself against Monday's current published limits (and whether archived items count)** —
  it's the sole justification for excluding ~45k contacts, and Monday's guidance has shifted
  between hard limits and performance recommendations over time.
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
* **Field mapping** — Donations ← Opportunity, Recurring Gifts ← `funraise__Subscription__c`
  (Pledge folds in as columns — confirmed 1:1 duplicate, do not create a separate Pledges board),
  People ← Contact, Organizations ← Account, Event Registrations ←
  `funraise__Fundraising_Event_Registration__c`. Full column-by-column mapping, status-value
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
