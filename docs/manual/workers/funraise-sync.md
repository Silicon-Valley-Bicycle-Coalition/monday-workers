# funraise-sync

[Appendix A](../reference/funraise-sync.md) lists this Worker's routes, crons, queues, storage and bindings.

`funraise-sync` deploys as `svbc-funraise-sync` (production) and `svbc-funraise-sync-sandbox`
(sandbox), on the account's `workers.dev` subdomain
(`svbc-funraise-sync-sandbox.svbc-account.workers.dev` for the sandbox). It has no custom domain.
It gets Monday access from the `monday-auth` broker through the `SyncToken` entrypoint.

## What it does

It turns every Funraise online donation into a Donations item on Monday, linked to the donor's
People item and, for a monthly or yearly gift, to its Recurring Gifts item. It also keeps the
Recurring Gifts board in step with Funraise subscriptions. If it stops, online gifts stop
appearing in Monday, so rollups, membership renewals and acknowledgments built on them stall.

## Trigger and data flow

### Webhook: `POST /webhooks/funraise/transaction?secret=…`

Funraise has one webhook per organization, fired when a transaction is created or edited. It
cannot send headers, so the shared secret travels in the URL query
([Architecture](../02-architecture.md)). Scripts send it as the `X-Webhook-Secret` header instead.

1. The route checks the secret (constant-time; fails closed with 401 when unset or wrong) and the
   per-IP rate limit (60 requests a minute).
2. It unwraps the envelope `{ sentAt, event, data }`, strips card and billing fields
   (`lastFour`, `expirationDate`, `cardType`, `billingFirstName`/`LastName`/`Zip`,
   `transaction.errors`), and upserts the D1 `events` row keyed on the transaction id. A newer
   `sentAt` replaces the payload; an identical or older delivery is a duplicate. A send time more
   than an hour in the future is rejected.
3. It enqueues a message on `funraise-sync-writes` and answers 200.
4. The queue consumer matches the donor on the People board: Funraise Profile (bare supporter
   id), then Personal Email. If neither matches it creates a person.
5. For an installment (`data.subscription.id`) it finds the Recurring Gifts item in the D1
   ledger, or fetches the subscription from Funraise and creates it.
6. **Adopt before create.** It looks the transaction id up in the Donations board's Funraise ID
   column. If an item exists (a migrated gift, or its own orphan), it updates that item.
   Otherwise it creates one.
7. On first write only it stamps Thank You Sent, Gift Type and Fiscal Year Ending. Later updates
   never overwrite those, so staff corrections stick.

A gift dated before `funraiseSync.oldestActiveFiscalYear` with no active item is not created.
Archived items are invisible to the Monday lookup, so creating one could double-count. The row is
marked `needs_review` instead (see Failure modes).

### Crons

| Schedule | Job |
|---|---|
| `0 * * * *` (hourly) | Poll Funraise `GET /api/v1/crm/subscription` with keyset pagination on (`updtime`, `id`), up to 20 pages a run. Each row adopts or creates a Recurring Gifts item. Cursors in `poll_cursors` advance only after a page lands. |
| `0 9 * * *` (daily) | Empty `raw_payload` for events written more than 90 days ago (`rawPayloadRetentionDays`), and for events never written once older than 365 days (`unresolvedPayloadRetentionDays`). |

Sandbox crons are disabled (Appendix A).

### Dead-letter queue

After 100 retries (about four days) a message goes to `funraise-sync-writes-dlq`. This Worker
also consumes the DLQ: it prefixes the row's error with `dead-lettered after retries: ` and logs
one `console.error` per batch. Nothing re-drives automatically. See
[Operations](../07-operations.md) for the shared retry policy.

### D1 tables

| Table | Holds |
|---|---|
| `events` | One row per transaction: status (`queued`, `written`, `failed`, `needs_review`…), Monday item ids, error, PII-stripped payload |
| `subscriptions` | Ledger of Funraise subscription → Recurring Gifts item and donor |
| `poll_cursors` | `subscriptions` (updtime) and `subscriptions:id` keyset cursors |
| `subscription_claims` | Short-lived create claims so the poll and the consumer never both create one subscription; expire after 10 minutes |

## Monday boards and columns

Ids live in `config/svbc.json` (production) and `config/sandbox.json` (sandbox).

| Board | Reads | Writes |
|---|---|---|
| People (live) | Funraise Profile (link, matched on bare id), Personal Email | Creates a person: name, Funraise Profile, Personal Email, then First Name / Last Name (best effort) |
| Donations | Funraise ID (adopt lookup) | Amount, Status, Date, Funraise ID, Recurring Gift link, Donor link (create only), Thank You Sent, Gift Type, Fiscal Year Ending (first write only) |
| Recurring Gifts | Funraise ID (adopt lookup) | Funraise ID, Donor, Installment Amount, Annualized Value, Frequency, Status, Next Payment, Designation, Company Match, Match Employer |

