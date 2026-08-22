# quickbooks-sync — Design

**Status:** Approved design, pre-implementation.
**Worker README:** [`quickbooks-sync/README.md`](../../../quickbooks-sync/README.md) — the ask, priority, APIs & auth, and sources live there; this doc covers the build itself.

## Scope (v1)

Three QuickBooks Online entities, with an intentional asymmetry in direction:

- **Customers** — bidirectional. A Customer can originate in QuickBooks (synced to Monday as
  usual) or be created on Monday first (e.g. staff adds an Organization before it's ever
  invoiced), which must create a matching QuickBooks Customer.
- **Invoices** — QuickBooks → Monday only. Invoices are accounting-system artifacts; there's no
  workflow where staff originate one on Monday.
- **Products/Services** — QuickBooks → Monday only, same reasoning as Invoices.

Full bidirectional sync for all three was considered and rejected as scope not asked for by any
real workflow (YAGNI) — see the design conversation that produced this doc. If a genuine
Monday-originated invoice/product workflow shows up later, it's a new scope decision, not an
oversight here.

## Architecture

Two independent webhook-driven pipelines sharing one Worker, one D1 database, and one Cloudflare
Queue — matching the standard shape the root README establishes for every webhook-driven Worker in
this plan:

1. **QuickBooks webhook handler** (Hono route, `POST /webhooks/quickbooks`) — QuickBooks webhooks
   carry no payload, only "this entity id changed." Handler verifies the request, insert-or-ignores
   the notification into D1 `qb_events` (dedup by QuickBooks's own notification/event id), then a
   follow-up step calls the QuickBooks API to fetch the actual current record, and enqueues a Queue
   message referencing it.
2. **Monday webhook handler** (Hono route, `POST /webhooks/monday`) — receives a payload from a
   monday.com board automation ("when a new item is created in \[Customers board\]") configured to
   POST to this URL. Verifies the request, checks `qb_monday_map` — if the item is already linked
   to a QuickBooks Customer, ignore (this is an update, not a create, and Customers-from-Monday only
   handles net-new records in v1 per the Conflict Policy below); otherwise insert-or-ignore into D1
   `monday_events` and enqueue a Queue message.
3. **D1 database** — `qb_events`, `monday_events`, `qb_monday_map` (schemas below).
4. **Cloudflare Queue** — one queue, messages tagged with `direction: qb-to-monday | monday-to-qb`
   so the single consumer can branch. Automatic retry (3x default) on failure; once exhausted,
   routes to a Dead Letter Queue instead of the write silently disappearing.
5. **Queue consumer** (same Worker, separate handler) — for `qb-to-monday`: upserts the Monday item
   via `qb_monday_map`, unconditionally overwriting mapped fields (QuickBooks wins — see Conflict
   Policy). For `monday-to-qb`: creates a new QuickBooks Customer from the Monday item's fields,
   then writes the new QuickBooks id into `qb_monday_map`.

**Why the follow-up fetch happens in the QuickBooks webhook handler, not the consumer:** the
handler needs the real record to decide whether this is a create or update against
`qb_monday_map` before it's worth queuing at all. Re-fetching on every Queue retry would waste API
calls against QuickBooks's 500 requests/minute limit for no benefit — a failed *write* retries
without redoing the fetch.

## Data flow

```
QuickBooks Online                              Monday.com (Customers board — new items only)
  │ webhook: change notification (no payload)     │ board automation → webhook on new item
  ▼                                                ▼
QuickBooks webhook handler (Hono)               Monday webhook handler (Hono)
  │ 1. verify request                              │ 1. verify request
  │ 2. insert-or-ignore into D1 qb_events           │ 2. check qb_monday_map — skip if already linked
  │    (PK = QuickBooks notification/event id)      │ 3. insert-or-ignore into D1 monday_events
  │ 3. fetch changed record via QuickBooks API      │ 4. enqueue message (direction: monday-to-qb)
  │ 4. enqueue message (direction: qb-to-monday)    │
  ▼                                                ▼
Cloudflare Queue → consumer
  │ qb-to-monday: upsert Monday item via qb_monday_map, QuickBooks's value always wins on conflict
  │ monday-to-qb: create QuickBooks Customer, write new qb_id into qb_monday_map
  │ on failure: automatic retry (3x default) → Dead Letter Queue on exhaustion
  ▼                              ▼
Monday board (Customers/Invoices/Products —    QuickBooks Customer
 target board TBD, see Open Questions)
```

## Matching / identity linkage

A `qb_monday_map` D1 table is the sole source of identity linkage — no email or name matching
needed, since every record in this sync either originates in QuickBooks (has a `qb_id` from the
start) or originates on Monday and gets a `qb_id` written back the moment the QuickBooks Customer
is created. This is simpler than `funraise-sync`'s donor matching precisely because there's no
third system's historical data to reconcile against — QuickBooks and Monday are the only two
parties here.

| column | purpose |
|---|---|
| `entity_type` | `customer` \| `invoice` \| `product` |
| `qb_id` | QuickBooks record id |
| `monday_item_id` | Monday item id |
| `monday_board_id` | which board (per entity type, per config) |
| `created_at` | when the link was first established |

Primary key: (`entity_type`, `qb_id`). Unique index on (`entity_type`, `monday_item_id`).

## D1 schema: `qb_events`

One row per QuickBooks change notification; `event_id` as primary key is the dedup mechanism.

| column | purpose |
|---|---|
| `event_id` (PK) | QuickBooks's notification id |
| `entity_type` | `customer` \| `invoice` \| `product` |
| `qb_id` | the changed record's QuickBooks id |
| `fetched_payload` | full record as fetched from the QuickBooks API, for replay/debugging |
| `status` | `received` → `fetched` → `queued` → `written`, or `failed` |
| `error` | last failure reason, nullable |
| `received_at` / `written_at` | timestamps |

## D1 schema: `monday_events`

One row per Monday-originated Customer creation.

| column | purpose |
|---|---|
| `event_id` (PK) | derived: `monday_item_id` (a given item can only trigger this once, since post-link events are skipped at the handler) |
| `monday_item_id` | the new Monday item's id |
| `raw_payload` | full automation payload as received, for replay/debugging |
| `status` | `received` → `queued` → `written`, or `failed` |
| `qb_id` | set once the QuickBooks Customer is created |
| `error` | last failure reason, nullable |
| `received_at` / `written_at` | timestamps |

## Conflict policy: QuickBooks wins

QuickBooks is the accounting system of record. This needs no explicit "detect and reconcile"
machinery:

- **QuickBooks → Monday** sync unconditionally overwrites the mapped fields on every
  QuickBooks-triggered event.
- **Monday → QuickBooks** only ever *creates* — it never updates an existing linked record (the
  webhook handler skips events for items already in `qb_monday_map`). So there is no code path
  where a Monday edit is pushed as an update to QuickBooks.
- **Known, accepted limitation:** a Monday-side edit to a QuickBooks-owned field (e.g. someone
  changes a Customer's address directly on the Monday item) persists until the next real
  QuickBooks-side change to that same record triggers a re-sync. This is a staleness window, not a
  bug — building a periodic reconciliation pass to close it is scope nobody asked for (YAGNI); note
  it here so it's a documented tradeoff if it ever needs revisiting.

## Auth & QuickBooks production keys

Standard OAuth2 against QuickBooks, same pattern as every other Worker here. One concrete
pre-launch step this design surfaces (resolving the worker README's open question): **every app
requesting QuickBooks production API keys — including a private, single-company, never-listed
integration — goes through Intuit's assessment questionnaire** (legal/tech/security/platform).
There's no internal-use exemption from that step; the exemption that does exist is narrower (no
public Developer-Terms-acceptance flow for third-party end users, since there are none). Practical
implications for the build:

- Development proceeds freely against sandbox keys with zero review.
- Before go-live, submit the production-key assessment questionnaire — it asks for a host domain,
  launch URL, and disconnect URL even for an internal tool that will never be used by anyone but
  SVBC staff.
- Budget calendar time for this before any go-live date; per multiple developer-community reports
  it's typically fast for a single-company app with no live third-party users, but it is not
  skippable.

Sources: [Will I need to prepare for an app review to get Production keys for a private app?](https://help.developer.intuit.com/s/question/0D5TR00000fHVqB0AW/will-i-need-to-prepare-for-an-app-review-to-get-production-keys-for-a-private-app) · [Production keys & credentials for single company use only / internal use only](https://help.developer.intuit.com/s/question/0D54R00008fCxd7SAC/production-keys-credentials-for-single-company-use-only-internal-use-only) · [How can I get production API access... in-house data integration project](https://help.developer.intuit.com/s/question/0D54R00009olnsiSAA/how-can-i-get-production-api-access-to-my-qbo-data-if-i-dont-have-a-publicfacing-website-or-hosted-application-im-building-an-inhouse-data-integration-project-for-my-companys-data-were-building-a-data-warehouse-in-aws-and-need-some-data-from-qb)

## Monday-side webhook mechanism (unconfirmed — verify during implementation)

Monday.com's board automations ("when column changes, send a webhook") don't have the same
documented challenge/handshake mechanism as Monday's native item-level Webhooks API, and the exact
authenticity guarantees of an automation-triggered POST aren't confirmed here. Same treatment as
`funraise-sync`'s webhook-authenticity finding: treat the webhook URL itself as a credential
(secret, never logged), validate payload shape strictly as a second line of defense, and rely on
D1 dedup to make a replayed delivery harmless regardless of cause. Confirm the actual payload shape
and any signing headers against a real automation recipe before finalizing `validate.ts` for this
route.

## Config-driven field mapping

Own `config/svbc.json` in this worker (same per-worker pattern `funraise-sync` and
`salesforce-import` use — config lives with the worker that reads it):

```json
{
  "monday": {
    "apiUrl": "https://api.monday.com/v2",
    "boards": {
      "customers": null,
      "invoices": null,
      "products": null
    }
  },
  "quickbooksSync": {
    "columnMap": {
      "customer": { "<QuickBooks field>": "<Monday column id>" },
      "invoice": { "<QuickBooks field>": "<Monday column id>" },
      "product": { "<QuickBooks field>": "<Monday column id>" }
    },
    "itemNameField": {
      "customer": "DisplayName",
      "invoice": "DocNumber",
      "product": "Name"
    }
  }
}
```

All board ids and column maps are placeholders — **which existing Monday board(s) Customers should
target (Organizations, Donors, or a new board) is an explicit open decision for SVBC**, not
something this design resolves; Invoices and Products need new boards created regardless. Nothing
in the write-step code changes once these are filled in — it reads this object at runtime, same
guarantee `funraise-sync` makes.

## Error handling & reliability

- **QuickBooks webhook, malformed/unrecognized notification:** still return HTTP 200 (avoid
  triggering QuickBooks's own retry storm on something that will never parse) but log the D1 row
  with `status: failed` — visible for debugging, never silently dropped.
- **Monday-to-QuickBooks write failure, or Monday write failure** (rate limit, 5xx, network blip):
  handled by the Cloudflare Queue's automatic retry → Dead Letter Queue on exhaustion, per the root
  README's standard shape for every webhook-driven Worker in this plan.
- **DLQ visibility:** a Slack ping (native automation, no build) triggered on a message landing in
  the DLQ, same pattern as `funraise-sync`.

## Testing

- **Vitest** unit tests: `qb_monday_map` lookups (linked vs. unlinked), config-driven field
  mapping, payload validation for both webhook routes, conflict-policy behavior (Monday event for
  an already-linked item is skipped, not queued).
- **Integration-style test** for both full paths (QuickBooks webhook → D1 → fetch → Queue →
  consumer → Monday write; Monday webhook → D1 → Queue → consumer → QuickBooks create) using
  Miniflare's local D1/Queues and mocked QuickBooks/Monday API endpoints — no live calls in CI.
- Once a real QuickBooks sandbox company and a real Monday automation payload are available, add
  them as fixtures replacing the synthetic ones used above.

## Open items (not blocking the build)

- **Target Monday board(s)** for Customers, Invoices, and Products — unnamed; config placeholders
  (`null`) until SVBC decides. Per the design conversation, Customers may map to Organizations,
  Donors, or something else entirely.
- **QuickBooks production-key assessment questionnaire** — not blocking implementation (sandbox
  keys work for the whole build), but blocking go-live; see Auth section above.
- **Monday automation webhook payload shape and any signing mechanism** — unconfirmed; verify
  against a real automation recipe before finalizing the Monday-side webhook route.
- Real field mapping (which QuickBooks Customer/Invoice/Product fields map to which Monday
  columns) — config placeholders until SVBC's field-mapping decision is made, same gap
  `funraise-sync`'s spec has for its own mapping doc.
