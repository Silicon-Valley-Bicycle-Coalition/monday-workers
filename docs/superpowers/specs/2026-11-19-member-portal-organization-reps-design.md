# Member portal: organization reps see their organization's giving and tax letters

Date: 2026-11-19. Worker: `member-portal`. Status: design.

Third piece of the member portal rework, after sign-in (PR #17) and the card-first home page
(PR #19). Builds on both.

## Why

Organizations give to SVBC: companies, foundations, and businesses whose gifts are credited to the
organization (Donor = the Organizations item; the person who drove it is reachable through Acting
for). The portal shows none of it, and the year-end letter job writes letters only for people.
The person who handles an organization's giving needs two things, once a year or when asked: **what
the organization has given, and its year-end tax letter.** Often the same person also writes the
company's community or CSR report, so the year-end document has to cover the whole relationship
(sponsorships, contracts, grants, employee matching), not only the tax-deductible part (the user,
2026-11-19).

Sponsorship benefits, bike shop discount listings, bike parking hosting and classes are other
reasons an organization's person might visit; they are not this piece.

## Goals

1. A rep signs in as themselves and, besides their own page, reaches each organization they handle.
2. For each organization: its full giving history, labelled by type, and a **year-end statement**
   per year with everything a rep needs for a community-outreach report, including the tax
   acknowledgment for the deductible part.
3. In January, every rep of an organization with a statement gets the statement-ready email.

## Non-goals

* Sponsor, bike-parking, classes or discount-partner self-service.
* Organizations signing in with a shared organization address (e.g. giving@acme.com). Reps are
  people.
* The contact-roles design (`2026-11-11-organization-contact-roles-design.md`, draft). Portal access
  is its own checkbox; if roles are built later, a "Giving" role could replace it.
* Changing what counts as deductible. The statement's tax acknowledgment uses the existing letter
  rules unchanged; everything else on the statement is reported, not acknowledged.
* Showing employee names on an organization's page.
* Employees' own gifts that weren't matched. They're personal, and the employer has no claim to
  them.
* Impact numbers written for the organization (riders reached, miles of bikeway). The statement
  reports what SVBC records; it isn't a custom impact report.

## Anti-goals

* Anyone at a company seeing that company's giving just because they work there. Access is granted
  by staff, per person.
* A rep keeping access to an organization page after staff remove it.
* An organization id ever treated as a person id (a person page rendering an organization, or the
  reverse).
* A deductible total that counts sponsorships, grants, contracts, event tickets or employer
  matching. They appear on the statement, never in the acknowledged amount.
* A statement that reads as if the whole total were a tax-deductible gift.

## Decisions (the user's, as made 2026-11-19)

* **Access:** a staff-ticked **Portal access** checkbox on the person's **Affiliation**, effective only
  while that Affiliation's Status is **Current**.
* **History shows everything, labelled by type.** Every gift where the organization is the Donor,
  with its Gift Type (Donation, Sponsorship, Grants, Contracts, Event Ticket, In Kind…). The letters
  part explains that sponsorships, grants, contracts and matching aren't tax-deductible gifts and so
  aren't on the letter.
* **January email to every rep** with Portal access on a Current Affiliation, at their own address,
  linking to the organization's statement.
* **The year-end statement covers everything**: employee matching, contracts, sponsorships, grants
  and the rest, i.e. what the rep needs to write a report on their team's community outreach.
* **Employee volunteering on the statement, aggregate only:** number of people and total hours,
  hidden below 3 people.

## Approaches considered

* **A + live check — chosen.** At sign-in, read each signed-in person's Affiliations once and store
  the organizations (Current + Portal access) in the session as their own list, separate from the
  people. Every organization page re-checks that one Affiliation live before rendering anything. The
  home page's list may lag access changes by up to the session lifetime (24 h); an organization page
  never does.
* B — check live everywhere, store nothing. Rejected: an extra Monday read on every home page view;
  the organization page's live check already gives the guarantee that matters.
* Mixing organization ids into the session's person list. Rejected: every person route would have to
  tell the two apart, and one miss shows an organization as a person.

## Design

### Monday

* Affiliations board: new **Portal access** checkbox (staff edit it; not marked 🔒, since staff own
  it). Production and sandbox column ids go in config, gated with the placeholder pattern; with the
  placeholder, the whole feature is off.
* Existing reads reused: `getPersonAffiliations` (through People's Affiliations link) gives Status,
  Organization and, once configured, Portal access.

### Session

* New nullable column `sessions.org_item_ids` (JSON list), migration 0009, applied to both D1s
  before merge (same rule as 0007/0008).
* Sign-in (link or code): after the person ids are known, read their Affiliations; store the
  Organizations items whose Affiliation is Current with Portal access ticked, de-duplicated. A
  failed Affiliations read stores an empty list and logs; it never blocks the person's own sign-in.
* `SessionInfo` gains `orgItemIds: string[]` (empty for old sessions).

### Whose organizations a session gets

Organizations come only from the person whose **Personal Email** matched the sign-in. Signing in with
a shared Household Email doesn't carry a partner's organizations: access is granted per person, by
staff. (Builder-check call.)

### Live check

`hasOrgAccess(personItemIds, orgItemId)`: re-reads the session people's Affiliations and returns
true only if one is Current, has Portal access, and links that organization. Every organization
route calls it first; false, or a failed read, renders a not-found page (no hint the organization
exists). The id in the URL must also be in the session's `orgItemIds`.

### Home page

Below the person's own content, when `orgItemIds` is non-empty: a **"You also manage"** section, one
row per organization (name; "Your 2026 letter is ready" between Jan 1 and `home.taxLetterUntil` when
one exists) linking to its page. No gold button: the person's own state keeps the page's one gold
action. Names come from one Organizations read; a failed read shows the section without names
("An organization you manage") rather than hiding access.

### Organization page — `/:locale/portal/org/:orgItemId`

Door layout ("‹ Home", organization name as title), two parts:

1. **Giving.** Every Donations item whose Donor is the organization, newest first: date, amount,
   Gift Type label, description; a total per calendar year. **Employer matches**, i.e. gifts whose
   Matched By is the organization, appear in the same list labelled "Employee match" with date and
   amount, never the employee's name. The donation-history date gate applies as for people.
2. **Year-end statements.** One per calendar year with any activity, newest first, each opening a
   printable statement page (below).

Statement URLs live under the organization path (`…/org/:orgItemId/statement/:year`); the person
letter routes are untouched.

### Year-end statement

One printable page per organization and year, on SVBC letterhead like the person letter, addressed
to the organization (its name and address). Sections, each shown only when it has something:

1. **Summary.** Total support in the year, then one line per kind: donations, sponsorships, grants,
   contracts, in-kind, event tickets, employee matching. Counts and totals.
2. **Gifts and payments.** Every item from the Giving list for that year, grouped by Gift Type, with
   date, amount and description, and a subtotal per group.
3. **Employee matching.** Matches the organization paid in the year: count and total, one row per
   match (date, amount), no employee names.
4. **Employee volunteering** (the user, 2026-11-19: aggregate only): people with a Current
   Affiliation to the organization who completed volunteer shifts in the year, as an aggregate only:
   number of people and total hours. Hidden below 3 people.
5. **Tax acknowledgment.** The existing letter rules applied to the organization's gifts: the
   deductible gifts and their total, SVBC's legal name and EIN, and "No goods or services were
   provided in exchange for these contributions." A line says the other sections are listed for the
   organization's records and aren't acknowledged as deductible gifts. Shown only while the
   organization acknowledgment switch is on (config, off until the accountant signs off the
   wording); until then the statement says the acknowledgment will follow. A year with no
   deductible gifts has no acknowledgment section.

Signed like the person letter (signature name and title from `taxLetter`).

### January email

The letter cron gets an organization pass after the people pass:

* Find organizations with any statement activity in the year (same sweep, Donor or Matched By on the
  Organizations board).
* For each, find people with a Current Affiliation with Portal access to it, and queue one
  statement-ready email per rep, at the rep's Personal Email, linking (through sign-in, `next=`) to the
  organization's statement. Locale: the rep's Preferred Language. The copy is built-in i18n
  ("Acme Corp's 2026 year-end statement is ready"), not the Letter Settings templates, which are
  written to a donor about their own letter; no board change.
* Dedupe per (organization, rep, year), alongside the existing `letter_sends` dedupe, so a rerun or a
  rep added later is handled once.
* Respects the existing write switch, auto-send setting, start date and daily cap.

### Privacy

* A rep sees only organizations they were granted, re-checked live on every organization page.
* An organization page shows no person's address, phone or name except the organization's own
  details; employer matches carry no employee name.
* Employee volunteering is an aggregate with a floor of 3 people, so no single
  employee's volunteering can be read off it.
* Nothing about an organization appears on a person's own doors.

## Open questions

1. **Work Email for reps.** Corporate contacts are often on file only with a work address on their
   Affiliation. Proposed: accept the Work Email of a Current Affiliation with Portal access, for
   sign-in and the January email; signing in that way opens only that organization, never the
   person's own pages. Alternative: Personal Email only, and the January job reports unreachable
   reps to staff.

## Left to the builder

Config key names; the Organizations columns for name and address on the letter; how the cron's
sweep tells People donors from Organization donors (board of the linked item); the dedupe table
shape (new migration or a column on `letter_sends`); i18n keys and copy within the meaning above
(all ten locales); tests (access granted/revoked/Former/Draft, live-check failure, an org id not in
the session, an org id used on a person route, the acknowledgment excludes the excluded types while
the statement lists them, the acknowledgment switch off, employer match without names, the
volunteering floor, January pass with two reps and a rerun); "Employee match" rows are hidden until
`donationMatchedBy` is configured and never counted in the deductible total; staff runbook line for ticking Portal access,
UAT script, README.