Label rules that matter:

- **Donations Status:** `Complete` → `Received`, `Refunded` → `Refunded`, `Failed` → `Failed`
  (`statusValueMap`). Any other value is written as is and fails if the label does not exist.
  `donation-rollups` counts only `Received`.
- **Gift Type:** `Donation`, or `Event Ticket` when the transaction has a `fundraisingEvent`.
- **Recurring Gifts Frequency** (Monthly, Quarterly, Yearly) and **Status** (Active, Cancelled,
  Failed, Redacted) go through maps in config. An unmapped value is left unset with a warning.
- Fiscal Year Ending uses SVBC's July–June year, from the Pacific calendar date of the gift.
- The Acknowledgment Tier column is set by a native Monday automation. This Worker never writes it.

The Donations Status column must carry a `Refunded` label; without it every refund write fails and
dead-letters. It exists on both production and sandbox boards (checked 2026-11-19). Don't rename it.

## Secrets

| Name | Purpose | Issued by | Rotate |
|---|---|---|---|
| `FUNRAISE_WEBHOOK_SECRET` | Shared secret in the webhook URL (`?secret=`) and the scripts' `X-Webhook-Secret` header | Generated by the operator (`openssl rand -hex 32`) | `wrangler secret put` a new value, then edit the Target URL in Funraise → Settings → Webhooks. Rotate if Workers Logs are ever shared |
| `FUNRAISE_API_KEY` | Read-only Funraise REST key (`X-Api-Key`) for the subscription poll and never-seen-subscription lookups. If unset, the poll logs and skips | Funraise admin console | Funraise → Settings → API keys: generate a new key (copy it at once), `wrangler secret put`, delete the old key |
| `MONDAY_API_TOKEN` | Optional fallback only; the broker binding is the normal path. Also read from the operator's shell by `scripts/*.mjs` | Monday (SVBC Integration user) | Remove the Worker secret once the broker binding is confirmed; do not add new uses |

Funraise's own **Webhook Signing Secret** (shown on the webhook card) is not the URL secret and
never goes into this Worker. Funraise allows only 3,000 API requests a month on the base plan;
the hourly poll uses under 900.

## Write switch

Key `funraise-sync:writes` in `FLAGS` (`sandbox-FLAGS` in the sandbox). Set it with
`node scripts/flags.mjs funraise-sync writes on|hold|off --env production|sandbox`; `hold` and
`on` also pause and resume the `funraise-sync-writes` queue.

| Mode | Webhook | Queue consumer | Hourly poll |
|---|---|---|---|
| `on` | Records and enqueues | Writes to Monday | Writes, cursor advances |
| `hold` (or KV error) | Records and enqueues | Queue paused; nothing written | Skips; cursor stays put |
| `off` (or missing key) | Records and enqueues; message stamped `dropped` | Dry run, one `"writeSwitch":"skipped"` log line per write | Dry run; cursor advances, so those changes are skipped for good |

A delivery ingested under `off` stays a dry run even if consumed after a flip to `on`. The daily
purge and the DLQ consumer run in every mode. Set `writes on` before deploying a build that reads
the switch. While on `hold`, `flags.mjs status` may show `backlog 0 (no recent sample)`; the D1
`queued` rows are the reliable count. Details: [Operations](../07-operations.md).

## Failure modes

| Symptom | Cause | What to do |
|---|---|---|
| Funraise webhook card stays **Disabled** after Save | Worker answered 401 on the verify call; usually the signing secret was pasted into the URL instead of the Worker's secret | Check which secret is in the Target URL |
| A refund never shows on the board; row `dead-lettered after retries:` | `Refunded` label missing on Donations Status | Add the label, then run `redrive-failed.mjs` |
| Rows `failed` with `not retried: ` | Monday rejected the request (4xx, bad column value, missing column, board or item id). Acked at once, no retries | Fix the config or the board (a renamed or deleted column, a missing label), then re-drive |
| Many rows `failed` or dead-lettered at once | Broker token rejected, Monday 429/5xx outage, or a deleted board (`UserUnauthorizedException`) | Check `monday-auth` `/health`; once fixed, re-drive. These still retry with backoff |
| Rows in `needs_review` | Gift dated in an archived fiscal year with no active item | List them: `npx wrangler d1 execute svbc-funraise-sync --remote --command "SELECT entity_id, error, received_at FROM events WHERE status = 'needs_review'"`. Update the archived item by hand, or add a back-dated gift that was never migrated |
| Donation lacks a Recurring Gift link | `FUNRAISE_API_KEY` unset, subscription lookup failed, or lost a create claim | Check the key; the hourly poll fills the ledger. Fix the link by hand if needed |
| Recurring Gifts board falls behind | Poll failing (Funraise 500, API quota spent, key revoked); cursor stays put and the next run retries | Check Workers Logs for `subscriptions poll read …` lines and Funraise quota |
| Re-drive reports rows it cannot replay | Retention purge emptied the payload | Recover the gift from Funraise by hand |
| Gift doubled on the board | Should not happen (adopt before create); archived items are the blind spot | Run `check-funraise-ids.mjs` |
| Every delivery for a known gift fails after a board rebuild | D1 still holds item ids from the deleted boards | Follow "Resetting for new board ids" in the README |
| Funraise Test button created a "Lorem Ipsum" donor and gift | The Test button sends a real `DONATION` (id `-1`) | Delete the donor and item by hand |

