# donation-rollups

**Status:** Built (`feat/donation-rollups`) — not deployed; needs D1 provisioning and a Monday
webhook subscription. Config in `config/svbc.json` is real, verified board/column ids (against the
CRM Sandbox, 2026-08-24), not placeholders. Core mechanism (donor link resolution, the D1 reverse
index, fetching donations by id, writing the rollup back) tested directly against that sandbox —
see "Tested against the real sandbox" below for what that found and fixed.
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
Monday.com (any of the 9 Donations era boards — see below)
  │  webhook, on Donation item create / column change
  ▼
Cloudflare Worker (webhook handler)
  │  1. echo the challenge verbatim during webhook-subscription setup (one-time handshake,
  │     needed once per era board — Monday webhooks are board-scoped)
  │  2. upsert into D1 `pending_recomputes`, keyed on the *Donation item id* plus which
  │     board it came from — a later event for the same donation replaces the pending
  │     row instead of queuing a redundant duplicate
  │  3. enqueue a Cloudflare Queue message referencing the donation item id + board id
  ▼
Cloudflare Queue → consumer Worker
  │  1. resolve the Donation's linked owner (Donor or Organization item) using *that
  │     board's own* column ids — every era board has independently generated column ids
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
populated incrementally as webhooks arrive and bootstrapped once from every already-existing
donation via `scripts/bootstrap-links.mjs` before this Worker can be trusted for a real donor's
totals. Recompute then fetches specific donation ids directly (`items(ids: [...])`, which *does*
work, no filter needed) instead of asking Monday to find them.

**Full recompute, not incremental.** Every run re-pulls and re-sums *all* of an owner's Donations
rather than adjusting a running total. Simpler, self-healing (a missed webhook or a bad prior
write can't compound), and correct at SVBC's donation volume — an owner with dozens to low
hundreds of gifts is a cheap query, not hundreds of thousands. Revisit only if per-owner Donation
counts grow enough that this stops being cheap.

**No coalescing across donations for the same owner.** Two Donations for the same donor changing
within moments of each other queue two independent recompute jobs, not one. Each is a correct,
idempotent full recompute on its own — mildly redundant work, not a correctness bug — so this
wasn't worth the added complexity of a per-owner dedup layer for v1.

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

`config/svbc.json` holds real ids verified against the CRM Sandbox (2026-08-24), not placeholders
— re-verify against production board ids before deploying for real, since the sandbox gets rebuilt
before cutover:

* `donationRollups.donationBoards` — one entry per Donations *era* board (9 in the sandbox: one
  "live" board plus 8 dated historical ones, split to stay under Monday's 10k-item ceiling), each
  with its own `columns` block (Donor-link, Amount, Date, Status, and Fiscal Year — `null` where
  that column doesn't exist yet on that particular board; this Worker derives it from Date instead
  in that case, see `fiscalYearFromDate` in `rollups/compute.ts`). **Every board id here needs its
  own webhook subscription** — Monday webhooks are board-scoped, so a new era board added later
  needs both a config entry and a new subscription, not just one.
* `donationRollups.ownerColumnsByBoard` — keyed by the **real Monday board id** (a string), one
  entry per board a Donation's Donor connect column can point to. Confirmed against the sandbox
  this is three boards, not two — People, People (Historical), and Organizations — each with
  independently generated column ids for the same twelve rollup fields (Lifetime Giving, Gift
  Count, First Gift, This/Last Year amount+count, Largest/Smallest/Average, Last Gift date+amount).
  A donor whose owner board isn't a key in this map fails loudly (retried via the queue), not
  silently skipped — add the board before donors can land there, don't wait for the failure.

## APIs & auth

* **Monday.com webhooks** — subscribe via the API (`create_webhook` mutation) for `create_pulse`
  and `change_column_value`, **once per Donations era board** (9 separate subscriptions in the
  sandbox — Monday webhooks are board-scoped, there's no "subscribe to all boards" option), scoped
  to the Amount/Date/Fiscal Year/Status/Donor-link columns if Monday's webhook config supports
  column-level scoping; board-wide otherwise. The subscription-creation handshake POSTs
  `{"challenge": "..."}` to the webhook URL, which must be echoed back verbatim — handled in
  `src/webhook/route.ts`.
* **Monday.com GraphQL API** — standard integration-user token, least-privilege (read/write on the
  Donations era boards plus People/People Historical/Organizations only), same pattern as every
  other Worker here.

## Not yet done

* **`donation_links` bootstrap hasn't been run against any real target yet.** `scripts/
  bootstrap-links.mjs` exists and is unit-tested at the query-shape level (the same GraphQL it
  uses was verified directly against the sandbox), but it hasn't actually been run end-to-end to
  populate a real D1 database — needs a provisioned D1 instance and `wrangler d1 execute --remote`
  before this Worker can be trusted for any donor whose donations predate its first webhook.
* **`owner_board_id` in `donation_links` is written blank by the bootstrap script.** Not resolvable
  from the same query that finds the donation→owner link (the owner could be on any of three
  boards). Not currently read by anything downstream — the consumer re-resolves it fresh via
  `getItemBoardId` every time — but it's a real gap in the table's own data if anything ever comes
  to depend on that column being populated.
* **Webhook signature verification** — Monday's webhook payloads aren't currently checked for
  authenticity beyond the challenge handshake. Confirm what Monday actually offers (a shared
  secret header, IP allow-listing, or nothing) before deploying publicly.
* **This/Last Year go stale exactly once a year, on the fiscal-year boundary, if nothing else
  triggers a recompute.** A donor with no new gifts near July 1st keeps last fiscal year's
  This/Last Year split until their next Donation changes. Not a bug this Worker's design can fix
  on its own — a small annual cron sweep (recompute every owner once, first week of July) would
  close this gap if it turns out to matter in practice.

## Sources

* `docs/07-migration-gotchas.md` gotcha #1 (fiscal year), #4 (Closed Won stale stage), #10 (rollup
  recomputation) (private planning repo)
* `docs/05-migration-script-requirements.md` §8, §10 (private planning repo)
* `salesforce-import/src/transform/rollups.ts`, `transform/donations.ts` — the one-time-import
  half of this same rollup logic, and the `Closed Won` → `'Received (Historical)'` fix this
  Worker's filter depends on
