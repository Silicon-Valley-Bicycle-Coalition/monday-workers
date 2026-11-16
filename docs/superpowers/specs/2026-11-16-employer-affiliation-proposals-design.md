# Employer affiliations from repeated matching gifts (`impact-attribution`, first job)

**Status:** Design, awaiting review (2026-11-16).
**Issue:** svbc-monday-workers#125.
**Affects:** a new `impact-attribution` Worker (this is its first and only job for now); reads
Donations, reads and writes Affiliations. No other Worker changes.
**Builds on:** [`2026-09-08-person-org-email-model-design.md`](2026-09-08-person-org-email-model-design.md)
(the Affiliations board, its **Draft** status, and the `impact-attribution` Worker it names);
`contact-roles` (the cron-only Worker shape and the sparse Donations read this copies).

## Why

Every employer matching gift on the Donations board names the company that paid it in
**Matched By** (connect → Organizations), and the employee it is credited to in **Donor**. That is
SVBC's most reliable evidence of who works where *and* whose employer matches. Nothing carries it
to the person today: `benevity-import` deliberately does not (its README, "Resolving a person does
**not** write the employer…"), because one match is weak evidence of current employment
(foundation payers, retiree programs, spouse matches). The affiliation design left this to
`impact-attribution`, which was never built.

So employer data from matches never reaches People, Affiliations, `contact-roles`, or anything
that prompts donors.

## Goals

* When the same company has matched a person **at least twice within any 12-month span**, propose
  an Affiliation between them for staff to confirm.
* Propose it as **Current** if the latest match of that person by that company is within the last
  12 months, otherwise as **Former**.
* Use history, not just new gifts: the first run covers every matching gift since 2013,
  Salesforce-era and archived included, through a one-time bootstrap from the import's artifacts
  (see "Where the evidence comes from").
* Never let a proposal take effect without a staff decision, and never re-propose one staff turned
  down.

## Non-goals

* **A single match does nothing.** No review list, no note. (Decided 2026-11-16; the issue's
  single-match list is dropped.)
* Not the email resolver, `email_index`, Acting-for attribution, or the derived People →
  Organization column from the affiliation design. They are later jobs for this Worker.
* Not writing an employer onto the People item (Employer text, DTD Company) — the Affiliation is
  the record.
* Not changing `benevity-import`, `dtd-sync` or `salesforce-import`.

## Anti-goals (would make this a failure even if it works)

* A Draft that silently counts: Drafts must stay out of `contact-roles` and rollups. Both already
  read only `Status = Current`, so a Draft is inert until staff change it — keep it that way.
* Staff deleting the same suggestion night after night.
* A flood of Drafts nobody can work through on the first `on` run (see Rollout).

## Approaches considered

* **A. A nightly step in `dtd-sync`.** Its pairing step already loads every Matching Donation with
  Donor and Matched By, and it has D1, the write switch and a sandbox environment — least new code.
  But it puts affiliation writes in a Worker built around Double the Donation, which SVBC can only
  half use on its Standard plan, and a fork that uses Benevity without DTD couldn't take it alone.
* **B. Start `impact-attribution` now with this as its only job.** *Chosen (2026-11-16).* New
  cron-only Worker; about a day of scaffolding, mostly copying canonical files. Lands where the
  affiliation design already puts this work and gives the later resolver its home. Neither A nor B
  is deployed, so A wouldn't ship sooner.
* **C. A nightly job in `benevity-import`.** Rejected: that Worker is shaped around uploads and its
  queue, and half the evidence isn't its own (Salesforce-era and hand-entered matches).

## What was decided

### The rule

For each (person, company) pair, taking only Donations items where:

* Gift Type = `Matching Donation` (the label `benevity-import`, `salesforce-import` and staff use;
  `dtd-sync/src/pairing/pair.ts` has the constant),
* Matched By links exactly one Organizations item (zero → skip; more than one → skip the item and
  log it, it's malformed),
* Donor links an item on a **People** board (live or Historical). A Donor on Organizations (a
  match Benevity disclosed no employee for) or no Donor (anonymous) → skip,
* Matched By is not on the config **exclusion list** (foundations, DAF sponsors),
* Date is set (no Date → skip; it can't be placed in a window),

sort the pair's match dates and propose if **any two of them are ≤ 365 days apart** (inclusive).
Two matches on the same day count (recurring payroll matches qualify, as the issue says).

* **Current** if the pair's latest match Date is within 365 days of the run date, else **Former**.
  The window is measured from the latest match overall, not the latest qualifying pair.

### What a proposal is

One new item on the Affiliations board:

| Column | Value |
|---|---|
| Name | `<Person name> @ <Organization name>` (the affiliation design's convention) |
| Person | the Donor's People / People (Historical) item |
| Organization | the Matched By item |
| Status | **Draft** |
| Proposed status | **Current** or **Former** — see below |
| Start / End | blank. Match dates say when someone gave, not when they were hired or left |
| Role, Work Email, Primary, SVBC Roles | blank |

Plus one **item update** (comment) on the new item listing the evidence, so staff can judge it
without leaving the item: "Proposed from N matching gifts by <Org>: <date> $<amount>, …", newest
first, at most 10 lines with "and K more".

**The Current/Former proposal needs a column.** Status can hold only one label and it must be
`Draft` (that's what keeps it inert and puts it in "Drafts to confirm"). So the Affiliations board
gains a 🔒 status column **Proposed status** (`Current` / `Former`), written only by this Worker.
Staff read it in the "Drafts to confirm" view and set Status to match (or to Former, or delete the
item). It means nothing once Status is not Draft. Add it to `MARKED_COLUMNS` in
`scripts/mark-read-only-columns.mjs`, add it to the "Drafts to confirm" view's columns in
`salesforce-import/src/configure/spec.ts`, and create it on both the sandbox and production
Affiliations boards by a small idempotent setup script (match columns through `bareTitle`).

### When nothing is proposed

* The person already has **any** Affiliation (Current, Former or Draft, from any source) whose
  Organization is that company. Staff's record wins, including someone who left and came back.
* This Worker has proposed that (person, organization) pair before, whatever became of it. Staff
  turning a suggestion down = deleting or archiving the Draft; the D1 ledger stops it coming back.

### Where the evidence comes from: a match history in D1

**The board alone can't supply the history.** `salesforce-import` archived ~44,800 gifts in place
(everything before the two active fiscal years), `items_page` never returns archived items, and an
archived item's connect columns (Donor, Matched By) read empty even fetched by id
(`donation-rollups/README.md`, "Archived donations and this Worker"). Each year-end archive run
moves another fiscal year off the board. So the Worker keeps its own record of every match it
has ever seen, and judges pairs from that.

Table `matches`: `donation_item_id` (primary key), `person_item_id`, `org_item_id`, `match_date`
(ISO date), `amount_cents` (nullable), `source` (`bootstrap` / `board`), `seen_at`. Only rows that
pass the item filters in "The rule" (Matching Donation, one Matched By, a People Donor, a Date) are
stored; the exclusion list is applied when pairs are computed, not when matches are stored, so
changing the list needs no re-bootstrap.

* **Bootstrap (once, decided 2026-11-16):** a script in the Worker's `scripts/` reads the
  production import's artifacts — `monday-migration/backup/salesforce-import-data-2026-10-31/`
  `transform/payloads.ndjson`, `load/ledger.ndjson`, `load/boards.json` — and emits SQL that
  inserts every Matching Donation with its Donor and Matched By links resolved to Monday item ids,
  the same method as `donation-rollups/scripts/bootstrap-links-from-artifacts.mjs` (ledger replay:
  sfId → item id; skip a gift whose Donor resolves to Organizations or to nothing). Run with
  `wrangler d1 execute … --remote --file`. `INSERT OR IGNORE`, so it is safe to re-run. Those
  artifacts are gitignored and irreplaceable; the script only reads them. The sandbox gets the
  same script against the sandbox load's artifacts, or a small hand-made fixture if those are gone.
* **Nightly board read:** every run upserts what the active board shows (step 3 below), so new
  matches, staff corrections to Donor/Matched By/Date/Amount on active gifts, and hand-entered
  matches all land. A row whose active item no longer passes the filters (Gift Type changed,
  Donor cleared) is deleted. A stored row the board no longer returns is looked up by id: if the
  item is still active, staff cleared its Matched By, and the row is deleted; otherwise it is
  **kept**: it was archived (or deleted — keeping a deleted match costs at most one Draft staff can
  delete). *(Added after the final review, 2026-11-16.)*
* **Stale ids:** post-import merges deleted some People and Organizations items. Before creating a
  Draft, fetch the person and organization items by id (one batched `items(ids:)` read for the
  run's candidates); a candidate whose person or org is missing or not `active` is skipped and
  logged.

### The ledger (D1)

Table `proposals`: `person_item_id`, `org_item_id` (together the primary key),
`affiliation_item_id`, `proposed_status` (`Current`/`Former`), `match_count`, `proposed_at`.
Written **after** Monday confirms the item was created (the repo's cursor invariant: never record
work before the write). If the comment write fails after the item was created, still record the
row — the Affiliation is the proposal; log the missing comment.

A crash between creating the item and writing the row would re-propose next night; the "already has
an Affiliation with that org" check catches that, because the Draft now exists. That check is why
the ledger can't be the only guard, and the ledger is why the board check isn't enough (a deleted
Draft leaves no trace on the board).

### Schedule and shape

Cron-only, once nightly (proposed `0 11 * * *` UTC, after `dtd-sync`'s summary at 10:00; no
dependency on it). No HTTP surface, no queue — a failed run is redone the next night, and the
ledger makes it idempotent. The match history is why a missed night loses nothing even across a
year-end archive: a gift seen once while active stays in `matches`. Each run:

1. Read the write mode once (below).
2. Read the Affiliations board in full (Person, Organization, Status) → set of existing
   (person, org) pairs. ~6,400 items, 13 pages of 500.
3. Read active Donations sparsely: `items_page` with `query_params` Matched By `is_not_empty`,
   columns Gift Type, Matched By, Donor, Date, Amount (the `contact-roles` sparse read). Filter
   Gift Type in code. Use `linked_items { id board { id } }` (or the connect value's
   `linkedPulseIds` with board) to tell a People Donor from an Organizations one. Upsert into
   `matches` as described above. Under `off` this D1 write still happens (it is the Worker's own
   state, not a Monday write).
4. Load the ledger's (person, org) keys.
5. Compute candidate pairs by the rule **from `matches`**; drop excluded payers, existing pairs
   and ledger pairs.
6. Order candidates Current first, then by latest match date descending; walk that list checking
   each candidate's person and org items still exist (above) until `maxProposalsPerRun` (config,
   default 25) live ones are found. A gone candidate doesn't use a slot, so a stale pair can't
   block the queue night after night. *(Changed after the final review, 2026-11-16.)*
7. For each: create the item, record the ledger row, post the comment (evidence from `matches`). One failure logs
   `impact-attribution: proposal <person>/<org> failed …` (ids only, never names or emails — the
   log-safety check) and moves to the next.
8. Log a summary line: matches read, pairs qualifying, skipped as existing / ledger / excluded /
   anonymous / org donor, proposed, left for later runs.

### Write switch

`impact-attribution` joins `IN_SCOPE` in `scripts/check-worker-flags.mjs` with a byte-identical
`src/flags.ts`.

* **on** — as above.
* **off** — dry run: refresh `matches`, compute and log what it would propose, write nothing to
  Monday or the `proposals` ledger. The log carries counts, person/org item ids, and a **payer
  summary**: each Matched By organization that would get a Draft, by item id, with its number of
  would-be Drafts (Organization names are not personal data, so the summary may name them; never
  log a person's name or email). This is how the first-run size is measured and how the exclusion
  list is built.
* **hold / unknown** — skip the run entirely, including the board read. No catch-up needed: the
  next run reads the board again.

### Config (`config/svbc.json`, `config/sandbox.json`)

Validated at startup; `config/split.test.ts` fails if the two share an id.

* `donations`: `boardId`, column titles `giftType`, `matchedBy`, `donor`, `date`, `amount`;
  `matchingGiftLabel` (`Matching Donation`).
* `affiliations`: `boardId`, column titles `person`, `organization`, `status`, `proposedStatus`;
  labels `draft`, `current`, `former`.
* `peopleBoardIds` (live and Historical) and `organizationsBoardId` — to classify the Donor link.
* `rule`: `windowDays` (365), `minMatches` (2), `currentWithinDays` (365).
* `excludedPayers`: Organizations item ids that are not employers (foundations, DAF sponsors), each
  with a `note` naming it (ids are what match; names drift).
* `maxProposalsPerRun` (25).

Columns are found by bare title (`bareTitle`).

### Monday access

`MONDAY_AUTH` service binding to `svbc-monday-auth`'s `SyncToken` entrypoint (sandbox:
`svbc-monday-auth-sandbox`). Add the Worker to the `SyncToken` row in `monday-auth/README.md` and
to whatever `check-monday-auth-bindings.mjs` maps. The canonical `graphql.ts` transport, copied
byte-identical, with 3 in-process attempts; add the path to the `monday-graphql-copies` CI roster.
No queue, so no `outage.ts`.

## Scaffolding (copied, per the root `CLAUDE.md`)

Standard Hono-free cron Worker: `wrangler.jsonc` with `env.sandbox` (own name, D1, FLAGS
namespace, broker), `src/environment.ts` and `config/split.test.ts` copied from `member-portal`,
`src/flags.ts` and `src/monday/graphql.ts` copied byte-identical, D1 migration
`migrations/0001_create_tables.sql` (`matches`, `proposals`), the bootstrap script, README as spec (the repo's per-Worker README shape), a CI
job in `.gitlab-ci.yml` like `contact-roles`', and a row in the root README's "Status at a glance".
The affiliation design spec's mention of `impact-attribution` gets a pointer here.

## Rollout

Ships **off**. Sandbox first: deploy, bootstrap, run dry, check the logged candidates against a
few known people, then `on` and work the Drafts in "Drafts to confirm". Production:

1. Deploy, run the bootstrap against the production artifacts, let one nightly dry run happen.
2. **Gate (decided 2026-11-16): David reviews the dry run's payer summary** and marks which
   organizations are foundations, donor-advised-fund sponsors or other non-employers. Those ids go
   into `excludedPayers` in `config/svbc.json`, deployed. No production `on` before this.
3. One more dry run to confirm the exclusions took and to read the backlog size (history since
   2013 — this number decides whether 25/night is right).
4. `impact-attribution:writes on`. The cap means a large backlog drains over days rather than
   landing at once; staff can raise it in config.

Organizations are matched by item id only. If the same company exists twice ("Google", "Google,
LLC") and an existing Affiliation points at the other one, a duplicate Draft appears; staff delete
it and the ledger keeps it gone. The 2026-10-30 duplicate merge makes this rare. (Decided
2026-11-16, not matching by name.)

## Left to the builder

* Module layout, test structure, naming inside the Worker.
* The exact `query_params`/column-value shape for reading a connect column's linked board.
* The comment's exact wording, within the content above.
* Whether the setup script for **Proposed status** lives in `scripts/` or the Worker's own
  `scripts/`.
