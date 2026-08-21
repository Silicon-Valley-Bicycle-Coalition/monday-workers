# buffer-content-calendar

**Status:** Recommended, not yet formally decided (unlike Instagram, this wasn't put through an
explicit greenlight decision in the plan — confirm before building).
**Priority:** Post-migration, non-blocking.
**Owner:** Unassigned.
**Stack:** Hono + TypeScript + D1, on an **hourly Cron Trigger**, D1 for dedup/diff state.

## The ask

Buffer is in active use by SVBC's social team but isn't linked to Monday. No native integration
exists, and Buffer's own API is publish/schedule only (no comments/DMs, no webhooks) — so this
Worker is a **content-calendar sync only**, not an interaction-tracking tool (that's
`instagram-threads-interactions` / `bluesky-interactions`).

## Data flow

```
Buffer GraphQL API
  │  hourly poll (comfortably within even the Free tier's limits)
  ▼
Cloudflare Worker
  │  diffs against D1 by post id / updated timestamp
  ▼
Social Media board (https://bikesiliconvalley.monday.com/boards/8846927068)
  writes/updates items
```

## Before finalizing

Confirm which Buffer plan the social team is actually on — it determines the safe poll interval
and whether hourly is conservative or already close to a limit.

## Platform coverage, for free

Buffer already natively schedules to both of the plan's recommended new platforms —
[Bluesky](https://buffer.com/bluesky) and [Threads](https://support.buffer.com/article/857-using-threads-with-buffer).
Once staff starts posting there, this sync picks them up automatically with **no
platform-specific work** — don't build separate ingestion for Bluesky/Threads *posting* (as
opposed to *interaction tracking*, which is a separate concern — see `bluesky-interactions`).
Reddit isn't a confirmed Buffer platform and typically isn't well-suited to bulk scheduling
anyway — treat Reddit posting as manual, outside this Worker's scope entirely.

## APIs & auth

* **Buffer GraphQL API** — [API overview](https://buffer.com/made-for/developers) ·
  [rate limits](https://developers.buffer.com/guides/api-limits.html).

## Sources

* [What is Buffer's API?](https://support.buffer.com/article/859-does-buffer-have-an-api)
* [Social Media API for Developers](https://buffer.com/made-for/developers)
* [Buffer API rate limits](https://developers.buffer.com/guides/api-limits.html)
* [Schedule to Bluesky with Buffer](https://buffer.com/bluesky)
* [Using Threads with Buffer](https://support.buffer.com/article/857-using-threads-with-buffer)
* Plan section: Social media tracking (Integrations) — `migration-plan.md` (private planning repo)
