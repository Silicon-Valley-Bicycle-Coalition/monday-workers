# SVBC Calendars

**Staff UAT script:** [`docs/uat/svbc-calendars.md`](../docs/uat/svbc-calendars.md) — what a non-technical tester can try in the sandbox and what they should see. Keep it in step with this README.

A single Cloudflare Worker that serves two things for the Silicon Valley Bicycle Coalition:
an embeddable Eventbrite events widget for the Squarespace site (`events.bikesiliconvalley.org`),
and nine subscribable ICS calendar feeds — SVBC's own Eventbrite Public Events and Volunteer
Opportunities, plus seven local Bicycle & Pedestrian Advisory Committee meetings across five
cities and two transit agencies (`committees.bikesiliconvalley.org`) — with a staff-facing
listing page of every subscribe link. One-click "Subscribe to calendar" replaces staff or members
manually checking a handful of different city, transit-agency, and Eventbrite pages.

## Architecture

```text
┌────────────────────────────────────┐
│  Squarespace (iframe)               │  events.bikesiliconvalley.org
│  Calendar apps / browsers           │  committees.bikesiliconvalley.org
└────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────┐      ┌──────────────────────────────┐
│    Cloudflare Worker      │─────▶│  Eventbrite API v3             │
│  (proxy + widget +        │      │  Legistar / CivicPlus /        │
│   calendar feeds)         │      │  Caltrain BATAC (per source)   │
└──────────────────────────┘      └──────────────────────────────┘
              │
       Cloudflare Cache (caches.default)
       CALENDAR_KV (last-known-good fallback)
```

**Why a proxy?** Eventbrite's public token can't list events by organization — it only works for individual event lookups. The private token is needed, so we keep it server-side in a Cloudflare Worker. The Cache API means most requests never hit Eventbrite at all.

## Per-source adapters

| Source | Platform | Feed id |
|---|---|---|
| Santa Clara, BART, San Jose, Cupertino | Legistar (Granicus) Web API | `santa-clara`, `bart`, `san-jose`, `cupertino` |
| Campbell, Saratoga (PEBTAC) | CivicPlus Agenda Center `iCalendar.aspx` | `campbell`, `saratoga` |
| Caltrain BATAC | `caltrain.com` BATAC page, embedded `data:text/calendar` links | `caltrain-batac` |
| SVBC Public Events, SVBC Volunteer Opportunities | Eventbrite Organizer Events API | `eventbrite-public-events`, `eventbrite-volunteer-opportunities` |

## How it works

Every route fetches live, per request — there's no daily rebuild. `/events` and `/widget` call
the Eventbrite API directly; `/calendars` and `/calendars/*.ics` dispatch to the matching source's
adapter (see the table above). Every route is wrapped in a Cloudflare edge cache
(`caches.default`): 900s (15 min) for `/events` and `/widget`, 86400s (24h) for `/calendars` and
`/calendars/*.ics` — nothing on the committee-meeting side needs to be real-time. If a source's
live fetch fails, its calendar route falls back to the last-known-good `.ics` stored in
`CALENDAR_KV` instead of erroring; a daily cron proactively warms every source into KV so that
fallback stays fresh even for sources nobody has requested recently. `/status.json` reports each
source's live consecutive-failure count and last success time, for at-a-glance health.

## Setup

### Prerequisites

