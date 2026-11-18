# Sync failure alerting — design

Date: 2026-11-17 · Status: draft for approval

## Intent

When a production Worker that keeps Monday in sync stops working, the operator (DWK) should hear
about it in the **private staff Slack channel** within hours, not discover it weeks later from a
missing gift or a stale roster. Today nothing tells anyone.

Evidence that this is real, from the account on 2026-11-17:

- Workers Issues is enabled on every Worker (README "Error monitoring: Workers Issues") and holds
  **117 active issues, 4.39k occurrences, 0 resolved**. Nothing routes them anywhere.
- Two **production** failures are live and unnoticed: `svbc-eventbrite-sync`'s missed-orders check
  fails with Eventbrite HTTP 400 (15 occurrences), and `svbc-people-reclassification` fails every
  run because the People board has no column titled "Promote to People".
- Only four Workers post to Slack themselves (`monday-backup`, `monday-auth`, `mailchimp-sync`,
  `svbc-calendars`), each about its own narrow failure.

## Goals

1. Every production error a Worker already surfaces (uncaught exception, 5xx, `console.error`,
   dead-lettered message) reaches the staff Slack channel once, when it first appears, and again if
   it comes back after going quiet.
2. A production cron Worker that **stops running**, or that runs but is held by its write switch,
   is reported even though it raises no error.
3. A production queue whose backlog keeps growing (consumer stuck, or held) is reported.
4. Alerts are few enough that DWK reads every one.

## Non-goals

- Sandbox Workers. They are excluded from every alert (most of the 117 issues are sandbox).
- Paging or on-call escalation. Slack is the only channel.
- Auto-remediation (re-driving dead letters, flipping switches). Alerts point at the existing tools
  (`scripts/redrive-failed.mjs`, `scripts/flags.mjs`).
- Fixing the two live production failures above. They are triaged separately; this design only
  makes sure the next ones get seen.
- Replacing `monday-backup`'s own watchdog (snapshot staleness), which stays as is.

## Anti-goals

- **Alert fatigue.** An alert that repeats every hour for a known condition gets muted, and then
  the channel is useless. Every check alerts on a change of state, with at most one daily reminder.
- **PII in Slack.** No donor names or email addresses in any message. Workers Issues payloads
  include surrounding logs, which the `log-safety` CI check already keeps free of email addresses;
  the watchdog's own messages name Workers, queues and counts only.

## Approaches considered

| | Approach | Trade-off |
|---|---|---|
| A | Workers Issues automations only (dashboard) | No code, catches every error, but blind to a Worker that goes quiet or is left on `hold` |
| **B** | **A, plus a `sync-watchdog` Worker for silence** | **Chosen.** Small new Worker; no change to the 13 existing Workers |
| C | Each Worker posts its own failures to Slack | 13 copies of alert code, duplicates Issues, still misses a cron that never fires |

DWK chose **B** (2026-11-17).

## Part 1 — Workers Issues automations (dashboard, no code)

- One automation per **production** Worker, on that Worker's Issues page
  (**Automations → Add automation**). Sandbox Workers get none.
- Triggers: occurrence threshold **1** (a new issue alerts immediately) and recurrence after
  **24 hours** of inactivity. If one automation can't hold both triggers, create two; the account
  limit is 50 automations and 16 production scripts are deployed (17 with `sync-watchdog`;
  `svbc-member-portal-writer` counts separately).
