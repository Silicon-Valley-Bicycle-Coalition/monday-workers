# donation-rollups

**Status: repointed at the single archive-in-place Donations board ("sandbox v2"), 2026-08-31** —
config now targets ONE Donations board (id `18428131791`, with a real `fiscalYear` column at
last) plus the three v2 owner boards, replacing the 9-era-board layout that docs/20 in the
private planning repo retired. D1 re-bootstrapped from `salesforce-import`'s run artifacts
(37,286 donation→owner links — see `scripts/bootstrap-links-from-artifacts.mjs` and "Why the
bootstrap reads artifacts now" below), owner boards provisioned with the full 12-column rollup
set (`scripts/setup-owner-columns.mjs`). Webhooks drop from 18 subscriptions to 2
(`create_item` + `change_column_value` on the one board, shared secret in the URL — Monday
doesn't sign payloads); subscribe/prune via `scripts/setup-webhooks.mjs` after deploying the
Worker with the matching `MONDAY_WEBHOOK_SECRET`. **Scoped entirely to the CRM Sandbox** —
every board id in `config/svbc.json` is a sandbox board, not a production one (production
doesn't exist yet; real cutover is October), so nothing this Worker does can touch live donor
data. The era-board deployment was verified end-to-end 2026-08-25 (webhook → D1 → queue →
consumer → Monday fetch → recompute → write-back, correct cross-board totals); re-verify the
same flow against the v2 board after the webhook cutover.

**Archived donations and this Worker:** most gifts on the v2 board are archived in place.
Archived items reject all writes and their `board_relation` columns read empty, but they remain
readable by id — which is exactly what the recompute path does (`items(ids: [...])`), so
historical gifts still count. Corollary: `donation_links` rows for archived donations can never
be re-derived from Monday — the importer's artifacts are their only source (docs/20).
**Priority:** Post-migration, non-blocking — the initial correct values ship as part of
`salesforce-import`'s one-time load; this Worker is what keeps them from going stale afterward.
**Owner:** Unassigned.
**Stack:** Hono + TypeScript + D1 + Cloudflare Queue (`npm create cloudflare@latest`).

## The ask

`salesforce-import` computes `Lifetime Giving`, `First Gift`, and `Gift Count` once, at migration
time — correct on day one, but static. Everything else NPSP's legacy rollup engine used to keep
current — **This Year / Last Year giving, Largest/Smallest/Average gift, Last Gift date and
amount** — has no Monday-side equivalent at all once Salesforce retires, and none of the six
fields above stay accurate as new donations come in after cutover unless something recomputes
them. This Worker is that something: it recomputes a donor's (or org-donor's) full rollup set
every time one of their Donations changes, live, not on a nightly batch — a permanent fix for the
"stale by up to a day" problem the old NPSP rollups had, not just a one-time replacement of it.

Full background: `docs/07-migration-gotchas.md` gotcha #10, `docs/05-migration-script-requirements.md`
§8 (private planning repo).

## Data flow

```
Monday.com (the single Donations board — config/svbc.json)
  │  webhook, on Donation item create / column change
  ▼
Cloudflare Worker (webhook handler)
  │  1. echo the challenge verbatim during webhook-subscription setup (one-time handshake,
  │     needed once per subscribed board — Monday webhooks are board-scoped)
  │  2. upsert into D1 `pending_recomputes`, keyed on the *Donation item id* plus which
  │     board it came from — a later event for the same donation replaces the pending
  │     row instead of queuing a redundant duplicate
  │  3. enqueue a Cloudflare Queue message referencing the donation item id + board id
  ▼
Cloudflare Queue → consumer Worker
  │  1. resolve the Donation's linked owner (Donor or Organization item) using *that
  │     board's own* column ids (kept per-board in config, since every Monday board has
  │     independently generated column ids)
  │     — no owner linked yet → nothing to recompute, ack and skip (not a retry candidate)
  │  2. record this donation→owner link in D1 `donation_links` (the reverse index — see
  │     "Why a D1 reverse index" below for why this exists at all)
  │  3. ask Monday which board the owner itself lives on (People / People Historical /
  │     Organizations — three separate boards, three independent column-id namespaces)
  │  4. read every donation id `donation_links` has on record for this owner, grouped by
  │     which Donations board each one lives on, and fetch those specific items by id
  │  5. recompute the full rollup set from scratch (not an incremental delta — see below)
  │  6. write all twelve fields back in one change_multiple_column_values call
  │  on failure at any step, Queues retries automatically and, once exhausted, routes to
  │  a Dead Letter Queue instead of a donor's totals silently drifting out of date
  ▼
People / People (Historical) / Organizations board (ids + column ids in config/svbc.json)
```

## Why a D1 reverse index — the sandbox test that changed the design

The obvious design — filter the Donations board by its Donor connect column, server-side —
**doesn't work**. Confirmed directly against the CRM Sandbox, 2026-08-24:
`items_page_by_column_values` rejects `board_relation` columns outright
(`"Column of type board-relation is not yet supported as a filter"`), and
`get_column_type_info` confirms there's no supported filter for that column type at all
(`filter: null`). The only alternative that returns *anything* — `items_page` with a text match —
matches against the linked item's **rendered display name**, not its id. Unsafe here: this data
has confirmed donor name collisions (seven "Michael Smith"s, etc. — see `docs/10` in the private
planning repo), so a name-based match would silently merge two different people's giving.

A fresh mirror/connect-back column on the Donor board doesn't solve this either — tested that too:
creating one doesn't retroactively populate from the ~40,000 already-existing forward links: it
starts empty regardless of what already points at that item from the other side.

So this Worker keeps its **own** reverse index instead of asking Monday to filter for it:
`donation_links` (donation item id → owner item id, grouped by which Donations board it's on),
populated incrementally as webhooks arrive and bootstrapped from `salesforce-import`'s run
artifacts via `scripts/bootstrap-links-from-artifacts.mjs` before this Worker can be trusted for
a real donor's totals. Recompute then fetches specific donation ids directly
(`items(ids: [...])`, which *does* work — even for archived items — no filter needed) instead of
asking Monday to find them.

**Why the bootstrap reads artifacts now.** The original `scripts/bootstrap-links.mjs` (kept for
reference) walked the boards with `items_page` — impossible under archive-in-place, where most
donations are archived: `items_page` never returns archived items, and an archived item's
`board_relation` column reads empty anyway. The importer's `payloads.ndjson` + `ledger.ndjson` +
`boards.json` are the authoritative donation→owner record including every archived gift, which
is why doc 20 treats those artifacts (and their durable copies in the private planning repo's
`rehearsal-artifacts/`) as infrastructure, not migration leftovers.

**Full recompute, not incremental.** Every run re-pulls and re-sums *all* of an owner's Donations
rather than adjusting a running total. Simpler, self-healing (a missed webhook or a bad prior
write can't compound), and correct at SVBC's donation volume — an owner with dozens to low
hundreds of gifts is a cheap query, not hundreds of thousands. Revisit only if per-owner Donation
counts grow enough that this stops being cheap.

**No coalescing across donations for the same owner.** Two Donations for the same donor changing
within moments of each other queue two independent recompute jobs, not one. Each is a correct,
idempotent full recompute on its own — mildly redundant work, not a correctness bug — so this
wasn't worth the added complexity of a per-owner dedup layer for v1.

**Bootstrap history.** 2026-08-25: first bootstrap from the era boards via the API walker
(37,278 links, 9 boards, 7,893 owners; Dan King spot-check exact). 2026-08-31: re-bootstrapped
for the single v2 board from the archive-in-place rehearsal's artifacts — **37,286 links, all on
board `18428131791`** (17 anonymous gifts and 11,231 excluded-owner gifts skipped by design),
`pending_recomputes` cleared. Re-run `bootstrap-links-from-artifacts.mjs` (then
`wrangler d1 execute svbc-donation-rollups --remote --file bootstrap.sql -y` — the `-y`
matters: without a TTY, wrangler's confirm prompt silently cancels with exit 0) after any fresh
load, since item ids change between loads.

## Ledger v2 + the custodian (docs/20 §5.1/§5.3)

D1 is the **authoritative gift ledger**, not just a reverse index: `gifts` (one row per gift —
amount in cents, date, fiscal year, status, provenance, archived state) and `annual_summaries`
(one row per closed fiscal year, restatement-stamped). Monday stays the working surface; staff
edits flow back via webhooks, and every recompute re-asserts the facts of every gift it reads,
so the ledger self-heals. Bootstrap: `scripts/bootstrap-gifts-from-artifacts.mjs` (37,286 gifts
loaded 2026-08-31; 32,739 Received, 33,541 archived).

The **custodian** runs four duties from one daily cron (09:00 UTC; `dutiesForDate` gates them)
and mirrors each as an authenticated route — `POST /custodian/run/{archive|capacity|sweep|reconcile}?secret=…`
and `GET /custodian/status` (last run per duty, from `custodian_runs`):

* **archive** (July 15 + on demand) — archives active gifts past the retention window
  (`custodian.activeFiscalYears`), then materializes closed-year summaries. Idempotent.
* **capacity** (Mondays) — every board in the workspace vs its item limit; alerts at
  `capacityAlertPct` (update posted to `custodian.alertItemId`). First live run immediately
  flagged Activities v2 at 90% — a true positive.
* **sweep** (July 1) — one recompute per owner so This/Last Year splits roll over at the
  fiscal boundary (closes the staleness gap in Not-yet-done).
* **reconcile** (nightly) — per-owner ledger cents vs Monday's Lifetime Giving (rounded-cents
  comparison; Monday stores float noise) plus summaries vs fresh ledger totals. First full
  pass 2026-08-31: 6,886 owners, zero mismatches.

Duties that touch many items **slice themselves** and report `remaining` + a cursor (re-run to
continue): the Workers Free plan caps subrequests at 50/invocation, Monday caps `items(ids:)`
at 100 ids — and note `items(ids:)` **silently returns 25 items unless you pass `limit: 100`**
(bit for real 2026-08-31: 75% of owners read back "missing"; the same default would silently
under-roll any donor with >25 gifts on one board — every batched read in `monday/client.ts`
now passes an explicit limit). When Workers Paid lands, the per-run slice constants in
`custodian.ts` can grow.

## The Closed Won filter — read this before touching the Status column

The rollup filters on `Status === 'Received'` **exactly** (config: `donationRollups.receivedStatusLabel`).
This is deliberate and load-bearing: `salesforce-import` gives the 438 stale-stage `Closed Won`
records a *different* label — `'Received (Historical)'` — specifically so this Worker excludes
them from ongoing totals the same way `Salesforce.IsWon` already did in the original NPSP rollups
(`Closed Won` has `IsWon = false`; only `Posted` is `true` — see gotcha #10). **If the Donations
board's Status vocabulary is ever changed to merge those two labels back together, this Worker
will silently start over-counting Lifetime Giving again** by the same ~$40,659.59 that fix was
for. Don't rename `'Received (Historical)'` to `'Received'` without updating this filter (or
better, without re-deriving whether the two should really be merged) at the same time.

## Fiscal year, not calendar year

`This Year` / `Last Year` bucket by SVBC's fiscal year (July–June, `Organization.FiscalYearStartMonth
= 7`) via the `Fiscal Year` column `salesforce-import` already writes on every Donation
(`transform/fields.ts`'s `fiscalYear()`), not a fresh date computation here. `currentFiscalYear()`
in `src/rollups/compute.ts` reimplements the same July-rollover rule locally (this Worker doesn't
share code with `salesforce-import` — each Worker is self-contained per the root README) so "this
year" always means the fiscal year, matching the reporting basis decided for gotcha #1.

## Config

`config/svbc.json` holds real ids verified against the CRM Sandbox v2 boards (2026-08-31), not
placeholders — re-verify against production board ids before deploying for real, since the
sandbox gets rebuilt before cutover:

* `donationRollups.donationBoards` — now a single entry: the archive-in-place Donations board
  (docs/20 retired the 9-era-board split), with its `columns` block (Donor-link, Amount, Date,
  Status, and Fiscal Year — `null` still supported for boards without one; this Worker derives it
  from Date instead in that case, see `fiscalYearFromDate` in `rollups/compute.ts`). The list
  stays an array on purpose — a second board (e.g. a future workspace split) is config + one
  `setup-webhooks.mjs` run, not code. **Every board id here needs its own webhook subscription**
  — Monday webhooks are board-scoped.
* `donationRollups.ownerColumnsByBoard` — keyed by the **real Monday board id** (a string), one
  entry per board a Donation's Donor connect column can point to. Confirmed against the sandbox
  this is three boards, not two — People, People (Historical), and Organizations — each with
  independently generated column ids for the same twelve rollup fields (Lifetime Giving, Gift
  Count, First Gift, This/Last Year amount+count, Largest/Smallest/Average, Last Gift date+amount).
  A donor whose owner board isn't a key in this map fails loudly (retried via the queue), not
  silently skipped — add the board before donors can land there, don't wait for the failure.

## APIs & auth

* **Monday.com webhooks** — one pair (`create_item` + `change_column_value`) on the single
  Donations board, pointed at
  `https://svbc-donation-rollups.svbc-account.workers.dev/webhooks/monday/donations` with the
  shared secret embedded in the URL (`?secret=`, matching the Worker's `MONDAY_WEBHOOK_SECRET`).
  Managed by `scripts/setup-webhooks.mjs`, which also prunes retired boards' subscriptions (the
  era boards' 18 old ones). The subscription-creation handshake POSTs `{"challenge": "..."}` to
  the webhook URL, which is echoed back verbatim — handled in `src/webhook/route.ts`, and is
  also what a new subscription's secret check has to pass, so a wrong secret at subscribe-time
  fails loudly rather than silently. Note the API cannot read back a webhook's URL, so a lost
  secret means rotate (`wrangler secret put MONDAY_WEBHOOK_SECRET`, redeploy, re-run
  `setup-webhooks.mjs`), not recover.
* **Monday.com GraphQL API** — reusing `salesforce-import`'s existing token for Sandbox testing.
  **Deliberately deferred, not open debt** (decided 2026-08-24, same reasoning as the donor-portal
  integration user — see `migration-plan.md`'s Post-Migration Follow-ups in the private planning
  repo): minting a dedicated least-privilege token against Sandbox board ids would be throwaway
  work, since the sandbox gets rebuilt before cutover. The dedicated token gets minted against the
  **production** workspace as part of production cutover instead — see "Not yet done" below.

## Non-destructive by design

Every board id in `config/svbc.json` — the Donations board and all 3 owner boards — is a CRM
**Sandbox** id (the "(sandbox v2)" set, verified directly 2026-08-31), not copied from a
production workspace. There is no production Monday workspace with real cutover data yet (that's
October); until there is, this Worker cannot touch live donor data no matter what triggers it.
**Before ever repointing any id in that config at a production workspace, re-verify every single
one against production directly** (the sandbox gets rebuilt before cutover, so today's ids won't
necessarily match) — don't assume sandbox and production share ids just because the schema matches.

## Not yet done

* ~~Webhook cutover to the v2 board~~ **Done 2026-08-31**: secret rotated, Worker redeployed,
  v2 pair subscribed, all 18 era-board subscriptions pruned, and verified live end to end — a
  test donation flowed webhook → D1 → queue → recompute and wrote all 12 columns on the donor's
  v2 item with values matching the importer's independent computation (Lifetime $714.93 / 15
  gifts, average exact). Note: the `webhooks` API query only returns subscriptions created by
  the SAME token/app — another client seeing an empty list doesn't mean none exist.
* **Dedicated least-privilege API token — scheduled for production cutover, not before** (see
  "APIs & auth" above). Scope, once minted: read-only on the Donations board, read/write on
  People/People Historical/Organizations.
* ~~`owner_board_id` in `donation_links` is written blank by the bootstrap script.~~ Fixed
  2026-08-31: `bootstrap-links-from-artifacts.mjs` populates it from the importer's ledger.
* **This/Last Year go stale exactly once a year, on the fiscal-year boundary, if nothing else
  triggers a recompute.** A donor with no new gifts near July 1st keeps last fiscal year's
  This/Last Year split until their next Donation changes. Not a bug this Worker's design can fix
  on its own — a small annual cron sweep (recompute every owner once, first week of July) would
  close this gap if it turns out to matter in practice; docs/20's custodian duties list already
  includes it alongside the year-end archive run.

## Sources

* `docs/07-migration-gotchas.md` gotcha #1 (fiscal year), #4 (Closed Won stale stage), #10 (rollup
  recomputation) (private planning repo)
* `docs/05-migration-script-requirements.md` §8, §10 (private planning repo)
* `salesforce-import/src/transform/rollups.ts`, `transform/donations.ts` — the one-time-import
  half of this same rollup logic, and the `Closed Won` → `'Received (Historical)'` fix this
  Worker's filter depends on
