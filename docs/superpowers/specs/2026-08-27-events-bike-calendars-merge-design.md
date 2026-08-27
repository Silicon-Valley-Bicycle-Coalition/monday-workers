# events-widgets + bike-calendars merge: implementation design

**Status:** Design complete, approved for implementation.
**Supersedes:** `committee-calendars/` (this repo) and the standalone `bike-calendars` /
`bike-calendars-implementation` project (separate GitLab repo,
`silicon-valley-bicycle-coalition/bike-calendars`, branch `feat/initial-build`). Both are deleted
as part of this work. This also reverses a decision in bike-calendars' own approved design doc
(`bike-calendars/docs/superpowers/specs/2026-08-26-bike-calendars-design.md`), which deliberately
kept bike-calendars out of `monday-workers` and off a Workers/D1 architecture — see "Why this
reverses the prior decision" below.

## Motivation

Three separate deployables currently do overlapping work, all serving the SVBC public website:

- `events-widgets` — live Cloudflare Worker, deployed since 2026-02, proxying Eventbrite for a
  Squarespace-embedded widget (`events.bikesiliconvalley.org`).
- `committee-calendars` — live Cloudflare Worker + D1, deployed 2026-08-23, serving one merged
  ICS feed of 7 government committee calendars (`committees.bikesiliconvalley.org`).
- `bike-calendars` (standalone repo, `feat/initial-build`) — an in-progress Astro static site on
  Cloudflare Pages plus a `trigger/` cron Worker, built specifically to **replace**
  `committee-calendars` with per-source feeds, and to also absorb the two Eventbrite sources
  `events-widgets` already serves.

All three touch Eventbrite and/or the same "public calendar surface on bikesiliconvalley.org"
problem, each with its own from-scratch fetch/cache/error-handling code. The ask: reduce this to
one deployable, sharing one implementation per data source.

## Why this reverses the prior decision

bike-calendars' approved design doc chose a standalone repo and an Astro-static/Cloudflare-Pages
architecture specifically to avoid `monday-workers`' Worker+D1 conventions ("this project doesn't
need to stay inside the `monday-workers` monorepo's conventions — it's unrelated to the
Salesforce/Monday migration those conventions exist for") and to get a daily-rebuild "last known
good" fallback without new infrastructure.

This design deliberately reopens that choice: the goal shifted from "keep bike-calendars
architecturally separate" to "minimize the number of deployed Workers," which the Astro/Pages
split works against (it's still 2 deployables — the Pages project and its `trigger/` Worker — on
top of the pre-existing `events-widgets`). Folding everything into one Worker, in the repo that
already hosts `events-widgets` and `committee-calendars`, gets to one deployable total. The
resilience goal Astro/Pages provided (fallback on a source failing) is preserved with a small KV
addition (see below) instead of a daily static rebuild.

## Target architecture

One Cloudflare Worker, renamed from `events-widgets/` to `svbc-calendars/` to reflect the broader
scope, serving:

| Route | Behavior | Source of implementation |
|---|---|---|
| `GET /events` | Unchanged — JSON Eventbrite events for the SVBC org | `events-widgets` (existing) |
| `GET /widget` | Unchanged — embeddable HTML widget for Squarespace iframe | `events-widgets` (existing) |
| `GET /calendars/:id.ics` | New — one route per source, generated at request time | Adapters below |
| `GET /calendars` | New — staff-facing listing of every subscribe link | Ported from bike-calendars' Astro listing page, rewritten as a hand-written HTML generator (same style as the existing `/widget` HTML) |
| `GET /status.json` | New — per-source consecutive-failure counts, Slack alert at streak 3 | Ported from bike-calendars' `alert.ts`/`sync.ts`, adapted from per-build to per-request |

Nine calendar sources (unchanged from both prior designs): Santa Clara, BART, San Jose, Cupertino
(Legistar), Campbell, Saratoga/PEBTAC (CivicPlus), Caltrain BATAC (page-scrape), SVBC Public
Events, SVBC Volunteer Opportunities (Eventbrite). `config/sources.json` carries over from
bike-calendars as-is.

### Domains

