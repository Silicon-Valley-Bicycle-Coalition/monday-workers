# impact-attribution

**Status: sandbox deployed 2026-11-16 with writes off; production not deployed. No live Monday write has been run.** It has two jobs, both
proposing Draft employer affiliations for staff to confirm: from repeated matching gifts (issue
#125, deployed to the sandbox) and from a donor's company email domain (issue #124, built, not
deployed; needs migration `0002`). The matching-gift job also takes employer answers collected by
`eventbrite-sync` (issue #127, built, not deployed; needs migration `0003`; ships disabled in
`eventbrite-sync`). Every Monday write ships **off**
(`impact-attribution:writes` unset, which means `off`).
Design: [`docs/superpowers/specs/2026-11-16-employer-affiliation-proposals-design.md`](../docs/superpowers/specs/2026-11-16-employer-affiliation-proposals-design.md);
plan: [`docs/superpowers/plans/2026-11-16-employer-affiliation-proposals.md`](../docs/superpowers/plans/2026-11-16-employer-affiliation-proposals.md).
Email domains: [`2026-11-16-employer-from-email-domain-design.md`](../docs/superpowers/specs/2026-11-16-employer-from-email-domain-design.md).
Employer answers: [`2026-11-17-eventbrite-employer-answers-design.md`](../docs/superpowers/specs/2026-11-17-eventbrite-employer-answers-design.md).
The wider job this Worker is named for (the email resolver, Acting-for attribution, the derived
People → Organization column) is in
[`2026-09-08-person-org-email-model-design.md`](../docs/superpowers/specs/2026-09-08-person-org-email-model-design.md);
only its `email_index` table is built.
**Stack:** TypeScript on Cloudflare Workers, a nightly cron, D1, no queue, no HTTP surface; one service-binding RPC entrypoint (`EmployerAnswers`).

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
365 days of the run date, otherwise **Former**. A person has one current employer: when two
companies both come out Current, the one whose latest match is older is proposed as **Former**, and
its comment names the newer one ("Proposed as Former: Google, LLC has matched since (latest
2026-09-11)"). The newer company counts even if it already has an Affiliation or was proposed
before; an excluded payer never does, and two latest matches on the same day leave both Current.

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

## Employer answers in the matching-gift job (#127)

`eventbrite-sync` hands over what an attendee typed for "Where do you work?" (it collects; this Worker
proposes, so one place creates Drafts, with one ledger, one cap and one exclusion list). Answers are
weaker than a donor's own portal answer, so one becomes a **Draft** for staff to confirm, never an
affiliation that counts on its own. Spec: "Proposing it" in the design above.

**The RPC.** `EmployerAnswers` (`src/answers/entrypoint.ts`) has one method, `recordEmployerAnswer({
source: 'eventbrite', sourceId, personItemId, answer, answeredAt, context })`. It returns `{ recorded:
true }`, or `{ recorded: false, reason }` for anything that will never pass (`disabled`: no
`employerAnswers` config; `invalid`; `non-answer`: blank or on the `ignore` list; `closed`: the row was
already decided). It throws only on a transient failure (D1), so the caller retries. The answer and
the context are each stored trimmed and cut to 200 characters. It is an upsert on
`(source, source_id)`: a `pending` row is replaced by a later, changed answer; once the row is
`proposed`, `skipped`, `expired` or `superseded` it is left alone. Logs carry ids and the result, never
the answer or context.

**D1 `employer_answers`** (migration `0003_employer_answers.sql`; it also adds `proposals.sources`):
`source`, `source_id` (primary key), `person_item_id`, `answer`, `answer_normalized`, `answered_at`,
`context`, `state`, `org_item_id`, `received_at`, `last_tried_at`. The answer text lives in D1 and in
Monday comments; it is never logged.

| State | Meaning |
|---|---|
| `pending` | waiting: unresolved name, or over the cap |
| `proposed` | a Draft was created from it |
| `skipped` | a skip rule applied (excluded payer, existing Affiliation, `proposals` ledger, missing person or organization item); not retried |
| `expired` | answered more than `maxAgeDays` (365) ago |
| `superseded` | the same person gave a later, different answer |

**In the nightly run**, after the match step and before choosing candidates:

