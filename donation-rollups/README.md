# donation-rollups

**Status:** Built (`feat/donation-rollups`) — not deployed; needs D1 provisioning, real board/
column ids, and a Monday webhook subscription. Not yet tested against a live Monday account.
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
Monday.com (Donations board)
  │  webhook, on Donation item create / column change
  ▼
Cloudflare Worker (webhook handler)
  │  1. echo the challenge verbatim during webhook-subscription setup (one-time handshake)
  │  2. upsert into D1 `pending_recomputes`, keyed on the *Donation item id* — a later
  │     event for the same donation replaces the pending row instead of queuing a
  │     redundant duplicate
  │  3. enqueue a Cloudflare Queue message referencing the donation item id
  ▼
Cloudflare Queue → consumer Worker
  │  1. resolve the Donation's linked Donor/Organization (its "owner")
  │     — no owner linked yet → nothing to recompute, ack and skip (not a retry candidate)
  │  2. ask Monday which board the owner lives on (Donors vs. Organizations — they have
  │     independent column-id namespaces even for identically-named fields)
  │  3. pull every Donation linked to that owner, fresh, via items_page_by_column_values
  │  4. recompute the full rollup set from scratch (not an incremental delta — see below)
  │  5. write all twelve fields back in one change_multiple_column_values call
  │  on failure at any step, Queues retries automatically and, once exhausted, routes to
  │  a Dead Letter Queue instead of a donor's totals silently drifting out of date
  ▼
Donors board / Organizations board (ids + column ids in config/svbc.json)
```

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

`config/svbc.json` needs, after `salesforce-import`'s load stage runs and real board/column ids
exist:

* `monday.boards.donations` / `.donors` / `.organizations` — the three board ids.
* `donationRollups.donationColumns` — the Donations board's Donor-link (connect_boards),
  Amount, Date, Fiscal Year, and Status column ids.
* `donationRollups.ownerColumnsByBoard.donors` **and** `.organizations` — two separate sets of
  twelve column ids (Lifetime Giving, Gift Count, First Gift, This/Last Year amount+count,
  Largest/Smallest/Average, Last Gift date+amount). Donors and Organizations are different Monday
  boards with independent column-id namespaces, even for fields with the same name — a shared
  column-id map would write to the wrong (or a nonexistent) column on whichever board isn't
  "donors."

## APIs & auth

* **Monday.com webhooks** — subscribe via the API (`create_webhook` mutation) for `create_pulse`
  and `change_column_value` on the Donations board, scoped to the Amount/Date/Fiscal Year/Status/
  Donor-link columns if Monday's webhook config supports column-level scoping; board-wide
  otherwise. The subscription-creation handshake POSTs `{"challenge": "..."}` to the webhook URL,
  which must be echoed back verbatim — handled in `src/webhook/route.ts`.
* **Monday.com GraphQL API** — standard integration-user token, least-privilege (read/write on
  Donations + Donors + Organizations only), same pattern as every other Worker here.

## Not yet done

* **Not tested against a live Monday account.** Every test here uses a fake `DonationRollupsMondayClient`
  or the D1 miniflare binding — the actual GraphQL queries (`items_page_by_column_values` for a
  connect column filtered by linked-item-id, `BoardRelationValue.linked_item_ids` for reading a
  single link) haven't been exercised against Monday's real API yet. Verify this before relying on
  it for a real donor's totals.
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
