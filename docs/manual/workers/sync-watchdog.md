# sync-watchdog

[Appendix A](../reference/sync-watchdog.md) lists this Worker's routes, crons, queues, storage and bindings.

`sync-watchdog` deploys as `svbc-sync-watchdog` (production) and `svbc-sync-watchdog-sandbox`
(sandbox). It has no routes; `workers.dev` and preview URLs are off. It has no Monday access: it
reads only the Cloudflare API and the `FLAGS` KV namespace, and posts to Slack.

## What it does

Once an hour it checks that every production Worker is still running its crons, is on the write
switch it should be, and is draining its queue, and that no Custom Domain or route on the zone has
changed. It posts to the private staff Slack channel when
one of those goes wrong. If it stops, a Worker that goes quiet without logging an error (a
dropped cron, a forgotten `hold`, a stuck queue) goes unnoticed. The Monday heartbeat is how you
notice the watchdog itself has stopped.

## Trigger and data flow

### Cron: `40 * * * *` (hourly, production only)

Each run checks four kinds of subject:

| Subject | Healthy when | Source |
|---|---|---|
| `cron:<worker>:<cron>` | The Worker ran that cron within `maxGapHours` | Cloudflare GraphQL analytics (`workersInvocationsAdaptive`, cron events), matched to the expression by time |
| `writes:<worker>` | `<worker>:writes` in production `FLAGS` equals `expectedWrites` | `FLAGS` KV, read only |
| `queue:<queue>` | The oldest message is younger than `maxBacklogAgeHours` (6) | Cloudflare Queues REST API (metrics) |
| `domains:<zone>` | Every Custom Domain and Workers route on the zone matches `domains` | Cloudflare REST API: Workers Domains list, then the zone's Workers routes |

Then, per subject:

1. Load the subject's previous state from the `STATE` KV namespace.
2. Post when it goes bad, again once a day while it stays bad (`… still failing`), and once when
   it recovers. `domains:` also posts again as soon as its list of differences changes, so a
   second change while it is already bad isn't hidden. Save the new state.
3. If a check itself fails (Cloudflare API error), log it with `console.error` and leave that
   subject's state unchanged. No Slack post.

On the Monday 16:40 UTC run it also posts `sync-watchdog: running, N of M subjects healthy`.

The sandbox has no crons and never posts to Slack. Run by hand, it logs what it would have said
(`sync-watchdog (sandbox, not sent): …`).

Errors logged or thrown inside Workers are not this Worker's job. Workers Issues automations in
the Cloudflare dashboard post those to the same channel. See the
[sync alerting runbook](../../runbooks/sync-alerting.md).

### Storage

No D1. `STATE` KV holds one alert-state record per subject, and `snapshot:latest`: every
subject's result and the run time, written after each run (both environments) for
[`status-page`](status-page.md). A failed snapshot write is logged; alerts still go out.

## Monday boards and columns

None. It never calls Monday.

What it watches is `config/svbc.json` (production) and `config/sandbox.json`:

| Key | Meaning |
|---|---|
| `accountId` | Cloudflare account to query |
| `selfScript` | This Worker's own script; its runs prove Cloudflare's run data is arriving |
| `watched` | Each live Worker: production `script` name, `expectedWrites` (`on`, `off`, or `null` for Workers without a switch), and `crons` with `maxGapHours` |
| `notLive` | Workers with production crons that are not live yet, each with a reason |
| `queues` | Production main queues and `maxBacklogAgeHours` |
| `domains` | The zone, its expected `customDomains` (hostname → script, production and sandbox), `routes` (pattern → script; none today) and `pending` hostnames (declared, not deployed yet: fine absent or on their script). Production config only |

`config/coverage.test.ts` fails CI when any Worker's `wrangler.jsonc` gains, loses or changes a
production cron that this config does not match, so every cron is either watched or explained.
It also fails when `domains` doesn't list every Custom Domain in every `wrangler*.jsonc`, on the
script that declares it.

## Secrets

