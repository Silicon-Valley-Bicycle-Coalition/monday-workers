# UAT script: the Monday.com boards

**Last checked 2026-10-06, corrected 2026-11-11** against the `(sandbox v4)` boards in
[CRM Sandbox v4 (migration rehearsal)](https://bikesiliconvalley.monday.com/workspaces/18210301).
Item counts are from that day.

This script is about the *boards*: are the views the lists you actually need, is the information
where you'd look for it, does adding or editing a record feel workable. Whether every record came
across from Salesforce correctly is the migration guide's sample review, not this. Where an
automation feeds a board, the relevant Worker script is linked.

Every board here follows the same conventions, so once you've learned one you've learned them
all:

- **The first tab is a working view**, named for what it's for, showing six to nine columns in
  reading order, grouped by the one thing that matters on that board. The unfiltered every-column
  view is the last tab.
- **Plumbing columns are hidden** in working views: Salesforce Debug, Salesforce Owner, Lat, Lng,
  Gift Ledger (JSON), the Funraise, Eventbrite, and Benevity IDs. They're still on the board.
- **🔒 and 📜 mean don't edit.** A column titled 🔒 is filled in by an automation (Lifetime
  Giving, Donor Level, Membership Status, Funding Stream, the Funraise ID, and so on). Change it
  by hand and the next nightly or sync run puts the computed value back, or the link to the
  outside system breaks. A column titled 📜 is history brought over from Salesforce once
  (Salesforce ID, Volunteers 2014–2020). Nothing updates it, and it stays as
  the record of what Salesforce held. If a 🔒 or 📜 value looks wrong, report it rather than fixing
  it in place. Columns without a marker are yours to edit.
