# Ticket type, capacity and sales status from Eventbrite

**Status:** design, 2026-11-11. Nothing built. Follows a review of what `eventbrite-sync` reads against
Eventbrite's v3 API blueprint.

## Why

`eventbrite-sync` already fetches the event and every attendee, but drops three things staff would use:

1. **Ticket type.** `EventbriteAttendee.ticket_class_name` is typed and fetched (`eventbrite/client.ts`) and never
   written. Role only says Volunteer or Participant, so a "Member", "Youth" or "Free" registration looks like any other.
2. **Capacity.** Nothing on the Events board says how big a class is or whether it is full. Ride and class leaders open
   Eventbrite to find out.
3. **Sales status.** The event is already fetched with `expand=event_sales_status`, but only `event_cancelled` is read.
   The same object says `on_sale`, `sold_out`, `sales_ended`, `not_yet_on_sale`.

## Goals

* Each Event Registrations item shows its ticket type.
* Each upcoming Events item shows capacity, tickets sold, and a sales status label, at most an hour stale.
* No new Eventbrite webhook, no new queue message kind, no change to how a registration is written.

## Non-goals

* Spots left as a Worker-written number. It is a Monday formula column (Capacity − Tickets Sold), so it follows a
  hand correction and costs no code.
* Per-ticket-class breakdowns (a board of ticket classes per event).
* Backfilling ticket type onto past registrations beyond the existing `scripts/backfill-attendees.mjs` replay.
* Registration-driven refresh of capacity (see "Freshness" and Question 3).
* Order-side fields (promo code, fee and net amounts). Separate item.

## Anti-goals: this has failed if

* A failed ticket-class or capacity read blocks or delays an Events or registration write.
* A hand-typed Capacity is overwritten by an event that has none in Eventbrite.
* The board shows a sold-out label for an event that has seats.
* Past events (30+ days ended) are touched by the hourly refresh.

## Overlap with the event counts design

[`2026-11-04-event-counts-design.md`](2026-11-04-event-counts-design.md) is also unbuilt and touches the same Events
items and the same hourly cron. They are different data and must not be merged:

| | Source | Columns | Message |
|---|---|---|---|
| Event counts | Monday (Event Registrations) | `🔒 Registered`, `🔒 Checked In`, `🔒 No-shows` | `{ kind: 'counts' }` |
| This design | Eventbrite | `🔒 Capacity`, `🔒 Tickets Sold`, `🔒 Sales Status` | existing `{ kind: 'event' }` |

`🔒 Registered` there counts canceled registrations, so Capacity − Registered would overstate how full a class is.
That is why Tickets Sold here comes from Eventbrite, not from that column. Both designs add to the `Events` entry of
`MARKED_COLUMNS`; whichever lands second rebases the list. `📜 Tickets Sold` (Salesforce history) already exists on the
board: the new column is named `Eventbrite Tickets Sold` to keep the two apart.

**This design reverses one non-goal there**: the counts spec lists "Ticket type" under Non-goals. It was out of scope
for that design, not rejected; if staff would rather not have it, drop item 1 here and nothing else changes.

---

## Item 1: ticket type on Event Registrations

**Change.** `mapAttendee` writes `attendee.ticket_class_name` (trimmed, non-empty) to a new text column, only when
present, the same way phone is handled. Text, not a status column: ticket class names are free text, per event
("Adult", "Adult – member rate", "Youth (under 16)"), and a status column would reject or auto-create labels.

* Config: `attendeeSync.registrations.ticketTypeColumn`, placeholder `REPLACE_WITH_COLUMN_ID` = write nothing (same
  rule as `attendeePhoneColumn`; add the key to the placeholder list in `config.ts`).
* Board: new text column `🔒 Ticket Type` on Event Registrations, added to `MARKED_COLUMNS`.
* No new fetch. Existing registrations pick it up on the next `attendee.updated` or a replay with
  `scripts/backfill-attendees.mjs` (idempotent).
* Volunteers board: not changed. `jobColumn` there is the event name today (`mapping/volunteer.ts`); whether a ticket
  class is a shift is Question 2.
