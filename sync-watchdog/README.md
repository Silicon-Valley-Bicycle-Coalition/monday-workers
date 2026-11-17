# sync-watchdog

Hourly cron Worker (`40 * * * *`) that posts to the private staff Slack channel when a production
Worker:

- **stops running a cron**: no scheduled run of a (Worker, cron expression) pair within its
  `maxGapHours`;
- **is not on its expected write switch**: `<worker>:writes` in the production `FLAGS` KV
  differs from `expectedWrites`;
- **has a queue backlog that isn't draining**: a production main queue's oldest message is older
  than `maxBacklogAgeHours`.

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

## Bindings and secrets

- `FLAGS`: the production `FLAGS` KV namespace, read only.
- `STATE`: this Worker's own KV namespace, holding per-subject alert state.
- `CLOUDFLARE_API_TOKEN` (secret): an account token with Account Analytics Read and Queues Read.
- `SLACK_WEBHOOK_URL` (secret): the private staff channel's incoming webhook.

No write switch: it writes nothing to Monday. The sandbox environment has no crons and never
posts to Slack. Run it by hand to see what it would say.

```sh
npm test
npm run typecheck
npm run deploy
```
