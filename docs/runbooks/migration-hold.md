# Runbook: holding writes during the Salesforce to Monday load

Uses the write switch (README, "Write switch: off / hold / on"). Run every command from the repo
root. Never run `hold` to `off` to leave a hold: it drops the held messages. Never run
`all writes on`: four Workers must stay `off` (below), and `all` would turn them on.

The in-scope Workers, in five groups that this runbook treats differently:

- **Writing normally** (`on` outside the hold): `benevity-import`, `bp-feedback-notify`,
  `eventbrite-sync`, `funraise-sync`, `mailchimp-sync`, `member-portal`,
  `monday-backup`, `report-digests`.
- **`donation-rollups`**: `on` only once its Monday webhooks are subscribed
  (`donation-rollups/scripts/setup-webhooks.mjs`); `off` during the load.
- **`contact-roles`**: ships `off`; goes `on` only after its sandbox rollout: deployed while `off`,
  its `run-complete` dry-run counts checked, the backfill run and staff roles confirmed, then
  the smoke tests (its README); never part of a bulk flip. A stateless cron with no cursor: under `hold`/`unknown`
  it skips, and under `off` it dry-runs (computes and logs, writes nothing). Either way nothing
  needs catching up, because the next `on` run recomputes every `Contacts` column.
- **`people-reclassification`**: stays `off` until the staged one-item live check in its README
  ("Not verified against a live board yet") has passed; never part of a bulk flip.
- **`quickbooks-sync`**: postponed indefinitely (decided 2026-10-28); stays `off` in both
  environments and is never part of a bulk flip.

## Merging / first deploy sequencing

CI deploys the sandbox Workers from `main`, and a missing key reads as `off`, so the order is:

1. Create the namespaces (live account changes; confirm before running). Done for SVBC on
   2026-10-27 (`FLAGS`, `sandbox-FLAGS`); a fork runs:

```sh
npx wrangler kv namespace create FLAGS
```

```sh
npx wrangler kv namespace create sandbox-FLAGS
```

2. Fill the two ids into every in-scope `wrangler.jsonc` in your working copy, uncommitted
   (`flags.mjs` reads them from `member-portal/wrangler.jsonc` and refuses placeholder ids that
   start with `REPLACE_WITH`), and check them:

```sh
node scripts/check-worker-flags.mjs --strict
```

3. Put the sandbox keys **`on`** for every Worker that should keep writing in the sandbox (the
   "writing normally" group, plus `donation-rollups` if its sandbox webhooks are subscribed), one
   Worker at a time (see "Setting keys" for the loop).
4. Only then commit the real ids and merge. The sandbox deploys that follow read `on` and keep
   writing; a Worker whose key was not set comes up `off` (dry runs only, and `member-portal`
   login returns 503).

Production follows the same order before the first production deploy of each Worker.

## Setting keys

A Worker's main queues exist once it has been deployed; `writes` pauses or resumes them, and a
queue wrangler reports missing is a **failure** for that Worker (create the queues — deploy the
Worker — first, then rerun). With several Workers (or `all`), every Worker still runs after one
fails, and the command lists each failure (Worker, step, KV/queue mismatch) and exits non-zero.
For `on`, the CLI waits 60 s after the KV write before resuming the Worker's queues (it prints a
notice), so allow about a minute per Worker that has queues.

Set the writing-normally group one Worker at a time, never with `all`:

```sh
for w in benevity-import bp-feedback-notify eventbrite-sync funraise-sync mailchimp-sync member-portal monday-backup report-digests; do
  node scripts/flags.mjs "$w" writes on --env production || echo "FAILED: $w"
done
```

```sh
node scripts/flags.mjs status --env production
```

`status` exits non-zero on any `MISMATCH` or `?` (a value it could not read), and on a queue that
reads `missing` (not created; deploy the Worker). Keys come from `wrangler kv key get`; queue state
comes from the Cloudflare API under wrangler's own login, because `wrangler queues info` shows
neither: paused from the queue's settings, backlog from the latest Queues analytics sample in the
last 15 minutes. An idle queue has no samples, shown as `backlog 0 (no recent sample)`, and the
analytics lag a minute or two, so a backlog that just started may read 0 at first. A **paused**
queue may not be sampled at all: in the 2026-10-28 funraise-sync rehearsal it read
`backlog 0 (no recent sample)` with 11 messages held. During a hold, count what's held from each
Worker's D1 ledger (`status = 'queued'`) rather than trusting the backlog column.

## Before the load

1. Turn off the Salesforce integrations. This is separate from the write switch: use Funraise's
   Salesforce pause control and the rest of the migration runbook.
2. Set 14-day retention on every main queue and DLQ, so a multi-day hold queues instead of
   expiring (the Cloudflare default is 4 days).

```sh
node scripts/flags.mjs retention --env production
```

3. Set `donation-rollups` **`off` first**, before anything is held. Held, it would keep one message
   per imported gift and recompute every owner when released; `off` drops them, and the real load
   sets the totals anyway. Its webhooks stay unsubscribed until after the load, as before.

```sh
node scripts/flags.mjs donation-rollups writes off --env production
```

4. Hold the writing-normally group, one Worker at a time. Each Worker's KV key is set first, then
   its main queues are paused (DLQs never are). Don't use `all writes hold`: it would also move
   `contact-roles`, `donation-rollups` and `people-reclassification` from `off` to `hold`, and releasing them later
   with `on` would turn them on.

