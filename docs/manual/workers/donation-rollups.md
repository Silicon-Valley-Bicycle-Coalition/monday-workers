# donation-rollups

[Appendix A](../reference/donation-rollups.md) lists this Worker's routes, crons, queues, storage and bindings.

`donation-rollups` deploys as `svbc-donation-rollups` (production,
`svbc-donation-rollups.svbc-account.workers.dev`) and `svbc-donation-rollups-sandbox` (sandbox,
`svbc-donation-rollups-sandbox.svbc-account.workers.dev`). It has no custom domain. It gets Monday
access from the `monday-auth` broker through the `SyncToken` entrypoint.

## What it does

It keeps every donor's giving totals on People, People (Historical) and Organizations current
whenever a Donations item changes: Lifetime Giving, This Year and Last Year, Largest, Smallest,
Average, Last Gift, Donor Level and a gift-history ledger. It also keeps membership status, the
chart labels on Donations, the Donor Roll Call board, the Annual Giving Summary board and the
Has Active Recurring Gift checkbox up to date. If it stops, those numbers go stale: staff see
wrong totals, members show as lapsed or active incorrectly, and reports built on them drift.

## Trigger and data flow

### Webhook: `POST /webhooks/monday/donations?secret=…`

Monday webhooks (`create_item`, `change_column_value`, `item_deleted`, `item_archived`,
`item_restored`) on the Donations board, the Event Registrations boards (for volunteer
activity), and the Affiliations board (when employer sync is on) all reach this one route.
`scripts/setup-webhooks.mjs` subscribes them.

1. The route echoes Monday's `challenge` handshake. It checks the URL secret (constant time,
   fails closed) and, when `MONDAY_SIGNING_SECRET` is set, Monday's signed JWT. It drops changes
   to Worker-written classification columns so its own writes do not cause a flood.
2. It upserts a `pending_recomputes` row keyed on the donation item and enqueues a message on
   `donation-rollups-recompute`.
3. The consumer reads the donation, finds its owner (Donor link), and records the link in
   `donation_links`. Monday cannot filter Donations by a connect column, so this D1 reverse
   index is how the Worker finds all of an owner's gifts.
4. It skips the message if a recent recompute already covered it (`owner_recomputes`
   coalescing). Otherwise it takes a per-owner lease (`owner_leases`), fetches every gift by id
   (archived gifts still read by id), refreshes the `gifts` ledger, and recomputes from scratch.
5. It writes the rollup columns in one call, the membership columns, per-gift term stamps, the
   Gift Ledger JSON and the item description (Gift History, plus Sponsorships on
   Organizations). Description writes are non-fatal.
6. A gift that is deleted or has its Donor link cleared is soft-removed (`removed_at`) and its
   old owner recomputed. An active gift whose Date is cleared (corrected to Pledged) is
   soft-removed too, and comes back once it has a Date. A gift moved to another owner queues a recompute for the old owner.

Only gifts whose Status is exactly `Received` count (`receivedStatusLabel`). `Received
(Historical)` is excluded on purpose. Do not merge those two labels.

### Custodian cron: `0 9 * * *` (daily, 09:00 UTC; production only)

One run executes the duties due that day, sharing board reads and a write budget
(`custodian.writesPerRun`, default 500). A duty that runs out reports `remaining` and the next
night continues it.

| Duty | When | What |
|---|---|---|
| `reconcile` | Nightly | D1 ledger cents vs Monday Lifetime Giving; summaries vs ledger |
| `requeue` | Nightly | Re-enqueues pending rows stuck over 24 hours; prunes old rows. Alerts when it found any |
| `classify` | Nightly | Funding Stream, Gift Size, Fiscal Quarter, Gift Fiscal Year, Matched By Company, Acknowledgment Tier backstop, blank Fiscal Year Ending |
| `membership` | Nightly | Recomputes 13-month anniversaries; sets Membership Status to Lapsed for expired terms (max 500 a night) |
| `recurring` | Nightly | Has Active Recurring Gift on People, from the Recurring Gifts board |
| `rollcall` | Nightly | Donor Roll Call board, diffed by Row Key |
| `sponsorships` | Nightly when configured | Backfills sponsorship facts |
| `capacity` | Mondays | Alerts when any board in the workspace nears Monday's item limit |
| `sweep` | July 1 (and Jan 1 for calendar-year sponsorships) | Recomputes owners so This/Last Year roll over; paced for Monday's daily call cap |
| `archive` | July 15 | Archives gifts past the active window; writes closed-year summaries |

