# One Opportunities board and two-way board links

Date: 2026-11-11. Status: draft for review (revision 2).

## Intent

Staff asked for Monday boards to behave like a network: open any record and jump straight to the
records linked to it (events, organizations, people, donations), then onward from those. No board
is the permanent hub: some staff start from an Opportunity, some from an Event, some from a Person.
Every core board must be as navigable as every other, with the same links in the same place.

SVBC raises money in several ways that staff think of as one thing, "Opportunities": grants,
contracts, sponsorships, Bike Parking, sponsored classes, and bike programs staff may invent later.
Today these live on two boards (Grants & Contracts, Sponsorships), so "Opportunities" names no
board. The user's decision: **one Opportunities board for all revenue opportunities, with
Category as the discriminator**; a new revenue program is a new Category value, not a new board.

Today most links run one way. A donation shows its donor; the donor's item shows nothing about its
donations. Events cannot reach their donations or sponsors at all.

## Scope

| Board | Production id | Note |
|---|---|---|
| People (+ People (Historical)) | 18437909781 (+ 18437909784) | |
| Organizations | 18437909779 | |
| Donations | 18437909794 | |
| Events | 18437909790 | |
| **Opportunities** | one of the two below survives | merge of Grants & Contracts and Sponsorships |
| Grants & Contracts | 7896177072 | 117 items; groups by stage (Prospecting, Submitted, Active, Declined, Inactive) |
| Sponsorships | 18391037433 | 915 items; groups by year and event; the four other sponsorship pipelines are already merged into it and the empty ones await archive (svbc-monday-migration#108, Martha, UI step) |

Two workstreams, in this order:
1. **Links:** two-way connect columns across the core boards and the opportunity board(s).
2. **Merge and rename:** one Opportunities board.

## Decisions (the user's)

- One Opportunities board for all revenue opportunities, distinguished by Category.
- Staff use "Opportunities" as the umbrella word; the board takes that name. This reverses
  Clarrissa's 2026-11-03 board name "Sponsorships" and needs her sign-off (see open items).
- Start with People, Organizations, Donations, Events, and the opportunity boards. Other boards
  that link into the CRM (Invoicing Tasks, Bike Education Tracker, Comms/Marketing Requests,
  Volunteer Roster, ...) come in a later phase, except that they must keep working through the
  merge.

## Goals

1. Every meaningful pair among the boards above has a connect column on both sides.
2. Events gain direct links they lack: Donations, Organizations, People, Opportunities.
3. Opportunities have People, Organizations and Donations connects (today Sponsorships has only
   "Organization", and Grants & Contracts only "Grant Provider" and "BP Request"; the Funder and
   Donations links in `board-links.json` were never provisioned).
4. One Opportunities board, nothing lost: every item, subitem, file, update, and existing
   link on the two boards arrives with it, and Category carries Grants, Contracts, Sponsorship,
   Bike Parking, Sponsored Classes.
5. The link pattern is data in one config, so adding a board is one entry; idempotent,
   dry-run-by-default tooling (like `scripts/mark-read-only-columns.mjs`).

## Non-goals

- Changing what the Workers write, their sinks, or write switches (their column and board ids may
  need updating; their behavior does not).
- Automating item-view default tabs (the API cannot; staff set it by hand).
- Rollup columns beyond what exists; the planned #16 columns (Received mirror, Balance Owed,
  Invoices sent mirror, Restriction, Type, 14-day reminder) are owned by that work, not this.

## Anti-goals

- Losing items, subitems, files, updates, or links; or an empty reverse column where data exists.
- Duplicate columns: find columns by `bareTitle` (🔒 / 📜 markers).
- Touching production before the sandbox shows the same result.

## Current state (live, 2026-11-11)

- Donations: Donor (People, People (Historical), Organizations), Soft Credit, Campaign, Matched By,
  Acting for, Recurring Gift. None has a reverse on its target; none was made with
  `allowCreateReflectionColumn`.
- People / People (Historical): Organization, Affiliations, plus reflection columns for Activities
  and Change Requests. Nothing for Donations, Events, Registrations.
- Organizations: no connect or mirror columns.
- Events: only "🔒 Registrants". The "Sponsor" column in the docs does not exist.
- Event Registrations: Attendee, Event (reflection off), Payment.
- Sponsorships: "Organization" connect; Primary Contact and Email are text. Columns include Stage
  (status), Package, Category, Event, Year, Giving Level, Close Date, Grant Amount, Contract.
- Grants & Contracts: public, permissions "everyone" (**not** Directors-only). Columns include Type,
  Status, Category, Priority, Funding Category, FY Secured, Probability, $ in FY27 / FY28, Funding
  (formula), Hours, Hourly Rate, Contract Status, W-9 Needed, COI Needed, Grant Agreement, Box
  Folder, Bike Parking Total (formula), connects Grant Provider and BP Request. It has automations
  (Awarded creates three delivery subitems; 1-week due-date reminder; status-to-group moves).
- Boards pointing at the opportunity boards: Invoicing Tasks (Grant), Bike Education Tracker
  (Grant), Comms/Marketing Requests (Grant; Sponsorship -> the pipelines).
- `board-links.json` and docs 29/30 still describe the old pipeline names and are stale.

API constraint: an existing connect column's target cannot be changed (doc 29). A reverse side is
added by creating the column with `allowCreateReflectionColumn`, or, if verified possible, by
turning that on for an existing column.

## Link matrix to build

Each row is one reflection pair (a column on each board). "Opportunities" below means the merged
board. Titles are proposals; use the titles already specified in `board-links.json` where they
exist (Sponsor, Primary Contact (People), Donations) and avoid titles that collide with existing
columns (Sponsorships already has Category, Event, Year, so the Events link is titled
"Linked event", not "Event").

