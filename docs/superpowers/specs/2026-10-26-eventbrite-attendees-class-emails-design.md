# Eventbrite attendees → Event Registrations, and Bike Education class emails — Design

**Date:** 2026-10-26
**Status:** Proposed, on `feat/eventbrite-attendees`. Not built.
**Worker:** `eventbrite-sync` (extends the orders path from `2026-10-06-eventbrite-orders-design.md`).
**Issue:** private planning repo #62 (Bike Education class emails); this is also the attendee half of
`migration-plan.md`'s "Eventbrite-going-forward Worker".
**Prior art:** the orders path in this Worker (webhook → D1 ledger → queue → Monday write,
pointer-only deliveries, adopt-before-create); `salesforce-import`'s Eventbrite transform (Events
and Event Registrations columns, `Eventbrite Attendee ID`, decision D on People inclusion).

## Why

Kendra Toy (Bike Education) sends three emails per class from `learn@bikesiliconvalley.org`. Today
she does it by hand as Salesforce List Emails to the Campaign `eb4sf` builds for each class from
Eventbrite:

* a **reminder** to everyone registered, 1–4 days before class (sometimes the morning of);
* a **thank-you** to everyone who checked in, and
* a **missed-you** to everyone who registered but didn't, usually the evening of the class or
  within two days.

Salesforce's record, 2026-07-01 to 2026-10-26: 50 List Emails, about two classes a week, 1–28
recipients each, last sent 2026-10-15. She uses 29 templates in her own folder, one per class type
and email kind. The only merge field is the recipient's first name. Dates and days ("on Saturday")
are typed into each send.

When Salesforce goes, `eb4sf` and List Email go with it. Nothing in Monday has Eventbrite's
attendees or check-ins: `eventbrite-sync` only writes orders, and only paid ones. Kendra's
Salesforce user can't be deactivated (migration repo `docs/23`, Salesforce after Gate C, step 1)
until this works in Monday.

Decided with David on 2026-10-26:

1. **Monday's own email.** Eventbrite's attendee emails come from Eventbrite's address and can't use
   our templates. Mailchimp was not chosen.
2. **Reminders: one template per class type; Kendra edits and sends each one by hand**, so she
   can personalize it.
3. **Thank-you and missed-you: one template per class type, sent automatically.** Kendra only
   touches these when she edits a template.
4. **Class type is chosen by Kendra on each class**, because Eventbrite has no field for it.
   Eventbrite's Format is "Class" for these, but also for volunteering events, and Bike Education
   classes aren't Eventbrite series.
5. **No confirm step, and the Held guard fires only when nobody checked in.** Eventbrite check-in
   is uneven. From 2026-08-01, some classes are fully checked in (event 1993885250458: 8 of 8),
   some not at all (1997497147740: 0 of 29), and many partly (1999432012974: 2 of 14). A partly
   checked-in class will send missed-you to the people who weren't scanned and mark them No Show.
   David accepted that risk rather than add a confirm click per class. Kendra can correct
   Attendance in Monday until the 08:00 run.

## Goals

* Every Eventbrite event becomes an **Events** item (upsert on `Eventbrite ID`).
* Every Eventbrite attendee becomes an **Event Registrations** item (upsert on `Eventbrite Attendee
  ID`), with Attendance kept current: registered, checked in, cancelled. Check-ins land within
  minutes, because follow-ups go out the next morning.
* For a class with a **Class Type** set, the morning after it ends, the Worker marks each
  registration for thank-you or missed-you. Monday enrolls it in that class type's Sequence, which
  sends from `learn@`.
* Kendra sends reminders from a saved board view with Mass email and that class type's template.
* Kendra's Salesforce user can be deactivated.

## Non-goals

