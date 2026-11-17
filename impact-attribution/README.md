# impact-attribution

**Status: sandbox deployed 2026-11-16 with writes off; production not deployed. No live Monday write has been run.** It has two jobs, both
proposing Draft employer affiliations for staff to confirm: from repeated matching gifts (issue
#125, deployed to the sandbox) and from a donor's company email domain (issue #124, built, not
deployed; needs migration `0002`). Every Monday write ships **off**
(`impact-attribution:writes` unset, which means `off`).
Design: [`docs/superpowers/specs/2026-11-16-employer-affiliation-proposals-design.md`](../docs/superpowers/specs/2026-11-16-employer-affiliation-proposals-design.md);
plan: [`docs/superpowers/plans/2026-11-16-employer-affiliation-proposals.md`](../docs/superpowers/plans/2026-11-16-employer-affiliation-proposals.md).
Email domains: [`2026-11-16-employer-from-email-domain-design.md`](../docs/superpowers/specs/2026-11-16-employer-from-email-domain-design.md).
The wider job this Worker is named for (the email resolver, Acting-for attribution, the derived
People → Organization column) is in
[`2026-09-08-person-org-email-model-design.md`](../docs/superpowers/specs/2026-09-08-person-org-email-model-design.md);
only its `email_index` table is built.
**Stack:** TypeScript on Cloudflare Workers, a nightly cron, D1, no queue, no HTTP surface.

## The ask

Every employer matching gift names the company that paid it (Donations **Matched By**) and the
employee it is credited to (**Donor**). That is the best evidence SVBC has of who works where and
whose employer matches, but `benevity-import` deliberately never turns it into an affiliation: one
match is weak evidence (foundation payers, retiree programs, spouse matches).

This Worker collects the evidence across years and proposes an affiliation only when it repeats:
when the same company has matched a person **at least twice within 365 days**, it creates a
**Draft** Affiliation between them for staff to confirm. A single match does nothing.

## Data flow

```
Cloudflare cron 0 11 * * * ──► read write mode (once): on → run · off → dry run · hold/unknown → skip
                                   │
                                   ▼
   read active Donations with a Matched By (sparse) ──► upsert D1 `matches`
     (an item that no longer qualifies is deleted; a stored one the board stops returning is
      checked by id: still active means Matched By was cleared → deleted; archived → kept,
      because archived gifts read empty through the API, so D1 is the history)
                                   │
                                   ▼
   pairs from ALL of `matches` ──► the rule ──► drop excluded payers, pairs that already have an
     Affiliation (any status), pairs proposed before (D1 `proposals`)
                                   │
                                   ▼
   Current first, newest first ──► check person and org items still exist (a gone one is
     skipped without using a slot) until maxProposalsPerRun (25) live ones ──► create Draft Affiliation ──► record in `proposals` ──► post evidence comment
                                   │
                                   ▼  then, in the same run (src/nightly.ts; one job failing doesn't stop the other)
   read People + People (Historical), Organizations, Affiliations ──► rebuild D1 `email_index`
                                   │
                                   ▼
   email domain → organization map ──► live-board people with a company Personal/Household Email
     nobody else holds, a gift in the last 3 years (or none), no Current or Draft affiliation, not
     Former there, not in `proposals` ──► recent donors first,
     emailDomains.maxProposalsPerRun (25) ──► create Draft (Proposed status Current) ──► record
     in `proposals` ──► post evidence comment
```

## The rule

A storable match is a Donations item with Gift Type `Matching Donation`, exactly one Matched By on
Organizations, exactly one Donor on People or People (Historical), and a Date. A (person,
organization) pair qualifies when any two of its matches are at most 365 days apart (same-day
matches count). The Draft's **Proposed status** is **Current** if the pair's latest match is within
365 days of the run date, otherwise **Former**.

A proposal is one Affiliations item named `<Person> @ <Organization>`, with Person, Organization,
Status `Draft` and the 🔒 **Proposed status** column set (Start, End, Role and Work Email left
blank: match dates say when someone gave, not when they were hired). A comment on it lists the
matches, newest first, at most 10. Drafts are inert: `contact-roles` and the rollups read only
`Status = Current`. Staff work them in the **Drafts to confirm** view: set Status to what Proposed
status says (or the other), or delete the item. A deleted Draft never comes back: the pair is in
`proposals` for good.

## Second job: employers from email domains (#124)

Many donors give from a work address (`jo@acme.com` in Personal Email). Each night the Worker maps
email domains to Organizations from what the CRM already holds, in this order:

1. `emailDomains.domainOverrides` (domain → Organizations item id): always wins.
2. The Work Email on a **Current** affiliation with exactly one Organization.
3. An Organization's **Website** (scheme, `www.`, path and port dropped). A website on a social or
   hosting platform (`emailDomains.platformDomains`: LinkedIn, Facebook, Eventbrite, …) is ignored.

