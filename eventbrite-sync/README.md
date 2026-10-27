# eventbrite-sync

**Staff UAT script:** [`docs/uat/eventbrite-sync.md`](../docs/uat/eventbrite-sync.md) — what a non-technical tester can try in the sandbox and what they should see. Keep it in step with this README.

**Status:** Built (`feat/eventbrite-orders`, 2026-10-06; design:
[`docs/superpowers/specs/2026-10-06-eventbrite-orders-design.md`](../docs/superpowers/specs/2026-10-06-eventbrite-orders-design.md))
— **not deployed anywhere yet.** Blocked on prerequisites nobody has done: the `Eventbrite Order
ID` column's id in config (see "Prerequisite column"), an Eventbrite private token, D1 and queue
provisioning, the three secrets, and the webhook registration. The `Refunded` Status label it
shares with `funraise-sync` is also still missing from the board.
**Attendee feed and class emails:** built on `feat/eventbrite-attendees` (2026-10-26; design:
[`docs/superpowers/specs/2026-10-26-eventbrite-attendees-class-emails-design.md`](../docs/superpowers/specs/2026-10-26-eventbrite-attendees-class-emails-design.md);
see "Attendee feed and class emails" below). Rehearsed in the sandbox only; production still needs
the items in "Open".
**Priority:** Post-cutover (2026-10-23). Bike Summit 2026 (Oct 22) now sells out *before*
cutover, so `eb4sf` puts its orders in Salesforce and `salesforce-import` carries them over as
Event Ticket gifts with their order ids; this Worker takes every order after that, and the
backfill (below) covers the gap between the final extract and the webhook registration. Decision that it counts as giving: migration repo issue #56 (2026-09-30).
**Owner:** David (decided 2026-10-09).
**Stack:** Hono + TypeScript + D1 + Cloudflare Queues (the shared stack, see `../README.md`).

## The ask

SVBC's events sell tickets on Eventbrite. Today the `eb4sf` package writes each order and
attendee into Salesforce, where paid tickets have never been treated as gifts. On 2026-09-30 the
migration decided they are: **after cutover, every paid Eventbrite order becomes a Donations item
with Status `Received` and Gift Type `Event Ticket`** — the same labels `funraise-sync` writes for
a paid Funraise ticket — linked to the buyer on People by email. Nothing does this today, and
`eb4sf` retires with Salesforce. This Worker is the replacement.

The orders feed is one half. One order is one gift, however many tickets it holds; the buyer is
the donor. The other half (2026-10-26) is an **attendee feed**: a second webhook keeps the Events
and Event Registrations boards in step with Eventbrite, and an hourly job sets the morning-after
**Follow-up Email** label that fires the Bike Education thank-you and missed-you emails from
Monday (see "Attendee feed and class emails"). The Worker itself never sends email.
`svbc-calendars`, the other Eventbrite consumer in this repo, reads the public event feed for the
website and never sees orders or attendees.

## Data flow

```
Eventbrite (SaaS)
  │  one organization-wide webhook: order.placed, order.updated, order.refunded
  │  { "api_url": "https://www.eventbriteapi.com/v3/orders/<id>/",
  │    "config": { "action": "order.placed", "user_id": "<org>", "webhook_id": "…", "endpoint_url": "…" } }
  ▼
Cloudflare Worker (webhook handler)   POST /webhooks/eventbrite/order?secret=…
  │  1. verify the shared secret (constant time); unsubscribed action → 200, ignored
  │  2. take the order id out of api_url — host and path must match, nothing else is read
  │  3. upsert D1 `orders` keyed on the order id; enqueue { orderId, action }; 500 if that fails
  ▼
Cloudflare Queue → consumer (one at a time)
  │  1. GET /v3/orders/{id}/?expand=event with the Worker's own private token
  │  2. map: status → label (placed → Received, refunded → Refunded, else skip), amount = gross,
  │     Date = Pacific day of `created`, item name "{buyer} - {event}", fiscal year
  │  3. donor: cached on the row, else People lookup by email, else create
  │  4. write: ledger item → update; else adopt by Eventbrite Order ID → update; else create
  │     with the first-write stamps (Thank You Sent, Gift Type, Fiscal Year Ending)
  │  failure → retry with backoff (1, 4, 16 min) → dead-letter consumer marks the row and logs
  ▼
Donations board (+ Donor link to People; ids in config/sandbox.json, svbc.json for production)
```

