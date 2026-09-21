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
- `npm test` — Run unit tests (Vitest + `@cloudflare/vitest-pool-workers`)

## Key details

- TypeScript with `@cloudflare/workers-types`. Wrangler handles transpilation — no separate build step.
- Tests use `@cloudflare/vitest-pool-workers` with `fetchMock` to intercept outbound calls. Tests live alongside their source files (`*.test.ts`) and in `test/`.
- `EVENTBRITE_TOKEN` and `SLACK_WEBHOOK_URL` are secrets, set via `npx wrangler secret put`, never stored in code.
- CORS allows `bikesiliconvalley.org` and `localhost` origins.
- Full route list (from `src/index.ts`): `OPTIONS` → CORS preflight (204); any non-`GET` method → 405; `GET /widget` → embeddable HTML widget; `GET /` or `GET /events` → Eventbrite JSON API; `GET /calendars` → staff listing page; `GET /calendars/:id.ics` → one source's ICS feed; `GET /status.json` → live per-source health (never cached); everything else → 404. A daily cron (`scheduled` handler) proactively warms every source into `CALENDAR_KV`.
- `/widget` accepts query params: `max`, `images`, `descriptions`.

## Sandbox environment

`env.sandbox` (`wrangler deploy --env sandbox`, deploys `svbc-calendars-sandbox`) is a plain
staging tier — unrelated to the CRM-migration "sandbox" convention used by every other Worker in
this repo (no donor data here, not migration-related; see the root design doc). It has its own KV
namespace and Analytics Engine dataset and serves on its `workers.dev` URL, **not** the real
custom domains.

**Real incident, 2026-09-21 — confirmed non-outage:** the first deploy of `env.sandbox`, before it
had an explicit `"routes": []` override, silently inherited the top-level `routes` —
`events.bikesiliconvalley.org` and `committees.bikesiliconvalley.org` — and reassigned both real
custom domains to the untested sandbox Worker. `wrangler deploy` prints an explicit warning about
exactly this before it happens; it's easy to miss in a long build/deploy log. Fixed by adding the
`"routes": []` line (now in `wrangler.jsonc`, with a comment — never remove it) and manually
deleting both Custom Domain entries from `svbc-calendars-sandbox` in the Cloudflare dashboard
(**Workers & Pages → the Worker → Domains**), since clearing `routes` in config does not
retroactively delete an already-created Custom Domain resource — that's a separate, manual step
every time this mistake happens.

Verified afterward, directly against the zone: **neither domain had a live target before or after
this incident**, so it did not cause a real outage. `bikesiliconvalley.org`'s DNS records (search
in the dashboard's DNS tab) contain no record at all for `events` or `committees`; the legacy
`svbc-events-widgets` and `svbc-committee-calendars` Workers (the two this repo is meant to
replace) both show "No custom domains" on their own Domains tabs; and external resolution for both
hostnames fails outright (NXDOMAIN). The domain cutover described in the root README's Deploy
section is still a fully pending step, not a live reassignment this incident disturbed.

Before running `wrangler deploy --env sandbox` for this Worker again, read wrangler's own output
for a "reassign" warning and stop if one appears — this won't always be a no-op.
