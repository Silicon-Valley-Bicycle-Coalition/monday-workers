# UAT script: Bike Parking organizer feedback email

**Status 2026-09-30: testable now.** Confirmed working end to end on 2026-09-21.

## What it does

After a bike valet event, staff mark the event's request item **Ready to Send**, and the
organizer gets an email with a link to the post-event feedback form. It replaces the manual
"remember to email the organizer the survey" step. Nothing else changes; it doesn't read the
form's answers.

## Safety

In the sandbox every email goes to the shared inbox **`sandbox@bikesiliconvalley.org`**, whatever
organizer address is on the item. You can use a real request with a real organizer email; they
will not receive anything.

## Try it

1. Open [BP Request Form (sandbox)](https://bikesiliconvalley.monday.com/boards/18441421707) in
   the CRM Sandbox v4 workspace. Pick any item with an address in **Preferred Email
   Address For Coordination**, or create one. That column, and **Event Name**, are what the email
   uses; nothing else on the item matters.
2. Set its **Post-Event Feedback** column to **Ready to Send**.
3. Within a few seconds, check `sandbox@bikesiliconvalley.org`. Expect an email from **SVBC Bike
   Valet (sandbox)** naming the event (Event Name, or the item name if that is blank), with a link
   to the feedback form. Open
   the link and confirm the form loads. Is the wording what you'd want an organizer to read?
4. Set the column to **Sent to Organizer** yourself. See the first note below.
5. Set it back to Ready to Send. **No** second email arrives: the Worker emails each item at most
   once every 24 hours, however many times it's triggered. Is a day the right wait before a
   re-send is allowed? Inside it, a re-send needs an engineer.
6. Clear the item's Preferred Email Address For Coordination and set it to Ready to Send again.
   No email arrives: the Worker only sends to the address on the item.

## Don't report these

- The column does **not** flip to Sent to Organizer on its own; staff set it after the email goes
  out. The automatic write-back exists but is switched off in the sandbox.
- An item emailed in the last 24 hours (by anyone's test) sends nothing when set to Ready to Send
  again. Pick a different item, or wait a day.
- The email's branding is the shared SVBC template; wording changes are Feature Requests, not
  bugs.

## Not testable yet

- **Steps 2 to 6, until the sandbox board's webhook automation is added** (it was rebuilt on 2026-11-24
  without one; see "Monday automation setup" in the Worker's README).
- The automatic Sent / Failed write-back to the item.
- The production version is live (2026-11-03), but no real organizer email has gone out through
  it yet.

---

*Engineers: [`bp-feedback-notify/README.md`](../../bp-feedback-notify/README.md) has the
Monday automation setup and the sandbox verification record.*
