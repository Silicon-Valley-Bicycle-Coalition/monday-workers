# UAT script: Eventbrite ticket orders and class emails

**Class emails: see the sections starting at "Class emails: try it".** Orders below are unchanged.

**Status 2026-11-02: nothing to test yet for orders.** The sandbox copy has been deployed since
2026-10-26, but it can't write a gift until the **Eventbrite Order ID** column exists on
Donations (sandbox v3) and its id is in the sandbox config, and a refund can't be recorded until
someone adds the **Refunded** Status label there. Production went live on 2026-11-02. This
script will be updated when the sandbox can take an order.

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

Everything above about orders: the sandbox copy is deployed but has no Eventbrite Order ID
column to write to. See `eventbrite-sync/README.md` "Deploy".

## Class emails: try it (sandbox)

For the Bike Education coordinator. Everything here uses a test class and **staff email addresses
only**; never register a real attendee. Each email is a Gmail draft you write. The **Send event
email** link on the class's Events item opens a page that sends it from your Gmail as `learn@`. In
the sandbox, every email goes to the sandbox address, whoever is on the list.

1. **Register.** Register 3 staff addresses on the test event in Eventbrite. Within a minute each
   should appear on Event Registrations with Attendance **Registered** and the class date, day and
   location filled in.
2. **Write a draft.** In Gmail, write the email From `learn@`, with `{{First Name}}` in the greeting
   and mail merge off.
3. **Send a reminder.** Before the class starts, click **Send event email** on the test class. Choose
   **Reminder** and your draft, check From, subject and the list of people, then click **Send a test
   to me**. Check the test in your inbox, then click **Send to 3 people**. The page shows the result,
   and an update on the Events item gives the kind, sender and count.
4. **Try to send it twice.** Reload the page. Reminder should show 3 sent already and nobody left.
5. **Check in some.** In Eventbrite check in two of the three. Attendance should change to
   **Attended** for those two. The third stays Registered.
6. **After the class ends.** Open the page again. Thank-you should list the two who checked in.
   Missed-you should say 1 person will get it and 2 checked in. Send both, testing each first. The
   third person's Attendance becomes **No Show**, and the two who came get linked to People.
7. **Nobody checked in.** Repeat with a second test class and check in nobody. After it ends,
   Thank-you and Missed-you should both be refused, with no send button. A volunteer checked in
   doesn't count.
8. **Not confirmed.** Ask for help with this one: it needs a send cut off partway. Those people show
   under **Not confirmed**. Releasing them right away should say they're too recent; after 10 minutes
   it should release them, and an update on the item should say how many. A person listed as
   **failed** can be released at any time.

## Class emails: look at

- Do the Thank-you and Missed-you emails read right, and are the bold, links and names correct?
- A person who checks in only some of a group: the others get a missed-you (known, see below).
- Is the warning clear when a Thank-you or Missed-you is for a class that ended more than 3 days ago?

## Class emails: don't report these

- Partial check-in sends a missed-you to anyone not checked in. Finish check-in before you send.
- A hand-added registration (not through Eventbrite) isn't on the list.
- A draft can only fill in `{{First Name}}`. Type each class's details into the draft.
- Spanish class day and date appear in English.

## Grant report: try it (sandbox)

1. Register for a test class on a Public or Group Rides event, entering a real 5-digit zip when asked.
   Within a few minutes, **Home Zip** on your row in Event Registrations should show it.
2. Register again with a 9-digit zip (`95112-1234`). Only the first 5 digits should appear.
3. Edit your Eventbrite answer to something that isn't a zip, like `call me`, then re-send the event with
   `scripts/backfill-attendees.mjs --event-id <id>`. Home Zip should keep the good value, and `call me`
   should appear nowhere in Monday. Editing an answer doesn't send a webhook (below), so the backfill is
   what picks the edit up.
4. Set **Grant** on the class in Events. Every registration for that class should show it straight away.
5. Open the **Grant report** view, filter to that Grant and date, and export it to Excel.

## Grant report: look at