Sources that disagree make a domain ambiguous: it proposes nothing, and the run logs it, until an
override settles it. A subdomain walks up to its parent (`cs.stanford.edu` → `stanford.edu`), but
a consumer or excluded domain on the way stops it (`emailDomains.consumerDomains`,
`excludedDomains`). A domain under a blocked TLD (`emailDomains.blockedTlds`: `edu`) maps only
through an override: students share a university's domain with its staff, so neither its Website
nor a Work Email is enough. An override on `stanford.edu` covers its subdomains too, so pair it with
`excludedDomains` entries for the alumni ones.

A person gets a proposal when their Personal or Household Email maps to one organization (two
addresses mapping to two organizations: skipped) and they have no Current or Draft affiliation
anywhere, no Former one at that organization, and the pair isn't in `proposals`. Three guards keep
an address from naming an old or someone else's job:

* only people on the live People board (`emailDomains.proposeFromBoardIds`); People (Historical)
  addresses still go into `email_index`;
* no proposal when the Last Gift Date is older than `emailDomains.staleAfterDays` (1095); a person
  with no gift on the live board is still proposed;
* an address more than one person holds (a shared Household Email, usually) is ignored, so a spouse
  isn't proposed at the other's employer. The person's other address can still propose. Recent donors go
first (Last Gift Date, newest first; no gift last), 25 a night.

The Draft is the same as the matching-gift job's: `<Person> @ <Organization>`, Status `Draft`,
**Proposed status** `Current`, and a comment such as `Proposed from email domain acme.com
(Personal Email; Website match). Salesforce employer: Acme Inc.` Work Email is never set: the
address stays on People, and moving it (with its Mailchimp consent) is a staff decision. Staff
reject one by deleting it or setting it to Former; either way it never comes back.

Both jobs share the `proposals` ledger, so a pair either one proposed is never proposed again by the
other. Matching gifts run first, so when both point a person at the same organization the Draft
cites the gifts.

`benevity-import` counts only **Current** affiliations when it resolves a Benevity donor by Work
Email or by organization, so Drafts from either job never steer a donation to a person.

## D1

| Table | What | Key |
|---|---|---|
| `matches` | every storable match seen: donation, person and organization item ids, date, amount in cents, `source` (`bootstrap`/`board`) | `donation_item_id` |
| `proposals` | every Draft either job created: person, organization, affiliation item id, proposed status, match count (0 for an email-domain one), `evidence` (`matches`/`email_domain`), `domain` | (`person_item_id`, `org_item_id`) |
| `email_index` | every address on People (Personal, Household) and Affiliations (Work Email), lower-cased, with its kind (work beats personal beats household), the people holding it and the affiliation for a work one. Rebuilt in full each run; the resolver's later slices read it | `address` |

A proposal is recorded only after Monday confirms the create. If the comment fails afterwards the
proposal still stands (logged).

## Config (`config/svbc.json`, `config/sandbox.json`)

Chosen by `env.ENVIRONMENT` (`src/environment.ts`); `config/split.test.ts` fails if the two share a
board id. Validated at startup (`src/config.ts`). Column titles are bare titles, matched with
`bareTitle`.

* `donations`: `boardId`, column titles `giftType`, `matchedBy`, `donor`, `date`, `amount`, and
  `matchingGiftLabel`.
* `affiliations`: `boardId`, column titles `person`, `organization`, `status`, `proposedStatus`, and
  `labels` (`draft`, `current`, `former`).
* `peopleBoardIds` (live and Historical) and `organizationsBoardId`: what a Donor or Matched By link
  must point at.
* `rule`: `windowDays` 365, `minMatches` 2 (the only supported value), `currentWithinDays` 365.
* `excludedPayers`: `{ id, note }` per Organizations item that pays matches but isn't an employer
  (foundations, donor-advised-fund sponsors). Empty until the production gate below.
* `maxProposalsPerRun`: 25.
* `emailDomains` (#124): column titles `people` (`personalEmail`, `householdEmail`,
  `employerName`, `lastGiftDate`), `organizationWebsite`, `affiliationWorkEmail`; domain lists
  `consumerDomains`, `excludedDomains`, `platformDomains` (lower-cased at startup);
  `domainOverrides` (domain → Organizations item id); `blockedTlds` (`edu`, bare TLDs only);
  `proposeFromBoardIds` (the live People board; must be one of `peopleBoardIds`);
  `staleAfterDays` (1095); its own `maxProposalsPerRun` (25).

## Write switch