| Name | Purpose | Issued by | Rotate |
|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Reads cron invocations, queue metrics, Custom Domains and the zone's Workers routes. Permissions: Account Analytics Read, Queues Read, Workers Scripts Read (account); Workers Routes Read (zone `bikesiliconvalley.org`) | Cloudflare dashboard → Account API Tokens | Create a new token with the same permissions, `wrangler secret put`, delete the old one |
| `SLACK_WEBHOOK_URL` | The private staff channel's incoming webhook | Slack app incoming webhook | Issue a new URL, `wrangler secret put` |

Bindings (not secrets): `FLAGS` (production namespace in production, `sandbox-FLAGS` in the
sandbox) and `STATE`.

## Write switch

No write switch. It writes nothing to Monday, and it is the thing that reports on other
Workers' switches. To silence it, remove its cron or disable the Worker in the dashboard.

## Failure modes

What its own messages mean:

| Message | Meaning | What to do |
|---|---|---|
| `cron:<worker>:<cron>: no run since <time>` | That schedule has not fired within its gap | Check the Worker's Trigger Events in the dashboard. Usual causes: a deploy dropped the cron, or a cron changed in `wrangler.jsonc` without updating this config |
| `writes:<worker>: writes are <value>, expected <value>` | Write switch differs from `expectedWrites` | `node scripts/flags.mjs status`; set it back on if a hold is over. If the new value is intended, update `expectedWrites` and redeploy |
| `queue:<queue>: N messages waiting, oldest H h` | A production queue is not draining | Check the consumer's Workers Issues and logs. Expected while that Worker is on `hold` |
| `… still failing: …` | Same problem 24 hours later | As above |
| `… recovered` | Cleared | Nothing |

Problems with the watchdog itself:

| Symptom | Cause | What to do |
|---|---|---|
| No Monday heartbeat | Watchdog down, cron removed, or Slack webhook revoked | Check `svbc-sync-watchdog` in the dashboard and its logs |
| `sync-watchdog: N check(s) failed` in logs, no posts | Cloudflare API token expired or lacks a permission, or an API outage | Check the token's permissions; replace it if needed |
| `sync-watchdog: N check(s) failed … Cloudflare reports no cron runs …` in logs | Cloudflare's invocation data is empty or late. The Workers may be fine; cron subjects are not judged until it returns | Check the Workers' logs directly, and cloudflarestatus.com |
| CI fails in `coverage.test.ts` | A Worker's production cron changed without a matching config change | Update `config/svbc.json` (`watched` or `notLive`) in the same PR |
| A Worker on deliberate `hold` alerts every day | Expected; `expectedWrites` says `on` | Leave it during a planned hold, or change `expectedWrites` |

## Operator scripts

None. To take a Worker live, move it from `notLive` to `watched` in `config/svbc.json` with its
script name, expected write switch and a `maxGapHours` per cron (twice the interval; at least 3
hours for hourly, 30 for daily, 192 for weekly), then redeploy.

To see what it would say without posting, run the sandbox by hand:

```sh
npx wrangler dev --env sandbox --test-scheduled
curl 'http://localhost:8787/__scheduled?cron=40+*+*+*+*'
```

## Changing it

Key files: `src/run.ts` (orchestration, heartbeat, sandbox no-post), `src/checks.ts`
(health rules), `src/cloudflare.ts` (GraphQL and Queues API), `src/state.ts` (alert dedupe),
`src/alert.ts`, `config/svbc.json`, `config/coverage.test.ts`.

Gotchas:

- Any PR that adds, removes or changes a production cron in any Worker must also update this
  Worker's config, or CI fails.
- A Worker added to the fleet with a production queue needs a `queues` entry here too.
- It reads the production `FLAGS` namespace by id; if that namespace changes, update
  `wrangler.jsonc`.

Tests: `npm test`, `npm run typecheck`. Deploy: `npm run deploy` (sandbox: `npm run deploy:sandbox`).
No D1 migrations.

## Further reading

- [`sync-watchdog/README.md`](../../../sync-watchdog/README.md).
- [Sync alerting runbook](../../runbooks/sync-alerting.md): message meanings and the Workers Issues automations.
- [Design spec](../../superpowers/specs/2026-11-17-sync-failure-alerting-design.md).
- [Operations](../07-operations.md) (alerts), [Troubleshooting](../08-troubleshooting.md).
