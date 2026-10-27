# Runbook: holding writes during the Salesforce to Monday load

Uses the write switch (README, "Write switch: off / hold / on"). Run every command from the repo
root. Never run `hold` to `off` to leave a hold: it drops the held messages.

## Prerequisites

The FLAGS KV namespaces must exist and their ids be in all 11 `wrangler.jsonc` files; they are
placeholders (`REPLACE_WITH_FLAGS_KV_ID`, `REPLACE_WITH_SANDBOX_FLAGS_KV_ID`) until then, and
`flags.mjs` refuses to run on placeholders.

```sh
npx wrangler kv namespace create svbc-worker-flags
```

```sh
npx wrangler kv namespace create svbc-worker-flags-sandbox
```

```sh
node scripts/check-worker-flags.mjs --strict
```

A missing key reads as `off`, so for every Worker that should keep writing, set `on` **before**
deploying the build that reads the switch (`member-portal` login returns 503 otherwise):

```sh
node scripts/flags.mjs all writes on --env production
```

## Before the load

1. Turn off the Salesforce integrations. This is separate from the write switch: use Funraise's
   Salesforce pause control and the rest of the migration runbook.
2. Set 14-day retention on every main queue and DLQ, so a multi-day hold queues instead of
   expiring (the Cloudflare default is 4 days).

```sh
node scripts/flags.mjs retention --env production
```

3. Hold all Workers. Each Worker's KV key is set first, then its main queues are paused (DLQs
   never are).

```sh
node scripts/flags.mjs all writes hold --env production
```

4. Check the result. Every Worker should read `writes=hold`, queues `paused`, no `MISMATCH`.
   `status` parses `wrangler queues info` and `kv key get` output, which is unverified against
   real wrangler: on first use, confirm it against the dashboard; a `?` means output was not parsed.

```sh
node scripts/flags.mjs status --env production
```

5. `donation-rollups`: keep it `off` (or its Monday webhooks unsubscribed) during the load,
   otherwise it holds one message per imported gift.

```sh
node scripts/flags.mjs donation-rollups writes off --env production
```

Subscribe its webhooks after the load, as before; flip it `on` only after they are subscribed.

## During the hold

- `member-portal` is donor-visibly unavailable under `hold`, `unknown` and `off`: login,
  change-request and card-regenerate POSTs render a 503 "temporarily unavailable" page, while
  reads still work. Holding `all` therefore takes donor login offline for the whole hold. Trade-off:
  announce the outage to donors beforehand, or hold Workers individually instead of `all` (for
  example leaving `member-portal` `on` if its boards stay readable during the load).
- `bp-feedback-notify` has no queue: under `hold` it returns 503 and only Monday's own retries
  apply, so a feedback request fired mid-migration may need re-triggering by hand. The two
  `benevity-import` routes also return 503 under `hold`.
- Queue retries: 1 minute doubling to 1 hour, `max_retries: 100` (about 4 days) before the DLQ;
  hinted waits (Retry-After, midnight daily limit) up to 12 h. A held message that keeps failing on
  reads can still reach a DLQ, and DLQ alerts stay live.
- A flip takes up to 30 s to reach a warm location (KV `cacheTtl`).

## After `validate`

1. Release the hold with `on`, not `off`.

```sh
node scripts/flags.mjs all writes on --env production
```

2. Watch backlog drain until every queue reads 0. A non-zero exit means KV changed but a queue
   resume failed: fix and rerun, then check for `MISMATCH`.

```sh
node scripts/flags.mjs status --env production
```

3. Follow-ups:
   - `donation-rollups`: if it was held or off for more than 24 h, flip it to `on` early enough
     for the queue to drain before the 09:00 UTC custodian requeue, or expect one ATTENTION and
     duplicate (idempotent) recomputes.
   - `monday-backup`: after an off/hold period the 36 h stale-snapshot Slack alert fires after the
     flip until the next 09:00 UTC backup succeeds. Flip shortly before 09:00 or expect one alert.
     Abandoned-run alerts under `off` are only logged.

## Work ingested under `off` is deliberately not written later

Deliveries ingested while a Worker was `off` are stamped `dropped` and stay dry runs after the
flip. Recover them by hand if wanted:

- `quickbooks-sync`: events stay queued; QuickBooks redelivery would be a duplicate, so use a
  manual redrive.
- `benevity-import`: reports uploaded during the off period need a re-upload or the Retry action.
- `email-log`: rows close out `failed`, so a staff re-send is logged.
- `member-portal`: change requests are refused with 503 under `off` (the donor re-submits); the
  letters webhook logs and returns 200 with no `letter_sends` row (staff re-click); a message
  queued under `hold` but consumed under `off` stays `queued`.
