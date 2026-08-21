# committee-calendars

**Status:** Recommended.
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

## Needed first

Confirm the meeting-management platform for **San Jose, Cupertino, Saratoga, and Caltrain's
BATAC** before finalizing the adapter list — these four aren't yet confirmed the way Santa Clara,
BART, and Campbell are (below).

## Per-source adapters, confirmed so far

| Source | Platform | Feed |
|---|---|---|
| [Santa Clara](https://santaclara.legistar.com/DepartmentDetail.aspx?ID=40583&GUID=A2976D84-B2FF-46EA-9AB6-595E6BFE57BA) | Legistar (Granicus) | [Legistar Web API](https://webapi.legistar.com/Home/Examples) — free, public, no key, JSON, filterable by body |
| [BART](https://bart.legistar.com/DepartmentDetail.aspx?ID=40340&GUID=26A86988-37E5-49C0-B948-DEE109826AE1) | Legistar (Granicus) | Same Legistar Web API adapter as Santa Clara — one adapter, two sources |
| [Campbell](https://www.campbellca.gov/calendar.aspx?CID=32%2C) | CivicPlus Agenda Center | [iCalendar.aspx feed](https://www.civicplus.help/municipal-websites-central/docs/create-a-calendar-category-from-an-icalendar-feed) per category — likely consumable directly, no scraping |
| [Caltrain BATAC](https://www.caltrain.com/about-caltrain/advisory-committees/batac) | Minutes via [SamTrans's Granicus instance](https://samtrans.granicus.com/MinutesViewer.php?view_id=3&clip_id=1382&doc_id=fb610e44-c67c-11f0-a7da-005056a89546) | Same vendor family as Legistar, but **confirm this specific deployment exposes a feed** before assuming the same adapter applies as-is |
| [San Jose](https://www.sanjoseca.gov/your-government/departments-offices/transportation/walking-biking/bicycle-pedestrian-advisory-committee) | Not yet confirmed | Check before finalizing |
| Cupertino, Saratoga | Not yet confirmed | Check before finalizing |
| County-level: [VTA meeting portal](https://santaclaravta.iqm2.com/Citizens/Board/1007-Bicycle--Pedestrian-Advisory-Committee) | IQM2/Accela | Likely has its own export — not yet investigated |

Where a source exposes a structured feed (Legistar's API, CivicPlus's `iCalendar.aspx`), pull it
directly. Where none exists, fall back to **scraping the agenda list page** for date/time — more
fragile, and worth revisiting if that source changes platforms.

## Data flow

```
One small adapter per city/agency (Legistar API / CivicPlus iCalendar.aspx / scrape fallback)
  │  daily Cron Trigger
  ▼
Normalize into a single merged ICS feed → D1 or R2
  ▼
Serve from a stable Worker route, e.g. calendar.bikesiliconvalley.org/committees.ics
  supporting webcal:// subscription
```

A visitor subscribes once in Google/Apple Calendar and gets every committee's meetings from then
on, no re-checking required.

## Not a data source for this Worker

The [VTA Bicycle Program](https://www.vta.org/programs/bicycle-program) page and city Bicycle &
Pedestrian Advisory Committee agendas/minutes have no API — useful as manual reference links on a
project-level board item elsewhere in the plan (see Bike-lane GIS proximity), not inputs to this
calendar feed.

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
