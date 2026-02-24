# SVBC Events Widget

Displays upcoming Silicon Valley Bicycle Coalition events from Eventbrite on the SVBC Squarespace website.

## Architecture

```text
┌──────────────┐      ┌─────────────────────┐      ┌───────────────┐
│  Squarespace │─────▶│  Cloudflare Worker   │─────▶│ Eventbrite    │
│  (iframe)    │      │  (proxy + widget)    │      │ API v3        │
└──────────────┘      └─────────────────────┘      └───────────────┘
                              │
                       Cloudflare Cache
                       (serves HIT for 15 min)
```

**Why a proxy?** Eventbrite's public token can't list events by organization — it only works for individual event lookups. The private token is needed, so we keep it server-side in a Cloudflare Worker. The Cache API means most requests never hit Eventbrite at all.

## Files

```text
src/worker.ts              Cloudflare Worker (API proxy + widget + cache)
wrangler.toml              Wrangler deployment config
tsconfig.json              TypeScript configuration
.dev.vars.example          Template for local secrets
```

## Setup

### Prerequisites

- Node.js 18+
- A Cloudflare account (free tier is fine — 100K requests/day)
- An Eventbrite API key ([Account Settings → Developer Links → API Keys](https://www.eventbrite.com/account-settings/apps))

### 1. Clone and install

```sh
git clone <this-repo>
cd svbc-events-widget
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

### 4. Deploy

```sh
npx wrangler deploy
```

Note the URL it prints, e.g. `https://svbc-events.<subdomain>.workers.dev`

### 5. Test

```sh
curl https://svbc-events.<subdomain>.workers.dev/events
```

You should see JSON with upcoming events. Run it again and check the `X-Cache` header — the second request should show `HIT`.

### 6. Add the widget to Squarespace

1. In Squarespace, edit the events page → add a **Code Block**
2. Paste an iframe pointing at your Worker:

```html
<iframe
  src="https://svbc-events.<subdomain>.workers.dev/widget"
  style="width:100%;border:none;min-height:800px"
  loading="lazy"
  title="SVBC Upcoming Events"
></iframe>
```

3. Save and publish

## Configuration

### Worker (`wrangler.toml`)

| Variable | Default | Description |
|---|---|---|
| `EVENTBRITE_ORG_ID` | `9974694499` | SVBC's Eventbrite organization ID |
| `CACHE_TTL` | `900` | Edge cache lifetime in seconds (15 min) |

### Widget (`/widget` query params)

| Param | Default | Description |
|---|---|---|
| `max` | `20` | Number of events to display (max 50) |
| `images` | `true` | Set to `false` to hide event images |
| `descriptions` | `true` | Set to `false` to hide event summaries |
| `organizer` | _(all)_ | Filter to a specific Eventbrite organizer profile |

Example: `/widget?max=10&images=false`

### Organizer IDs

Use the `organizer` query param to show events from a specific organizer profile:

| Organizer ID | Name | Example |
| --- | --- | --- |
| `21763925459` | Silicon Valley Bicycle Coalition (main) | `/widget?organizer=21763925459` |
| `17135810858` | Silicon Valley Bicycle Coalition (volunteering) | `/widget?organizer=17135810858` |

Without the `organizer` param, events from all organizers are shown.

## Local development

```sh
cp .dev.vars.example .dev.vars
# Edit .dev.vars with the real Eventbrite token
npm run dev
```

The Worker runs at `http://localhost:8787`. Visit `http://localhost:8787/widget` to preview the widget, or `http://localhost:8787/events` for the JSON API.

## How the cache works

1. Browser requests `/events` from the Worker
2. Worker checks Cloudflare's edge cache for a matching response
3. **HIT** → response served instantly from the edge, no Eventbrite API call
4. **MISS** → Worker fetches from Eventbrite, serves the response, and writes it to cache in the background
5. Cache expires after `CACHE_TTL` seconds, next request triggers a fresh fetch

The `X-Cache` response header shows `HIT` or `MISS` for debugging.

## Eventbrite credentials

| Credential | Where it's used | Sensitive? |
| --- | --- | --- |
| API key (`KEV3IXL...`) | Not used | — |
| Private token (`GQNO2O...`) | Worker secret | **Yes** — stored encrypted in Cloudflare, never in code |
| Public token (`MRZOTJ...`) | Not used (can't list org events) | No |
| Organization ID (`9974694499`) | `wrangler.toml` | No |

## Cost

$0. Cloudflare Workers free tier includes 100,000 requests/day. With 15-minute caching, even heavy traffic will only generate a handful of Eventbrite API calls per day.
