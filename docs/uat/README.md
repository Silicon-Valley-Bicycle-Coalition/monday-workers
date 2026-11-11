# Staff UAT: the Monday.com boards and the integrations behind them

**Last refreshed 2026-11-02** against the Workers deployed to the sandbox. Each script below says
when it was last checked.

**The sandbox is one set of boards:** the `(sandbox v4)` boards in
[CRM Sandbox v4](https://bikesiliconvalley.monday.com/workspaces/18210301). Every integration
below runs against it (the earlier v3 workspace is retired). Each script links the boards it uses.

This folder holds the User Acceptance Testing scripts for the parts of SVBC's new CRM that stay
around after the migration: the Monday.com boards you will work in every day, and the integrations
(Cloudflare Workers, one per subdirectory of this repo) that feed them. Whether the *data* came
across from Salesforce correctly is a separate question with its own guide in the private
migration repo (`monday-migration/docs/16-staff-uat-guide.md`); that guide covers the one-time
sample review, and this folder covers everything that keeps running.

## What UAT is, and why we're asking you

UAT stands for **User Acceptance Testing**: before SVBC commits to Monday.com for good, the people
who do this work every day try it out and say what is wrong, missing, or worse than today. It is
not a demo and not a training session. It is you doing, or pretending to do, your actual job in
the new system so that problems surface while they are still cheap to fix.

You do not need technical knowledge. If you can click around a Monday.com board you can do UAT.

## Nothing here can break anything real

Everything you will test lives in the two sandbox workspaces above, plus a handful of `(sandbox)` boards and a test web address for the donor portal. Three things to
know:

1. **It is real data, but a disposable copy.** The boards hold real donor and member records
   pulled from Salesforce once, as a snapshot. Nothing you edit here changes Salesforce, and the
   whole workspace is rebuilt from scratch at cutover. Rename, edit, or delete freely.
2. **The integrations are live against this copy, not against the real world.** Some things
   *do* update on their own here: a donor's giving totals recompute when you add a gift, a
   Funraise donation should appear on the Donations board, a status change can send an email.
   That is the point of these scripts. But every outbound path is locked to a test destination:
   every email lands in the shared inbox **`sandbox@bikesiliconvalley.org`** no matter whose
   address is on the record, Mailchimp changes only touch an audience named **SVBC Sandbox**,
   and nothing writes to QuickBooks or to a real Google Drive folder. You cannot accidentally
   contact a real donor from here.
3. **The migration data itself is checked separately.** If a number or a name looks wrong
   compared with Salesforce, that is worth reporting, but the migration guide's sample review is
   the formal check for it. These scripts ask "does the board and the automation work the way I
   need," not "did every record come across."

## Quick Monday.com vocabulary

- A **workspace** is a folder of related **boards**. A **board** is a list of records of one kind.
- Each row on a board is an **item** (a person, a gift, a grant); each **column** is one piece of
  information about it. **Subitems** are smaller rows nested under an item.
- The tabs across the top of a board are **views**. Each view is a saved way of looking at the
  same items: filtered, grouped, sorted, with only some columns showing. Every board here opens
  on a named working view, and the tab called **All columns** (or **Main Table**, until it is
  renamed) shows everything unfiltered. View tabs carry a small tag: **Worklist** means "things to
  act on", **Report** means "numbers to read", **Reference** means "look-up only".
- Clicking an item's name opens its **item card**: every column, plus **Updates** (a comment
  thread on that item) and links to related items on other boards.
- A **dashboard** is a page of charts and numbers drawn from one or more boards. A **doc** is a
  Monday-hosted document that can embed live board data.

## The scripts

Work through the ones for the areas you touch. Each script says what the thing does in plain
language, what to try, what you should see and how long it takes, and which known gaps not to
report again.