1. Pending answers older than `maxAgeDays` are `expired`.
2. Per person only the latest `answered_at` answer (plus any with the same normalised text) stays; the
   rest are `superseded`, even while the latest is unresolved. A pending answer older than that
   person's latest `proposed` answer (same day: earlier `received_at`), such as a backfill arriving
   after a newer answer was proposed, is `superseded` too. This is among answers only; a pair
   that qualifies from matching gifts is proposed by its own rule.
3. Each distinct answer is resolved to an Organization with one name query (`findOrganizationsByNames`
   on `organizationsBoardId`; `normalizeEmployerName`, `organizationNameVariants` and `pickOrganization`
   in `src/employerName.ts`). Exactly one Organization whose normalised name equals the answer resolves;
   zero or several leave it `pending`, retried nightly, so it becomes a Draft after staff add the
   Organization. No staff item or digest per unmatched answer.
4. A resolved answer is a candidate with Proposed status **Current** and evidence date `answered_at`.
   A pair that also qualifies from matches gets one Draft and one comment from both; **Current** if either
   source says Current.
   The one-current-employer rule counts answers as evidence too: when a person has Current candidates at
   two organizations, the one with the newest match or answer stays Current and the other is proposed as
   Former, its comment naming the newer employer (`has matched since` or `named … as their employer since`).
5. The same skips as for matches apply. Answer candidates and match candidates share one ordered list
   (Current first, then latest evidence) and one `maxProposalsPerRun`; leftovers stay `pending`.
6. A created Draft is recorded in `proposals` (`evidence` `matches`; `sources` is `matches`, `answers` or `both`; `match_count`
   0 for an answer-only Draft), its answers become `proposed`, and the comment gets a line per answer:
   `Proposed from an Eventbrite answer: "<answer>" (<event>, <date>)`, after any match lines.

If the answer step itself throws (D1, the Organizations lookup), the run logs
`impact-attribution: answer step failed: <error class>: <message>` (never answer text) and carries on
with match proposals only; answers left `pending` are tried again the next night.

If marking the answers `proposed` fails after the Draft is created, the `proposals` ledger row still
stops a second Draft and the next run marks them `skipped`, so a `skipped` answer can belong to a pair
that was proposed.

**Run summary.** `RunSummary.answers` counts `pending` (still pending after the run), `expired`,
`superseded`, `resolved`, `unresolved`, `skipped` and `proposed`. `summary.skipped.*` now counts
answer-only pairs as well; `qualifying` counts match pairs only.

**Write switch.** `on` as above. Under `off` the run does the D1 state changes (expire, supersede,
`last_tried_at`, skips) and logs the counts and `wouldPropose`, and writes nothing to Monday. Under
`hold`/`unknown` the run skips and answers wait.

**Config.** `employerAnswers: { maxAgeDays, ignore }` in `config/*.json` (non-answers such as `n/a`,
`none`, `retired`, `self employed`, `student`), with Organizations read from the existing
`organizationsBoardId`. Absent, the RPC returns `disabled` and the run skips the answer step.

**Shared name matching.** `src/employerName.ts` is a byte-identical copy of the canonical
`member-portal/src/changeRequests/employerName.ts`, held by the CI job `employer-name-copies`. Edit
`member-portal`'s, then copy it over; it must stay strip-only TypeScript.

### Rollout of employer answers

1. **Now, no code:** staff add "Where do you work? (Many employers match donations and volunteer
   time.)" to the 2027 Pledge to Ride draft before **2027-01-15**. Answers land in Other Answers.
   Whoever configures the event marks that question `ignoreQuestions` until this ships, or maps it
   to `employer` once it has.
2. Ship both Workers with `employerAnswers.enabled` false in `eventbrite-sync`. Turn it on in
   sandbox (after the pre-enable checklist below) and replay one past event with `backfill-attendees.mjs --env sandbox`.
   Production `eventbrite-sync` deploys without the binding, so the 2027 pledge config never waits
   on this. Order in the sandbox: apply migration `0003` and deploy `impact-attribution` sandbox
   **before** `eventbrite-sync` sandbox, so the service binding resolves.
3. Production: apply `0003` to the production D1
   (`npx wrangler d1 migrations apply svbc-impact-attribution --remote`), deploy `impact-attribution`
   (its own gate: the `excludedPayers` review), then add the binding to `eventbrite-sync` production
   and, once the checklist below passes, enable it. Then backfill the 2027 pledges, so answers given
   before this step are recorded.