- Does the export have what the funder asks for: name, email, class date, zip and attendance?
- Does the Grant filter pick up only that funder's classes?
- Is anything there that shouldn't be? Conditions, emergency contacts and other answers should never appear.

## Grant report: don't report these

- No Show stays blank until staff or the class email page mark it. It isn't automatic.
- Zip is empty when someone left it blank or typed something that isn't a zip.
- A zip corrected in Eventbrite after registering doesn't reach Monday on its own: editing an answer
  sends no webhook and doesn't change the attendee's `changed` time (tested 2026-11-09). It arrives with
  the attendee's next change, such as check-in, or a backfill of the event.
- Events on the volunteering, bike parking and private Eventbrite accounts get no zip.
- A class needs Grant set by hand. Until then it won't appear under any grant.

## Sandbox rehearsal, 2026-10-26

History: this tested the hourly follow-up job and Sequences, since replaced by the send page. The
feed findings still apply.

Run 2026-10-27 (UTC) against the sandbox Worker (`svbc-eventbrite-sync-sandbox`, D1
`svbc-eventbrite-sync-sandbox` with migrations 0001–0002) and the CRM Sandbox boards, which have no
Sequences, so no attendee could be emailed.

**Feed.** A real past class-sized event (a group ride that ended 2026-10-24 20:30 PDT, 126
registrations) and its canceled twin were delivered as pointers (one event delivery each, then one
attendee delivery per registration, with the shared secret in the header). Both events adopted their
existing Events items; all registrations were written, and every checked-in attendee was linked to
People. Posting faster than the rate limiter (60/min) got HTTP 429 and needed a resend at ~1/s; the
backfill script's `--pause-ms` covers this.

**Follow-ups.** With Class Type set and Follow-ups blank, the 03:00Z hourly run labelled 36
registrations Thank-you and 38 Missed-you (Attendance set to No Show), set Follow-ups to Sent, and
labelled no address twice. The 46 unlabelled Attended/Registered registrations all shared an
address with a labelled one (family registrations); no address with a check-in got a missed-you.

**Found and fixed during the rehearsal.**

- Eventbrite reports a canceled, removed event as `deleted`; it was treated as due and shown as
  Completed. Now only `live`, `started`, `ended` and `completed` events are due, and `deleted` shows
  as Canceled (re-delivered: the twin now reads Canceled).
- `getItems` read at most 25 items per call (Monday's default without `limit`); now 100.
- Monday shows the label with **id 5** as the text of an empty status cell. The sandbox Class Type
  and Follow-up Email columns had real labels at id 5, so every empty registration read as already
  labelled (the first run wrote nothing and set Sent) and every event without a Class Type read as
  "Bike Commuting (online)". Status cells are now read by stored value, and the setup checklist says
  to keep id 5 free; the sandbox columns were recreated without it.

**Sequences.** On a staff-only scratch board in the SVBC workspace (Sequences need a CRM workspace),
two Sequences sending from a connected staff mailbox, each with its "When Follow-up Email changes to
…, enroll" automation: setting each label enrolled the item (1/1 each). The emails send in the
Sequence's 7 AM–5 PM Pacific window.

**Not exercised live:** the Held path (no event in the window had zero check-ins; covered by unit
tests) and a real Eventbrite webhook delivery (deliveries were posted directly).

## Pledge to Ride: try it (sandbox, once the board exists there)

The board holds real pledges replayed from 2026, so treat it as private.

1. Open the **Pledge to Ride** board. There's one row per pledge, with Year, County, Days Pledged, Rider Type and Heard About It filled in.
2. Find a row where Details says **Buyer only**. Its name and email are the buyer's, County is Unknown, and Contact Consent is blank. That's expected: Eventbrite gave us no answers for that pledge.
3. Open the dashboard. Compare the total and county figures with what you expected from Eventbrite.

## Pledge to Ride: don't report these

- Unknown is separate from Outside on purpose. Past reports counted the two together, so Outside looks much smaller.
- 2025's total on the dashboard is lower than the 3,758 in its report, because that figure includes pledges from outside Eventbrite.
