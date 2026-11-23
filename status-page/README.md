# status-page

**Status: built, not deployed.** Its Cloudflare Access applications exist (below); deploy
`sync-watchdog` first.

A staff-only page at `status.bikesiliconvalley.org` that answers "is it us, a vendor, or
Cloudflare?" when something seems broken. Three sections, in this order:

1. **SVBC syncs**: whether each of our own integrations is running, in plain language, from
   the snapshot [`sync-watchdog`](../sync-watchdog/README.md) writes after each hourly run.
2. **Cloudflare**: the platform status of the Cloudflare products our Workers use, from
   cloudflarestatus.com.
3. **Services we use**: each SaaS vendor's live status where it publishes a machine-readable
   feed, and always a link to its official status page.

A banner at the top says "All systems normal" or lists what needs attention: a sync that isn't
running, is paused or is backed up; a watchdog that has stopped reporting; a Cloudflare product or
vendor in an outage. Degraded, maintenance and "Couldn't check" show on their rows only, but the
banner never says "All systems normal" over unchecked rows: it says "Nothing needs attention · N
couldn't be checked" instead.

Design: [`docs/superpowers/specs/2026-11-20-status-page-design.md`](../docs/superpowers/specs/2026-11-20-status-page-design.md).

## Data flow

```
browser (behind Access) ─▶ Worker ─┬─▶ KV WATCHDOG_STATE  `snapshot:latest`  (sync-watchdog writes it)
                                   ├─▶ cloudflarestatus.com /api/v2/summary.json
                                   └─▶ each vendor's feed (Statuspage, Slack, Google)
```

On each page load every source is read in parallel. Each feed fetch gives up after
`feedTimeoutMs` (3 s) and is cached at the edge for `feedCacheSeconds` (60 s). Nothing can fail
the page: a timeout, an error status, a body that isn't JSON (`status.eventbrite.com` answers 200
with an unrelated web page), or a snapshot older than `snapshotMaxAgeHours` (2 h) shows that row
as **Couldn't check**, never as healthy. The page has no script and reloads itself every
2 minutes.

**No secrets, no Monday access, no write switch.** It writes nothing anywhere, and its only
binding beyond the rate limiter is read access to `sync-watchdog`'s KV namespace.

## Config (`config/svbc.json`, `config/sandbox.json`)

| Field | Meaning |
|---|---|
| `access.teamDomain`, `access.aud`, `access.allowedEmailDomain` | Cloudflare Access values for the JWT check. An empty `aud` refuses every request. |
| `timezone` | Times on the page (`America/Los_Angeles`). |
| `feedTimeoutMs`, `feedCacheSeconds`, `snapshotMaxAgeHours` | See Data flow. |
| `syncs[]` | `{ label, description, worker, queues }`: one row per Worker `sync-watchdog` watches. `worker` is the watchdog's name (the Worker's directory); `queues` are the watchdog queues that belong to it. |
| `hiddenWorkers` | Watched Workers deliberately not shown, with the reason (`monday-auth`: its failure shows as the syncs that depend on it). |
| `cloudflare.components` | Component names exactly as cloudflarestatus.com lists them. A name the feed doesn't list shows as Couldn't check. |
| `vendors[]` | `{ name, usedFor, statusPageUrl, linkLabel?, feed }`. See Adding a vendor. |

`config/coverage.test.ts` fails CI when the `syncs` list drifts from `sync-watchdog/config/*.json`:
every watched Worker must be shown or hidden, and every watched queue must belong to exactly one
shown sync. When a Worker goes live in the watchdog, give it a row here.

A row's state is the worst of its watchdog subjects: a missed cron → **Not running** (with
"last ran 4 hours ago"), a stuck queue → **Backed up**, a write switch other than expected →
**Paused** (or **Write switch changed** when writes are on but the watchdog expected them off, as
for `contact-roles`); a failed check or missing subject → **Couldn't check**. The watchdog's own detail
line sits behind "Why".

## Adding a vendor

`feed.kind` is one of:

- `statuspage`: an Atlassian Statuspage (most vendors). `url` is the page's base URL;
  `/api/v2/summary.json` is appended. Check it answers JSON first:
  `curl -s https://status.example.com/api/v2/summary.json | head -c 200`.
- `slack`: `https://slack-status.com/api/v2.0.0/current`.
- `google`: `https://www.google.com/appsstatus/dashboard/incidents.json`, plus `products`
  (the `affected_products[].title` values SVBC uses).
- `none`: link only. Set `statusPageUrl` to the vendor's status page, or `null` when there is none
  ("No public status page"). If the link isn't a status page, set `linkLabel` too (Eventbrite:
  `"Help center"`).

## Cloudflare Access

Two self-hosted Access applications, created 2026-11-23, both in the existing Zero Trust organization
(`https://bikesiliconvalley.cloudflareaccess.com`, shared with `member-map`):

| Application | Hostname | AUD (in config) |
|---|---|---|
| SVBC Status Page | `status.bikesiliconvalley.org` | `config/svbc.json` |
| SVBC Status Page (sandbox) | `status.sandbox.bikesiliconvalley.org` | `config/sandbox.json` |

Each uses the reusable **SVBC Staff** policy (allow emails ending in `@bikesiliconvalley.org`),
Google Workspace as the only identity provider with automatic redirect, and 24-hour sessions, like
`lanes.` and `map.sandbox.`. Forks: create your own and replace `access.teamDomain` and `access.aud`.

An empty `aud` refuses every request. `workers_dev` and `preview_urls` are `false` in both
environments, so the custom domain is the only way in, and the Worker checks the Access JWT itself
on every route, its stylesheet and fonts included.

## Deploy

Deploy `sync-watchdog` first (it writes `snapshot:latest`), or the syncs section says the
watchdog hasn't reported until its next hourly run.

```sh
npm test
npm run typecheck
npm run deploy:sandbox   # then check status.sandbox.bikesiliconvalley.org through Access
npm run deploy
```

The sandbox page shows the watchdog as not reporting most of the time, which is expected:
the sandbox watchdog has no crons, so its snapshot only updates when someone runs it by hand.

## Local development

```sh
echo 'ACCESS_DEV_BYPASS=1' > .dev.vars     # git-ignored
npm run dev                                 # http://localhost:8787/
npx wrangler kv key put --local --binding WATCHDOG_STATE snapshot:latest '{"runAt":"…","subjects":[]}'
```

`ACCESS_DEV_BYPASS=1` skips the Access check **only for requests whose URL host is localhost**.
Local KV starts empty, so the syncs section says the watchdog hasn't reported until you seed a
snapshot. The vendor and Cloudflare feeds are live.

Fonts: `src/fontData.ts` is generated by `node scripts/build-font-modules.mjs`; never link Google
Fonts.
