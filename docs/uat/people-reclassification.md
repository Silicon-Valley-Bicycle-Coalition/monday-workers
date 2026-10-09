# UAT script: People board housekeeping (reclassification)

**Status 2026-10-09: nothing to test yet.** The integration is built but not running anywhere,
and when it is first switched on it will only *report* what it would do, not move anything.
This script will be updated when it is live in the sandbox.

## What it does

Monday.com allows at most 10,000 items on one board. That is why there are two People boards:
**People** (everyone with activity in recent years) and **People (Historical)** (everyone
else). The migration decides who goes where once; nothing keeps it right afterwards. This
integration does: every quarter (or sooner, if People gets close to full) it looks at each
person's most recent activity — their last gift, their membership term, an event they attended
or a ticket they bought, volunteer hours — and moves anyone with nothing in the last **seven
years** to People (Historical). It also moves people the other way: a lapsed donor on
Historical who gives again comes back to People, so you see them where you work.

A person's item keeps its id, its Updates thread and its links to gifts and organizations when
it moves. Someone with **no** activity recorded at all (a city staff contact, someone added by
hand) is never moved.

## Try it (once it is live in the sandbox)

1. **A reactivated donor.** Find someone on
   [People (Historical) (sandbox v3)](https://bikesiliconvalley.monday.com/boards/18431577228)
   whose Last Gift Date is years ago, and add a gift for them on Donations (sandbox v3) dated
   this month (the donation-rollups script shows how). After the next pass runs, they should be
   on [People (sandbox v3)](https://bikesiliconvalley.monday.com/boards/18431577220) with their
   gifts, organization and Updates intact.
2. **Someone who aged out.** After a pass, open the newest group on People (Historical): the
   people moved there should all have a Last Gift Date, Member Until and event history more than
   seven years old — and nothing newer. Report anyone who looks current.
3. **Nothing lost.** Pick a moved person and open their item card: every column that was filled
   in before (email, address, membership, giving totals) should still be filled in.

## Don't report these

* People with no gifts, membership or events at all staying on People — by design.
* Lifetime members and anyone with a Funraise profile staying on People however old their last
  gift is — by design, matching how the migration placed them.
