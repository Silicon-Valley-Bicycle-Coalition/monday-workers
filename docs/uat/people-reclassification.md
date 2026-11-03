# UAT script: People board housekeeping (reclassification)

**Status 2026-11-03: live.** In the sandbox, the first live pass moved 400 people to People
(Historical) and every value and link checked survived the move. In production it runs for
the first time on 2027-01-01, and quarterly after that.

## What it does

There are two People boards: **People** (everyone with activity in recent years) and **People
(Historical)** (everyone else). The split keeps your day-to-day board to people you're likely to
work with. (It was first made because a board was thought to hold at most 10,000 items. SVBC's
real limit is 100,000, so neither board is close to full.) The migration decides who goes where
once; nothing keeps it right afterwards. This integration does: every quarter it looks at each
person's most recent activity — their last gift, their membership term, an event they attended
or a ticket they bought, volunteer hours — and moves anyone with nothing in the last **seven
years** to People (Historical). It also moves people the other way: a lapsed donor on
Historical who gives again comes back to People, so you see them where you work.

A person's item keeps its id, its Updates thread and its links to gifts and organizations when
it moves. Someone with **no** activity recorded at all (a city staff contact, someone added by
hand) is never moved.

## Try it (once it is live in the sandbox)

1. **A reactivated donor.** Find someone on
   [People (Historical) (sandbox v4)](https://bikesiliconvalley.monday.com/boards/18437342607)
   whose Last Gift Date is years ago, and add a gift for them on Donations (sandbox v4) dated
   this month (the donation-rollups script shows how). After the next pass runs, they should be
   on [People (sandbox v4)](https://bikesiliconvalley.monday.com/boards/18437342592) with their
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