**The delivery is a trigger, never a source.** Eventbrite's webhook carries only a pointer, so the
consumer fetches the order at processing time. That is why out-of-order deliveries don't matter
(whatever Eventbrite says now is what gets written), why a redelivery is enqueued rather than
deduped (one extra fetch, an idempotent write, never a second item), and why the D1 ledger holds
**no name, email or payload** — nothing personal at rest, so unlike `funraise-sync` there is no
retention purge. (The hourly cron is for the class follow-ups and the daily missed-order check.) See `../README.md`'s Reliability section for why the Queue shape is
standard across every webhook-driven Worker here.

## APIs & auth

* **Eventbrite API v3** — [reference](https://www.eventbrite.com/platform/api) (rendered from the
  [API blueprint](https://www.eventbrite.com/platform/new/docs/eventbrite-api-v3-public.apib),
  which is the readable source) · [Webhooks guide](https://www.eventbrite.com/platform/docs/webhooks).
  Base `https://www.eventbriteapi.com/v3`, `Authorization: Bearer <private token>`. This Worker
  makes exactly one call per message, `GET /orders/{order_id}/?expand=event`; the backfill
  script adds `GET /events/{event_id}/orders/`. Nothing here writes to Eventbrite.
* **`EVENTBRITE_PRIVATE_TOKEN`** — `wrangler secret put EVENTBRITE_PRIVATE_TOKEN` (and
  `--env sandbox`). Mint it from SVBC's organizer account: Account Settings → Developer Links →
  API Keys → Create API Key → *Private token* (blueprint, "Get a Private Token"). Eventbrite has
  **no read-only or per-resource scope**: the token acts as the user that minted it and can read
  every order on the account, so treat it like the Monday token (least privilege by *who* mints
  it — a staff login that only administers events, not a personal account with other
  organizations attached). Unset → every message fails and dead-letters naming the secret.
* **Webhook auth.** Eventbrite documents **no signature, no HMAC header and no verification
  handshake** for webhook deliveries (the blueprint's Webhook object is `id`, `resource_uri`,
  `created`, `actions`, `user_id`, `event_id`; third-party guides that show an
  `x-eventbrite-signature` header cite no Eventbrite source and are not relied on). So, as with
  Funraise:

  1. `wrangler secret put EVENTBRITE_WEBHOOK_SECRET` (`openssl rand -hex 32`).
  2. Register the webhook URL **with the secret embedded**:
     `https://<worker-host>/webhooks/eventbrite/order?secret=<value>`.

  The route **fails closed**: any POST whose secret doesn't match — including every POST while
  the secret is unset — is 401. Comparison is constant-time (SHA-256 both sides, then an
  early-exit-free byte compare, copied from funraise-sync #25). Callers that can set headers
  (`scripts/backfill-orders.mjs`, a hand replay) send `X-Webhook-Secret` instead, which is
  checked first. Eventbrite itself can't: its webhook form takes a URL and the actions. The
  tradeoff and mitigations are the ones in funraise-sync's README (the secret lands wherever the
  full request URL is logged; keep observability access tight, never log `c.req.url`, rotate by
  re-registering).

  On top of the secret, **the payload is never trusted for data**: the only thing read from it is
  the order id, after `api_url` is checked against `eventbrite.apiUrl` + `/orders/<digits>/`
  (host, path, no query, no credentials). Everything written to Monday comes from the Worker's
  own authenticated fetch, so a forged delivery can at most make the Worker re-read a real order.
  When `eventbrite.organizationId` is set in config, a delivery whose `config.user_id` names
  another organization is acknowledged and ignored — a sanity filter, not an auth control.
* **Registering it** (not done yet): Eventbrite → Account Settings → Developer Links → Webhooks
  → Add Webhook: Payload URL = the full URL above, Event = *All events* (no `event_id` filter:
  every paid order anywhere is giving), Actions = `order.placed`, `order.updated`,
  `order.refunded`. Or via the API, `POST /v3/organizations/{organization_id}/webhooks/` with
  `{ "endpoint_url": "…", "actions": "order.placed,order.updated,order.refunded" }`. Eventbrite
  allows many webhooks per organization, so the sandbox keeps its own beside production's. The
  dashboard's **Test** button and its per-webhook delivery log are the way to see deliveries
  from Eventbrite's side; a Test delivery that points at a non-existent order is marked `failed`
  ("not found in Eventbrite") and acked, never retried. The blueprint says a non-2xx answer is
  retried but gives no schedule — read it off the delivery log.
* **Monday.com GraphQL API** — standard token, same pattern as every other Worker here; the
  sandbox reuses the shared `Sandbox Integration` user, production gets a dedicated integration
  user (root README "Least-privilege Monday tokens"; run
  `node ../scripts/check-monday-token-scope.mjs` before calling it scoped).

## Prerequisite column: `Eventbrite Order ID`

The idempotency key is the Eventbrite order id, stored in a **text** column titled
**`Eventbrite Order ID`** on the Donations board, config `eventbriteSync.orderIdColumn`.
`salesforce-import` declares it on every migrated gift (2026-10-19), so its `load` creates the
column on the next sandbox load and on the production cutover load — no hand-made column. After
each load, read the column id from `salesforce-import/data/load/boards.json` (or the board), put it in
`config/sandbox.json` (and `config/svbc.json` at cutover) and tighten `config/split.test.ts`
(move `orderIdColumn` into its `COLUMN_KEYS`). Text, not link: nothing in Eventbrite's organizer
UI deep-links an order by id, and a bare-text exact match is the simplest lookup.

Until then both configs ship `REPLACE_WITH_COLUMN_ID`. **The route still accepts and stores
deliveries** (so nothing is lost while the column is pending), and **the consumer refuses to
write** — each message fails with a message naming the key, retries, and dead-letters. Once the
column exists and the config is deployed, re-drive with `scripts/backfill-orders.mjs` for each
affected event. Nothing is ever created without its key, so nothing can be duplicated later.

### Adopt before create

Before creating, the consumer looks the order id up in that column (`items_page_by_column_values`,
the same lookup `funraise-sync` does on `Funraise ID`) and updates a hit instead. That covers this
Worker's own orphans (a create whose D1 update was lost), a backfill re-run, and a gift staff
entered by hand with the id filled in. An adopted item gets only the order-owned columns
(Amount, Status, Date, the id) — never the first-write stamps and never the Donor link, exactly
as funraise-sync treats migrated gifts. Same known gap: archived items aren't visible to the
lookup.

`salesforce-import` **does** migrate Eventbrite orders as Donations items: `eb4sf` files each paid
order as a Closed Won Opportunity, which the importer maps to Received / Event Ticket (#43), and
it stamps `Eventbrite Order ID` from the `eb4sf__Eventbrite_Order__c` record linked to that
Opportunity (the order record's `Name` is Eventbrite's order id). So a webhook or backfill for an
order placed before the final extract adopts the migrated item instead of creating a second one.
Adopting overwrites Amount, Status and Date with what Eventbrite reports now (a refund since the
extract shows as `Refunded`) and leaves the importer's Donor link alone. Coverage, checked live on
2026-10-19: every 2026 Eventbrite-created Closed Won has a linked order; 206 from 2024–2025 have
none and migrate with a blank id, so **never backfill an event that sold tickets before 2026** —
those orders would be created a second time.

## Monday targets (sandbox v3 ids, from funraise-sync's config, read live 2026-09-30)

`config/sandbox.json` points at the same Donations (sandbox v3) and People (sandbox v3) columns
`funraise-sync` writes, on purpose: a Funraise ticket and an Eventbrite ticket should be
indistinguishable on the board. Re-verify against production ids at cutover.

| Config key | Board / column | Id | Notes |
|---|---|---|---|
| `monday.boards["donations:live"]` | Donations (sandbox v3) | `18431577310` | the only write target |
| `monday.boards["people-live"]` | People (sandbox v3) | `18431577220` | People (Historical) is not a match target |
| `eventbriteSync.orderIdColumn` | Donations → **Eventbrite Order ID** (text) | **missing — prerequisite** | bare order id; the adopt-before-create key |
| `eventbriteSync.amountColumn` | Donations → Amount (numbers) | `numeric_mm79nz8b` | `costs.gross.major_value` as a number — see "Amount" |
| `eventbriteSync.statusColumn` | Donations → Status (status) | `color_mm79q3b3` | `placed → Received`, `refunded → Refunded` via `statusLabelMap`; **`Refunded` is not yet a label on the board** (funraise-sync's open item) |
| `eventbriteSync.dateColumn` | Donations → Date (date) | `date_mm7938jk` | the Pacific calendar day of the order's `created` |
| `eventbriteSync.thankYouSentColumn` | Donations → Thank You Sent (checkbox) | `boolean_mm7ddybs` | first write only; Eventbrite sends the buyer its own confirmation |
| `eventbriteSync.giftTypeColumn` / `giftTypeValue` | Donations → Gift Type (text) | `text_mm79fzs3` / `Event Ticket` | first write only; the label `donation-rollups`' membership rule excludes |
| `eventbriteSync.fiscalYearColumn` | Donations → Fiscal Year Ending (text) | `text_mm7973ah` | first write only, derived from the same date as the Date column |
| `eventbriteSync.donorEmailColumn` | People → Personal Email (email) | `email_mm79m5qa` | lookup by bare address; create writes `{ email, text }` |
| `eventbriteSync.donorLinkColumn` | Donations → Donor (connect) | `board_relation_mm795r2d` | `{ item_ids: [n] }` |

## Field mapping

| Eventbrite (Order object, `?expand=event`) | Donations | Rule |
|---|---|---|
| `id` | Eventbrite Order ID | bare string |
| `status` | Status | `statusLabelMap`; `placed` and `refunded` only. `started`, `pending`, `abandoned` and anything else are **not giving**: the row is marked `skipped` with the status named and nothing is written. A later delivery re-evaluates from scratch. |
| `costs.gross.major_value` | Amount | see "Amount" |
| `created` | Date, Fiscal Year Ending | `toISODate` → `America/Los_Angeles` calendar day (#25 rule); FY = July–June year it ends in, first write only |
| `name` (fallback `first_name` + `last_name`) + `event.name.text` | item name | `itemNameTemplate`, default `{buyer} - {event}` → `Jane Rider - Bike Summit 2026`; the board has no notes column, so the event lives in the name |
| `email`, `name` | Donor → People | match by email, create if new — see "Donor matching" |
| — | Thank You Sent, Gift Type | stamps, first write only |

**Amount.** `costs.gross` — "the total amount the buyer was charged" — fees and tax included.
Eventbrite's service fee and the payment-processing fee are **not** deducted: the gift is recorded
gross, as Funraise gifts are (processing fees are a books-side cost for QuickBooks, not a
reduction of the gift). SVBC collects no sales tax on tickets, so `tax` is normally 0; if it
were not, it is inside `gross` too. `costs.gross` is already net of any promo-code discount. A
fork that wants organizer revenue net of Eventbrite's fees sets `amountSource: "base_price"`.
**Free orders** (`gross` 0, or no `costs`) with no Donations item yet are skipped — a free
registration is not a gift. An order that already has an item is always updated even at 0, so a
refund can never be masked by the skip. A **refunded** order with no item yet is skipped too: nothing was ever recorded as received, so there is nothing to reverse. If staff delete or archive an order's item, a later update is recorded `failed` ("deleted or archived") and acked, not retried or recreated.

## Donor matching

`funraise-sync`'s `matchDonor` minus the Funraise-profile step: Eventbrite has no stable buyer id
worth a People column, so the order's `email` is the whole key. One `items_page_by_column_values`
on People's Personal Email column with the bare address (verified live for funraise-sync
2026-09-17 on that column); a hit links it, a miss creates a People item named from the order's
`name` with `{ email, text }` in the email column, so a buyer this Worker creates looks like a
migrated person. The match is cached on the ledger row, so a retry or a later `order.updated`
doesn't re-run it. An order with no email is written **without** a Donor link and a warning (order
id only); a later update with an email picks the link up. A Monday failure during the match
throws — retry, then DLQ — a gift without a donor is worse than a late one.

## Failures and the dead-letter queue

A failed consumer run marks the `orders` row `failed` with the error and retries the message with
backoff — 1 minute, doubling to a cap of 1 hour (`retryDelaySeconds` in `src/flags.ts`). After
`max_retries` (100, about four days) the message goes to `eventbrite-sync-writes-dlq` (`…-sandbox-dlq` in the
sandbox), which this Worker also consumes (`src/consumer/processDeadLetters.ts`): the row's
error is prefixed `dead-lettered after retries: ` and the batch logs one `console.error` naming
the order ids. A 404 from Eventbrite is **not** retried: the row is marked `failed` ("not found in
Eventbrite") and acked. To find dead orders:
`select order_id, event_id, error, received_at from orders where error like 'dead-lettered%'`.
Re-drive by re-running `scripts/backfill-orders.mjs` for the affected event once the cause is
fixed; adopt-before-create makes it safe for the orders that did land.

## Missed-order check (daily)

Failed writes are loud, but a webhook that was deleted, disabled or repointed fails nothing: orders
just stop arriving. So at 15:00 UTC (07:00 or 08:00 Pacific), on one of the hourly cron runs,
`src/missedOrders/check.ts` lists the organization's orders changed in the last 26 hours
(`GET /organizations/{id}/orders/?status=all_not_deleted&changed_since=…`) and looks each id up in
the `orders` ledger. Orders changed in the last 30 minutes are skipped as possibly still in
flight. Any order Eventbrite has that the ledger doesn't gets one `console.error` naming the ids,
which Workers Issues raises; a clean check logs one info line. A day with no sales is not an alarm.
It replaces Salesforce's *Today's Eventbrite Orders Report* subscription, which emailed on every
day with no `eb4sf` orders (svbc-monday-migration #90, `docs/35` §3.6).

It reads with `EVENTBRITE_PRIVATE_TOKEN`; unset, it logs an error and skips. With
`eventbrite.organizationId` null it uses the token's only organization (`GET /users/me/organizations/`)
and fails if the token has more than one. To act on an alarm: check the webhook in Eventbrite
(Account Settings → Developer Links → Webhooks), then re-drive the affected events with
`scripts/backfill-orders.mjs` below.

## Backfill: the Oct 22 Summit, and any later gap

```sh
cd eventbrite-sync
EVENTBRITE_PRIVATE_TOKEN=… node scripts/backfill-orders.mjs --event-id <id> --dry-run
EVENTBRITE_PRIVATE_TOKEN=… EVENTBRITE_WEBHOOK_SECRET=… node scripts/backfill-orders.mjs \
  --event-id <id> --worker-url https://svbc-eventbrite-sync.<subdomain>.workers.dev [--changed-since 2026-10-23T00:00:00Z]
# sandbox: --env sandbox --worker-url https://svbc-eventbrite-sync-sandbox.<subdomain>.workers.dev
# (the script refuses an --env that doesn't match the Worker URL)
```

The script lists the event's orders (`GET /v3/events/{event_id}/orders/?status=all_not_deleted`,
following `pagination.continuation`), keeps the `placed` and `refunded` ones, and POSTs each to
the deployed Worker as the delivery Eventbrite would have sent — a pointer built from the
configured API base and the order id, `order.placed` or `order.refunded` as the action, the
secret in `X-Webhook-Secret`. Every order then takes the normal route → ledger → consumer path
(fetched fresh from Eventbrite, matched, adopted or created), so the backfill exercises exactly
the code the live webhook will, and a re-run is a no-op. It never touches D1 or Monday itself.
Nothing personal is printed: ids and statuses only.

**Procedure for Bike Summit 2026:** after cutover and once this Worker is in production with
the column id in config (see "Deploy"), run it once with the Summit's event id — the event id is
in the manage-page URL (`…/myevent?eid=<id>`) or from `GET /v3/organizations/{org}/events/`. Do
the same for any other event that sold tickets between the final Salesforce extract and the
webhook registration. Orders the cutover load already carried over are adopted, not duplicated
(see "Adopt before create"), so the dry-run's order count includes them; the real run only
creates what landed after the extract.
**Owner and deadline (issue #44).** Run it on or after **2026-10-23**, once Summit sales have
closed, by David (the Worker's owner, decided 2026-10-09). Pre-flight, in order: the
`Eventbrite Order ID` column and `Refunded` label exist on production Donations; `config/svbc.json`
has no `REPLACE_WITH_COLUMN_ID` left; the Worker is deployed and the webhook registered; then
`--dry-run`, compare its order count with the Eventbrite attendee/orders report, then the real
run. If the Worker cannot be in production by then, `--dry-run` still needs only the read-only
token and lists the paid orders (ids and statuses, no PII) — use it as the checklist for a
manual entry on Donations (Gift Type `Event Ticket`, the order id in `Eventbrite Order ID` so a
later backfill adopts the item instead of duplicating it).
An order refunded before the Worker ever saw it has no item to reverse, so it is recorded as `skipped` and nothing is written; one with an item is updated to `Refunded`. The consumer runs one
message at a time, so a few hundred orders take a few minutes; then check the board and
`select status, count(*) from orders where event_id = '<id>' group by status`.

## Attendee feed and class emails

Replaces the Salesforce `eb4sf` Campaigns Bike Education sent class emails from (migration repo
issue #62). Eventbrite is the source of who registered and who checked in; Monday sends the mail.

```
Eventbrite (SaaS)
  │  second webhook: attendee.updated, attendee.checked_in, attendee.checked_out,
  │  event.created, event.published, event.updated, event.unpublished   (attendeeSync.actions)
  ▼
Worker   POST /webhooks/eventbrite/attendee   (same shared secret: X-Webhook-Secret or ?secret=)
  │  ledger rows in D1 (migration 0002_attendees.sql: `events` and `attendees`, ids and status
  │  only, no personal data), then the same queue → consumer fetches the attendee or event fresh
  ▼
Events board (one item per Eventbrite event, program from the organizer name)
Event Registrations board (one item per attendee: Attendance, Class Type/Date/Day/Location, People link)
  ▲
Hourly cron  0 * * * *  → follow-up job sets Event Registrations → Follow-up Email
  ▼
Monday automation (label → Sequence enrollment) → email from learn@
```

As with orders, the delivery is only a pointer; what is written comes from the Worker's own fetch.
The **program** is resolved from the organizer name suffix (same rule as `salesforce-import`);
`attendeeSync.programByOrganizer` is an optional override by organizer id. Attendance is never
downgraded (a check-in is not undone by a later `attendee.updated`), and the People link is set
only once the attendee is Attended and never overwrites a link staff set. Item names follow
Eventbrite: rename a class or attendee there, since a rename in Monday is overwritten by the next
delivery.

### Prerequisites

* Config `attendeeSync` ids for the Events and Event Registrations columns, `peopleEmailColumn`,
  and `followups.notifyUserId` (the Bike Education coordinator's Monday user id, for the Held
  notice). Production ships
  `REPLACE_WITH_COLUMN_ID` / `null` until set.
* `Attendee Email` must be an **Email** column on Event Registrations. `salesforce-import` only
  creates missing columns, so a production board already loaded with a text column needs it
  converted.
* The Monday-side setup (Mass email templates, Sequences, automations, the Class reminders view,
  `learn@`) is [`docs/class-emails-setup.md`](docs/class-emails-setup.md). Sequences only work on
  boards in a monday CRM workspace, so production Events and Event Registrations must live in one.
* Register the second webhook (below).

### Registering it

Same dashboard route as the order webhook: Payload URL
`https://<worker-host>/webhooks/eventbrite/attendee?secret=<EVENTBRITE_WEBHOOK_SECRET>`, Event =
*All events*, Actions = the list in `attendeeSync.actions` in config. Sandbox keeps its own.

### Follow-up rules

The cron looks at Events that have **Class Type** set and **Follow-ups** blank, are in this
Worker's own `events` ledger, are past **08:00 Pacific the day after End**, ended no more than
`followups.maxAgeDays` (3) days ago, and are not canceled. For each:

* Nobody **Attended** (no check-ins at all): the event is set to **Held** and `notifyUserId` is
  notified. Clearing Held re-runs it, but only within the 3 days.
* **Attended** registrations get `Thank-you: <class type>`. **Registered** ones get
  `Missed-you: <class type>` and Attendance becomes **No Show**. Canceled, No Show and
  registrations with no email get nothing.
* One label per email address per class (a shared address gets one email, thank-you wins). A retry
  skips addresses already labelled.
* A class with no registrations (or whose registrations are all deleted or archived in Monday)
  is skipped; a deleted or archived registration gets nothing. Registrations added by hand in
  Monday (not via Eventbrite) get no follow-up.
* Just before a missed-you is written, that registration's Attendance is read again; anyone
  checked in since the run started gets nothing rather than a missed-you.
* After labelling, the event's **Follow-ups** is set to **Sent**: that is the run-once guard.
* The label is `Thank-you: ` / `Missed-you: ` plus the Class Type text, so a Class Type with no
  matching Follow-up Email label makes Monday reject the write: the event logs `failed` every hour
  (nothing sent, Follow-ups stays blank) until the label is added — the setup checklist covers
  adding both labels for every Class Type.

**Only events in this Worker's own ledger can send, but any of them can.** A class migrated from
Salesforce, or created in Monday by hand, is never in the ledger and never emails. A class that
*is* in the ledger — because a webhook arrived, or because `backfill-attendees.mjs` or a
redelivery put it there — sends as soon as it is within the window above with Class Type set and
Follow-ups blank, even if it was already emailed by hand. So at cutover, after any backfill, set
**Follow-ups = Sent** on every class that ended in the last 3 days and was already emailed by hand
(the setup checklist's cutover step).
The hourly summary line is `eventbrite-sync follow-ups: sent N, held N, skipped N, failed N`; a
sweep that throws logs `sweep failed`.

**Accepted risk: partial check-in.** If staff check in only some of the people who came, the rest
get a missed-you. The Held case covers nobody checked in; partial check-in cannot be detected.
Staff should finish check-in before 08:00 the next morning.

### Backfill

`scripts/backfill-attendees.mjs` replays an event's attendees to the deployed Worker, as the order
backfill does: flags `--event-id`, `--worker-url`, `--env`, `--pause-ms`, `--dry-run`. Use it for a
class that predates the webhook. A backfilled class that ended more than 3 days ago is never
emailed; one that ended within 3 days **will** be once its Class Type is set and Follow-ups is
blank — see "Follow-up rules" above, and set Follow-ups = Sent first if it was already emailed by
hand.

## Out of scope (follow-ups)

* **Order ↔ registration link.** A ticket's Donations item still has no link to its Event
  Registrations item; the attendee feed keys on `Eventbrite Attendee ID`, orders on the order id.
* **Per-attendee gifts.** One order = one item; the buyer is the donor.
* **Partial refunds.** An order with some attendees refunded stays `placed`; it is written as
  `Received` with whatever `gross` Eventbrite now reports. Whether that `gross` reflects the
  refund is not stated in the blueprint — verify on the first real one, then decide whether to
  compute from `attendees[].costs`.
* **Historical orders** come over from Salesforce, not from here: `salesforce-import` migrates
  every eb4sf ticket gift (with its order id where Salesforce linked one, i.e. all of 2026). Don't
  point the backfill at older events — see "Adopt before create".
* **Multi-currency.** `currency` is stored, not converted; SVBC's events are USD.

## Sandbox environment — inbound only, no outbound data

Same split as every migration Worker (`wrangler.jsonc` `env.sandbox`, `config/sandbox.json`
chosen by `ENVIRONMENT`, `src/environment.ts`): `npm run deploy:sandbox` deploys
`svbc-eventbrite-sync-sandbox` with its own D1 (`svbc-eventbrite-sync-sandbox`), queues
(`eventbrite-sync-writes-sandbox` / `-sandbox-dlq`), rate limiter and secrets
(`wrangler secret put … --env sandbox`). This Worker writes only to Monday, so there is no
outbound sink to lock; `config/split.test.ts` fails if the two configs share an id or
`env.sandbox` shares a resource with the top level. Design:
`../docs/superpowers/specs/2026-09-18-sandbox-environment-design.md`. Local development against
the sandbox is `npm run dev:sandbox`. The sandbox D1 now exists (created
2026-10-26; migrations 0001–0002 applied, `svbc-eventbrite-sync-sandbox` deployed). Production is
not provisioned: its `database_id` in `wrangler.jsonc` is a placeholder until `wrangler d1 create`
runs.

**Workers Builds:** connect `svbc-eventbrite-sync-sandbox` to this repo with root directory
`/eventbrite-sync` and deploy command `npx wrangler deploy --env sandbox`, as for the other
Workers; `.gitlab-ci.yml`'s `deploy-sandbox:eventbrite-sync` job is the gated fallback.

## Deploy

Production has not been run; the sandbox has (2026-10-26, D1 `svbc-eventbrite-sync-sandbox` with migrations 0001–0002). This is the order (sandbox first, `--env sandbox` on every command,
then production at cutover without it):

```sh
cd eventbrite-sync && npm install
npx wrangler d1 create svbc-eventbrite-sync-sandbox      # paste the id into wrangler.jsonc env.sandbox
npx wrangler queues create eventbrite-sync-writes-sandbox
npx wrangler queues create eventbrite-sync-writes-sandbox-dlq
npx wrangler d1 migrations apply svbc-eventbrite-sync-sandbox --remote --env sandbox
npx wrangler secret put MONDAY_API_TOKEN --env sandbox
npx wrangler secret put EVENTBRITE_PRIVATE_TOKEN --env sandbox
npx wrangler secret put EVENTBRITE_WEBHOOK_SECRET --env sandbox
npm run deploy:sandbox
```

Then the prerequisite column's id (created by the sandbox load) in `config/sandbox.json`, redeploy, and register a
webhook on a sandbox-safe test event (Eventbrite allows several webhooks per organization).
**Verify** with a free order on that event (expect a `skipped` row, nothing on the board), a paid
order (expect the Donations item with every column in the table above and a Donor link),
a refund (expect `Refunded` — once the label exists), and a backfill run for the event (expect
no second item). Production repeats the list under the production names at cutover (see
`../docs/production-deploy-checklist.md`), then the Summit backfill.

### The write switch

Every Monday write and ledger update is gated by the shared write switch (spec
`../docs/superpowers/specs/2026-10-26-write-switch-design.md`, module `src/flags.ts`, a
byte-identical copy of `member-portal/src/flags.ts`), read from the `FLAGS` KV namespace
(`wrangler.jsonc`; the ids are placeholders until the namespaces exist):

- `eventbrite-sync:writes` — `on` writes normally; `hold` writes nothing and keeps messages queued
  (they retry); `off` writes nothing and logs one `"writeSwitch":"skipped"` line per would-be
  write. **A missing key means `off`**, and a KV read error means hold.
- `eventbrite-sync:log` — `debug` adds redacted payloads to those lines.

Set it with the operator CLI at the repo root, never by hand (`writes hold`/`on` also pauses and
resumes `eventbrite-sync-writes`):

```sh
node scripts/flags.mjs eventbrite-sync writes on --env sandbox     # or --env production
node scripts/flags.mjs status --env sandbox
```

**Set `writes on` before deploying** a build that carries the switch, or the deployed Worker
dry-runs everything. The webhook still records every delivery under any mode; one ingested while
`off` is stamped and is never written, even if the switch is `on` by the time it is consumed. The
dead-letter consumer is D1 bookkeeping and runs in every mode.

Orders, events and attendees share the one write queue and the same gate. What each mode does
beyond the table above:

- **Queue messages (order, event, attendee).** Under `off` (or a `dropped` stamp) the consumer runs
  the same fetch → map → match path against recording deps: each Donations, People, Events and
  Event Registrations write is a skip line, no ledger row changes, and the consumer's own sends
  (an event's attendee fan-out, an attendee's request for its event) are logged as `Write queue`
  skips, not sent. A message the consumer does send live carries its parent's stamp. A dry-run
  attendee whose event has a ledger row but no Events item yet (a dry run never records one) links
  the placeholder `dry-run-event` rather than retrying until its event is written.
- **The hourly follow-up sweep** (`runFollowups`). `on` runs it; `off` runs it against a recording
  Monday client — every Follow-up Email, Attendance, People link, Follow-ups `Sent`/`Held` and the
  Held bell notification is a skip line, nothing reaches Monday, so no Sequence fires. It has no
  cursor: its run-once guard is the event's Follow-ups column, which a dry run never sets, so a
  due class is logged again every hour until it ages out of `maxAgeDays`. `hold` or an unreadable
  switch skips the run with one `eventbrite-sync scheduled: write mode is …` line.
- **The daily missed-order check.** Reads Eventbrite and the orders ledger and only logs, so it
  runs unchanged under `on` and `off`; under `hold` or an unreadable switch it is skipped with the
  sweep (the same line). Its 26-hour lookback does not reach back over a long hold, so after a
  multi-day `hold` compare the orders ledger against Eventbrite by hand (or run
  `scripts/backfill-orders.mjs --dry-run` per event) for the held days.
- No path re-enqueues "stuck" ledger rows automatically, so a row ingested under `off` is never
  resurrected later; re-driving stays the backfill scripts' job.

## Open

0. **Production class emails (attendee feed).** Connect `learn@` in Emails & Activities; the Bike
   Education coordinator's `notifyUserId`; production column ids; the `Attendee Email` Email-column conversion; Sequences
   and automations per the setup checklist, every Thank-you Sequence created **paused** until the
   Bike Education coordinator refreshes the dated upcoming-classes list and the Bike to Wherever Days line;
   register the attendee webhook; after any backfill, set Follow-ups = Sent on recent classes
   already emailed by hand (setup checklist Step 5); name an owner. Known limits: no Class Time column (reminders
   carry a `[start time]` note), and Spanish class day/date render in English.
1. **The `Eventbrite Order ID` column id** in config — the column arrives with the next sandbox
   load and the production cutover load; see "Prerequisite column". Nothing can be written until
   the id is set.
2. **The `Refunded` Status label** — shared with funraise-sync; still missing on sandbox v3.
3. **Eventbrite private token and organization id** — which staff account mints the token, and
   `eventbrite.organizationId` in config (optional but recommended; without it the missed-order
   check asks Eventbrite which organization the token belongs to).
4. **Partial-refund behaviour** — verify `costs.gross` on the first real one (Out of scope).

## Development

```sh
npm install
npm test            # vitest, including scripts/backfill-orders-lib.test.mjs
npm run typecheck   # wrangler types, then tsc --noEmit — the only supported typecheck
```

Type-check with `npm run typecheck`, never a bare `tsc --noEmit` (binding types come from the
generated, gitignored `worker-configuration.d.ts`). `src/monday/graphql.ts` is a byte-identical
copy of `monday-backup/src/monday/graphql.ts` checked by the `monday-graphql-copies` CI job —
edit the canonical file, not the copy. `node ../scripts/check-log-safety.mjs eventbrite-sync/src`
must stay clean: log order ids and item ids, never a buyer's email.

## Sources

* Eventbrite API v3 blueprint — Group Webhooks (Create Webhook, action list), Group Order (Order
  Fields, Order Costs Fields, Retrieve Order by ID, List Orders by Event ID), Currency Cost,
  Pagination, Authentication: <https://www.eventbrite.com/platform/new/docs/eventbrite-api-v3-public.apib>
* Eventbrite Webhooks guide: <https://www.eventbrite.com/platform/docs/webhooks>
* `../funraise-sync/README.md` — the shape this Worker copies (adopt before create, first-write
  stamps, the Pacific date rule, the dead-letter consumer, the URL-secret tradeoff)
* Private planning repo: issue #56 (2026-09-30 decision), `migration-plan.md` "Eventbrite"