- Destination: a **Chat** destination for the private staff Slack channel (the one
  `monday-backup` alerts into, [GL#52](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/52)), created once and shared by every automation.
- **Who does what** (DWK, 2026-11-17): Claude sets up the destination and automations in the
  dashboard (Chrome); DWK triages the existing production issues, deciding which to resolve,
  before the automations are turned on, so the first day isn't a flood. Automations are created
  disabled and enabled once DWK says the triage is done.
- These settings live only in the dashboard. Record the list (Worker, triggers, destination) in a
  new runbook, `docs/runbooks/sync-alerting.md`, and point to it from the README's "Error
  monitoring: Workers Issues" section, so a fork can recreate them.

## Part 2 — `sync-watchdog` Worker

A new Worker in its own directory, on the repo's standard TypeScript stack, with one hourly cron.
It reads state from Cloudflare and posts to Slack. It writes nothing to Monday and holds no donor
data.

### Checks (each run)

1. **Cron ran — per schedule, not per Worker.** Several Workers run an hourly and a daily cron
   (`funraise-sync`, `mailchimp-sync`, `monday-backup`, `dtd-sync`); a dead daily job must not
   hide behind a live hourly one. For each watched (Worker, cron expression) pair, find the latest
   scheduled invocation of the production script for that expression. None within its window →
   alert `<worker> (<cron>): no run since <time>`. Errors inside a run are Part 1's job, not this
   check's. *(Builder check; my call.)*
2. **Write switch — against the expected value.** Read `<worker>:writes` from the production
   `FLAGS` KV namespace for each watched Worker. Alert when it differs from that Worker's
   expected value in config (`on` for live Workers; `off` for one deliberately parked, such as
   `quickbooks-sync`), then a daily reminder while it stays that way. A deliberately parked
   Worker is quiet until someone changes it. *(Builder check; my call.)*
3. **Queue backlog.** For each production main queue, read its backlog from the Queues API. A
   backlog that is non-empty and older than the threshold → alert with queue name and count.
   Dead-letter queues are *not* checked by depth: their consumers drain them and log each dead
   letter with `console.error`, which Part 1 already alerts on.

### Behaviour

- **Alert on state change only.** Per check and subject (for example `cron:funraise-sync`), keep
  the last state and the time of the last alert. Post when a subject goes bad, once a day while it
  stays bad, and once when it recovers ("funraise-sync: cron running again").
- **Heartbeat.** Every Monday at 16:00 UTC, post one line saying the watchdog ran and how many
  subjects are healthy. If that line stops arriving, the watchdog itself is down.
- **Its own failures** (an API call fails, KV unreadable) go to `console.error`, so Part 1's
  automation for `sync-watchdog` reports them. A failed check never counts as "healthy".

### Configuration

`config/svbc.json`, validated at startup like every other Worker's config:

- the Slack channel is a secret (`SLACK_WEBHOOK_URL`), not config;
- `watched`: Worker directory name → production script name, expected write-switch value (or
  none, for Workers without one), and for each production cron expression its maximum gap
  between runs (about twice the interval, with floors of 3 hours for hourly, 30 hours for daily
  and 8 days for weekly);
- `notLive`: Worker directory name → one-line reason it isn't watched (not deployed to
  production, sandbox only). As of 2026-11-17: `dtd-sync` and `nearby-search` (not deployed),
  `impact-attribution` (production deployed with no cron and no live writes yet; confirm at
  build time), `quickbooks-sync` (sandbox only, postponed). The README's status table is
  stale on this point (it lists `contact-roles` as undeployed; production is live), so
  the builder checks the live account, not the README;
- `queues`: production main queue names and the maximum backlog age before alerting.

A config test reads every `wrangler.jsonc` and fails unless every Worker with production crons
is in exactly one of `watched` or `notLive`, and every `watched` cron expression matches the
Worker's production crons with a gap no shorter than its interval. Taking a Worker live
therefore fails CI until it moves from `notLive` to `watched`, deliberately. *(Builder check; my
call.)*

### Bindings and secrets

- `FLAGS`: the production `FLAGS` KV namespace (read only).
- `STATE`: a new KV namespace of its own for per-subject state.
- `CLOUDFLARE_API_TOKEN`: an account API token with **Account Analytics: Read** and
  **Queues: Read** only.
- `SLACK_WEBHOOK_URL`: the private staff channel's incoming webhook.
- `observability.issues.enabled: true`, like every Worker.

### Repo conventions

- **Slack posting**: copy the shape of `monday-backup/src/alert.ts` (10-second timeout, failures
  logged, never thrown).
- **No write switch.** It writes nothing to Monday, like `monday-auth` and `member-map`; add it to
  the exceptions listed in `CLAUDE.md`.
- **Sandbox environment**: an `env.sandbox` block with **no crons** (sandbox crons are off to save
  cost), the `sandbox-FLAGS` namespace and a sandbox webhook, so it can be run by hand against
  sandbox Workers. Not alerting from sandbox is the point.
- CI: a test job for the new directory, like the other Workers'.
- README: add it to "Status at a glance", and replace the line about a "Slack-automation ping" for
  cron-polled Workers with a pointer here.

## Left to the builder

- The exact GraphQL dataset and fields that identify a scheduled invocation per script, and the
  Queues API field for backlog age. Confirm both against the live account before writing the
  checks. The cron check needs invocations grouped by cron expression; if Workers Analytics
  can't do that, use Workers Observability's query API (scheduled events carry the cron
  string), and widen the token's permissions to match.
- Exact message wording, within the rules above.
- Whether the Monday heartbeat counts subjects or lists them.
- Initial thresholds, starting from the rules above.