* Nothing sensitive: the ticket class name is organizer-authored. It is not an attendee answer, so the custom-question
  allowlist in the counts design does not apply.

**Tests.** `mapping/attendee.test.ts`: written when present; absent when null/blank; absent when the column is the
placeholder. `config.test.ts`: the new key is validated like its siblings. `config/split.test.ts` still passes.

## Item 2: capacity and tickets sold on Events

**What Eventbrite offers.** Verified in the blueprint:

* `event.capacity` (integer, private field): max tickets. Unless `capacity_is_custom`, it is the sum of ticket class
  totals. No expansion needed, so `getEvent` already returns it.
* Ticket class `capacity` and `quantity_sold` (private fields) at `GET /events/{event_id}/ticket_classes/`. This is the
  only place a sold count lives; `ticket_availability` and `event_sales_status` carry flags and prices, not counts.

**Change.** `getEvent` stays one call. A new `getTicketClasses(eventId)` (paged, like the order lister) feeds a pure
`ticketsSold(classes)` that sums `quantity_sold`. `processEvent` calls it after the event fetch and writes:

| Column | Value | Rule |
|---|---|---|
| `🔒 Capacity` (number) | `event.capacity` | Written only when it is a positive integer. A null/0/absent value leaves the cell alone, so a hand-typed number survives and an unlimited event stays blank. |
| `🔒 Eventbrite Tickets Sold` (number) | sum of `quantity_sold` | Written whenever the ticket-class read succeeded, including 0. |

**Failure isolation.** The ticket-class read is best effort: on any error, `processEvent` logs one `console.warn` and
writes the event without the sold count. It never fails the message, so an Eventbrite hiccup on a secondary endpoint
can't stall event writes or class emails. The next hourly refresh retries.

**Config.** `attendeeSync.events.capacityColumn`, `ticketsSoldColumn`, each placeholder = skip. Add to
`MARKED_COLUMNS` under `Events`.

**Spots Left.** A Monday formula column `Spots Left` = Capacity − Eventbrite Tickets Sold, created by hand or by the
setup script; blank when Capacity is blank. Not Worker-written, so not in `MARKED_COLUMNS`.

**Open until verified in sandbox (Question 1):** whether `quantity_sold` drops on a refund or cancellation. If it
doesn't, Tickets Sold overstates, and the fallback is `GET /events/{event_id}/attendees/` counted with
`status=attending` (the `countAttendees` the pledge check already uses), at the cost of a paged read per event.

## Item 3: sales status on Events

**Change.** `mapEvent` already receives `event_sales_status`. Add a pure `salesStatusLabel(event)`:

| Eventbrite | Label |
|---|---|
| `message_code` = `event_cancelled` | *none: Event Status already says Canceled* |
| `sales_status` = `on_sale` | Open |
| `sold_out` | Sold out |
| `sales_ended` | Registration closed |
| `not_yet_on_sale` | Not open yet |
| `unavailable` | Unavailable (a soft sell-out from a pending order) |
| absent or unknown | *none: the cell is left alone* |

Written to a new status column `🔒 Sales Status` on Events. Only for `live`/`started` events: for draft, ended and
canceled events the cell is left as it was, so a finished class doesn't flip to "Registration closed". Labels are a
fixed set, created on the board once; `statusLabelMap`-style config isn't needed because the mapping is code, but the
column's labels must exist or the write is refused, so the setup script creates them.

