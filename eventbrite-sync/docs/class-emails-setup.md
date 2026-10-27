# Class emails: Monday-side setup checklist

The `eventbrite-sync` Worker sets **Follow-up Email** on each Event Registrations item the morning
after a class (see the attendees spec,
`docs/superpowers/specs/2026-10-26-eventbrite-attendees-class-emails-design.md`). Everything that
actually sends email lives in Monday and is set up by hand, following this checklist. Do it on the
sandbox first, then again on production at cutover.

The email bodies themselves are **not** in this repo. They're in the template doc in the migration
repo (`docs/36-class-email-templates.md`), one section per class type,
with a staff-review list at the top. Copy each subject and body from there.

## 1. Prerequisites

- [ ] **`learn@` is connected in Emails & Activities.** Someone with that mailbox's login
      connects it (Monday → Emails & Activities → connect mailbox). Sequences and Mass email can't
      send from it until then.
- [ ] **The boards are in a monday CRM workspace.** Sequences only connect to boards in a CRM
      workspace; the "Connect a board" picker doesn't offer boards anywhere else, and the API's
      `create-sequence` returns HTTP 400 for them. The production Events and Event Registrations
      boards must be created in the CRM-product workspace. (The CRM Sandbox rehearsal boards are
      *not* eligible, so Steps 3–4 below are rehearsed on a staff-only scratch board in a CRM
      workspace, not on the sandbox boards.)
- [ ] **Class Type labels** exist on Events → Class Type, and the same values come through on
      Event Registrations → Class Type. Starting labels: Smart Cycling Part 1 (online), Smart
      Cycling Part 1 (in-person), Smart Cycling Part 2, E-Bike Basics (online), E-Bike Basics
      (in-person), Bike Commuting (online), Basic Bike Repair, Basic Bike Repair (Spanish), Basic
      Bike Maintenance (SVBE), Learn to Ride, Bike Security & Theft Prevention, Winter Biking.
- [ ] **Follow-up Email labels** exist on Event Registrations: `Thank-you: <class type>` and
      `Missed-you: <class type>` for every Class Type label (24 for the starting 12). The label
      text must match the Class Type exactly — the Worker builds it from Class Type, and a Class
      Type without its two labels makes Monday reject the write: that class logs `failed` every
      hour, sending nothing, until the labels exist.
- [ ] **No real label sits at label id 5** on Events → Class Type and Follow-ups, or on Event
      Registrations → Follow-up Email and Attendance. Monday shows label id 5's text for an
      *empty* status cell, so a real label there makes every blank cell read as labelled — to
      staff, filters and reports, and to any tool reading cell text (the Worker reads stored
      values, so it isn't fooled, but nothing else is protected). When building each column,
      create a blank or placeholder label first (or move the real one off id 5), then check with
      `get_board_info`: on each of these columns `labels[].id === 5` must be blank or absent.
- [ ] The registration columns the bodies insert exist and are filled by the Worker: First Name,
      Class Day, Class Date, Class Location as each registration arrives, and Class Type, which the
      morning follow-up run copies from the event.

Adding a class type later means adding its Class Type label, both Follow-up Email labels, its
templates, two Sequences and two automations — all of Steps 2–4 for that one type.

## 2. Mass email templates (reminders)

For each class type, create a Mass email template named **`Reminder: <class type>`** from the
`Reminder:` section of the template doc.

- [ ] Paste the subject and body. Keep bold, links and line breaks.
- [ ] Replace each `{First Name}`, `{Class Day}`, `{Class Date}` and `{Class Location}` in the doc
      with the real column, inserted through the editor's **`{ } Columns`** picker (it shows as
      `{pulse.<column id>}`). Typed braces don't merge.
- [ ] Leave the `[ … ]` notes in place: the sender fills them per class (start time, venue address,
      event link) when she sends.

Optional: a **Cancelled class** Mass email template. Salesforce had one for a
cancelled class; it isn't part of this setup, but it's an easy one to add the same way.

## 3. Sequences (follow-ups)

For each Follow-up Email label, create one Sequence **named exactly like the label**
(e.g. `Thank-you: Learn to Ride`) from the matching section of the template doc. On the scratch
CRM board for the rehearsal; on the production Event Registrations board at cutover.

- [ ] Connect it to the Event Registrations board, with Attendee Email as the recipient column.
- [ ] **A single step: one automatic email**, sent immediately on enrollment. No manual steps,
      no follow-up steps.
