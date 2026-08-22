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
Live-checked all five during this design pass — using raw HTTP (`curl`), not a summarizing fetch
tool, after an initial pass on two sources gave a misleadingly optimistic read (see below):

| Source | Platform | Confirmed detail |
|---|---|---|
| San Jose | Legistar Web API | `client=sanjose`, BodyId 230, "Bicycle Pedestrian Advisory Committee". `events` endpoint verified with a real body+date filter (`$filter=EventBodyId eq ... and EventDate ge datetime'...'`), returning genuine forward-scheduled meetings. |
| Cupertino | Legistar Web API | `client=cupertino`, BodyId 170, "Bicycle Pedestrian Commission". Same `events` endpoint verified live. |
| Saratoga | CivicPlus `iCalendar.aspx` | Saratoga has no bike-only committee — the relevant body is **PEBTAC** (Pedestrian, Equestrian & Bicycle Trails Advisory Committee), `catID=34`. Verified live: valid `BEGIN:VCALENDAR` output, 40 future `VEVENT`s (schedule goes out to 2036). |
| Caltrain BATAC | **Not** Granicus RSS — see below | `samtrans.granicus.com/ViewPublisherRSS.php` looks live but is a **past-meeting video archive**: `pubDate` is the archive-publish date (a day or so *after* each meeting), and SamTrans's own viewer confirms "Currently there are no Upcoming Events." The real forward schedule lives on `caltrain.com`'s own BATAC page: each upcoming meeting has an "Add to calendar" button whose `href` is `data:text/calendar;charset=utf8;base64,...` — a genuine per-meeting ICS blob, just HTML-embedded rather than served as a feed. |
| VTA (county-level) | **No reliable source found — dropped from v1** | The page's "RSS" link (`/Services/RSS.aspx?Feed=Calendar&Group=1007`) is, per raw `curl`, an HTML fragment (not real RSS) listing only *published agendas/minutes* — both entries already in the past relative to the design date. The one genuinely future meeting visible on the board page (Sept 9, 2026) exists only as unstructured, staff-authored prose inside a `board-message` div, with no calendar export nearby and no consistent template. Not reliably scrapable. |

**Net result: 7 sources, 3 adapter implementations.** Legistar covers 4 sources (Santa Clara,
BART, San Jose, Cupertino), parameterized by `client` + `bodyId`. CivicPlus covers 2 (Campbell,
Saratoga), parameterized by `domain` + `catID`. A third adapter, specific to Caltrain BATAC,
scrapes `caltrain.com`'s BATAC page for embedded `data:text/calendar` links and parses each with
the same ICS parser the CivicPlus adapter uses.

**Correction note:** An earlier pass through this design (and the resulting README update)
initially reported Caltrain BATAC's Granicus RSS as "confirmed live" and VTA's IQM2 endpoint as "a
confirmed board-scoped calendar RSS," and included VTA in v1 scope on that basis. Both were
wrong — the first check used a summarizing fetch tool that described *a* feed existing without
verifying its actual date semantics (archive vs. schedule). Re-checking with raw HTTP responses
caught this before implementation started; this document and the README are corrected accordingly.

## Decisions made in this design pass

* **VTA is out of scope for v1**, reverting to the README's original "five cities plus two transit
  agencies" (7 sources). No structured forward-schedule source exists for it — see above. Revisit
  if VTA's site ever exposes a real schedule feed or export.
* **Caltrain BATAC gets its own adapter**, not a shared "Granicus RSS" adapter (Granicus doesn't
  work for this source at all — see above). It scrapes `caltrain.com`'s BATAC page for
  `data:text/calendar;base64,...` hrefs, base64-decodes each, and parses the resulting ICS with the
  same parser `civicplus.ts` uses. This is the "scrape fallback" the original README anticipated
  might be needed — except what's scraped is still structured ICS data embedded in HTML, not
  free-text date parsing, so it's meaningfully more robust than a plain agenda-list scrape.
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
* **A cron run replaces each source's future events wholesale**, not a pure additive upsert:
  before inserting today's fetch for a source, delete that source's existing rows with
  `start_utc >= today`. This is what makes a cancelled/rescheduled meeting disappear from the feed
  the next day instead of lingering forever — a plain upsert-by-external-id has no way to notice an
  event that stopped being returned by the source.
* **One adapter per platform, not per source.** `config/sources.json` holds the 7 source configs;
  adding another city later is a config entry, not new code, if it's on the Legistar or CivicPlus
  platform — keeps the "another org's fork is a config change" goal intact even as coverage grows.
* **ICS generation via the `ics` npm package** (write direction), **ICS parsing via `ical.js`**
  (read direction — CivicPlus and Caltrain BATAC both hand back real ICS that needs parsing,
  including `VTIMEZONE`-qualified `DTSTART`s). Both are small, dependency-free, pure-JS libraries
  with no Node-specific APIs (`fs`, `Buffer`) — confirmed Workers-safe. RFC 5545's line-folding,
  escaping, and timezone rules are easy to get subtly wrong by hand and easy to get right with a
  well-tested library; using two single-purpose libraries here isn't a framework, it's not
  reinventing a well-known spec twice.
* **`webcal://` needs no server-side handling.** It's the same HTTPS URL under a different scheme
  that calendar apps treat as "subscribe" instead of "download." The README/landing copy should
  surface both URL forms; the Worker only ever serves `https://`.
* **Workspace:** new git worktree `monday-workers-committee-calendars` on branch
  `feat/committee-calendars` off `main` — same one-worktree-per-feature-branch pattern as
  `funraise-sync`/`quickbooks-sync`/`salesforce-import`.

## Components

* `config/sources.json` — the 7 source configs: `{id, name, committeeName, adapter,
  ...adapter-specific params}`.