* **on**: as above.
* **off**: refreshes `matches` and `email_index` (the Worker's own state), creates nothing on
  Monday and records no proposals. The run's JSON log line carries `wouldPropose` (person/org item ids) and a `payers`
  summary: every organization that would get a Draft with no per-run cap, by item id and name, with
  its count. The email-domain job logs an `emailDomainProposals` line (counts) and an
  `emailDomainProposalDomains` line: each domain it would propose from, with its organization id,
  source and count, and each ambiguous domain. Person names and emails are never logged.
* **hold / unknown**: skips the night entirely. Nothing to catch up.

## Operator setup

Run from this directory unless noted. Sandbox first, then production.

0. Deploy `benevity-import` with its Current-only affiliation filter (#124) before this Worker
   writes anything in that environment: until then a Draft would count when Benevity resolves a
   donor.
1. ~~Create the D1 databases~~ done 2026-11-16: `svbc-impact-attribution`
   (`1df5c5c8-8804-4b85-90dc-09360a5f2aa5`) and `svbc-impact-attribution-sandbox`
   (`75b7115a-abe0-4bd4-904e-7ca255694906`), ids in `wrangler.jsonc`.
2. ~~Apply the D1 migrations~~ done 2026-11-16 on both (`0001_create_tables.sql`). For a later
   migration: `npx wrangler d1 migrations apply svbc-impact-attribution-sandbox --remote --env
   sandbox` (and `svbc-impact-attribution --remote`).
   `0002_email_domain_proposals.sql` (#124: `proposals.evidence`/`domain`, `email_index`): applied
   to the sandbox 2026-11-17; **production still to do**, before the production deploy that carries
   the email-domain job. CI deploys the sandbox on every merge to `main` without applying
   migrations, so a later migration goes to the sandbox before its MR merges.
3. ~~Proposed status column~~ done 2026-11-16 on both Affiliations boards with
   `scripts/add-proposed-status.mjs --env sandbox|production --execute`, and marked `🔒 Proposed
   status` (production through `scripts/mark-read-only-columns.mjs --workspace 18201685 --apply`;
   sandbox by renaming the one column, because that workspace's run would also have renamed 11
   unrelated Wealth Screening columns). **Still to do by hand:** add Proposed status to the
   existing **Drafts to confirm** view on both boards (production view 289689214, sandbox
   289083044). `salesforce-import`'s configure only creates a view that doesn't exist yet, and the
   API doesn't return a view's current column settings, so overwriting it could undo staff changes.
4. ~~Match history~~ done 2026-11-16 in production: 1,964 matches, 424 person–company pairs,
   2016-04-06 to 2026-10-28, from the import's artifacts (read-only; they are gitignored and
   irreplaceable):
   ```sh
   B=../../monday-migration/backup/salesforce-import-data-2026-10-31
   node scripts/bootstrap-matches.mjs --payloads $B/transform/payloads.ndjson \
     --ledger $B/load/ledger.ndjson --boards $B/load/boards.json --out /tmp/bootstrap.sql
   npx wrangler d1 execute svbc-impact-attribution --remote --file=/tmp/bootstrap.sql
   ```
   (831 matching gifts had an organization as Donor, 242 no migrated person, 30 no organization
   link.) The sandbox has no import artifacts of its own: its nightly read fills `matches`.
5. ~~Sandbox deploy, writes off~~ done 2026-11-16 (version `15807c85`; `impact-attribution:writes
   off` set in `sandbox-FLAGS`). Read the next 11:00 UTC run's JSON log line in Workers Logs.
6. Sandbox: `writes on`, check the Drafts in **Drafts to confirm** against a few known people.
7. Production: `writes off`, `npm run deploy`, wait for one dry run.
8. **Gate (decided 2026-11-16): David reviews the dry run's `payers` summary** and marks the
   foundations, donor-advised-fund sponsors and other non-employers. Put their ids in
   `excludedPayers` in `config/svbc.json` with a note naming each, deploy, and wait for one more dry
   run to confirm. No production `on` before this. In the same pass, read the
   `emailDomainProposalDomains` line: add an `excludedDomains` entry for any domain that isn't an
   employer (an ISP missing from `consumerDomains`, an alumni domain outside `.edu`) and a
   `domainOverrides` entry for each ambiguous domain worth settling. A university only proposes
   once it has an override (`.edu` is blocked).
9. `node ../scripts/flags.mjs impact-attribution writes on --env production`.

From the artifacts, about 133 pairs qualify (56 Current) before existing affiliations are removed;
at 25 a night the backlog drains in about six nights.

## Known limits

* Organizations are matched by item id. If a company exists twice ("Google", "Google, LLC") and an
  existing Affiliation points at the other one, a duplicate Draft appears; delete it and it stays
  gone.
* A match whose Donations item was deleted (not archived) stays in `matches`: the Worker can't tell
  the two apart. At worst it contributes to one Draft staff can delete.
* An email-domain proposal whose ledger write failed after the Draft was created isn't in
  `proposals`. The Draft keeps the person from being proposed again while it exists, but if staff
  delete it the next run proposes it again (logged as `emailDomainLedgerWriteFailed`).
* A Household Email only one person in the CRM holds can still be a spouse's work address. The
  comment names Household Email so staff can tell.
* Last Gift Date is the only clock on an address. A live-board person who has never given is
  proposed whatever the address's age.
* The matching-gift job skips only an existing (person, organization) pair, not a person with a
  Draft elsewhere. If the email-domain job proposed Acme one night and a second matching gift from
  Globex qualifies later, the person has two Drafts; staff keep one and delete the other (it stays
  gone).
* A `domainOverrides` entry whose organization no longer exists is ignored and listed as
  `staleOverrides` in the `emailDomainProposalDomains` log line; fix or remove it.
