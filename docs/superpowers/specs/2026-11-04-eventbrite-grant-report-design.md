# Eventbrite grant report — Design

**Date:** 2026-11-04
**Status:** Approved by David 2026-11-04. Built 2026-11-06. Accepted in the sandbox 2026-11-09: one VTA class backfilled (23 of 23 valid zips),
and a test event with a live registration (`95112`), a ZIP+4 (`95112-1234` written as `95112`), and an
answer edited to `call me` (zip kept, text absent). Not yet in production. Replaces a counts-only draft (see "Dropped").
**Worker:** `eventbrite-sync` (extends the attendee feed from
`2026-10-26-eventbrite-attendees-class-emails-design.md`).

## Why

Staff use Eventbrite's custom-questions report for grant reporting, and asked whether Monday can show it
after a class. Staff's answers (Box note "Grant question reporting in Monday - for review", 2026-11-04):

* Funders request **name, email, date attending, zip code, checked in, no show and canceled**, per person.
* Each class ties back to one grant, from VTA or SMCTA.
* Age, gender and ethnicity are no longer asked on VTA/SMCTA forms. Detailed responses moved to the
  post-class survey, already a Monday form. The conditions and accommodation questions are internal.
* Instructors check people in on online classes too.
* Data before November 2026 is already captured, so this runs from November 2026 forward.
* The waiver sign-off is not a funder requirement for the report (staff, 2026-11-05), so no waiver column.

Event Registrations already holds nearly all of this. Two things are missing: the zip and the grant.

## Goals

* Staff can pull a funder's list from one Monday view, filtered by grant and date, and export it.
* A dashboard shows registrations and attendance by grant and by zip.

## Non-goals

* Other custom answers in Monday. This feature brings over only the zip, however many questions a form asks. A new
  question stays in Eventbrite until someone decides to bring it over.
* Counts per question, and an Answer Counts board (see "Dropped").
* Classes before November 2026.

## Must never happen

* Free text reaches Monday, D1 or the logs. Someone can type anything into a zip field.
* An emergency-contact, street-address, health or other non-zip answer reaches any of those places.

## Design

### Home Zip on Event Registrations

A new text column **Home Zip**, written by the attendee consumer alongside the rest of the registration,
and added to `MARKED_COLUMNS` as locked.

* **Which question.** An answer whose question type is `text` and whose wording contains the whole word
  `zip` or `zipcode`, any case: "What is your home ZIP code?", "Home Zip Code", "Mailing Zip Code". "Do you
  use Zipcar?" doesn't match. The first such answer with a valid value wins.
* **Which value.** After trimming, the value must match `^\d{5}(-\d{4})?$`. Only the first 5 digits are
  kept. Anything else is treated as no answer, and the text is discarded.
* **No valid answer** leaves the column as it is, so a later bad edit can't erase a good zip.
* **Which events.** Only programs in `attendeeSync.zipPrograms`, shipped as `["Public", "Group Rides"]`, and
  only where the form asks for a zip. Program follows the Eventbrite organizer account, and the main account
  is `Public`, so a ticketed event there, like the Bike Summit, gets a zip if its form asks. Volunteering, bike
  parking and private accounts get none. Eventbrite has no separate fundraiser account.
* **Off switch.** `registrations.homeZipColumn` set to the placeholder id means no zip is written, so a
  deploy can precede the column and a fork can leave it out.

Zip is stored against a named person, on a board every CRM seat can read. David accepted this on 2026-11-04,
reversing the draft's "no answer stored against a person": funders require it, the same row already holds
name and email, and this feature stores no other answer. (The Attendee Phone column and the Pledge to Ride
board, added separately, read answers of their own.)

Nothing new goes in D1. The zip stays out of log lines and debug skip lines.

### Grant

A dropdown **Grant** on Events, set by staff, with labels VTA and SMCTA to begin with. Event Registrations
gets a mirror of it through the existing Event link, so setting Grant once covers every registration, and a
correction applies straight away. No Worker code reads or writes Grant.

### Report view and dashboard

On Event Registrations, a **Grant report** table view with Name, Attendee Email, Class Date, Home Zip,
Attendance and Grant, filtered by Grant and date, exportable to Excel. Attendance carries checked in
(Attended), canceled and no show. A dashboard charts it by Grant and quarter; `Home Zip` groups as text.

**No Show** stays as it works today: set by staff or by the class email page, not by the Worker (David,
2026-11-05). A registration nobody marks stays unresolved, so a funder's no-show count relies on staff marking
each class. Eventbrite records check-ins, not absences, so an automatic rule couldn't tell "nobody came" from
"nobody took attendance".

### Classes already written

A class whose registrations were written before this deploy gets its zips from the existing
`scripts/backfill-attendees.mjs`, which re-drives each attendee. No new script is needed.

## API and Monday findings

Checked 2026-11-06, read-only, against three past events (a Bike Summit ride, a VTA online class and a
Commute.org class, 80 attendees), keeping tallies only:

* The single-attendee fetch the consumer already makes returns `answers`, with no `expand` needed.
* Each answer entry carries `answer`, `question`, `question_id` and `type`, so no call to `/questions/` is needed.
* Answers are on the attendee. Order rows carry none.
* The two classes' zip entries were all valid or blank: 36 valid, 6 blank, 0 invalid.
* The ride's "Mailing Zip Code" had 7 valid, 26 blank and 5 invalid: 4 with no digits, and 1 with digits but no
  5-digit run. The rule rejects these as intended.
* Editing an answer in Eventbrite (organizer side, 2026-11-09) sends no `attendee.updated` and leaves the
  attendee's `changed` time as it was, so a corrected zip waits for the attendee's next change or a backfill.
* Classes do record check-ins (17 of 25, and 9 of 17), but the ride recorded none, which is why an automatic
  No Show would be unsafe.

Confirmed 2026-11-04 on the sandbox: a dropdown Grant on Events (`dropdown_mm8t5b6g`), mirrored to Event
Registrations through the Event link (`lookup_mm8t69ex`), filters as a normal "Grant is VTA" in a table view
(261 of 7,030 test rows). Both columns can be created through the API. A dashboard chart can also group by a
text column and sum a numbers column, and filter by "contains" on a text column.

## Open questions for staff

1. When is the next report due?
2. Is VTA or SMCTA the full grant list? Some live event names say "Commute.org TA C/CAG".

## Dropped

**Counting answers per class on a new board**, the earlier draft of this design. It assumed funders want totals
and that funders' multiple-choice questions keep changing, and neither holds for these reports. If funders bring
back other questions, counting by type (radio, dropdown and checkbox verbatim, nothing else) remains the way
to add them without putting those answers against a name.

## Testing

* **Unit:** the zip wording match, ZIP+4, whitespace, invalid text appearing in no output, first valid answer
  wins, no answer leaves the column out, program scope, the placeholder column.
* **No leaks:** an attendee carrying emergency-contact, health and free-text answers leaves no trace in the
  write or in log lines, including debug skip lines.
* **Config guard:** the two configs share no Home Zip column id once both are set.
* **Sandbox:** one test registration, with a valid and then an invalid zip edit, and one class re-driven with
  the backfill script.

Update `eventbrite-sync/README.md`, `docs/uat/eventbrite-sync.md` and the root README's status table in the
same change.