Both existing custom domains route to the single Worker — `events.bikesiliconvalley.org` for
`/events` and `/widget`, `committees.bikesiliconvalley.org` for `/calendars/*`. No existing embed
or subscription URL breaks.

**Before deleting `committee-calendars`, verify its actual production status.** This repo's
`README.md` says it's "Live... serving `https://committees.bikesiliconvalley.org/committees.ics`,"
but bike-calendars' design doc says that Worker "ran locally for debugging but was never deployed
with real traffic" — the two documents disagree. `committee-calendars/wrangler.jsonc` does have a
real custom-domain route and a provisioned D1 database (`svbc-committee-calendars`,
`bdadb7de-19b2-4fa8-b74b-cf311093acd9`), which suggests the README is likely correct, but this
needs a live check (`curl https://committees.bikesiliconvalley.org/committees.ics`) before the
route is repointed, so nothing live goes dark mid-migration.

## Where the code comes from

Rather than importing all of `bike-calendars` (Astro scaffolding included) and deleting most of
it, each piece is pulled from wherever it already has the most history/correctness:

- **Legistar / CivicPlus / Caltrain adapters** — `git mv` from this repo's own
  `committee-calendars/src/adapters/` (bike-calendars' copies were "near-verbatim" derivatives of
  these; the originals already have native history in this repo, no import needed).
- **Eventbrite adapter** — ported from `bike-calendars`'s
  `src/lib/adapters/eventbrite.ts` (organizer-scoped `/v3/organizers/{id}/events/` endpoint, fully
  paginated), which is more correct than `events-widgets`'s current org-wide
  `/v3/organizations/{id}/events/` fetch (single page, filters by organizer client-side — can
  silently drop a given organizer's events past the first ~50 results org-wide). This becomes the
  one Eventbrite fetch function used by `/events`, `/widget`, and the two Eventbrite `.ics` routes.
  It needs a small signature change to accept the token as an explicit parameter (bike-calendars'
  version reads `process.env.EVENTBRITE_TOKEN` directly, which doesn't exist in a Worker's `fetch`
  handler — the Worker passes `env.EVENTBRITE_TOKEN` instead).
  - `/events` and `/widget` (no `organizer` query param) currently return one merged, org-wide
    "all upcoming events" view. Reusing the organizer-scoped adapter for that case means fetching
    each of the 3 allowlisted organizer IDs and merging + sorting by start time, rather than one
    org-wide call. Minor behavior change (results are now provably complete instead of
    first-50-across-the-org), otherwise invisible to callers.
- **`config/sources.json`** — ported from bike-calendars as-is.
- **Listing page markup** — ported from bike-calendars' Astro page, rewritten as a plain
  HTML-string generator matching `events-widgets`' existing `/widget` style (no framework).

## Caching and fallback

`caches.default` fronts every route, as `events-widgets` already does today:

- `/events`, `/widget` — unchanged 15-minute TTL.
- `/calendars/*`, `/calendars/:id.ics` — much longer TTL (~24h) — bike-calendars' scope was
  explicit that "nothing needs to be real-time" for these sources.

**New KV namespace**, one key per source id, written on every successful fetch for that source. If
a source's live fetch fails (Caltrain's page changes shape, Legistar/CivicPlus is down, etc.),
`/calendars/:id.ics` serves the last KV-stored ICS instead of erroring — this replaces the
resilience bike-calendars' daily-rebuild "republish last known good" pattern provided, without
needing a database or a rebuild step. `/status.json`'s failure-streak counter also lives in this
namespace (or a second one) and increments per failed *request* rather than per failed *daily
build* — a semantic shift worth noting: streaks now depend on request volume against the TTL
window, not literally "N calendar days in a row," but the Slack-alert-at-3 behavior is otherwise
unchanged.

## Observability

- **Workers Logs** — extend the `observability.enabled: true` already present in
  `events-widgets`' `wrangler.jsonc`; add structured log fields per request (route, source id,
  cache hit/miss, KV-fallback triggered, failure reason).
- **Workers Analytics Engine** — new dataset, counters per route and per source id: fetch counts,
  cache hit rate, failure rate, KV-fallback rate. Answers "is committee X's feed healthy" at a
  glance, queryable via the Analytics Engine SQL API.
