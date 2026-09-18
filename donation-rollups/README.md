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

## Status and verification — operational findings, 2026-09-17

Two problems were investigated read-only on 2026-09-17 (D1 via `wrangler d1 execute --remote`,
Cloudflare GraphQL analytics via the wrangler OAuth token, Monday `activity_logs`). Findings and
the proposed fixes; nothing on the sandbox was changed.

### 1. 2,865 `pending_recomputes` rows stuck in `queued` — D1 Free-tier daily write cap

**What the rows are.** They are not one flood but two, and neither is the migration load you'd
guess from the timestamps:

| Window (UTC) | Monday events on the Donations board | Pending rows | Outcome |
| --- | --- | --- | --- |
| 2026-09-03 19:19–19:21 | 3,753 `update_column_value` on a temporary text column (`text_mm6v2fvg`, created then deleted the same minute — a throwaway bulk write, not a rollup input) | 3,427 (602 written, 3 failed, 2,822 queued) | consumer stalled 20:09 |
| 2026-09-09 01:34–01:45 | 402 items: 77 `create_pulse` + 325 `board_relation` updates (the sandbox v2 load) | 401 (358 written, 43 queued) | consumer stalled 01:58 |

Every queued row has `owner_item_id NULL` and no `written_at`: the consumer never got far enough
to record anything, not even `failed`. The 3 `failed` rows carry
"Too many subrequests by single Worker invocation" (the 50/invocation Free-plan budget, shared by
every message in a batch).

