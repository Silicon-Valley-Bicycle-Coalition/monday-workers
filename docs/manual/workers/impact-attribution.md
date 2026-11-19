# impact-attribution

[Appendix A](../reference/impact-attribution.md) lists this Worker's routes, crons, queues, storage and bindings.

`impact-attribution` runs as the Cloudflare Worker `svbc-impact-attribution` (sandbox: `svbc-impact-attribution-sandbox`). It has no hostname: `fetch` returns 404. It runs on a nightly cron and also exposes one service-binding RPC entrypoint, `EmployerAnswers`, which `eventbrite-sync` calls. It reaches Monday through the `monday-auth` broker's `SyncToken` entrypoint (the Staff sync app). Production writes stay off until the `excludedPayers` list has been reviewed (see "Write switch"). Check the root README's [Status at a glance](../../../README.md#status-at-a-glance) table for current deploy state.

## What it does

It proposes employer affiliations for staff to confirm. Each night it creates **Draft** Affiliations from three kinds of evidence: the same company matching a person's gifts at least twice within 365 days, a donor's Personal or Household Email on a company domain, and the employer an Eventbrite attendee typed in. If it stops, no new Drafts appear in the **Drafts to confirm** view. Nothing else depends on it: Drafts are inert, and other Workers (`contact-roles`, `benevity-import`, the rollups) count only `Status = Current`.

## Trigger and data flow

Production cron `0 11 * * *` (11:00 UTC daily). The sandbox has no cron; start a run by hand with `npx wrangler dev --env sandbox --remote --test-scheduled` and request `/__scheduled`. The request may hang with no logs; confirm the run from the `proposals` table.

The nightly run (`src/nightly.ts`) has two jobs. One failing does not stop the other.

**Job 1, matching gifts and employer answers** (`src/run.ts`):

1. Read the write switch once. `hold` or `unknown` skips the night.
2. Read active Donations that have a `Matched By` and upsert them into D1 `matches`. Archived gifts read empty through the API, so D1 keeps them as history. An item whose `Matched By` was cleared is deleted from `matches`.
3. Find (person, organization) pairs with two matches no more than 365 days apart.
4. Process pending `employer_answers`: expire answers older than 365 days, supersede older answers from the same person, and resolve each answer to exactly one Organization by name. Unresolved answers stay `pending` and retry nightly.
5. Drop excluded payers, pairs that already have an Affiliation (any status), and pairs already in `proposals`.
6. Order Current first, newest evidence first. Create up to `maxProposalsPerRun` (25) Draft Affiliations, record each in `proposals`, then post an evidence comment on the item.

**Job 2, email domains** (`src/emailDomains/`):

1. Read People, People (Historical), Organizations and Affiliations, and rebuild D1 `email_index` in full.
2. Map email domains to Organizations: `domainOverrides` first, then Work Email on a Current affiliation, then the Organization's `Website`. Conflicting sources make a domain ambiguous, and it proposes nothing.
3. Propose a Draft (Proposed status Current) for live-board people whose Personal or Household Email maps to one organization, who have no Current or Draft affiliation, and who gave in the last 1,095 days (or never). Up to 25 a night, recent donors first.

**RPC.** `eventbrite-sync` calls `EmployerAnswers.recordEmployerAnswer(...)`, which upserts into D1 `employer_answers`. It throws only on a transient D1 failure, so the caller retries.

### D1 tables (`DB`)

| Table | Holds |
|---|---|
| `matches` | Every storable matching gift seen, keyed by Donations item id |
| `proposals` | Every Draft either job created. A pair here is never proposed again, even if staff delete the Draft. |
| `email_index` | Every address on People and Affiliations. Rebuilt each run. |
| `employer_answers` | Answers from `eventbrite-sync`, with state `pending`, `proposed`, `skipped`, `expired` or `superseded` |

## Monday boards and columns

Board ids live in [`config/svbc.json`](../../../impact-attribution/config/svbc.json) (production) and [`config/sandbox.json`](../../../impact-attribution/config/sandbox.json). Columns are named by bare title.

| Board | Columns | Read or write |
|---|---|---|
| Donations | `Gift Type` (label `Matching Donation`), `Matched By`, `Donor`, `Date`, `Amount` | Read |
| People, People (Historical) | `Personal Email`, `Household Email`, employer name, `Last Gift Date` | Read |
| Organizations | `Website`, item names (for answer lookup) | Read |
| Affiliations | `Person`, `Organization`, `Status`, `Work Email` | Read |
| Affiliations | New items named `<Person> @ <Organization>` with `Person`, `Organization`, `Status` = `Draft`, `Proposed status` (Current or Former) | Write (create), plus an update (comment) listing the evidence |

Staff work Drafts in the **Drafts to confirm** view on Affiliations: set `Status` to what `Proposed status` says, or delete the item. The view showing `Proposed status` is a hand setting in the view's Hide menu.

## Secrets

The Worker has no secrets. Monday access comes from the `MONDAY_AUTH` service binding. See [Accounts and access](../03-accounts-and-access.md).

| Name | Purpose | Issued by | Rotate |
|---|---|---|---|
| `MONDAY_API_TOKEN` (operator shell only) | Lets `add-proposed-status.mjs` call Monday | SVBC Integration user (production) or Sandbox Integration user (sandbox) | When that user's token is regenerated |

## Write switch

Key `impact-attribution:writes`. See [Operations](../07-operations.md).

| Mode | Behavior |
|---|---|
| `on` | Both jobs run and create Drafts. |
| `off` | Refreshes `matches`, `email_index` and answer states in D1. Creates nothing on Monday and records no proposals. Logs `wouldPropose`, a `payers` summary (every organization that would get a Draft, uncapped), and `emailDomainProposalDomains` (domains it would propose from, plus ambiguous ones). |
| `hold` / `unknown` | Skips the night. Nothing to catch up. |

**Production gate.** Do not set production to `on` until someone has reviewed the `off` run's `payers` summary and put every non-employer payer (foundations, donor-advised-fund sponsors) into `excludedPayers` in `config/svbc.json`, each with a note. In the same pass, review `emailDomainProposalDomains`: add `excludedDomains` for non-employer domains and `domainOverrides` for ambiguous ones worth settling. Deploy, wait for one more dry run, then run `node scripts/flags.mjs impact-attribution writes on --env production`.

## Failure modes

| Symptom | Cause | What to do |
|---|---|---|
| A duplicate Draft for a company that already has an Affiliation | The company exists twice on Organizations ("Google" and "Google, LLC"). Matching is by item id. | Delete the Draft. It won't return. Merge the Organizations if you can. |
| A person has two Drafts at different companies | The two jobs proposed different employers on different nights. | Staff keep one and delete the other. |
| A deleted email-domain Draft comes back | Its `proposals` row failed to write (log `emailDomainLedgerWriteFailed`). | Delete it again and check D1 health. |
| A domain never proposes | It is ambiguous, on `consumerDomains`/`excludedDomains`/`platformDomains`, or under `.edu` (blocked unless overridden). | Read `emailDomainProposalDomains`. Add a `domainOverrides` entry. |
| `staleOverrides` in the domain log line | A `domainOverrides` entry points at an Organization that no longer exists. | Fix or remove the entry. |
| `impact-attribution: answer step failed: ...` | D1 or the Organizations lookup threw during answers. Match proposals still ran. | Answers stay `pending` and retry the next night. Investigate if it repeats. |
| An employer answer stays `pending` | No Organization, or more than one, has that normalized name. | Staff add or merge the Organization. It resolves on the next run. |
| `eventbrite-sync` attendee messages dead-letter after ~4 days | The `EmployerAnswers` RPC throws: migration `0003` not applied, Worker not deployed with the entrypoint, or the `employerAnswers` config block fails validation. | Fix this Worker first, then replay the DLQ in `eventbrite-sync`. |
| Monday 429 or outage | The run fails partway. | Nothing to do. The next night redoes it; proposals are recorded only after Monday confirms the create. |
| A Draft has no evidence comment | The comment failed after the create. The proposal still stands (logged). | Optional: add the comment by hand. |

## Operator scripts

| Script | When | Command |
|---|---|---|
| `add-proposed-status.mjs` | Once per environment, to add the `Proposed status` column to Affiliations. Idempotent. Then add the 🔒 with `node scripts/mark-read-only-columns.mjs`. | `MONDAY_API_TOKEN=... node impact-attribution/scripts/add-proposed-status.mjs --env sandbox\|production [--execute]` |
| `bootstrap-matches.mjs` | Once, to seed `matches` from the Salesforce import artifacts (read-only use; the artifacts are gitignored and irreplaceable). Produces SQL to run against D1. | `node scripts/bootstrap-matches.mjs --payloads <payloads.ndjson> --ledger <ledger.ndjson> --boards <boards.json> --out /tmp/bootstrap.sql`, then `npx wrangler d1 execute svbc-impact-attribution --remote --file=/tmp/bootstrap.sql` |
| Flags | Turn writes on or off | `node scripts/flags.mjs impact-attribution writes on\|off\|hold --env sandbox\|production` |

## Changing it

- Key files: `src/nightly.ts` (runs both jobs), `src/run.ts` and `src/rule.ts` (matching gifts), `src/answers/` (RPC and answer rules), `src/emailDomains/` (domain mapping and selection), `src/store.ts` (D1), `src/config.ts` (validation).
- Copied files: `src/flags.ts`, `src/monday/graphql.ts`, and `src/employerName.ts` (canonical: `member-portal/src/changeRequests/employerName.ts`, CI job `employer-name-copies`). Edit the canonical file, then copy. See [Development](../05-development.md).
- Most tuning is config, not code: `rule`, `excludedPayers`, `maxProposalsPerRun`, and the `emailDomains` lists.
- **Deploy order for D1 migrations.** CI deploys the sandbox on every merge to `main` without applying migrations. Apply a new migration to the sandbox before its PR merges:
  - `npx wrangler d1 migrations apply svbc-impact-attribution-sandbox --remote --env sandbox`
  - `npx wrangler d1 migrations apply svbc-impact-attribution --remote`
- Deploy `impact-attribution` before `eventbrite-sync` in any environment, so its service binding resolves.
- Tests: `npm test`, `npm run test:scripts`, `npm run typecheck`. Deploy: `npm run deploy`, `npm run deploy:sandbox`.

## Further reading

- [`impact-attribution/README.md`](../../../impact-attribution/README.md), especially [Operator setup](../../../impact-attribution/README.md#operator-setup) and [Known limits](../../../impact-attribution/README.md#known-limits)
- [Matching-gift design](../../../docs/superpowers/specs/2026-11-16-employer-affiliation-proposals-design.md)
- [Email-domain design](../../../docs/superpowers/specs/2026-11-16-employer-from-email-domain-design.md)
- [Employer answers design](../../../docs/superpowers/specs/2026-11-17-eventbrite-employer-answers-design.md)
- [Operations](../07-operations.md), [Troubleshooting](../08-troubleshooting.md)
