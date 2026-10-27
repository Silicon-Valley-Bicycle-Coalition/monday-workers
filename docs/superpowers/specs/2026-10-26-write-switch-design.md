# Write switch: off / hold / on, flipped at runtime

Date: 2026-10-26. Status: design approved in chat, not built. Calls marked *(design-author's
call)* were made by the author while writing this up, not discussed — check them.

## Intent

Every Worker that writes to Monday or any other service gets a runtime switch, in both
`production` and `sandbox`, with three modes:

- **`off` — testing.** Deploy a Worker before it is trusted. It accepts real upstream deliveries
  (Funraise, QuickBooks, Eventbrite, Benevity uploads, Monday webhooks, inbound email, donor
  requests, crons), logs in detail what it *would* have done, writes nothing, and drops it. When
  flipped to `on`, only deliveries arriving after the flip write. This is how a change to a
  Worker gets tested against live traffic from now on, not just before cutover. (Running totals
  touched by dark-period activity don't matter here: they are re-set by the real load.)
- **`hold` — migration.** The production load takes about three days, and donations keep coming.
  During it, Salesforce integrations are turned off (a separate runbook step, e.g. the
  Funraise → Salesforce pause control) and every Worker **accepts and keeps** what arrives
  without writing. When flipped to `on`, everything held is written to Monday in arrival order.
- **`on` — normal operation.**

Separately, **outages of Monday or any other sink heal themselves**: a failed write is retried
with escalating delay for about four days before it reaches the dead-letter queue, with no
operator action.

## Platform basis

Cloudflare Queues (already the backbone of the webhook Workers) provides what `hold` and outage
retry need:

- **Pause / resume delivery** (`wrangler queues pause-delivery|resume-delivery <queue>`, or the
  Queues REST API): a paused queue still accepts messages but delivers none, and held messages
  don't spend retry attempts. Resume drains them.
- **Message retention up to 14 days** on Workers Paid (the account is on Paid). Default is 4
  days; raise every in-scope queue **and its DLQ** to 14 days
  (`wrangler queues update <q> --message-retention-period-secs 1209600`).
- **Per-message retry delay** (`message.retry({ delaySeconds })`) and `max_retries` up to 100.

Cloudflare Workflows (durable per-step retries) was considered and is not needed: each delivery
here is one logical write that the queue can retry as a unit.

## Goals

- One mechanism across every in-scope Worker, in both environments.
- Flip without a redeploy (KV), effective within about a minute.
- Fails closed: a missing key or any unrecognized value is `off`; a typo can never enable writes.
- `hold` loses nothing for up to 14 days; flipping to `on` writes everything held.
- Sink outages up to ~4 days recover with no operator action; longer ones land in the DLQ, which
  stays the visible, replayable last resort.
- Debug logging, toggled the same way, detailed enough to verify a delivery end to end from logs.

## Non-goals

- Replaying what arrived while `off`.
- A UI. A CLI script is the operator surface.
- Gating reads. Workers still read Monday and upstream APIs in every mode.
- Turning off the Salesforce side during migration (runbook, not this switch).
- `svbc-calendars` (not a migration Worker, already live) and the CLIs `salesforce-import` and
  `geo-filter`.

## Anti-goals

- Anything written to Monday, emailed, or sent to a vendor while `off` or `hold`.
- Anything received during `hold` lost, or written out of order relative to other held items.
- A ledger that claims Monday items exist that don't (e.g. funraise's adopt-before-create ledger
  recording "created" for an item never created).
- A delivery received while `off` written later.
- Debug logs leaking email addresses or donor PII.
- A switch that can be turned on by a request parameter, a missing key, or a KV error.

## Workers in scope

benevity-import, bp-feedback-notify, donation-rollups, email-log, eventbrite-sync,
funraise-sync, mailchimp-sync, member-portal, monday-backup, people-reclassification,
quickbooks-sync — and `report-digests` once it lands on `main` (deployed to the sandbox as
`svbc-report-digests-sandbox` on 2026-10-26, not on `main` when this was written).

## Decided

### The switch

