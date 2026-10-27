# UAT script: Eventbrite ticket orders and class emails

**Class emails (attendee feed): see the last two sections.** Orders below are unchanged.

**Status 2026-10-19: nothing to test yet.** The integration is built but not running anywhere.
Before it can be switched on in the sandbox, the next sandbox load needs to create the
**Eventbrite Order ID** column on the Donations board, someone needs to add the **Refunded**
Status label there, create the sandbox D1 and queue, and set up its Eventbrite and Cloudflare
credentials. This script
will be updated when it is live.

## What it does

When someone buys a ticket to an SVBC event on Eventbrite, this adds the order to the
**Donations** board within seconds as a gift: the amount the buyer paid, Status **Received**,
Gift Type **Event Ticket**, Thank You Sent checked (Eventbrite already sent the buyer its
confirmation), and a **Donor** link to the buyer on People — created if they're new. A refund in
Eventbrite flips the gift to **Refunded**. Free registrations are ignored: they aren't gifts.
This is new — ticket revenue was never recorded as giving in Salesforce; the decision to count it
was made on 2026-09-30.

One order is one gift, however many tickets it contains, and the buyer is the donor. It does not
create Event Registrations items; that is a separate, later integration.

## Try it (once it is live in the sandbox)

1. **A paid order.** Buy a ticket on the sandbox test event. Within about ten seconds a new item
   should appear on [Donations (sandbox v3)](https://bikesiliconvalley.monday.com/boards/18431577310),
   named `<your name> - <event name>`, with Amount (what you paid, fees included), Date, Status
   **Received**, Gift Type **Event Ticket**, Fiscal Year Ending, Thank You Sent, Eventbrite Order
   ID, and a Donor link to your People item.
2. **A free order.** Register for a free ticket. Nothing should appear on Donations. That is
   correct.
3. **A refund.** Refund the paid order in Eventbrite. The gift's Status should become
   **Refunded** within a few minutes, and its giving totals on People should drop accordingly
   (the [donation rollups](donation-rollups.md) script's job).
4. **A new buyer.** Buy with an email address that isn't on People. A new People item should be
   created with that name and email; check it looks like a record you'd be happy to keep.

## What to look at while you're there

- Is the gross amount (what the buyer paid, Eventbrite's fees included) the number you want on
  the Donations board, or would you rather see SVBC's net?
- Is `<buyer> - <event>` a useful item name, or would you prefer the event first?

## Don't report these

- **Refunded** is not yet a Status label on the Donations board, so a refund write fails until
  someone adds it. Already on the pre-cutover list (shared with the Funraise sync).
- Bike Summit 2026 tickets sold before this goes live will be added in one batch after the
  Summit (Oct 22), not as they are sold.
- A ticket's gift has no link to an Event Registrations item. Known limit until the
  registrations integration exists.

## Not testable yet

Everything above. The Worker is code-complete but not deployed; see `eventbrite-sync/README.md`
"Deploy" for what has to happen first.

## Class emails: try it (sandbox)

For the Bike Education coordinator. Everything here uses a test class and **staff email addresses only**; never register a
real attendee. The Worker only sets a label; Monday sends the email from `learn@`.

1. **Set up the class.** On the sandbox Events board, find the test class (it appears when the
   Eventbrite event is created or updated) and set **Class Type**.
2. **Register.** Register 3 staff addresses on the test event in Eventbrite. Within a minute each
   should appear on Event Registrations with Attendance **Registered** and the class date, day and
   location filled in. Class Type stays blank on the registrations until the morning follow-up run
   copies it from the event (step 5).
3. **Send a reminder.** Open the **Class reminders** view, filter to the test class, select all,
   open Mass email, pick `Reminder: <class type>`, fill the `[ … ]` notes and send. Check the
   email lands in the staff inboxes.
4. **Check in some.** In Eventbrite check in two of the three. Attendance should change to
   **Attended** for those two. The third stays Registered.
5. **Morning after.** After 08:00 Pacific the day after the class ends (the job runs hourly, so
   allow until the next hour), the two checked-in rows get Follow-up Email `Thank-you: <class
   type>`, the third gets `Missed-you: <class type>` and its Attendance becomes **No Show**, and
   all three get the event's Class Type. The matching emails arrive from `learn@`. The test
   event's **Follow-ups** then turns to **Sent** — that is what stops the class being emailed
   twice.
6. **Held.** Repeat with a second test class and check in nobody. The event's **Follow-ups**
   should turn to **Held** and you should get a Monday notification. Check someone in, then
   clear Held: the follow-ups run on the next hourly pass. (Only within 3 days of the class end.)

## Class emails: look at

- Do the Thank-you and Missed-you texts read right, and are the bold, links and merged names
  correct?
- A person who checks in only some of a group: the others get a missed-you (known, see below).

## Class emails: don't report these

- Partial check-in sends a missed-you to anyone not checked in. Check everyone in before 08:00
  the next morning.
- A hand-added registration (not through Eventbrite) gets no follow-up.
- Reminders show a `[start time]` note: there is no Class Time column yet.
- Spanish class day and date appear in English.
- Thank-you Sequences are created paused until the upcoming-classes list is refreshed.
- A class that ended more than 3 days ago never emails, even if Held is cleared.

## Sandbox rehearsal, 2026-10-26

Results recorded below once the rehearsal runs.
