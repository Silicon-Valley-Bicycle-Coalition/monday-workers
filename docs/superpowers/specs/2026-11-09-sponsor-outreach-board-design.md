# Sponsor Outreach board — Design

**Date:** 2026-11-09
**Status:** Proposed. Not built.
**For:** Martha Corral (corporate sponsorships). Decided with David W. Keith; Martha hasn't seen it yet.
**Builds on:** `2026-11-03-class-emails-from-monday-design.md` (the event send page) and
`2026-11-02-sponsorship-audit-history-design.md` (sponsorship history on Organizations).

## Why

Once a year Martha emails corporate sponsors and prospects from her own Gmail, a different email
per segment: lapsed BTWD sponsors, prospects, wellness-focused companies, dinner-focused ones,
Energizer Station hosts. The wording changes every year, and so do the segments.

Today she starts from the Salesforce report **"2022- 2026 Corporate Sponsors"** (Sponsorship
record type, Pledged or Posted, Sponsorship Cycle 2022–2026 BTWD / Regional BTWD / Advocacy
Summit) plus a wider 2011–2026 export. She pastes these into a Google Sheet ("2027 Sponsor List"),
with one tab per segment, built by hand, then mail-merges each tab. Three problems:

* **Five years isn't enough.** Her note: "I have to fix lapsed and prospecting. We need to go 15
  years back vs 5 of data." Her Lapsed tab holds about 30 rows, all from 2022.
* **Names drift from emails.** Contacts are typed per row. Her Prospects tab is headed "red
  highlights mean the name doesn't match email address."
* **No opt-outs are applied.** The report has no opt-out column. In Salesforce, 2 sponsor
  primary contacts are Email Opt Out and 20 are Fundraise Opt Out. Nothing removed them.

Salesforce is retired, but everything the Sheet held is now in Monday. The Donations board holds
every sponsorship back to 2011 with its Sponsorship Cycle. The Organizations board holds the
companies, including all her prospects. The Affiliations board holds who works where, with a work
email and that email's Mailchimp consent.

## Goals

* Martha builds each year's segments on a Monday board and starts each segment's email from it.
* Lapsed and current are computed from 15 years of sponsorship history, not typed.
* Every recipient is a linked record, so a name always matches its email, and a contact who
  changes jobs is fixed once.
* Do Not Solicit and Mailchimp unsubscribes are excluded automatically.
* Each email is personalized with the company's own sponsorship and giving history.
* A company that says yes becomes a pipeline opportunity in one click.

## Non-goals

* Writing the email on the page. Wording stays a Gmail draft, as with the event send page, because
  it's rewritten every year.
* An Unsubscribe link. Decided 2026-11-09: these are relationship emails to a company's named
  giving contacts, sent one by one from Martha's Gmail. Opted-out contacts are excluded instead.
* Changing Martha's **Sponsorships** pipeline board (`18391037433`) beyond the Organization link
  column (One-time setup) and receiving opportunities from the button. Linking its text Primary
  Contact / Email columns to People is separate work.
* Individual-donor appeals. This is corporate sponsorship only.
* Scheduling or sequences. A person starts every send.

## Anti-goals (failure even if it technically works)

* An email to anyone marked Do Not Solicit (the person or the company) or Unsubscribed/Cleaned.
* The same email to the same person twice for one segment.
* A company silently missing from a segment because it has no contact. Show it, don't drop it.
* 300 cold prospects appearing as pipeline opportunities and skewing Sponsorships board totals.
* Personal data at rest in D1, or email addresses in logs.

## Definitions

**Campaign year (Y):** the year the outreach is for, set per group (e.g. 2027).
**Last year:** Y − 1, the most recent event year. It's the event year from Sponsorship Cycle
("2026 BTWD"), not the fiscal year.
**Window:** Y − 1 − *Years Back* through Y − 1. *Years Back* defaults to 15.

