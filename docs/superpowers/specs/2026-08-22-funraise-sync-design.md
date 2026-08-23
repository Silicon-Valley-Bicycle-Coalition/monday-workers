# funraise-sync — Design

**Status:** Approved design, pre-implementation.
**Worker README:** [`funraise-sync/README.md`](../../../funraise-sync/README.md) — the ask, blocking precondition, APIs & auth, and sources live there; this doc covers the build itself.

## Scope (v1)

All four Funraise webhook event types: `Transaction`, `Subscription`, `Pledge`, `Registration`.

Routing to Monday boards:
- `Transaction` → Donations board (`donations:live` in `config/svbc.json`, board id `8845443596`)
- `Subscription` and `Pledge` → the **same** Recurring Gifts item type — confirmed 1:1 duplicate per the README, one code path handles both, keyed by whichever id Funraise sends
- `Registration` → target board is **not yet named** anywhere in the README or the private migration plan. Treated as an open config slot (`registrationBoardId: null` in `config/svbc.json`'s `monday.boards.event-registrations`, already present as a placeholder) rather than a blocker.

Double the Donation/360MatchPro and Streamlabs Charity are explicitly out of scope (per the worker README's "Related, not yet in scope" section) — not touched by this build.

## Architecture

Four components, matching the standard shape the root README establishes for every webhook-driven Worker in this plan:

1. **Webhook handler** (Hono route) — receives all four event types, one route per entity type (`POST /webhooks/funraise/:entityType`), since Funraise webhook subscriptions are configured per event type with their own target URL and the payload's own type discriminator field isn't confirmed yet (this is why entity type comes from the URL path, not the body — see "Real Funraise payload field names..." in Global Constraints). Each of the four URLs is a credential in the same sense the design's webhook-auth section describes and must be provisioned and kept secret individually. Handles the one-time `x-hook-secret` handshake, validates payload shape per entity type, strips the do-not-migrate PII fields, and upserts the event into D1's `events` table keyed on the *entity* (`entity_type` + the entity's own id from the payload body, per `funraiseSync.entityIdField`) — a later event for a known entity replaces its stored payload and re-enqueues instead of being dropped as a duplicate; only an exact redelivery of the same `event_id` short-circuits. Then enqueues a message referencing the entity onto a Cloudflare Queue.
2. **D1 database** — the `events` table (schema below).
3. **Cloudflare Queue** — decouples "ingested" from "written to Monday." Automatic retry (3x default, configurable) on failure; once exhausted, routes to a Dead Letter Queue instead of the match or write silently disappearing.
4. **Queue consumer** (same Worker, separate handler) — reads the queued message, performs donor matching (persisting the matched Donors-item id so retries don't re-match), then the Monday GraphQL write: `create_item` the first time, `change_multiple_column_values` on the existing item for later events for the same entity. Marks the D1 row `written`.

**Why matching happens in the queue consumer, not the webhook handler (decided 2026-08-22, reversing the original design):** in the handler, a transient Monday failure during matching had no retry path — the request still returned 200, so Funraise never redelivered, and the event died as a `failed` D1 row nobody saw. In the consumer, both matching and the write inherit the Queue's retries and DLQ. The original concern (re-matching on every write retry) is answered by persisting `matched_donor_item_id` on first success — retries skip matching.

**A daily cron** (`scheduled()` handler) empties `raw_payload` for events written more than `funraiseSync.rawPayloadRetentionDays` (default 90) days ago; combined with the ingest-time strip of `doNotMigrateFields`, denylisted PII never lands in D1 at rest and the rest of the payload has a bounded lifetime. Failed events keep their payload until resolved.

## Data flow

```
Funraise (SaaS)
  │  webhook: Transaction / Subscription / Pledge / Registration
  ▼
Webhook handler (Hono)
  │  1. handshake: echo x-hook-secret on subscription setup
  │  2. validate payload shape per entity type
  │  3. strip doNotMigrateFields, upsert into D1 events (unique on entity_type + entity_id;
  │     a new delivery for a known entity replaces the payload, an exact event_id
  │     redelivery is a no-op)
  │  4. enqueue message referencing the entity (5xx on enqueue failure so Funraise
  │     can redeliver — the upsert makes redelivery safe)
  ▼
Cloudflare Queue → consumer
  │  1. donor match: external-ID column → email fallback → auto-create new Donor item
  │     (skipped when matched_donor_item_id is already set)
  │  2. Monday GraphQL write: create_item on first sight, change_multiple_column_values after
  │  on failure at either step: automatic retry (3x default) → Dead Letter Queue on exhaustion
  ▼
Donations board / Recurring Gifts board / Registration board (ids in config/svbc.json)
```

## Donor matching

1. Look up the Donors board by the `funraise__fr_ID__c`-style external-ID column (exact match) — reuses the existing Salesforce-side external-ID convention rather than inventing a new one.
2. Fall back to email match if no ID match.
3. No match on either → **auto-create** a new Donors-board item from the Funraise contact fields, then proceed with the Donation/Recurring-Gift write against it. No manual-review queue in v1 — fully automated.

The exact Funraise payload field name(s) for donor email/contact aren't confirmed yet (same gap as the Monday field mapping below) — matching reads field names from the same config stub, so wiring the real names later doesn't touch matching logic.

## D1 schema: `events`

One row per Funraise *entity*; the unique index on (`entity_type`, `entity_id`) is the dedup mechanism (decided 2026-08-22 — an exact `event_id` redelivery is a no-op, while a new delivery for a known entity replaces the row's payload and flows through as an update to the existing Monday item).

| column | purpose |
|---|---|
| `event_id` (PK) | the latest delivery's Funraise event id |
| `entity_type` | `transaction` \| `subscription` \| `pledge` \| `registration` |
| `entity_id` | the entity's own id from the payload (`funraiseSync.entityIdField`); unique with `entity_type` |
| `raw_payload` | JSON as received minus `doNotMigrateFields`, for replay/debugging; emptied by the daily retention cron once written > `rawPayloadRetentionDays` ago |
| `matched_donor_item_id` | Monday Donors-board item id, set after matching |
| `monday_item_id` | Donations/Recurring-Gifts/Registration item id, set after write |
| `status` | `received` → `matched` → `queued` → `written`, or `failed` |
| `error` | last failure reason, nullable |
| `received_at` / `written_at` | timestamps |

## Config-driven field mapping

Reuses **`salesforce-import/config/svbc.json`**'s existing shape (already has a `monday.boards` registry with `donations:live: 8845443596` and `recurring-gifts: null` / `event-registrations: null` placeholders) rather than introducing a second config file — keeps board ids in one place instead of two workers drifting out of sync.

Add a `funraiseSync` section to that same file:

```json
"funraiseSync": {
  "columnMap": {
    "transaction": { "<funraise field>": "<monday column id>" },
    "recurringGift": { "<funraise field>": "<monday column id>" },
    "registration": { "<funraise field>": "<monday column id>" }
  },
  "emailFieldPrecedence": ["<placeholder>", "<placeholder>"],
  "statusValueMap": { "Posted": "<monday status label>" },
  "doNotMigrateFields": ["<placeholder: payment last-four>", "<placeholder: expiration>"]
}
```

All placeholders now; filled in once the real mapping doc (`docs/03-monday-migration-mapping.md`, private planning repo) is available. Nothing in the write-step code changes when they are — it reads this object at runtime.

**PII guarantee:** the write step only forwards fields present in `columnMap`. An unmapped field is dropped by default — not merely excluded via the `doNotMigrateFields` list, which is a secondary, explicit denylist for defense in depth (payment last-four, expiration).

## Webhook authenticity (spike finding, 2026-08-22)

Checked Funraise's public webhooks documentation directly: authentication is **handshake-only**. Funraise sends a signing secret in a request header during subscription setup; the endpoint must echo it back as `x-hook-secret` and return HTTP 200. Nothing in the docs describes a per-delivery signature, HMAC header, or replay-protection mechanism on individual event payloads — every subsequent delivery is authenticated only by possession of the webhook URL.

**Design response:**
- Treat the webhook URL itself as a credential — store as a secret, never log it, never surface it in client-visible config.
- Strict payload-shape validation per entity type as the second line of defense.
- D1 dedup by `event_id` makes a replayed or duplicate delivery harmless by construction, regardless of whether it was malicious or just a retried delivery.

This is a known, documented limitation — not a silent gap. Revisit if Funraise later confirms a real per-event signing mechanism.

## Error handling & reliability

- **Malformed/unrecognized payload:** still return HTTP 200 (no confirmation that Funraise has robust retry-on-4xx behavior, so a non-200 buys nothing) but log the D1 row with `status: failed` and the validation error — visible for debugging, never silently dropped.
- **Monday write failure** (rate limit, 5xx, network blip): handled by the Cloudflare Queue's automatic retry → Dead Letter Queue on exhaustion, per the root README's standard shape for every webhook-driven Worker in this plan.
- **DLQ visibility:** a Slack ping (native automation, no build) triggered on a message landing in the DLQ, so a persistent failure surfaces to a human instead of sitting invisible in a queue nobody's watching.

## Testing

- **Vitest** unit tests: donor-matching logic (ID match → email match → auto-create, each independently testable), config-driven field mapping (including the "unmapped field is dropped" PII guarantee), payload validation per entity type.
- **Integration-style test** for the full path (webhook → D1 → Queue → consumer → Monday write) using Miniflare's local D1/Queues and a mocked Monday GraphQL endpoint — no live Funraise or Monday calls in CI.
- Once real Funraise sandbox payloads are available, add them as fixtures replacing the synthetic ones used above — keeps tests honest against the real wire format.

## Open items (not blocking the build)

- `Registration`'s target Monday board is unnamed — config placeholder until decided.
- Real field mapping (`docs/03-monday-migration-mapping.md`) and exact Funraise payload field names — config placeholders until the private doc is available.
- Blocking precondition from the worker README (157 sync errors) — **resolved 2026-08-22**, reconciled directly against Funraise; see `docs/12-funraise-sync-error-fix.md` (private planning repo). The originally suspected case-sensitivity root cause was wrong.

**Found during the final whole-branch review (2026-08-22) — all three decided and implemented 2026-08-22:**

- **Dedup vs. update semantics** — decided: dedup is keyed on the *entity* (`entity_type` + `entity_id` from the payload body, per `funraiseSync.entityIdField`), not the delivery id. The first event creates the Monday item; later events for the same entity update it via `changeColumnValues`. This is correct whether Funraise's envelope `id` turns out to be per-delivery or per-entity, so the unconfirmed question no longer blocks deploy. When the field carrying the entity id is absent, dedup degrades to per-delivery (the envelope id) rather than dropping the event. Confirming the real payload field names from a sandbox remains a config task, not a code change.
- **Donor-match retry path** — decided: matching moved from the webhook handler into the queue consumer, where it inherits the Queue's 3 retries and DLQ. The handler is now validate → ingest → enqueue, and returns 5xx on an enqueue failure instead of falsely acknowledging the delivery. `matched_donor_item_id` persists on first success so write retries don't re-match.
- **`raw_payload` retention** — decided: both halves. `doNotMigrateFields` paths are stripped before the D1 insert (denylisted PII never lands at rest), and a daily `scheduled()` cron empties `raw_payload` for events written more than `funraiseSync.rawPayloadRetentionDays` (90) days ago. Failed events keep their payload until resolved.