| Script | What it covers | Status (2026-11-02) |
|---|---|---|
| [Monday boards](monday-boards.md) | Every board in the CRM Sandbox: the views, item cards, and what to try on each. Also the live SVBC-workspace boards (Grants, Events, Sponsorships, Communications) that carry over unchanged. | **Testable now** (v3 boards; giving totals only update on v4) |
| [Donation rollups](donation-rollups.md) | Giving totals, Donor Level, membership dates, and the chart columns that update on their own when gifts change | **Testable now** on the **v4** boards (moved 2026-10-28) |
| [Donor portal](member-portal.md) | Donors log in with their email to see giving history, membership, discounts, and tax letters | **Testable now** (test site, v3 boards) |
| [Mailchimp sync](mailchimp-sync.md) | Keeps each donor's Mailchimp contact matched to their Monday record | **Testable now** (test audience, v3 boards) |
| [Bike Parking feedback email](bp-feedback-notify.md) | Emails an event organizer the feedback form when staff mark the event ready | **Testable now** |
| [Funraise sync](funraise-sync.md) | Funraise donations and recurring plans flow onto the boards automatically | **Testable until production takes the feed.** Funraise has one webhook; once it points at production, real gifts stop arriving in the sandbox |
| [Benevity import](benevity-import.md) | Drop a Benevity report on a board and the gifts and matches create themselves | **Testable now** (Retry added 2026-10-19; production live 2026-11-02) |
| [Report emails](report-digests.md) | Five scheduled emails replacing the Salesforce report subscriptions | **Views testable now; emails blocked**: sandbox sends bounce at the shared inbox |
| [Eventbrite ticket orders](eventbrite-sync.md) | Paid Eventbrite ticket orders land on the Donations board as gifts | Nothing to test yet: sandbox deployed 2026-10-26, but it can't write a gift until its order column is set up |
| [People board housekeeping](people-reclassification.md) | Moves people between People and People (Historical) on a rolling seven-year activity window, so People holds only the last seven years of activity | Nothing to test yet (built, not deployed; will run on v4) |
| [QuickBooks sync](quickbooks-sync.md) | Two-way sync of customers, invoices, and products | Postponed indefinitely (2026-10-28) — nothing to test |
| [Monday backup](monday-backup.md) | Nightly copy of every board to Google Drive | Nothing to test yet |
| [Member map](member-map.md) | A staff-only map of where SVBC members live, shaded to show the neighborhoods where membership is thin | Nothing to test yet (built 2026-11-02, not deployed) |
| [Public calendars](svbc-calendars.md) | The events widget and committee calendar feeds on bikesiliconvalley.org | Live in production; a five-minute smoke check |

## How to give feedback

Report anything wrong, missing, or worse than today's process on the
**[IT Requests board](https://bikesiliconvalley.monday.com/boards/8846215481)**:

1. Create a new item with a specific name ("Members view doesn't show Member Until").
2. Set the **Type** column: **Bug Report** for anything broken or wrong, **Feature Request** for a
   suggestion, **IT Support** for anything else (a question, an access problem, general feedback).
3. Say which board or script, which item, what you expected, and what happened. A screenshot
   helps. For anything involving an email, note the time so it can be found in the logs.

Report things as you find them rather than saving up a list. Check the script's "Don't report
these" section first, since those are already known. If you are not sure whether something is a
real problem, report it anyway.

## What "done" looks like

For each script that applies to your work: read it, do the Try-it steps, and ask yourself whether
this matches how you would actually do the task and whether anything you rely on today is
missing. When you are satisfied an area works, or you have reported everything that doesn't, that
area is signed off. There is no fixed deadline; the sooner issues surface, the sooner they get
fixed.

## Known gaps across the whole sandbox

These apply everywhere and are already on the list:

- **The shared sandbox inbox may be rejecting mail.** On 2026-10-26 every report email sent to
  `sandbox@bikesiliconvalley.org` bounced. Until that's fixed, a test that expects an email there
  (donor portal login links, Bike Parking feedback, report emails) may show nothing. Say so on
  IT Requests rather than retrying.

- **The three dashboards are not created yet** (Development weekly pulse, Membership, Board
  Report quarterly). The code that builds them is ready but needs a Monday user with dashboard
  rights. Please don't build your own in the meantime; say on IT Requests if a number you need is
  missing from the plan in the boards script.
- **Row colouring is unconfirmed.** Several views are set to shade rows (red for a major gift not
  yet thanked, amber for a membership ending within 60 days, red for lapsed). The setting was
  applied through the API, which can't read it back, so the first person to open those views is
  the visual check. Say whether you see the shading.
- **Tab order and item-card layouts are still to do by hand.** Some boards may still open on
  Main Table rather than their working view, and item cards show every column in one flat list
  rather than grouped sections.
- **Email Consent reads "Not in Mailchimp" for everyone.** The load ran without the Mailchimp
  consent file. That column is empty, not wrong.
- **Nobody moves between People and People (Historical) yet.** The split was computed once at
  import. If you find someone on the wrong board, report it rather than moving them by hand.

## For staff without repo access

These scripts are distributed to staff as Google Docs, one per script, in the Drive folder
[Monday CRM UAT scripts (boards and integrations)](https://drive.google.com/drive/folders/1aIiQxJCUOjJhBhka3dxiMdX4qAEPUbeN),
inside "SVBC Process Documentation (migrated from Box)" next to the migration guide's copy. Each
Drive copy says which commit it was synced from. If a Drive copy disagrees with a board you are
looking at, the repo copy is newer; ask whoever shared it to re-sync rather than editing the
Drive copy.

---

*For engineers: each Worker's `README.md` is its spec and its deploy and verification record.
These scripts describe only what a staff tester can see and do. Keep them in step: when a
Worker's sandbox behaviour changes, update its script and the status table above in the same
merge request.*