- **One colour language:** red means needs action, amber means coming due, grey means
  historical. (Shading is unconfirmed on screen; see the README's known gaps.)
- **Worklists are named as tasks** ("Major gifts to thank", "Members expiring soon") and tagged
  Worklist; number views are tagged Report; look-up views are tagged Reference.

Two things to try on **every** board, before the per-board steps:

1. Open each tab. Is the first tab the list you'd want to see when you open the board? Is there a
   list you run today that isn't here?
2. Click an item's name to open its card. Can you find what you need without scrolling past
   fields you never use? Item cards are meant to show grouped sections (Contact, Giving summary,
   Membership, Links, then Migration details collapsed); that layout is still to be set by hand,
   so today you'll see one long list. Say whether the grouping would help.

---

## People

[People (sandbox v4)](https://bikesiliconvalley.monday.com/boards/18437342592), 8,044 items:
everyone with real activity since about 2019. Replaces Salesforce Contacts, with membership
status right on the record instead of tracked separately.

**Tabs:** **Find a person** (opens here; sorted by name) · **Donors** (grouped by Donor Level:
Leadership, Major, Donor, blank) ·
**Major donors** · **Donors to target** (Worklist: last gift $250 or more, most recent first) ·
**Gave last year, not this year** (Worklist: the lapsed-donor call list) · **Appeal list**
(donors with an email and no Do Not Solicit flag, grouped by level) · **Postal appeal list**
(donors with an address, a gift of $25 or more in the last five years, and neither Do Not Solicit
nor Do Not Mail, leaving out anyone with an active recurring gift; deceased contacts carry Do Not
Solicit) · **Board donor call list** (Worklist: gave in the last three months, has a phone, no Do
Not Solicit; biggest last gift first) · **Gave last fiscal year (990)** (each donor's total for the
last closed fiscal year) · **Donor portfolios** (grouped by Relationship Owner) · **Members** (everyone with
a membership status, sorted by Member Until; amber within 60 days, red when lapsed) · **Active
members** (the Board Elections export) · **By city** · **Stakeholders** · **By campaign** ·
**Do Not Solicit** · **DNS reason missing** (Worklist, red) · **Renewals this month and next**
(Worklist: Member Until this calendar month or next, red when lapsed; emailed on the 1st and 15th) ·
**Possible duplicates** (Worklist: items staff flagged with Possible Duplicate).

**Try it:**

1. On **Donors**, find three people you know well. Do Lifetime Giving, Last Gift, and Donor Level
   match your sense of them? Donor Level is set automatically: Leadership at $5,000 or more
   lifetime, Major at $500 lifetime or any single gift of $200 or more.
2. Open **Gave last year, not this year**. This replaces the "Weekly Individual Donors Data"
   Salesforce report. Is it the list you'd call from?
3. Open **Members**. Scroll to the people whose Member Until is within the next two months. Are
   those rows shaded amber? Are lapsed rows red? Tell us either way.
4. Open **Active members**. This is the annual Board Elections voter list; in November it's
   exported for Election Runner from here. Is anyone missing who should be able to vote?
5. Open a member's card. Membership Status, Tier (Member or Lifetime), Member Since, and Member
   Until are on the person. **Stakeholder Type** (Individual Donor, City or Agency Staff,
   Elected Official, Partner Org Contact) is there too. Elected Official is pre-filled from
   Salesforce's Elected flag after the next load; the other types are filled by the review pass.
6. **Add a person.** Search by name and email first (and check People (Historical) if they're not
   found). Then add a new item with Personal Email, Phone, Address. Nothing else is required;
   totals and history populate as records link to them. Name it "UAT test" so it's easy to find
   later.
7. **Someone who represents an organization and also gives personally.** One People item; link
   it to the organization through **Affiliations** (see below), not by creating a second person
   for their work email. Try it on your test person.
8. **Do Not Solicit.** Check the box on your test person without filling in a reason. They should
   appear on **DNS reason missing**. Fill in the reason and set **DNS Reason Status** to
   Confirmed; they drop off the worklist. (This also drives the Mailchimp unsubscribe; see the
   [Mailchimp sync](mailchimp-sync.md) script.)

**Not testable yet: bulk-loading a batch of new contacts.** If you've used the "Protocol for
Dataloading Contacts + Campaigns into Salesforce" process (BTWD outreach, a bike parking
recruitment push, any spreadsheet of people loaded at once), its Monday replacement is designed
around the **Campaign** tag column but hasn't been rehearsed here. If that process matters to
you, say so on IT Requests so it's prioritised before cutover.

**Don't report these:** Personal Email Consent reads "Not in Mailchimp" for everyone (load ran
without the consent file). People move between this board and People (Historical) on a schedule (see
[people-reclassification.md](people-reclassification.md)). You can no longer merge duplicates
yourself: set **Possible Duplicate** on the item and add an update naming the other record; David
reviews and merges. A tab called **Drafts to
confirm** with nothing in it is a leftover from the load and will be removed.

## People (Historical)