Every duty can also run on demand:
`POST /custodian/run/<duty>` with `Authorization: Bearer $CUSTODIAN_SECRET`.
`GET /custodian/status` shows the last run of each. Failures post an update on the alert item
(`custodian.alertItemId`): an item on IT Requests in production, on Worker Alerts (sandbox) in
the sandbox. Subscribe to that item to be notified.

### Dead-letter queue

After 100 retries the message goes to `donation-rollups-recompute-dlq`. This Worker consumes it:
the pending row becomes `failed` with `dead-lettered after retries: …` and one alert names the
donations. Nothing re-drives automatically.

### D1 tables

| Table | Holds |
|---|---|
| `pending_recomputes` | One row per donation event: `queued`, `received`, `written`, `failed`, `dropped` |
| `donation_links` | Donation → owner reverse index. For archived gifts, the only source |
| `gifts` | Authoritative gift ledger: cents, date, fiscal year, status, type, term start, `removed_at` |
| `annual_summaries` | One row per closed fiscal year |
| `owner_recomputes`, `owner_leases` | Coalescing and per-owner locking |
| `custodian_runs` | Each duty's last runs and cursors |
| `affiliations`, `roll_call_credits`, `membership_baseline`, `volunteer_activity` | Affiliation, roll call and membership inputs |

## Monday boards and columns

Ids live in `config/svbc.json` (production) and `config/sandbox.json` (sandbox).

| Board | Reads | Writes |
|---|---|---|
| Donations | Donor, Amount, Date, Status, Fiscal Year Ending, Gift Type, Acting for, Matched By, Sponsorship Cycle, In-Kind Value | Term Start, Term End, Membership Type (post-cutover qualifying gifts); Funding Stream, Gift Size, Fiscal Quarter, Gift Fiscal Year, Matched By Company, Acknowledgment Tier, blank Fiscal Year Ending |
| People, People (Historical) | Membership columns, Household ID, address, Do Not Solicit / Do Not Mail flags | Lifetime Giving, Gift Count, First Gift, This Year (amount, count), Last Year (amount, count), Largest, Smallest, Average, Last Gift Date and Amount, Donor Level, Organizational Giving, Gift Ledger (JSON), Has Active Recurring Gift; membership: Member Since, Current Term Start, Member Until, Membership Tier, Membership Status, Lapse Count, Last Lapsed, Member Type; item description |
| Organizations | Recognition Name | The same rollup set and Donor Level; item description with Sponsorships |
| Event Registrations, Volunteers (historical) | Attendee, Event, Attendance, Role, Hours, Status | Nothing |
| Affiliations | Person, Organization, Status, Primary | Attributed Giving, Attributed Gift Count, Last Attributed Gift; Employer Name on People |
| Recurring Gifts | Status, Donor | Nothing |
| Donor Roll Call | Row Key | All columns |
| Annual Giving Summary | | One item per closed fiscal year |

Things that must be set up by hand in Monday:

- The **Item description** widget on every owner board's item view (no API). Without it,
  description writes log "gift-history description skipped".
- Membership Type labels on Donations: New, Continuing, Lapsed renewal, Lifetime.
- Matched By Company is a status column, capped at 40 labels. A 41st company fails its write.

Membership rule: a person is a member when they gave at least $1 (eligible Gift Types) or
volunteered at least 1 hour in the last 13 months. Lifetime is a single gift of $1,000 or more
(`lifetimeThresholdCents`). Member Since and Member Until only extend; the other membership
columns are rewritten each recompute. Details:
[membership design](../../superpowers/specs/2026-10-09-membership-activity-rule-design.md).

## Secrets

| Name | Purpose | Issued by | Rotate |
|---|---|---|---|
| `MONDAY_WEBHOOK_SECRET` | Shared secret in Monday's webhook URLs (`?secret=`) | Generated by the operator | Monday cannot read back a webhook URL, so a lost secret means rotate: `wrangler secret put`, redeploy, re-run `setup-webhooks.mjs` with `--prune` |
| `CUSTODIAN_SECRET` | Bearer token for `/custodian/*` routes | Generated by the operator | `wrangler secret put`; touches no webhook |
| `MONDAY_SIGNING_SECRET` | Required (`MONDAY_WEBHOOK_JWT_REQUIRED` is on). Verifies Monday's signed JWT on app-created webhooks | Monday Developer Center, Staff sync app (Signing Secret) | Copy the new Signing Secret, `wrangler secret put` |
| `MONDAY_API_TOKEN` | Optional fallback only; normal access is the broker. Operator scripts read it from the shell | Monday (SVBC Integration user) | Do not add new uses |