* `src/config.ts` — typed loader/validator for the above.
* `src/types.ts` — `NormalizedEvent`, per-adapter `SourceConfig` variants, `Env`.
* `src/adapters/legistar.ts` — Legistar Web API client. Config: `{client, bodyId}`. Used for Santa
  Clara, BART, San Jose, Cupertino. Converts each event's naive Pacific-local `EventDate` +
  `EventTime` into a UTC instant (see `src/util/zonedTime.ts` below).
* `src/adapters/civicplus.ts` — fetches the CivicPlus `iCalendar.aspx` output (already valid ICS)
  and parses it with `ical.js`. Config: `{domain, catId}`. Used for Campbell, Saratoga.
* `src/adapters/caltrainBatac.ts` — fetches `caltrain.com`'s BATAC page HTML, extracts every
  `data:text/calendar;base64,...` href, base64-decodes each to raw ICS text, and parses each with
  `ical.js` (shared logic factored into `src/util/parseIcs.ts`, used by both this adapter and
  `civicplus.ts`). No config params beyond the page URL — this adapter is source-specific, not
  platform-generic.
* `src/util/parseIcs.ts` — shared `ical.js` wrapper: parse an ICS string, register any embedded
  `VTIMEZONE` components, return each `VEVENT` as a plain object (summary, start, end, location,
  url, uid).
* `src/util/zonedTime.ts` — converts a naive `(year, month, day, hour, minute)` wall-clock time in
  a given IANA timezone to a UTC `Date`, using `Intl.DateTimeFormat`'s `formatToParts` to resolve
  the zone's offset at that instant (correct across DST transitions, no dependency needed —
  Cloudflare Workers ship full ICU/`Intl` support).
* `src/normalize.ts` — maps each adapter's raw output to a common `NormalizedEvent {sourceId,
  externalId, title, committeeName, startUtc, endUtc, location, url}`. Dedup key is `(sourceId,
  externalId)`.
* `src/db/events.ts` — D1 read/write layer for `events` and `source_status`.
* `src/ics.ts` — builds the merged `VCALENDAR` from a `NormalizedEvent[]` using `ics`.
* `src/sync.ts` — cron orchestration: iterate configured sources, call the right adapter, replace
  that source's future events on success, record success/failure in `source_status`, fire a Slack
  alert on crossing the failure threshold.
* `src/alert.ts` — `sendFailureAlert`: POSTs a message to a Slack incoming-webhook URL.
* `src/route.ts` — Hono `GET /committees.ics`.
* `src/index.ts` — Hono app export + `scheduled()` cron handler, wiring bindings into `sync.ts`.

## Data model (D1)

```sql
-- migrations/0001_create_events.sql
CREATE TABLE events (
  id TEXT PRIMARY KEY,              -- source_id || ':' || external_id
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

Daily Cron Trigger. For each of the 7 configured sources, independently: call its adapter → on
success, **replace** that source's future events (`DELETE ... WHERE source_id = ? AND start_utc >=
today` then insert the fresh set, as one D1 `batch()`), reset `consecutive_failures`, and update
`last_success_at` in `source_status`; on failure, catch it locally, increment
`consecutive_failures`, record `last_error`, and move on to the next source — one adapter throwing
never aborts the run. `last_success_at` only advances after the D1 write commits, matching this
repo's standing "cursor advances only after confirmed write" invariant (the write here is to D1
itself, since this Worker has no downstream Monday write). The moment `consecutive_failures`
*first* reaches the threshold (3), fire a Slack ping via a Slack incoming-webhook URL — not on
every subsequent failed day past that, to avoid alert spam for a still-broken source.

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
failure mode: a broken source degrades the feed for its own committee only, never the other 6.

## Testing

Vitest, TDD. Unit-test:

* Each adapter against fixture responses captured from the real endpoints verified during this
  design pass (Legistar JSON for Cupertino's `events` endpoint, Campbell/Saratoga ICS, the
  caltrain.com BATAC page HTML with an embedded `data:text/calendar` link) — no live network calls
  in tests.
* `zonedTime.ts`'s local-to-UTC conversion, including a case straddling a DST transition.
* `parseIcs.ts` against a fixture with a `VTIMEZONE` block (the Saratoga/Campbell shape).
* `normalize.ts`'s dedup-key construction.
* `ics.ts`'s serialization against a known `NormalizedEvent[]` fixture (line-folding, escaping).
* `sync.ts`'s failure-threshold logic (alert fires exactly once on crossing 3, not again on 4/5/...).
* One integration test, using the `test/apply-migrations.ts` D1-harness pattern from
  `funraise-sync`, covering cron write → route read end-to-end, including the empty-D1 case and a
  cancelled-meeting-disappears-next-run case.

## Deliberately not in v1

* No per-user filtering (subscribe to just one city) — one merged feed for everyone, matching the
  README's "one-click subscribe" framing. A per-committee feed (e.g.
  `/committees/san-jose.ics`) is a natural follow-up if requested, not built speculatively now.
* No historical/past-meeting data in the feed — only `start_utc >= now`. Minutes/agendas for past
  meetings stay on each source's own site.
* No retry-with-backoff *within* a single adapter call — a transient failure just waits for
  tomorrow's cron run, consistent with every other cron-polled Worker in this repo.
* **VTA** — no reliable structured source found; see Platform confirmation above.

## Open questions

None blocking. Remaining unknowns are ordinary build-time detail: how stable `caltrain.com`'s BATAC
page markup is for the `data:text/calendar` scrape (confirm the extraction still works against a
few months of real page snapshots during adapter implementation, and treat a page-structure change
there as an expected maintenance cost of scraping a page rather than a feed), and the Slack webhook
target for the failure-alert threshold.
