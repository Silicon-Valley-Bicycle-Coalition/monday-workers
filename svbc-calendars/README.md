# SVBC Calendars

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

```sh
npx wrangler deploy
```

Deploys to both custom domains configured in `wrangler.jsonc`: `events.bikesiliconvalley.org`
(widget + JSON events API) and `committees.bikesiliconvalley.org` (calendar feeds + staff
listing page).

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
