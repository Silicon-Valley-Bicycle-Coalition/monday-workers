# CLAUDE.md

## Project overview

SVBC Events Widget — a Cloudflare Worker that proxies the Eventbrite API (keeping the private token server-side) plus a standalone HTML/CSS/JS widget for embedding on the SVBC Squarespace site. Edge-cached with a 15-minute TTL.

## Architecture

- `src/worker.ts` — Single-file Cloudflare Worker (TypeScript). Handles CORS, edge caching via `caches.default`, Eventbrite API proxying, and serves the widget HTML at `/widget`.
- `wrangler.toml` — Wrangler config with env vars (`EVENTBRITE_ORG_ID`, `CACHE_TTL`).
- `tsconfig.json` — TypeScript config targeting ESNext with `@cloudflare/workers-types`.

## Development commands

- `npm run dev` — Start local Worker at http://localhost:8787 (requires `.dev.vars` with `EVENTBRITE_TOKEN`)
- `npm run deploy` — Deploy Worker to Cloudflare
- `npm run tail` — Stream live Worker logs
- `npm run check` — Run TypeScript type-checking (`tsc --noEmit`)
- `npm test` — Run unit tests (Vitest + `@cloudflare/vitest-pool-workers`)

## Key details

- TypeScript with `@cloudflare/workers-types`. Wrangler handles transpilation — no separate build step.
- Tests use `@cloudflare/vitest-pool-workers` with `fetchMock` to intercept outbound Eventbrite calls. Tests live in `test/`.
- The `EVENTBRITE_TOKEN` secret is set via `npx wrangler secret put`, never stored in code.
- CORS allows `bikesiliconvalley.org` and `localhost` origins.
- The Worker serves GET on `/`, `/events` (JSON API), and `/widget` (embeddable HTML page); everything else returns 404.
- `/widget` accepts query params: `max`, `images`, `descriptions`.
