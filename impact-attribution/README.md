# impact-attribution

**Status: sandbox deployed 2026-11-16 with writes off; production not deployed. No live Monday write has been run.** Its first and only job so far
is employer affiliations from repeated matching gifts (issue #125). Every Monday write ships **off**
(`impact-attribution:writes` unset, which means `off`).
Design: [`docs/superpowers/specs/2026-11-16-employer-affiliation-proposals-design.md`](../docs/superpowers/specs/2026-11-16-employer-affiliation-proposals-design.md);
plan: [`docs/superpowers/plans/2026-11-16-employer-affiliation-proposals.md`](../docs/superpowers/plans/2026-11-16-employer-affiliation-proposals.md).
The wider job this Worker is named for (the email resolver, Acting-for attribution, the derived
People → Organization column) is in
[`2026-09-08-person-org-email-model-design.md`](../docs/superpowers/specs/2026-09-08-person-org-email-model-design.md)
and not built.
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

## D1

| Table | What | Key |
|---|---|---|
| `matches` | every storable match seen: donation, person and organization item ids, date, amount in cents, `source` (`bootstrap`/`board`) | `donation_item_id` |
| `proposals` | every Draft created: person, organization, affiliation item id, proposed status, match count | (`person_item_id`, `org_item_id`) |

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

## Write switch

* **on**: as above.
* **off**: refreshes `matches` (the Worker's own state), creates nothing on Monday and records no
  proposals. The run's JSON log line carries `wouldPropose` (person/org item ids) and a `payers`
  summary: every organization that would get a Draft with no per-run cap, by item id and name, with
  its count. Person names and emails are never logged.
* **hold / unknown**: skips the night entirely. Nothing to catch up.

## Operator setup

Run from this directory unless noted. Sandbox first, then production.

1. ~~Create the D1 databases~~ done 2026-11-16: `svbc-impact-attribution`
   (`1df5c5c8-8804-4b85-90dc-09360a5f2aa5`) and `svbc-impact-attribution-sandbox`
   (`75b7115a-abe0-4bd4-904e-7ca255694906`), ids in `wrangler.jsonc`.
2. ~~Apply the D1 migrations~~ done 2026-11-16 on both (`0001_create_tables.sql`). For a later
   migration: `npx wrangler d1 migrations apply svbc-impact-attribution-sandbox --remote --env
   sandbox` (and `svbc-impact-attribution --remote`).
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
   run to confirm. No production `on` before this.
9. `node ../scripts/flags.mjs impact-attribution writes on --env production`.

From the artifacts, about 133 pairs qualify (56 Current) before existing affiliations are removed;
at 25 a night the backlog drains in about six nights.

## Known limits

* Organizations are matched by item id. If a company exists twice ("Google", "Google, LLC") and an
  existing Affiliation points at the other one, a duplicate Draft appears; delete it and it stays
  gone.
* A match whose Donations item was deleted (not archived) stays in `matches`: the Worker can't tell
  the two apart. At worst it contributes to one Draft staff can delete.
