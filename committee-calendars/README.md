# committee-calendars

**Status:** Live (deployed 2026-08-23). See
[implementation design](../docs/superpowers/specs/2026-08-22-committee-calendars-design.md) for
the resolved adapter list and build-level decisions.
**Priority:** Post-migration, non-blocking.
**Owner:** Unassigned.
**Stack:** Hono + TypeScript + D1, same shape used elsewhere, on a **daily Cron Trigger**.

## The ask

Let people subscribe to local Bicycle & Pedestrian Advisory Committee meetings from the website —
one-click "Subscribe to calendar" instead of staff or members manually checking a handful of
different city and transit-agency agenda sites.

## Coverage

Five cities plus two transit agencies whose committees intersect Santa Clara County directly:

* San Jose, Santa Clara, Cupertino, Campbell, Saratoga
* **Caltrain's** [Bicycle and Active Transportation Advisory Committee (BATAC)](https://www.caltrain.com/about-caltrain/advisory-committees/batac)
* **BART's** [Bicycle Advisory Task Force](https://www.bart.gov/about/bod/advisory/bicycle)

MTC is explicitly **out of scope** — its
[Bicycle, Pedestrian & Micromobility](https://mtc.ca.gov/planning/transportation/bicycle-pedestrian-micromobility)
work is a regional funding/planning program, not a recurring public meeting body. Nothing to
subscribe to there.

**VTA's countywide committee was investigated and dropped, not just left unconfirmed:** its
meeting portal has no reliable structured schedule — what looks like a "Calendar RSS" is actually
just a log of published agendas/minutes (always in the past by the time it's posted), and the one
genuinely upcoming meeting date on its board page exists only as unstructured, staff-written prose
with no calendar export nearby. Revisit only if VTA's site ever exposes a real feed.

Saratoga has no bicycle-only committee — the relevant body is **PEBTAC** (Pedestrian, Equestrian &
Bicycle Trails Advisory Committee), which covers bike trails alongside pedestrian/equestrian
trails.

## Per-source adapters — all platforms confirmed (2026-08-22)

Every source was live-checked with raw HTTP responses (not a summarizing fetch tool — an initial
pass on Caltrain BATAC and VTA looked promising but turned out to be checking the wrong thing; see
the [implementation design](../docs/superpowers/specs/2026-08-22-committee-calendars-design.md) for
that correction). Net result: **3 adapter implementations for 7 sources**, not 7 one-off scrapers:

| Source | Platform | Feed |
|---|---|---|
| [Santa Clara](https://santaclara.legistar.com/DepartmentDetail.aspx?ID=40583&GUID=A2976D84-B2FF-46EA-9AB6-595E6BFE57BA) | Legistar (Granicus) | [Legistar Web API](https://webapi.legistar.com/Home/Examples) — free, public, no key, JSON, filterable by body |
| [BART](https://bart.legistar.com/DepartmentDetail.aspx?ID=40340&GUID=26A86988-37E5-49C0-B948-DEE109826AE1) | Legistar (Granicus) | Same Legistar Web API adapter as Santa Clara — `client=bart` |
| [San Jose](https://www.sanjoseca.gov/your-government/departments-offices/transportation/walking-biking/bicycle-pedestrian-advisory-committee) | Legistar (Granicus) | Same adapter — `client=sanjose`, BodyId 230 "Bicycle Pedestrian Advisory Committee" |
| [Cupertino](https://www.cupertino.gov/Your-City/Commissions-and-Committees/Commissions/Bicycle-Pedestrian-Commission) | Legistar (Granicus) | Same adapter — `client=cupertino`, BodyId 170 "Bicycle Pedestrian Commission" |
| [Campbell](https://www.campbellca.gov/calendar.aspx?CID=32%2C) | CivicPlus Agenda Center | [iCalendar.aspx feed](https://www.civicplus.help/municipal-websites-central/docs/create-a-calendar-category-from-an-icalendar-feed), `catID=32` — verified live, valid ICS output |
| Saratoga (PEBTAC) | CivicPlus Agenda Center | Same adapter — `catID=34` — verified live, 40 future `VEVENT`s |
| [Caltrain BATAC](https://www.caltrain.com/about-caltrain/advisory-committees/batac) | Its own adapter — **not** Granicus RSS | SamTrans's Granicus RSS (`ViewPublisherRSS.php`) turned out to be a past-meeting video archive with no upcoming events at all. The real schedule lives on `caltrain.com`'s own BATAC page: each upcoming meeting has an "Add to calendar" button whose href is a `data:text/calendar;base64,...` URI — real ICS data, just embedded in HTML. This adapter scrapes that page for those links and parses each one, reusing the same ICS parser as the CivicPlus adapter. |

See the [implementation design](../docs/superpowers/specs/2026-08-22-committee-calendars-design.md)
for the full adapter/data-model/error-handling decisions built on this confirmation pass.

## Data flow

```
3 adapters (Legistar API / CivicPlus iCalendar.aspx / Caltrain BATAC page scrape), 7 sources total
  │  daily Cron Trigger, each source polled independently — one failure doesn't block the rest
  ▼
Normalize + replace each source's future events in D1 (a failing source keeps its last-known events)
  ▼
Serve from a stable Worker route: committees.bikesiliconvalley.org/committees.ics
  — ICS serialized from D1 on each request, cached at the edge; supports webcal:// subscription
```

A visitor subscribes once in Google/Apple Calendar and gets every committee's meetings from then
on, no re-checking required.

**Live:** https://committees.bikesiliconvalley.org/committees.ics — deployed 2026-08-23. Note this
isn't `calendar.bikesiliconvalley.org` (the plan's original placeholder) because that subdomain
was already in use as SVBC's Google Workspace hosted-calendar redirect.

## Not a data source for this Worker

The [VTA Bicycle Program](https://www.vta.org/programs/bicycle-program) page is a static program
overview with no meeting-schedule API — useful only as a manual reference link on a project-level
board item elsewhere in the plan (see Bike-lane GIS proximity), not an input to this calendar feed.
Nor is VTA's meeting portal itself (see Coverage above — investigated and ruled out, not a data
source here despite being a structured meeting-management platform in general).

## Sources

* [Legistar Web API (Granicus)](https://webapi.legistar.com/Home/Examples)
* [City of Santa Clara — Bicycle & Pedestrian Advisory Committee (Legistar)](https://santaclara.legistar.com/DepartmentDetail.aspx?ID=40583&GUID=A2976D84-B2FF-46EA-9AB6-595E6BFE57BA)
* [BART Bicycle Advisory Task Force (Legistar)](https://bart.legistar.com/DepartmentDetail.aspx?ID=40340&GUID=26A86988-37E5-49C0-B948-DEE109826AE1)
* [Campbell Bicycle & Pedestrian Advisory Committee (Agenda Center)](https://www.campbellca.gov/calendar.aspx?CID=32%2C)
* [Create a Calendar Category from an iCalendar Feed (CivicPlus)](https://www.civicplus.help/municipal-websites-central/docs/create-a-calendar-category-from-an-icalendar-feed)
* [Caltrain — BATAC](https://www.caltrain.com/about-caltrain/advisory-committees/batac) — the actual adapter source (embedded per-meeting `data:text/calendar` links)
* [SamTrans Granicus instance (ruled out — archive only, no upcoming events)](https://samtrans.granicus.com/MinutesViewer.php?view_id=3&clip_id=1382&doc_id=fb610e44-c67c-11f0-a7da-005056a89546)
* [BART Bicycle Advisory Task Force](https://www.bart.gov/about/bod/advisory/bicycle)
* [City of San José Bicycle Pedestrian Advisory Committee](https://www.sanjoseca.gov/your-government/departments-offices/transportation/walking-biking/bicycle-pedestrian-advisory-committee)
* [Santa Clara VTA Meeting Portal (IQM2) — ruled out, no structured forward schedule](https://santaclaravta.iqm2.com/Citizens/Board/1007-Bicycle--Pedestrian-Advisory-Committee)
* [MTC — Bicycle, Pedestrian & Micromobility (out of scope)](https://mtc.ca.gov/planning/transportation/bicycle-pedestrian-micromobility)
* Plan section: Committee calendar subscriptions (Integrations) — `migration-plan.md` (private planning repo)
