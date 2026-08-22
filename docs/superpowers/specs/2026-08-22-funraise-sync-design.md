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

1. **Webhook handler** (Hono route) — receives all four event types on one endpoint. Handles the one-time `x-hook-secret` handshake, validates payload shape per entity type, writes the raw event to D1's `events` table (insert-or-ignore on Funraise's event id — this is the dedup mechanism), performs donor matching, then enqueues a message referencing the D1 row onto a Cloudflare Queue.
2. **D1 database** — the `events` table (schema below).
3. **Cloudflare Queue** — decouples "matched, ready to write" from "written to Monday." Automatic retry (3x default, configurable) on failure; once exhausted, routes to a Dead Letter Queue instead of the write silently disappearing.
4. **Queue consumer** (same Worker, separate handler) — reads the queued message, performs the actual Monday GraphQL write (create/update the appropriate item type), marks the D1 row `written`.

**Why matching happens in the webhook handler, not the consumer:** matching only needs Donors-board state at ingest time. Doing it in the consumer would mean re-matching on every Queue retry — wasted API calls, and a source of drift if the board changes between retries. A failed *write* retries without redoing the match.

## Data flow

```
Funraise (SaaS)
  │  webhook: Transaction / Subscription / Pledge / Registration
  ▼
Webhook handler (Hono)
  │  1. handshake: echo x-hook-secret on subscription setup
  │  2. validate payload shape per entity type
  │  3. insert-or-ignore into D1 events (PK = Funraise event id)
  │  4. donor match: external-ID column → email fallback → auto-create new Donor item
  │  5. enqueue message referencing the D1 row
  ▼
Cloudflare Queue → consumer
  │  Monday GraphQL write (create/update Donations, Recurring Gifts, or Registration item)
  │  on failure: automatic retry (3x default) → Dead Letter Queue on exhaustion
  ▼
Donations board (8845443596) / Recurring Gifts board / Registration board (TBD)
```

## Donor matching

1. Look up the Donors board by the `funraise__fr_ID__c`-style external-ID column (exact match) — reuses the existing Salesforce-side external-ID convention rather than inventing a new one.
2. Fall back to email match if no ID match.
3. No match on either → **auto-create** a new Donors-board item from the Funraise contact fields, then proceed with the Donation/Recurring-Gift write against it. No manual-review queue in v1 — fully automated.

The exact Funraise payload field name(s) for donor email/contact aren't confirmed yet (same gap as the Monday field mapping below) — matching reads field names from the same config stub, so wiring the real names later doesn't touch matching logic.

## D1 schema: `events`

One row per Funraise event; `event_id` as primary key is the dedup mechanism (insert-or-ignore makes a re-delivery a no-op if already processed, and safely retriable if it wasn't).

| column | purpose |
|---|---|
| `event_id` (PK) | Funraise's event id |
| `entity_type` | `transaction` \| `subscription` \| `pledge` \| `registration` |
| `raw_payload` | full JSON as received, for replay/debugging |
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
- Blocking precondition from the worker README (157 sync errors, ~11 supporters missing from Salesforce due to the `Contact.Primary_Email__c` case-sensitivity bug) doesn't block *building* this Worker, only trusting historical data its donor-matching logic is tested against — noted here for continuity, not a v1 build task.