```sh
for w in benevity-import bp-feedback-notify eventbrite-sync funraise-sync mailchimp-sync member-portal monday-backup report-digests; do
  node scripts/flags.mjs "$w" writes hold --env production || echo "FAILED: $w"
done
```

   (To keep donor login up during the load, leave `member-portal` out of the loop; see "During
   the hold" for what that costs.)

5. Check the result. Every held Worker should read `writes=hold`, queues `paused`;
   `contact-roles`, `donation-rollups` and `people-reclassification` read `writes=off`; no `MISMATCH`, no `?`.

```sh
node scripts/flags.mjs status --env production
```

6. **Wait about a minute before starting the load.** KV reads are edge-cached for 30 s, so a
   Worker can act on the old mode for up to that long after the flip.

## During the hold

- `member-portal` is donor-visibly unavailable under `hold`, `unknown` and `off`: login,
  change-request and card-regenerate POSTs render a 503 "temporarily unavailable" page, while
  reads still work. Holding it takes donor login offline for the whole hold. The alternative,
  leaving it `on`, is not read-only: under `on` the portal still writes change requests, card
  regenerations and letter sends to Monday during the load. Choose one and announce it.
- `bp-feedback-notify` has no queue: under `hold` (or an unreadable switch, `unknown`) it returns
  503 and only Monday's own retries apply, so a feedback request fired mid-migration may need
  re-triggering by hand once Monday gives up. The two `benevity-import` routes also return 503
  under `hold`/`unknown`: an upload or Retry during the hold is refused and must be repeated
  after the flip to `on`.
- `contact-roles` skips its 10-minute run under `hold`/`unknown` and has nothing to catch up:
  after the flip, the next run recomputes every `Contacts` column.
- A `member-portal` letter queued under `hold` but consumed under `off` (someone flipped the
  Worker to `off` instead of `on`) stays stranded as `queued` until a staff re-click.
- `report-digests` skips each hour's digests under `hold` and does not catch up: after the flip,
  resend any digest that fell due with `POST /digests/run?key=<key>&date=<day it was due>`.
- `eventbrite-sync` skips its daily missed-order check under `hold`, and the class email send page
  can't claim or release. A send already running still records its result in D1, but its update, No
  Show and People link writes are skipped and not replayed, so check that class's Attendance after
  the flip. The missed-order check looks back only 26 h, so compare the held days by hand
  (`scripts/backfill-orders.mjs --dry-run` per event).
- Queue retries: 1 minute doubling to 1 hour, `max_retries: 100` (about 4 days) before the DLQ;
  hinted waits (Retry-After, midnight daily limit) up to 12 h. A held message that keeps failing on
  reads can still reach a DLQ, and DLQ alerts stay live.
- A flip takes up to 30 s to reach a warm location (KV `cacheTtl`).

## After `validate`

1. Release the hold with `on`, not `off`, one Worker at a time — the same writing-normally list,
   never `all`. The CLI waits 60 s before resuming each Worker's queues.

```sh
for w in benevity-import bp-feedback-notify eventbrite-sync funraise-sync mailchimp-sync member-portal monday-backup report-digests; do
  node scripts/flags.mjs "$w" writes on --env production || echo "FAILED: $w"
done
```

2. Watch backlog drain until every queue reads 0. A non-zero exit means KV changed but a queue
   resume failed: fix and rerun that Worker, then check for `MISMATCH`.

```sh
node scripts/flags.mjs status --env production
```

3. `donation-rollups`: subscribe its webhooks (as before), and only then flip it `on`:

```sh
node scripts/flags.mjs donation-rollups writes on --env production
```

4. `people-reclassification` stays `off` until its staged one-item live check passes.
5. Follow-ups:
   - `donation-rollups`: if it was off for more than 24 h, flip it to `on` early enough for the
     queue to drain before the 09:00 UTC custodian requeue, or expect one ATTENTION and duplicate
     (idempotent) recomputes.
   - `monday-backup`: after an off/hold period the 36 h stale-snapshot Slack alert fires after the
     flip until the next 09:00 UTC backup succeeds. Flip shortly before 09:00 or expect one alert.
     Abandoned-run alerts under `off` are only logged.
   - `report-digests`: resend any digest that fell due during the hold (above).

## Work ingested under `off` is deliberately not written later

Deliveries ingested while a Worker was `off` are stamped `dropped` and stay dry runs after the
flip. Recover them by hand if wanted:

- `quickbooks-sync`: events stay queued; QuickBooks redelivery would be a duplicate, so use a
  manual redrive.
- `benevity-import`: a report uploaded during the off period is recorded (its rows sit in D1 at
  `ingested`) but never written, and no worklist item is posted for it, so the Retry action has
  nothing to act on. Once writes are `on`, upload the same report file again as a new file on the
  Benevity Uploads board: the Worker re-sends every row still at `ingested`, unstamped, and posts
  any block worklist item it needs. Which reports: the `uploads` rows with `uploaded_at` inside the
  off window (`wrangler d1 execute svbc-benevity-import --remote --command "SELECT monday_asset_id,
  uploaded_at FROM uploads WHERE uploaded_at >= '<off start>'"`). See `benevity-import/README.md`.
- `member-portal`: change requests are refused with 503 under `off` (the donor re-submits); the
  letters webhook logs and returns 200 with no `letter_sends` row (staff re-click); a message
  queued under `hold` but consumed under `off` stays `queued`.
- `eventbrite-sync`: orders, events and attendees ingested under `off` are re-driven with
  `scripts/backfill-orders.mjs` / `scripts/backfill-attendees.mjs` for the affected events.
