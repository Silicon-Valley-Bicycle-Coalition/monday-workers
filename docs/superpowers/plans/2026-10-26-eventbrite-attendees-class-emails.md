# Eventbrite Attendees and Bike Education Class Emails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `eventbrite-sync` keeps Events and Event Registrations current from Eventbrite, and the
morning after each typed class it marks registrations so Monday Sequences send the thank-you and
missed-you emails. Kendra sends reminders herself with Mass email.

**Architecture:** A second webhook route (`/webhooks/eventbrite/attendee`) records pointer-only
deliveries in two new D1 ledgers (`events`, `attendees`) and enqueues them on the existing write
queue, now carrying a `kind`-tagged message. The consumer dispatches by kind. A new hourly cron runs
the follow-up job, which reads Class Type, Follow-ups and Attendance from Monday, plans the labels
in a pure function, and writes them. Monday automations then enroll each labelled registration in
that label's Sequence. Nothing in the Worker sends email.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers (D1, Queues, Cron Triggers), Vitest with
`@cloudflare/vitest-plugin`, Monday GraphQL API `2026-07`, Eventbrite API v3.

**Spec:** `docs/superpowers/specs/2026-10-26-eventbrite-attendees-class-emails-design.md`. Read it
first; this plan argues from it.

## Global Constraints

- Work in `monday-workers-eventbrite-attendees` on `feat/eventbrite-attendees`. Commands run from
  `eventbrite-sync/` unless a task says otherwise.
- **Sandbox only.** No write to production Monday, the production Worker, or production Eventbrite
  webhooks. Production setup is a separate step David approves at cutover.
- D1 holds ids, statuses and timestamps only: no name, email or payload (same rule as `orders`).
- Deliveries are triggers, never sources: the only thing read from a payload is the id(s) in
  `api_url`, after it's checked against `eventbrite.apiUrl`.
- Time zone `America/Los_Angeles` for every date, day and the 08:00 send time.
- Follow-ups only for events that ended no more than **3 days** ago and are in the `events` ledger.
- The Held guard fires **only** when no registration for the class is Attended (spec decision 5).
- Status labels, verbatim: Events Follow-ups `Sent` / `Held`; Attendance `Registered` / `Attended`
  / `No Show` / `Canceled`; Follow-up Email `Thank-you: <class type>` / `Missed-you: <class type>`.
- Event Status mapping matches `salesforce-import/src/transform/boards.ts` `EVENTBRITE_EVENT_STATUS`:
  `live`, `started` → Upcoming; `completed` → Completed; `canceled` → Canceled; `draft` → Draft;
  anything else → Completed.
- Every new config key exists in both `config/sandbox.json` (real ids) and `config/svbc.json`
  (`null` or `REPLACE_WITH_COLUMN_ID`), and `config/split.test.ts` checks it.
- Run `npm test` and `npm run typecheck` before every commit. Conventional commits, ending
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **A late check-in after follow-ups ran** (`No Show` → checked in on Eventbrite): Attendance
  becomes Attended and the person is linked to People. No second email, since Follow-ups is
  already Sent. Pinned in Task 4 (`mergeAttendance`) and Task 6.
- **A stale `attendee.updated` that arrives after a check-in**: Attendance stays Attended. Pinned in
  Task 4.
- **A class rescheduled or moved after people registered**: Class Date, Day and Location are
  refreshed on every registration. Pinned in Task 5.
- **A canceled class**: no follow-ups and no notification. Pinned in Task 7 (`isDue`).
- **The DST change on 2026-11-01**: a class ending Saturday 2026-10-31 at 19:00 is due at 08:00
  PST on Sunday 2026-11-01, which is 16:00Z. Pinned in Task 7.

---

## File structure

