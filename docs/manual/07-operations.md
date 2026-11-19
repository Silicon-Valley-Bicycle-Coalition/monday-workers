# Operations

Day-to-day running: the write switch, queues, logs and alerts, backups, the repo-wide operator
scripts, and the chores that keep the system healthy.

## The write switch

[Chapter 2](02-architecture.md#the-write-switch) explains what `on`, `hold` and `off` mean. This
section covers using them. The CLI is `scripts/flags.mjs`. It calls `npx wrangler` under the
hood, so you must be logged in. Run it from the repo root.

```sh
node scripts/flags.mjs status --env production                   # every Worker: mode, log level, queue state, backlog
node scripts/flags.mjs funraise-sync writes hold --env production
node scripts/flags.mjs funraise-sync writes on --env production
node scripts/flags.mjs funraise-sync log debug --env sandbox      # redacted payloads in skip logs
node scripts/flags.mjs retention --env production                # set 14-day retention on every queue
```

What `writes` does:

- **`hold`** writes the KV key, then **pauses** the Worker's main queues.
- **`on`** writes the KV key, waits 60 seconds for KV edge caches to catch up, then resumes the
  queues.
- **`off`** writes the key and resumes the queues. They then drain as dry runs.
- Dead-letter queues are never paused.

If the KV write works but the queue step fails, the command exits non-zero, and `status` shows
the row as `MISMATCH`. Fix it by re-running the same command.

### Rules

- **Leave `hold` with `on`, never `off`.** Going from `hold` to `off` throws away everything
  held.
- **Never run `all writes on`.** Several Workers must stay `off` until their own rollout gates
  pass: `contact-roles`, `impact-attribution`, `dtd-sync`, `nearby-search` and `quickbooks-sync`.
  `all` would turn them on. Flip Workers one at a time.
- **Wait about a minute after `hold`** before relying on it. Reads are cached for 30 seconds.
- `sync-watchdog` alerts when a production Worker's switch isn't the value in its config
  (`expectedWrites`). If you change a switch on purpose for more than a few hours, update
  `sync-watchdog/config/svbc.json` and redeploy it, or expect the alert.

### When to use which

| Situation | Use |
|---|---|
| A bulk change in Monday (an import, a board rebuild, a column migration) that Workers shouldn't react to or write over | `hold` the affected Workers, do the work, then `on` |
| A Worker is writing bad data | `hold` it at once. Investigate, fix, deploy, then `on`. Held work then writes with the fix. |
| A Worker must not process anything it receives, for now or later | `off` |
| A new Worker's first run in production | Deploy with `off`, read its dry-run logs, then `on` |

The full procedure used during the Salesforce migration is in
[`docs/runbooks/migration-hold.md`](../runbooks/migration-hold.md). Each Worker's chapter says
how that Worker behaves under each mode.

## Queues and dead letters

```sh
npx wrangler queues list                                  # every queue with backlog
npx wrangler queues info funraise-sync-writes             # one queue: consumers, backlog
npx wrangler queues pause-delivery funraise-sync-writes   # flags.mjs does this for you
npx wrangler queues resume-delivery funraise-sync-writes
```

A growing **main queue** backlog has one of three causes: the consumer is failing and retrying
(check Workers Issues and `wrangler tail`), the Worker is on `hold`, or Monday is down.
Messages wait up to 14 days.

A message in a **dead-letter queue** has used all its retries. The DLQ consumer:

- marks the Worker's D1 row as dead-lettered;
- logs one error per batch, which raises a Workers Issues alert in Slack.

To recover:

1. Find and fix the cause. Common causes:
   - a renamed Monday column or a missing status label;
   - a revoked token;
   - a config id that points at a deleted board.
2. Deploy the fix.
3. Re-drive with the Worker's script, which re-enqueues the failed rows from D1:
   - `funraise-sync`: `node scripts/redrive-failed.mjs`
   - `mailchimp-sync`: `node scripts/redrive-dead-lettered.mjs`
   - `donation-rollups`: `node scripts/redrive-pending.mjs`

   Each script's header and the Worker's README give the flags. Run it with `--env sandbox`
   first if you can.

## Logs

```sh
npx wrangler tail svbc-<worker>                     # live logs, production
npx wrangler tail svbc-<worker>-sandbox             # sandbox
npx wrangler tail svbc-<worker> --format json --status error
```

Use the dashboard for history. **Workers & Pages → the Worker → Observability** has Workers Logs
for the last few days, and **Settings → Trigger Events** shows cron runs. **Issues** groups errors
by cause.

## Alerts and what they mean

Two sources post to the **private staff Slack channel**. The sandbox never alerts.

1. **Workers Issues automations**, set up in the dashboard. Each production Worker has two
   automations: "occurs once" and "recurs after 24 hours". They fire when a Worker throws, logs
   `console.error`, or returns a 5xx. A dead letter shows up this way.
2. **`sync-watchdog`** runs hourly at :40 and catches silence. It reports when:
   - a cron didn't run within its allowed gap;
   - a write switch isn't the expected value;
   - a queue isn't draining.

   It repeats an unresolved problem after 24 hours, says when the problem recovers, and posts a
   heartbeat every Monday at 16:40 UTC. **If the heartbeat stops, the watchdog itself is down.**

`monday-auth`, `monday-backup` and `mailchimp-sync` also post their own alerts (consent lost,
backup incomplete, and so on). Their chapters list them.

The message-by-message guide is
[`docs/runbooks/sync-alerting.md`](../runbooks/sync-alerting.md). Symptom-first troubleshooting
is in [chapter 8](08-troubleshooting.md).

### Adding a Worker to monitoring

When a Worker with production crons goes live:

1. Move it from `notLive` to `watched` in `sync-watchdog/config/svbc.json`. Give it a
   `maxGapHours` for each cron (twice the interval; at least 3 for hourly, 30 for daily, 192 for
   weekly) and its `expectedWrites`.
2. Redeploy `sync-watchdog`. CI's `coverage.test.ts` fails until every Worker with production
   crons is listed.
3. In the dashboard, add the two Workers Issues automations (**Issues → Automations → Add
   automation**, destination `staff-slack-private`) and record them in `sync-alerting.md`.

## Backups and restore

`monday-backup` takes a nightly snapshot of every Monday board, item, update and doc that the
Read-only app can see. It writes the snapshot, encrypted with
`BACKUP_ENCRYPTION_KEY`, to a folder per run on the backup **Google Shared Drive**. It alerts
Slack if a run is partial.

Restoring is an operator task done from a laptop: `cd monday-backup && npm run restore`. Follow
[`monday-backup/RESTORE.md`](../../monday-backup/RESTORE.md): pick a snapshot, decrypt, dry run,
restore into an **empty** workspace, then verify. A restore creates new boards with new ids. It
doesn't overwrite the live ones. **The full restore hasn't been rehearsed end to end yet**
(RESTORE.md, "Restore rehearsal"), so treat a first real restore with care and rehearse it in
the sandbox when you can.

Also keep in mind:

- **Monday's own safeguards:** boards, items and columns go to the trash or archive for 30 days
  before permanent deletion, and the account admin can restore them there. Check the Monday UI
  before reaching for a snapshot.
- **What's not backed up:** file contents attached to items (metadata only), deleted boards still
  in Monday's 30-day trash, Worker D1 databases, and Cloudflare configuration (which is in Git).
  D1 has its own point-in-time recovery: `npx wrangler d1 time-travel restore <db> --timestamp …`
  covers the last 30 days. Secrets are
  in the password manager.

## Operator scripts at the repo root

All are dependency-free Node scripts with `node:test` tests beside them. Each starts with a
comment describing its usage. Load your Monday token first (`source .env.production` or
`.env.sandbox`).

| Script | Use |
|---|---|
| `flags.mjs` | Write switch and queue retention (above) |
| `check-monday-token-scope.mjs` | Which workspaces and boards a Monday token can actually reach |
| `make-boards-private.mjs` | List or change board privacy, with a dry run by default. As of this writing `--apply` fails on SVBC's account, so make boards private in the UI. |
| `mark-read-only-columns.mjs` | Adds 🔒 and 📜 to the columns in `MARKED_COLUMNS` |
| `check-donation-form.mjs` | Checks the staff "Enter a gift" form shows only the expected questions (`--form <token>`) |
| `smoke-donation-entry.mjs` | Creates, checks and deletes test gifts on a **sandbox** Donations board |
| `windfall-board.mjs`, `funding-leads-board.mjs`, `sponsor-outreach-setup.mjs`, `propose-partner-types.mjs` | One-off board builders, each with a runbook in `docs/runbooks/` |
| `build-font-modules.mjs` | Regenerates the self-hosted fonts in `member-portal` and `svbc-calendars` |
| `manual-reference.mjs`, `check-manual.mjs`, `build-manual.mjs` | This manual |
| `check-*.mjs` (other) | The CI checks in [chapter 6](06-ci-and-deploy.md#checksyml-steps). Run any of them locally. |

## Recurring chores

| When | Chore | How |
|---|---|---|
| Every Monday | Check the watchdog heartbeat arrived in Slack | If it didn't, check `svbc-sync-watchdog` |
| Monthly | Skim open Workers Issues in the dashboard | Resolve fixed ones so recurrences alert again |
| Monthly | `node scripts/flags.mjs status --env production` | Every row as expected, no `MISMATCH` or `?` |
| Quarterly | Check a backup run on the Shared Drive is complete and recent | `monday-backup` chapter |
| At least every two quarters | **Bump the Monday API version** | Change `MONDAY_API_VERSION` in the canonical `monday-backup/src/monday/graphql.ts`, copy it to every Worker (the `monday-graphql-copies` list), and update the literal in `salesforce-import` and `bp-feedback-notify`. Run every Worker's tests, deploy, and confirm with `{ version { value kind } }` that it's still served as itself. |
| When staff join or leave | Review Cloudflare members, GitHub org, Monday admins and private-board subscribers. Rotate secrets the leaver could read. | [Chapter 3](03-accounts-and-access.md) |
| When a Donations column is added | Hide it on the "Enter a gift" form, then run `check-donation-form.mjs` | [`CLAUDE.md`](../../CLAUDE.md), "The staff 'Enter a gift' form" |
| When a Worker starts writing a column | Add it to `MARKED_COLUMNS` and run `mark-read-only-columns.mjs` | [Chapter 2](02-architecture.md#read-only-column-markers) |
| Before trusting a token's reach | `check-monday-token-scope.mjs` | [Chapter 2](02-architecture.md#monday-access-the-token-broker) |
| Yearly | Renew vendor contracts and check that API keys haven't expired | Private appendix has renewal dates |
| After a Worker change ships | Rebuild this manual's PDF and upload it as a new Box version | [`docs/manual/README.md`](README.md) |

## Costs

The Cloudflare account is on Workers Paid ($5 a month base) through Project Galileo, which
covers the zone's Business plan. Usage at SVBC's volume stays near the included limits. Queues
and D1 operations are well under quota. The $10-a-month billing alert is the early warning.
Per-Worker CPU and request metrics are in the dashboard. Monday seats (including the integration
user's) and vendor subscriptions are billed by those vendors. See the private appendix.
