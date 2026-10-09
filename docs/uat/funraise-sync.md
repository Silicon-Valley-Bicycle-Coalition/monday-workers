# UAT script: Funraise sync

**Status 2026-10-06: testable now.** The sandbox copy was moved onto the `(sandbox v3)` boards
on 2026-09-30. The 53 Funraise gifts made since 2026-09-19, which had been held while it still
pointed at the deleted v2 boards, were added to Donations (sandbox v3) the same evening, and
Recurring Gifts (sandbox v3) now mirrors all 1,176 Funraise plans. The first new gift after the
move arrived on its own nine seconds after it was made.

## What it does

When someone gives on Funraise, this adds the gift to the **Donations** board within seconds,
linked to the donor's People item, and creates the People item if the donor is new. Once an hour
it also copies every Funraise recurring-giving plan onto the **Recurring Gifts** board and keeps
it current: new plans appear, cancellations mark the plan Cancelled. It replaces the Funraise →
Salesforce sync that posts Opportunities today.

## Where it runs, and why real gifts show up here

Funraise allows one webhook per organization, and until cutover it points at this sandbox copy.
So **a real donation made on Funraise today is supposed to land on Donations (sandbox v3)**, not
in some test area. This is safe: the board is a disposable copy, and the integration only writes
to Monday. It sends no email and touches nothing in Funraise.

## Try it

1. **Watch a real gift arrive.** Open
   [Donations (sandbox v3)](https://bikesiliconvalley.monday.com/boards/18431577310), **Recent
   gifts** tab. The next time a Funraise donation comes in, a new item should appear within about
   ten seconds, with: Amount, Date, Status **Received**, Fiscal Year Ending, Gift Type
   **Donation** (or **Event Ticket** for a paid event), **Thank You Sent** checked (Funraise sent
   its own receipt), and a **Donor** link to the person on People. If the gift is one payment of a
   recurring plan, **Recurring Gift** links to that plan too.
2. **Send a test gift yourself.** In Funraise, go to Settings → Webhooks and press **Test**. That
   delivers a fake gift from "Lorem Ipsum" for $123.12. It should appear on Donations the same
   way. Its Recurring Gift column stays empty, which is correct. Tell the migration team when you
   have done this so the test item and its bookkeeping can be removed.
3. **Follow the links.** Open the new gift's Donor. Their giving totals on People should already
   reflect it (that is the [donation rollups](donation-rollups.md) script's job). By the next
   morning the gift's Funding Stream, Gift Size, Fiscal Quarter, and Gift Fiscal Year columns fill
   in.
4. **A new donor.** If the giver isn't matched to anyone on People by Funraise profile or personal
   email, a new People item is created with their name, email, address, and Funraise Profile link.
   Check it looks like a record you'd be happy to keep.
5. **Recurring plans.** Open
   [Recurring Gifts (sandbox v3)](https://bikesiliconvalley.monday.com/boards/18431577263),
   **Active** tab, sorted by Next Payment. A new monthly or yearly donor's plan should appear
   within about an hour of being created in Funraise, with Installment Amount, **Annualized
   Value** (monthly × 12, quarterly × 4), Frequency, Status, Next Payment, Designation, and the
   Donor link. Cancelling a plan in Funraise turns Status to **Cancelled** and clears Next Payment
   on the next hourly pass. If many plans changed at once it can take a few hours, since each pass
   handles ten.
6. **A refund.** Refunding a gift in Funraise should flip its Donations item to Status
   **Refunded**. See the first item under Don't report these.

## What to look at while you're there

- Is Annualized Value the number you want for stewardship tiers, rather than Installment Amount?
- A card payment that fails in Funraise also arrives, as an item with Status **Failed** (ten of
  the 53 caught-up gifts are like this). Is it useful to see those on Donations, or is it noise?
  Note they also carry Thank You Sent checked, which is probably not what you want.
- The board mirrors every Funraise plan, including 568 old ones whose payment details Funraise
  has redacted under its data-retention rules. They show Status **Redacted**. Is that the right
  way to see them, or would you rather they were hidden by default?

## Don't report these

- **Refunded** is not yet a Status label on the Donations board. Until someone adds it, a refund
  write fails quietly. It is on the pre-cutover list.
- A gift migrated from Salesforce in an archived fiscal year (FY2025 or earlier) that is later
  edited or refunded in Funraise is **not** written to the board. It is flagged for staff and no
  duplicate is created, but nothing surfaces the flag on a board yet.
- Migrated gifts that this integration recognises as its own never get Thank You Sent, Gift Type,
  or Fiscal Year stamped afterwards; only new gifts do.
- The **Event Ticket** gift type label hasn't been confirmed against a real paid-event purchase
  yet.
- Dedication and comment text from Funraise comes across as written; it isn't scrubbed.

## Not testable yet

Nothing here is blocked. After cutover, the real Funraise webhook moves to production. The real
gifts that landed on this sandbox copy over the cutover weekend are replayed into production by
the engineers, so nothing given during the weekend is lost; from then on the sandbox copy is
exercised only with the Test button or a replayed delivery.

---

*Engineers: [`funraise-sync/README.md`](../../funraise-sync/README.md) has the data flow, the
"Deployed and verified" record, and the poller design.*