| File | Responsibility |
|---|---|
| `migrations/0002_attendees.sql` | `events` and `attendees` ledgers |
| `src/db/events.ts`, `src/db/attendees.ts` | D1 stores (pattern of `src/db/orders.ts`) |
| `src/eventbrite/client.ts` | + `getEvent`, `getAttendee` |
| `src/monday/client.ts` | + `getItems`, `notify` |
| `src/matching/people.ts` | `matchPerson`, shared by donors and attendees |
| `src/webhook/validateAttendee.ts` | attendee/event delivery validation |
| `src/webhook/route.ts` | + `POST /webhooks/eventbrite/attendee` |
| `src/mapping/event.ts`, `src/mapping/attendee.ts` | pure mappings |
| `src/consumer/processEvent.ts`, `src/consumer/processAttendee.ts` | per-kind consumers |
| `src/consumer/processBatch.ts` | dispatch by `kind`; message union |
| `src/followups/plan.ts`, `src/followups/run.ts` | pure planner and the cron job |
| `src/index.ts`, `wrangler.jsonc`, `src/types.ts`, `src/config.ts` | wiring, cron, config |
| `scripts/backfill-attendees.mjs` | re-drive one event's attendees through the route |
| `../salesforce-import/src/load/boards.ts` | `Attendee Email` → `email` |

---

### Task 0: Sandbox gate: can Sequences do this?

Nothing is built until this passes (spec, "Left to the builder").

**Files:** Modify: `docs/superpowers/specs/2026-10-26-eventbrite-attendees-class-emails-design.md` (add a "Sandbox check, 2026-10-xx" section).

- [ ] **Step 1:** On a scratch board in workspace `17141226` (CRM Sandbox), with an Email column holding David's own address and a text column `Class Day` = `Saturday`, create a Sequence with one automatic email step whose body has a bold line, a link, a line break and the `Class Day` column inserted. Use the monday MCP's `create-sequence` if it supports the body, otherwise the UI.
- [ ] **Step 2:** Add the automation "When status changes to X, enroll item in Sequence" on that board, set the status, and wait for the email.
- [ ] **Step 3:** Record in the spec what arrived: was the formatting kept, was `Saturday` inserted, and was it sent from the mailbox the Sequence names. Since `learn@` isn't connected yet, any connected staff mailbox shows the behaviour.
- [ ] **Step 4:** **If formatting or the column insert failed, stop the plan here** and report to David with what was seen. Otherwise commit: `docs(eventbrite-sync): record the Sequences sandbox check`.

### Task 1: Config, board columns and the D1 ledgers

**Files:**
- Create: `migrations/0002_attendees.sql`, `src/db/events.ts`, `src/db/attendees.ts`, `src/db/events.test.ts`, `src/db/attendees.test.ts`
- Modify: `src/types.ts`, `src/config.ts`, `src/config.test.ts`, `src/test/testConfig.ts`, `config/sandbox.json`, `config/svbc.json`, `config/split.test.ts`

**Interfaces:**
- Produces, in `types.ts`:
  - `MondayBoards` gains `'events': number | null` and `'event-registrations': number | null`.
  - `EventbriteSyncConfig.attendeeSync`:
    ```ts
    attendeeSync: {
      actions: string[]; // attendee.updated, attendee.checked_in, attendee.checked_out, event.created, event.published, event.updated, event.unpublished
      programByOrganizer: Record<string, string>; // Eventbrite organizer id → Program label
      volunteerPrograms: string[];                // Programs whose attendees get Role = Volunteer, e.g. ["Volunteering"]
      events: { eventbriteIdColumn; dateColumn; endColumn; venueColumn; addressColumn; cityColumn;
                programColumn; eventStatusColumn; sourceColumn; urlColumn; classTypeColumn; followupsColumn: string };
      registrations: { attendeeIdColumn; attendeeNameColumn; attendeeEmailColumn; firstNameColumn; attendanceColumn;
                       sourceColumn; roleColumn; eventLinkColumn; attendeeLinkColumn; classDateColumn; classDayColumn;
                       classLocationColumn; classTypeColumn; followupEmailColumn: string };
      peopleEmailColumn: string;
      followups: { maxAgeDays: number; sendHourLocal: number; notifyUserId: number | null };
    }
    ```
    (Every column key is `string`.)
  - `LedgerStatus = OrderStatus` reused for both new ledgers.
  - `EventRow { eventId; mondayItemId: string | null; startsAt: string | null; endsAt: string | null; locationKey: string | null; eventbriteStatus: string | null; status: LedgerStatus; lastAction; error: string | null; deliveries: number; receivedAt; writtenAt: string | null }`
  - `AttendeeRow { attendeeId; eventId; mondayItemId: string | null; matchedPersonItemId: string | null; status: LedgerStatus; lastAction; error: string | null; deliveries: number; receivedAt; writtenAt: string | null }`
