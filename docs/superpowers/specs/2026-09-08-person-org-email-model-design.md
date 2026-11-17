# People, Organizations, and Email: the affiliation model

**Status:** Design, awaiting review (2026-09-08).
**Affects:** `salesforce-import` (new Affiliations board, email classification), `donation-rollups`
(per-affiliation totals), `mailchimp-sync` (per-address contacts), and a new `impact-attribution`
Worker. Also the People and Organizations boards' column set.
**Builds on:** the 2026-09-08 change making Mailchimp consent per email address (MR !43), and the
migration plan's "Personal/professional email handling" decision, which this design supersedes
in part (see Decision history).

## The ask

SVBC's ultimate relationship is with a **person**. That person may also act for an
organization — another nonprofit, a corporate sponsor, a city or agency — and may move between
organizations over time, representing a different one each time. The same person may give as an
individual too. SVBC wants to track:

1. the person, once, across every organization and every email they have ever used;
2. which email address belongs to which capacity — personal, shared household, or work at a
   specific organization — so that an incoming record can be attributed correctly; and
3. the person's **lifetime impact** on SVBC, meaning their personal giving **plus** what they
   drove through each organization while they were there, **plus** non-money impact (event
   registrations, volunteer hours, committee activity), each stamped with the organization they
   represented at the time.

## Decisions made in the brainstorm (2026-09-08)

* **Lifetime impact = personal + organizational + non-money.** Chosen over "personal giving
  only" (what the boards do today) and "personal plus organizational money only."
* **Attribution is email-first with staff override.** An incoming record's email resolves the
  person and, if it is a work address, the affiliation. Staff can correct the result on the
  record, and unresolved or ambiguous records land on a worklist. Chosen over "email only"
  (blind to invoiced sponsorships with no person attached) and "staff always picks" (never
  automatic, decays when nobody fills it in).
* **A household email can be shared by more than one person.** Two People items may carry the
  same Household Email. Chosen over "one email, one person" (forces a spouse off the record) and
  a full Household entity (NPSP-style, the most structure to build). Matching on a shared
  address therefore produces candidates, not an answer — see Resolver.