- [ ] Subject and body from the doc, with columns inserted through `{ } Columns` as in Step 2.
- [ ] **Sender: `learn@`.**
- [ ] **Send window: Pacific time** (America/Los_Angeles). Monday's default, 7:00 AM–5:00 PM
      every day, is fine — the Worker labels at 08:00 Pacific, so follow-ups go out that morning.
- [ ] **Keep the unsubscribe link** and the global unsubscribe list on. Keep removal on reply,
      bounce and auto-reply.
- [ ] **Bodies the doc marks DRAFTED are created paused.** Leave them off until the Bike Education
      coordinator has read them. Bodies marked "from Salesforce" can be turned on — but check the doc's review list
      first: the thank-yous carry dated "coming up" class lists that should be refreshed before
      any of them go live.

A class type with no active Sequence for one kind just doesn't send that kind: the label is set,
nothing is enrolled. That's the intended way to switch, say, missed-you off for one class type.

## 4. Automations (one per label)

For each Follow-up Email label, one automation on Event Registrations:

> **When Follow-up Email changes to `<label>`, enroll item in `<label>`** (the Sequence of the
> same name)

- [ ] Exactly **one automation per label** — 24 for the starting 12 types. A second automation on
      the same label would enroll twice; a missing one silently sends nothing.
- [ ] The trigger is "changes to" that specific label, not "changes" plus a condition. After
      creating them, read them back with `list_automations` (Step 7) rather than trusting the
      builder's summary.

## 5. Cutover: mark classes already emailed by hand

Only events in the Worker's own ledger can send, but every one of them can: a class that ended in
the last 3 days and reached the ledger through a webhook, `scripts/backfill-attendees.mjs` or a
redelivery **will** be emailed the next morning if its Class Type is set and Follow-ups is blank —
even if staff already emailed it by hand from Salesforce or Monday.

- [ ] After the attendee webhook is registered and after **any** backfill, set **Follow-ups =
      Sent** on every Events item for a class that ended in the last 3 days and was already
      emailed by hand. (Classes that ended earlier, and classes migrated from Salesforce that the
      Worker never saw, never send.)
- [ ] Repeat for any later backfill or redelivery of a recent class.

## 6. "Class reminders" view

On Event Registrations, a table view **Class reminders**:

- Filter: **Attendance is Registered** AND **Class Date is on or after today**.
- **Grouped by Event** (the board-relation column), ascending, empty groups hidden.
- Sorted by Class Date ascending. Columns shown first: Name, Attendee Email, First Name,
  Attendance, Class Date, Class Day, Class Location, Class Type, Event.

The Bike Education coordinator filters it to one class, selects all, opens Mass email, picks `Reminder: <class type>`
from `learn@`, fills the `[ … ]` notes and sends.

Sandbox: created through the monday MCP (`create_view_table`) on the sandbox Event Registrations
board, view id `288657540`. Grouping by the Event board-relation worked through the API. Open the
view once in the UI to confirm the date filter reads "Class Date is on or after Today" (relative,
not pinned to the creation date). At cutover, create the same view on the production board with
that board's column ids.

## 7. Verify

With the monday MCP, on the board the Sequences are connected to:

- [ ] `get-board-sequences` — exactly one Sequence per Follow-up Email label, names matching the
      labels; drafted ones paused.
- [ ] `list_automations` — exactly one "Follow-up Email changes to X → enroll in X" per label, each
      pointing at the Sequence of the same name.
- [ ] One end-to-end test on a staff-only item with a staff address: set its Follow-up Email by
      hand, confirm the enrollment and the delivered email (bold, links, line breaks, columns
      filled).

**Counts** (fill in after each run):

| Board | Labels | Sequences | Active | Paused | Automations | Checked |
|---|---|---|---|---|---|---|
| Rehearsal (CRM scratch board) | | | | | | |
| Production | | | | | | |

## Held, and the 3-day limit

If no registration for a class is Attended when follow-ups run, the Worker sets the event's
**Follow-ups** to **Held** instead of sending, and notifies the Bike Education coordinator, who can mark check-ins
late and then **clear Held** to re-run the follow-ups for that class.

Clearing Held only re-runs follow-ups for a class that **ended no more than 3 days ago**
(`attendeeSync.followups.maxAgeDays` in the Worker config). After that, clearing Held does nothing:
the Worker deliberately never emails about an old class. A class migrated from Salesforce, or
created in Monday by hand, is not in the Worker's ledger and never sends. A recent class that *is*
in the ledger (webhook, backfill, redelivery) does send once Class Type is set and Follow-ups is
blank — see Step 5.