- Node.js 18+
- A Cloudflare account (free tier is fine — 100K requests/day)
- An Eventbrite API key ([Account Settings → Developer Links → API Keys](https://www.eventbrite.com/account-settings/apps))

### 1. Clone and install

```sh
git clone <this-repo>
cd svbc-calendars
npm install
```

### 2. Authenticate with Cloudflare

```sh
npx wrangler login
```

### 3. Set the Eventbrite token as a secret

```sh
npx wrangler secret put EVENTBRITE_TOKEN
```

Paste the **Private token** from Eventbrite when prompted. This is stored encrypted in Cloudflare — it never appears in code or logs.

### 4. Set the Slack webhook as a secret

```sh
npx wrangler secret put SLACK_WEBHOOK_URL
```

Paste a Slack incoming-webhook URL. Used to alert when a calendar source's failure streak first reaches 3.

## Deploy

**Deployed and live** on both custom domains (checked 2026-09-30: both secrets set, both domains
attached to `svbc-calendars`, and the two predecessor Workers deleted). It has a Workers Builds
connection, so every merge to `main` redeploys it — see the root `README.md`'s Deploys section.
The one step still open is 2 (`CF_WEB_ANALYTICS_TOKEN` is still empty). The feeds also depend on
a WAF rule that lives outside this repo — see step 7. The checklist below is the cutover as it
was done, kept for forks and for a rebuild from scratch:

### 1. ~~Provision the KV namespace~~ Done 2026-09-23

`CALENDAR_KV` is provisioned (id in `wrangler.jsonc`). A `sandbox-CALENDAR_KV` namespace also
exists in the account but isn't wired into this config — this Worker has no `env.sandbox` split
(unlike `mailchimp-sync`/`donation-rollups`/etc.); add one later if that's wanted.

### 2. Enable Cloudflare Web Analytics (still open)

In the Cloudflare dashboard: **Analytics & Logs → Web Analytics → Add a site**, for
`bikesiliconvalley.org` (or its relevant subdomains). Paste the resulting site token into
`wrangler.jsonc`'s `vars.CF_WEB_ANALYTICS_TOKEN`, replacing the empty string. If left empty, the
widget and listing page simply omit the beacon script rather than shipping a broken one — see the
comment above that var in `wrangler.jsonc`.

### 3. ~~Set the secrets~~ Done

```sh
npx wrangler secret put EVENTBRITE_TOKEN
npx wrangler secret put SLACK_WEBHOOK_URL
```

See "Setup" above for where each value comes from.

### 4. ~~Point Workers Builds at this subdirectory~~ Done

In the Cloudflare dashboard, this Worker's connected [Workers
Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) root directory is
`/svbc-calendars` (it previously pointed at one of the two predecessor directories,
`/committee-calendars` or `/events-widgets`), so pushes to `main` auto-deploy the right directory
instead of a now-deleted one.

### 5. ~~Deploy~~ Done

```sh
npx wrangler deploy
```

Deploys to both custom domains configured in `wrangler.jsonc`: `events.bikesiliconvalley.org`
(widget + JSON events API) and `committees.bikesiliconvalley.org` (calendar feeds + staff
listing page).

### 6. ~~Verify, then retire the old Workers~~ Done

Cloudflare custom domains are exclusive to one Worker, so step 5's deploy reassigned both
`events.bikesiliconvalley.org` and `committees.bikesiliconvalley.org` away from their previous
Workers (`svbc-events-widgets`, `svbc-committee-calendars`) to this one. Both old Worker scripts
have since been deleted. On a rebuild, verify both domains serve correctly — widget, JSON API,
calendar feeds, listing page — **before** deleting whatever they replace.

### 7. ~~Exempt the feeds from Super Bot Fight Mode~~ Done 2026-10-02

The `bikesiliconvalley.org` zone runs Super Bot Fight Mode with both "definitely automated" and
"likely automated" traffic set to Managed Challenge. Calendar apps fetch feeds with non-browser
clients that can't solve a challenge, so without an exception a feed request gets a `403` "Just a
moment..." page (`cf-mitigated: challenge`) instead of a calendar, and the subscription silently
fails. That is what every route here returned to plain `curl` from 2026-09-25, when the mode was
turned on, until this rule went in.

A WAF custom rule on the zone (**Security → Security rules**, "Skip SBFM for feeds, calendar
Worker routes and the portal webhook") skips Super Bot Fight Mode for this Worker's routes. It is
one rule shared with the Squarespace RSS/iCal feeds and `member-portal`'s Monday webhook
(widened 2026-10-06 from an ICS-only rule); the clause for this Worker is:

```text
(http.host in {"events.bikesiliconvalley.org" "committees.bikesiliconvalley.org"}
 and (http.request.uri.path in {"/calendars" "/events" "/widget" "/status.json"}
      or (starts_with(http.request.uri.path, "/calendars/")
          and ends_with(http.request.uri.path, ".ics"))))
```

Action: **Skip → All Super Bot Fight Mode rules** (API: `action_parameters.phases:
["http_request_sbfm"]`). Every route stays behind the edge cache and the per-IP rate limit.
Only `/` and unknown paths are still challenged, so a script hitting the bare host gets the
challenge page — don't read that `403` as the Worker being down.

The rule lives only in the Cloudflare zone, not in `wrangler.jsonc` — a deploy neither creates nor
checks it, and a fork on a zone with bot protection needs its own. To check it's still in place:

```sh
curl -sI https://committees.bikesiliconvalley.org/calendars/san-jose.ics
```

Expect `200` with `content-type: text/calendar` and no `cf-mitigated` header. A `403` with
`cf-mitigated: challenge` means the rule is gone or no longer matches. Forks on a Free-plan zone
can't do this: Bot Fight Mode can't be skipped per host, only turned off.

## Widget embed snippet

In Squarespace, edit the events page → add a **Code Block** → paste an iframe pointing at the Worker:

```html
<iframe
  id="svbc-events"
  src="https://events.bikesiliconvalley.org/widget?organizer=21763925459"
  style="width:100%;border:none;min-height:800px;overflow:hidden"
  loading="lazy"
  title="SVBC Upcoming Events"
></iframe>
<script>
window.addEventListener("message", function(e) {
  if (e.data && e.data.svbcEventsHeight) {
    document.getElementById("svbc-events").style.height = e.data.svbcEventsHeight + "px";
  }
});
</script>
```

The widget posts its content height to the parent page via `postMessage`, and the listener script resizes the iframe to fit. This eliminates scrollbars and blank space.

## Commands

```sh
npm install
npm test           # vitest run
npm run dev         # wrangler dev — local Worker at http://localhost:8787
                     # no separate build step — Wrangler transpiles on deploy
npm run typecheck   # wrangler types && tsc --noEmit
npm run deploy      # wrangler deploy
npm run tail        # wrangler tail — stream live Worker logs
```
