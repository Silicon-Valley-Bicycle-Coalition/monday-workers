# Sync failure alerting

Two things post to the **private staff Slack channel** when a production Worker has a problem:

1. **Workers Issues automations** (dashboard): an error a Worker logs or throws.
2. **[`sync-watchdog`](../../sync-watchdog/README.md)** (this repo): a Worker that goes quiet
   without an error.

Sandbox Workers never alert. Design:
[`docs/superpowers/specs/2026-11-17-sync-failure-alerting-design.md`](../superpowers/specs/2026-11-17-sync-failure-alerting-design.md).

## What a message means

| Message | Meaning | What to do |
|---|---|---|
| `sync-watchdog: cron:<worker>:<cron>: no run since <time>` | That schedule hasn't fired within its allowed gap. | Check the Worker in the dashboard (Settings → Trigger Events). A redeploy that dropped the cron, or a cron changed in `wrangler.jsonc` without updating `sync-watchdog/config/svbc.json`, are the usual causes. |
| `sync-watchdog: writes:<worker>: writes are <value>, expected <value>` | The write switch differs from the value the watchdog expects. | `node scripts/flags.mjs status`, then `node scripts/flags.mjs <worker> writes on` if the hold is over ([migration-hold runbook](migration-hold.md)). If the new value is intended, update `expectedWrites`. |
| `sync-watchdog: queue:<queue>: N messages waiting, oldest H h` | A production queue isn't draining. | Look at the consumer's Workers Issues and logs. If the Worker is on `hold`, that's expected until it's turned back `on`. |
| `… still failing: …` | The same problem, 24 hours later. | As above. |
| `… recovered` | The problem cleared. | Nothing. |
| `sync-watchdog: running, N of M subjects healthy` | Monday 16:40 UTC heartbeat. | If it **stops arriving**, the watchdog itself is down: check `svbc-sync-watchdog` in the dashboard. |
| A Workers Issues message | A Worker logged an error, threw, or returned a 5xx. Dead-lettered messages show up this way too. | Open the issue, fix the cause, and resolve the issue. Re-drive dead letters with the Worker's `scripts/redrive-failed.mjs` where it has one. |

## Taking a Worker live

`sync-watchdog/config/coverage.test.ts` fails CI until every Worker with production crons is
either `watched` or `notLive` in `sync-watchdog/config/svbc.json`. When a Worker goes live, move
it from `notLive` to `watched` with its script name, expected write switch, and a `maxGapHours`
for each cron (2× the interval; at least 3 h for hourly, 30 h for daily, 192 h for weekly), then
redeploy `sync-watchdog`.

## Workers Issues automations (dashboard)

One per production script, each to the `staff-slack-private` Chat destination, with occurrence
threshold 1 and recurrence after 24 h of inactivity. They are created **disabled** and turned on
once the backlog of known production issues has been triaged.

| Script | Triggers | Destination | Enabled |
|---|---|---|---|
| _filled in when the automations are created_ | | | |
