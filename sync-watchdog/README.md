# sync-watchdog

Hourly cron Worker (`40 * * * *`) that posts to the private staff Slack channel when a production
Worker:

- **stops running a cron**: no scheduled run of a (Worker, cron expression) pair within its
  `maxGapHours`;
- **is not on its expected write switch**: `<worker>:writes` in the production `FLAGS` KV
  differs from `expectedWrites`;
- **has a queue backlog that isn't draining**: a production main queue's oldest message is older
  than `maxBacklogAgeHours`;
- **has had its hostname moved**: a Custom Domain or Workers route on `bikesiliconvalley.org`
  differs from `domains` (missing, on another Worker, or not listed). The sandbox deploy token can
  change routes on the whole zone, and Cloudflare has no notification for that
  ([docs/manual/06-ci-and-deploy.md](../docs/manual/06-ci-and-deploy.md#the-sandbox-deploy-token)).
  This subject posts again whenever its list of differences changes.

It posts when a check goes bad, once a day while it stays bad, and once when it recovers. Every
Monday's 16:40 UTC run posts a one-line heartbeat; if that stops arriving, the watchdog itself is
down. Errors inside Workers are not this Worker's job: Workers Issues automations cover them
(see [`docs/runbooks/sync-alerting.md`](../docs/runbooks/sync-alerting.md)).

Design: [`docs/superpowers/specs/2026-11-17-sync-failure-alerting-design.md`](../docs/superpowers/specs/2026-11-17-sync-failure-alerting-design.md).

## Config

`config/svbc.json` lists every production Worker as `watched` (script, expected write switch,
crons with their maximum gap) or `notLive` (with a reason). `config/coverage.test.ts` fails CI
when any Worker's `wrangler.jsonc` gains, loses or changes a production cron that this file
doesn't match. To take a Worker live, move it from `notLive` to `watched`.
The same test fails until `domains` lists every Custom Domain in any `wrangler*.jsonc` on the
script that declares it: in `customDomains` once deployed, in `pending` until then.

Cron expressions must be ones `src/cron.ts` can read (numbers, `*`, `*/n`, ranges and lists; no
names, `L`, `W` or `#`); config validation rejects the rest. Weekdays are Cloudflare's: 1 is Sunday.

## How cron runs are read

From Cloudflare's GraphQL `workersInvocationsAdaptive`, filtered to `eventType: "cron"`. It gives
the script and the minute, not the cron expression, so `src/cron.ts` matches runs to expressions by
time (up to 2 minutes late). Where several crons of one Worker share a minute, all of them count as
run only if that minute has that many runs; otherwise the shortest-gap ones are credited first.
The data can lose the odd row, so one missing run never alerts on its own.

`workersInvocationsScheduled`, which does carry the expression, returned no rows for this account
(checked 2026-11-24, 30 days back) while the crons ran, so until then every cron subject alerted
daily. If the data has no run of any watched Worker or of the watchdog itself (`selfScript`) in the
last 2 h, every cron subject is "check failed" (logged, not posted) instead of "no run".

## Bindings and secrets

- `FLAGS`: the production `FLAGS` KV namespace, read only.
- `STATE`: this Worker's own KV namespace, holding per-subject alert state, and also
  `snapshot:latest`: every subject's result and the run time, written each run (both environments)
  and read by [`status-page`](../status-page/README.md).
- `CLOUDFLARE_API_TOKEN` (secret): an account token with Account Analytics Read, Queues Read and
  Workers Scripts Read, plus Workers Routes Read on the `bikesiliconvalley.org` zone. Without
  the last two, `domains:` is "check failed" (logged, not posted).
- `SLACK_WEBHOOK_URL` (secret): the private staff channel's incoming webhook.

No write switch: it writes nothing to Monday. The sandbox environment has no crons and never
posts to Slack. Run it by hand to see what it would say.

```sh
npm test
npm run typecheck
npm run deploy
```