* Sending email from the Worker. Monday sends it; the Worker only sets columns.
* Registrations from Funraise (yearly CSV, migration repo #51) or Eventbrite events from before
  cutover (`salesforce-import` migrates those).
* The occasional one-off email from `learn@`, like the LCI Seminar announcements and application
  updates. Kendra sends those with Mass email from a filtered view, and nothing here automates
  them.
* Per-attendee gifts or anything on Donations. The orders path is unchanged.

## Anti-goals (failure even if it technically works)

* **Missed-you to a whole class that came.** If a class never took check-in, every registrant is
  still "Registered" the next morning. Sending missed-you to all of them is the worst outcome
  here, and the Held guard exists to stop it. (Partial check-in is an accepted risk, decision 5.)
* An automated email Kendra didn't write, or one with a wrong day or date in it.
* Personal data at rest in D1. Like the orders ledger, it holds ids and statuses only.
* Making non-class events send anything. A blank Class Type means no automatic email, ever.

## Constraints (checked 2026-10-26)

* **Monday plan:** CRM Pro plus core Pro. That includes Mass email and email templates (Emails &
  Activities) and Sequences, which can enroll an item "when status changes to something".
  Workflow-builder Sequences are Enterprise only. Gmail/Outlook "send email" automations can't
  format text or add line breaks, so they aren't used.
* **Mass email** sends to the board's first **Email-type** column and can insert any of the
  board's columns into the body. Event Registrations' `Attendee Email` is a **text** column today
  (`text_mm79v2fx` in sandbox v3), so it has to become an Email column. That change lands in
  `salesforce-import` too, since it creates that board.
* **Eventbrite webhooks** (blueprint, as read in the orders design) offer `attendee.updated`,
  `attendee.checked_in`, `attendee.checked_out`, `event.created`, `event.published`,
  `event.updated` and `event.unpublished`. Deliveries carry only an `api_url` pointer. There is no
  signature, so the same `?secret=` scheme is used.
* **People inclusion (decision D, migration plan):** checking in at an event makes someone a
  Person; registering alone doesn't. The migrated board follows this: Eventbrite registrants who
  never checked in have no Attendee link.
* **Board ids in sandbox v3:** Events `18431577282`, Event Registrations `18431577302`, People
  `18431577220`. Events already has `Eventbrite ID` (`text_mm795t6s`), Date, End, Venue, Address,
  City, Program and Event Status. Event Registrations already has `Eventbrite Attendee ID`
  (`text_mm79bmyb`), Attendee Name, Attendance (Registered / Attended / No Show / Canceled),
  Source, Role and the Event and Attendee links.

## Decided shape

### Data flow

```
Eventbrite ── webhook (one org-wide, attendee.* + event.*) ──▶ POST /webhooks/eventbrite/attendee?secret=…
   route: verify secret → api_url must be <apiUrl>/events/<id>/ or an attendee URL under it
          → upsert D1 row (ids only) → enqueue { kind: 'event'|'attendee', id }
   consumer: GET the event or attendee with the Worker's token → upsert Monday item

Cron (hourly) ── Events with Class Type set, ended, follow-ups not yet run, now ≥ 08:00 Pacific
                 the day after End ──▶ check-in guard → set Follow-up Email on each registration
Monday ── automation per label: "When Follow-up Email changes to X → enroll in Sequence X"
       ── Sequence sends that class type's template from learn@
```

The orders webhook and route stay as they are. Attendees get their own route and webhook
registration, so neither one's action list or URL check gets looser.

### Events items

* Upsert on `Eventbrite ID`, adopting an existing item (the ones `salesforce-import` migrated)
  before creating one. The mapping matches `salesforce-import`'s Eventbrite events transform:
  name, Date and End (Pacific), Venue, Address, City, Program from the organizer account, Event
  Status, Source = Eventbrite and Eventbrite URL.
* **New column: Class Type** (status). Kendra sets it. The Worker never writes it.
* **New column: Follow-ups** (status: blank / Sent / Held). The Worker writes it so each class's
  follow-ups run once.

### Event Registrations items

* Upsert on `Eventbrite Attendee ID`, adopting migrated items. Item name is the attendee's name.
* **Attendance:** checked in → Attended; cancelled or refunded → Canceled; anything else →
  Registered. Checking out doesn't undo a check-in. **The Worker never downgrades Attendance.** It
  only moves Registered to Attended or Canceled, so an Attended or No Show that staff or the
  follow-up job set in Monday survives a later `attendee.updated`. A Monday edit to Attended
  links the attendee to People the next time the Worker processes them, or during the follow-up
  run.
* **Attendee link (People):** only once the attendee has checked in (decision D). Match People
  by email, or create a Person if there's no match. A new Person gets name and email only.
* **New columns, written from Eventbrite and the event:** Attendee Email (**Email type**, which
  replaces the text column), First Name, Class Date (date), Class Day (text, e.g. "Saturday"),
  Class Location (text, venue or "online"), and Class Type (copied from the event when follow-ups
  run, so Sequences and Mass email can insert it).
* **New column: Follow-up Email** (status). Its labels are `Thank-you: <class type>` and
  `Missed-you: <class type>`, so each label maps to one Sequence and one simple automation.

### Follow-ups (the automated part)

Hourly, the Worker looks for Events where Class Type isn't blank, Follow-ups is blank, it's past
08:00 Pacific the day after End, End is **no more than 3 days ago**, and the event is in the
Worker's own `events` ledger. So labelling a past or migrated class never sends anything. The
job reads Attendance from Monday, not Eventbrite, so Kendra's corrections count. For each one:

1. **Check-in guard.** If no registration is Attended, write nothing to registrations, set
   Follow-ups to **Held**, and notify Kendra in Monday. She can then do check-ins late and clear
   Held to re-run it, or just leave it.
2. Otherwise set Follow-up Email to `Thank-you: <type>` on each Attended registration, and to
   `Missed-you: <type>` on each one still Registered, also setting their Attendance to **No
   Show**. Canceled gets nothing. **One email per address per class:** when registrations share
   an email address (one buyer registering family members), only one of them gets a label, and
   thank-you wins over missed-you. Then set Follow-ups to **Sent**.
3. Monday's automation enrolls each changed registration in its Sequence, which sends the
   template from `learn@` inside the Sequence's send window.

If a class type has no Sequence for one email kind, that registration's label is set but nothing
sends. That's a quiet way for Kendra to turn off missed-you for a class type.

### Reminders (the hand-sent part)

* A saved Event Registrations view, "Class reminders": Attendance = Registered, grouped by Event,
  upcoming classes only. Kendra filters it to one class, selects all, opens Mass email, picks
  `Reminder: <class type>` from learn@, edits it and sends it.
* Templates insert First Name, Class Day, Class Date and Class Location, the same columns the
  Sequences use.

### Templates and Sequences (Monday-side setup, sandbox first)

* **Class types, as the starting labels.** These come from Kendra's Salesforce folder: Smart
  Cycling Part 1 (online), Smart Cycling Part 1 (in-person), Smart Cycling Part 2, E-Bike Basics
  (online), E-Bike Basics (in-person), Bike Commuting (online), Basic Bike Repair, Basic Bike
  Repair (Spanish), Basic Bike Maintenance (SVBE), Learn to Ride, Bike Security & Theft
  Prevention, and Winter Biking. Kendra can add or rename them.
* **Template bodies:** rebuilt from the 2026-10-21 export
  (`monday-migration/backup/email-templates-keep-review-2026-10-21.json`, gitignored). Each
  hard-coded day and date becomes Class Day / Class Date, and `{{{Recipient.FirstName}}}` becomes
  First Name. For a class type with no Salesforce missed-you or thank-you template, the builder
  drafts one from the closest existing one, and it's marked for Kendra to review before its
  Sequence is turned on.
* **Sequences:** one per class type and kind, a single automatic email step from `learn@`, with
  Monday's per-label enrollment automation.
* **Sender:** `learn@` has to be connected to Monday's Emails & Activities. Kendra or another
  staff member with that mailbox's login does this; the builder can't.

### D1 (migration `0002_attendees.sql`)

* `events (event_id PK, monday_item_id, status, last_action, error, received_at, written_at)`
* `attendees (attendee_id PK, event_id, monday_item_id, attendance, matched_person_item_id,
  status, last_action, error, deliveries, received_at, written_at)`

No names, emails or payloads, same as `orders`.

## Left to the builder

* The exact attendee `api_url` form, and whether `attendee.updated` fires on cancellations and
  refunds. Read both off the blueprint and a sandbox delivery. Store whatever the URL check needs.
* How Eventbrite says "cancelled" or "refunded" on an attendee (fields vs status values). Read it
  off the blueprint.
* Whether a Sequences email can insert board columns the way Mass email can, and whether it keeps
  formatting. **Check in the sandbox before building the follow-up path.** If it can't do either,
  stop and bring it back. The fallback is a different tool, not plain-text Gmail automations.
* Whether Monday's notify action or the API's `create_notification` notifies Kendra on Held. The
  user to notify goes in config.
* The backfill script for attendees and events (same shape as `backfill-orders.mjs`), and how it
  covers the gap between the final extract and the webhook registration.
* Turning `Attendee Email` into an Email column on the existing sandbox board, plus the matching
  `salesforce-import` change. Plan for both cases at cutover: the production Event Registrations
  board doesn't exist yet, so the load creates it as Email; or it was already loaded with a text
  column, so cutover adds an Email column, copies the values, and repoints config and views.
* README, UAT script (`docs/uat/eventbrite-sync.md`) and config split test, kept in step as for
  the orders path.

## Calls I made (David to check)

* Follow-ups run at **08:00 Pacific the day after the class**. Kendra often sends them the same
  evening, but the morning after leaves time for late check-ins.
* People are linked or created **only on check-in**, matching decision D and the migrated board.
* Still-Registered attendees become **No Show** when missed-you is set. Today staff set No Show by
  hand.
* **One Sequence per class type and kind**, picked by a status label, instead of one Sequence with
  conditional steps. It's simpler to set up and easier for Kendra to find the one to edit.
* Follow-ups only for classes that **ended in the last 3 days and are in the Worker's ledger**.
* **One email per address per class**, thank-you winning.
* The Worker **never downgrades Attendance**, and the follow-up job reads Monday's Attendance.
* **Sandbox only** for all build and rehearsal work. Production setup at cutover is a separate
  step David approves.
* Events are upserted for **every** Eventbrite event, not just classes, because the plan already
  gives this Worker all Eventbrite events and registrations.

## Open

* **Owner** of the class-email flow after cutover: who keeps the templates, Class Type labels and
  Sequences up to date. Kendra is the obvious choice, but nobody has agreed yet.

## Testing

Vitest, as for the orders path: route validation (attendee and event URLs, secret, ignored
actions), mapping (Attendance rules, the Pacific date and day), consumer adopt-before-create, and
the follow-up job (the guard, labels, No Show, run-once). The full flow is rehearsed in the
sandbox with a test Eventbrite event and Sequences that send to staff addresses only.

## Sequencing

1. Sandbox check of Sequences (dynamic fields, formatting, sender). This gates step 4.
2. Events and attendees feed, plus the Email-column change.
3. Templates and the reminder view; Kendra sends one real reminder from Monday while `eb4sf` still
   runs.
4. Follow-up job, Sequences and automations; one real class run end to end.
5. Production setup at cutover; then Kendra's Salesforce user is deactivated (`docs/23`, Gate C
   step 1).

