# donation-rollups

**Staff UAT script:** [`docs/uat/donation-rollups.md`](../docs/uat/donation-rollups.md) — what a non-technical tester can try in the sandbox and what they should see. Keep it in step with this README.

**Status: running as `svbc-donation-rollups-sandbox` since the 2026-09-20 move onto the sandbox
environment** (`npm run deploy:sandbox`; own D1 `svbc-donation-rollups-sandbox`, queues
`donation-rollups-recompute-sandbox` and `-sandbox-dlq`, secrets under `--env sandbox`; the
production name `svbc-donation-rollups` is retired until cutover — sandbox design §9). The move:
D1 created and migrations 0001–0007 applied, every table copied from `svbc-donation-rollups` with
counts verified equal (37,367 links, 37,367 gifts, 3,838 pending, 1,349 baseline rows, 18
summaries, 30 runs, 12 owner recomputes), secrets set, deployed, both Donations-board webhooks
pruned and re-subscribed at the `…-sandbox` URL by `scripts/setup-webhooks.mjs`, one recompute
proven end to end on the new Worker (donor 12896376818 unchanged at This Year 200 / 4), no rows
newer than the snapshot in the old D1, and the old Worker deleted (its consumer bindings on both
queues removed first — Cloudflare refuses to delete a consumer Worker). Its D1 and queues
survive for the cutover deploy. One finding: the ~300,000 row writes of the copy went through
`wrangler d1 execute --file` without hitting the Free tier's 100k/day cap — that cap has only
ever bitten Worker-binding writes here, so the operational finding below still stands.
**Repointed at the single archive-in-place Donations board ("sandbox v2"), 2026-08-31** —
config now targets ONE Donations board (id `18428131791`, with a real `fiscalYear` column at
last) plus the three v2 owner boards, replacing the 9-era-board layout that docs/20 in the
private planning repo retired. D1 re-bootstrapped from `salesforce-import`'s run artifacts
(37,286 donation→owner links — see `scripts/bootstrap-links-from-artifacts.mjs` and "Why the
bootstrap reads artifacts now" below), owner boards provisioned with the full 12-column rollup
set (`scripts/setup-owner-columns.mjs`). Webhooks drop from 18 subscriptions to 2
(`create_item` + `change_column_value` on the one board, shared secret in the URL — Monday
doesn't sign payloads); subscribe/prune via `scripts/setup-webhooks.mjs` after deploying the
Worker with the matching `MONDAY_WEBHOOK_SECRET`. **Scoped entirely to the CRM Sandbox** —
every board id in `config/sandbox.json` is a sandbox board,
not a production one (production doesn't exist yet; real cutover is October — `config/svbc.json`
is the production placeholder file until then), so nothing this Worker does can touch live donor
data. The era-board deployment was verified end-to-end 2026-08-25 (webhook → D1 → queue →
consumer → Monday fetch → recompute → write-back, correct cross-board totals); re-verify the
same flow against the v2 board after the webhook cutover.

**Archived donations and this Worker:** most gifts on the v2 board are archived in place.
Archived items reject all writes and their `board_relation` columns read empty, but they remain
readable by id — which is exactly what the recompute path does (`items(ids: [...])`), so
historical gifts still count. Corollary: `donation_links` rows for archived donations can never
be re-derived from Monday — the importer's artifacts are their only source (docs/20).

**When a gift leaves an owner (issue #26).** An empty Donor link means one of three things, and
the consumer asks Monday for the item's `state` to tell them apart:

- **Archived:** the gift still counts. The D1 owner is used as before.
- **Deleted, or active with the link cleared:** the gift no longer counts for anyone. Its
  `donation_links` row is dropped, the `gifts` row is soft-removed (`removed_at`, migration 0008),
  and the owner it left is recomputed. Every total and projection ignores removed rows. A restore
  or re-link clears `removed_at` on the next recompute, with provenance intact.
- **Moved to a different owner:** `upsertLink` returns the previous owner. The consumer queues an
  owner-keyed recompute for it (`RecomputeQueueMessage.ownerItemId`), which is never coalesced.
  The recompute is queued, not run inline, to stay inside the per-invocation subrequest
  budget `max_batch_size` is sized for.

Deletes only arrive if the board is subscribed to `item_deleted`, so `scripts/setup-webhooks.mjs`
now also subscribes `item_deleted`, `item_archived` and `item_restored`. Re-run it once on
existing boards; it only adds the missing subscriptions.

**Deploy order for #26:** apply `0008_gifts_removed_at.sql` to the remote D1 database
(`wrangler d1 migrations apply svbc-donation-rollups --remote`) **before** merging. `refreshFacts`
and every ledger total name `removed_at`, so an unmigrated database breaks every consumer message
the moment the build goes live, the same hazard as 0007 below. Then re-run `setup-webhooks.mjs`.

**Priority:** Post-migration, non-blocking — the initial correct values ship as part of
`salesforce-import`'s one-time load; this Worker is what keeps them from going stale afterward.
**Owner:** David (decided 2026-10-09).
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
account was on Workers Free at the time (it's on Workers Paid now, confirmed 2026-09-29). D1 analytics for this database:

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
land in `donation-rollups-recompute-dlq`. The DLQ had **no consumer** (until fix 5), so there
was nothing to read or replay from it (`wrangler queues info donation-rollups-recompute-dlq`:
0 producers, 0 consumers). The D1 rows were never touched again.

**Queue retention, corrected 2026-09-18.** Both donation-rollups queues were created on 08-25
with a `message_retention_period` of **1 day**, not the 4-day default this section first
assumed (the main queue's settings were never modified after creation; the funraise-sync queues
created 09-18 show the 4-day default). And the platform evidently does not delete an expired
message until it tries to deliver it: when the fix-5 consumer first attached, ~2,700 messages
from the 09-03/09-09 floods — two weeks past a 1-day retention — were dropped in that minute,
while ~300 from the previous day were delivered. So for three weeks the DLQ's contents were
simply unobservable. Settings since 2026-09-18 21:00 UTC: DLQ retention **14 days** (the
maximum — a safety net if delivery is ever paused or the consumer breaks), main queue **4 days**
(fix 4 can defer a quota-hit message up to 12 h, and a second deferral would have crossed a
1-day retention and been dropped before its retry):

```sh
npx wrangler queues update donation-rollups-recompute-dlq --message-retention-period-secs 1209600
npx wrangler queues update donation-rollups-recompute --message-retention-period-secs 345600
```

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

1. ~~**Workers Paid is the decisive fix.**~~ **Done — the account is on Workers Paid (Project
   Galileo, confirmed 2026-09-29):** D1 has no daily write cap (50M rows written/month are
   included, then $1 per million), CPU goes to 30 s by default, subrequests to
   10,000/invocation. Everything below is hardening that is worth doing regardless — more so
   now that a flood costs money instead of stalling.
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
   without any Monday calls. Monday rate-limit and complexity-budget errors get the same
   batch-wide deferral (issue #27): `delaySeconds` of 60 s doubling per delivery attempt, never
   less than Monday's `retry_in_seconds` / `Retry-After` hint, capped at 12 h; a
   `DAILY_LIMIT_EXCEEDED` with no hint defers to midnight UTC (Monday's daily reset) exactly like
   the D1 quota. A message deferred behind a failing batch sibling still spends one of its own
   retries (either path); if that exhausts them it lands in the DLQ, is marked `failed` there,
   and can be re-driven. Other errors still retry immediately. `max_batch_size` is 2: D1
   queries count against the 50-subrequest budget and a full recompute costs ~16–26, so two
   worst-case recomputes fit and three don't (the default 10 is what produced the three
   "Too many subrequests" rows). Raised to 10, with `max_concurrency` 3, on Workers Paid
   (cap 1,000) on 2026-10-28; `wrangler.jsonc` has the sizing and the sandbox measurements.
   Concurrency > 1 needs the per-owner lease (migration `0010_owner_leases.sql`, see "Concurrent
   gifts"): apply it to each remote D1 **before** deploying a build that takes the lease, or every
   recompute fails on the missing table.
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
   queue's then 1-day retention (expiry is enforced lazily, on delivery — see "Queue retention,
   corrected" above), but ~300 messages from the previous day's hand re-drive were
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
  retention was 3 days on Free; it's 7 on Paid). Expect some loss under a burst; the owner-coalescing in fix 3
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
Monday.com (the single Donations board — config/sandbox.json (or svbc.json for production))
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
People / People (Historical) / Organizations board (ids + column ids in config/sandbox.json (or svbc.json for production))
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
`pending_recomputes` cleared. Re-run `bootstrap-gifts-from-artifacts.mjs` (it writes both
`bootstrap-gifts.sql` and `bootstrap-affiliations.sql`), then
`wrangler d1 execute svbc-donation-rollups --remote --file bootstrap-gifts.sql -y` and
`wrangler d1 execute svbc-donation-rollups --remote --file bootstrap-affiliations.sql -y` — the
`-y` matters: without a TTY, wrangler's confirm prompt silently cancels with exit 0 — after any
fresh load, since item ids change between loads.

## Membership — the activity rule (spec `docs/superpowers/specs/2026-10-09-membership-activity-rule-design.md`)

A person is a member when they have **given at least $1 or volunteered at least 1 hour in the
last 13 months.** This Worker keeps eight membership columns on every People / People
(Historical) item true to that rule from the person's full history, as one more step of the
recompute (after the rollups), and stamps Term Start / Term End / Membership Type on each
post-cutover qualifying gift. Gated on `donationRollups.membership` (null = off) and on an owner
board having a `membership` column block; Organizations never get a term. Volunteer activity
never touches the giving rollups.

**What counts as an activity:**

| Kind | Source | Qualifies when | Date |
|---|---|---|---|
| gift | Donations (D1 `gifts`) | Status = Received, Gift Type in `eligibleGiftTypes` (`["Donation"]`), amount ≥ `minAmountCents` ($1.00), a valid date — no date gate: a qualifying gift before `fromISO` counts too (as ordinary activity — Lifetime only when the gift is dated on/after `fromISO`) | Gift date |
| migrated term | Donations dated **before** `fromISO` | a pre-`fromISO` gift that does not itself qualify, with a migrated Term Start, counts on that Term Start — **regardless of its amount, type or status** | Term Start |
| volunteer check-in | Event Registrations (D1 `volunteer_activity`) | Role ∈ `volunteerRoleLabels` (Volunteer) and Attendance ∈ `countedAttendanceLabels` (Attended); Hours ≥ 1, or **blank, which counts as 1**; an explicit 0 or 0.5 does not | the linked Event's Start (a registration has no date of its own) |
| historical shift | Volunteers board, 2014–2020 (read once, by the post-cutover recompute) | Status ∈ `countedStatusLabels` (Completed) and Hours ≥ 1 | the shift's Date |

Migrated terms are trusted as stamped because Salesforce never booked membership revenue as
Opportunity amounts and comp terms have no gift at all — an amount gate over history would
un-member people who were members. `fromISO` (the cutover date) is therefore the boundary between
*migrated history, trusted as stamped* and *the live rule, amount-gated*, not an exclusion.

**Runs.** Sort an owner's activities by date (ties by kind, then item id, so the order is
stable). Each activity reaches `addMonths(date, termMonths)` (13; Feb 29 and month-end overflow
roll to the 1st). An activity dated on or before the previous one's reach extends the current
run; a later one starts a new run. A run's start is its first activity's date and its end is its
last activity's date + 13 months; the last run is the current one, the rest are earlier. A gap of
exactly 13 months to the day is still one run.

**The eight owner columns:**

| Column | Derivation |
|---|---|
| Member Since | first run's start — min with the board value (never later than what staff or the import wrote) |
| Current Term Start | the current run's start — written outright |
| Member Until | blank if Tier = Lifetime; else the current run's end, max with the board value (comps survive) |
| Membership Tier | Lifetime if any qualifying gift is ≥ `lifetimeThresholdCents` — Lifetime only when the gift is dated on/after `fromISO` — or the board already says Lifetime; else Member; untouched when the owner has no activity and no board membership |
| Membership Status | Active if Tier = Lifetime or the written Until ≥ today (UTC); else Lapsed |
| Lapse Count | the number of earlier runs — written outright. A currently lapsed member's own lapse is not counted until they come back and start a new run |
| Last Lapsed | the last earlier run's end, blank when Lapse Count is 0 — written outright |
| Member Type | `anniversary` = Current Term Start + 13 months. **Continuing** if today ≥ anniversary **and** the run's end is past the anniversary (the run holds more than one activity — otherwise a single-activity run would read Continuing for the one day it is both past its anniversary and still Active). Else **New** if Lapse Count = 0, else **Lapsed renewal**. On lapse the last value stays; Status already says Lapsed |

Member Type is the only column that depends on today without an event, which is why the nightly
`membership` duty exists (below).

**Per-gift stamps** apply to post-`fromISO` qualifying gifts only: Term Start = gift date, Term
End = gift date + 13 months (blank for a Lifetime gift), Membership Type = **New** if the gift
starts the owner's first run, **Lapsed renewal** if it starts a later run, **Continuing** if it
extends a run, **Lifetime** for a Lifetime gift (`typeLabels` keys `new` / `continuing` /
`lapsedRenewal` / `lifetime`; the same labels serve the owner's Member Type). A gift that lands
while the owner is already Lifetime gets no stamp (Salesforce's "already a life member" exit).
Migrated per-gift terms (before `fromISO`) keep their 12-month ends and old labels — only the
owner columns are recomputed over history. Volunteer activities stamp nothing.

**Merge with the board** is **extend-only** for Since (min), Until (max, blank for Lifetime) and
Tier (never downgrades), so a staff-granted comp or Lifetime is never shortened; shorten by hand
if you mean to. Current Term Start, Lapse Count, Last Lapsed and Member Type are derived facts
**written outright** — a staff edit to them is overwritten on the next recompute. All eight
writes, and the gift stamps, are compare-before-write, so a stamp's own webhook triggers one idle
recompute and stops (that recompute still writes the owner rollups and descriptions; only the
membership keys and stamps are compared away).

* **Enabling — order matters.** Migration `0009_membership_activity.sql` (`volunteer_activity`,
  `gifts.term_start`, `pending_recomputes.kind`) must be applied **before deploying the build
  that reads it** — the same ordering lesson as 0005/0006, and stricter: the webhook insert
  writes `kind` and the ledger refresh reads and writes `term_start` whether or not the
  membership block is on, so deploying first breaks every recompute, not just membership. 
  `config/sandbox.json` carries `membership: null` today (it turns on once the CRM Sandbox v3
  column ids are filled in); `config/svbc.json` carries the full block with
  `REPLACE_WITH_COLUMN_ID` / board-id `0` placeholders that must be replaced before it is
  deployed. For any other database (a fresh fork, the production cutover) the safe first deploy
  sets `donationRollups.membership` to `null` until 0009 is applied and the ids are filled. In
  order:
  1. `CI=1 wrangler d1 migrations apply svbc-donation-rollups --remote`
  2. `MONDAY_API_TOKEN=… node scripts/setup-membership-columns.mjs <peopleBoardId> [<peopleBoardId> …] [--registrations <eventRegistrationsBoardId>]`
     — finds the four existing columns by title, creates Current Term Start, Member Type, Lapse
     Count and Last Lapsed, and (with `--registrations`) an Hours column on Event Registrations;
     prints config-ready blocks. The Donations board's `termStart` / `termEnd` /
     `membershipType` column ids are unchanged, but its Membership Type status needs the labels
     New / Continuing / Lapsed renewal / Lifetime.
  3. set `donationRollups.membership`, the eight-key `membership` block under each People board
     in `ownerColumnsByBoard`, `volunteerBoards` and `historicalVolunteerBoards` in
     `config/<env>.json`, then deploy:

  ```json
  "membership": {
    "fromISO": "2026-10-30",
    "eligibleGiftTypes": ["Donation"],
    "minAmountCents": 100,
    "termMonths": 13,
    "lifetimeThresholdCents": 100000,
    "statusLabels": { "active": "Active", "lapsed": "Lapsed" },
    "tierLabels": { "member": "Member", "lifetime": "Lifetime" },
    "typeLabels": { "new": "New", "continuing": "Continuing", "lapsedRenewal": "Lapsed renewal", "lifetime": "Lifetime" }
  }
  ```
  `fromISO` is the cutover date; set it to the real one when fixed. With the block on, every
  board that has a `membership` entry must carry all eight column ids, `volunteerBoards` may be
  empty (a gifts-only rule) but not absent, and `hours: null` is accepted while the Event
  Registrations Hours column does not exist (blank counts as 1 hour either way).
* **Webhooks.** `scripts/setup-webhooks.mjs` now also subscribes `create_item`,
  `change_column_value`, `item_deleted` and `item_restored` on every `volunteerBoards[]` board
  (a check-in, an Attendee re-point, a deletion or a restore must reach the consumer — a
  restored registration is re-read), to the same route; the Worker accepts a registration event
  only for `create_item`, `item_deleted` and `item_restored` (neither carries a `columnId`, so
  both always enqueue) and `change_column_value` on the configured Attendee,
  Event, Attendance, Role and Hours columns, and acknowledges everything else. The historical
  Volunteers board gets **no** subscription — it is record-keeping. An Attendee re-point
  recomputes both the old and the new person. A registration with no Event link or no Event Start
  is stored as non-qualifying, not a fault; an archived registration keeps its last read (archived
  items read empty board relations — the same trap as archived gifts, issue #26), and one read
  back with state `deleted` is treated as deleted. The all=true load stores archived and deleted
  registrations as non-qualifying, so a row loaded earlier stops counting.
* **The `membership` duty.** Every run (nightly at 09:00 UTC, and first thing in every all=true
  run) recomputes everyone whose 13-month anniversary of Current Term Start fell since the last
  run's `anniversariesThroughISO` — normally just today; after missed nights it catches up, at
  most 31 days back — so Member Type moves from New to Continuing without an event, tens of
  people a night. On demand, it is the **post-cutover
  recompute**, run once after the cutover load and the webhook subscriptions, before Gate C and
  before the November Board Elections export:

  ```
  POST /custodian/run/membership?all=true[&since=<ISO>]   (Authorization: Bearer $CUSTODIAN_SECRET)
  ```

  Call it with a long client timeout (the HTTP request returns only when the run's slice
  finishes; a 120 s timeout recorded no run on the sandbox). Repeat it — or leave it to the
  09:00 UTC cron, which continues an unfinished pass — until `detail.remaining` is `0`. Three
  phases, in order, each idempotent:
  1. `load-volunteers` — the historical Volunteers board and every Event Registrations item
     (with each registration's Event Start) into `volunteer_activity`, 50 rows per D1 batch.
     Reads only on Monday; runs once at the start, in the first run.
  2. `backfill-terms` — reads the migrated Term Start of every pre-`fromISO` gift into
     `gifts.term_start` (archived gifts included — the webhook path never reads them),
     `BACKFILL_PER_RUN` = 5,000 gifts a run, cursored (~37,000 gifts, so about eight runs).
  3. `enqueue` — one owner-keyed recompute for every owner with a gift on a membership board,
     plus everyone with a qualifying check-in, `ENQUEUE_PER_RUN` = 3,500 owners a run with an
     owner-id cursor. Never-donors with no check-ins are not recomputed by this pass — there is
     nothing to derive for them, and their board membership stays as imported. It skips only
     owners recomputed after phases 1–2 finished (`detail.loadedAtISO`) — a recompute before
     then read incomplete history — or after `since`, whichever is later. The runbook order is
     phases 1–2 first, then the sweep: a sweep recompute after the load is skipped here
     automatically, so people the sweep covered are not recomputed twice (`since` only ever
     moves the skip instant later). Owner-keyed messages bypass the `owner_recomputes`
     coalescing (each one is a full recompute); the daily D1 write quota still applies.

  A run that crashes mid-way records no `detail`, so there is nothing to continue from: re-issue
  `?all=true` (passing `since` again — the restart loses it), which restarts at phase 1
  (idempotent). Because the pass is just the normal
  recompute per owner, there is no separate 12→13-month migration: the fold rewrites every owner
  column from history, the extend-only merge keeps anything staff set higher, and nobody loses
  status (13 months is longer than 12). Re-running it on the same inputs writes nothing.
* **Known limits.** A staff comp that only extends Until does not bridge two runs, so a person
  comped across a gap still counts one lapse — if a comp should count as activity, log it as a
  volunteer registration. Migrated terms on the 6,619-term placeholder Opportunity have no Term
  Start and so do not seed runs; Member Since still comes from the board, through min.
* **Auto-lapse** stays a native board automation ("When Member Until arrives … set Membership
  Status to Lapsed"); this Worker agrees with it by construction. `mailchimp-sync` picks up the
  People changes through its own webhook; the donor portal reads the same columns.
* **Funraise gifts** qualify only because `funraise-sync` stamps Gift Type = Donation on the
  items it creates (see that README) and only once its Date column transform lands — a gift
  with an empty Date never starts a term.
* Not replicated: Salesforce's inconsistent Lifetime firing, and the Matching Donation terms
  staff created by cloning gifts. Add `"Matching Donation"` to `eligibleGiftTypes` if that
  practice should continue.
* **Recurring donors:** every recurring charge is a Received Donation of at least $1, so a
  monthly donor extends their run with each charge; their Member Until is always 13 months past
  the latest charge.
* **Expiry-day boundary:** the Worker counts Member Until = today as Active; the native
  automation lapses on that day. A recompute on the expiry date can flip Lapsed back to Active
  for that one day. The Worker's "today" is UTC, the automation's is the account timezone.
* **Lifetime Term End:** post-cutover Lifetime gifts have a blank Term End; migrated Lifetime
  history carries 2122-01-01. Sorting "Membership payments" by Term End mixes the two.
* **Refunds:** a gift flipped to Failed drops out of the fold but keeps its stamped term columns;
  the owner's Until is recomputed from what remains but, being extend-only, never shortens below
  what the board already says — same as Salesforce. Shorten by hand if intended.
* **Concurrent gifts:** two gifts for one owner never recompute at once. Each recompute holds a
  per-owner lease in D1 (`owner_leases`, migration 0010) from before its Monday read to after its
  write; a second message for that owner retries 30 s later and re-reads, often coalescing away.
  Before 2026-10-28 they could interleave: the recompute that read first could write last and
  overwrite fresher totals, and a plain amount edit sends no further webhook to repair that.
  A lease whose holder died expires after 5 minutes.
* **What changed from the 2026-09-15 write path:** the rule is activity-based (gift ≥ $1 or a
  volunteer hour) instead of "any Received Donation"; `termMonths` 12 → 13; `minAmountCents`
  added; the `typeLabels` keys `renewal` / `reacquire` became `continuing` / `lapsedRenewal`
  (Renewal and Reacquire no longer exist as labels); four owner columns added (Current Term
  Start, Member Type, Lapse Count, Last Lapsed); and the `membership_baseline` capture retired —
  a full-history fold is deterministic from the ledger, so the table (migration 0005) is no
  longer read and its per-owner reset runbook line is gone. The table stays; dropping it is a
  separate migration, not worth a deploy.

## Ledger v2 + the custodian (docs/20 §5.1/§5.3)

D1 is the **authoritative gift ledger**, not just a reverse index: `gifts` (one row per gift —
amount in cents, date, fiscal year, status, provenance, archived state) and `annual_summaries`
(one row per closed fiscal year, restatement-stamped). Monday stays the working surface; staff
edits flow back via webhooks, and every recompute re-asserts the facts of every gift it reads,
so the ledger self-heals. Bootstrap: `scripts/bootstrap-gifts-from-artifacts.mjs` (37,286 gifts
loaded 2026-08-31; 32,739 Received, 33,541 archived).

The **custodian** runs its duties (listed below) from one daily cron (09:00 UTC; `dutiesForDate` gates them)
and mirrors each as an authenticated route — `POST /custodian/run/{archive|capacity|sweep|reconcile|requeue|classify|membership|recurring|rollcall}`
and `GET /custodian/status` (last run per duty, from `custodian_runs`), each with
`Authorization: Bearer <CUSTODIAN_SECRET>` (issue #63 — its own secret, never the webhook's,
which sits in Monday's webhook URL; a `?secret=` query parameter is ignored; unset = every
custodian route 401s):

```sh
curl -X POST -H "Authorization: Bearer $CUSTODIAN_SECRET" \
  'https://svbc-donation-rollups-sandbox.svbc-account.workers.dev/custodian/run/classify'
```


* **archive** (July 15 + on demand) — archives active gifts past the retention window
  (`custodian.activeFiscalYears`), then materializes closed-year summaries. Idempotent.
* **capacity** (Mondays) — every board in the workspace vs its item limit; alerts at
  `capacityAlertPct` (update posted to `custodian.alertItemId`). First live run immediately
  flagged Activities v2 at 90% — a true positive.
* **sweep** (July 1) — one recompute per owner so This/Last Year splits roll over at the
  fiscal boundary (closes the staleness gap in Not-yet-done).
* **reconcile** (nightly) — per-owner ledger cents vs Monday's Lifetime Giving (rounded-cents
  comparison — values written before issue #27 carry float noise; since then every money column
  is written from integer cents as two-decimal text) plus summaries vs fresh ledger totals. First full
  pass 2026-08-31: 6,886 owners, zero mismatches.
* **requeue** (nightly) — re-enqueues pending rows the queue never finished (`queued`/`received`
  older than 24 h); quiet when there are none, alerts when there were (fix 5 in "Status and
  verification" above).
* **classify** (nightly + on demand) — fills the four chartable gift labels on the Donations board
  (see "Chartable gift labels" below). Capped per run; re-run until `detail.remaining` is `0`.
* **recurring** (nightly) — keeps People's **Has Active Recurring Gift** checkbox in step with the
  Recurring Gifts board, which the Postal appeal list filters on (monday-migration docs/35 §3.1).
  Recurring Gifts isn't a Donations board, so no webhook reaches this Worker when a subscription
  starts or lapses; each night it reads every Recurring Gifts item (Status + Donor) and every
  flagged People board, and writes only the cells that disagree, at most 500 a run (the rest
  next night). Off until `donationRollups.recurringGifts` is configured. `salesforce-import`
  seeds the column at migration, so the first night writes little.
* **rollcall** (nightly + on demand) — maintains the **Donor Roll Call** board (see "Donor Roll Call
  board" below) from the D1 ledger and the donor boards. Off until `donationRollups.rollCall` is
  configured; `rollCall: null` turns it off.

**Gift-history projections (docs/20 §5.5)** ride every recompute: each owner item gets a
`Gift Ledger (JSON)` text column — the full lifetime history as compact newest-first tuples
`[itemId, dateISO, cents, type, status, actingForItemId|'']` (the sixth element is the
affiliation model's — see below — empty string for a gift with no Acting for), sourced from the
D1 ledger so it includes archived gifts and their types — plus a markdown gift-history table in
the item description with a deep link per gift. The description write is **deliberately
non-fatal**: `set_item_description_content` returns a bare `Internal server error` for any
markdown on a board whose item view lacks the **Item description** widget, so a failure logs
"gift-history description skipped" and moves on rather than burning queue retries over a
redundant rendering of the JSON column. **Add that widget by hand to the item view of every owner
board** (open an item → **+** in the item view header → Item description) before the first sweep;
there is no API for it. Once it's there, writes succeed for every item on the board, including
items with no description yet (verified on the sandbox 2026-10-30; the 2026-08-31 reading that
the feature was off for the whole account was wrong). Provision the
column via `setup-owner-columns.mjs` (it's part of the 13-column set now).

**The Annual Giving Summary board (docs/20 §5.4)** — created by
`scripts/setup-annual-summary-board.mjs`, one item per closed fiscal year (Fiscal Year Ending, Total
Received, Gift Count, By Gift Type, Restated), written ONLY by the custodian's archive duty:
new years created once, and a closed year rewritten only when the ledger's totals changed (an
audit restatement — the Restated date is stamped). D1's `annual_summaries` stays authoritative;
the board is its staff-facing projection, wired via `custodian.annualSummaryBoardId` +
`annualSummaryColumns` in config.

Duties that touch many items **slice themselves** and report `remaining` + a cursor (re-run to
continue): the slices were sized for the Workers Free plan's 50 subrequests/invocation, Monday caps `items(ids:)`
at 100 ids — and note `items(ids:)` **silently returns 25 items unless you pass `limit: 100`**
(bit for real 2026-08-31: 75% of owners read back "missing"; the same default would silently
under-roll any donor with >25 gifts on one board — every batched read in `monday/client.ts`
now passes an explicit limit). The account is on Workers Paid now (confirmed 2026-09-29), so the per-run slice
constants in `custodian.ts` can grow — not yet done.

## Chartable gift labels and Donor Level (spec 2026-09-29)

**Chartable gift labels.** Monday charts group by status/dropdown columns, not formulas or text,
so the custodian's `classify` duty writes four status columns on each Donations board that has
`donationBoards[].columns.classification` configured: **Funding Stream** (Individual Giving,
Membership, Sponsorships, Grants & Contracts, Matching Donations, Other Program Revenue),
**Gift Size** (`< $100`, `$100–249`, `$250–999`, `$1k–4.9k`, `$5k+`), **Fiscal Quarter** and
**Gift Fiscal Year** (labels created on first write). Values come from `classifyGift` over the
gift's amount, date and type. It runs nightly and on demand
(`POST /custodian/run/classify` with the custodian Bearer secret), skips gifts already correct, and writes at most
`CLASSIFY_WRITES_PER_RUN` (300) gifts per run — repeat until `detail.remaining` is `0` (~13 runs
for the first ~3,800 gifts). Provision with `scripts/setup-classification-columns.mjs <donationsBoardId>`.

**Webhook ignore rule.** The donation webhook drops any change to a classification column
(`ignored: classification column "<id>"`). Those columns are Worker-written, and Monday delivers
a webhook for every API write; without the rule each classify write would enqueue a recompute
for the gift's owner — the same self-inflicted flood as 09-03.

**Donor Level.** Every recompute also writes a **Donor Level** status column on People and
Organizations (`ownerColumnsByBoard[id].donorLevel`; created by `setup-owner-columns.mjs`):
**Leadership** when lifetime giving >= $5,000 (`leadershipLifetimeCents`); **Major** when lifetime
>= $500 (`majorLifetimeCents`) or largest gift >= $200 (`majorLargestCents`); otherwise **Donor**; no gifts, no level.
Thresholds and labels live in `donationRollups.donorLevel` (both configs); absent column id means
nothing is written. It is a status column, not a formula, so board views can group by it.

## Affiliation model (Plan 2)

A gift a Primary Contact drove **for an organization** — rather than personally — carries an
"Acting for" attribution to an Affiliation item (Person + Organization, on its own Affiliations
board). This model adds two new money rollups on top of phase 1's per-owner ones, gated entirely
behind `config.affiliations`: `null` (the default) turns off every behavior described here — the
consumer skips phase 2 outright, and the custodian skips reconcile legs 5/6. The one exception is
the bootstrap script, which populates the `affiliations` table from artifacts unconditionally
(it's not gated on this config flag) — see Bootstrap below.

**What phase 2 writes and reads.** After the phase 1 owner write, the consumer
(`src/consumer/processBatch.ts`) recomputes:

* **Attributed Giving / Attributed Gift Count / Last Attributed Gift** on the affiliation(s) a
  gift is tied to — its own affiliation, and, if the gift's "Acting for" just changed, the
  affiliation it moved away from too, so the old tenure's totals don't stay stale
  (`affectedAffiliations`). Lifetime totals, not fiscal-year split — there's no This/Last Year
  for an affiliation.
* **Organizational Giving** on every Person those affiliations belong to — the sum, across all
  of a person's affiliations, of what they've driven for every organization they're linked to
  (computed from the D1 ledger, like the attributed totals above). Which Person an affiliation
  currently belongs to is re-read fresh from Monday each time (`getAffiliationSummary`), since
  the Affiliation → Person link can be re-pointed on Monday directly; D1's `affiliations` table
  remembers the *previous* person for exactly that case, so a re-point still zeroes out the
  person who lost the tenure instead of leaving their total stuck at its last value.

Both are full recomputes from the D1 `gifts` ledger (via the new `acting_for_item_id` column and
the `affiliations` table, migration `0007_affiliations.sql`), the same self-healing design as
phase 1's owner rollups. The gift-history markdown gains a "Driven for organizations" section for
a Person who drives giving for one or more organizations (non-fatal like the rest of the
description write, and omitted — not shown as a $0 row — for an affiliation with no gifts). The
`Gift Ledger (JSON)` tuple format above already carries the affiliation this gift was attributed
to, so the ledger and the Attributed/Organizational rollups always agree on provenance.

**Archived-gift rule.** `gifts.acting_for_item_id` is kept unchanged for archived gifts — an
archived item's `board_relation` columns read empty on Monday (see "Why a D1 reverse index"
above), so re-deriving "Acting for" from a live fetch would silently blank out every archived
gift's attribution. The recompute path only refreshes `acting_for_item_id` from a Donation it can
still read the column on.

**Bootstrap.** Before merging the branch that adds this affiliation model, apply migration
`0007_affiliations.sql` to the remote D1 database **first**:
`wrangler d1 migrations apply svbc-donation-rollups --remote`. Apply it before the new code is
deployed — by `npm run deploy`, or on merge once a Workers Builds connection exists (none does as of
2026-09-28; root README, "Deploys") — because the consumer's `refreshFacts` names the `acting_for_item_id` column unconditionally (phase 1 or
not) — an unmigrated remote D1 breaks every consumer message the moment the new build goes live,
not just the affiliation-specific ones. Once the migration is applied,
`scripts/bootstrap-gifts-from-artifacts.mjs` writes two SQL files — gifts
(`--out`, default `bootstrap-gifts.sql`) and affiliations (`--out-affiliations`, default
`bootstrap-affiliations.sql`) — both applied the same way:
`wrangler d1 execute svbc-donation-rollups --remote --file <file> -y` (see "Bootstrap history"
above for the exact commands). It refuses, without `--force`, when a gift's "Acting for" target
or an affiliation's Person isn't a migrated People item — a superseded or incomplete artifact set,
the same guardrail reasoning as the existing owner/board checks.

**Provisioning.** `scripts/setup-affiliation-columns.mjs` (same shape as
`scripts/setup-owner-columns.mjs`) ensures the Affiliations board has `Attributed Giving`
(numbers, currency), `Attributed Gift Count` (numbers), and `Last Attributed Gift` (date),
locates its existing `Person` board_relation column (this one it never creates — it must already
exist, and the script errors if it's missing or the wrong column type), and ensures
`Organizational Giving` (numbers, currency) on every People board passed to it. It also reads the
Donations board id out of `config/sandbox.json` (or `svbc.json` for production) and looks up that board's `Acting for` column, so
the printed output is ready to paste straight into config — `affiliations`,
`organizationalGivingByBoard`, and a reminder with the `actingForLink` column id.

**Reconcile legs 5/6.** The custodian's nightly reconcile duty gained two more legs once
`config.affiliations` is set: leg 5 compares every affiliation's ledger total against its
`Attributed Giving` column, leg 6 compares every person's ledger total against their board's
`Organizational Giving` column. Both are sliced and cursored like the owner walk
(`affiliationCursor`/`personCursor` in the run's `detail`, 2,000 ids — 20 `getItemsColumnsText`
calls — per leg per run), and — unlike legs 3/4, which are cheap enough to ride along with an
owner slice — they only spend Monday subrequests in an invocation whose owner slice came back
empty, to stay under the Workers Free plan's 50-subrequest cap. Each run's `detail` report
carries `affiliationRemaining` and `personRemaining` to show progress; how many nights a full
cycle takes depends on the board sizes and is visible in `custodian_runs`, not a fixed number here.
Now that the account is on Workers Paid (confirmed 2026-09-29), the per-run slice constants
(`RECONCILE_AFFILIATIONS_PER_RUN` and `RECONCILE_PERSONS_PER_RUN` in `src/custodian/custodian.ts`)
can grow to complete cycles faster — not yet done.

**Subrequest budget in the consumer.** `getAffiliationSummary` costs two Monday subrequests per
affiliation touched. A single gift touches at most two affiliations (its own, plus one it moved
away from), so this is nowhere near the Free plan's 50-subrequest cap — but a bulk re-point
(many gifts changing "Acting for" in one deploy) could approach it if it ever landed in one
consumer invocation. `wrangler.jsonc`'s consumer `max_batch_size` (10 on Workers Paid's
1,000-subrequest cap) keeps that bounded — phase 1 costs `4 + ceil(gifts / 100)` Monday
subrequests per message, plus phase 2 adds 3 calls per affected affiliation and 1 call per
affected person.

**Deferred.** Non-money rollups — registrations, volunteer hours, activities — are out of scope
for this plan; a Person's or Organization's non-giving activity isn't touched here. Also
deferred: re-pointing a gift's Donor link after cutover (bulk corrections), which belongs to the
resolver Worker in Plan 3, not this one.

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

## Donor Roll Call board

The Annual Impact Report's donor roll call as a Monday board (spec
`../docs/superpowers/specs/2026-11-02-donor-roll-call-board-design.md`; the rules are
monday-migration `docs/40` §3). **Donor Roll Call** has one group per fiscal year (`FY2027 (in
progress)`, `FY2026`, newest first) and one item per donor per year: a household (people sharing
a **Household ID**), an individual, an organization, or the pooled Anonymous row. Columns: Name
(the Household Greeting, or Recognition Name for an organization, else Name), Fiscal Year, Tier
(`$50,000+` down to `Under $100`), Type, Listed (`Listed` / `Don't list`), Total, Gifts, People,
Organization, Review Note and Row Key (`2026|household:<Household ID>`, `2026|item:<itemId>`,
`2026|anonymous` — the identity the Worker matches on; don't edit it). Donors with **Don't List in
Recognition** checked stay on the board marked `Don't list`, so totals still add up; the saved
views leave them out.

**The duty.** `rollcall` runs nightly from the custodian cron, behind the `donation-rollups:writes`
switch. It reads the ledger (`gifts` for `firstFiscalYear` through the current year, archived gifts
included, so closed years recompute without touching Donations), refreshes `roll_call_credits`,
reads People, People (Historical) and Organizations, computes the rows, and diffs them against the
board by Row Key: only differing cells are written, at most `writesPerRun` (500) per run, with
`remaining` reported. Closed years recompute too, so a late correction to an old gift shows up.
On demand:

```sh
curl -X POST -H "Authorization: Bearer $CUSTODIAN_SECRET" \
  'https://svbc-donation-rollups-sandbox.svbc-account.workers.dev/custodian/run/rollcall'
```

**Mass-delete guard.** A run that would delete more than `max(10, 10% of the board's items)` rows
as `gone`, or whose computed rows are empty while the board has items, applies nothing and says
so in its report (a failed upstream read must never empty the board). Check the ledger and donor
reads, then re-run with `POST /custodian/run/rollcall?force=1` to apply anyway.

**`roll_call_credits`** (migration `0011`). The ledger can't credit three kinds of gift: Matched By
isn't stored in `gifts`; gifts with no Donor never reach the ledger (the consumer finds a gift
through its Donor link); and the Anonymous Donor flag isn't stored. Rather than make
`gifts.owner_item_id` nullable (which touches every owner-keyed query), the duty owns a side
table: each night it pages the active Donations items and upserts a row for every gift whose
credit isn't simply its Donor — a Matching Donation with Matched By, anything marked Anonymous
Donor, anything with no Donor — plus an `unmatched_match` flag for an employer match with no
Matched By. A row is dropped when its gift no longer qualifies or is deleted. When a gift
archives its row is **kept** and stamped `archived_at` (an archived item's connect columns read
back empty, so it can't be recomputed from Monday); that keeps closed years reproducible. The first
night fills the table; no backfill is needed.

### Setup

1. **Household columns.** The People boards need **Household ID** and **Household Greeting**.
   monday-migration's `scripts/copy-household-greetings.mjs --people <id> [--people-historical <id>]
   [--execute]` creates and fills them from Salesforce (dry run by default).
2. **Create the board and donor-side columns** (idempotent; same-titled columns are reused, so it
   is safe to re-run with `--board <id>`):

   ```sh
   MONDAY_API_TOKEN=... node scripts/setup-roll-call-board.mjs --workspace <id> [--name "Donor Roll Call"] \
     [--board <existingId>] --people <id>[,<id>] --organizations <id> --donations <id>
   ```

   It creates the board with the ten columns (Tier, Type and Listed seeded with every label the duty
   writes, since the duty never creates labels), adds **Don't List in Recognition** (checkbox) to
   each People board and Organizations and **Recognition Name** (text) to Organizations, looks up
   the existing columns the duty reads, creates the three saved views, and prints the
   `donationRollups.rollCall` block for `config/{sandbox,svbc}.json`. Sandbox v4 (board
   `18438151197`) is in `config/sandbox.json`:

   ```json
   "rollCall": {
     "boardId": 18438151197,
     "firstFiscalYear": 2026,
     "excludedGiftTypes": ["Contracts"],
     "writesPerRun": 500,
     "columns": { "fiscalYear": "text_mm8qv10g", "tier": "color_mm8qxft1", "type": "color_mm8qdsja",
       "listed": "color_mm8qhc0q", "total": "numeric_mm8qcd2t", "gifts": "numeric_mm8qzkfg",
       "people": "board_relation_mm8qxrg6", "organization": "board_relation_mm8qsb72",
       "reviewNote": "long_text_mm8qna43", "rowKey": "text_mm8qmpb2" },
     "donations": { "boardId": 18437342657, "columns": { "amount": "numeric_mm8hn1b2", "status": "color_mm8hshet",
       "fiscalYear": "text_mm8hpk76", "giftType": "text_mm8h238c", "donorLink": "board_relation_mm8hhdk7",
       "matchedBy": "board_relation_mm8hs607", "anonymous": "boolean_mm8h4a5h" } },
     "people": {
       "18437342592": { "householdId": "text_mm8qmhc8", "householdGreeting": "text_mm8qzmk6",
         "householdEmail": "email_mm8hj3f8", "doNotSolicit": "boolean_mm8h1x0b", "dontList": "boolean_mm8qmb9v" },
       "18437342607": { "householdId": "text_mm8qh43v", "householdGreeting": "text_mm8qqva9",
         "householdEmail": "email_mm8hzsdg", "doNotSolicit": "boolean_mm8h56b4", "dontList": "boolean_mm8qxc1f" } },
     "organizations": { "boardId": 18437342579, "columns": { "recognitionName": "text_mm8q3rj", "dontList": "boolean_mm8qt96y" } }
   }
   ```

   `firstFiscalYear` is the first year the board covers; `excludedGiftTypes` defaults to
   `["Contracts"]`; `writesPerRun` to 500. `"rollCall": null` (or omitted) turns the duty off.
3. **Deploy order: apply migration `0011` to the remote D1 BEFORE deploying** a build that carries
   the duty (`npx wrangler d1 migrations apply <db> --remote`), or the first nightly run fails on
   the missing `roll_call_credits` table. Then set the write switch `on` and trigger a first run
   with `POST /custodian/run/rollcall`.

### Saved views

`setup-roll-call-board.mjs` creates these three table views through `create_view_table` (filter
plus sort worked), each sorted by Total, largest first:

* **This year so far** — Fiscal Year is the in-progress year, Listed is `Listed`, Tier is not
  `Under $100`.
* **Last closed year** — Fiscal Year is the most recently closed year, Listed is `Listed`, Tier is
  `$100+` or higher. This is the one to export for the report.
* **Needs review** — Review Note is not empty.

A filter can't say "the in-progress year", so the two year views name the fiscal years as of the
day the script ran (sandbox: 2027 and 2026). **Every July, edit the Fiscal Year value in those two
views** (and re-running the script won't — it leaves existing views alone).

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

`config/sandbox.json` holds real ids verified against the CRM Sandbox v2 boards (2026-08-31), not
placeholders — re-verify against production board ids before deploying for real, since the
sandbox gets rebuilt before cutover:

* `fiscalYear` — required, `{ "startMonth": 7, "timeZone": "America/Los_Angeles" }` for SVBC
  (July–June, named for the year it ends in, matching the Fiscal Year Ending column). "Today" for
  This/Last Year and for the custodian's sweep (day 1 of `startMonth`) and archive (day 15) is
  read in `timeZone` — before issue #27 it was UTC, so This Year rolled over at 5pm Pacific on
  June 30. `startMonth` also derives a gift's fiscal year from its Date when the column is blank.
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
* `donationRollups.membership` (null = off), the per-board eight-key `membership` column ids
  under `ownerColumnsByBoard`, and the Donations board's `termStart`/`termEnd`/`membershipType`
  column ids together configure the membership activity rule — see "Membership — the activity
  rule" above.
* `donationRollups.membership.minAmountCents` — the "given at least $1" gate (100): a Received
  Donation below it neither starts nor extends a run after `fromISO`. Migrated terms before
  `fromISO` ignore it.
* `donationRollups.volunteerBoards` — the Event Registrations board(s) whose check-ins count as
  volunteering: `boardId`; `columns` with `attendee` (the People link), `event` (the Event link),
  `attendance`, `role` and `hours` (`null` until the Hours column exists — blank counts as 1
  hour); `eventBoard` (`boardId` and `columns.start`, the Events board's Start date, which dates
  the check-in); `volunteerRoleLabels` (`["Volunteer"]`) and `countedAttendanceLabels`
  (`["Attended"]`). Required (may be an empty array) whenever `membership` is on. **Every board
  here needs its own webhook subscription**, as with `donationBoards` — `setup-webhooks.mjs`
  covers both lists.
* `donationRollups.historicalVolunteerBoards` — the 2014–2020 Volunteers board(s): `boardId`,
  `columns` (`volunteer`, `date`, `hours`, `status`) and `countedStatusLabels` (`["Completed"]`).
  Required (may be `[]`) whenever `membership` is on. Read once by the `membership` duty's
  `load-volunteers` phase; **no webhook** — it is record-keeping.
* `donationRollups.recurringGifts` — `null` or omitted keeps the `recurring` duty off. Otherwise
  `{ boardId, columns: { donorLink, status }, activeStatusLabel }`: the Recurring Gifts board, its
  Donor connect column and Status column, and the label that means active (`"Active"`). At least
  one `ownerColumnsByBoard` entry then needs `hasActiveRecurringGift`: the People board's
  **Has Active Recurring Gift** checkbox column id (People and People (Historical); Organizations
  has none). No webhook.
* `affiliations` — `null` until the Affiliations board exists (every affiliation-model behavior is off); otherwise `{ boardId, columns: { personLink, attributedGiving, attributedGiftCount, lastAttributedGift } }` — the Person connect column and the three rollup columns on the Affiliations board (`scripts/setup-affiliation-columns.mjs` prints the block). When set, every `donationBoards[]` entry must have `columns.actingForLink` (the Donations board's "Acting for" connect column).
* `donationRollups.ownerColumnsByBoard["<board id>"].organizationalGiving` — optional, People boards only; an owner board without it (Organizations, or a People board before the setup script has run) is skipped with a `console.warn` naming the board — the consumer never retries over it, and reconcile leg 6 skips those persons.

## APIs & auth

* **Monday.com webhooks** — one pair (`create_item` + `change_column_value`) on the single
  Donations board, pointed at the deployment's `/webhooks/monday/donations` route
  (`https://svbc-donation-rollups-sandbox.svbc-account.workers.dev` for the sandbox environment;
  the production-named Worker once production boards exist) with the
  shared secret embedded in the URL (`?secret=`, matching the Worker's `MONDAY_WEBHOOK_SECRET`;
  Monday doesn't sign API-created webhooks, so this is the only authentication). Compared in
  constant time and **fails closed** since issue #27: with the secret unset or empty every
  delivery — handshake included — gets a 401, so local dev needs it in `.dev.vars` too.
  Managed by `scripts/setup-webhooks.mjs`, which also prunes retired boards' subscriptions (the
  era boards' 18 old ones). Pass `--config config/sandbox.json` to subscribe the sandbox
  boards; the default reads `config/svbc.json`. The subscription-creation handshake POSTs `{"challenge": "..."}` to
  the webhook URL, which is echoed back verbatim — handled in `src/webhook/route.ts`, and is
  also what a new subscription's secret check has to pass, so a wrong secret at subscribe-time
  fails loudly rather than silently. Note the API cannot read back a webhook's URL, so a lost
  secret means rotate (`wrangler secret put MONDAY_WEBHOOK_SECRET`, redeploy, re-run
  `setup-webhooks.mjs`), not recover.
* **Custodian routes** — `CUSTODIAN_SECRET`, a separate random value sent as
  `Authorization: Bearer <secret>` (issue #63). It never appears in a URL, so it stays out of
  Monday's config and request logs, and rotating it (`wrangler secret put CUSTODIAN_SECRET`)
  touches no webhook subscription. Same constant-time, fail-closed check as the webhook.
* **Monday.com GraphQL API** — from the `monday-auth` broker, not a stored token. Both
  deployments bind `MONDAY_AUTH` (`wrangler.jsonc` `services`) to its `SyncToken` entrypoint — the
  *SVBC Staff Sync* OAuth app — which owns the token and its refresh;
  `src/monday/graphql.ts` `tokenProviderFor` asks it per request and re-asks once on a 401.
  Design: `docs/superpowers/specs/2026-10-30-monday-oauth-broker-design.md`.

  | Setting | Production (`svbc-donation-rollups`) | Sandbox (`--env sandbox`) | Operator scripts (`scripts/*.mjs`) |
  | --- | --- | --- | --- |
  | Monday access | `MONDAY_AUTH` → `svbc-monday-auth` / `SyncToken` | `MONDAY_AUTH` → `svbc-monday-auth-sandbox` / `SyncToken` | `MONDAY_API_TOKEN` in the operator's shell |
  | `MONDAY_API_TOKEN` secret | none (fallback only while the cutover is under way; delete it once the binding works) | none (same) | — |
  | `MONDAY_WEBHOOK_SECRET`, `CUSTODIAN_SECRET` | `wrangler secret put` | `wrangler secret put … --env sandbox` | `setup-webhooks.mjs` needs `WEBHOOK_SECRET` |

  With neither the binding nor the secret, building the Monday client throws a config error
  naming both, rather than sending an empty `Authorization` header. Local `wrangler dev` has no
  broker to call, so put a `MONDAY_API_TOKEN` in `.dev.vars` for it.

## Non-destructive by design

Every board id in `config/sandbox.json` — the Donations board and all 3 owner boards — is a CRM
**Sandbox** id (the "(sandbox v2)" set, verified directly 2026-08-31), not copied from a
production workspace; `config/svbc.json` is the production placeholder file, whose ids must be
verified against the production workspace before cutover. There is no production Monday
workspace with real cutover data yet (that's October); until there is, this Worker cannot touch
live donor data no matter what triggers it.
**Before ever repointing any id in that config at a production workspace, re-verify every single
one against production directly** (the sandbox gets rebuilt before cutover, so today's ids won't
necessarily match) — don't assume sandbox and production share ids just because the schema matches.

## Resetting for new board ids

When the boards this Worker reads and writes are deleted and rebuilt (a cutover retry — private
runbook, Rollback step 8 — or a sandbox rebuild), every Monday item id in D1 is dead. The
bootstrap (`bootstrap-*-from-artifacts.mjs`) replaces `donation_links`, `pending_recomputes`,
`gifts` and `affiliations` wholesale, but nothing replaces the rest: `volunteer_activity` is
upsert-only, so owners from the old boards would survive and count toward the membership rule,
and a kept `custodian_runs` row is the resume point of a sliced sweep or archive, which would
pick up partway through the new boards.

**First:** set the switch to `hold` (`node scripts/flags.mjs donation-rollups writes hold --env
production`): the daily custodian run is skipped and the recompute queue pauses, so nothing
writes back what this clears. Disable the old boards' webhooks (or delete the old boards).

```sh
# 1. Export, to somewhere outside the repo (it holds donor amounts and item ids).
npx wrangler d1 export svbc-donation-rollups --remote --output <dir>/svbc-donation-rollups.sql

# 2. Clear every table keyed by an old item id, and the old summary items. -y answers any
#    wrangler confirmation prompt; unanswered without a TTY, one cancels silently with exit 0.
npx wrangler d1 execute svbc-donation-rollups --remote -y --command \
  "DELETE FROM donation_links; DELETE FROM pending_recomputes; DELETE FROM gifts; DELETE FROM affiliations; DELETE FROM volunteer_activity; DELETE FROM owner_recomputes; DELETE FROM owner_leases; DELETE FROM membership_baseline; DELETE FROM custodian_runs; UPDATE annual_summaries SET monday_item_id = NULL;"

# 3. Check: every column is 0. (One row of subqueries: D1 refuses a UNION ALL this long,
#    "too many terms in compound SELECT".)
npx wrangler d1 execute svbc-donation-rollups --remote --command \
  "SELECT (SELECT COUNT(*) FROM donation_links) AS donation_links, (SELECT COUNT(*) FROM pending_recomputes) AS pending_recomputes, (SELECT COUNT(*) FROM gifts) AS gifts, (SELECT COUNT(*) FROM affiliations) AS affiliations, (SELECT COUNT(*) FROM volunteer_activity) AS volunteer_activity, (SELECT COUNT(*) FROM owner_recomputes) AS owner_recomputes, (SELECT COUNT(*) FROM owner_leases) AS owner_leases, (SELECT COUNT(*) FROM membership_baseline) AS membership_baseline, (SELECT COUNT(*) FROM custodian_runs) AS custodian_runs, (SELECT COUNT(*) FROM annual_summaries WHERE monday_item_id IS NOT NULL) AS summaries_with_an_item"
```

Sandbox: `svbc-donation-rollups-sandbox`, with `--env sandbox` on every command.

| Table | Reset | Why |
|---|---|---|
| `donation_links`, `pending_recomputes`, `gifts`, `affiliations` | cleared | Old item ids. The bootstrap from the new load's artifacts refills them. |
| `volunteer_activity` | cleared | Old registration and owner ids; upsert-only, so nothing else removes them. The `membership?all=true` pre-pass reloads it from the new boards. |
| `owner_recomputes`, `owner_leases` | cleared | Per-owner bookkeeping for old owners. |
| `membership_baseline` | cleared | Retired (no longer read), but keyed by old owners. |
| `custodian_runs` | cleared | Each duty's last run, and a sliced sweep's or archive's resume point. Cleared, every duty starts from the beginning. `/custodian/status` reads empty until the first run. |
| `annual_summaries` | **kept, `monday_item_id` nulled** | The totals are restated by `archive`; the item ids are on the old Annual Giving Summary board, and `archive` fails with "Item not found in board" on a kept one. |

`d1_migrations` is untouched. A recompute message still on the queue for an old item fails once
the switch is back `on` and goes to the dead-letter queue; that's expected, so clear the DLQ
after the new boards' passes.

**Then**, in this order (cutover runbook step 4.0): deploy with the new ids, the provisioning
scripts, the bootstrap, `setup-webhooks.mjs --prune <old board ids>` (without `--prune` the old
boards' subscriptions are left in place), `writes on`, and the custodian passes.

Tested 2026-10-30 on a local D1 with every migration applied: rows seeded in the cleared
tables were removed, `annual_summaries` kept its totals with `monday_item_id` nulled, and the
check read 0. Not yet run against a deployed D1.

## Sandbox environment — inbound only, no outbound data

This Worker has a permanent `sandbox` Wrangler environment (`wrangler.jsonc` `env.sandbox`):
`npm run deploy:sandbox` deploys `svbc-donation-rollups-sandbox` against the CRM Sandbox
boards in `config/sandbox.json`, chosen at request time by the `ENVIRONMENT` var
(`src/environment.ts`). It has its own D1 (`svbc-donation-rollups-sandbox`), queues
(`donation-rollups-recompute-sandbox` and `-sandbox-dlq`, consumed by the same handler — see
`isDeadLetterBatch` in `src/index.ts`), and secrets (`wrangler secret put … --env sandbox`);
it shares nothing with the production-named Worker. Local development against the sandbox uses `npm run dev:sandbox`; `npm run dev` targets the production config and, once production secrets exist in `.dev.vars`, would write to production sinks. This Worker writes only to Monday, so
there is no outbound sink to lock — the split exists so the sandbox and production deployments
can coexist after cutover. `config/split.test.ts` fails if any of the 60-odd sandbox column ids
appears in `config/svbc.json` or if `env.sandbox` shares a resource with the top level. The
four operator scripts that read config (`setup-webhooks.mjs`, `bootstrap-links.mjs`,
`bootstrap-gifts-from-artifacts.mjs`, `setup-affiliation-columns.mjs`) take
`--config config/sandbox.json`. Design:
`../docs/superpowers/specs/2026-09-18-sandbox-environment-design.md`; the move of the existing
deployment onto this environment is its §9, run once from the runbook in the step 2 plan.
`npm run deploy:sandbox` fails until `env.sandbox.d1_databases[0].database_id` in
`wrangler.jsonc` is replaced with the id `wrangler d1 create` prints — see the step 2 plan's
Task 9.

**Workers Builds:** connect a second Worker, `svbc-donation-rollups-sandbox`, to this repo with
root directory `/donation-rollups`, production branch `main`, and deploy command
`npx wrangler deploy --env sandbox`. The sandbox then tracks `main` alongside production. If the
dashboard refuses two connections on one root directory, fall back to the
`deploy-sandbox:donation-rollups` job in `../.gitlab-ci.yml` — same command, gated on a
`CLOUDFLARE_API_TOKEN` CI variable so it stays inert until that variable is set.

## Deploying: the write switch

Every Monday write (owner rollups, gift term stamps, affiliation totals, gift-history
descriptions, archive, Annual Giving Summary items, alerts), every fan-out enqueue onto
`donation-rollups-recompute`, and every D1 projection write is gated by the shared write switch
(spec `../docs/superpowers/specs/2026-10-26-write-switch-design.md`, module `src/flags.ts`, a
byte-identical copy of `member-portal/src/flags.ts`; the dry-run deps are `src/writeSwitch.ts`).
It is read from the `FLAGS` KV namespace (`wrangler.jsonc`; the ids are placeholders until the
namespaces exist):

- `donation-rollups:writes` — `on` writes normally; `hold` writes nothing, keeps recompute
  messages on the queue (retrying at 1 minute doubling to an hour), skips the daily custodian
  run and answers `POST /custodian/run/:duty` with 409; `off` recomputes and runs duties against
  recording proxies, logging one `"writeSwitch":"skipped"` line per would-be write and acking.
  **A missing key means `off`**, and a KV read error behaves like hold except that the queue is
  not paused (messages keep retrying on the backoff).
- `donation-rollups:log` — `debug` adds redacted payloads to those lines.

Under `off` nothing in D1 moves except ingest: the webhook still records its pending row and
enqueues (stamped, so that message is never written even if the switch is `on` by the time it's
consumed), but the ledger, links, summaries and `custodian_runs` are not refreshed — so no duty
cursor advances, and a sliced sweep/archive resumes where the last live run stopped. The one
other D1 write a dry run makes is closing out its pending row as `dropped` — whether the webhook
stamped it under `off` or it was ingested live and consumed after an emergency `off` — so the
nightly requeue never re-sends it as a live recompute once writes are back `on`; the item's next
webhook resets the row and is processed normally. A message already queued
before this build has no stamp and is written under `on`. The dead-letter consumer runs in every
mode. Set the switch with the operator CLI at the repo root, never by hand — `writes hold`/`on`
also pauses and resumes `donation-rollups-recompute`:

```sh
node scripts/flags.mjs donation-rollups writes on --env sandbox     # or --env production
node scripts/flags.mjs status --env sandbox
```

**Set `writes on` before deploying** a build that carries the switch, or the deployed Worker
dry-runs everything. The exception is a **first production deploy onto freshly loaded boards**
(cutover runbook step 4.0): deploy with the switch `off`, so the 09:00 UTC cron dry-runs
against the half-configured Worker, and turn it on once the webhooks are subscribed, before the
custodian passes. **During a production load** (salesforce-import), keep rollups `off` — or
its Monday webhooks unsubscribed, as today — until the load finishes: every imported gift fires a
webhook, and under `on` each one is a full owner recompute. Recompute retries now back off 1
minute doubling to an hour across `max_retries: 100` (about four days) before the DLQ; a D1 or
Monday daily limit still defers to midnight UTC.

## Not yet done

* ~~Webhook cutover to the v2 board~~ **Done 2026-08-31**: secret rotated, Worker redeployed,
  v2 pair subscribed, all 18 era-board subscriptions pruned, and verified live end to end — a
  test donation flowed webhook → D1 → queue → recompute and wrote all 12 columns on the donor's
  v2 item with values matching the importer's independent computation (Lifetime $714.93 / 15
  gifts, average exact). Note: the `webhooks` API query only returns subscriptions created by
  the SAME token/app — another client seeing an empty list doesn't mean none exist.
* **2,865 `pending_recomputes` rows stuck in `queued` (09-03 and 09-09 floods)** — root cause and
  the five-part fix are in "Status and verification — operational findings, 2026-09-17" above.
  Repair (re-enqueue in slices) only after the write-amplification fixes or Workers Paid — the
  account is on Workers Paid now (confirmed 2026-09-29), so the repair is unblocked.
* **DLQ has no consumer** — dead messages expire unseen after 4 days; see the same section.
* ~~Dedicated least-privilege API token~~ Superseded by the `monday-auth` broker's Staff Sync
  OAuth app (see "APIs & auth" above); the sandbox QA and the `MONDAY_API_TOKEN` secret's removal
  happen at deploy time.
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
* **Affiliation model shipped but not turned on.** `config/sandbox.json`'s `affiliations` is still
  `null` — the Affiliations board and its columns haven't been provisioned in the sandbox yet.
  Run `scripts/setup-affiliation-columns.mjs`, paste its output into config, and set
  `donationRollups.donationBoards[].columns.actingForLink`; see "Affiliation model (Plan 2)"
  above.
* **Sync Member Type and Current Term Start to Mailchimp merge fields (`mailchimp-sync`), so a
  welcome-back Journey can target Lapsed renewal.**
* **Non-money rollups (registrations, volunteer hours, activities) and post-cutover Donor
  re-pointing are out of scope for this plan** — the latter belongs to the resolver Worker in
  Plan 3.

## Sources

* `docs/07-migration-gotchas.md` gotcha #1 (fiscal year), #4 (Closed Won stale stage), #10 (rollup
  recomputation) (private planning repo)
* `docs/05-migration-script-requirements.md` §8, §10 (private planning repo)
* `salesforce-import/src/transform/rollups.ts`, `transform/donations.ts` — the one-time-import
  half of this same rollup logic, and the `Closed Won` → `'Received (Historical)'` fix this
  Worker's filter depends on
