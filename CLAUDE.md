# CLAUDE.md

## Project overview

SVBC Events Widget — a Cloudflare Worker that proxies the Eventbrite API (keeping the private token server-side) plus a standalone HTML/CSS/JS widget for embedding on the SVBC Squarespace site. Edge-cached with a 15-minute TTL.

## Architecture

- `src/worker.js` — Single-file Cloudflare Worker (vanilla JS, no framework). Handles CORS, edge caching via `caches.default`, and Eventbrite API proxying.
- `squarespace-widget.html` — Self-contained HTML/CSS/JS snippet pasted into a Squarespace Code Block. Fetches from the Worker and renders event cards.
- `wrangler.toml` — Wrangler config with env vars (`EVENTBRITE_ORG_ID`, `CACHE_TTL`).

## Development commands

- `npm run dev` — Start local Worker at http://localhost:8787 (requires `.dev.vars` with `EVENTBRITE_TOKEN`)
- `npm run deploy` — Deploy Worker to Cloudflare
- `npm run tail` — Stream live Worker logs

## Key details

- No build step, no bundler — plain JS throughout.
- No test framework is configured.
- The `EVENTBRITE_TOKEN` secret is set via `npx wrangler secret put`, never stored in code.
- CORS allows `bikesiliconvalley.org` and `localhost` origins.
- The Worker only serves GET on `/` and `/events`; everything else returns 404.
