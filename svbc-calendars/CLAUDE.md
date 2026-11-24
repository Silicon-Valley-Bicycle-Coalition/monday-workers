# CLAUDE.md

## Project overview

SVBC Calendars — a Cloudflare Worker that proxies the Eventbrite API (keeping the private token
server-side) for an embeddable events widget, and serves nine subscribable ICS calendar feeds
(SVBC's own Eventbrite events plus seven local Bicycle & Pedestrian Advisory Committee meetings)
with a staff-facing listing page. Deployed on two custom domains:
`events.bikesiliconvalley.org` (widget + JSON events API) and `committees.bikesiliconvalley.org`
(calendar feeds + listing). Edge-cached via `caches.default` — 15 min for the events/widget
routes, 24h for the calendar routes — with a KV last-known-good fallback per source.

## Architecture

- `src/index.ts` — router: CORS, `withCache` (the shared cache-aside wrapper), dispatches every route.
- `src/eventsApi.ts` + `src/widget.ts` — the Eventbrite events JSON API and embeddable widget, unchanged behavior from the original events-widget.
- `src/adapters/*` — one file per source platform (Legistar, CivicPlus, Caltrain BATAC, Eventbrite), dispatched via `src/adapters/dispatch.ts`.
- `src/calendarSource.ts` + `src/calendarStore.ts` — live-fetch-or-KV-fallback orchestration, and the KV read/write layer, for calendar sources.
- `src/ics.ts` — ICS building.
- `src/listing.ts` — the staff-facing listing page of every subscribe link.
- `src/metrics.ts` — per-route, per-source metrics recorded to Workers Analytics Engine.
- `config/sources.json` — the 9 source definitions (id, adapter, platform-specific config).
- `config/eventbriteOrganizers.json` — the Eventbrite organizer ids allowed via the `organizer` query param (`src/eventsApi.ts`'s `ALLOWED_ORGANIZERS`, derived at module load, not hardcoded).

## Development commands

- `npm run dev` — Start local Worker at http://localhost:8787 (requires `.dev.vars` with `EVENTBRITE_TOKEN` and `SLACK_WEBHOOK_URL` — copy `.dev.vars.example`)
- `npm run deploy` — Deploy Worker to Cloudflare
- `npm run tail` — Stream live Worker logs
- `npm run typecheck` — Regenerate Worker types and run `tsc --noEmit`
- `npm test` — Run unit tests (Vitest + `@cloudflare/vitest-plugin`)

## Key details

- TypeScript with `@cloudflare/workers-types`. Wrangler handles transpilation — no separate build step.
- Tests use `@cloudflare/vitest-plugin` with `fetchMock` to intercept outbound calls. Tests live alongside their source files (`*.test.ts`) and in `test/`.
- `EVENTBRITE_TOKEN` and `SLACK_WEBHOOK_URL` are secrets, set via `npx wrangler secret put`, never stored in code.
- CORS is `Access-Control-Allow-Origin: *` on every response — never reflect the request's `Origin`, since cached responses carry no `Vary: Origin` ([GL#72](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/72)).
- Public error bodies stay generic (`/events` 502s, `/status.json` omits `lastError`); upstream detail goes to `console.error`, KV and the Slack alert only.
- Full route list (from `src/index.ts`): `OPTIONS` → CORS preflight (204); any non-`GET` method → 405; `GET /widget` → embeddable HTML widget; `GET /` or `GET /events` → Eventbrite JSON API; `GET /calendars` → staff listing page; `GET /calendars/:id.ics` → one source's ICS feed; `GET /status.json` → live per-source health (never cached); `GET /fonts/:name.woff2` → the widget's self-hosted Nunito Sans (`src/fonts.ts`, served before the rate limiter, immutable); everything else → 404. A daily cron (`scheduled` handler) proactively warms every source into `CALENDAR_KV`.
- `/widget` accepts query params: `max`, `images`, `descriptions`.