`MONDAY_WEBHOOK_JWT_REQUIRED` is a var: `"true"` rejects unsigned deliveries. It is `"true"` in
both environments since 2026-11-19, so `MONDAY_SIGNING_SECRET` is required: without it every
delivery gets a 401. A subscription registered with a personal token (not through the broker)
is rejected too.

## Write switch

Key `donation-rollups:writes` in `FLAGS` (`sandbox-FLAGS`). Set with
`node scripts/flags.mjs donation-rollups writes on|hold|off --env production|sandbox`.

| Mode | Webhook | Recompute queue | Custodian |
|---|---|---|---|
| `on` | Records and enqueues | Writes | Runs |
| `hold` | Records and enqueues | Paused; messages held | Daily run skipped; `POST /custodian/run/*` returns 409 |
| `unknown` (KV error) | Records and enqueues | Not paused; messages retry on backoff | Skipped |
| `off` (or missing key) | Records and enqueues; message stamped | Dry run: logs `"writeSwitch":"skipped"`, marks the pending row `dropped` | Dry run; no cursors advance, ledger not refreshed |

During a production load (`salesforce-import`), keep this switch `off` or the webhooks
unsubscribed: every imported gift fires a webhook and each one is a full owner recompute. The
DLQ consumer runs in every mode. Details: [Operations](../07-operations.md).

## Failure modes

| Symptom | Cause | What to do |
|---|---|---|
| Totals stale; `pending_recomputes` rows stuck `queued` | Consumer failing or a flood exceeded limits | `requeue` re-sends rows over 24 hours old nightly. To push now: `redrive-pending.mjs` |
| Alert "dead-lettered after retries" | Recompute failed 100 times | Fix the cause, then `redrive-pending.mjs --status failed` |
| Burst of Monday 429 or `DAILY_LIMIT_EXCEEDED` | Monday rate or daily cap (10,000 calls a day account-wide, shared with the sandbox) | Batch defers to the hint or midnight UTC; no action unless it persists |
| Flood of recomputes after a bulk edit | Every Monday API write fires a webhook | Coalescing absorbs most. Put the switch on `hold` for planned bulk loads |
| Recompute fails on a missing table or column after deploy | D1 migration not applied first | Apply migrations, then redeploy |
| "gift-history description skipped" in logs | Item description widget missing on that board, or a description over about 250 blocks | Add the widget in the item view. The JSON column still holds the full history |
| Lifetime Giving jumps by a large amount | Someone merged `Received (Historical)` into `Received` | Restore the separate label |
| Classify `failed` count rises | Matched By Company hit Monday's 40-label cap | Prune or merge labels |
| `reconcile` reports mismatches | A write was lost, or a staff edit to a Worker column | Recompute the owner (any edit to one of their gifts) or run `sweep` |
| All writes fail with 401/403 | Broker token problem | Check `monday-auth` `/health` |
| Nothing arrives after a board rebuild | Webhooks are board-scoped; D1 holds dead item ids | Follow README "Resetting for new board ids", then re-run `setup-webhooks.mjs` |
| `setup-webhooks.mjs` creates nothing new | It skips an event type a board already has, even if owned by another token | Run with `--prune` on those boards; old personal-token webhooks must be deleted by their creator |

## Operator scripts

Run from `donation-rollups/`. Scripts take `MONDAY_API_TOKEN` from the shell unless noted.

