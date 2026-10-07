# UAT script: Eventbrite ticket orders

**Status 2026-10-06: nothing to test yet.** The integration is built but not running anywhere.
Before it can be switched on in the sandbox, someone needs to add an **Eventbrite Order ID** text
column and the **Refunded** Status label to the Donations board, create the sandbox D1 and
queue, and set up its Eventbrite and Cloudflare credentials. This script
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
