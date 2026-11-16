# UAT script: donation rollups

**Status 2026-11-02: testable now, on the `(sandbox v4)` boards.** The integration moved there on
2026-10-28. A gift added on the older `(sandbox v3)` Donations board no longer updates anyone's
totals, so use the v4 links below.

## What it does

Whenever a gift is added, changed, archived, or deleted on the Donations board, this recalculates
that donor's giving totals on their People or Organizations item within seconds. It also grants
and extends membership terms when a qualifying gift lands, fills in the chart columns and
Acknowledgment Tier on Donations overnight, and writes one row per closed fiscal year to Annual Giving Summary. In
Salesforce these were NPSP rollups and reports you pulled; here they are columns that stay
current on their own.

It only writes to Monday. No email, no external system.

## The columns it keeps current

On **People**, **People (Historical)**, and **Organizations**: Lifetime Giving, Gift Count, First
Gift, This Year Amount and Count, Last Year Amount and Count (fiscal years run July to June),
Largest, Smallest, and Average Gift, Last Gift Date and Amount, the machine-readable Gift
Ledger, and **Donor Level** (Leadership at $5,000 or more lifetime;
Major at $500 lifetime or a single gift of $200 or more; Donor for anyone with a gift; blank
otherwise). On People and People (Historical): Membership Status, Tier, Member Since, Member
Until. On Affiliations: Attributed Giving, Attributed Gift Count, Last Attributed Gift.

Only gifts with Status **Received** count. "Received (Historical)", Pending, Failed, and Refunded
do not.

## Try it

1. **Add a gift and watch the totals move.** On
   [Donations (sandbox v4)](https://bikesiliconvalley.monday.com/boards/18437342657) add an item:
   pick a person you know as **Donor**, set **Amount**, today's **Date**, Status **Received**, Gift
   Type **Donation**. Open that person on
   [People (sandbox v4)](https://bikesiliconvalley.monday.com/boards/18437342592). Within about a
   minute their Lifetime Giving, Gift Count, Last Gift Date and Amount, This Year Amount, and, if it
   is their biggest, Largest Gift should reflect it. Donor Level moves up if the gift crosses a
   threshold.
2. **Change it, then remove it.** Edit the Amount; the totals follow. Delete the item (or archive
   it); the totals fall back. Both should take well under a minute.
3. **Give a membership.** Add a gift with Gift Type **Donation**, Status Received, an Amount of
   **$1 or more**, and today's **Date**. The person
   is a member for 13 months from that date: they should gain or extend Member Since and Member
   Until, get Current Term Start, Member Type (New, Continuing, or Lapsed renewal), Membership
   Tier **Member** (or **Lifetime** for $1,000 and up), and Status **Active**. A gift dated
   on or after the sandbox's membership start date (2026-10-01) also gains Term Start,
   Term End (13 months later) and Membership Type.
   A term is only ever extended, never shortened, so a second gift dated earlier can move Current
   Term Start and Lapse Count, but never shortens Member Until.
4. **Come back the next morning.** The chart columns on your new gift, Funding Stream, Gift Size,
   Fiscal Quarter, and Gift Fiscal Year, and its Acknowledgment Tier fill in overnight (the
   nightly pass runs around 2 am Pacific, 1 am in winter). Editing them by hand is ignored: they are derived from Gift Type, Amount, and Date.
   A gift with Gift Type **Donor Advised Fund**, typed exactly, reads Funding Stream **Donor Advised
   Funds** and renews the donor's membership the way a Donation does.
5. **Annual Giving Summary.** Open
   [Annual Giving Summary (sandbox v4)](https://bikesiliconvalley.monday.com/boards/18437530607):
   one row per closed fiscal year, FY2005 and FY2009 through FY2025, with Total Received, Gift
   Count, and the By Gift Type split. Check a year you remember. This board only changes when a
   year closes (July 15), so it won't move during UAT.
6. **An organization's gift.** Repeat step 1 with an organization as Donor and check its totals on
   [Organizations (sandbox v4)](https://bikesiliconvalley.monday.com/boards/18437342579).

Clean up the test gifts when you are done, or leave them named "UAT test" so they are easy to
spot.

## Questions we need your answer on

- **Membership gifts.** Today only Gift Types **Donation** and **Donor Advised Fund** grant a term; a gift typed
  **Membership** counts toward totals and the Membership funding stream but does not set Member
  Until. Is that right for how membership payments arrive, or should Membership-typed gifts count
  too?
- **Lifetime at $1,000.** A single gift of $1,000 or more sets Tier to Lifetime. Confirm that
  threshold.
- **No grace period.** Status goes Lapsed the day after Member Until (that flip is a board
  automation, not this integration). Do you honour late renewals for some window?

## Don't report these

- A blank **Fiscal Year Ending** on a gift is fine; the year is derived from Date.
- The per-donor gift history that was meant to appear in the item's description isn't written on
  this account; the Gift Ledger column carries it instead.
- On the day a membership expires, Status can read Active and then Lapsed within the same day.
- A refund does not take back a membership term that was already granted.
- Gifts marked "Received (Historical)" (Closed Won gifts staff keyed in by hand) are deliberately
  excluded from totals. Eventbrite's paid ticket orders also reach Salesforce as Closed Won, and
  until the next load they are excluded too — that is why FY2026 Individual Giving read about
  $11,900 lower than the Salesforce report on 2026-09-29. The importer now maps them to Received
  / Event Ticket, so expect the gap to close once the boards are reloaded.

## Not testable yet

- **Volunteer-granted memberships.** An attended volunteer registration is meant to grant a term
  the way a Donation does, but no registration board is connected yet.
- The **Annual Giving Summary** restate for the current year (happens each July).
- The nightly **reconcile** check that repairs any drift; it runs, but there is nothing for you to
  see unless it finds a problem.

---

*Engineers: [`donation-rollups/README.md`](../../donation-rollups/README.md) has the ledger
design, the membership write path, the custodian duties, and the operational findings.*