**Pre-enable checklist.** Before setting `eventbrite-sync`'s `employerAnswers.enabled` to `true` in
an environment, confirm in that same environment:

- [ ] migration `0003_employer_answers.sql` is applied to this Worker's D1;
- [ ] this Worker is deployed with the `EmployerAnswers` entrypoint (a build from #127 or later);
- [ ] this Worker's `config/*.json` has an `employerAnswers` block (and loads: a config that
  fails validation makes every call throw).

A missing migration, entrypoint or loadable config makes every call throw: each answered attendee's
message retries for about four days and then dead-letters, after its board item already exists. A
missing `employerAnswers` block is refused as `disabled`, so nothing is recorded.

Each answered attendee costs one extra People read in `eventbrite-sync`, so pace that backfill as its
README advises.

## D1

| Table | What | Key |
|---|---|---|
| `matches` | every storable match seen: donation, person and organization item ids, date, amount in cents, `source` (`bootstrap`/`board`) | `donation_item_id` |
| `proposals` | every Draft either job created: person, organization, affiliation item id, proposed status, match count (0 for an email-domain or answer-only one), `evidence` (`matches`/`email_domain`), `domain`, `sources` (`matches`/`answers`/`both` on matching-gift-job Drafts from migration `0003` on; null otherwise) | (`person_item_id`, `org_item_id`) |
| `email_index` | every address on People (Personal, Household) and Affiliations (Work Email), lower-cased, with its kind (work beats personal beats household), the people holding it and the affiliation for a work one. Rebuilt in full each run; the resolver's later slices read it | `address` |
| `employer_answers` | answers handed over by other Workers (see "Employer answers") | (`source`, `source_id`) |

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

0. ~~Deploy `benevity-import` with its Current-only affiliation filter~~ done 2026-11-17 in both
   environments (production `a0e1b206`, sandbox `bd5e1efd`). It must precede this Worker's writes
   in an environment: without it a Draft would count when Benevity resolves a donor.
1. ~~Create the D1 databases~~ done 2026-11-16: `svbc-impact-attribution`
   (`1df5c5c8-8804-4b85-90dc-09360a5f2aa5`) and `svbc-impact-attribution-sandbox`
   (`75b7115a-abe0-4bd4-904e-7ca255694906`), ids in `wrangler.jsonc`.
2. ~~Apply the D1 migrations~~ done 2026-11-16 on both (`0001_create_tables.sql`). For a later
   migration: `npx wrangler d1 migrations apply svbc-impact-attribution-sandbox --remote --env
   sandbox` (and `svbc-impact-attribution --remote`).
   `0002_email_domain_proposals.sql` (#124: `proposals.evidence`/`domain`, `email_index`): applied
   to the sandbox and production 2026-11-17. CI deploys the sandbox on every merge to `main` without applying
   migrations, so a later migration goes to the sandbox before its MR merges.
3. ~~Proposed status column~~ done 2026-11-16 on both Affiliations boards with
   `scripts/add-proposed-status.mjs --env sandbox|production --execute`, and marked `🔒 Proposed
   status` (production through `scripts/mark-read-only-columns.mjs --workspace 18201685 --apply`;
   sandbox by renaming the one column, because that workspace's run would also have renamed 11
   unrelated Wealth Screening columns). Proposed status is shown in the **Drafts to confirm** view
   on both boards (production view 289689214, sandbox 289083044; checked 2026-11-17). That is a
   hand setting in the view's Hide menu: `salesforce-import`'s configure only creates a view that
   doesn't exist yet, and the API doesn't return a view's column settings.
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
5. ~~Sandbox deploy, writes off~~ done 2026-11-16 (version `15807c85`).
6. ~~Sandbox `writes on`~~ done 2026-11-17 (version `979e0f75`): one run made 35 Drafts (20
   matching gifts, 15 email domains), all Proposed status Current with their comment. **Still to
   do:** check them in **Drafts to confirm** against a few known people. Sandbox crons are off
   (`triggers.crons: []`), so a sandbox run is started by hand: `npx wrangler dev --env sandbox
   --remote --test-scheduled`, then request `/__scheduled`. The run happens against the sandbox D1
   and boards even though the request may hang with no logs; confirm it from `proposals` in D1.
7. ~~Production: `writes off`, `npm run deploy`~~ done 2026-11-17 (version `971344ab`, migration
   `0002` applied first). The first dry run is 2026-11-18 at 11:00 UTC.
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