[People (Historical) (sandbox v4)](https://bikesiliconvalley.monday.com/boards/18437342607),
8,062 items, same shape as People: everyone with **no** activity since about 2019. The split is
by recency, not importance, so People stays focused on people you're likely to work with. It
was first made to fit a 10,000-item board limit; SVBC's real limit is 100,000. Nothing is lost.
Each quarter, people with no activity in seven years move here, and anyone here who becomes
active again moves back.

**Tabs:** **Find a person** (opens here) · **Active again** (Worklist: anyone here who has
given or renewed since the split, and so belongs on People) · **Do Not Solicit** · **DNS reason
missing** · **Possible duplicates**.

**Try it:** search for someone who "used to give" and doesn't turn up on People. Look at
**Active again**: anyone listed belongs on People. Don't move them by hand; set **Promote to
People** to Promote on their item (see [people-reclassification.md](people-reclassification.md)).

## Organizations

[Organizations (sandbox v4)](https://bikesiliconvalley.monday.com/boards/18437342579), 1,888
items: bike shops, corporate partners, funders, cities and agencies. Replaces Salesforce Accounts.

**Tabs:** **Find an organization** (opens here) · **Organizations** (grouped by Donor Level) ·
**Untyped** (Worklist:
organizations with no Partner Type) · **Municipal** · **Funders and matching companies** ·
**Do Not Solicit** · **DNS reason missing**.

**Try it:**

1. Open a bike shop, a funder, and a city. Do Partner Type, Website, and the giving totals read
   right? Website was filled from Google Places where Salesforce had none.
2. **Untyped** is the cleanup list. Partner Type is a dropdown of ten values. Pick one on a blank
   organization and check that it leaves the list.
3. **Discount Offered** and **Discount Active** are what the donor portal shows members as
   partner bike-shop discounts. Set one on a shop and check it in the
   [donor portal](member-portal.md) script.
4. There's no Organization → People column. To see everyone at an organization, open
   **Affiliations** and use **By organization**. Is that workable, or do you need the list on the
   organization's card?

## Affiliations

[Affiliations (sandbox v4)](https://bikesiliconvalley.monday.com/boards/18437342615), 6,278
items: one row per person-at-organization relationship, with Affiliation Role, Start and End,
Primary, a Work Email with its own consent, and **Attributed Giving** (gifts the person gave on
that organization's behalf). This is new; Salesforce hid these links inside Contact and
Account fields.

**Tabs:** **Drafts to confirm** (opens here; Worklist: links the import inferred from Salesforce
that a person should confirm or reject) · **Current** · **By organization**.

**Try it:**

1. Work through a few **Drafts to confirm**. Is enough information on the row to decide without
   opening Salesforce? Confirm one by setting its Status.
2. On **By organization**, open a company you know. Are the right people listed with the right
   roles?
3. Add an affiliation for your UAT test person: new item, set Person, Organization, Role, Primary.
   Open the person's card and confirm it appears under Affiliations, and that Employer Name now
   shows the organization.

## Donations

[Donations (sandbox v4)](https://bikesiliconvalley.monday.com/boards/18437342657), about 3,880 active
items (FY2026 and FY2027 to date, growing as Funraise gifts arrive) plus about 44,800 archived (FY2025 and earlier, on the same
board). Replaces Salesforce Opportunities: one board for the whole history, with the current and
previous fiscal year (July to June) active and everything older archived in place.

**Tabs:** **Recent gifts** (opens here; grouped by Gift Fiscal Year, newest first) · **Revenue
by funding stream** (Report; each group's footer sums Amount) · **By gift size** · **By fiscal
quarter** · **Major gifts to thank** (Worklist, red) · **Unacknowledged** · **Membership
payments** · **Matching gifts** · **Needs a donor** (Worklist) · **Failed and pending** · **Gifts,
last 7 days** · **Gifts, last 60 days** (largest first). These two, plus Needs a donor and By gift
size, are also emailed weekly by the report-digests integration.

Four columns are set automatically overnight so views and dashboards can group and chart:
**Funding Stream** (Individual Giving, Membership, Sponsorships, Grants & Contracts, Matching
Donations, Other Program Revenue, Donor Advised Funds, Event Tickets), **Gift Size**,
**Fiscal Quarter** (`FY26 Q1` is July to September 2025), and **Gift Fiscal Year**. A gift entered today shows them blank until tomorrow.

**Try it:**

1. **Log a manual gift** (a check, cash, anything Funraise didn't touch): new item, set Donor,
   Amount, Date, Status Received, Gift Type. The donor's totals update on their own within a
   minute (the [donation rollups](donation-rollups.md) script has more to try here).
2. **Acknowledgments.** A gift of $200 or more gets **Acknowledgment Tier** = Major automatically
   and shows on **Major gifts to thank** until **Thank You Sent** is checked. Check it on one;
   it drops off. Is that worklist how you'd want to work major-gift thank-yous? Salesforce had a
   separate email tier; Monday's replacement is a person working this list.
3. **Revenue by funding stream.** Compare the group footers with what you'd expect for this year.
   FY2026 Matching Donations and Grants & Contracts reconcile to Salesforce to the cent;
   Individual Giving read about $11,900 lower on the 2026-09-29 load because every "Closed Won"
   gift was excluded from revenue; the Eventbrite ticket orders that stage mostly holds now map
   to Received / Event Ticket, which has its own Event Tickets stream, so compare Individual
   Giving plus Event Tickets with that figure.
4. **Find an old gift.** Searching the table only finds the active two years. For older gifts,
   use the board's ⋯ menu → Archived items, or start from the donor's card. Is that workable, or
   too awkward to live with?
5. **Needs a donor.** These are gifts with no Donor link. Do you recognise any and can you link
   them?
6. **Matching gifts.** A matching gift lists the employee as Donor and the company under
   **Matched By**. **Acting for** and **Attribution** cover gifts made on someone else's behalf
   (soft credits). Check one you know.

**Don't report these:** Recurring Gifts and Fiscal Year Ending can be blank on a gift; the year
is derived from Date. Older gifts may show no Acknowledgment Tier until a one-time backfill runs.

## Recurring Gifts

[Recurring Gifts (sandbox v4)](https://bikesiliconvalley.monday.com/boards/18437342630), 1,176
items, one per recurring plan or multi-year pledge. Replaces Salesforce's Subscription object.

**Tabs:** **Active** (opens here; sorted by Next Payment; Failed rows red) · **Failed** ·
**Pledges** (the older multi-year pledges with Pledge Amount and Received Amount).

**Try it:** open a monthly donor's plan. **Annualized Value** (Installment × Frequency) is the
number for stewardship tiers, not Installment Amount; the two get confused today. Is the
distinction clear on the board? Since 2026-09-30 this board mirrors every Funraise plan,
including 568 redacted historical ones; see [Funraise sync](funraise-sync.md).

**Don't report these:** Frequency and Status may still show Monday's stock labels (Working on
it, Done, Stuck) alongside the real ones; they're stripped before cutover.

## Annual Giving Summary

[Annual Giving Summary (sandbox v4)](https://bikesiliconvalley.monday.com/boards/18437530607),
18 items: one per closed fiscal year, FY2005 and FY2009 through FY2025, with Total Received, Gift
Count, and a By Gift Type breakdown. Exists because dashboards and searches can't see archived
gifts, so year-over-year comparisons read from here. Written automatically each July; hand edits
get overwritten.

**Try it:** check FY2024 and FY2025 against the numbers you reported to the board. A Chart view
(Total Received by year) is still to be added by hand.

## Campaigns

[Campaigns (sandbox v4)](https://bikesiliconvalley.monday.com/boards/18437342623), 2,425 items:
the Salesforce Campaigns, kept so every migrated gift's Campaign link still resolves. Reference
only; you won't work here day to day. Going forward, tagging a person to an outreach effort is the
**Campaign** tag column on People.

**Tabs:** **All Campaigns** (opens here) · **Appeals** · **Active**.

## Events and Event Registrations

[Events (sandbox v4)](https://bikesiliconvalley.monday.com/boards/18437342639), 247 items, and
[Event Registrations (sandbox v4)](https://bikesiliconvalley.monday.com/boards/18437342649),
6,913 items: the historical Eventbrite and Funraise events and who attended, migrated from
Salesforce. New Eventbrite registrations and check-ins now arrive here through the eventbrite-sync
integration (see [eventbrite-sync.md](eventbrite-sync.md)).

**Events tabs:** **Upcoming** (opens here) · **All events**. Calendar (by Date) and Kanban (by
Program) views are still to be added by hand.
**Registrations tabs:** **By event** (opens here; grouped by Event) · **Class roster** (who is
registered right now for each upcoming class; needs the Eventbrite attendee feed) · **Volunteers** ·
**Attended** · **Unlinked attendees** (Worklist: registrations with no People match) · **Needs
review**.

**Try it:** open a 2025 event on **By event**. Are the attendees you remember there, with Role
(Participant or Volunteer), Attendance, and Ticket Amount? Look at **Unlinked attendees**: can
you match a few to People?

## Volunteers

[Volunteers (sandbox v4)](https://bikesiliconvalley.monday.com/boards/18437342662), 3,936 items:
logged volunteer hours (Job, Hours, Date, Status, the Volunteer link), including the 2014 to 2020
records from the old separate system, marked **Historical**.

**Tabs:** in production, **Completed by event** (opens here; one section per event, newest first;
called Completed hours until 2026-11-24). This sandbox board still has **Completed hours** (grey, newest
first). In production the 2014 to 2020 records and their hours are in the **Table** views.

**Try it:** find a long-time volunteer and check their hours look complete. Eventbrite volunteer sign-ups
now arrive here through the eventbrite-sync integration.

## Activities

[Activities (sandbox v4)](https://bikesiliconvalley.monday.com/boards/18437342671), 9,000
items: the migrated last two years of calls, meetings, and logged emails. That board is full, so
new activities go on
[Activities (Logged) (sandbox v4)](https://bikesiliconvalley.monday.com/boards/18438393347). A searchable "who did we talk
to, and about what" log, replacing free-text Salesforce notes.

**Tabs:** **My activities** (opens here; Worklist) · **Recent touches** (grouped by Activity
Type) · **Open** · **All** · **By person**.

**Try it:**

1. Log a call: new item on Activities (Logged), set Activity Type, Date, yourself under **Assigned To**, link the
   **Person**, and add a **Topic** tag for what it was about (free tags, your vocabulary).
2. Open that person's card: the activity should be listed there.
3. Only significant touches belong here (calls, meetings, major-gift emails), not every email.
   Does **My activities** give you a usable to-do list?

**Don't report these:** Topic is a free tag, not a structured link to a campaign; a formal "who's
been engaged with which ask" report is later work. **Owner** is the migrated Salesforce owner
name as text; **Assigned To** is the live Monday people column.

## Dashboards (not created yet)

Three dashboards are designed and their build code is ready, but creating a dashboard needs a
Monday user with dashboard rights, so there is nothing to open yet:

- **Development weekly pulse**: revenue, gift count, average gift this fiscal year; revenue by
  month this year against last; revenue by gift size; major gifts thanked against not.
- **Membership**: members by status; memberships ending by month; members by tier.
- **Board Report quarterly**: revenue this year by funding stream; by fiscal quarter stacked by
  stream; multi-year totals from Annual Giving Summary; this year against the same point last
  year; sponsorships committed. A Quarterly Board Report doc template will embed it beside
  narrative sections.

Please don't build your own in the meantime. If a number you report today isn't in that list,
say so on IT Requests as a Feature Request. Known omissions: no Grants & Contracts widget until
cutover (that board is in production, not the sandbox); members by city and membership type are board
views, not charts, because Monday can't chart text columns.

## Donor portal boards

[Donor Portal Change Requests](https://bikesiliconvalley.monday.com/boards/18439574429) and
[Donor Portal Letter Settings (sandbox)](https://bikesiliconvalley.monday.com/boards/18439574433)
are written and read by the donor portal. They're covered in the [donor portal](member-portal.md)
script.

---

# Boards in the live SVBC workspace

These live in the original
[SVBC workspace](https://bikesiliconvalley.monday.com/workspaces/10001795), aren't Salesforce
data, and carry over unchanged at cutover. They were part of the earlier UAT round; check them
again only if your work touches them.

## Events, Event Participation, and Volunteers

[Volunteer registration management](https://bikesiliconvalley.monday.com/boards/8846285372) for
"I want to volunteer" sign-ups, and
[Event Participation](https://bikesiliconvalley.monday.com/boards/8845611139) for per-event
registration and attendance.

**Try it:** submit the public "Volunteer with us!" form linked from the registration board and
confirm the item lands with no staff entry. On an Event Participation item, set **Attendance**
(Attended, Registered, No Show) and the Participant / Volunteer dropdown by hand; Eventbrite
check-ins themselves now go to Event Registrations through the eventbrite-sync integration.

## Grants & Contracts

> **Changed 2026-11-03:** the board staff run is
> [Grants & Contracts](https://bikesiliconvalley.monday.com/boards/7896177072), the former Grants
> Pipeline, now on monday CRM in Donors & Contacts with a Category column and a view per category
> (Bike Parking is one category). The demo pair below is for trying things out and is archived at
> cutover.

[Grants Pipeline (demo)](https://bikesiliconvalley.monday.com/boards/8846256606) and
[Grant Providers](https://bikesiliconvalley.monday.com/boards/8846256609): already in daily use,
the most mature area here. Bike parking contracts are meant to live on this same board as a
category rather than on a board of their own; say if that model is wrong for how you think about
bike parking work.

**Try it:** log a prospective grant (Status New, Owner, Due Date, Grant Amount, link a Provider),
walk it New → Working on it → Submitted → Awarded, and add a delivery-task subitem to an Awarded
item.

**Don't report these:** no Type (Renewal, New, One-off, Bike Parking) or Probability field yet;
Awarded doesn't spin up a delivery project automatically.

### Bike Parking: book an event and get the invoice reminder ([GL#120](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/120))

Built on [Grants & Contracts (sandbox v4)](https://bikesiliconvalley.monday.com/boards/18439568066)
only; production waits on the Opportunities merge and the stage vocabulary sign-off.

**Try it (Bike Parking manager):**

1. Open the organizer on Organizations (e.g. City of Sunnyvale) and check it carries the primary
   contact.
2. On Grants & Contracts, add an item named for the engagement ("Bike Parking at Sunnyvale Earth
   Day Festival"). Set Type = Bike Parking, Contract Status = Requested, **Event Date**, Hours and
   Hourly Rate (Bike Parking Total fills in), and link the organizer in **Funder**. Link the
   request in BP Request and the event in Linked event if they exist.
3. Open the organizer again: the new item shows in its **Opportunities (Grants)** column.
4. Walk Contract Status Requested → Quoted → Contract Sent → Signed.

**What happens next:** at 9:00 the day after the Event Date, if Type is Bike Parking and Contract
Status is Signed or Event Done, Monday adds a subitem **"Send invoice: \<item name\>"** under the
item, assigned to the bookkeeper. Once the invoice goes out, the bookkeeper marks the subitem Done
and sets Contract Status to **Invoiced**. A Quoted, Requested or Cancelled item gets no reminder.

**Known limits:** the reminder only fires when Event Date is filled in on the item itself (a date
only on the linked Event or BP Request doesn't count), and it doesn't fire for an Event Date set
in the past. The subitem has no Deadline yet. In the sandbox it is assigned to David, not Deanna,
so tests don't notify her.

## Sponsorships

The sandbox prototype once linked here was dropped and its workspace deleted 2026-10-15.
Sponsorships are tracked on the live
[Sponsorships](https://bikesiliconvalley.monday.com/boards/18391037433) board, the former BTWD
Pipeline with the Advocacy Summit, Fundraising Ride, Misc. and Annual Gala pipelines merged in on
2026-11-03, on monday CRM in Donors & Contacts: one group per event and year, Category, Event and
Year on each item, and a Current cycle view. Historical sponsorship revenue (3,613 Salesforce
Sponsorship Opportunities) is on Donations under Funding Stream = Sponsorships.

Separately, if you're involved in fulfilling sponsor benefits (t-shirts, event tables, website
logos), we still need to know what current sponsors are actually owed; the tier-to-benefit matrix
migrated from Salesforce is the pre-2018 structure.

## LCI Squad Management (prototype)

A [prototype board](https://bikesiliconvalley.monday.com/boards/18432114887) mirroring Event
Participation's shape (Instructor, Date, Location, Event, Status), replacing the Google Sheet
instructors use for shift sign-ups. Paychex is untouched either way. Not promoted yet; take a look.

## Communications: Social Media, Website & Blog, Email

[Social Media](https://bikesiliconvalley.monday.com/boards/8846927068) ·
[Website & Blog](https://bikesiliconvalley.monday.com/boards/8846647961) ·
[Email](https://bikesiliconvalley.monday.com/boards/8847255699). All three hold only a Name and a
Files column; empty scaffolds. Nothing to test, but if you have opinions on what they should
track, now is the time.

## Board Elections

No separate board. The eligible-voter list is People → **Active members**, exported each November
and formatted for Election Runner by a script in the migration repo. The next election is after
cutover, so the only check now is step 4 under People above.

---

*Engineers: the views, colouring, and tags are applied by `salesforce-import configure`
(`salesforce-import/src/configure/spec.ts`); the UI-only remainder and the dashboards blocker are
in the migration repo's `docs/22` §5. Update this script when the spec changes.*
