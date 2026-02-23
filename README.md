# SVBC Events Widget

Displays upcoming Silicon Valley Bicycle Coalition events from Eventbrite on the SVBC Squarespace website. Replaces the paid [eventscalendar.co](https://eventscalendar.co) service.

## Architecture

```
┌──────────────┐      ┌─────────────────────┐      ┌───────────────┐
│  Squarespace │─────▶│  Cloudflare Worker   │─────▶│ Eventbrite    │
│  (widget JS) │      │  (edge-cached proxy) │      │ API v3        │
└──────────────┘      └─────────────────────┘      └───────────────┘
                              │
                       Cloudflare Cache
                       (serves HIT for 15 min)
```

**Why a proxy?** Eventbrite's public token can't list events by organization — it only works for individual event lookups. The private token is needed, so we keep it server-side in a Cloudflare Worker. The Cache API means most requests never hit Eventbrite at all.

## Files

```
src/worker.ts              Cloudflare Worker (API proxy + cache, TypeScript)
squarespace-widget.html    HTML/CSS/JS to paste into a Squarespace Code Block
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

1. Open `squarespace-widget.html`
2. Update `WORKER_URL` on line 24 to your Worker URL (ending in `/events`)
3. In Squarespace, edit the events page → add a **Code Block** → paste the contents
4. Save and publish

## Configuration

### Worker (`wrangler.toml`)

| Variable | Default | Description |
|---|---|---|
| `EVENTBRITE_ORG_ID` | `9974694499` | SVBC's Eventbrite organization ID |
| `CACHE_TTL` | `900` | Edge cache lifetime in seconds (15 min) |

### Widget (`squarespace-widget.html`)

| Variable | Default | Description |
|---|---|---|
| `WORKER_URL` | — | Your deployed Worker URL |
| `SHOW_IMAGE` | `true` | Display event images |
| `SHOW_DESCRIPTION` | `true` | Display event summary text |
| `MAX_EVENTS` | `20` | Number of events to display |

## Local development

```sh
cp .dev.vars.example .dev.vars
# Edit .dev.vars with the real Eventbrite token
npm run dev
```

The Worker runs at `http://localhost:8787`. Open `squarespace-widget.html` in a browser (temporarily point `WORKER_URL` to localhost) to test the full flow.

## How the cache works

1. Browser requests `/events` from the Worker
2. Worker checks Cloudflare's edge cache for a matching response
3. **HIT** → response served instantly from the edge, no Eventbrite API call
4. **MISS** → Worker fetches from Eventbrite, serves the response, and writes it to cache in the background
5. Cache expires after `CACHE_TTL` seconds, next request triggers a fresh fetch

The `X-Cache` response header shows `HIT` or `MISS` for debugging.

## Eventbrite credentials

| Credential | Where it's used | Sensitive? |
|---|---|---|
| API key (`KEV3IXL...`) | Not used | — |
| Private token (`GQNO2O...`) | Worker secret | **Yes** — stored encrypted in Cloudflare, never in code |
| Public token (`MRZOTJ...`) | Not used (can't list org events) | No |
| Organization ID (`9974694499`) | `wrangler.toml` | No |

## Cost

$0. Cloudflare Workers free tier includes 100,000 requests/day. With 15-minute caching, even heavy traffic will only generate a handful of Eventbrite API calls per day.