## Sandbox check, 2026-10-26

**Result: still blocked, not yet run.** The gate (formatting kept, `Class Day` inserted, sending
mailbox) is unanswered; nothing was sent. History: attempt 1 blocked (no mailbox); attempt 2 after
David connected Gmail blocked identically (`mailboxes: []`).

* Scratch board `18437217754` "Sequences check (sandbox, delete me)" in workspace `17141226`:
  Email `email_mm8ghvpm`, Class Day `text_mm8gx7am`, Follow-up Email status `color_mm8gcdc2`, and
  item `13390907087` (Email = David's address, Class Day = Saturday). No Sequence or automation.
* Attempt 3: `create-sequence` now lists the mailbox (connectionId `33826938`,
  `dwk@bikesiliconvalley.org`, gmail). Creating with that sender, `emailColumnId`
  `email_mm8ghvpm`, and one automatic_email step failed with `Fetcher response returned NON-OK
  status=400 statusText=Bad Request`. The same 400 came back for an HTML body with
  `{{Class Day}}`, an HTML body with no variable, a plain-text body, and an empty `steps: []`.
  So the 400 is not about the body; likely the sender/board/column arguments or the endpoint.
  `get-board-sequences` shows 0 sequences.
* monday's Sequences help article (via `get_monday_knowledge`) says "email templates and HTML are
  not supported in Sequences", and column values go in through the editor's "{ } Columns" button.
  If so, bold and link formatting may not survive in a Sequence at all. Unverified, a doc claim.
* Unverified: formatting, column insert, sending mailbox actually used, whether the status
  automation is creatable via MCP (`enroll-item-in-sequence` is the fallback).
