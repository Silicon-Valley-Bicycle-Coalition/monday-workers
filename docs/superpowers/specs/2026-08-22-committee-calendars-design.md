# committee-calendars: implementation design

**Status:** Design complete, approved for implementation.
**Builds on:** [`committee-calendars/README.md`](../../../committee-calendars/README.md), the
product/business spec. This document resolves that README's "Needed first" platform-confirmation
gap and covers the implementation-level decisions the README leaves open.

## Scope recap (from the README, not re-decided here)

Let people subscribe to local Bicycle & Pedestrian Advisory Committee meetings from one merged
ICS feed instead of checking a handful of city/agency agenda sites by hand. Cron-polled, no
Queue — self-healing on next run, same shape as `squarespace-forms`/`buffer-content-calendar`.

## Platform confirmation (resolves the README's open item)

The README left four sources ("not yet confirmed") plus VTA ("not yet investigated") unresolved.
Live-checked all five during this design pass:

| Source | Platform | Confirmed detail |
|---|---|---|
| San Jose | Legistar Web API | `client=sanjose`, BodyId 230, "Bicycle Pedestrian Advisory Committee" |
| Cupertino | Legistar Web API | `client=cupertino`, BodyId 170, "Bicycle Pedestrian Commission" |
| Saratoga | CivicPlus `iCalendar.aspx` | Saratoga has no bike-only committee — the relevant body is **PEBTAC** (Pedestrian, Equestrian & Bicycle Trails Advisory Committee), `catID=34`. Verified live: valid `BEGIN:VCALENDAR` output, 40 future `VEVENT`s. |
| Caltrain BATAC | Granicus RSS | `samtrans.granicus.com/ViewPublisherRSS.php` is live, but it's a **shared feed across every JPB/Caltrain body** (Board, Citizens Advisory, Finance, TOPS, AMP, BATAC, Local Policy Maker Group) — needs title-filtering to `"Bicycle and Active Transportation Advisory Committee"`, not a body-scoped export like Legistar's. |
| VTA (county-level) | IQM2 Calendar RSS | `santaclaravta.iqm2.com/Services/RSS.aspx?Feed=Calendar&Group=1007` — confirmed live, scoped per board via `Group` ID. Included in v1 scope (was ambiguous in the README's Coverage vs. adapter-table listing; resolved to include — see decision below). |

Net result: **8 sources, 4 adapter implementations** (not 7 one-off scrapers). Legistar covers 4
sources (Santa Clara, BART, San Jose, Cupertino) with one client, parameterized by `client` +
`bodyId`. CivicPlus covers 2 (Campbell, Saratoga), parameterized by `domain` + `catID`. Granicus
RSS and IQM2 RSS each cover one source.

## Decisions made in this design pass

* **VTA is in scope for v1.** The README's Coverage section names "five cities plus two transit
  agencies" (7) but separately lists VTA in the adapter table as county-level and
  "not yet investigated" — read as an ambiguous maybe-8th, not a confirmed exclusion (MTC, by
  contrast, is explicitly ruled out as a planning body with nothing to subscribe to). Since the
  IQM2 adapter is now confirmed working, there's no remaining research cost to including it.
* **Feed generation: D1-only, serialize ICS on request** — not D1 + a published R2 blob. Cron
  writes normalized events into one D1 `events` table; the `GET /committees.ics` route queries D1
  and serializes on each request, with `Cache-Control: public, max-age=3600` so repeat polls from
  calendar apps mostly hit edge cache. One storage system; a cron write is visible on the very
  next request with no separate "did the publish step run" failure mode to reason about. Traffic
  is low (a handful of subscriber polls a day), so per-request serialization cost is negligible.
* **Per-source failure handling: degrade gracefully, not fail closed.** Each source's
  last-successfully-fetched events stay in D1 even when today's poll for that source fails — the
  merged feed always serves what's there, so one flaky source (e.g. Legistar down) goes stale for
  that one committee instead of 500ing the whole feed. `source_status.consecutive_failures` tracks
  the streak; a Slack ping fires past a threshold, per the root README's existing guidance for
  cron-polled Workers ("worth a Slack-automation ping on repeated failure, not just silent
  retry-next-cycle").
* **One adapter per platform, not per source.** `config/sources.json` holds the 8 source configs;
  adding a 9th city later is a config entry, not new code, if it's on one of these 4 platforms —
  keeps the "another org's fork is a config change" goal intact even as coverage grows.
* **ICS serialization via the `ics` npm package**, not hand-rolled. RFC 5545's line-folding
  (75-octet soft wrap) and text-escaping rules (commas, semicolons, backslashes) are easy to get
  subtly wrong by hand and easy to get right with a small, dependency-light, pure-JS library — this
  is boilerplate worth not reinventing, not a framework.
* **`webcal://` needs no server-side handling.** It's the same HTTPS URL under a different scheme
  that calendar apps treat as "subscribe" instead of "download." The README/landing copy should
  surface both URL forms; the Worker only ever serves `https://`.
* **Workspace:** new git worktree `monday-workers-committee-calendars` on branch
  `feat/committee-calendars` off `main` — same one-worktree-per-feature-branch pattern as
  `funraise-sync`/`quickbooks-sync`/`salesforce-import`.

## Components

* `config/sources.json` — the 8 source configs: `{id, name, adapter, ...adapter-specific params}`.
* `src/config.ts` — typed loader/validator for the above.
* `src/adapters/legistar.ts` — Legistar Web API client. Config: `{client, bodyId}`. Used for Santa
  Clara, BART, San Jose, Cupertino.
* `src/adapters/civicplus.ts` — fetches and parses the CivicPlus `iCalendar.aspx` output, which is
  already valid ICS — mostly parse-and-passthrough rather than a scrape. Config: `{domain, catID}`.
  Used for Campbell, Saratoga.
* `src/adapters/granicusRss.ts` — fetches the shared Granicus `ViewPublisherRSS.php` feed and
  filters items by title. Config: `{domain, viewId, titleFilter}`. Used for Caltrain BATAC.
* `src/adapters/iqm2Rss.ts` — fetches the IQM2 board-scoped calendar RSS. Config: `{domain,
  group}`. Used for VTA.
* `src/normalize.ts` — maps each adapter's raw output to a common `NormalizedEvent {sourceId,
  externalId, title, committeeName, start, end, location, url}`. Dedup key is `(sourceId,
  externalId)`, falling back to a hash of `(title, start)` for feeds without a stable ID (Granicus
  RSS items, which may lack a GUID).
* `src/db/events.ts` — D1 upsert/query layer for `events` and `source_status`.
* `src/ics.ts` — builds the merged `VCALENDAR` from a `NormalizedEvent[]` using `ics`.
* `src/route.ts` — Hono `GET /committees.ics`.
* `src/index.ts` — Hono app export + `scheduled()` cron handler.

## Data model (D1)

```sql
-- migrations/0001_create_events.sql
CREATE TABLE events (
  id TEXT PRIMARY KEY,              -- source_id || ':' || external_id (or title/start hash)
  source_id TEXT NOT NULL,
  title TEXT NOT NULL,
  committee_name TEXT NOT NULL,
  start_utc TEXT NOT NULL,
  end_utc TEXT,
  location TEXT,
  url TEXT,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE source_status (
  source_id TEXT PRIMARY KEY,
  last_success_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
```

## Cron flow

Daily Cron Trigger. For each of the 8 configured sources, independently: call its adapter → on
success, upsert its `NormalizedEvent[]` into `events`, reset `consecutive_failures`, and update
`last_success_at` in `source_status`; on failure, catch it locally, increment
`consecutive_failures`, record `last_error`, and move on to the next source — one adapter throwing
never aborts the run. `last_success_at` only advances after the D1 upsert commits, matching this
repo's standing "cursor advances only after confirmed write" invariant (the write here is to D1
itself, since this Worker has no downstream Monday write). Past a threshold (e.g. 3) consecutive
failures for one source, fire a Slack ping via a native Slack workflow webhook — no new
integration to build.

## Serving

`GET /committees.ics` queries all events with `start_utc >= now`, serializes to one merged
`VCALENDAR`, returns `Content-Type: text/calendar; charset=utf-8` and
`Cache-Control: public, max-age=3600`. If D1 has zero rows (fresh deploy, cron hasn't run yet), it
returns a valid empty calendar rather than an error — the route never depends on cron having run.

## Error handling

Same invariant as every cron-polled Worker in this repo (see `../../../README.md`'s Reliability
section): a per-source cursor/status only advances after a confirmed write, never before, so a
failed poll is retried next cycle instead of silently skipping whatever it should have processed.
Unlike the webhook-driven Workers, there is no Queue here and no external write to retry against —
failure isolation is per-source within a single cron run, and staleness (not data loss) is the
failure mode: a broken source degrades the feed for its own committee only, never the other 7.

## Testing

Vitest, TDD. Unit-test:

* Each adapter against fixture responses captured from the real endpoints verified during this
  design pass (Legistar JSON, Campbell/Saratoga ICS, SamTrans RSS, VTA RSS) — no live network calls
  in tests.
* `normalize.ts`'s dedup/hash-fallback logic.
* `ics.ts`'s serialization against a known `NormalizedEvent[]` fixture (line-folding, escaping).
* One integration test, using the `test/apply-migrations.ts` D1-harness pattern from
  `funraise-sync`, covering cron write → route read end-to-end, including the empty-D1 case.

## Deliberately not in v1

* No per-user filtering (subscribe to just one city) — one merged feed for everyone, matching the
  README's "one-click subscribe" framing. A per-committee feed (e.g.
  `/committees/san-jose.ics`) is a natural follow-up if requested, not built speculatively now.
* No historical/past-meeting data in the feed — only `start_utc >= now`. Minutes/agendas for past
  meetings stay on each source's own site.
* No retry-with-backoff *within* a single adapter call — a transient failure just waits for
  tomorrow's cron run, consistent with every other cron-polled Worker in this repo.

## Open questions

None blocking. The two items the README flagged as "needed first" (San Jose/Cupertino/Saratoga/
Caltrain BATAC platform confirmation, VTA feasibility) are resolved above. Remaining unknowns are
ordinary build-time detail: exact `titleFilter` matching robustness for the Granicus feed (titles
could drift, e.g. "BATAC" abbreviation vs. full name — confirm against a few months of real feed
data during adapter implementation) and the Slack webhook target for the failure-alert threshold.
