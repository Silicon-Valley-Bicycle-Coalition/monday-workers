# salesforce-import

**Status:** Decided — one-time custom import, not Monday's live Salesforce sync connector.
**Priority:** Blocking. This is the central pre-migration engineering deliverable.
**Owner:** David (decided 2026-09-30, [svbc-monday-migration#49](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-migration/-/issues/49)). The time budget for its cutover runs is in the migration runbook (`docs/23`, Pre-weekend readiness and Timeline).
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
#   transform also writes data/review/email-classification.csv (secondary addresses on a domain
#   that is neither an affiliated org's nor a consumer mailbox — decide each one, copy rows into
#   data/enrich/email-kinds.csv as email,kind,affiliationSfId, re-run transform; a work override
#   naming an affiliation that contact doesn't have is ignored with a warning in the report) and
#   data/review/unaffiliated-org-gifts.csv (org gifts whose primary contact has no Affiliation at
#   that org — create the Affiliation in Salesforce or accept the gift as organization-only).
npm run cli -- load --dry-run       # prints the full per-board plan, writes nothing
npm run cli -- load                 # idempotent; re-run to retry failures only (sequential by default;
                                    #   --batched is opt-in, sandbox-only until its rehearsal passes)
npm run cli -- validate             # reconciliation + data/validate/sample.csv for the admin
npm run cli -- validate --live      # also reads every board back from Monday (see below)
npm run cli -- reconcile            # go/no-go gate: extract vs Monday, per fiscal year and per board
npm run cli -- configure --dry-run  # UI-layer setup: descriptions, groups, columns, saved views
npm run cli -- configure            # idempotent; --only key1,key2 scopes to specific boards
```

**Re-runs never duplicate items.** Every imported item carries its Salesforce Id in a plain-text
`Salesforce ID` column (kept after the migration, unlike `Salesforce Debug` — it's the only
searchable link back to the source record). `create_item` isn't idempotent, so the client never
blindly retries it after a 5xx, a dropped connection or a timeout — the write may have committed.
The loader looks the Id up first and adopts the item if it landed. At the start of each run, any
board that existed before the run and still has unledgered payloads is scanned, and items already
on Monday are adopted into the ledger (the crash window between `create_item` and the ledger
append). Salesforce Ids found more than once are listed in `data/load/report.json`, never
auto-deleted, and make `load` exit 1. A torn final ledger line from a crash is dropped with a
warning.

**Links are complete before a donation archives.** Each link write records the targets it set,
so a link written while some targets were missing is rewritten once they land. A target that this
run's payloads are expected to create but that doesn't exist yet (its create failed) is *pending*,
not "skipped". Pending links hold back archiving and make `load` exit 1 until a re-run resolves
them. Targets that were never migrated at all are still skipped by design. `data/load/report.json`
records per-run counts: created, adopted, failed, written/partial/pending/skipped links, and
archived/deferred items.

**Batched load (#22) — opt-in, not the default.** Plain `load` runs the pre-#22 sequential path
(one `create_item` per request, one at a time, the pre-#22 Monday client) and prints
`load: mode = sequential (default)`. **`--batched` must not be used against production until
every step of the rehearsal checklist below has passed on the sandbox account.** `load --batched`
prints `load: mode = batched (size 10, concurrency 3, inline links on)`. It sends 10 aliased
`create_item`s per request (`--batch-size N`, max 25) with 3 requests in flight
(`--concurrency N`, max 8; separate links and archives are aliased `--batch-size` to a request too, #50), and puts a payload's board-relation values straight into its `create_item` when every
target is already on Monday — which covers nearly all Donation relations (Donor, Campaign,
Recurring Gift, Matched By, Soft Credit) and most other boards' links. A relation only counts as
written when `create_item`'s response echoes it back; anything else (a target still to be created,
an archived target, an unconfirmed echo, an adopted item) goes through the separate link pass with
all of #21's pending/archive rules, and `validate` checks the same ledger entries either way. A
shared gate reads each response's `complexity` budget and pauses new batches before it runs out;
the client waits Monday's `retry_in_seconds` on complexity and rate-limit errors.

Duplicate safety: any entry in a batch whose outcome isn't a confirmed id is looked up by
`Salesforce ID` (one request for the whole batch, after `load.recoveryLookupDelayMs`), and found
items are adopted. **In batched mode an ambiguous create is never re-sent in that run, whatever the
request size (one item or 25)**. That covers a timeout, 5xx, network error, cut-off response body,
whole-request error or null alias: Monday can keep committing after the client gives up, and search
can lag, so a miss proves nothing. The entry is ledgered as failed, `load` exits 1, and **the next
`load` run's start-of-run board scan adopts whatever landed and creates the rest**. An error under
an alias's read-back (its `column_values`) means the create committed and only its id was lost; it
is looked up and adopted, and if not found yet it isn't re-sent either. A
definitely-rejected alias is never re-sent, except that an entry Monday rejected *itself* (error
path = the alias, in a response with data) while it carried inline relations is retried once
without them (`links.inlineRejected`), and the link pass writes those. If the lookup itself fails,
nothing is re-sent. A crash mid-batch is recovered by the same start-of-run scan. Monday's
`DAILY_LIMIT_EXCEEDED` fails requests at once and is never retried.

**Duplicate read-back:** in batched mode, every board (and every donations fiscal year, before it
archives) is read back by `Salesforce ID` right after its creates. Any Id Monday holds more than
once is printed as `load: DUPLICATE <board>/<sfId> …`, listed under `duplicates` in
`data/load/report.json`, and makes `load` exit 1. It's never deleted; remove the extras by hand.
If a read-back itself errors, it's printed as `load: READ-BACK FAILED for <board or FY> …` and
recorded under `readBackFailed`. The link and archive phases still run, and `load` exits 1: that
board wasn't checked, so re-run `load` (or `validate --live`) before trusting it.

```sh
npm run cli -- load --dry-run                     # per-board plan + old vs --batched request counts and hours
npm run cli -- load --dry-run --request-ms 1100 --create-ms 435 --link-ms 700 --archive-ms 760  # override the measured cost defaults
npm run cli -- load                               # DEFAULT: the pre-#22 sequential path, unchanged
npm run cli -- load --sequential                  # the same thing, spelled out
npm run cli -- load --batched                     # SANDBOX ONLY until rehearsed: 10 per request, 3 in flight, inline links
npm run cli -- load --batched --batch-size 25 --concurrency 4   # tune on top of --batched
npm run cli -- load --batched --no-inline-links   # batch creates, but write every relation separately
```

**Cutover-weekend fallback:** if a `--batched` run misbehaves (unexpected Monday errors, relations
not sticking, complexity trouble), stop and re-run plain `load` (the default; `--sequential` is the
same). It uses the same ledger, so it resumes where
the batched run stopped. It's the code path every rehearsal before #22 ran: the same create loop
and the same Monday client (`MondayClient` `legacy`/`gqlLegacy`, a verbatim copy). It keeps the old
lookup-then-retry rule for an ambiguous create, up to 3 attempts, and no duplicate read-back.

**Budget a follow-up `load` run.** Every ambiguous batched outcome, at any request size, leaves
its items for the next run rather than retrying them in place. So after any batched run that exits
1 with "not re-sent this run" failures, run `load --batched` again (plain `load` works too). Its start-of-run scan adopts what landed,
creates the rest, and should finish at 0. Plan for at least one such extra run on cutover weekend.

`--batch-size`, `--concurrency` and `--no-inline-links` also work without `--batched`. Any
combination other than exactly `--batch-size 1 --concurrency 1 --no-inline-links` (the default)
runs batched, and the mode line says so. `config/svbc.json`'s `load` block holds the sequential
default. `load --dry-run`'s "new" figures always describe `--batched` (or the batched settings you
pass), even though the default run is sequential.

The dry-run estimate treats Monday as serialised (#50): it runs mutations one at a time across the
whole account, so a bigger `--concurrency` or link pool only queues requests and adds nothing.
Time is `requests·R + creates·c + links·l + archives·a`, where every request pays the overhead R once
however many mutations are aliased into it, and each mutation pays its own type's cost. Defaults, from
the full-size Donations (sandbox v3) board: R = 1100 ms, c = 435 ms, l = 700 ms, a = 760 ms (override
with `--request-ms`, `--create-ms`, `--link-ms`, `--archive-ms`). In batched mode links and archives
are aliased `--batch-size` to a request like creates, so they pay R once per batch; the sequential
default sends one mutation per request. On the 2026-09-15 transform output that puts `--batched`
at ≈ 26.7 h; expect ±20%, and complexity-budget waits are not modelled. `MondayClient.stats()`
counts requests, retries by reason, backoff and peak in-flight, and `scripts/probe-pools.ts`
re-measures the costs on a sandbox workspace.

**Rehearse the batched path against the sandbox Monday account before cutover** (every step uses
`--batched`; until all pass, production loads stay on the default):
1. A full `load --batched`: `report.json` shows `links.inlineUnconfirmed` and `links.inlineRejected` at
   0, there are no `DUPLICATE` lines, and `validate --live` passes (0 missing, duplicated or
   unexpected).
2. Spot-check donations' Donor, Campaign, Recurring Gift, Matched By and Soft Credit in the UI.
3. Kill a `load --batched` run mid-board and re-run it with `--batched`: every item is adopted and none duplicated.
4. If a `--batched` run exits 1 with "not re-sent this run" failures, the next run must adopt or create them
   and finish at 0. Confirm that happens, and budget for that extra run on cutover weekend.
5. Resume a partial `--batched` ledger with plain `load` (the sequential default).
6. Re-run `load --dry-run` (with `--request-ms` and the per-mutation flags set from the measured
   timings) and decide whether production uses `--batched`.

**Rehearsal results, 2026-10-09.** Measured 2026-10-06 → 09 against fresh `(batched rehearsal)`
boards in the sandbox workspace, from the 2026-09-08 extract, at the defaults (size 10,
concurrency 3, inline links on). The final state matched the dry-run plan exactly: 96,007 items,
110,013 links, 44,783 archives. **The checklist has not yet passed** — steps 1, 2 and 5 are still
open — so the rule above stands: `--batched` stays off production.

| Step | Result | Detail |
|------|--------|--------|
| 1. Full load, inline counts at 0, `validate --live` clean | Not clean as written | `links.inlineUnconfirmed` 3 and `links.inlineRejected` 2 (the step asks for 0; the link pass wrote all five). No `DUPLICATE` lines, `readBackFailed` empty. `validate --live` clean on every board (0 missing / 0 not in ledger / 0 duplicated / 0 untagged); ledger-coverage, link-integrity and archive-coverage OK. |
| 2. UI spot-check of donation relations | Not done | |
| 3. Kill mid-board, re-run `--batched` | Passed | Run 1 killed mid-FY2019; run 2's start-of-run scan adopted 120 items and duplicated none. |
| 4. "Not re-sent" items adopted or created next run | Passed | Run 2 exited 1 with 110 not re-sent; run 3 created all 110, 0 duplicates, exit 0 in 5 min. 180 ambiguous creates across the three runs (0.19%), all resolved. |
| 5. Resume a batched ledger with plain `load` | Not run | |
| 6. Re-estimate with measured timings | Run | `load --dry-run --latency-ms 1500 --alias-ms 1650` → batched ≈ 21.1 h, sequential ≈ 66.3 h. The batched figure was low because that formula assumed parallel link and archive passes; Monday serialises mutations (#50), and the current model gives ≈ 26.7 h batched with aliased links and archives. |

Run 1's 629 archive and 6 link failures were all "fetch failed" network errors on the operator
machine (its proxy dropped connections, and it slept for part of the run); every one retried clean
in run 2.

Throughput: creates sustained ~105–115 items/min, which from 3 lanes of 10-item requests gives
α ≈ 1,650 ms per extra alias, not the 765 ms placeholder. The link pass managed 49 links/min and
the archive pass 24–41 archives/min — one request every 1.2–2.5 s, i.e. effectively one in flight,
not the 6 and 3 the estimate assumes — while `{ complexity }` showed the account at 9.6M of its
10M budget. No run's wall-clock is a valid timing: the operator Mac slept for long stretches of
runs 1 and 2 with no `caffeinate` held, so the figures above are 2–4 minute samples taken while
the ledger was advancing. Projected from those rates, a clean end-to-end batched load of this
dataset is on the order of 55–65 h (creates ≈ 14.5 h, the non-Donations link pass ≈ 17 h,
archives ≈ 18–30 h), not the 14–21 h the dry-run prints. A timed re-run must stay awake: AC
power, `caffeinate -s`, lid open.

**`validate --live`** doesn't trust the ledger. It scans each board's active items by
`Salesforce ID` and fails on items the ledger expects but Monday lacks, items Monday has that the
ledger doesn't, and duplicated Ids. It needs a fresh full load (the cutover procedure): items
created before the `Salesforce ID` column existed carry no Id, so on older rehearsal boards they
count as "without a Salesforce ID" and their ledger entries as missing.

**`configure`** applies the API-doable subset of the board-configuration plan (private repo:
`docs/22-board-configuration-plan.md`) — board descriptions, the default-group rename, additive
columns, column descriptions, and saved table views with filters — against whatever board ids are
in `data/load/boards.json` (sandbox or production, whichever `load` last ran against). It's
idempotent and non-destructive: an already-set description or column description is left alone
rather than overwritten, a column already on the board (including Stakeholder Type, which `load`
normally creates because `transform` seeds it — see "What the script must resolve") is skipped,
and a view is only created if no view of that name exists yet. Run it
after `load`'s `ensureBoards` pass and before staff get access, same sequencing docs/22 §5
specifies. Deliberately **not** scripted (see `src/configure/spec.ts` header): automations (no
public API to create them), the Documentation doc view (no API for doc-kind views), stripping
Monday's stock status labels (data-safety — do it by hand per docs/22 §2.5), Subitems-column
deletion and hide-plumbing view settings (both UI-only in the plan), the Donations Fiscal Year
column removal (a guarded one-off, not repeatable structure), and the Acknowledgment Tier
backfill (a data operation, not board configuration).

The `dashboards` step (`--only dashboards`) also creates the Development, Membership, and Board
Report dashboards with their chart/number widgets in `monday.workspaceId`. What it created is
remembered in gitignored `data/load/dashboards.json`, so reruns skip existing dashboards and
widgets (delete a widget's entry there to recreate it). One board outside the board map is read
from gitignored `data/load/extra-boards.json`, e.g. `{ "annual-giving-summary": 18431966690 }`.

The `overviews` step (`--only overviews`, or a board key such as `--only people-live`) creates an
**Overview** dashboard view on each board that has an entry in `src/configure/overviewSpecs.ts`.
It uses the ordinary `MONDAY_API_TOKEN`; no dashboard-rights user is needed. An Overview is created
whole or not at all, because widgets added to a board-view dashboard after it has been opened do not
render, so a widget that can't resolve (a missing column or label) stops the whole Overview and makes
`configure` exit non-zero. An existing view named `Overview` that `configure` did not make is
adopted and left exactly as built. What it created is remembered in `data/load/dashboards.json`
under `overview:<board key>`; a run that dies midway is repaired on the next run by replacing the
half-built view. Pinning the Overview as a tab, and widget size and position, have no API and stay
manual (private repo: `docs/22` §5).

`--rebuild-overviews people-live,organizations` deletes and recreates the named boards' Overviews
whole (explicit board keys only, never `all`), which also replaces a hand-built one. A new view has
no pin and default widget sizes, so the output lists what is left to do by hand. The plan for a
board is computed before anything is deleted, so a refused plan never removes a view. The flag is
not idempotent: rerun it with only the boards that failed, or finished boards are rebuilt again and
lose the pin and sizes you gave them. It is also the repair for one edge case: if a `create_view`
call commits but its response is lost, the next run finds an Overview it has no record of and
adopts it as hand-built, leaving it empty until it is rebuilt. It is normally paired with
`--only <the same board keys>`, since without `--only` it also re-applies every board's views and the
workspace dashboards (idempotent, but slow and noisy).

Fiscal-year widgets (`@FY` and `@FY-1` labels, `{ fiscalYear: 'current' }` date ranges) are resolved
from the clock on every run, in Pacific time, so a July run needs the `Gift Fiscal Year` column to
already hold the new year's label (`classify` creates it); otherwise the Donations Overview is
refused and `configure` exits non-zero.

The dashboards step's `create_dashboard` / `create_widget` mutations are refused (403) for the
integration user, so they use `MONDAY_DASHBOARD_TOKEN` (a token for a user allowed to create
dashboards) when set, else `MONDAY_API_TOKEN`. Saved-view create/update calls use API-Version
2026-10 (needed for conditional formatting); everything else stays on the pinned 2026-01.

**Sandbox week:** set `monday.boardSuffix` to `" (sandbox)"` in config, and delete `data/load/`
between full rehearsals. A run against a partial `payloads.ndjson` (e.g. a partial extract, not
`load --limit N`, which only caps items per board and never drops a board from the run) can create
connect columns without board defaults if a link's target board has zero payloads that run, and a
later full run does not retroactively patch them — run a full `--dry-run` first, and delete
`data/load/` between sandbox rehearsals rather than layering partial runs on top of each other.
The 2026-09 email-column rename (Email → Personal Email, etc.) makes this mandatory, not just
recommended: a load that reuses an existing ledger after the rename only retitles the column going
forward — it never rewrites pre-existing People items — so those items are left holding old-semantics
values under the new title while newly created items hold new-semantics values under the same title.

**Cutover:** freeze Funraise sync first (doc 03 §7), delete `data/load/` (boards.json + the
ledger) — sandbox board ids and ledger entries left over from rehearsals would otherwise redirect
writes to the sandbox boards or suppress them entirely, since the ledger would report those items
as already loaded — re-run `extract` fresh, then keep `data/` as the migration audit artifact
alongside the backup archive.

**Backup-only extracts** (`backupOnly: true` in `src/extract/queries.ts`) are written to
`data/backup/*.ndjson` by `extract` and never read by `transform` — they exist so the archive is
complete, not so anything lands on a board. Today: `ContactHistory`, `CampaignMember`, `Lead`,
every `Task` and `EmailMessage` (the Activities board gets only the recent slice), NPSP payments
(#23) and `npe4__Relationship__c`, plus — decided 2026-09-30 in the private planning repo's
issue #53 — the sponsor benefit-fulfillment cluster (`Sponsorship_Level__c`,
`Sponsorship_Package__c`, `Sponsor_Benefit__c`, `Benefit__c`; ~2,046 rows) and the Bike to Work
Day logistics objects (`BTWD_Order__c`, `Energizer_Station__c`). Each of those six selects every
custom field the schema reference lists plus Id, Name, record type and system dates; none is
near the CLI's 50k ceiling, so none is paginated.

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
Activities board; `npe5__Affiliation__c` as its own **Affiliations** board (one item per
person-at-organization tenure: Affiliation Role, Status, Start/End, Primary, and the Work Email that
address-classification assigns to it, with its own consent status); People carry **Personal
Email** and **Household Email**, each with its own consent status, plus **Household Primary** for a
shared address; Donations and Event Registrations carry **Acting for** (→ Affiliations) and
**Attribution** (Auto / Staff / Needs review / None), attributed at import from NPSP's org-gift
shape and from registration emails — and an attributed org gift's **Donor** is the organization
(the person stays reachable through Acting for), so Lifetime Giving is personal giving and
Organizational Giving is driven giving, with no overlap; design in
`docs/superpowers/specs/2026-09-08-person-org-email-model-design.md`; and a `ContactHistory`
flat export (68,831 rows) into the backup archive.

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
  **Exception (2026-09-08):** NPSP only stamps that field when its own trigger creates the Account,
  so blank-type Accounts created first and given a Contact afterwards — the 2013 bulk load and
  Click & Pledge's Account-then-Contact writes — are people with no stamp. `transform` folds a
  blank-type Account into its Contact when every attached Contact shares the Account's name
  (`personNamedAccountIds`, 204 in the live org, 172 of them `C&P Online`): no Organization item,
  and gifts/links booked against the Account re-point at the person. `enrich` skips them too.
  Blank-type Accounts with no Contact, or a differently-named one ("Smith Family"), still land on
  Organizations — a human review list is the follow-up if that residue matters.
* **Partner-type reconciliation** — cascade `Type` → `Type_2__c` → `Industry`; ~1,212 organizations
  have none of the three set and need the Pre-Migration Deliverables' manual classification pass
  completed before the script can consume it.
* **Stakeholder Type for individuals** — the same classification need, widened to all 49,749
  people (Individual Donor / City or Agency Staff / Elected Official / Partner Org Contact), per
  Unique Advocacy-Specific Needs. **Seeded at import (#46):** `extract` selects
  `Contact.Elected__c` and `transform` writes `Stakeholder Type = Elected Official` on the 366
  contacts that have it set (on whichever People board they land — the classification is a fact
  about the person, not the board), and nothing on anyone else. Because `load` creates every
  column a payload names, the status column comes into existence at load time with the full
  four-label set (`STAKEHOLDER_TYPE_LABELS` in `src/load/boards.ts`, which `configure`'s spec
  imports so the two can't drift), and `configure` then finds it present and leaves it alone.
  The other three labels have no Salesforce source — City or Agency Staff in particular is a
  Monday-side seed from the reviewed `find-city-agency-staff` CSV — so they start empty.
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
  real relationship — ever a donor, member, event registrant (Funraise, or checked in via Eventbrite), volunteer, Funraise supporter, or
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
  per-contact bike-lane map, local news links, advocacy geography filtering). An address with no
  street, or one neither geocoder matches, takes City and Zip (ZIP+4 cut to five digits) from
  Salesforce's own Mailing/Billing fields instead, and has no `lat`/`lng`. Nominatim was
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
  adds those back when reconciling `eventbriteAttendees`). **People inclusion counts a Funraise
  registration or an Eventbrite check-in, not a bare Eventbrite registration** (decided 2026-09-08
  after the real transform measured 4,308 Eventbrite Contacts pushing both People boards past the
  10k ceiling — only 859 of them ever checked in; the rest are free-class no-shows and
  cancellations, treated like email-list-only contacts). A counted registration for an event on or
  after `peopleActiveSinceISO` makes the Person *live*, not just included. Attendee rows land on
  Event Registrations either way; the Attendee link is skipped at load when the Contact isn't a Person.
* **Field mapping** — Donations ← Opportunity, Recurring Gifts ← `funraise__Subscription__c`
  (Pledge folds in as columns — confirmed 1:1 duplicate, do not create a separate Pledges board),
  People ← Contact, Organizations ← Account, Events / Event Registrations ← both event platforms
  (previous bullet). Full column-by-column mapping, status-value
  mapping (`Posted` is the real success stage, not `Closed Won`), and the do-not-migrate list
  (payment-method PII, `funraise__Error__c`, `_Display__c` formula fields, test events, the
  `Redacted` subscription) are all in
  `docs/03-monday-migration-mapping.md` (private planning repo) — treat
  that document as the authoritative field mapping for this script, not a summary of it.
* **`Closed Won` is not a retired stage — decided 2026-09-30 (#43, migration issue #56).** The
  `eb4sf` Eventbrite package still writes every paid ticket order as a `Closed Won` Opportunity
  under the `SVBC Integration` user (211 records / $14,751.94 with `CloseDate` ≥ 2025-07-01 in the
  2026-09-08 extract; none has a Funraise ID). Ticket revenue counts as giving, so `transform`
  maps a `Closed Won` gift **created by `eventbriteIntegrationUserName`** (`config/svbc.json`)
  to Status `Received` with Gift Type `Event Ticket` — the same label `funraise-sync` writes for
  its paid events, so keep the two configs in step — and seeds Lifetime Giving / Gift Count with
  it (`transform/rollups.ts`), as `donation-rollups` will once it recomputes on `Received`. The
  138 `Closed Won` gifts individual users keyed in stay `Received (Historical)`, excluded from
  revenue as before. The discriminator is `CreatedBy.Name`, not the "… Eventbrite" name suffix
  (the package stamps the user on every order; the name is an editable template). No new SOQL
  field and no re-extract: `CreatedBy.Name` has been on the Opportunity query since the extract
  stage first shipped (`7e9def2`, 2026-08-22), so every `data/extract/` this script ever wrote
  already carries it — but the mapping only lands after `transform` is re-run against it, so
  re-run `transform` before the next `load`. **Follow-up, not done here:** the FY2026 reconciliation (migration `docs/16`, and §9
  of the 2026-09-29 spec, which show Individual Giving $11,940.52 under Salesforce) must be
  re-run on the sandbox after the next load to confirm the gap closes.
* **Eventbrite Order ID on migrated ticket gifts (2026-10-19).** The `eb4sf_orders` extract
  (`eb4sf__Eventbrite_Order__c` linked to an Opportunity; the record `Name` is Eventbrite's order
  id) lets `transform` stamp `Eventbrite Order ID` on each linked gift, so `eventbrite-sync`'s
  webhook and Summit backfill adopt the migrated item instead of duplicating it — needed since
  the cutover moved past Bike Summit 2026. The column is declared on every gift, so `load` creates
  it. Live counts on 2026-10-19: all 133 Eventbrite-created `Closed Won` from 2026 link an order;
  206 from 2024–2025 don't and stay blank. **This one does need a re-extract**: `transform` warns
  and stamps nothing when `data/extract/eb4sf_orders.ndjson` is missing.
* **Opportunity audit fields and fee-coverage folding (2026-10-26).** The audit in migration
  `docs/32` found Opportunity fields in active use that never reached Donations. Six new columns,
  each declared on every gift so `load` creates them: **Finance Class** and **Revenue Code**
  (`Finance_Class__c` / `Finance_Revenue_Code__c`, staff's accounting coding on ~8,100 gifts from
  2020 on), **Payment Method** (20,983) and **Check/Reference Number** (5,959), **In-Kind Value**
  (`Retail_Value__c`, 993; 115 posted in-kind gifts carry $345k there with a blank or $0 Amount)
  and **In-Kind Category** (645). Amount itself is unchanged for in-kind gifts. Separately, the
  2,166 Funraise fee-coverage splits (`Funraise_Fee_Match_Opportunity__c`, $0.12–$20 each) are
  folded into the gift they belong to — same donor, same `CreatedDate` second, same stage, split
  Amount = the gift's `Funraise_Fee_Match_Amount__c` — before anything else reads Opportunities
  (`foldFeeCoverage` in `transform/donations.ts`). The gift's Amount becomes gift + fee, so
  Lifetime Giving and the per-FY reconciliation totals don't move, and the new **Fee Covered**
  column records the fee part; Gift Count drops by the number folded. `reconcile` folds the same
  way. A split with no matching gift stays a gift of its own and `transform` reports the count.
  **Needs a re-extract**, since the opportunities query gained the fields.
* **Lost status (decided 2026-10-26, migration `docs/32` decisions 5 and 6).** Donations Status
  gains a fifth label, **Lost**, seeded with the rest at board creation. Closed Lost and Withdrawn
  on the pipeline record types (Sponsorship, Grants, Contracts, Membership, In Kind Donation /
  Sponsorship, Commute Workshop, Driver Training) are Lost; Donation and Matching Donation keep
  Failed. Any gift still at an open stage (Prospecting, Pledged, Invoiced…) whose close date is
  before the first fiscal year kept active on the board (`archiveCutoffFY`: FY2026 for an
  October 2026 cutover, ~620 gifts) is Lost too, instead of sitting in Pending for good.
  `transform` prints the Lost count. Lost counts toward nothing and is outside the "Failed and
  pending" worklist. On a Donations board created before this change, the load's
  `create_labels_if_missing` adds the label the first time it writes one.
* **Employer matching gifts (Benevity) — decided 2026-09-08.** The "Matching donations" stream is
  Benevity disbursement CSVs keyed in by hand (3,020 Opportunities of record type Matching
  Donation), not 360MatchPro, whose `dtd` package holds zero records — nothing of it migrates, and
  `Employer Name` on People comes from `Employer__c` (10,354 populated), not `dtd__company__c`.
  Three things this script does so the post-cutover `benevity-import` Worker has columns to
  write into: (1) a **Matched By** connect column (→ Organizations) on Donations, filled from
  `AccountId` on every Matching Donation whose Account is an organization — the Donor link takes
  the Primary Contact, so before this the paying company was dropped on the 2,182 matched gifts
  that have one; (2) the placeholder "Anonymous Person" Contact and its household Account
  (`placeholderDonorSfIds` in config) are not emitted as items, and the 741 Opportunities that
  point at them migrate as Anonymous Donor = checked with no Donor link (and no fallback to the
  Account); (3) a blank **Benevity Transaction ID** text column, declared on every donation
  payload so `load` creates it — Salesforce never stored the id, so the Worker's first upload
  must be the first disbursement after the data freeze. See the plan's Benevity section and
  `../benevity-import/README.md`.

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
failed-to-migrate records) — approved by SVBC's Deputy Director 2026-09-25, with a second or third
cutover weekend available if the first attempt fails.

### `reconcile` — the post-load go/no-go gate

`validate` checks the load against its own ledger. `reconcile` checks it against the source:
it recomputes what must be on Monday from the frozen extract (`data/extract/`) and compares
that with what Monday itself reports. It only reads from Monday. Exit 0 means **GO**, 1 means
**NO-GO**. The full report goes to `data/reconcile/report.md` (Markdown tables you can paste
into the cutover log) and `data/reconcile/result.json`.

| Check | Salesforce side (frozen extract) | Monday side (read back) |
| --- | --- | --- |
| `extract-matches-transform` | every Opportunity plus the Click & Pledge transactions that aren't already an Opportunity | the donation payloads in `data/transform/` (catches a transform that's stale against the extract) |
| `donations-by-fiscal-year` | gift count and Amount sum per July–June fiscal year, by `CloseDate` / transaction date | the same, bucketed from each Donations item's `Date` and `Amount` |
| `donations-by-salesforce-id` | each gift's Amount and fiscal year | gifts that landed once but with a different Amount or fiscal year |
| `board-<key>` | payload count per board | items per board, active plus archived. Salesforce Ids missing, duplicated, or not from this extract |
| `top-N-donors` | Lifetime Giving and Gift Count the importer derived from the extract (Posted Opportunities and Eventbrite ticket orders, plus unique Click & Pledge, credited as the Donor link is) | the same columns on the owner item, which `donation-rollups` maintains |

```sh
npm run cli -- reconcile                    # top 25 donors, boards from data/load/boards.json
npm run cli -- reconcile --top 50 --boards path/to/boards.json
```

How it works:

* **Figures come from the extract.** Nothing is hard-coded, unlike the `reconciliation` block in
  `config/*.json` that `validate` uses. Re-running `extract` and `transform` moves the expected
  figures with them.
* **Items are matched by Salesforce Id.** The Id comes from the `Salesforce ID` column, or from
  the `SF ID: …` prefix of `Salesforce Debug` on boards loaded before that column existed. A
  board with neither (e.g. activities) gets a count-only comparison.
* **Items with no Salesforce Id are reported, not compared.** These are items added on Monday
  after the load, for example by a live sync. Run the gate before the sync Workers go live and
  this count should be 0.
* **Archived items are read by id.** Monday's API can only list active items, so the ledger's
  item ids are the index to archived gifts, which is most of the donation history. Only the ids
  come from the ledger. Board, state, Salesforce Id, Amount and Date are all read from Monday,
  and ids Monday reports as deleted or on another board count as missing. A duplicate that was
  created and then archived without a ledger entry is the one case it can't see. `load` only
  archives ledgered items, so that case shouldn't arise.
* **Duplicates count twice.** A duplicated gift adds its Amount twice to its fiscal-year total,
  so it fails the fiscal-year check as well as its board check.

A sandbox run against the ~60k-item rehearsal load takes about 15 minutes, mostly spent reading
~45k archived donations 100 at a time.

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
