# Upcoming volunteers by event (Volunteers board view)

Status: approved 2026-11-24 (date-first headings). Date: 2026-11-24. Size: small change, two stages.

## Why

Before an event, staff email its volunteers and its shift lead, and give the lead the other
volunteers' contact info. No Volunteers view lists only upcoming sign-ups ("Recent events" is the
last 90 days; "Table" and "Completed hours" are Completed rows only), and none is grouped by event.

## Goals

- A saved view on the Volunteers board: upcoming sign-ups, one section per event, with event name and
  date in the heading, soonest first.
- Each row has what staff need to contact the person: name, shift, email, phone. The lead is visible.
- Headings stay right when an event is renamed or staff re-point `Event`.

## Non-goals and anti-goals

- Emailing the lead automatically, or giving leads access to Monday. Staff send the list themselves.
- Deduplicating rows. One row is one ticket, so two shifts are two rows, and two people can share one
  email address.
- Listing events with no sign-ups: the view groups volunteer rows.
- Board groups per event; changing the existing views.
- Adding a column to People (it would also have to go on People (Historical)).

## Decided with the owner

- The view is for emailing volunteers and the lead, and for giving the lead contact info.
- The lead is someone who did not sign up, so the lead is set on the event, not on a volunteer row.
- A grouped view, tried in the sandbox first (approach A).

## Approaches

| | Approach | Outcome |
|---|---|---|
| A | View grouped by a heading column | **Picked.** As proposed, `eventbrite-sync` would fill a text column hourly. The sandbox test showed a formula column does it with no code, so the design uses that. |
| B | A real board group per upcoming event, kept by the sync | Exact wording and date order, but the sync moves rows, and staff can rename or delete groups. |
| | Group by the `Event` link | Dropped 2026-11-17: not in date order, and no date in the heading. |

## Sandbox test (2026-11-24, Volunteers sandbox v4 18437342662)

Throwaway columns and views, all deleted; the one re-pointed row was put back.

- A formula can read the linked event's current name (`Event`) and its date through a mirror, and a
  table view can group by that formula. Created through the API; checked in the Monday UI.
- Re-pointing a row's `Event` changed its formula value at once (read through the API).
- Formula and text groups sort only A→Z or Z→A; the view's item sort doesn't affect group order.
  Name-first headings came out Cardinals (Nov 28), Rams (Dec 13), Seahawks (Nov 29). Headings that start
  with an ISO date came out in date order.
- Grouping by `Date` first gives relative buckets ("This week", "Next month"), not events.
- A one-way `Shift Lead` link on Events shows on volunteer rows through a mirror, and added no column
  to People.
- The filter (Date today or later, Status not Canceled) returned the expected 43 of 45 rows.
- A view grouped by a formula disables New item. That suits these rows, which the sync creates.
- Not tested: a second-level mirror (the lead's email on volunteer rows); exporting one section.

## Design

**Stage 1, Monday only (no deploy).**

- Events: `Shift Lead`, a one-way link, one person, to People and People (Historical). Staff-editable.
- Volunteers: `Event Date` (mirror of the event's Date), `Shift Lead` (mirror of the event's), and
  `Event and Date` (formula).
- Heading: `2026-11-28 · Cardinals vs Mustangs: …`, so sections are in date order. Owner's choice over
  `[EventName] [Date]`, which lists events alphabetically.
- View `Upcoming by event`: Date today or later; Status not Canceled; grouped by `Event and Date` A→Z;
  empty groups hidden; sorted by Ticket Type. Columns: Name, Ticket Type, Attendee Email, Attendee
  Phone (stage 2), Status, Shift Lead.
- `setup-volunteers-board.mjs` gains the columns and the view, so a rebuilt board gets them. Idempotent
  through `bareTitle`, dry run by default. `Shift Lead` goes on Events, which the script already takes.
- My call: try the lead's email as a mirror on Volunteers; if Monday refuses a mirror of a mirror, staff
  open the lead's People item.

**Stage 2, phone and shift (`eventbrite-sync`).**

- `🔒 Attendee Phone` (text) on Volunteers, written by `mapVolunteer` with the rules `mapAttendee`
  already uses (`attendeePhone`, exported from `mapping/attendee.ts`): the built-in Cell Phone or Work
  Phone, else a phone question, never an emergency contact's. The Seahawks and Stanford forms require a
  Cell Phone (checked 2026-11-24).
- Config `attendeeSync.volunteers.attendeePhoneColumn`, optional like `ticketTypeColumn`: the
  placeholder writes nothing. Add it to `MARKED_COLUMNS`; tests beside the Ticket Type ones.
- Deploy, then replay each upcoming listing with `scripts/backfill-attendees.mjs`, which also fills
  Ticket Type on rows created before that column.

**Emailing.** Unchanged: Events' **Send event email** sends one message per address to a volunteer
event's volunteers. It does not include the lead; staff email the lead separately.

## Privacy

Several upcoming sign-ups use high-school addresses, so some volunteers are probably minors, and the two
forms checked have no question about sharing contact info with another volunteer. The view shows staff
everything; staff decide what each lead gets. A consent line on the Eventbrite form would be a staff
change, outside this design.

## Rollout

Sandbox v4, then production after the operator's go-ahead, stage 1 before stage 2. Stage 1 needs no
deploy, so it can be ready before the 2026-11-28 event. After production, rename the Volunteers group
"Group is Event and Date" (renamed from "Shifts" 2026-11-24) back to "Shifts", with Zachary's agreement.
Check the view in the UI, then update the Volunteers board description, the README's Volunteers section
and the cutover runbook's "For staff".

## Left to the builder

Column ids, the formula's exact text, test layout.