* **An unknown address with a familiar name is a proposal, not a link (added 2026-09-08,
  Eventbrite ask).** A community member who registers in Eventbrite with a new address is
  matched to People by name, the candidate is shown to staff on the worklist, and only a staff
  confirmation links the record and attaches the address to the person. Chosen over "create a
  new person for every unknown email" (what the `eb4sf` package did in Salesforce, and how
  Funraise produced ~1,000 duplicates) and "auto-link on exact name" (a shared common name would
  silently pool two people's impact).
* **Approach: one new Affiliations board; emails stay on the record they belong to.** Chosen
  over an Emails board (fully normalized, but ~9,500 items for live people alone, against the
  10,000-item ceiling that already split People, and three boards to answer "what's their work
  email") and affiliations-as-subitems (weak filtering, awkward connect columns from Donations,
  a second write path for rollups).

## Decision history

* **Superseded in part:** the plan's "Personal/professional email handling → migrate
  Affiliations *and* keep the second email as its own column" (2026-08-21). That decision
  flattened all 6,349 Affiliations onto a single People→Organizations connect column, dropping
  role, dates, and status, and kept `Secondary_Email__c` as an unlabeled second address. Both
  choices were right for getting a sandbox up; neither can answer "who did this person represent
  in 2021" or "is this address work or home." This design keeps the People→Organizations connect
  column (it's cheap and staff use it as a filter) but derives it from the Affiliations board.
* **Kept:** Mailchimp is the consent system of record, and consent is per address (2026-09-08).
  This design moves the *work* address and its consent onto the Affiliation item; personal and
  household consent stay on People.
* **Kept:** Donations link to one Donor item (person or organization), and the organization's
  own rollups keep computing across every Donation linked to it. This design adds attribution on
  top; it does not re-point organizational gifts at people.
* **Decided 2026-09-11 (Plan 2 entry):** an organization gift that is attributed to an
  affiliation has the **organization** as its Donor; the person who drove it is reachable through
  Acting for. So Lifetime Giving means personal giving, Organizational Giving means driven giving,
  and the Organizations rollups mean what the section below says, with no overlap. An org gift
  nobody has attributed yet keeps the person as Donor until staff resolve the review row, and a
  Benevity matching gift is never attributed or re-pointed (its Donor is the employee, Matched By
  the company). Implemented in `salesforce-import` (`giftDonorSfId`); `donation-rollups` reads the
  Donor link as written, so no Worker-side special case is needed.

## Data model

### People board (live and Historical) — changed

| Column | Type | Change |
|---|---|---|
| Personal Email | email | renamed from **Email**. The address SVBC uses for the person as themselves |
| Personal Email Consent | status | renamed from **Email Consent**; same vocabulary |
| Household Email | email | renamed from **Secondary Email** *for addresses classified as household* (see Migration). May repeat across People items |
| Household Email Consent | status | renamed from **Secondary Email Consent** |
| Organization | connect → Organizations | kept, now **derived**: the set of organizations with a Current affiliation. Maintained by the `impact-attribution` Worker's daily reconciliation, not by hand |
| Affiliations | connect → Affiliations | new; the mirror of Affiliations → Person |
| Other Emails | text | new; semicolon-separated aliases attached by staff confirmation on the worklist (see Resolver, "Confirm"). Resolve to this person in `email_index`; carry no consent and are not sent to Mailchimp |
| Household Primary | checkbox | new; on a shared Household Email, which person's merge fields the Mailchimp contact carries (see Consent). Defaults to the first person imported |
| Organizational Giving | numbers | new rollup: sum of gifts attributed to this person acting for any organization |
| Lifetime Impact (description) | — | the existing gift-history item description gains a per-affiliation section |

The 12 existing giving rollups keep their meaning: **personal** giving, computed across
Donations whose Donor is this person. They do not change.

### Affiliations board — new

One item per person-at-organization tenure. Name: `<Person> @ <Organization>`.

| Column | Type | Notes |
|---|---|---|
| Person | connect → People, People (Historical) | required |
| Organization | connect → Organizations | required |
| Role | text | from `npe5__Role__c`; free text today |
| Status | status | Current / Former, from `npe5__Status__c`; plus **Draft** for an affiliation the resolver proposed from a confirmed work address and staff have not yet checked (see Resolver, "Confirm"). Draft affiliations are excluded from the derived Organization column and from rollups until staff set Current |
| Start / End | date | from `npe5__StartDate__c` / `npe5__EndDate__c` (not extracted today — see Migration) |
| Primary | checkbox | from `npe5__Primary__c`; which affiliation to show first |
| Work Email | email | the address the person uses in this capacity. Unique across Affiliations |
| Work Email Consent | status | Subscribed / Unsubscribed / Cleaned / Not in Mailchimp, per address as everywhere else |
| Attributed Giving, Attributed Gift Count, Last Attributed Gift | numbers, numbers, date | rollups over Donations whose **Acting for** is this affiliation |
| Attributed Registrations, Attributed Volunteer Hours, Attributed Activities | numbers | the non-money rollups |
| Salesforce Debug | long text | provenance, as on every board |

A person with two work addresses at one organization gets two Affiliation items. A person who
left and came back gets two items with different date ranges. Both are rare and both read
correctly on the board, so no special case.

Expected size: 6,349 Affiliations from Salesforce, well under the item ceiling.

### Impact boards — one new column each

Donations, Event Registrations, Volunteers, and Activities each gain:

| Column | Type | Notes |
|---|---|---|
| Acting for | connect → Affiliations | set by the resolver; staff may change it. Blank means "as themselves" |
| Attribution | status | Auto / Staff / Needs review / None — how **Acting for** was set, so overrides survive re-resolution |
| Suggested person | connect → People | set by the resolver when an unknown email carries a name that matches existing People; the person link stays blank until staff confirm. Cleared on confirmation |
| Match reason | text | one line explaining the suggestion ("same name; different email"), so staff can judge it without opening the person |

The existing person link on each board (Donor, Attendee, Volunteer, Person) is unchanged and
remains the answer to "who." **Acting for** answers "in what capacity."

### Organizations board — unchanged

Its rollups keep computing across Donations linked to it directly. An organization's page
answers "what has this organization given"; a person's page answers "what has this person
driven, here and elsewhere." The two are allowed to overlap; that is the point.

## The resolver: `impact-attribution` Worker

*Started 2026-11-17: the Worker exists (#125, Draft affiliations from repeated matching gifts) and
its second job rebuilds `email_index` nightly and proposes employers from email domains
(`2026-11-16-employer-from-email-domain-design.md`, #124). The webhook resolver below is still to
come.*

*(2026-11-16: the Worker exists, but its only job so far is employer affiliations from repeated
matching gifts — [`2026-11-16-employer-affiliation-proposals-design.md`](2026-11-16-employer-affiliation-proposals-design.md).
The resolver below is not built.)*

Follows the repo's standard webhook-driven shape (root `README.md`'s Reliability section):
webhook → D1 idempotency row → Cloudflare Queue → consumer → retry → DLQ.

```
Donations / Event Registrations / Volunteers / Activities boards
  │  webhook on item create / change of the email or person-link column
  ▼
Worker (webhook route)
  │  challenge echo; URL-secret validation; upsert D1 `pending_attributions`
  │  keyed on (board id, item id); enqueue
  ▼
Queue consumer
  │  1. fetch the item fresh; skip and ack if Attribution = Staff (an override is
  │     never re-resolved automatically)
  │  2. take the record's email — Attendee Email, the Funraise supporter email carried
  │     by funraise-sync, the volunteer app's email, or the Activity's From/To
  │  3. look the address up in D1 `email_index` (see below):
  │       work address      → person + that affiliation → Acting for = affiliation,
  │                           Attribution = Auto; also ensure Donor/Attendee/... = person
  │       personal address  → person, Acting for blank, Attribution = None
  │       household address → one candidate → as personal
  │                           several candidates → pick the one whose name matches the
  │                           record's name (Attendee Name / supporter name); no match →
  │                           Attribution = Needs review, add to worklist
  │       unknown address   → look People up by normalized name (see Name matching):
  │                             no candidate → create the Person, Attribution = None
  │                             one or more  → person link stays BLANK, Suggested person =
  │                                            the candidate(s), Match reason set,
  │                                            Attribution = Needs review, add to worklist
  │       no email at all   → Attribution = Needs review only if the person link is also
  │                           blank; otherwise None (an invoiced sponsorship with a Donor
  │                           set by staff is complete as-is)
  │  4. after any Acting-for write, enqueue a rollup recompute for the affiliation
  ▼
Worklist: a "Needs attribution" view on each impact board, filtered on Attribution =
Needs review. Staff set Acting for (or the person link) and flip Attribution to Staff.
For Event Registrations this view, filtered to one event, is the post-event checklist.
```

**Name matching (the unknown-address branch):** normalize first and last name the way
`monday-migration/scripts/find-duplicate-contacts.mjs` does (lowercase, letters only) and look
up People on the pair; skip candidates whose name is on that script's junk list (the 86
"Eventbrite Your" contacts from `docs/10` are the canonical case). A name alone is never enough
to link — the dedup script scores it 25 of 100 — so the resolver only ever *suggests*. The
person link is left blank on purpose: a Person created optimistically and corrected later is a
duplicate to merge, and this design has no merge path for staff.

**Confirm (a Staff transition on a row that carried a suggestion):** the webhook on the
Attribution column fires the resolver a second time. When it reads Staff and the person link is
now set, it attaches the record's email to that person: Personal Email if empty, otherwise
appended to Other Emails; a non-freemail domain instead creates a Draft Affiliation with the
address as Work Email for staff to confirm the organization. It then patches `email_index`, so
the next record from the same address resolves as personal (or work) without staff. Suggested
person and Match reason are cleared. If staff cleared the suggestion and left the link blank,
the resolver creates the Person as in the no-candidate case. This is the whole "merge": an
address moves onto a person, no records combine.

**`email_index` (D1):** address → { kind, person item ids, affiliation item id }. Rebuilt by a
daily cron from the People (both boards) and Affiliations boards, and patched incrementally by
webhooks on those boards' email columns. The cron is the self-healing path; the webhooks keep it
current between runs. Same shape as `mailchimp-sync`'s campaign-catalog reconciliation.

**Why not resolve by date instead of email?** A work address already identifies the
organization. Date-based resolution ("which affiliation was active when the gift landed") would
be needed only when a personal address is used for organizational business, which is exactly the
case staff override exists for. Dates stay on the Affiliation for reading, not for matching.

## Rollups

`donation-rollups` gains a second owner kind. Today it resolves a Donation's owner (person or
organization) and recomputes that owner's twelve fields from a D1 reverse index. It extends to:

* index Donation → Acting-for affiliation alongside Donation → Donor;
* on any change, recompute the affiliation's three money rollups and the person's
  **Organizational Giving** (sum over that person's affiliations);
* leave the person's existing twelve personal rollups and the organization's rollups exactly as
  they are.

Non-money rollups (registrations, volunteer hours, activities) are new. They follow the same
recompute-from-scratch pattern and live in the same Worker rather than a fourth one; the reverse
index gets a `kind` column. The Activities count is over items on the Activities board only,
not email volume.

The gift-history item description on People gains a section per affiliation ("As SVBC's contact
at Apple, 2019–2023: 4 gifts, $12,000") between the personal history and the archived-gift
section.

## Consent and `mailchimp-sync`

Mailchimp is per address, and after this design so is Monday. `mailchimp-sync` changes from
"one Donor item → one Mailchimp contact on the primary Email" to:

* **outbound:** each of a person's addresses (Personal, Household, every Work) is its own
  Mailchimp contact. Personal and household contacts carry the person's merge fields as today.
  A work contact carries the same person merge fields plus `ORG` (organization name) and
  `ROLE`, so staff can segment "current contacts at municipal organizations" in Mailchimp
  directly. A household address shared by two people is one Mailchimp contact; its merge fields
  come from whichever person is flagged Primary on the household (a new checkbox on People,
  defaulting to the first person imported), and the other person's membership state is not
  represented there. Staff accept that limit for shared addresses.
* **inbound:** a Mailchimp event resolves through the same `email_index`, so an unsubscribe on
  a work address updates that Affiliation's Work Email Consent and nothing else.
* The design doc's existing "Deliberately not in this design: a Donor's second email address"
  item closes.

## Migration (`salesforce-import`)

1. **Extract** adds `npe5__StartDate__c`, `npe5__EndDate__c`, `npe5__Primary__c`, and
   `npe5__Description__c` to the affiliations query. Verify the first two exist in the org before
   relying on them; NPSP ships them, but SVBC's page layouts may never have exposed them.
2. **Transform** emits an Affiliations-board payload per `npe5__Affiliation__c` whose Contact
   is on People or People (Historical) and whose Organization is an org Account (the same filter
   used today). The People→Organization connect column is derived from Status = Current
   affiliations plus the Contact's own org Account, as now.
3. **Email classification.** Each Contact's `Secondary_Email__c` becomes either a Work Email on
   one of that person's affiliations or the person's Household Email:
   * its domain matches the Website domain of an affiliated Organization → Work Email on that
     affiliation;
   * its domain is a consumer mail provider (gmail, yahoo, icloud, hotmail, aol, comcast, sbcglobal
     and the like — a list in config) → Household Email;
   * anything else → Household Email, plus a row in `data/review/email-classification.csv`
     with the domain and the person's affiliations, for a human pass before cutover. The same
     approved-list mechanism the geocoder uses (`data/enrich/approved.txt`) applies.
   The primary address keeps its current precedence rule and becomes Personal Email. Where the
   *primary* address's domain matches an affiliated organization and the secondary is consumer
   mail, swap them: the consumer address is Personal, the org address is Work. That swap is the
   one place this pass changes which address is "primary," and it is logged.
4. **Load** provisions the Affiliations board and the renamed columns. Renaming a column on the
   existing sandbox boards is a Monday UI step, not a create; `ensureBoards` matches by title, so
   the rename happens before the next load run and the config's title map is updated.
5. **Consent ingest** is unchanged: the Mailchimp export is keyed by address, and each of the
   three consent columns looks its own address up.

## Error handling

Webhook, D1, Queue, retry, DLQ: the standard shape, nothing new. The one design-specific rule is
that **a Staff attribution is never overwritten by the resolver**. The resolver checks the
Attribution status before writing and acks without change if it reads Staff. A staff member who
wants a record re-resolved clears Acting for and sets Attribution back to Auto.

Household ambiguity and unknown addresses are not errors; they are worklist rows. The DLQ is for
Monday and D1 failures only.

## Testing

Vitest with mocked Monday at the boundary, D1-backed via the repo's existing test setup:

* Resolver: each branch of step 3 (work, personal, household-one, household-many-with-name-match,
  household-many-no-match, unknown-no-candidate, unknown-with-candidates, no-email-with-person,
  no-email-without-person), plus "Attribution = Staff is left alone."
* Name matching: "Michael Smith" with two People candidates yields both as Suggested person and
  no link; a junk-list name yields no candidate and a new Person; a candidate on the Historical
  People board is offered the same as a live one.
* Confirm: Staff with a link set attaches the email (Personal Email empty → filled; not empty →
  Other Emails appended; work domain → Draft Affiliation) and the next resolve of that address
  is Auto; Staff with the link blank creates a Person; a second Confirm on the same row is a
  no-op.
* `email_index` rebuild: a shared household address indexes to two people; a work address
  indexes to one affiliation; a renamed column id does not break the rebuild.
* Rollups: affiliation totals recompute from scratch; a person's Organizational Giving equals the
  sum of their affiliations'; moving a Donation's Acting for from one affiliation to another
  updates both.
* Migration: email classification's three branches and the primary/secondary swap; an
  Affiliation with a Contact not on either People board is dropped with a warning, not an error.
* `mailchimp-sync`: one person with three addresses produces three upserts; an inbound
  unsubscribe on a work address touches only that Affiliation's consent column.

## Deliberately not in this design

* **A Household entity.** Shared addresses are represented by repetition, and attribution
  between two people on one address is decided by name match or by staff. If joint giving turns
  out to need its own totals, that is a later addition on top of this model, not a change to it.
* **Person-to-person relationships** (`npe4__Relationship__c`, 722 rows). Still backup-only.
* **Re-pointing organizational gifts at people.** Organizations keep their own rollups; a
  person's organizational impact is an attribution, not a transfer.
* **Date-based attribution.** See the resolver note above.
* **A donor-portal view of organizational impact.** The portal shows personal giving today;
  showing "what you drove at Apple" to a donor is a product decision for the portal's own spec.

## Prerequisites and open questions

* Confirm `npe5__StartDate__c` / `npe5__EndDate__c` are populated in the `svbc` org, not just
  present. If they are empty for most rows, Start/End import blank and Status carries the load.
* Confirm the Funraise supporter email is reachable on the Donation item. `funraise-sync` writes
  the Donor link; the resolver needs the address that produced it. If it is not stored, add a
  hidden Supporter Email column to Donations in `funraise-sync`.
* Rename the four People columns on the sandbox boards before the next load run (UI step).
* Decide the Primary-on-household default with staff, or accept "first imported."

## Sources

* `migration-plan.md` — Data Inventory ("Personal vs. professional email for the same person")
  and Decisions Needed ("Personal/professional email handling"), 2026-08-21
* `docs/05-migration-script-requirements.md` §1b (Affiliations), §1g (consent)
* `docs/06-staff-process-guide.md` §1 (People and Organizations tables, "someone who represents
  an organization *and* gives personally")
* `salesforce-import/src/transform/index.ts` — current Affiliation flattening
* `donation-rollups/README.md` — the owner-resolution and reverse-index shape this extends
* `2026-08-26-mailchimp-sync-design.md` — the per-address consent decision and the "second email
  address" gap this closes