| A | B | Column on A | Column on B |
|---|---|---|---|
| Donations | People / Organizations | Donor (exists) | Donations |
| Donations | Organizations | Matched By (exists) | Matched Donations |
| Donations | Events | Event (new) | Donations |
| Donations | Opportunities | Opportunity (new) | Donations |
| Events | Organizations | Sponsor (new) | Events |
| Events | People | Organizer (new) | Events |
| Events | Opportunities | Opportunities (new) | Linked event |
| Opportunities | Organizations | Funder / Sponsor (one column, title TBD) | Opportunities |
| Opportunities | People | Primary Contact (People) | Opportunities |
| People | Organizations | Organization (exists) | People |

## Constraints

- Production and sandbox have separate ids; config carries both. Sandbox still has the five
  unmerged sponsorship pipelines plus Grants (ids in `board-links.sandbox.json`); the CRM Sandbox
  v4 test boards for the stage bar are 18438893957 (grants) and 18438893959 (sponsorships).
- Use the repo's `MondayGraphQL` transport (canonical copy in `monday-backup`). Workers never hold
  Monday tokens; operator scripts use the integration user's token like the existing
  provisioning scripts.
- `data/` and `.env` are gitignored; never touch or commit them.
- Extend `monday-migration/scripts/provision-board-links.mjs`; do not write a second tool.

## Merge: what has to be true

The two boards have different shapes: Sponsorships has Stage and groups by year/event, Grants &
Contracts has Status and groups by stage, and each has columns the other lacks. A merged board
needs, at minimum:
- one stage/status vocabulary (this overlaps svbc-monday-migration#109, Clarrissa's Leads / Deals
  stage bar: Leads = prospects, Deals = won grants, contracts and sponsorships);
- a Category value for each kind of opportunity, populated for every migrated item;
- the union of the columns staff use, with columns that only apply to some Categories kept but
  unobtrusive;
- grouping that works for every Category (today: stage groups vs year/event groups);
- the Grants automations re-created (they do not move with items), and no automation lost;
- every inbound link preserved: Invoicing Tasks, Bike Education Tracker, Comms/Marketing Requests,
  Donations connects, and the donation-rollups and benevity/eventbrite config that name boards
  by id;
- protocols, the Box Notes, MR !103/!104 docs, `board-links.json` keys and docs updated to the new
  name.

Which of the two boards survives (items can be moved with their ids; Sponsorships holds 915 items,
Grants & Contracts 117 plus the automations and the inbound links) is the builder's call after
testing item moves in the sandbox.

## Left to the builder

- Final column titles; whether People (Historical) gets the same reverse columns as People.
- Surviving board, move mechanics, and cutover (keep the old board read-only until verified).
- Sandbox rehearsal procedure, batching and rate limits.
- Whether existing one-way links get a reverse in place or are replaced and re-linked with
  `link-board-items.mjs` (open item 1).

## Builder's calls (the author's, marked for review)

- Start Events -> Organizations as a single "Sponsor" column; add Host only if staff use it.
- Donor and Matched By stay separate reflection pairs; one reflection per target board.
- A rename, merge or archive that would break an automation or inbound link stops the work and
  is reported.
- The four empty sponsorship pipelines are not touched here (svbc-monday-migration#108).

## Open items

1. Verify in the sandbox whether `allowCreateReflectionColumn` can be set on an existing connect
   column (decides "turn on" vs "replace and re-link"). **Decided by the user: replacing a
   connect column (new id) is acceptable if in-place is impossible.** Then the builder must
   re-create every existing link on the new column with `link-board-items.mjs`, update every
   Worker, script and config that references the old column id (in both repos), and keep the old
   column until the new one is verified. Prefer in place whenever it works.
   **Answer (sandbox probe, 2026-11-11): it works in place.** On Donations (sandbox v4,
   18437342657) the existing `Donor` column (`board_relation_mm8hhdk7`), updated with
   `update_column(board_id, id, revision, column_type: board_relation, settings: {...existing,
   allowCreateReflectionColumn: true})` (settings passed as a JSON object, `revision` read from
   the column first), created a reverse `link to Donations (sandbox v4)` column on each of its
   three targets (People, People Historical, Organizations) with no replacement and the column id
   unchanged. So "turn on", not "replace and re-link". Probe: `scripts/probe-reflection.mjs` in
   `monday-migration`. Side effect: the reflection columns are named `link to <board>` and need
   renaming.
2. **Decided by the user: links and merge together** (one project, one sandbox rehearsal, one
   production cutover), not links first. Consequence: the merged board's stage vocabulary
   (svbc-monday-migration#109, Clarrissa's Leads / Deals stage bar) and the board name need
   Clarrissa's sign-off before the production cutover; the builder takes the stage model as an
   input from #109 and does not invent one. If #109 is undecided when the sandbox rehearsal
   finishes, production waits.
3. **Decided by the user: backfill where matched.** New relationships (Donations -> Event,
   Opportunities -> People, Events -> sponsors) are filled from existing data where a match
   exists, e.g. Primary Contact email matched to People; unmatched rows stay empty or keep their
   text. The builder defines matching rules per link (unambiguous matches only; ambiguous ones are
   listed for staff review, never auto-linked), runs as dry-run first, and writes a report of
   linked / ambiguous / unmatched counts.
4. Whether item permissions matter: Grants & Contracts is public today, so nothing prevents a
   merge on access grounds; confirm no data on it should be hidden from Sponsorships' users.

## Rollout

Sandbox rehearsal, staff review, production. The old boards are kept read-only, not deleted, until
the merged board is verified.
