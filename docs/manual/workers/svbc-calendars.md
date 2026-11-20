# svbc-calendars

[Appendix A](../reference/svbc-calendars.md) lists this Worker's routes, crons, queues, storage and bindings.

Deployed as `svbc-calendars` on two custom domains, `events.bikesiliconvalley.org` and
`committees.bikesiliconvalley.org`, plus a staging copy, `svbc-calendars-sandbox`, on its
`*.workers.dev` URL. It has no Monday access at all. It is not part of the CRM migration and
predates it. It is the one Worker here with a Workers Builds connection, so **every merge to `main`
redeploys production**.

## What it does

It serves SVBC's public events widget, embedded in an iframe on the Squarespace site's events page,
and nine subscribable calendar (ICS) feeds: SVBC's Eventbrite Public Events and Volunteer
Opportunities, and seven local bicycle and pedestrian advisory committee meetings. A staff-facing
page lists every subscribe link. If it stops, the website's events widget goes blank and calendar
subscriptions stop updating. No CRM data is involved.

## Trigger and data flow

| Route | Host | Cache | What it does |
|---|---|---|---|
| `GET /widget` | events. | 15 min | Embeddable HTML widget; query params `max`, `images`, `descriptions`, `organizer` |
| `GET /` and `GET /events` | events. | 15 min | Upcoming Eventbrite events as JSON; `organizer` must be in the allowlist |
| `GET /calendars` | committees. | 24 h | Staff listing page of every subscribe link |
| `GET /calendars/<id>.ics` | committees. | 24 h | One source's ICS feed |
| `GET /status.json` | either | never | Per-source consecutive-failure count and last success time |
| `GET /fonts/<name>.woff2` | either | immutable | Self-hosted Manrope and Poppins for the widget |
| Cron `0 13 * * *` (production only) | — | — | Warms every source into `CALENDAR_KV` |

`OPTIONS` answers the CORS preflight; any other non-`GET` method is 405; unknown paths are 404.

Flow for a request:

1. The per-IP rate limiter (120 requests a minute) is checked on a cache miss.
2. The edge cache (`caches.default`) answers most requests. TTLs come from the `CACHE_TTL` (900 s)
   and `CALENDAR_CACHE_TTL` (86,400 s) vars; `CACHE_VERSION` is part of the cache key.
3. On a miss, the route fetches live. `/events` and `/widget` call Eventbrite
   (`/v3/organizations/{EVENTBRITE_ORG_ID}/events/`) with the private token. Calendar routes
   dispatch to the source's adapter:

   | Source | Platform | Feed ids |
   |---|---|---|
   | Santa Clara, BART, San Jose, Cupertino | Legistar Web API | `santa-clara`, `bart`, `san-jose`, `cupertino` |
   | Campbell, Saratoga | CivicPlus Agenda Center `iCalendar.aspx` | `campbell`, `saratoga` |
   | Caltrain BATAC | `caltrain.com` page, embedded calendar links | `caltrain-batac` |
   | SVBC events | Eventbrite Organizer Events API | `eventbrite-public-events`, `eventbrite-volunteer-opportunities` |

4. If a source's live fetch fails, the feed falls back to the last-known-good `.ics` in
   `CALENDAR_KV` instead of erroring. When a source's failure streak first reaches 3, a Slack alert
   is sent.
5. Per-route and per-source metrics go to Workers Analytics Engine (binding `CALENDAR_ANALYTICS`,
   dataset `svbc_calendars`).

Why a proxy: Eventbrite's public token can't list events by organization, so the private token has
to stay server-side.

## Monday boards and columns

None. This Worker doesn't read or write Monday. Its configuration is in `config/sources.json` (the
nine sources) and `config/eventbriteOrganizers.json` (Eventbrite organizer ids allowed in the
`organizer` query parameter).

## Secrets

| Name | Purpose | Issued by | Rotate |
|---|---|---|---|
| `EVENTBRITE_TOKEN` | Eventbrite private token for listing SVBC's public events | Eventbrite: Account Settings → Developer Links → API Keys → Private token | Create a new key, `npx wrangler secret put EVENTBRITE_TOKEN` (and `--env sandbox`), revoke the old key |
| `SLACK_WEBHOOK_URL` | Slack incoming webhook for source-failure alerts. Optional in the sandbox; alerts no-op without it | Slack workspace admin (incoming webhook app) | Create a new webhook, `npx wrangler secret put SLACK_WEBHOOK_URL`, delete the old one |

This token is separate from `eventbrite-sync`'s `EVENTBRITE_PRIVATE_TOKEN`. Which Eventbrite login
minted it, and which Slack channel the webhook posts to, are recorded in the private appendix.

`CF_WEB_ANALYTICS_TOKEN` is a var, deliberately empty, on the assumption (checked 2026-09-21) that
the zone's automatic Web Analytics injects the beacon. On 2026-11-19 the `/events` listing page
carried no beacon, so these pages are probably not measured. If page analytics are wanted, check
Analytics & Logs → Web Analytics: turn automatic setup back on, or create a site and put its token
in the var (not both, or the beacon loads twice).

## Write switch