**A sponsorship** is a Donations-board row whose Gift Type is a sponsorship type (the same
`giftTypes` / `inKindGiftTypes` lists as `donation-rollups`' `sponsorships` block), linked to an
Organization, with a usable event and year. The event and year come from Sponsorship Cycle. A
committed item on the Sponsorships board also counts as a sponsorship once that board links to
Organizations (see One-time setup). One company, event and year counts once.

| Segment kind | A company is in it when |
|---|---|
| **Current** | it has a sponsorship in Y − 1 for one of the segment's events |
| **Lapsed** | it has a sponsorship in the window for one of the segment's events, but none in Y − 1 for any event |
| **Prospect** | it's marked **Sponsor Prospect** and has no sponsorship in the window |
| **Hand-picked** | Martha links the companies herself (Wellness, Dinner Focused, Energizer hosts…) |

**Already in play for Y** *(builder check; my call):* a company with a sponsorship dated in Y, or
an item in a "Y …" group on the Sponsorships board, is left out of Lapsed and Prospect segments and
listed under Excluded as "already in the Y pipeline". Martha doesn't send "we've missed you" to a
company she's already talking to.

**Event names** *(builder check; my call):* Sponsorship Cycle text over 15 years ("2014 Dinner",
"Advocacy Summit", "Regional BTWD"…) maps to the Sponsorships board's Event labels through a table
in `config/*.json`. The setup produces every distinct cycle value in the Donations data; Martha
approves the table once. A cycle that doesn't map is listed on the segment item, never silently
dropped.

Lapsed is per company, with the dropped events shown: Google sponsored the 2025 Dinner but nothing
in 2026, so Google is lapsed. Martha splits segments by event when the email differs ("Lapsed
BTWD" = the events filter set to BTWD and Regional BTWD).

## Recipients

A recipient is an **Affiliation** (one person at one company) that is:

* **Status = Current**, and
* **Sponsor Contact** checked (new column: "this person handles nonprofit giving here"), and
* has a **Work Email**, and
* **Work Email Consent** isn't Unsubscribed or Cleaned. "Not in Mailchimp" may be sent to.

Then everyone is removed whose People item or Organization has **Do Not Solicit** checked.

**Prerequisite: Work Email Consent must be current.** Today it's a cutover snapshot:
`mailchimp-sync` keys on the People Email column only and never updates Affiliations, so an
unsubscribe since 2026-10-30 doesn't show. Decided 2026-11-09: extend `mailchimp-sync` to keep
Work Email Consent current per address (as planned in
`2026-09-08-person-org-email-model-design.md`) **before** the send page goes live. This design
then trusts the column, re-read at send time. That work has its own design and branch.

Every qualifying Sponsor Contact at a company gets their own copy, because it's often a team. A
company with none appears on the segment as **no contact**, so Martha can add one before sending.

## The board: Sponsor Outreach

A new board in the Donors & Contacts workspace. One **group per campaign year** ("2027"). **One
item per email**: "Lapsed BTWD", "Prospects", "Wellness"…

| Column | Type | Who sets it |
|---|---|---|
| Segment Kind | status: Current / Lapsed / Prospect / Hand-picked | Martha |
| Events | dropdown, values from the Sponsorships board's Event labels | Martha (blank = any event) |
| Years Back | number, default 15 | Martha |
| Campaign Year | number (or from the group) | Martha |
| Companies | connect → Organizations | 🔒 Build list for computed kinds, then Martha edits; Martha for Hand-picked |
| Recipients | connect → Affiliations | 🔒 Build list, from Companies |
| No Contact | connect → Organizations | 🔒 Build list |
| Excluded | long text: who was left out and why (DNS, Unsubscribed) | 🔒 Build list |
| Build list | button | Martha |
| Send sponsor email | link to the send page | 🔒 |
| Sent | date + update on the item with sender, draft subject, count, failures | 🔒 send page |

**Build list** computes Companies (unless Hand-picked), Recipients, No Contact and Excluded. Martha
can then remove companies or recipients by hand. A later Build list warns before it overwrites her
edits. The send re-checks consent and Do Not Solicit at send time, because they can change after
the list was built.

**Create opportunity** (button on each Recipients/Companies row, or on the item with a company
picker; builder's choice): creates an item on the Sponsorships board in the matching
"Y <Event>" group, Stage = New, Owner = the clicker, linked to the Organization. *(Builder check;
my calls:)* when the segment's Events is blank or has several values, it asks which event. It
refuses when the "Y <Event>" group doesn't exist (Martha creates groups) and when that company
already has an item in that group.

## The send page

Same pattern as the event send page: an Apps Script web app that runs as the person who clicked it,
through their own Gmail, with a Worker holding the at-most-once ledger.

1. Martha writes the segment's email as a Gmail draft, From her own address, with merge fields.
2. She clicks **Send sponsor email** on the segment's item.
3. The page shows From, subject, count, the recipients, and the excluded and no-contact companies.
4. **Send a test to me** (filled with the first recipient's values) unlocks **Send to N people**.
5. One message per recipient. The Worker records (segment item, affiliation) before each send, so a
   reload or double click can't duplicate.
6. An update on the item records the sender, subject, count and failures. Each recipient's People
   item (and the Organization) gets a timeline entry, the way the event send page logs.

**Merge fields** (per recipient; company values from Donations):

| Field | Value |
|---|---|
| `{{First Name}}` | the recipient's People first name |
| `{{Company}}` | Organization name (Recognition Name if set) |
| `{{Last Sponsorship Event}}`, `{{Last Sponsorship Year}}`, `{{Last Sponsorship Amount}}` | the company's most recent sponsorship in the window |
| `{{Events Sponsored}}` | distinct events in the window, e.g. "BTWD, Bike Summit" |
| `{{Years Sponsoring}}` | count of distinct years with a sponsorship |
| `{{Lifetime Giving}}` | the Organization's 🔒 Lifetime Giving |

Martha will think of more once she uses it, so adding a field must be a small change. A placeholder
with no value for a recipient is refused before the test, as on the event page, rather than sent
blank.

## One-time setup

* **Sponsor Prospect** (checkbox) and **Prospect Notes** (text) on Organizations, seeded from the
  Prospects tab of "2027 Sponsor List" (~270 companies) by name. Names that don't match exactly go
  on a review list for Martha, not a guess.
* **Sponsor Contact** (checkbox) on Affiliations, pre-checked for current affiliations whose person
  was:
  * the primary contact on a Salesforce sponsorship (from the extract, or the live org while it
    lasts), or
  * a contact on the Sponsorships board, or
  * a contact on any tab of the Sheet.
  Contacts with no matching Affiliation go on a review list. Martha reviews the result once.
* **Sponsorships board as a second source** (decided 2026-11-09). A Donations row entered after
  cutover has no Sponsorship Cycle unless someone typed it. So a late-2026 renewal could read as
  Lapsed.
  * Add an **Organization** link column (connect → Organizations) to the Sponsorships board
    (`18391037433`). Fill it for all ~915 items by matching the company name. Names that don't
    match go on a review list for Martha.
  * A Sponsorships item counts as a sponsorship for its **Event** and **Year** when Stage is
    Awarded, Pledged, Posted, In-kind donation or In-Kind Sponsor. That's Stage only, not the Grant
    Amount.
  * Count it alongside the Donations rows. One company, event and year counts once, whichever
    source it came from. Amounts in merge fields come from Donations when both exist.
  * The same link feeds "Already in play for Y". It's also the pipeline link the sponsorship
    history on Organizations is waiting for (`sponsorshipPipelineLinks`), but wiring that up is
    separate work.
  * Being able to link the Sponsorships board's Primary Contact / Email text to People stays a
    non-goal.
* **The 20 Fundraise Opt Out sponsor contacts** (not migrated; Mailchimp is the consent record):
  produce the list for Martha to decide whether each gets Do Not Solicit.

## Conventions this follows

Sandbox environment and `config/split.test.ts`; the `FLAGS` write switch; the shared Monday
GraphQL transport copy; a `SyncToken` service binding, not a Monday token; `bareTitle` and
`MARKED_COLUMNS` for the 🔒 columns; board and column ids in `config/*.json`. See the root
`CLAUDE.md`.

## Left to the builder

* Which Worker owns this: a new `sponsor-outreach` Worker, or `donation-rollups` (which already
  reads sponsorships). My call if asked: a new Worker. Its job is sending and segment-building, not
  rollups.
* Whether the send page is a second Apps Script project or the event page generalized. Shared code
  is copied today (`mail-merge.gs`, `class-email-page`); a third copy argues for generalizing.
* How Build list is triggered (button webhook vs a link to a page) and how it detects Martha's edits.
* Timeline entry format, matching the event send page's.

## Open questions

1. **Which sponsorships count:** Received only, or Pledged too? The Salesforce report used
   Pledged + Posted. Recommended: both, since a pledged 2026 sponsor isn't lapsed.
2. ~~Sponsorships recorded after cutover.~~ Decided 2026-11-09: see "Sponsorships board as a
   second source" under One-time setup.
3. **Martha's review.** She hasn't seen this. *(My call on order:)* build the one-time setup first
   (Sponsor Prospect, Sponsor Contact, the review lists, the event-name table, the Fundraise Opt Out
   list). Show Martha the setup and this design together, then build the board, Worker and send
   page with her changes.

## Noticed along the way (separate work)

The Organizations board has an **"Emailed items"** group, which is what Emails & Activities fills
when someone's "create a new contact for unknown addresses" setting is on. Worth checking whose
setting that is before it fills Organizations with one-off correspondents.