- **Cloudflare Web Analytics** — client-side, cookieless pageview beacon added to the public-facing
  HTML (the widget's embedded content and the `/calendars` listing page). Separate from the above —
  real visitor pageviews/referrers, not Worker request counts. Just a script tag + site token.

## What gets deleted

- `committee-calendars/` — directory, GitLab CI job, README status-table row. D1 database
  (`svbc-committee-calendars`) decommissioned **only after** confirming the merged Worker is live
  and serving correctly — this is a separate, explicit, destructive step, not bundled into the
  main migration commit.
- `bike-calendars-implementation`'s Astro app and `trigger/` Worker, in their entirety (only the
  adapters/config/listing-markup described above survive, ported into the merged Worker).
- The standalone `bike-calendars` GitLab repo — recommend archiving (not deleting) once the merge
  ships, with a README note pointing at its new home, matching how a fork-friendly project
  typically gets retired rather than removed outright. Final call on archive-vs-delete is the
  user's, not part of this spec.
- The `bike-calendars` / `bike-calendars-implementation` sibling directories and the
  `bike-calendars-implementation` worktree in this workspace, once the above is committed and
  pushed. **Before removing that worktree**, check for gitignored files that would be lost
  (`git status --ignored --short | grep '^!!'` — the workspace CLAUDE.md documents a prior
  incident where this step was skipped and cost real data). `bike-calendars-implementation/.env`
  in particular needs to be preserved or copied to the merged Worker's `.dev.vars` if it holds a
  local `EVENTBRITE_TOKEN` or similar.

## Docs to update

- `monday-workers/README.md` — replace the `events-widgets` and `committee-calendars` status-table
  rows with one row for the merged Worker; update the "Status at a glance" description.
- `monday-workers/CLAUDE.md` — its current framing ("Workers... built for the Salesforce → Monday
  CRM migration and for post-migration integrations") already didn't quite fit `events-widgets`
  ("Not migration-related; predates this repo," per the README). Worth a small note acknowledging
  the repo now also hosts SVBC's public-website-facing Workers as a deliberate, separate category —
  similar to how the README already carves out "two related builds are deliberately not Workers."
- `bike-calendars/docs/superpowers/specs/2026-08-26-bike-calendars-design.md` — annotate (don't
  delete) with a note that this later decision reversed its standalone-repo/Astro-Pages choice, and
  why, for anyone who finds that doc later.
- The top-level workspace `CLAUDE.md` — remove references to `bike-calendars` /
  `bike-calendars-implementation` as separate projects once they're gone.

## Migration mechanics

This work happens in the `monday-workers-events-bike-calendars` worktree (sibling to the primary
`monday-workers` checkout), branch `feat/events-bike-calendars-merge`, per this repo's own
worktree-per-topic convention.

1. `git mv committee-calendars/src/adapters/{legistar,civicplus,caltrainBatac}.ts` (and their
   tests) into the merged Worker's directory — preserves history natively.
2. Port the Eventbrite adapter and `config/sources.json` from bike-calendars
   (`feat/initial-build`) by hand (small enough that a full `git subtree` import isn't worth the
   churn of immediately deleting most of what it brings in).
3. Add the new routes, KV namespace, and observability config.
4. Delete `committee-calendars/` and the Astro/`trigger/` parts of bike-calendars.
5. Update the docs listed above.
6. Verify (see below), then open the MR.

## Testing / verification

- Existing `events-widgets` tests (Vitest + `@cloudflare/vitest-pool-workers`, `fetchMock`) continue
  to cover `/events` and `/widget`.
- Port `committee-calendars`' and bike-calendars' adapter-level tests (Legistar, CivicPlus,
  Caltrain, Eventbrite) alongside the moved/ported source files.
- New tests for: KV fallback-on-failure per source, `/status.json` streak/alert logic, the merged
  Eventbrite organizer-fetch-and-merge behavior for the no-`organizer`-param case.
- Manual check before cutover: confirm `committee-calendars`'s actual live status (see "Domains"
  above) so the domain repoint doesn't produce a gap.