- **One KV namespace per environment**: `svbc-worker-flags` / `svbc-worker-flags-sandbox`, bound
  as `FLAGS` at the top level and in `env.sandbox` of each `wrangler.jsonc` (mind the
  env-inheritance rules for new env blocks).
- **Keys per Worker**, named by directory name so one key name works in both environments:
  - `<worker>:writes` — `on` | `hold` | `off`. Missing or anything else → `off`.
  - `<worker>:log` — `debug` enables debug logging; anything else → normal logging.
- **A KV read error is its own state, `unknown`** *(design-author's call)*: never writes; a queue
  consumer retries the message (same escalating delay as an outage) rather than acking it; a cron
  skips the run and does not advance its cursor. A transient KV failure therefore delays a real
  donation, never drops it.
- **Freshness**: KV `cacheTtl` 30 s (the minimum); read per request / per queue batch / per cron
  run, never once per isolate.

### Behavior by mode

| | `off` | `hold` | `on` |
|---|---|---|---|
| Webhook route (verify, dedupe, enqueue) | runs; message stamped `dropped` | runs; message unstamped | runs |
| Queue | delivering | **paused** by `flags.mjs` | delivering |
| Queue consumer | log would-be write, ack | fallback if pause failed: retry with delay | write |
| Poller cursor | advances | **does not advance** | advances after confirmed write |
| Recompute / maintenance crons | compute, log, don't write | skip run | run |
| "Seen" ledger rows (dedupe) | recorded | recorded | recorded |
| "Written" ledger rows | not recorded | not recorded | recorded |

- **The stamp, and why** *(design-author's call)*: the route stamps a message `dropped` when the
  switch is `off` at ingest. A consumer never writes a `dropped` message, whatever the switch says
  when it is consumed (flip-boundary race, backoff retry, DLQ redrive) — that is what makes
  "only deliveries after the flip" exact. Unstamped messages (ingested under `hold` or `on`) write
  when consumed under `on`. If the switch is `off` at consume time, `off` wins (it is the
  emergency stop): log and ack. Anything else persisted for a later write (quickbooks-sync
  pending-create rows, member-portal's letter queue) carries the same stamp. Consumers accept
  old unstamped messages in flight at deploy time (treat as unstamped).
- **Pollers under `hold`** keep their cursor still, so the first `on` run walks everything since
  the hold began (funraise subscriptions, mailchimp, benevity's daily job). Under `off` the cursor
  advances — deliberately departing from CLAUDE.md's "cursor only after a confirmed write"
  invariant; document that exception when this lands.
- **Derived totals** (donation-rollups, mailchimp merge fields): under `hold`, held gifts arrive
  after the flip like any delivery and recompute their owners normally — no special catch-up.
- **Synchronous user-facing paths under `off`/`hold`** *(design-author's call)*: member-portal
  login links and change requests can't be queued meaningfully mid-migration. Under `off`/`hold`
  the portal renders a "temporarily unavailable, try again later" page for anything that would
  send or write; reads still work. bp-feedback-notify and email-log replies are queue-backed and
  follow the table.
- **Operational writes are exempt in every mode** *(design-author's call)*: OAuth token refresh
  and its persistence (quickbooks-sync `qb_oauth_tokens`), auth sessions/tokens in D1, Monday
  webhook challenge replies and subscription management, D1 leases/locks, rate-limit counters.
  Each Worker's sink inventory in the plan lists these explicitly.

### Outage retry (independent of the switch)

- On a sink failure that is retryable (Monday 5xx/429/timeouts — every `MondayApiError` the
  transport marks retryable — and the equivalent for other sinks), the consumer calls
  `message.retry({ delaySeconds })` with **1 minute, doubling, capped at 1 hour**, honoring a
  longer `Retry-After` when given. `max_retries: 100` per consumer. That is ≈ 4 days before the
  DLQ. Non-retryable failures (4xx validation, bad config) go to the DLQ fast, as today — a
  builder should keep the existing retryable/non-retryable split each consumer already has.
- The in-process attempts inside the Monday transport stay as they are (3 for queue Workers).
- Retention 14 days on every queue and DLQ, so a full ~4-day retry run plus time to notice and
  redrive fits.
- Poll/cron Workers already self-heal on the next run; no change beyond the cursor rules above.

### Shared module

- `src/flags.ts`, written once and copied **byte-identical** into each in-scope Worker, with a CI
  job (`worker-flags-copies`) modeled on `monday-graphql-copies`. Canonical copy at
  `member-portal/src/flags.ts`. Strip-only-TypeScript compatible so `.mjs` scripts can import it.
- Exposes at least: read the mode (`on`/`hold`/`off`/`unknown`), read the log level, the retry
  delay calculation, a `redactPayload` helper, and the one-line skip logger. API shape is the
  builder's.

### Where the gate sits

- **At each sink, not in business logic.** Validate, dedupe, match, read, and build the mutation
  normally; the gate stops at the last step.
- **Every outbound sink is gated**: Monday mutations, `send_email` (email-log replies,
  member-portal mail, bp-feedback notifications, alert emails), Mailchimp writes, Slack posts,
  Google Drive uploads, QuickBooks write-backs, IT Requests items, any other vendor write. The
  canonical Monday transport (`monday-backup/src/monday/graphql.ts`) is **not** edited; gate in
  each Worker's own client/consumer layer.
- **Chained writes** (create donor, then donation linked to its id): under `off`, log the whole
  chain with clearly-placeholder ids.

### Logging

- **Every skipped write logs one line** at normal level: Worker, environment, mode, delivery or
  message id, sink, operation, redacted summary.
- **`debug`** adds per-step lines (verified → deduped → matched → built → gated/sent/retried) and
  the would-be payload.
- **Redaction** *(design-author's call)*: payloads log ids, column ids, amounts, dates, statuses,
  gift types and board/item ids in full; **mask** names, emails, phones and postal-address fields
  (present + length only). `redactPayload` takes a per-Worker PII key list from config so a fork
  can extend it; tests assert each Worker's known PII fields come out masked. Free-text bodies log
  length only. The `log-safety` CI check stays green.

### Operator CLI

`scripts/flags.mjs` at the repo root, dependency-free, wrapping `wrangler kv key` and
`wrangler queues`:

```sh
node scripts/flags.mjs funraise-sync writes hold --env production   # KV + pause its queues
node scripts/flags.mjs funraise-sync writes on   --env production   # KV + resume its queues
node scripts/flags.mjs all writes hold --env production             # whole migration in one go
node scripts/flags.mjs funraise-sync log debug --env sandbox
node scripts/flags.mjs status --env production   # mode, log level, queue paused?, backlog depth
```

- `--env` required, no default. Unknown Worker names refused. It owns a per-Worker map of which
  queues to pause/resume (main queues only, never DLQs).
- **Order on the way in to `hold`**: write KV first, then pause. **On the way out to `on`**: write
  KV first, then resume — so a consumer never sees a delivered message while KV still says `hold`.
- `status` flags any mismatch (KV says `on` but queue paused, or vice versa).

### Rollout default

A missing key reads as `off`, so the first deploy carrying this turns a Worker dark unless its key
is set first. As of 2026-10-26 **no in-scope Worker is deployed to production** (only
`svbc-calendars`), so production starts `off` with nothing to lose. In the sandbox, the deployed
Workers are funraise-sync, donation-rollups, benevity-import, bp-feedback-notify, member-portal,
mailchimp-sync, quickbooks-sync, monday-backup, eventbrite-sync and report-digests; set each one
that should keep writing to `on` **before** its new build deploys. Raise queue retention to 14
days as part of the same rollout.

## Left to the builder

- `flags.ts` API, logger and test approach — each Worker covers, at minimum: `off` → no sink
  called + skip line; `hold` → consumer retries, cursor still; `on` → sink called; `dropped`
  message never written; retryable sink failure → `retry` with the escalating delay.
- Exact gate placement per Worker, and the "seen" vs "written" classification of every ledger
  table — list it in the plan.
- Rollout order (suggest sandbox first, one Worker per commit, then a full `hold` → `on`
  rehearsal in the sandbox before the production migration).
- Docs: root README section on the switch, each Worker README's Deploy section, the CLAUDE.md
  cursor-invariant exception and outage-retry note, `docs/systems-map.html`, and a migration
  runbook entry ("set all to `hold` before the load, `on` after validate").