**Root cause — D1's Free-tier daily row-write limit, enforced since 2026-09-01.** Cloudflare began
failing D1 queries on Workers Free accounts that exceed 100,000 rows written per day on
2026-09-01 (changelog "D1 enforces free tier daily query limits"; error text "Your account has
exceeded D1's free tier daily row write limit… wait until tomorrow (midnight UTC)"). This
account is on Workers Free. D1 analytics for this database:

| Day | Rows written | Write queries | Consumer invocations |
| --- | --- | --- | --- |
| 2026-08-31 (bootstrap, pre-enforcement) | 298,611 | 149 | fine |
| 2026-09-03 | 133,084 | 49,022 | 4,618 ok · 74 exceededResources · 1,437 threw |
| 2026-09-09 | 139,070 | 47,499 | 629 ok · 108 threw |

The minute-level signature is unambiguous on both days: rows written run at 1–5k/min while the
consumer works, then drop to **zero** (09-03 at 20:09, 09-09 at 01:58) while every queue
invocation flips to `scriptThrewException` at 25–50/min until the backlog has burned its
retries (09-03 20:09–20:39; 09-09 01:58–02:01). Once D1 rejects writes, `processRecomputeBatch`'s
catch block calls `pendingStore.updateStatus(…, 'failed')`, which is itself a D1 write, so the
exception escapes the loop, the whole batch is retried, and after `max_retries: 3` the messages
land in `donation-rollups-recompute-dlq`. The DLQ had **no consumer** (until fix 5), and its
`message_retention_period` is 1 day, not the 4-day default assumed here at first — so there was
nothing left to read or replay from it (`wrangler queues info donation-rollups-recompute-dlq`:
0 producers, 0 consumers). The D1 rows were never touched again.

**Why one flood writes 100k+ rows.** Nothing else wrote to D1 on either day (every 09-03/09-09
row in `gifts` and `donation_links` has `source = 'webhook'`). The volume is the consumer's own
amplification: `giftsStore.refreshFacts` upserts **every** gift of the owner on every recompute
(~3 rows written per gift: row + `idx_gifts_owner` + `idx_gifts_fy`), and a bulk edit that
touches all of a big owner's donations recomputes that same owner once per donation. The top
owners hold 619 and 557 gifts, so one of their recomputes is ~1,800 rows written; the 09-03
flood repeated that dozens of times per owner. The 2,865 stuck rows map (via `donation_links`)
to 1,349 owners.

**Secondary cause, same days:** 74 consumer invocations on 09-03 died with `exceededResources`
(Free-plan CPU/memory limit) between 19:45 and 20:08, each after its D1 writes landed but before
the status update — the same big-owner recomputes. Those messages also retried into the DLQ.

**Impact on rollups: none detected.** The 09-03 bulk write was to a column this Worker does not
read, and the nightly reconcile (`custodian_runs`, every night 09-08 → 09-17) reports zero
Lifetime Giving or Gift Ledger JSON mismatches across all 6,887 owners. The stuck rows are
bookkeeping debt, and a warning that the next real flood (production cutover, a Funraise
backfill) would silently lose recomputes the same way.

**Proposed fix (not yet applied):**

1. **Workers Paid ($5/mo) is the decisive fix** and is already on the infrastructure wishlist for
   `funraise-sync`/`quickbooks-sync`: D1 goes to 50M rows written/day, CPU to 30 s, subrequests
   to 1,000/invocation. Everything below is hardening that is worth doing regardless.
2. ~~**Stop rewriting unchanged gifts.**~~ **Done (branch `fix/rollups-diff-only-refresh-facts`):**
   `refreshFacts` now reads the stored facts for the gifts it was handed (one `IN (…)` query per
   100 ids) and upserts only the new or changed ones, returning `{ changed }`; the consumer logs
   "N of M gift facts changed" when N > 0. A recompute of an owner whose history is already
   right costs reads, not rows written — O(changed gifts) instead of O(gifts). An absent
   `giftType` still means "keep stored" and is not a change.
3. ~~**Coalesce redundant recomputes per owner.**~~ **Done (branch `feat/rollups-owner-coalescing`,
   migration 0006 — apply to the sandbox D1 before deploying):** `owner_recomputes` records, per
   owner, when a successful recompute *fetched* Monday and when its write landed. A message is
   coalesced (pending row marked `written`, no fetch, no write) only when **both** hold: the
   owner's last fetch is at/after the pending row's `received_at` (fetch time, not completion —
   a recompute that started before the edit read stale data), **and** this donation's link
   already existed unchanged before that fetch (a recompute only reads the donations D1 links
   to the owner at that moment, so a new or re-owned link can't have been covered — the sketch
   above missed this). `upsertLink` became diff-aware for that check and now costs no write
   when unchanged. The row is recorded only after the owner write *and* the gift term stamps,
   so a partial failure retries in full instead of being coalesced away. A 3,700-webhook flood
   now costs ~1 recompute per owner plus two Monday reads and three small D1 ops per skipped
   message; the consumer logs each coalesced donation.
4. ~~**Make D1 outages retry later instead of burning the DLQ.**~~ **Done (branch
   `fix/rollups-d1-quota-retry`):** the consumer's `failed` status write is guarded so a D1 error
   there can no longer escape the batch loop; a D1 daily-quota error (`src/consumer/quota.ts`
   matches D1's fixed "exceeded D1's free tier daily row read/write limit" text) retries the
   message with `delaySeconds` to the next midnight UTC (capped at Queues' 12 h — a message
   further out comes back once mid-way, fails without touching Monday, and defers again), and
   once one message in a batch hits it the rest of that batch is deferred to the same moment
   without any Monday calls. Other errors still retry immediately. `max_batch_size` is 2: D1
   queries count against the 50-subrequest budget and a full recompute costs ~16–26, so two
   worst-case recomputes fit and three don't (the default 10 is what produced the three
   "Too many subrequests" rows). Raise it on Workers Paid.
5. ~~**Give the DLQ a consumer … add a custodian duty `requeue-stuck`.**~~ **Done (branch
   `feat/rollups-dlq-requeue`):** the Worker now also consumes `donation-rollups-recompute-dlq`
   (`src/consumer/processDeadLetters.ts`): a dead message marks its pending row `failed` with
   `dead-lettered after retries: <last consumer error>` and each batch posts one alert on
   `custodian.alertItemId` naming the donations, so a dead message is visible in D1 and on
   Monday instead of expiring unseen. Nothing is re-driven from there — a dead-lettered row is a
   human's signal; `scripts/redrive-pending.mjs --status failed` is the tool once the cause is
   fixed. The nightly custodian duty **`requeue`** (also `POST /custodian/run/requeue`)
   re-enqueues `queued`/`received` rows older than 24 h, oldest first, up to 3,500 per run in
   batches of 100, with `received_at` left alone so fix 3's coalescing turns every message after
   the first per owner into a two-read skip — a flood's worth of stuck rows costs ~one recompute
   per owner, with no per-owner planning or bookkeeping SQL. It reports `ok: false` (one alert)
   whenever it found anything, because stuck rows mean the consumer lost work earlier. The
   2,865 rows this was designed to repair were drained by hand first (below), so the duty is
   preventative: it should report "no stuck recomputes" every night.
   **First-deploy incident (2026-09-18 20:38 UTC):** attaching the consumer delivered the DLQ's
   remaining backlog at once. Most of it (~2,700 messages) was dropped by the platform as past the
   queue's 1-day retention, but ~300 messages from the previous day's hand re-drive were
   delivered — and their rows had since been written. The consumer marked them `failed` and
   posted 35 alerts in two minutes before delivery was paused (`wrangler queues pause-delivery`).
   The rows were restored (`status='written', error=NULL` where `written_at` was set; 300 rows)
   and the consumer now treats a message sent at or before the row's `written_at` — or carrying
   no timestamp — as stale: acked, row untouched, not alerted. Re-deployed with that guard, then
   `wrangler queues resume-delivery`.

**Update — drained 2026-09-17 20:24–22:15 UTC, ahead of fixes 4–5.** The 2,865 rows were
re-driven by what became `scripts/redrive-pending.mjs`: one synthetic
`POST /webhooks/monday/donations` per distinct owner (1,349 owners + 14 rows with no D1 owner =
1,363 messages), in chunks of 50 behind a 5-owner canary, each chunk waited on in D1 before the
next. All 1,363 settled `written`, 0 failed, ~50 owners per 4 minutes at `max_concurrency: 1`,
against the build deployed at 20:05 UTC (version `db2aea17`). The daily D1 write cap did not
trip: the drain costs one recompute per owner, where the 09-03 flood cost one per donation. The
other ~1,500 rows of already-recomputed owners were then marked `written` by hand with
`scripts/redrive-pending-bookkeeping.sql` (09-18 00:20 UTC), and the 3 `failed` rows from 09-03
were re-driven individually on 09-18 19:38 UTC and settled in under 20 s each. Table now: 3,830
`written`, 0 `queued`, 0 `failed`. The "do not re-enqueue" warning stands as the rule for the
*next* flood until fixes 4–5 land; the script's canary, per-chunk settle, and 20 % failure-rate
abort are what made a one-off hand run safe. Usage:

```sh
MONDAY_WEBHOOK_SECRET=... node scripts/redrive-pending.mjs \
  --worker-url https://svbc-donation-rollups.svbc-account.workers.dev --dry-run   # plan only
# then without --dry-run; add --bookkeep to mark each owner's other rows written once settled
```

### 2. "No pending row since 09-09" — webhooks are delivering; the evidence was cleaned up

The two subscriptions (`630667357` create_item, `630667362` change_column_value) **are working.**
Correlating Monday's activity log with Cloudflare analytics for the 2026-09-17 test:

| UTC | Source | What happened |
| --- | --- | --- |
| 17:36:24 | wrangler deployments | membership-enabled build deployed (version `a4d2d379`, same D1 binding) |
| 17:37:00–17:38:44 | Monday activity_logs | item 13071939814 created, then 8 column edits (Amount, Term Start/End, Membership Type ×2, Salesforce Owner ×2) |
| 17:37–17:38 | Workers analytics | 12 invocations, all `success`, 50 Monday subrequests |
| 17:37:12 | Monday activity_logs | Term Start / Term End / Membership Type stamped on the new item — a write only this Worker's membership path makes |
| 17:37–17:38 | D1 analytics | 64 write queries, 131 rows written; `gifts` rows for donor 12895278456 refreshed at 17:38:52 with `source = 'webhook'` (the consumer's recompute path, reachable only via a queue message, which the webhook route only sends after inserting the pending row) |
| 17:40:18 | Monday activity_logs | item 13071939814 deleted |
| 17:40 | D1 analytics | 4 write queries, 4 rows, **with no Worker invocation that minute** — a hand `wrangler d1 execute` cleanup (one row each from `pending_recomputes`, `donation_links`, `gifts`, `membership_baseline` fits exactly) |

So the row was created and written, then deleted along with the test item's other D1 traces at
17:40, which is why a later status count shows nothing after 09-09. The secret rotation on 08-31
did not orphan the subscriptions (they were recreated after it), and Monday did not disable them.
The 19:27 synthetic POST that "worked" was the same path the real webhooks had taken two hours
earlier. **No `setup-webhooks.mjs` re-run is needed.**

(A re-run happened anyway at 19:52 UTC on 2026-09-17, before this analysis was in: `--prune
18428131791` deleted `630667357`/`630667362` and re-subscribed as **`638989616`** (create_item)
and **`638989691`** (change_column_value) — same URL and secret, so harmless, but those are the
live subscription ids now. A throwaway item created at 20:07 UTC produced its pending row within
a second and was deleted afterwards.)

Two things worth knowing from this exercise:

* Monday under-delivered on 09-03: 3,753 events on the board produced 3,427 pending rows (~9 %
  short). Whether Monday dropped them or the Worker 5xx'd is not recoverable now (Workers Logs
  retention is 3 days on Free). Expect some loss under a burst; the owner-coalescing in fix 3
  plus the reconcile duty are what make that tolerable.
* **How to verify delivery without trusting D1 row counts:** Cloudflare GraphQL
  `workersInvocationsAdaptive` grouped by `datetimeMinute` for `svbc-donation-rollups`, compared
  against the board's `activity_logs` for the same minute. It works with the local wrangler
  OAuth token (the Workers Observability log API does not — that token lacks the
  `workers_observability` scope, and `wrangler tail` is live-only). For a live check, run
  `npx wrangler tail` while creating one throwaway item, confirm the `POST /webhooks/monday/donations`
  and the queue invocation, then check `pending_recomputes` **before** cleaning up.

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

## Membership renewal write path (spec `docs/superpowers/specs/2026-09-15-membership-renewal-write-path-design.md`)

Salesforce's `Create_members` flow turned every won Donation-type gift into a one-year
membership term (and a $1,000+ gift into a Lifetime one). This Worker replicates that rule as
one more step of the recompute: after the rollups, it folds the owner's eligible post-cutover
gifts (Status = Received, Gift Type in `membership.eligibleGiftTypes`, date ≥
`membership.fromISO`) into Membership Status / Tier / Member Since / Member Until on the owner's
People item, and stamps Term Start / Term End / Membership Type on each eligible gift. Both
writes are compare-before-write, so the gift stamp's own webhook triggers one idle recompute and
stops. The merge with the board is **extend-only** — a staff-granted comp or Lifetime is never
shortened or downgraded; shorten by hand if you mean to.

* **Enabling — order matters.** The block is **on** in the shipped config because migration
  0005 was applied to the CRM Sandbox database on 2026-09-17; 0006 (`owner_recomputes`, fix 3
  coalescing) must be applied the same way before deploying that change. For any other database (a fresh
  fork, the production cutover), set `donationRollups.membership` to `null` first, then:
  1. `CI=1 wrangler d1 migrations apply svbc-donation-rollups --remote`
  2. set `donationRollups.membership` in `config/svbc.json` to the block below and deploy.
  Deploying with the block set before step 1 makes every People-board recompute throw on
  `membership_baseline`, which stops **rollups** for those owners too, not just membership.

  ```json
  "membership": {
    "fromISO": "2026-10-01",
    "eligibleGiftTypes": ["Donation"],
    "termMonths": 12,
    "lifetimeThresholdCents": 100000,
    "statusLabels": { "active": "Active", "lapsed": "Lapsed" },
    "tierLabels": { "member": "Member", "lifetime": "Lifetime" },
    "typeLabels": { "new": "New", "renewal": "Renewal", "reacquire": "Reacquire", "lifetime": "Lifetime" }
  }
  ```
  `fromISO` is the cutover date; set it to the real one when fixed.
* **Gated** on `donationRollups.membership` (null = off) and on an owner board having a
  `membership` column block; Organizations never get a term.
* **Baseline.** `membership_baseline` (migration 0005) holds each owner's pre-feature state,
  captured from the board on the first recompute that touches them, so New/Renewal/Reacquire
  stays stable across re-runs. It is never updated. To re-seed one owner after correcting their
  migrated history in the UI:
  `wrangler d1 execute svbc-donation-rollups --remote --command "DELETE FROM membership_baseline WHERE owner_item_id='<id>'" -y`
  — the next recompute recaptures it.
* **Auto-lapse** stays a native board automation ("When Member Until arrives … set Membership
  Status to Lapsed"); this Worker agrees with it by construction. `mailchimp-sync` picks up the
  People changes through its own webhook; the donor portal reads the same columns.
* **Funraise gifts** qualify only because `funraise-sync` stamps Gift Type = Donation on the
  items it creates (see that README) and only once its Date column transform lands — a gift
  with an empty Date never starts a term.
* Not replicated: Salesforce's inconsistent Lifetime firing, and the Matching Donation terms
  staff created by cloning gifts. Add `"Matching Donation"` to `eligibleGiftTypes` if that
  practice should continue.
* **Recurring donors:** every recurring charge is a Received Donation, so a monthly donor
  accrues a term per charge, as in Salesforce; their Member Until is always about a year past
  the latest charge.
* **Expiry-day boundary:** the Worker counts Member Until = today as Active; the native
  automation lapses on that day. A recompute on the expiry date can flip Lapsed back to Active
  for that one day. The Worker's "today" is UTC, the automation's is the account timezone.
* **Lifetime Term End:** post-cutover Lifetime gifts have a blank Term End; migrated Lifetime
  history carries 2122-01-01. Sorting "Membership payments" by Term End mixes the two.
* **Refunds:** a gift flipped to Failed drops out of the fold but keeps its stamped term columns,
  and the owner keeps their Until — same as Salesforce. Shorten by hand if intended.
* **Concurrent gifts:** two gifts for one owner recomputing at once can each write a merge of
  what it read; the later writer wins and the stamped gifts' webhooks re-converge on the next
  pass. Not atomic.
* **Baseline with Since but no Until:** treated as Renewal, matching the Salesforce formula
  (a null end date is not "before today").
* Qualify the "idle recompute" sentence above: the recompute still performs the owner rollup and
  description writes; only the membership keys and gift stamps are compared away.

## Ledger v2 + the custodian (docs/20 §5.1/§5.3)

D1 is the **authoritative gift ledger**, not just a reverse index: `gifts` (one row per gift —
amount in cents, date, fiscal year, status, provenance, archived state) and `annual_summaries`
(one row per closed fiscal year, restatement-stamped). Monday stays the working surface; staff
edits flow back via webhooks, and every recompute re-asserts the facts of every gift it reads,
so the ledger self-heals. Bootstrap: `scripts/bootstrap-gifts-from-artifacts.mjs` (37,286 gifts
loaded 2026-08-31; 32,739 Received, 33,541 archived).

The **custodian** runs five duties from one daily cron (09:00 UTC; `dutiesForDate` gates them)
and mirrors each as an authenticated route — `POST /custodian/run/{archive|capacity|sweep|reconcile|requeue}?secret=…`
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
* **requeue** (nightly) — re-enqueues pending rows the queue never finished (`queued`/`received`
  older than 24 h); quiet when there are none, alerts when there were (fix 5 in "Status and
  verification" above).

**Gift-history projections (docs/20 §5.5)** ride every recompute: each owner item gets a
`Gift Ledger (JSON)` text column — the full lifetime history as compact newest-first tuples
`[itemId, date, cents, type, status]`, sourced from the D1 ledger so it includes archived gifts
and their types — plus (where the account supports it) a markdown gift-history table in the
item description with a deep link per gift. The description write is **deliberately non-fatal**:
`set_item_description_content` 500s outright on this account (the item-description feature isn't
enabled — even a trivial markdown fails, observed 2026-08-31), so a failure logs and moves on
rather than burning queue retries over a redundant rendering of the JSON column. Provision the
column via `setup-owner-columns.mjs` (it's part of the 13-column set now).

**The Annual Giving Summary board (docs/20 §5.4)** — created by
`scripts/setup-annual-summary-board.mjs`, one item per closed fiscal year (Fiscal Year Ending, Total
Received, Gift Count, By Gift Type, Restated), written ONLY by the custodian's archive duty:
new years created once, and a closed year rewritten only when the ledger's totals changed (an
audit restatement — the Restated date is stamped). D1's `annual_summaries` stays authoritative;
the board is its staff-facing projection, wired via `custodian.annualSummaryBoardId` +
`annualSummaryColumns` in config.

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
= 7`) via the `Fiscal Year Ending` column `salesforce-import` already writes on every Donation
(`transform/fields.ts`'s `fiscalYear()`), not a fresh date computation here. `currentFiscalYear()`
in `src/rollups/compute.ts` reimplements the same July-rollover rule locally (this Worker doesn't
share code with `salesforce-import` — each Worker is self-contained per the root README) so "this
year" always means the fiscal year, matching the reporting basis decided for gotcha #1.

**A blank Fiscal Year Ending cell is treated as missing, not as year 0.** `getDonationsByIds`
falls back to `fiscalYearFromDate(Date)` whenever the column is unconfigured *or* the cell is
blank/whitespace — checked as text, the same way Amount is, because `Number('')` is `0` and a
gift bucketed into fiscal year 0 silently vanished from This Year / Last Year (observed live on
the CRM Sandbox 2026-09-17: a hand-created gift with no Fiscal Year cell wrote This Year Amount
$0 on its donor). This mattered post-cutover, not just for hand entry: until `funraise-sync`
stamped the column on create (same day), every Funraise gift would have hit it.

**Decision (2026-09-17): this Worker does not backfill the column.** Deriving from Date is
enough for correct rollups, and writing back to the Donations board it subscribes to would mean
a write-scoped token plus a `change_column_value` webhook re-triggered by our own write on every
new gift. The column exists for staff (board views/filters grouped by fiscal year, and the
`Fiscal Year Ending` grouping `salesforce-import` already stamps on every migrated gift), so
**the writer that creates the item should stamp it** — `funraise-sync` does, on create, from the
transaction's `createdAt` with the same July rule (see its README, "Field mapping"). Hand-entered
gifts, and any Funraise gift whose `createdAt` couldn't be parsed, roll up correctly via this
fallback but show a blank Fiscal Year Ending on the board.

## Config

`config/svbc.json` holds real ids verified against the CRM Sandbox v2 boards (2026-08-31), not
placeholders — re-verify against production board ids before deploying for real, since the
sandbox gets rebuilt before cutover:

* `donationRollups.donationBoards` — now a single entry: the archive-in-place Donations board
  (docs/20 retired the 9-era-board split), with its `columns` block (Donor-link, Amount, Date,
  Status, and Fiscal Year Ending — `null` still supported for boards without one; this Worker derives it
  from Date instead in that case, and also whenever the cell is blank, see `fiscalYearFromDate`
  in `rollups/compute.ts` and "Fiscal year, not calendar year" above). `fiscalYear` must be
  the **text** column titled `Fiscal Year Ending` (`text_mm70czyd` on the sandbox v2 board),
  not the older numbers column titled `Fiscal Year` (`numeric_mm6jm0g4`) that `salesforce-import`
  stopped writing when it switched the title/type (its commit `219b47d`). The two coexisted on
  the board as of 2026-09-17 with the numeric one stamped only on pre-switch loads, so pointing
  here at the numeric column would leave every newer gift on the Date fallback. Either column
  type parses the same way — `getDonationsByIds` reads the cell's `text`, not its typed value.
  Whether the stale numeric column should be deleted from the board is an open question (see
  "Not yet done"), not something this Worker or its scripts do. The list
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
* `donationRollups.membership` (null = off), the per-board `membership` column ids under
  `ownerColumnsByBoard`, and the Donations board's `termStart`/`termEnd`/`membershipType` column
  ids together configure the membership renewal write path — see "Membership renewal write path"
  above.

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
* **2,865 `pending_recomputes` rows stuck in `queued` (09-03 and 09-09 floods)** — root cause and
  the five-part fix are in "Status and verification — operational findings, 2026-09-17" above.
  Repair (re-enqueue in slices) only after the write-amplification fixes or Workers Paid.
* **DLQ has no consumer** — dead messages expire unseen after 4 days; see the same section.
* **Dedicated least-privilege API token — scheduled for production cutover, not before** (see
  "APIs & auth" above). Scope, once minted: read-only on the Donations board, read/write on
  People/People Historical/Organizations.
* ~~`owner_board_id` in `donation_links` is written blank by the bootstrap script.~~ Fixed
  2026-08-31: `bootstrap-links-from-artifacts.mjs` populates it from the importer's ledger.
* **Retire the stale numeric `Fiscal Year` column (`numeric_mm6jm0g4`) on the Donations board?**
  Open question, not done. As of 2026-09-17 the sandbox v2 board carries both it and the text
  `Fiscal Year Ending` column (`text_mm70czyd`) this Worker now reads: the numeric one is set on
  every pre-`219b47d` load and on none of the newest gifts, the text one the reverse, so staff
  views grouped by either column show a partial picture. Deleting it is a board change (Monday
  UI, or `delete_column` — an irreversible mutation this Worker's read-only token can't and
  shouldn't make), and the next sandbox rebuild from `salesforce-import` creates only the text
  column anyway, so the cheapest answer may be to let the rebuild retire it. Decide before
  production cutover; nothing here depends on it.
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