| Script | When | Command |
|---|---|---|
| `setup-webhooks.mjs` | After any board change, deploy to a new environment, or secret rotation | `MONDAY_AUTH_URL=https://svbc-monday-auth.svbc-account.workers.dev START_KEY=... WEBHOOK_SECRET=... node scripts/setup-webhooks.mjs --worker-url https://svbc-donation-rollups.svbc-account.workers.dev [--config config/sandbox.json] [--prune <boardIds>]` (needs `WEBHOOKS_ENABLED` on the broker for that deploy) |
| `redrive-pending.mjs` | Re-send stuck or failed pending rows, one per owner, with a canary | `MONDAY_WEBHOOK_SECRET=... node scripts/redrive-pending.mjs --worker-url <url> [--status queued,received,failed] --dry-run`, then without `--dry-run` (add `--bookkeep` to mark settled owners' other rows) |
| `redrive-pending-bookkeeping.sql` | Mark leftover rows of already-recomputed owners `written` | `npx wrangler d1 execute <db> --remote --file=scripts/redrive-pending-bookkeeping.sql` |
| `setup-owner-columns.mjs` | Create the rollup columns on an owner board | `node scripts/setup-owner-columns.mjs <boardId> [...]` |
| `setup-membership-columns.mjs` | Create membership columns; prints config blocks | `node scripts/setup-membership-columns.mjs <peopleBoardId> [...] [--registrations <boardId>]` |
| `setup-classification-columns.mjs` | Create chart label columns on Donations | `node scripts/setup-classification-columns.mjs <donationsBoardId>` |
| `setup-affiliation-columns.mjs` | Create affiliation rollup columns | `node scripts/setup-affiliation-columns.mjs <affiliationsBoardId> <peopleBoardId> [...]` |
| `setup-annual-summary-board.mjs` | Create the Annual Giving Summary board | `node scripts/setup-annual-summary-board.mjs --workspace <id> --name "<name>" [--board <id>]` |
| `setup-roll-call-board.mjs` | Create the Donor Roll Call board | `node scripts/setup-roll-call-board.mjs --workspace <id> --people <ids> --organizations <id> --donations <id>` |
| `bootstrap-links-from-artifacts.mjs`, `bootstrap-gifts-from-artifacts.mjs` | Rebuild `donation_links` and `gifts` from `salesforce-import` run artifacts after a load | `node scripts/bootstrap-gifts-from-artifacts.mjs --payloads <p> --ledger <l> --boards <b> [--out file.sql]`, then `npx wrangler d1 execute <db> --remote --file=<file.sql>` |
| `bootstrap-links.mjs` | Rebuild links from live Monday (cannot see archived gifts) | `node scripts/bootstrap-links.mjs [--config config/sandbox.json] --out bootstrap.sql` |

Custodian on demand (long client timeout; repeat until `detail.remaining` is 0):

```sh
curl -X POST -H "Authorization: Bearer $CUSTODIAN_SECRET" \
  'https://svbc-donation-rollups.svbc-account.workers.dev/custodian/run/classify'
```

`POST /custodian/run/membership?all=true[&since=<ISO>]` is the full membership recompute.

## Changing it

Key files: `src/webhook/route.ts`, `src/consumer/processBatch.ts`, `src/rollups/`,
`src/membership/`, `src/custodian/` (one file per duty), `src/db/`, `src/projections/`,
`config/*.json` (validated by `src/config.ts`).

Gotchas:

- **Apply D1 migrations before deploying** code that uses them. Several past migrations
  (`0007`, `0008`, `0010`) broke every message when the code went first.
  ```sh
  npx wrangler d1 migrations apply svbc-donation-rollups-sandbox --env sandbox --remote
  npx wrangler d1 migrations apply svbc-donation-rollups --remote
  ```
- Every batched `items(ids:)` read must pass `limit: 100`; Monday silently returns 25 otherwise.
- A new Worker-written column on Donations must be added to the webhook ignore rule, or each
  write triggers a recompute.
- Money columns are written from integer cents as two-decimal text.
- `src/flags.ts` and `src/monday/graphql.ts` are byte-identical copies; edit the canonical files.
- `npm run dev` uses the production config; use `npm run dev:sandbox`.

Tests: `npm test`, `npm run typecheck`. Deploy: `npm run deploy:sandbox`, `npm run deploy`.

## Further reading

- [`donation-rollups/README.md`](../../../donation-rollups/README.md), especially [Resetting for new board ids](../../../donation-rollups/README.md#resetting-for-new-board-ids) and [Deploying: the write switch](../../../donation-rollups/README.md#deploying-the-write-switch).
- [UAT script](../../uat/donation-rollups.md).
- Design specs: [membership activity rule](../../superpowers/specs/2026-10-09-membership-activity-rule-design.md), [Donor Roll Call board](../../superpowers/specs/2026-11-02-donor-roll-call-board-design.md), [sponsorship audit history](../../superpowers/specs/2026-11-02-sponsorship-audit-history-design.md).
- [`funraise-sync`](funraise-sync.md), the main writer of Donations items.
- [Operations](../07-operations.md), [Troubleshooting](../08-troubleshooting.md).
