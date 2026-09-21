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
JSON API, calendar feeds, listing page all serving correctly), Workers Builds is connected —
pushes to `main` auto-deploy from here on — and the predecessor Workers are retired. The public
`/events` page's main widget now embeds this Worker for real, verified live. **Step 7 has two
loose ends** — a second, separate Code Block on that same page still runs the old third-party
embed (out of scope of what this README documents), and `committees.bikesiliconvalley.org` was
never checked for a similar swap. See step 7 for the detail.

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

### 4. Point Workers Builds at this subdirectory — done

Checked 2026-09-21: neither predecessor Worker actually had a Git repository connected — both
showed **Settings → Builds → Git repository: Connect** (disconnected), not pointed at an old
directory as this step used to assume. So this was a fresh connection, not a repoint. Connected
2026-09-21 via **svbc-calendars → Settings → Builds → Connect**: repository
`silicon-valley-bicycle-coalition/svbc-monday-workers`, production branch `main`, root directory
`/svbc-calendars`, build command left empty (no `build` script in `package.json` — Wrangler
transpiles on deploy, no separate build step), deploy command `npx wrangler deploy`, preview
builds enabled for non-production branches. The GitLab account was already authorized on this
Cloudflare account from a previous Worker's setup, so no fresh GitLab OAuth consent was needed
this time. Verified by reloading the Settings page after connecting — the Git repository and
build configuration both persisted server-side, not just in the dialog's local state.

Every `main` push now auto-deploys via Workers Builds; `npx wrangler deploy` by hand (as steps 5
and the fixes below used) is only needed for emergencies or first-time provisioning, per the root
README's Deploys section.

### 5. Deploy — done

```sh
npx wrangler deploy
```

Deploys to both custom domains configured in `wrangler.jsonc`: `events.bikesiliconvalley.org`
(widget + JSON events API) and `committees.bikesiliconvalley.org` (calendar feeds + staff
listing page). First deployed 2026-09-21; two follow-up fixes then landed the same day (a dropped
`time_filter` param Eventbrite no longer accepts, and a dead organizer id removed from
`config/eventbriteOrganizers.json` — see git log for both).

### 6. Verify, then retire the old Workers — done

Cloudflare custom domains are exclusive to one Worker, so step 5's deploy claims both
`events.bikesiliconvalley.org` and `committees.bikesiliconvalley.org` for this Worker (as of
2026-09-21 neither domain had a live target to take them away from — see the note at the top of
this section). Verified 2026-09-21: widget, JSON API, calendar feeds, and the listing page all
serve correctly.

`svbc-events-widgets` and `svbc-committee-calendars` were deleted 2026-09-21, along with
`committee-calendars`'s D1 database (48 cached events, 7 source-status rows — purely a
last-known-good ICS cache, re-derivable from the live Legistar/CivicPlus/Caltrain/Eventbrite
sources, same role this Worker's `CALENDAR_KV` now plays; exported to a local `.sql` backup before
deletion regardless). Confirmed gone via `wrangler d1 list` and the Workers & Pages dashboard;
re-confirmed `events.bikesiliconvalley.org`/`committees.bikesiliconvalley.org` still serve 200s
on `svbc-calendars` afterward.

### 7. Actually embed the widget on the live site — partly done

Deploying this Worker does **not** put its content in front of any real visitor by itself; that
only happens once something on the public site points at it. Checked 2026-09-21, after steps 1–6
above were otherwise complete: `bikesiliconvalley.org/events` embedded **no reference to
`events.bikesiliconvalley.org` at all** — it loaded `https://dist.eventscalendar.co/embed.js`
instead, an unrelated third-party events-calendar service, in a Code Block under the "Upcoming
SVBC Classes & Rides" heading. The README's original assumption that a Squarespace iframe already
pointed at this Worker was wrong (or that step was never done).

**Done 2026-09-21:** that one Code Block's content was replaced in the Squarespace editor with
the exact iframe in "Widget embed snippet" below (`events.bikesiliconvalley.org/widget?organizer=21763925459`),
saved, and verified live — `bikesiliconvalley.org/events` now renders real events (checked the
page's actual `<iframe src>` after saving, not just the editor preview).

**Still open, scoped out deliberately:** the *same* `/events` page has a second, separate Code
Block further down, under "The Silicon Valley Bike Calendar" heading, that still runs its own
`eventscalendar.co` embed — a broader community calendar (BPAC committees + more), not the single
widget this README documents. Replacing it would need a URL this README doesn't define (possibly
`committees.bikesiliconvalley.org`'s listing content, in some embeddable form), so it was left
alone rather than guessed at. Separately, `committees.bikesiliconvalley.org` itself was never
checked for a similar third-party embed needing the same swap — that's still an open question, not
confirmed done or not-needed.

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