## Operator scripts

Run from `funraise-sync/`. Add `--env sandbox` for the sandbox.

| Script | When | Command |
|---|---|---|
| `redrive-failed.mjs` | After fixing the cause of `failed` or dead-lettered rows. POSTs each stored payload back to the Worker | `FUNRAISE_WEBHOOK_SECRET=... node scripts/redrive-failed.mjs --worker-url https://<host> [--env sandbox] --dry-run`, then without `--dry-run` |
| `replay-window.mjs` | Moving Funraise's webhook between Workers: replays one Worker's stored deliveries since a time into the other | `node scripts/replay-window.mjs --since <ISO UTC> --dry-run`; then `FUNRAISE_WEBHOOK_SECRET=<target's secret> node scripts/replay-window.mjs --since <ISO UTC> --worker-url https://<target> [--until <ISO>] [--source-env sandbox\|production] [--pause-ms 2000]` |
| `check-funraise-ids.mjs` | Read-only check that no Funraise ID is on more than one Donations item (after a replay or re-drive) | `MONDAY_API_TOKEN=... node scripts/check-funraise-ids.mjs [--env sandbox]` |

Keep `--pause-ms` at 2000 or more: the route allows 60 requests a minute per address, and a 429
counts as a failure. Re-run a replay until every row reads `already present`.

## Changing it

Key files: `src/webhook/route.ts` (route, secret, envelope),
`src/consumer/processBatch.ts` (match and write), `src/consumer/processDeadLetters.ts`,
`src/matching/donors.ts`, `src/subscriptions/` and `src/funraise/client.ts` (poller),
`src/scheduled.ts` (cron dispatch), `src/mapping/` (field, status and fiscal-year mapping),
`config/svbc.json` and `config/sandbox.json`.

Gotchas:

- `src/flags.ts` and `src/monday/graphql.ts` are byte-identical copies. Edit the canonical files
  (`member-portal/src/flags.ts`, `monday-backup/src/monday/graphql.ts`) and copy them over.
  `src/monday/outage.ts` is itself the canonical outage breaker that other queue Workers copy.
- The People Funraise Profile column must be a link column and Personal Email an email column;
  `matchDonor` and the create path depend on those shapes.
- Funraise sends ids as numbers and dates as epoch milliseconds. The subscription list returns
  HTTP 500 for an `updtime` filter below about 2001 and pages are fixed at 10 rows.
- After a board rebuild, reset D1 before pointing Funraise at the new boards (README "Resetting
  for new board ids").
- `npm run dev` uses the production config. Use `npm run dev:sandbox`.

Tests: `npm test`, `npm run typecheck`. Deploy: `npm run deploy:sandbox`, `npm run deploy`.
Migrations, before deploying code that needs them:

```sh
npx wrangler d1 migrations apply svbc-funraise-sync-sandbox --env sandbox --remote
npx wrangler d1 migrations apply svbc-funraise-sync --remote
```

## Further reading

- [`funraise-sync/README.md`](../../../funraise-sync/README.md), especially [Resetting for new board ids](../../../funraise-sync/README.md#resetting-for-new-board-ids) and [Deploying: the write switch](../../../funraise-sync/README.md#deploying-the-write-switch).
- [UAT script](../../uat/funraise-sync.md).
- Design specs: [subscriptions poller](../../superpowers/specs/2026-09-18-funraise-subscriptions-poller-design.md), [replay rehearsal](../../superpowers/specs/2026-10-06-funraise-replay-rehearsal-design.md), [write switch](../../superpowers/specs/2026-10-26-write-switch-design.md), [original design](../../superpowers/specs/2026-08-22-funraise-sync-design.md).
- [`donation-rollups`](donation-rollups.md), which reads the Donations items this Worker writes.
- [Operations](../07-operations.md), [Troubleshooting](../08-troubleshooting.md).
