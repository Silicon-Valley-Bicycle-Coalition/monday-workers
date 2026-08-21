# instagram-threads-interactions

**Status:** Decided — greenlit.
**Priority:** Post-migration, non-blocking. The Meta review process alone can run long and
unpredictably — start whenever bandwidth allows rather than racing the October deadline.
**Owner:** Unassigned.
**Stack:** Hono + TypeScript, D1 `events` table.

## The ask

Tie an Instagram comment or DM back to a specific Donors-board item — per-contact interaction
tracking. Nothing bought does this: not Buffer (posting/scheduling only), not the closest
Marketplace app ([Social Media Manager](https://www.upscale.tech/apps/monday/social-media-manager),
$30–300/mo, post-scheduling and per-post analytics only). This is build vs. do-without, not build
vs. buy.

## Prerequisite: data model

Before any webhook code, the Social Media board needs its item-per-(contact, platform) data model
in place (this is useful immediately, independent of the decisions below):
[Social Media board](https://bikesiliconvalley.monday.com/boards/8846927068), one item per
account. Fields: **Donor** (board-relation to Donors), **Platform** (status), **Handle** (text),
**Profile URL** (link), **Platform User ID** (text — matters most here, since Instagram webhook
events reference senders by numeric ID, not always by handle), **Source** (status: staff-entered
vs. auto-detected).

## Prerequisite: Meta review

**Required regardless of build details:** Meta Business verification + Advanced Access app review,
before any webhook can go live. This gate applies to both Instagram and Threads since both ride
the same Meta app.

## Data flow

```
Instagram Business account
  │  subscribed to Meta Webhooks: `comments`, `messages`
  ▼
Cloudflare Worker (webhook handler)
  │  1. verify `X-Hub-Signature-256` header against the Instagram App Secret
  │  2. store event in D1 `events` table
  │  3. matching step: look up sender in Social Media board
  │     (Platform User ID, falling back to Handle) → follow Donor board-relation
  │  4. enqueue a Cloudflare Queue message with the matched (or unmatched) event
  ▼
Cloudflare Queue → consumer Worker
  │  writes the interaction via Monday's API to the matched Donor item
  │  (unmatched senders → a holding group for manual linking, never dropped)
  │  on failure, Queues retries automatically and, once exhausted, routes to a Dead Letter
  │  Queue rather than the write silently disappearing
```

See `../README.md`'s Reliability section — the Queue step is standard across every webhook-driven
Worker in this plan, not Instagram-specific.

## Extending to Threads

Threads is the natural first extension, not a separate project: same Meta Business verification
and Advanced Access review already being done for Instagram, and Meta shipped
[reply and mention webhooks for Threads](https://www.threads.com/@threadsapi.changelog/post/DT_hJOrDB61/threads-api-update-january-reply-and-mention-webhooks-can-now-return-is)
in January 2026. Subscribe this same Worker to Threads' webhook topics alongside Instagram's,
matching senders the same way — do this as part of the same build, not a follow-on.

## APIs & auth

* **Meta Webhooks** (Instagram Graph API) — [Advanced Access approval guide](https://singhamandeep.com/instagram-api-advanced-access-approval/) ·
  [Instagram Graph API developer guide](https://elfsight.com/blog/instagram-graph-api-complete-developer-guide-for-2026/).
* Signature verification: `X-Hub-Signature-256` against the Instagram App Secret — every event
  must be verified before being trusted.

## Not in scope here

Bluesky is explicitly a **separate build** (`bluesky-interactions`) — different auth model
(AT Protocol firehose/subscription, not Meta webhooks), no shared code path with this Worker
beyond the general "match sender → Donor item" pattern.

## Sources

* [Instagram API Advanced Access Approval Guide (2026)](https://singhamandeep.com/instagram-api-advanced-access-approval/)
* [Instagram Graph API: Complete Developer Guide for 2026 (Elfsight)](https://elfsight.com/blog/instagram-graph-api-complete-developer-guide-for-2026/)
* [Threads API update — reply and mention webhooks (Jan 2026)](https://www.threads.com/@threadsapi.changelog/post/DT_hJOrDB61/threads-api-update-january-reply-and-mention-webhooks-can-now-return-is)
* [Social Media Manager (Upscale) — the bought alternative, ruled out](https://www.upscale.tech/apps/monday/social-media-manager)
* Plan section: Social media tracking (Integrations) — `migration-plan.md` (private planning repo)
