# bluesky-interactions

**Status:** Recommended — genuinely separate work from Instagram/Threads, not an extension of it.
**Priority:** Post-migration, non-blocking, and explicitly sequenced **after**
`instagram-threads-interactions` is stable.
**Owner:** Unassigned.
**Stack:** Hono + TypeScript — different shape from the Meta-based Worker (see below).

## The ask

Same per-contact interaction-tracking goal as Instagram/Threads (tie a mention or reply back to a
Donors-board item), but for Bluesky — recommended as a new platform elsewhere in the plan because
it's become the default home for transit/urbanist/bike-advocacy accounts since the Twitter/X
exodus.

## Why this is a separate Worker, not an extension

The [AT Protocol](https://docs.bsky.app/docs/category/http-reference) is free and open and needs
**no API key or app-review gate** (unlike Meta's Advanced Access review) — a genuinely lower
barrier to entry. But it's a different shape: a **firehose/subscription model**, not simple REST
webhooks. That's enough of an architectural difference that this isn't "add Bluesky to the
Instagram Worker" — it's its own build, sharing only the downstream pattern (match sender → Donors
item via the Social Media board).

## Data flow

```
AT Protocol firehose
  │  subscribe to mentions and replies directed at SVBC's account
  ▼
Cloudflare Worker (firehose subscriber)
  │  matches sender by Bluesky handle in the Social Media board
  │  enqueues a Cloudflare Queue message with the matched event
  ▼
Cloudflare Queue → consumer Worker
  │  writes the interaction via Monday's API to the matched Donor item
  │  on failure, Queues retries automatically and, once exhausted, routes to a Dead Letter
  │  Queue rather than the write silently disappearing
```

See `../README.md`'s Reliability section — the Queue step is standard across every webhook/
firehose-driven Worker in this plan. A firehose subscription in particular has no natural replay
of a missed event the way a polled API does, which makes this durability layer more important
here, not less.

Reuses the same Social Media board data model as Instagram (Donor board-relation, Platform,
Handle, Profile URL, Platform User ID, Source) — no schema changes needed, just a Bluesky row per
account.

## Sources

* [Bluesky HTTP API reference (AT Protocol)](https://docs.bsky.app/docs/category/http-reference)
* [Bluesky](https://bsky.app/)
* Plan section: Social media tracking (Integrations) — `migration-plan.md` (private planning repo)