* Config: `attendeeSync.events.salesStatusColumn`, placeholder = skip.
* Unknown `sales_status` values (Eventbrite adds one) map to no label and log once per run; never to a guess.
* `ticket_availability.is_sold_out` is **not** used: its description in the blueprint ("whether there is at least one
  ticket with availability") contradicts its name, so `event_sales_status` is the one source.

## Freshness

Two things move these columns after the event is written: registrations (sold count) and time (a ticket class's sales
window opening or closing flips `not_yet_on_sale` → `on_sale` → `sales_ended`). No webhook covers the second, and the
`attendee.*` webhooks reach the attendee consumer, not the event writer.

**Hourly upcoming refresh.** A sibling of the ended-event sweep (`src/upcomingEvents/sweep.ts`, same shape, same hourly
cron): list ledger events with status `written`, `eventbrite_status` in (`live`, `started`), and an end (else start) in
the future and within 120 days (config `attendeeSync.refreshHorizonDays`, default 120); for each, `recordDelivery` with
action `event.refresh` and send `{ kind: 'event', eventId, action: 'event.refresh' }`, exactly as `sweepEndedEvents`
does, including the revert-to-`written` on a failed send. `processEvent` needs no change to accept it.

* SVBC has 17 live upcoming events, so this is about 17 × (event + ticket classes + Monday write) an hour.
* It follows the write switch like the ended-event sweep: `on` runs, `off` logs each send as a `Write queue` skip,
  `hold`/`unknown` skip the hour.
* The ended-event guard (`written_at < ends_at`) is untouched: this sweep only selects events that haven't ended.
* The sweep also covers a hand-edited column: the next refresh puts Eventbrite's value back, which is what 🔒 means.

**Why not per registration.** Event messages fan out into attendee messages when a class moves, and one attendee burst
(a 200-person on-sale) would send 200 event messages for one number. A compare-and-set on the ledger row could dedupe
it (`UPDATE … SET status='queued' WHERE status='written'`, send only on a changed row), but that is new `EventStore`
surface and a second trigger path. Not worth it for a staff-facing view an hour stale; revisit if staff want it
(Question 3).

## Sandbox and write switch

* `eventbrite-sync:writes` covers the sweep and the writes. `off`: dry run, nothing written.
* Sandbox config gets the same four keys (`ticketTypeColumn`, `capacityColumn`, `ticketsSoldColumn`,
  `salesStatusColumn`) pointing at sandbox v4 columns; `config/split.test.ts` must fail if a production id leaks in.
* Production ids stay `REPLACE_WITH_COLUMN_ID` until the columns exist, so deploying the code first is safe: every
  new write is skipped on a placeholder.
* A new `scripts/setup-event-fields.mjs` (pattern: `setup-pledge-board.mjs`, with a `-lib.mjs` and test) creates the
  four columns, the status labels and the Spots Left formula idempotently, matching titles through `bareTitle`, and
  prints the config ids. Then re-run `scripts/mark-read-only-columns.mjs`.
* Events is not the Donations board, so `check-donation-form.mjs` doesn't apply.

## Build order

1. Config keys, types, placeholder handling (`config.ts`, `types.ts`) and tests.
2. Item 1: `mapAttendee` + tests. Ships alone.
3. Item 3: `salesStatusLabel` in `mapEvent` + tests (no new fetch, so no risk).
4. Item 2: `getTicketClasses`, `ticketsSold`, `processEvent` wiring with failure isolation + tests.
5. `src/upcomingEvents/sweep.ts`, the cron hook in `index.ts`, tests, write-switch skip lines.
6. Setup script, `MARKED_COLUMNS`, sandbox columns, UAT script update (`docs/uat/eventbrite-sync.md`), README.

## Questions

1. **Does `quantity_sold` drop on refund or cancel?** One sandbox order, then one refund, then read
   `/events/{id}/ticket_classes/`. Decides Tickets Sold's source (ticket classes vs counted attendees).
2. **Is a ticket class ever a volunteer shift?** If volunteer events sell "Setup crew", "Sweep" and so on, ticket type
   would be a better Volunteers `Job` than the event name. David or the volunteer coordinator.
3. **Is an hour stale enough for capacity?** If staff want it live during an on-sale, add the compare-and-set trigger.
4. **Does anyone object to ticket type** given the counts spec listed it as out of scope? Cherie Barnett's call.
5. **Do SVBC events set `capacity`, or leave tickets unlimited?** A sandbox read of the 17 live events answers it; if
   most are blank, Capacity is mostly empty and item 2 shrinks to Tickets Sold.