No write switch. This Worker writes nothing anywhere except its own KV cache and an occasional Slack
alert. It isn't in `scripts/check-worker-flags.mjs`'s `IN_SCOPE` list.

## Failure modes

| Symptom | Cause | What to do |
|---|---|---|
| Calendar app stops updating; `curl` gets `403` with `cf-mitigated: challenge` | The zone's WAF rule that skips Super Bot Fight Mode for these routes is gone or no longer matches | Restore the rule (see below) |
| `403` challenge on `/` or an unknown path | Expected: only the listed routes are exempt | None |
| Slack alert: a source failed 3 times in a row | The city, transit agency or Eventbrite page changed or is down | Check `/status.json`; the feed serves the KV fallback meanwhile. Fix the adapter in `src/adapters/` if the source changed format |
| Feed shows stale meetings | Source failing for a while; KV fallback being served | Same as above |
| Widget empty or `/events` 502 | Eventbrite token revoked or Eventbrite down (error body is generic; detail is in `console.error`) | `npm run tail`, check the token |
| `/events` 400 with `organizer` | Organizer id not in `config/eventbriteOrganizers.json` | Add it and deploy |
| Sandbox deploy took the production domains | The sandbox env lost its explicit `"routes": []` and inherited production's custom domains | Keep `"routes": []` in `env.sandbox`; redeploy production |
| A bad merge is live on the public site | Workers Builds deploys every merge to `main` | Revert on `main`, or roll back in the Cloudflare dashboard |

**The WAF rule lives in the Cloudflare zone, not in this repo.** It is the custom rule "Skip SBFM for
feeds, calendar Worker routes and the portal webhook" under Security → Security rules, action Skip →
All Super Bot Fight Mode rules. Its clause for this Worker:

```text
(http.host in {"events.bikesiliconvalley.org" "committees.bikesiliconvalley.org"}
 and (http.request.uri.path in {"/calendars" "/events" "/widget" "/status.json"}
      or (starts_with(http.request.uri.path, "/calendars/")
          and ends_with(http.request.uri.path, ".ics"))))
```

To check it:

```sh
curl -sI https://committees.bikesiliconvalley.org/calendars/san-jose.ics
```

Expect `200`, `content-type: text/calendar`, and no `cf-mitigated` header. A new public route needs
adding to this rule. See [Troubleshooting](../08-troubleshooting.md).

## Operator scripts

No scripts. Useful commands, from `svbc-calendars/`:

```sh
npm run tail                                                       # live logs
curl -s https://committees.bikesiliconvalley.org/status.json       # source health
```

To force fresh content past the edge cache, bump `CACHE_VERSION` in `wrangler.jsonc` and deploy.

## Changing it

Key files:

- `src/index.ts`: router, CORS, `withCache`, the cron.
- `src/eventsApi.ts`, `src/widget.ts`: the JSON API and widget.
- `src/adapters/`: one file per source platform, dispatched by `src/adapters/dispatch.ts`.
- `src/calendarSource.ts`, `src/calendarStore.ts`: live fetch with KV fallback, failure counting,
  alert threshold.
- `src/ics.ts`, `src/listing.ts`, `src/metrics.ts`, `src/alert.ts`.
- `config/sources.json`: add a committee here (and an adapter if it's a new platform).
- `src/fontData.ts`: generated by `scripts/build-font-modules.mjs` at the repo root; don't edit by
  hand.

Gotchas:

- CORS is always `Access-Control-Allow-Origin: *`. Never reflect the request's `Origin`: cached
  responses carry no `Vary: Origin`.
- Public error bodies stay generic. Upstream detail goes only to `console.error`, KV and Slack.
- The sandbox is a plain staging tier, not the migration Workers' "inbound only" sandbox. Its
  `env.sandbox` must keep `"routes": []`.
- Don't link Google Fonts; fonts are self-hosted.
- `svbc-calendars/CLAUDE.md` has more working notes. `specs/worker.cs.md` describes an older
  single-file version.

Test and deploy from `svbc-calendars/`:

```sh
npm test
npm run typecheck
npx wrangler deploy --env sandbox    # staging, on workers.dev
```

Production deploys through Workers Builds when a PR merges to `main` (root directory
`/svbc-calendars`). `npm run deploy` deploys production by hand. Local `npm run dev` needs
`.dev.vars` with `EVENTBRITE_TOKEN` and `SLACK_WEBHOOK_URL`. See [CI and deploy](../06-ci-and-deploy.md).

## Further reading

- [svbc-calendars/README.md](../../../svbc-calendars/README.md): setup from scratch, the WAF rule,
  the widget embed snippet.
- [svbc-calendars/CLAUDE.md](../../../svbc-calendars/CLAUDE.md): architecture and route notes.
- [Staff UAT script](../../../docs/uat/svbc-calendars.md)
- Design history: [committee calendars](../../../docs/superpowers/specs/2026-08-22-committee-calendars-design.md),
  [merge of the calendar Workers](../../../docs/superpowers/specs/2026-08-27-events-bike-calendars-merge-design.md)
- Core chapters: [Architecture](../02-architecture.md), [Operations](../07-operations.md),
  [Troubleshooting](../08-troubleshooting.md)
