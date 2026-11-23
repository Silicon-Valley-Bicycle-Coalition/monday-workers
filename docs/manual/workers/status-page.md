# status-page

[Appendix A](../reference/status-page.md) lists this Worker's routes, crons, queues, storage and bindings.

`status-page` runs as the Cloudflare Worker `svbc-status-page` on `status.bikesiliconvalley.org` (sandbox: `svbc-status-page-sandbox` on `status.sandbox.bikesiliconvalley.org`). Both hostnames sit behind Cloudflare Access applications ("SVBC Status Page" and "SVBC Status Page (sandbox)"). It has no Monday access, no secrets and no write switch; `workers.dev` and preview URLs are off.

## What it does

It is the staff page to open when something seems broken. It answers "is it us, a vendor, or Cloudflare?" in three sections:

1. **SVBC syncs**: each integration in plain language (Running, Not running, Paused, Write switch changed, Backed up, Couldn't check), from the snapshot `sync-watchdog` writes after each hourly run.
2. **Cloudflare**: the platform status of the products the Workers use (Workers, KV, D1, Queues, R2, Email Routing, Access, DNS, CDN, the San Jose data centre) and any incident touching them.
3. **Services we use**: each SaaS vendor's live status where it publishes a feed, and always a link to its official status page.

A banner at the top lists what needs attention: a sync that isn't running, is paused or backed up, a watchdog that has stopped reporting, or a Cloudflare product or vendor in an outage. If it stops, staff lose that page; nothing else depends on it, and alerting still comes from `sync-watchdog` and Workers Issues.

## Trigger and data flow

HTTP only, no crons and no queues.

| Route | What it serves |
|---|---|
| `GET /` | The page, built on each request. `Cache-Control: private, no-store`; strict CSP, no script. Reloads itself every 2 minutes. |
| `GET /styles.css` | The stylesheet, with self-hosted Nunito Sans `@font-face` rules |
| `GET /fonts/<name>.woff2` | The font file |

Every request is rate limited (60 per minute per client), then must carry a valid Access JWT whose email ends in `@bikesiliconvalley.org`; the Worker checks the JWT itself as well as relying on Access, on every route.

For `GET /`, in parallel:

1. Read `snapshot:latest` from `sync-watchdog`'s `STATE` KV namespace (bound read-only as `WATCHDOG_STATE`). Older than 2 hours, missing or unreadable: every sync row shows Couldn't check and the banner says the watchdog hasn't reported.
2. Fetch `https://www.cloudflarestatus.com/api/v2/summary.json` and keep the configured components.
3. Fetch each vendor's feed: Atlassian Statuspage `summary.json`, Slack's `current`, or Google Workspace's `incidents.json`.

Each fetch gives up after 3 seconds (headers and body) and is cached at the edge for 60 seconds. A timeout, an error status or a body that isn't the expected JSON shows that row as Couldn't check; nothing fails the page.

### Storage

None of its own. It reads one key from `sync-watchdog`'s KV namespace.

## Monday boards and columns

None. It never calls Monday.

What it shows is [`config/svbc.json`](../../../status-page/config/svbc.json) (production) and [`config/sandbox.json`](../../../status-page/config/sandbox.json):

| Key | Meaning |
|---|---|
| `access` | Access team domain, the application's AUD, and the allowed email domain |
| `syncs` | One row per Worker `sync-watchdog` watches: staff label, description, watchdog name, and the watched queues it owns |
| `hiddenWorkers` | Watched Workers deliberately not shown, with the reason (`monday-auth`) |
| `cloudflare.components` | Component names exactly as cloudflarestatus.com lists them |
| `vendors` | Name, what SVBC uses it for, status-page link, optional `linkLabel`, and the feed kind (`statuspage`, `slack`, `google`, `none`) |

`config/coverage.test.ts` fails CI when `syncs` drifts from `sync-watchdog/config/*.json`.

## Secrets

None. Bindings (not secrets): `WATCHDOG_STATE` (`sync-watchdog`'s `STATE` namespace in each environment) and `REQUEST_RATE_LIMITER`.

## Write switch

No write switch. It writes nothing anywhere.

## Failure modes

| Symptom | Cause | What to do |
|---|---|---|
| 403 for staff | The Access application's AUD isn't the one in config, or the person isn't signed in with an `@bikesiliconvalley.org` Google account | Compare `access.aud` with the application's overview page in Zero Trust |
| "The sync watchdog hasn't reported since …" | `sync-watchdog` has not run for over 2 hours, or it can't write its snapshot | Check `svbc-sync-watchdog` in the dashboard; its Monday heartbeat in Slack is the other signal |
| Every sync row Couldn't check on the sandbox page | Expected: the sandbox watchdog has no crons, so its snapshot is only as fresh as its last manual run | Nothing |
| One vendor always Couldn't check | Its feed URL moved or stopped answering JSON (`status.eventbrite.com` answers 200 with an unrelated page) | Check the URL with `curl`; change the vendor to `kind: "none"` or fix its URL |
| A Cloudflare component always Couldn't check | Cloudflare renamed or removed it | Match the name to the live `summary.json` and update `cloudflare.components` |
| CI fails in `config/coverage.test.ts` | A Worker was added to or removed from `sync-watchdog`'s config | Add a `syncs` row (or a `hiddenWorkers` reason) in the same PR |

## Operator scripts

None. To add a vendor, add it to `vendors` in both configs (check a Statuspage URL first with `curl -s <base>/api/v2/summary.json | head -c 200`). To seed a local snapshot for development, see the Worker README.

## Changing it

Key files: `src/index.ts` (routes and Access gate), `src/syncs.ts` (snapshot roll-up), `src/cloudflare.ts`, `src/vendors.ts` and `src/feeds/*` (feeds), `src/banner.ts` (what counts as attention), `src/render.ts` (page and CSS), `config/*.json`.

Gotchas:

- `src/syncs.ts` redeclares `sync-watchdog`'s `WatchdogSnapshot` shape; change both together.
- Never let an unchecked row read as healthy: every new feed parser returns `null` on a shape it doesn't recognise.
- Fonts come from `scripts/build-font-modules.mjs`; never link Google Fonts.

Tests: `npm test`, `npm run typecheck`. Deploy: `npm run deploy` (sandbox: `npm run deploy:sandbox`), after `sync-watchdog`. No D1 migrations.

## Further reading

- [`status-page/README.md`](../../../status-page/README.md).
- [Design spec](../../superpowers/specs/2026-11-20-status-page-design.md).
- [`sync-watchdog`](sync-watchdog.md), which writes the snapshot.
- [Troubleshooting](../08-troubleshooting.md).
