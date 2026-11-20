# Troubleshooting

Start from what you can see: an alert, a staff report, a donor email. Each entry below gives the
**symptom**, its **likely cause**, what to **check**, the **fix**, and where to read more.
Problems that belong to one Worker are also listed in that Worker's chapter under "Failure
modes".

## First response, for any problem

Who to contact first in an outage (named in the private appendix): the Cloudflare Super
Administrator for platform problems, the Monday account admin for consent, board and permission
problems, and the vendor's admin for anything on their side.

1. **Is it still happening?** Watch it live: `npx wrangler tail svbc-<worker>`. In the dashboard,
   look at the Worker's **Observability** (logs) and **Issues**.
2. **Stop the damage if data is being written wrong:**
   `node scripts/flags.mjs <worker> writes hold --env production`. A hold loses nothing: queues
   pause and crons skip until you turn it back `on`.
3. **Check the shared dependencies before the Worker:**
   - **The broker.** `curl https://svbc-monday-auth.svbc-account.workers.dev/health` should show
     every app `ok`.
   - **Monday itself.** Check `status.monday.com`.
   - **Cloudflare.** Check `cloudflarestatus.com`.
4. **Check what changed recently:**
   - a deploy (`npx wrangler deployments list --name svbc-<worker>`);
   - a merged pull request;
   - a Monday board or column edit (the board's Activity log);
   - a write-switch change (`node scripts/flags.mjs status --env production`).
5. **Know which build is live** before reading code
   ([chapter 7](07-operations.md#which-version-is-live)).
6. **Fix, deploy, then release:** turn writes back `on` and re-drive any dead letters
   ([chapter 7](07-operations.md#queues-and-dead-letters)).

## Alerts in Slack

| Message | Likely cause | Check / fix | See |
|---|---|---|---|
| Workers Issues: a new issue on `svbc-<worker>` | The Worker threw, logged an error, or returned 5xx | Open the issue for the stack and logs. Fix the cause, deploy, resolve the issue. | Worker chapter |
| `sync-watchdog: cron:<worker>:<cron>: no run since …` | Cron removed by a deploy, schedule changed without updating the watchdog, or the Worker failing at startup | Dashboard → Worker → Settings → Trigger Events. Compare `wrangler.jsonc` crons with `sync-watchdog/config/svbc.json`. | [`sync-alerting.md`](../runbooks/sync-alerting.md) |
| `sync-watchdog: writes:<worker>: writes are X, expected Y` | Someone left a hold in place, or a key was deleted, which reads as `off` | `flags.mjs status`. Set it back, or update `expectedWrites` if the change is intended. | [Chapter 7](07-operations.md#the-write-switch) |
| `sync-watchdog: queue:<queue>: N messages waiting, oldest H h` | Consumer failing, Worker on hold, or Monday outage | Worker's Issues and logs; `npx wrangler queues info <queue>` | [Queues](07-operations.md#queues-and-dead-letters) |
| No Monday heartbeat from `sync-watchdog` | The watchdog is down, or its Slack webhook broke | `svbc-sync-watchdog` in the dashboard; its `SLACK_WEBHOOK_URL` | [`sync-watchdog`](workers/sync-watchdog.md) |
| `monday-auth`: "needs consent" | Integration user deactivated, app uninstalled, or token revoked | Re-consent: as the integration user in a private window, open `/oauth/start/<app>` on the broker and enter `START_KEY` | [`monday-auth`](workers/monday-auth.md) |
| `monday-auth`: "rejected the … app's client credentials" | Client secret rotated in the Developer Center but not in the Worker | `npx wrangler secret put <APP>_CLIENT_SECRET` in `monday-auth/` | [`monday-auth`](workers/monday-auth.md) |
| `monday-auth`: "token refresh keeps failing" | Monday auth outage or network | Wait. Consumers fail once the token expires (about 24 h). Check `status.monday.com`. | [`monday-auth`](workers/monday-auth.md) |
| `monday-backup`: partial or failed backup | Run hit a Monday error or limit, Drive permission changed, or key missing | Its run log in D1 and the Drive folder | [`monday-backup`](workers/monday-backup.md) |

## Data isn't arriving in Monday

| Symptom | Likely cause | Check | Fix |
|---|---|---|---|
| A Funraise gift isn't on Donations | Webhook not delivered, rejected (wrong `?secret=`), or the write is failing | Funraise's webhook log; `select * from events order by received_at desc limit 20` in the Worker's D1; Workers Issues | Fix the cause, then `redrive-failed.mjs` |
| Every new gift from one source stopped | Vendor webhook disabled after repeated failures, URL secret rotated on one side only, or SBFM blocking a custom-domain route | The vendor's webhook settings page; the WAF event log for challenges | Re-enable the webhook, align the secret, add the path to the SBFM skip rule |
| Writes fail with "column not found" or a value rejected | A staff member renamed or deleted a column, removed a status label, or changed a column type | The error in Workers Issues names the column. Compare the board with `config/svbc.json`. | Restore the label or column, or update config and deploy. Then re-drive. |
| Writes fail with `UserUnauthorizedException` | Board made private without subscribing SVBC Integration, or a deleted board | Board permissions in Monday | Subscribe the integration user, or update the config |
| Writes fail with 401 or 403 for every Worker | Broker consent lost | `/health` on the broker | Re-consent ([`monday-auth`](workers/monday-auth.md)) |
| Writes fail with 429 or `COMPLEXITY_BUDGET_EXHAUSTED` | Monday rate or complexity limit, often during a bulk operation | Workers Issues; whether a bulk edit, import or backup is running | Nothing. Queues back off and retry. If it persists, `hold` the less urgent Workers. |
| `DAILY_LIMIT_EXCEEDED` | Monday's daily API call limit for the plan | Monday: profile picture → Administration → Usage stats → API (account admins; needs the API usage add-on or Enterprise). The `platform_api` GraphQL object reports the same numbers | Retries wait until midnight. Reduce polling or bulk work. |
| Nothing at all is written, and logs say "skip" or "dry run" | Write switch `off` or `hold`, or the key is missing | `flags.mjs status` | `writes on` |
| A cron-polled sync silently missed a window | Switch was `off` during that window, so cursors advanced by design | `flags.mjs status`; the Worker's D1 cursor table | Backfill with the Worker's script, if it has one |

## Wrong data in Monday

| Symptom | Likely cause | Fix |
|---|---|---|
| A 🔒 column "reverted" after staff edited it | A Worker owns the column and recomputed it | Expected. Change the input (the gift, the affiliation), not the 🔒 column. |
| Rollups (Lifetime Giving, Last Gift, membership) are stale | `donation-rollups` webhooks missing or unsubscribed, or recompute backlog | `donation-rollups` chapter; re-run `setup-webhooks.mjs`; `redrive-pending.mjs` |
| Duplicate Donations items | Two webhook registrations for one source (for example, sandbox and production both registered at the vendor), or a replay without dedupe | Check the vendor's webhook list. Delete the extra items in Monday and remove the duplicate registration. |
| A person moved to People (Historical) unexpectedly | `people-reclassification`'s seven-year rule; activity not recorded where the rule looks | Its chapter. Staff can use **Promote to People** on the item. |
| Duplicate columns appeared with a bare title | A setup script compared titles without `bareTitle()` | Delete the duplicate. Fix the script to use `bareTitle` ([chapter 2](02-architecture.md#read-only-column-markers)). |
| Wrong board written (sandbox data in production or the reverse) | A config id copied between `svbc.json` and `sandbox.json` | `config/split.test.ts` should have caught it. Fix config and redeploy. |

## Donor- and staff-facing problems

| Symptom | Likely cause | Fix |
|---|---|---|
| Portal shows "temporarily unavailable" (503) | `member-portal` write switch not `on` | `flags.mjs member-portal writes on` |
| Portal login email never arrives | Email sending failed, address not on People, or rate limit | `member-portal` chapter; its logs (redacted); Cloudflare Email Routing activity |
| A staff digest email didn't arrive | `report-digests` under `hold` (no catch-up), schedule misconfigured, or recipient not a Monday user | `report-digests` chapter |
| Calendar subscribers see no new events | Eventbrite token, KV cache, or SBFM challenge on `.ics` | `svbc-calendars` chapter, Deploy step 7 |
| Staff map or nearby search asks for login, or 403 | Cloudflare Access policy or JWT audience mismatch | Zero Trust → Access → Applications; `access.aud` in config |
| Mailchimp tags or consent don't match Monday | `mailchimp-sync` inbound/outbound backlog or a dead letter | `mailchimp-sync` chapter; `redrive-dead-lettered.mjs` |

## Deploy and CI problems

| Symptom | Likely cause | Fix |
|---|---|---|
| `checks` fails on a `*-copies` step | You edited a copy instead of the canonical file, or forgot a copy | Edit the canonical file and copy it over every listed path ([chapter 2](02-architecture.md#copied-not-shared-modules)) |
| `checks` fails on `manual` | New Worker without a chapter, a heading misspelt, or a broken link | Run `node scripts/check-manual.mjs` locally and follow its messages |
| `ci-changed-workers` fails: directory not in roster | New Worker directory not in `.github/workers.json` | Add it ([chapter 9](09-extending.md)) |
| `npm run typecheck` fails on binding names | Stale `worker-configuration.d.ts` | `npm run typecheck` regenerates it. Never run bare `tsc`. |
| Deploy fails: service binding not found | `monday-auth` entrypoint not deployed in that environment | Deploy the broker first |
| Deploy fails: queue already has a consumer | Two Workers consuming one queue (portal and writer) | `member-portal/DEPLOY.md` order |
| After a deploy the Worker writes nothing | Write key missing, so it reads `off` | Set `writes on` (keys before first deploy) |
| A new environment block took over a production domain | `env.sandbox` without `routes: []` inherited the top-level routes | Add `routes: []`, redeploy the sandbox, then redeploy production to reclaim the domain |
| Workers Issues stopped for a Worker | Its `wrangler.jsonc` env block lacks `observability.issues.enabled` | Add it to every env block. Needs Wrangler 4.145 or later. |
| Tests fail locally with port-bind or `workerd` errors | A sandboxed shell blocks workerd from listening | Run tests in a normal terminal |

## Platform limits worth knowing

| Limit | Effect | Mitigation already in place |
|---|---|---|
| Worker CPU per invocation (`limits.cpu_ms`, 100 ms to 300,000 ms by Worker) | A kill can't be caught, and shows as `exceededCpu` | Each cap is sized to measured use (Appendix A). Raise one when dashboard CPU metrics approach it. |
| Queue consumer wall time (15 min per batch) | Long batches die mid-way | Outage breaker, small batches |
| Subrequests per invocation | Large fan-outs fail | Batching and checkpoints |
| Queue retention (14 days, set by `flags.mjs retention`) | Older messages expire unseen | DLQ consumers record dead letters in D1 |
| Monday complexity budget per minute, and daily call limit | 429s and budget errors | Shared transport backs off. Breaker stops a batch early. |
| D1 size and write volume | Very large recomputes are slow | Paid plan. Avoid per-gift full-history rewrites in new code. |
