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

Deployed to production 2026-09-21: both custom domains are live and verified healthy (widget,
JSON API, calendar feeds, listing page all serving correctly). **Steps 4 and 7 are still open** —
Workers Builds isn't connected yet (routine `main` pushes still need a manual `wrangler deploy`
until then), and nothing on the public site actually embeds this Worker yet, so none of the
verified-healthy content in step 6 is in front of a real visitor. See those two steps for what's
still needed.

Cutover checklist, in order:

### 1. Provision the KV namespace — done

Provisioned 2026-09-21 (`wrangler.jsonc`'s `kv_namespaces[0].id` is the real id, not the old
`placeholder-replaced-in-task-16` value).

### 2. Enable Cloudflare Web Analytics — not needed, already covered

Checked 2026-09-21: `bikesiliconvalley.org` already has Web Analytics on **automatic setup**
(active 8 months). Per Cloudflare's own docs, automatic setup injects the beacon into every page
served through the proxied zone, **on all subdomains**, with no code changes — so once this Worker
is live on `events.bikesiliconvalley.org`/`committees.bikesiliconvalley.org`, its pages are already
covered. Manually setting `vars.CF_WEB_ANALYTICS_TOKEN` on top of that would add a second,
redundant beacon (a proxied site "can, but does not have to" also add one manually). Leave it
empty — that's not a placeholder, it's the correct final value here.

### 3. Set the secrets — done

```sh
npx wrangler secret put EVENTBRITE_TOKEN
npx wrangler secret put SLACK_WEBHOOK_URL
```

See "Setup" above for where each value comes from. Both were already in hand — checked 2026-09-21,
both secrets already existed on the two predecessor Workers (`svbc-events-widgets` had
`EVENTBRITE_TOKEN`, `svbc-committee-calendars` had `SLACK_WEBHOOK_URL`) — so neither needed to be
minted fresh, just re-entered here (Cloudflare secrets are write-only and per-Worker; there's no
way to copy one directly from another Worker).

### 4. Point Workers Builds at this subdirectory — still open

Checked 2026-09-21: neither predecessor Worker actually has a Git repository connected right now
— both show **Settings → Builds → Git repository: Connect** (disconnected), not pointed at an old
directory as this step used to assume. So this is a fresh connection to make, not a repoint:
in the Cloudflare dashboard, **svbc-calendars → Settings → Builds → Connect**, authorize this
GitLab repo, and set the build's root directory to `/svbc-calendars`. This needs an interactive
GitLab authorization step, so it isn't something to script or do unattended. Until this is done,
merges to `main` don't auto-deploy — use `npx wrangler deploy` by hand, as steps 5 and the fixes
below did.

### 5. Deploy — done

```sh
npx wrangler deploy
```

Deploys to both custom domains configured in `wrangler.jsonc`: `events.bikesiliconvalley.org`
(widget + JSON events API) and `committees.bikesiliconvalley.org` (calendar feeds + staff
listing page). First deployed 2026-09-21; two follow-up fixes then landed the same day (a dropped
`time_filter` param Eventbrite no longer accepts, and a dead organizer id removed from
`config/eventbriteOrganizers.json` — see git log for both).

### 6. Verify, then retire the old Workers — Worker verified; old-Worker retirement still open

Cloudflare custom domains are exclusive to one Worker, so step 5's deploy claims both
`events.bikesiliconvalley.org` and `committees.bikesiliconvalley.org` for this Worker (as of
2026-09-21 neither domain had a live target to take them away from — see the note at the top of
this section). Verified 2026-09-21: widget, JSON API, calendar feeds, and the listing page all
serve correctly. The old Workers' scripts (and `committee-calendars`'s D1 database) have **not**
been deleted yet — that's a deliberate, separate, destructive step for whoever's doing the
cutover to trigger explicitly, not something to do as a side effect of verification.

### 7. Actually embed the widget on the live site — still open

Deploying this Worker does **not** put its content in front of any real visitor by itself; that
only happens once something on the public site points at it. Checked 2026-09-21, after steps 1–6
above were otherwise complete: `bikesiliconvalley.org/events` embeds **no reference to
`events.bikesiliconvalley.org` at all** — it loads `https://dist.eventscalendar.co/embed.js`
instead, an unrelated third-party events-calendar service. The README's original assumption that
a Squarespace iframe already pointed at this Worker was wrong (or that step was never done); the
"Widget embed snippet" section below has never actually been pasted into the live site.

This means every verification in step 6 only proves the Worker itself is healthy — it says
nothing about what real visitors see, since they're not being served by it yet. Until someone
edits the Squarespace `/events` page (swap the `eventscalendar.co` embed for the iframe in "Widget
embed snippet" below) and the `/committees` page similarly, this migration isn't actually
user-facing, no matter how correct the Worker is. That's a Squarespace content edit, not something
in this repo.

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
