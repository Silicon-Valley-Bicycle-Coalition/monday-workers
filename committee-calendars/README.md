# committee-calendars

**Status:** Decided — build (scoped 2026-08-22). See
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

Five cities plus three transit/county agencies whose committees intersect Santa Clara County
directly:

* San Jose, Santa Clara, Cupertino, Campbell, Saratoga
* **Caltrain's** [Bicycle and Active Transportation Advisory Committee (BATAC)](https://www.caltrain.com/about-caltrain/advisory-committees/batac)
* **BART's** [Bicycle Advisory Task Force](https://www.bart.gov/about/bod/advisory/bicycle)
* **VTA's** [countywide Bicycle & Pedestrian Advisory Committee](https://santaclaravta.iqm2.com/Citizens/Board/1007-Bicycle--Pedestrian-Advisory-Committee) — added to scope 2026-08-22 once its feed was confirmed (see below); the original scope note only named the five cities plus Caltrain and BART.

MTC is explicitly **out of scope** — its
[Bicycle, Pedestrian & Micromobility](https://mtc.ca.gov/planning/transportation/bicycle-pedestrian-micromobility)
work is a regional funding/planning program, not a recurring public meeting body. Nothing to
subscribe to there.

Saratoga has no bicycle-only committee — the relevant body is **PEBTAC** (Pedestrian, Equestrian &
Bicycle Trails Advisory Committee), which covers bike trails alongside pedestrian/equestrian
trails.

## Per-source adapters — all 8 platforms confirmed (2026-08-22)

Every source was live-checked; the previously-unconfirmed platforms (San Jose, Cupertino,
Saratoga, Caltrain BATAC, VTA) all turned out to land on the same 4 platform types already in use,
so this is **4 adapter implementations, not 8 one-off scrapers**:

| Source | Platform | Feed |
|---|---|---|
| [Santa Clara](https://santaclara.legistar.com/DepartmentDetail.aspx?ID=40583&GUID=A2976D84-B2FF-46EA-9AB6-595E6BFE57BA) | Legistar (Granicus) | [Legistar Web API](https://webapi.legistar.com/Home/Examples) — free, public, no key, JSON, filterable by body |
| [BART](https://bart.legistar.com/DepartmentDetail.aspx?ID=40340&GUID=26A86988-37E5-49C0-B948-DEE109826AE1) | Legistar (Granicus) | Same Legistar Web API adapter as Santa Clara — `client=bart` |
| [San Jose](https://www.sanjoseca.gov/your-government/departments-offices/transportation/walking-biking/bicycle-pedestrian-advisory-committee) | Legistar (Granicus) | Same adapter — `client=sanjose`, BodyId 230 "Bicycle Pedestrian Advisory Committee" |
| [Cupertino](https://www.cupertino.gov/Your-City/Commissions-and-Committees/Commissions/Bicycle-Pedestrian-Commission) | Legistar (Granicus) | Same adapter — `client=cupertino`, BodyId 170 "Bicycle Pedestrian Commission" |
| [Campbell](https://www.campbellca.gov/calendar.aspx?CID=32%2C) | CivicPlus Agenda Center | [iCalendar.aspx feed](https://www.civicplus.help/municipal-websites-central/docs/create-a-calendar-category-from-an-icalendar-feed), `catID=32` — verified live, valid ICS output |
| Saratoga (PEBTAC) | CivicPlus Agenda Center | Same adapter — `catID=34` — verified live, 40 future `VEVENT`s |
| [Caltrain BATAC](https://www.caltrain.com/about-caltrain/advisory-committees/batac) | Granicus RSS via [SamTrans's Granicus instance](https://samtrans.granicus.com/MinutesViewer.php?view_id=3&clip_id=1382&doc_id=fb610e44-c67c-11f0-a7da-005056a89546) | `ViewPublisherRSS.php` — confirmed live, but it's a **shared feed across every JPB/Caltrain body**, so this adapter title-filters for "Bicycle and Active Transportation Advisory Committee" rather than getting a body-scoped export like Legistar's |
| [VTA meeting portal](https://santaclaravta.iqm2.com/Citizens/Board/1007-Bicycle--Pedestrian-Advisory-Committee) | IQM2/Accela | `/Services/RSS.aspx?Feed=Calendar&Group=1007` — confirmed live, board-scoped calendar RSS |

Every source above exposes a structured feed (Legistar's API, CivicPlus's `iCalendar.aspx`,
Granicus RSS, IQM2 RSS) — no scrape-fallback adapter is needed for v1.

See the [implementation design](../docs/superpowers/specs/2026-08-22-committee-calendars-design.md)
for the full adapter/data-model/error-handling decisions built on this confirmation pass.

## Data flow

```
4 adapters (Legistar API / CivicPlus iCalendar.aspx / Granicus RSS / IQM2 RSS), 8 sources total
  │  daily Cron Trigger, each source polled independently — one failure doesn't block the rest
  ▼
Normalize + upsert into D1 (source-tagged; a failing source keeps serving its last-known events)
  ▼
Serve from a stable Worker route, e.g. calendar.bikesiliconvalley.org/committees.ics
  — ICS serialized from D1 on each request, cached at the edge; supports webcal:// subscription
```

A visitor subscribes once in Google/Apple Calendar and gets every committee's meetings from then
on, no re-checking required.

## Not a data source for this Worker

The [VTA Bicycle Program](https://www.vta.org/programs/bicycle-program) page is a static program
overview with no meeting-schedule API — unlike the VTA meeting portal above (which does feed this
Worker), it's useful only as a manual reference link on a project-level board item elsewhere in
the plan (see Bike-lane GIS proximity), not an input to this calendar feed.

## Sources

* [Legistar Web API (Granicus)](https://webapi.legistar.com/Home/Examples)
* [City of Santa Clara — Bicycle & Pedestrian Advisory Committee (Legistar)](https://santaclara.legistar.com/DepartmentDetail.aspx?ID=40583&GUID=A2976D84-B2FF-46EA-9AB6-595E6BFE57BA)
* [BART Bicycle Advisory Task Force (Legistar)](https://bart.legistar.com/DepartmentDetail.aspx?ID=40340&GUID=26A86988-37E5-49C0-B948-DEE109826AE1)
* [Campbell Bicycle & Pedestrian Advisory Committee (Agenda Center)](https://www.campbellca.gov/calendar.aspx?CID=32%2C)
* [Create a Calendar Category from an iCalendar Feed (CivicPlus)](https://www.civicplus.help/municipal-websites-central/docs/create-a-calendar-category-from-an-icalendar-feed)
* [Caltrain — BATAC](https://www.caltrain.com/about-caltrain/advisory-committees/batac)
* [Caltrain BATAC minutes (SamTrans Granicus instance)](https://samtrans.granicus.com/MinutesViewer.php?view_id=3&clip_id=1382&doc_id=fb610e44-c67c-11f0-a7da-005056a89546)
* [BART Bicycle Advisory Task Force](https://www.bart.gov/about/bod/advisory/bicycle)
* [City of San José Bicycle Pedestrian Advisory Committee](https://www.sanjoseca.gov/your-government/departments-offices/transportation/walking-biking/bicycle-pedestrian-advisory-committee)
* [Santa Clara VTA Meeting Portal (IQM2)](https://santaclaravta.iqm2.com/Citizens/Board/1007-Bicycle--Pedestrian-Advisory-Committee)
* [MTC — Bicycle, Pedestrian & Micromobility (out of scope)](https://mtc.ca.gov/planning/transportation/bicycle-pedestrian-micromobility)
* Plan section: Committee calendar subscriptions (Integrations) — `migration-plan.md` (private planning repo)