- Produces, stores (same `recordDelivery` / `updateStatus(id, status, patch)` / `get` shape as `OrderStore`):
  - `EventStore`: `recordDelivery({ eventId, action, receivedAt })`, `updateStatus(eventId, status, patch: Partial<Pick<EventRow,'mondayItemId'|'startsAt'|'endsAt'|'locationKey'|'eventbriteStatus'|'error'|'writtenAt'>>)`, `getEvent(eventId)`, `listEndedBetween(fromIso: string, toIso: string): Promise<EventRow[]>` (only rows with `monday_item_id` not null).
  - `AttendeeStore`: `recordDelivery({ attendeeId, eventId, action, receivedAt })`, `updateStatus(attendeeId, status, patch)`, `getAttendee(attendeeId)`, `listByEvent(eventId): Promise<AttendeeRow[]>`.
  - `D1EventStore`, `D1AttendeeStore` implement them.

- [ ] **Step 1: Create the sandbox columns.** With the monday MCP, add to Events (sandbox v3) `18431577282`: `Class Type` (status, labels = the 12 class types in the spec's "Templates and Sequences") and `Follow-ups` (status: `Sent`, `Held`). Add to Event Registrations (sandbox v3) `18431577302`: `Attendee Email` (**email**; rename the old text column `text_mm79v2fx` to `Attendee Email (old)`, copy its values across with a one-off MCP batch, then delete the old one once the copy checks out), `First Name`, `Class Day`, `Class Location`, `Class Type` (text), `Class Date` (date), `Follow-up Email` (status, 24 labels: `Thank-you: <type>` and `Missed-you: <type>` for each type). Record each new column id.
- [ ] **Step 2: Write the failing config tests.** In `config.test.ts`: `validateConfig` throws `config: "attendeeSync.registrations.attendanceColumn" must be a Monday column id string` when that key is missing; throws on `followups.maxAgeDays` ≤ 0 and on `sendHourLocal` outside 0–23; accepts `notifyUserId: null`. In `split.test.ts`, add the board keys `events` and `event-registrations` to `BOARD_KEYS` and every new column key to `COLUMN_KEYS`.
- [ ] **Step 3: Run** `npx vitest run src/config.test.ts config/split.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** validation in `src/config.ts` (same style as `eventbriteSync`), the types, `testConfig`'s new defaults (fake ids such as `att_col`), and both JSON files. In `sandbox.json`: the ids from Step 1, the existing columns from the spec's Constraints (`text_mm795t6s`, `text_mm79bmyb`, `color_mm79pht5`, …, read the rest off `get_board_info`), `programByOrganizer` from `salesforce-import`'s organizer → Program rule, `peopleEmailColumn: "email_mm79m5qa"`, `followups: { maxAgeDays: 3, sendHourLocal: 8, notifyUserId: 74336833 }` (David in the sandbox; Kendra's id goes in at cutover). `svbc.json`: `REPLACE_WITH_COLUMN_ID` / `null`.
- [ ] **Step 5: Write the failing store tests** against the vitest D1 binding (pattern: `src/db/orders.test.ts`): `recordDelivery` inserts then bumps `deliveries` and keeps `monday_item_id`; `updateStatus` with a `COALESCE`d patch keeps old values on null; `listEndedBetween('2026-10-23T00:00:00Z','2026-10-26T12:00:00Z')` returns only rows whose `ends_at` is in range and that have a Monday item; `listByEvent('E1')` returns only E1's rows.
- [ ] **Step 6: Run** `npx vitest run src/db`. Expected: FAIL.
- [ ] **Step 7: Implement** `0002_attendees.sql` (columns as the `Row` types, snake_case, `PRIMARY KEY` on the id, an index on `attendees(event_id)` and `events(ends_at)`) and the two stores.
- [ ] **Step 8: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 9: Commit** `feat(eventbrite-sync): config and D1 ledgers for events and attendees`.

### Task 2: Eventbrite and Monday client additions; shared People match

**Files:**
- Modify: `src/eventbrite/client.ts`, `src/eventbrite/client.test.ts`, `src/monday/client.ts`, `src/monday/client.test.ts`, `src/matching/donors.ts`
- Create: `src/matching/people.ts`, `src/matching/people.test.ts`

**Interfaces:**
- Produces:
  - `EventbriteEvent { id; name?: { text?: string|null }|null; start?: { utc?: string|null; timezone?: string|null }|null; end?: { utc?: string|null }|null; status?: string|null; url?: string|null; organizer_id?: string|null; online_event?: boolean|null; venue?: { name?: string|null; address?: { address_1?: string|null; city?: string|null; localized_address_display?: string|null }|null }|null }`
  - `EventbriteAttendee { id; event_id?: string|null; checked_in?: boolean|null; cancelled?: boolean|null; refunded?: boolean|null; status?: string|null; profile?: { name?: string|null; first_name?: string|null; email?: string|null }|null; ticket_class_name?: string|null }`
  - `EventbriteClient.getEvent(eventId): Promise<EventbriteEvent|null>` → `GET /events/{id}/?expand=venue`; `getAttendee(eventId, attendeeId): Promise<EventbriteAttendee|null>` → `GET /events/{eventId}/attendees/{attendeeId}/`. Both: digits-only ids, 404 → null, same 401/403 message style as `getOrder`.
  - `MondayClient.getItems(boardId: number, itemIds: string[], columnIds: string[]): Promise<{ id: string; columns: Record<string, string> }[]>` (column `text` values; batches of 100 ids) and `MondayClient.notify(userId: number, itemId: string, text: string): Promise<void>` (`create_notification`, `target_type: Project`).
  - `matchPerson(client: MondayClient, peopleBoardId: number, emailColumn: string, who: { email; name }): Promise<DonorMatchResult>`. `matchDonor` becomes a call to it with `config.eventbriteSync.donorEmailColumn`, and its tests keep passing unchanged.

- [ ] **Step 1: Write failing tests:** `getEvent('1993885250458')` requests `https://www.eventbriteapi.com/v3/events/1993885250458/?expand=venue` with the Bearer header; `getAttendee('1','x')` throws on a non-numeric id; 404 → null for both. `getItems` sends `items(ids:)` with `column_values(ids:)` and maps `text`; 230 ids → 3 requests. `notify` sends `create_notification` with `user_id`, `target_id`, `text`, `target_type: Project`. `matchPerson` without an email → `{ donorItemId: null, reason: 'no email' }`.
- [ ] **Step 2: Run** `npx vitest run src/eventbrite src/monday src/matching`. Expected: FAIL.
- [ ] **Step 3: Implement.** Before coding, check `getAttendee`'s path and the cancel/refund fields against the API blueprint (`/platform/new/docs/eventbrite-api-v3-public.apib`, "Retrieve an Attendee"). If the path differs, use the blueprint's and change Task 3's URL check to match.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(eventbrite-sync): event, attendee, items and notify API calls`.

### Task 3: Attendee route and the queue message union

**Files:**
- Create: `src/webhook/validateAttendee.ts`, `src/webhook/validateAttendee.test.ts`
- Modify: `src/webhook/route.ts`, `src/webhook/route.test.ts`, `src/consumer/processBatch.ts`, `src/consumer/processDeadLetters.ts` (+ tests), `src/types.ts`

**Interfaces:**
- Consumes: `EventStore`, `AttendeeStore` (Task 1).
- Produces:
  - `type WriteQueueMessage = OrderQueueMessage | EventQueueMessage | AttendeeQueueMessage`, where `OrderQueueMessage` gains an optional `kind?: 'order'` (a message without `kind` is an order, so messages queued before deploy still work), `EventQueueMessage { kind: 'event'; eventId: string; action: string }` and `AttendeeQueueMessage { kind: 'attendee'; eventId: string; attendeeId: string; action: string }`. `Env.WRITE_QUEUE: Queue<WriteQueueMessage>`; `QueueLike.send(m: WriteQueueMessage)`.
  - `validateAttendeeDelivery(body, config): { kind: 'process'; delivery: { kind: 'event'; eventId; action } | { kind: 'attendee'; eventId; attendeeId; action } } | { kind: 'ignore'; reason }`. Accepts `<apiUrl>/events/<digits>/` and `<apiUrl>/events/<digits>/attendees/<digits>/` (or the path Task 2 found), checks actions against `attendeeSync.actions`, and applies the same organization check and throw rules as `validateDelivery`.
  - `AppDeps` gains `eventStore`, `attendeeStore`.

- [ ] **Step 1: Write failing tests.** Validation: an attendee URL → attendee delivery; an event URL → event delivery; an order URL on this route throws; `order.placed` on this route is ignored; a query string or a foreign host throws. Route: `/webhooks/eventbrite/attendee` returns 401 without the secret; a valid attendee delivery records an `attendees` row and enqueues `{ kind: 'attendee', … }`; an enqueue failure marks the row failed and returns 500 (same as orders). The DLQ marks the right ledger by `kind`.
- [ ] **Step 2: Run** `npx vitest run src/webhook src/consumer`. Expected: FAIL.
- [ ] **Step 3: Implement.** Reuse `secretsMatch`. `processOrderQueueBatch` keeps its name and order handling, and dispatches `event` and `attendee` messages to `processEvent` / `processAttendee` (Tasks 5–6; stub them here so this task's tests pass, with the stubs throwing `not implemented`). Retry and backoff are shared.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(eventbrite-sync): attendee and event webhook route`.

### Task 4: Pure mappings

**Files:** Create: `src/mapping/event.ts`, `src/mapping/event.test.ts`, `src/mapping/attendee.ts`, `src/mapping/attendee.test.ts`

**Interfaces:**
- Produces:
  - `mapEvent(event: EventbriteEvent, config): { itemName: string; columnValues: Record<string, unknown>; startsAt: string|null; endsAt: string|null; locationKey: string; classDate: string|null; classDay: string|null; classLocation: string }`. It never includes `classTypeColumn` or `followupsColumn`.
  - `attendanceFromEventbrite(a: EventbriteAttendee): 'Registered' | 'Attended' | 'Canceled'`.
  - `mergeAttendance(current: string | null, incoming: 'Registered'|'Attended'|'Canceled'): string`.
  - `mapAttendee(a, eventFacts: { classDate; classDay; classLocation; program: string|null }, config, attendance: string): { itemName; columnValues }` (Attendee Email as `{ email, text }`, Source `Eventbrite`, Role from `volunteerPrograms`).

- [ ] **Step 1: Write failing tests.** `mapEvent`: start `2026-10-31T02:00:00Z` → `classDate` `2026-10-30`, `classDay` `Friday`; `online_event: true` → `classLocation` `online`; a venue → `"<name>, <localized_address_display>"`; status `ended` → Event Status `Completed` (Global Constraints table); the organizer id maps to Program. `attendanceFromEventbrite`: `checked_in` → Attended; `cancelled` or `refunded` → Canceled; else Registered. `mergeAttendance`, every cell of this table:

  | current \ incoming | Registered | Attended | Canceled |
  |---|---|---|---|
  | null | Registered | Attended | Canceled |
  | Registered | Registered | Attended | Canceled |
  | Attended | Attended | Attended | Attended |
  | No Show | No Show | Attended | Canceled |
  | Canceled | Canceled | Attended | Canceled |

  `mapAttendee` with no email omits the email column and doesn't throw.
- [ ] **Step 2: Run** `npx vitest run src/mapping`. Expected: FAIL.
- [ ] **Step 3: Implement.** Dates and days use `Intl.DateTimeFormat` with `timeZone: 'America/Los_Angeles'`. Reuse `toISODate` where it fits.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(eventbrite-sync): event and attendee mappings`.

### Task 5: Event consumer

**Files:** Create: `src/consumer/processEvent.ts`, `src/consumer/processEvent.test.ts`

**Interfaces:**
- Consumes: `getEvent`, `mapEvent`, `EventStore`, `AttendeeStore.listByEvent`, `MondayClient`, `QueueLike`.
- Produces: `processEvent(msg: EventQueueMessage, deps: ProcessBatchDeps & { eventStore; attendeeStore; queue: QueueLike }): Promise<void>`.

- [ ] **Step 1: Write failing tests:** a new event with no ledger item or board hit → `createItem` on the Events board, and the row `written` with `endsAt`; an adopted item (found by `eventbriteIdColumn`) → `changeColumnValues` only; a 404 → `failed`, no retry. **A change of `startsAt` or `locationKey`** since the row was last written → one `attendee` message is enqueued for each `listByEvent` row. No change → nothing enqueued. A deleted item → `failed`, not recreated (same `isItemGone` rule as orders).
- [ ] **Step 2: Run** `npx vitest run src/consumer/processEvent.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, following `processOne` in `processBatch.ts`. Move `isItemGone` to `src/monday/itemGone.ts` so both consumers use it.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(eventbrite-sync): upsert Events items from Eventbrite`.

### Task 6: Attendee consumer

**Files:** Create: `src/consumer/processAttendee.ts`, `src/consumer/processAttendee.test.ts`

**Interfaces:**
- Consumes: `getAttendee`, `getEvent` (only when the event row has no Monday item yet, or for class facts), `mapEvent`, `mapAttendee`, `attendanceFromEventbrite`, `mergeAttendance`, `matchPerson`, `MondayClient.getItems`, the stores.
- Produces: `processAttendee(msg: AttendeeQueueMessage, deps): Promise<void>`.

Rules (spec, "Event Registrations items"):
1. If the event row has no Monday item, enqueue `{ kind: 'event', eventId }` and throw a retryable error naming it. The retry finds the event written.
2. Current Attendance is read from Monday for an existing item (`getItems`), then `mergeAttendance` decides.
3. People link or create **only when the merged Attendance is Attended**. Cache it on the row.
4. Write: Attendee Name, Attendee Email, First Name, Attendance, Source, Role, the Event link, the Attendee link (when set), and Class Date, Day and Location from `mapEvent`.
5. Adopt by `attendeeIdColumn` before create, as orders do.

- [ ] **Step 1: Write failing tests:** a new registered attendee → create with Attendance `Registered`, no People lookup; `checked_in` → `matchPerson` called and the Attendee link written; **current `No Show`, incoming checked in → Attended and linked** (Review Focus); **current `Attended`, incoming not checked in → stays Attended** (Review Focus); an event not yet on the board → an event message enqueued and the attendee message retried; an attendee with no email → written without email, no People link even if checked in, with a warning logged.
- [ ] **Step 2: Run** `npx vitest run src/consumer/processAttendee.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, and replace Task 3's stubs with the real consumers.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(eventbrite-sync): upsert Event Registrations from Eventbrite attendees`.

### Task 7: Follow-up planner and job

**Files:** Create: `src/followups/plan.ts`, `src/followups/plan.test.ts`, `src/followups/run.ts`, `src/followups/run.test.ts`

**Interfaces:**
- Produces:
  - `isDue(row: EventRow, now: Date, cfg: { maxAgeDays; sendHourLocal }): boolean`: false when `eventbriteStatus` is `canceled` or `endsAt` is null. True when `now` ≥ `sendHourLocal`:00 Pacific on the Pacific calendar day after `endsAt`'s Pacific day, **and** `endsAt` ≥ `now − maxAgeDays`.
  - `type Registration = { itemId: string; attendance: string; email: string }`
  - `planFollowups(regs: Registration[], classType: string): { outcome: 'held' } | { outcome: 'send'; writes: { itemId: string; label: string; noShow: boolean }[] }`
  - `runFollowups(now: Date, deps: { eventStore; attendeeStore; mondayClient; config }): Promise<{ sent: string[]; held: string[]; skipped: string[] }>` (event ids).

Planner rules: `held` iff no registration is Attended. Otherwise Attended → `Thank-you: <type>`; Registered → `Missed-you: <type>` and `noShow: true`; Canceled and No Show → nothing; registrations without an email → nothing. **One write per lowercased, trimmed email**, and thank-you wins over missed-you, in the first item order seen. `run.ts`: `listEndedBetween(now − maxAgeDays, now)` → `isDue` → `getItems` on Events for Class Type and Follow-ups → skip when Class Type is blank or Follow-ups isn't blank → `listByEvent` → `getItems` on registrations → plan → write each registration (Follow-up Email label, Class Type text, and Attendance `No Show` when `noShow`), then Follow-ups `Sent`. Held: Follow-ups `Held`, and `notify(notifyUserId, eventItemId, "Follow-ups held for <event name>: nobody was checked in. Fix Attendance and clear Follow-ups to send them.")` when `notifyUserId` isn't null. One event failing is logged and doesn't stop the others.

- [ ] **Step 1: Write failing tests.** `isDue`: ends `2026-10-25T02:00:00Z` (Sat 19:00 PDT) is due at `2026-10-25T15:00:00Z` (08:00 PDT Sun) and not at `14:59:59Z`. **DST: ends `2026-11-01T02:00:00Z` (Sat 10-31 19:00 PDT) is due at `2026-11-01T16:00:00Z` (08:00 PST) and not at `15:59:59Z`.** Ended 4 days ago → false; canceled → false. Planner: 0 Attended of 29 → `held`; 2 Attended + 12 Registered → 2 thank-you + 12 missed-you with `noShow`; a parent with two kids, one Attended and one Registered, on the same email → one thank-you only; mixed-case emails dedupe. Job: Follow-ups already `Sent` → no writes; Class Type blank → skipped; held → `notify` called once with that text; a throw on one event → the other still sent.
- [ ] **Step 2: Run** `npx vitest run src/followups`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(eventbrite-sync): morning-after class follow-up job`.

### Task 8: Wiring: cron, entrypoint, integration test

**Files:** Modify: `src/index.ts`, `src/index.test.ts`, `src/integration.test.ts`, `wrangler.jsonc`, `config/split.test.ts`

- [ ] **Step 1: Write failing tests:** `index.test.ts`, the `scheduled` handler calls `runFollowups` with the event time, and a missing `MONDAY_API_TOKEN` throws with a message naming it. `integration.test.ts`, end to end on D1: an attendee delivery goes route → queue → consumer → Monday mock, then a follow-up run at the due time writes the label. `split.test.ts`: the sandbox and production crons are both `["0 * * * *"]`.
- [ ] **Step 2: Run** `npx vitest run src/index.test.ts src/integration.test.ts config/split.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `scheduled(controller, env, ctx)` with `ctx.waitUntil(runFollowups(new Date(controller.scheduledTime), …))`, and `"triggers": { "crons": ["0 * * * *"] }` at the top level and under `env.sandbox`. Wire the new stores into `fetch` and `queue`.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(eventbrite-sync): hourly follow-up cron`.

### Task 9: Attendee backfill script

**Files:** Create: `scripts/backfill-attendees.mjs`; Modify: `scripts/backfill-orders-lib.mjs`, `scripts/backfill-orders-lib.test.mjs`

**Interfaces:** Consumes `readArg`, `checkTarget`, `sendDelivery` from `backfill-orders-lib.mjs`. Produces `listAttendeesUrl(apiUrl, eventId, { continuation })` and `parseAttendeesPage(body): { attendees: { id }[]; continuation: string|null }`.

- [ ] **Step 1: Write failing tests** for `listAttendeesUrl` (`/events/E/attendees/?continuation=…`) and `parseAttendeesPage` (follows `pagination.has_more_items`).
- [ ] **Step 2: Run** `node --test scripts/backfill-orders-lib.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** The script posts one event delivery (`<apiUrl>/events/E/`), then one attendee delivery for each attendee, to `/webhooks/eventbrite/attendee`, with the same flags as `backfill-orders.mjs` (`--event-id --worker-url --env --pause-ms --dry-run`).
- [ ] **Step 4: Run** `node --test scripts/*.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(eventbrite-sync): backfill script for event attendees`.

### Task 10: `salesforce-import` writes Attendee Email as an Email column

**Files:** Modify: `../salesforce-import/src/load/boards.ts:30`, `../salesforce-import/src/load/boards.test.ts`; check `../salesforce-import/src/transform/boards.ts:89` and its Eventbrite twin

- [ ] **Step 1: Write the failing test:** the `event-registrations` column types map has `'Attendee Email': 'email'`, and `formatColumnValue('email', 'ada@svbc.org')` is what the loader sends for it.
- [ ] **Step 2: Run** `cd ../salesforce-import && npx vitest run src/load/boards.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Change the type, and make sure an empty email is sent as no value, not `{ email: '' }`.
- [ ] **Step 4: Run** `cd ../salesforce-import && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(salesforce-import): load Attendee Email as an Email column`.

### Task 11: Monday-side setup in the sandbox

**Files:** Create: `eventbrite-sync/docs/class-emails-setup.md` (the checklist, reused for production at cutover)

- [ ] **Step 1: Templates.** Extract Kendra's 29 templates from `../../monday-migration/backup/email-templates-keep-review-2026-10-21.json` (gitignored; `FolderName` = `Kendra Toy's Private Email Templates`) into Mass email templates `Reminder: <type>` and Sequence bodies for `Thank-you: <type>` / `Missed-you: <type>`. Replace `{{{Recipient.FirstName}}}` with First Name, `{{{Sender.Signature}}}` with a fixed `learn@` signature, and each hard-coded day or date with Class Day / Class Date. List every type with no source template, and every drafted body, in the setup doc under "For Kendra to review".
- [ ] **Step 2: Sequences and automations.** One Sequence per `Follow-up Email` label, with a single automatic step and the template, plus one automation per label: "When Follow-up Email changes to `<label>`, enroll item in `<label>`". Sequences for drafted bodies are created **paused**.
- [ ] **Step 3: Reminder view.** Event Registrations view "Class reminders": Attendance = Registered, Class Date ≥ today, grouped by Event.
- [ ] **Step 4: Verify** with the monday MCP (`get-board-sequences`, `list_automations`) that every label has exactly one Sequence and one automation. Record the counts in the setup doc.
- [ ] **Step 5: Commit** `docs(eventbrite-sync): class email setup checklist`.

### Task 12: Docs and the sandbox rehearsal

**Files:** Modify: `eventbrite-sync/README.md`, `docs/uat/eventbrite-sync.md`; in `monday-migration`: `docs/23-cutover-runbook.md`, `docs/25-remaining-tasks.md`

- [ ] **Step 1: README.** Rewrite the "What it is not" and Out-of-scope sections, add the attendee data flow, the new prerequisite columns, the second webhook registration (actions from `attendeeSync.actions`, URL `/webhooks/eventbrite/attendee?secret=…`), the cron, and the follow-up rules with the accepted partial-check-in risk.
- [ ] **Step 2: UAT script.** Kendra's steps: set Class Type on a test class, register, check in some attendees, see Attendance change, check the morning-after labels and emails (sent to staff addresses only), send a reminder from the view.
- [ ] **Step 3: Rehearse in the sandbox.** Deploy `--env sandbox`, apply migration `0002`, register a sandbox webhook on a test Eventbrite event, and run one class end to end, including a Held case. Record the results in the UAT doc.
- [ ] **Step 4: Migration repo.** In `docs/25` #62 and `docs/23` Gate C step 1, point at this Worker and record what's left for production: the `learn@` connection, Kendra's `notifyUserId`, production columns (including the `Attendee Email` conversion from Task 1 Step 1 if the production board was already loaded with a text column), Sequences and automations from the setup doc, the webhook registration, and naming an owner.
- [ ] **Step 5: Commit** each repo: `docs(eventbrite-sync): attendee feed README and UAT` and `docs(23, 25): point #62 at the eventbrite-sync attendee feed`.
