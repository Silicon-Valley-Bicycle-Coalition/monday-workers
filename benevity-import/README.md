# benevity-import

**Staff UAT script:** [`docs/uat/benevity-import.md`](../docs/uat/benevity-import.md) — what a non-technical tester can try in the sandbox and what they should see. Keep it in step with this README.

**Status:** **Deployed to production 2026-11-02** (runbook step 6.5), `writes on`. That day the
`Benevity Uploads` board (`18438204360`, Donors & Contacts; same subscribers as Donations plus
SVBC Integration; groups Uploads / Review, Retry and Key columns as on the sandbox) and a
`Benevity Disbursement Date` column on Donations (`date_mm8rtv9y`) were created; every other id in
`config/svbc.json` was read by title from the live boards. `BENEVITY_WEBHOOK_SECRET` was rotated
and both webhooks registered: `662183019` (file column `file_mm8rz1v8` →
`/webhooks/monday/benevity-upload`) and `662183020` (Retry `color_mm8rfchp` →
`/webhooks/monday/benevity-retry`). No report has been uploaded to production yet. Sandbox
provisioned and verified end to end 2026-09-19, remapped to the `(sandbox v3)` boards and
re-verified 2026-09-30 (see "Sandbox environment" below).
**Priority:** Post-migration, non-blocking — staff can keep hand-entering matching gifts on the
Donations board in the meantime, exactly as they do in Salesforce today. Two small
`salesforce-import` changes it depends on (see Related changes) *are* pre-cutover.
**Owner:** David (decided 2026-09-30, [svbc-monday-migration#49](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-migration/-/issues/49)).
**Stack:** Hono + TypeScript + D1 + Cloudflare Queues (the shared stack, see `../README.md`).

## The ask

Employer matching gifts reach SVBC through [Benevity](https://benevity.com/nonprofits), the
workplace-giving platform most of its large local employers use (Google, Apple, Netflix, Applied
Materials, Microsoft, NVIDIA, Expedia, Varian, Intuitive). Benevity pays SVBC in periodic
disbursements and, for each one, publishes a report listing every donation and match it contains.
Today a staff member downloads that report and types each row into the CRM by hand — about 30 rows
a month, 3,020 since 2013, each named `<Company> - Employer Matching <Donor> <date>`. Nothing
stores Benevity's transaction id, so a row entered twice is invisible; and the CRM's one "donor"
link holds either the employee or the company, never both.

**There is no better feed than the CSV.** Benevity's [developer API](https://developer.benevity.org/)
serves corporate clients embedding giving into their own apps and has no endpoint for a cause to
pull the donations it received. Reports are downloads from the
[Causes Portal](https://causeshelp.benevity.org/hc/en-us/articles/115003003423-Where-do-I-find-my-reports)
(the [redesigned portal](https://causeshelp.benevity.org/hc/en-us/articles/47976276289684-New-Introducing-the-New-Causes-Portal-Experience)
can bundle many disbursements into one file). So this Worker's job is not to replace the download
— it is to replace the hand-keying: take the file, dedupe it, link each gift to the paying
**Organization** and, where Benevity disclosed one, to the employee **Person**, and put anything it
can't resolve on a worklist instead of guessing.

## Data flow

```
Benevity Causes Portal
  │  staff download the disbursement report (CSV), roughly monthly — may bundle
  │  several disbursements in one file (see Input format)
  ▼
Monday "Benevity Uploads" board — staff drop the file in a file column          (see Trigger)
  │  Monday webhook on item create/file change
  ▼
Cloudflare Worker (webhook handler)
  │  record the upload in D1 `uploads` and enqueue one Queue message for it — no
  │  fetch or parse inside the webhook request, so a large report can't time it out
  ▼
Cloudflare Queue → consumer Worker, per upload
  │  1. fetch the asset via Monday's GraphQL API (refused, marked `error`, over 2 MB)
  │  2. split the file into one or more preamble+rows+footer blocks; parse each
  │     independently into D1 `disbursements`, validating its own header and its
  │     footer's reported total against the sum of its own rows
  │  3. upsert each block's rows into D1 `rows` keyed on Benevity Transaction ID —
  │     one batched D1 call per block, and globally, not per file or per block, so
  │     the same gift arriving in two different bundles is still one row
  │     (a re-upload of an overlapping file is a no-op for rows already written)
  │  4. enqueue one Cloudflare Queue message per row not yet written
  │  a failed fetch or D1 call retries the message, resuming at the first unfinished block
  ▼
Cloudflare Queue → consumer Worker, per row
  │  1. resolve the paying company → Organizations item (exact name, then config aliases)
  │  2. resolve the employee → People item (email, then name + employer) or "anonymous"
  │  3. split the row: employee gift (if any) and company match (if any) → two Donations items
  │  4. write to Monday; stamp each item with the Transaction ID before marking the row done
  │  unresolved company or ambiguous person → write nothing, add a worklist item, mark
  │  the row `needs-review`; retries + DLQ on API failure as in every webhook Worker here, and
  │  a gift that exhausts its retries lands on the worklist too (see Dead letters)
  ▼
Donations board (+ Matched By → Organizations, Donor → People)
Worklist: a group on the Benevity Uploads board, one item per row needing a human

Staff fix what a worklist item reports, then set its Retry column to "Retry"   (see Worklist)
  │  Monday webhook on the Retry status column
  ▼
Cloudflare Worker (/webhooks/monday/benevity-retry)
  │  row (or every held-back row of a block) needs-review → ingested, re-enqueued; item → "Queued"
  ▼
Queue consumer, as above → item → "Done", or back to "Needs review" with the new reason
```

Ingestion, resolution, and the Monday write are separate, independently testable steps, same
shape as `funraise-sync`. The D1 row status only advances to `written` after Monday confirms the
item exists with its Transaction ID set, so a crash between "create item" and "record success"
is caught on retry by the pre-create lookup (search Donations for the Transaction ID before
creating), never by a duplicate. A block that fails its own header or total-sum validation is
recorded but contributes zero rows, so one bad block in a bundled file doesn't lose the good ones
around it.

### Trigger

**Recommended: a file column on a small staff-facing "Benevity Uploads" board**, one item per
uploaded report, with a Monday webhook on the file column. Staff already live in Monday, the
board's own permissions gate who can upload, and the worklist lives on the same board next to the
upload that produced it. The Worker fetches the file through Monday's `assets` query (time-limited
`public_url`) — no separate login surface to build or secure.

Alternative if the asset fetch proves awkward: a Cloudflare-Access-protected upload page on the
Worker itself. Same parsing and downstream steps; only the first hop changes.

Not in scope: polling Benevity. Whether Benevity can email the report as an attachment or deliver
it by SFTP is an open question for their support team; if either exists, an inbound-email or
SFTP-pull front end can replace the manual drop later without touching the rest.

## Input format

The Benevity disbursement ("Donation") report is a CSV with a preamble block above the column
header row, then one row per donation or match, then a trailer. **Verified against a real SVBC
export 2026-09-15** (structure only — the sample is not stored anywhere in this repo, real donor
PII):

* **Preamble:** a `Donations Report` line, a `#---...` separator, then one `key,value` line each
  for `Charity Name`, `Charity ID`, `Period Ending`, `Currency` (the disbursement's own currency,
  distinct from the per-row `Currency` column below), `Payment Method`, `Disbursement ID`, `Note`,
  another separator, then a blank line before the header row.
* **Trailer:** after the last data row, a `Totals,...` row (column totals, blank Company/Donor/etc.
  fields — must not be parsed as a data row), then three summary lines: `Total Donations (Gross)`,
  `Check Fee`, `Net Total Payment`.
* **A file may contain more than one preamble+rows+trailer block** — the redesigned Causes Portal
  can bundle several disbursements into one download. The parser splits on repeated `Donations
  Report` lines and treats each block independently (its own header validation, its own
  total-sum check against its own trailer).
* The header row's 23 columns are read **by name**, so column order doesn't matter; this Worker
  uses:

| Benevity column | Used for |
|---|---|
| Company | Organization resolution (paying company; may be a foundation name) |
| Donor First Name, Donor Last Name | Person resolution fallback; item name |
| Email | Person resolution, primary key when disclosed |
| Address / City / State/Province / Postal Code | Not written to Monday (see PII); may inform a worklist proposal |
| Donation Date | Donations `Date` |
| *(preamble)* Period Ending | Donations `Benevity Disbursement Date`, on every item the block produces — distinct from `Donation Date`, since one disbursement covers donations made on different dates |
| Transaction ID | Idempotency key → `Benevity Transaction ID` column |
| Donation Frequency | One-time vs recurring payroll giving — informational, written to item description |
| Currency (row-level) | Must be USD; anything else goes to the worklist. Confirmed non-hypothetical: the verification export's one data row was reported in EUR |
| Total Donation to be Acknowledged | Employee gift amount (gross) |
| Match Amount | Company match amount (gross) |
| Cause Support Fee, Merchant Fee | Not written to the CRM (finance/QuickBooks concern) |
| Comment / Reason / Source / Activity / Project / Project Remote ID | Parsed and concatenated into `ParsedRow.notes`, retained for a future Updates-post feature — **not currently written to Monday** (see Known gaps in this build) |

**Anonymous rows.** Donors choose what to share; withheld fields read the literal string `Not
shared by donor` (confirmed in the verification export — not merely blank). Treat either form in
the name or email columns as *no person*: the row still produces its Donations items, with
Anonymous Donor checked and no Donor link. Roughly a third of SVBC's history is like this and
always will be. Some companies also elect to appear under an alias — that's still the Company
string, resolved through the alias table like any other.

## Splitting a row into gifts

A row can carry an employee donation, a company match, or both. Each non-zero amount becomes its
own Donations item:

| | Employee gift | Company match |
|---|---|---|
| Created when | `Total Donation to be Acknowledged` > 0 | `Match Amount` > 0 |
| Name | `<Donor> - Donation <date> (Benevity)` | `<Company> - Employer Matching <Donor or Anonymous> <date>` |
| Amount | employee amount, gross | match amount, gross |
| Date | Donation Date | Donation Date |
| Benevity Disbursement Date | block's Period Ending | block's Period Ending |
| Gift Type | `Donation` | `Matching Donation` |
| Status | `Received` | `Received` |
| Donor (connect → People) | the Person, if resolved | the Person, if resolved (the employee the match is credited to) |
| Matched By (connect → Organizations) | blank | the Organization |
| Anonymous Donor | checked if no Person | checked if no Person |
| Benevity Transaction ID | `<Transaction ID>` | `<Transaction ID>-match` |
| Fiscal Year Ending | computed from Date, SVBC's July–June year, written as the bare ending year (`2027` for a 2026-09-20 gift) — same rule and shape as `salesforce-import` and `funraise-sync` | same |

`Gift Type` and `Status` labels must be exactly these strings: `donation-rollups` counts only
`Received`, and the Matching funding stream in the revenue dashboard is `Gift Type = Matching
Donation`. Do not set Thank You Sent — Benevity, not SVBC, receipts the donor for tax purposes;
whether SVBC sends its own stewardship thank-you is a staff decision made from the board, and the
`Amount ≥ $200 → Acknowledgment Tier: Major` automation applies to these items like any other.

## Resolution

### Company → Organizations item

1. Exact, case-insensitive match on the Organizations item name.
2. `config/svbc.json` alias table, e.g. `"Google, LLC": "Google"`, `"Applied Materials
   Foundation": "Applied Materials Foundation"` (kept distinct from `Applied Materials` — the CRM
   has both as separate payers, as it does `VMware` / `VMware Foundation`).
3. Otherwise: worklist. **Never auto-create an Organization.** Staff create the Organization (or
   rename the existing one to match, or add a config alias) and set the worklist item to Retry
   (see Worklist). Alias *learning* from a worklist resolution is not built — see Known gaps.

### Employee → People item

Only attempted when the row discloses a name or email.

1. **Email**, exact after normalization, against every address the CRM knows for a person: People
   `Personal Email` and `Household Email`, and `Work Email` on the Affiliations board (the
   person↔organization model decided 2026-09-08). One hit → resolved. Several hits (a shared
   household address) → worklist, listing all candidates.
2. **Name + employer**: exact first-and-last name against People where the person's Employer text
   or an Affiliation links to the resolved Organization. Exactly one → resolved. Otherwise →
   worklist with the candidates. Of last year's matched gifts with a known donor, the CRM's email
   for the donor was a personal address about twice as often as a work one, and Benevity may hand
   over either, so this fallback fires regularly.
   Both steps count only affiliations whose `Status` is `Current` (config
   `affiliationsCurrentLabel`, column `affiliationsColumns.status`): a `Draft` is an employer
   `impact-attribution` proposed and staff haven't confirmed (#124), and a `Former` is a past job.
3. **Never auto-create a Person from a name.** Same rule as the Eventbrite name-match proposal:
   propose, staff confirm. A worklist item carries the row's disclosed fields (name, email,
   company, amount, date) so staff can fix the Person (add the email Benevity disclosed, or create
   them) and set the item to Retry (see Worklist).

Resolving a person does **not** write the employer onto their People item or create an
Affiliation — a single match is weak evidence of current employment (foundation payers, retirees'
programs, spouse matches all exist). [`impact-attribution`](../impact-attribution/README.md) proposes
a Draft Affiliation once the same company has matched a person twice within a year, for staff to confirm.

## Worklist — what staff do

Every row or block the Worker can't write lands as one item in the worklist group on the
Benevity Uploads board, its Reason column saying why and its **Retry** status column at
**Needs review**. To work one:

1. Fix the cause *in Monday*, not on the worklist item: create the missing Organization (or
   rename it to the exact Benevity company string), or add the disclosed email to the right
   Person / create the Person. A row the Worker should not import at all (a non-USD or negative
   amount) — enter it by hand if it belongs in the CRM, and leave the item at Needs review or
   delete it.
2. Set the item's **Retry** column to **Retry**. Within a few seconds the Worker sets it to
   **Queued** and re-runs that row.
3. The item then moves to **Done** (the Donations items were written) or back to **Needs
   review** with a new Reason (it still can't resolve — fix that and Retry again).

A **block** item ("Disbursement …", reason about totals) held back every row of that
disbursement because the file's row sum didn't match its reported total. Check the report; if the
rows are right, set Retry: every held-back row of the block is released at once, and any that
can't resolve get their own row items. The block item itself stays at Queued. A block whose
*header* failed has no parsed rows — Retry does nothing for it; fix the file and upload it again
as a new file.

A block item whose reason starts **"Skipped, not imported"** is a disbursement the cutoff
(`minDisbursementDate`, see Idempotency) left out because its Period Ending is before it. The
reason gives its row count, donation-date range and gross total. Nothing is wrong if staff
already keyed that disbursement into Salesforce — leave the item, or delete it. If it was
**never** keyed into Salesforce, it is missing from the CRM: set Retry, and every row of it is
imported like any other. Only do that when you're sure — the migrated history has no Transaction
IDs, so importing a disbursement that *was* keyed double-counts it. If only some of its rows
were keyed, don't Retry (it imports every row): enter the missing gifts by hand.

A Retry the Worker can't carry out puts the item back to **Needs review** with the reason in
its Reason column instead of leaving it at Retry. The main case: a row's Benevity details are
deleted `unresolvedRowRetentionDays` (365) days after import (see PII), so a row left on the
worklist that long can no longer be re-run — enter that gift by hand from the report.

Retry is safe to repeat: a row already written isn't re-run (the item just goes to Done), and a
duplicate Retry doesn't create duplicate Donations items. **Re-uploading the same report is not
a retry** — rows and disbursements the Worker has already seen are skipped, so only new rows in
the file are imported.

## Dead letters

A gift whose Monday write keeps failing is retried for about four days (`max_retries: 100`,
backing off to an hour), then dead-lettered to `benevity-import-writes-dlq`
(`benevity-import-writes-sandbox-dlq` in sandbox). This Worker consumes both (#60,
`src/consumer/deadLetters.ts`), so a dead gift is never silently lost — which matters here more
than elsewhere, because re-uploading the report is a no-op for a row already recorded. Each dead
message:

* marks its row `needs-review`, with `dead-lettered after retries: ` in front of the last error
  the consumer recorded (never doubled) — in D1 first, so it's on record even while Monday is
  the thing that's down;
* raises a worklist item for it, reason **"Couldn't write this gift to Monday…"** with the last
  error, at **Needs review** (a row replayed from the worklist that died again reuses its item).
  Staff fix the cause and set **Retry**, exactly as for any other worklist item;
* leaves a row that is no longer `ingested` (written, held for review, or skipped since the
  message was sent) alone, and acks a body with no Transaction ID;
* always acks. Only a D1 failure retries the dead message (60 s, at most `max_retries: 2`, no
  further DLQ).

Posting the worklist item is a Monday write, so it happens only while writes are `on`, and a
failed post is logged rather than retried. The **daily cron** (after the `raw_row` purge, and
only under `on`) posts the item for every dead-lettered row still missing one, 25 a run — so a
gift that dead-letters during a Monday outage or a `hold` reaches the worklist once both are
over. Each batch that marked anything logs **one** `console.error` naming the Transaction IDs.

The same queue carries uploaded reports waiting to be ingested (#74), so a report can dead-letter
too: its asset kept failing to fetch, or a block kept failing in D1. There is no row to mark or
item to Retry, so the consumer marks the upload `error` (unless it has since finished) and logs a
`console.error` naming the Monday asset. Rows from blocks it did finish are already queued on
their own. Fix the cause, then upload the same file again: the new asset resumes from the
disbursements and rows already recorded.

To find dead-lettered rows directly:

```sh
npx wrangler d1 execute svbc-benevity-import --remote --command \
  "SELECT transaction_id, worklist_item_id, error FROM rows WHERE error LIKE 'dead-lettered after retries: %'"
```

## Idempotency and the migrated history

Three D1 tables, reflecting file → disbursement-block → row now that a single upload can bundle
several disbursements:

* **`uploads`** — one row per Monday file asset: id, Monday asset id, uploaded-at, status
  (`parsing` / `parsed` / `error`), block count.
* **`disbursements`** — one row per Benevity disbursement: id, upload id (FK, the upload that
  first produced it) and block position within it, Benevity's own `Disbursement ID`, `Period
  Ending`, disbursement-level currency, row count, and the trailer's reported gross/net totals.
  `Disbursement ID` is unique (migration `0002`, a partial index that exempts the empty id of a
  block whose header didn't parse): the same report re-uploaded as a new file, or bundled into a
  later download, finds its existing row — and its existing worklist item — instead of adding a
  second one. The consumer looks a block up by (upload, position) first, so a retried upload
  resumes its own blocks, then by `Disbursement ID`, and inserts only on a miss. On
  parse, the sum of the block's own rows is checked against its own reported gross total; a
  mismatch marks the whole block `needs-review` rather than writing partial data from a block the
  parser may have mis-split.
* **`rows`** — one row per data row across all blocks/files: Transaction ID (the true idempotency
  key — global, not scoped to a file or block, so the same gift arriving in two overlapping
  uploads is still one row), disbursement id (FK), status (`ingested` / `written` / `needs-review`
  / `skipped`), Monday item ids (employee gift and/or match), raw row.
* Every Donations item this Worker creates carries `Benevity Transaction ID`; the consumer looks
  it up before creating, so a retry after a lost status update adopts the existing item.
* Worklist items follow the same rule (#34): D1 records each one's Monday item id (`rows` and
  `disbursements` `worklist_item_id`, migration `0003`) in the same write that marks the row or
  block needs-review, and the item carries its key in the worklist `Key` column, looked up before
  creating — so a retry after that write is lost adopts the item it already posted.
* **The migrated history has no Transaction IDs** — Salesforce never stored them — so the ledger
  can't tell a Benevity row the import already carried from a new one. Config
  `benevityImport.minDisbursementDate` is the cutoff: a disbursement whose **Period Ending** is
  before it is skipped whole (its rows recorded `skipped`, nothing written), on the assumption
  that staff keyed it into Salesforce and it was migrated. **Set it to the data freeze date.**
  Staff can only key a disbursement that has already been paid out, so every disbursement keyed
  before the freeze has a Period Ending before it, and none can be imported twice. Erring later
  is the safe direction: a cutoff that is too late skips a disbursement nobody keyed, and that
  shows up on the worklist (below) to be checked and retried; a cutoff that is too early imports
  one that was keyed, and that double-count is silent. Expect one or two skipped disbursements
  around the freeze; check each against the migrated Donations (Matched By, dates, amounts)
  before setting Retry.
  The gate is deliberately *not* a row's Donation Date (#40): Benevity pays out weeks after the
  gift, so the first disbursement after the freeze is mostly rows dated before it, and none of
  those were ever keyed (staff key from the disbursement report, which didn't exist yet). Within
  an imported disbursement every row is written whatever its date; the per-row Transaction ID
  lookup above is the duplicate guard.
  A skipped disbursement is never silent: it gets one worklist item saying it was skipped, its
  Period Ending and the cutoff, its row count, donation-date range and gross total — and setting
  that item to Retry imports it anyway (see Worklist). Do not backfill history through this
  Worker beyond that deliberate, per-disbursement override.
* Rows with `Currency ≠ USD`, negative amounts (refund/clawback lines, if Benevity ever emits
  them), or a header that fails validation → `needs-review`, never silently dropped.

## Resetting for new board ids

When the Donations, People and Organizations boards are deleted and rebuilt (a cutover retry —
private runbook, Rollback step 8 — or a sandbox rebuild), D1 still says which rows are
`written`, so a report uploaded again is skipped even though its gifts went with the old
boards. Reset D1 before deploying against the new boards, with the Uploads-board webhooks off.

```sh
# 1. Export, to somewhere outside the repo — raw rows hold donor names and addresses. The
#    database is unavailable while the export runs (seconds).
npx wrangler d1 export svbc-benevity-import --remote --output <dir>/svbc-benevity-import.sql

# 2. Reset, in this order: rows → disbursements → uploads are foreign keys, and D1 enforces
#    them. -y answers any wrangler confirmation prompt; unanswered without a TTY, one cancels
#    silently with exit 0.
npx wrangler d1 execute svbc-benevity-import --remote -y --command \
  "DELETE FROM rows; DELETE FROM disbursements; DELETE FROM uploads; DELETE FROM aliases;"

# 3. Check: every count is 0.
npx wrangler d1 execute svbc-benevity-import --remote --command \
  "SELECT 'rows' AS t, COUNT(*) AS n FROM rows UNION ALL SELECT 'disbursements', COUNT(*) FROM disbursements UNION ALL SELECT 'uploads', COUNT(*) FROM uploads UNION ALL SELECT 'aliases', COUNT(*) FROM aliases"
```

Sandbox: `svbc-benevity-import-sandbox`, with `--env sandbox` on every command.

| Table | Reset | Why |
|---|---|---|
| `rows` | cleared | Donations and worklist item ids on the old boards, and the `written` status that would make a re-upload skip the row. |
| `disbursements`, `uploads` | cleared | So the same report can be uploaded again and is parsed as new; their worklist item ids are dead too if the Uploads board was rebuilt. |
| `aliases` | cleared | Organizations item ids on the old board. (Nothing writes this table yet, so it's normally empty.) |

Nothing is kept, so afterwards the Worker no longer knows what it imported. Before go-live the
only rows are the verification upload's. If a real disbursement was imported against the old
boards, it must reach the new ones exactly once: either staff key it into Salesforce before the
retry's extract (then set `minDisbursementDate` past its Period Ending), or it is uploaded again
after the retry — never both, since migrated gifts carry no Transaction ID to dedupe on. Set
`minDisbursementDate` for the retry's freeze either way. If the Uploads board survived, delete
its leftover worklist items; their Retry no longer finds a row.

Tested 2026-09-30: on a local D1 built from the sandbox database's export, with seeded rows
(`DELETE FROM uploads` first fails on the foreign key; the order above clears all four), and
on the deployed sandbox D1, whose tables were already empty.

## PII

Benevity rows include the donor's postal address when shared. Do **not** write it to Monday from
here (People addresses come from the import and the donor portal), and purge `raw_row` from D1 on
the same retention schedule `funraise-sync` uses (`rawRowRetentionDays`, default 90, for written
rows; `unresolvedRowRetentionDays`, default 365, for the rest). The worklist item shows name,
email, company, amount, and date only.

## Monday targets

All ids in `config/sandbox.json` (the CRM Sandbox) or `config/svbc.json` (production,
placeholders until cutover), validated at first request, none hardcoded:

| Board / column | Purpose |
|---|---|
| Donations board | writes |
| Donations: Donor (connect → People), Matched By (connect → Organizations), Amount, Date, Benevity Disbursement Date, Fiscal Year Ending, Status, Gift Type, Anonymous Donor, Benevity Transaction ID | columns written |
| People board: Personal Email, Household Email, Employer | person resolution |
| Affiliations board: Person, Organization, Work Email | person resolution |
| Organizations board: name | company resolution |
| Benevity Uploads board: file column, worklist group | trigger + worklist |
| Benevity Uploads board: worklist **Retry** status column (`uploadsBoard.retry`), labels `Needs review` / `Retry` / `Queued` / `Done` (all four must exist on the column; names configurable) | staff replay trigger — see Worklist; its own Monday webhook to `/webhooks/monday/benevity-retry`; `null` until provisioned (the route then ignores every event) |
| Benevity Uploads board: worklist `Key` text column (`uploadsBoard.worklistKeyColumn`) | each worklist item's stable key — the row's Transaction ID, or `disbursement <id>` for a block — looked up before posting so a retried write adopts the item instead of posting a second one; `null` until provisioned (the lookup is then skipped) |

Monday access comes from the `monday-auth` broker, not a stored token. Both deployments bind
`MONDAY_AUTH` (`wrangler.jsonc` `services`) to its `SyncToken` entrypoint — the *SVBC Staff Sync*
OAuth app — production (`svbc-benevity-import`) to `svbc-monday-auth`, sandbox (`--env sandbox`) to
`svbc-monday-auth-sandbox`; `src/monday/graphql.ts` `tokenProviderFor` asks it per request and
re-asks once on a 401. A `MONDAY_API_TOKEN` secret is only the fallback while the cutover is under
way (delete it once the binding works); with neither, building the Monday client throws a config
error naming both. Operator scripts (`scripts/*.mjs`) keep reading `MONDAY_API_TOKEN` from the
operator's shell. Local `wrangler dev` has no broker to call, so put a `MONDAY_API_TOKEN` in
`.dev.vars` for it. Design: `docs/superpowers/specs/2026-10-30-monday-oauth-broker-design.md`.

## Sandbox environment — inbound only, no outbound data

`npm run deploy:sandbox` deploys `svbc-benevity-import-sandbox` (`wrangler.jsonc` `env.sandbox`)
against the CRM Sandbox boards in `config/sandbox.json`, chosen at request time by the
`ENVIRONMENT` var (`src/environment.ts`); `config/svbc.json` is production and holds
placeholders until cutover. Own D1, queue (`benevity-import-writes-sandbox` and its `-dlq`), no cron (disabled to save cost),
and secrets (`wrangler secret put … --env sandbox`). Local development against the sandbox uses `npm run dev:sandbox`; `npm run dev` targets the production config and, once production secrets exist in `.dev.vars`, would write to production sinks. This Worker writes only to Monday, so the
split exists so the two deployments can coexist. `config/split.test.ts` fails if any of the
sandbox column ids appears in `config/svbc.json`. The Benevity Uploads board webhook must point at
the sandbox Worker's `/webhooks/monday/benevity-upload` route (see "Data flow") with the sandbox
`BENEVITY_WEBHOOK_SECRET`. The worklist Retry column needs a second webhook, same shape
(`change_specific_column_value`, `config: {"columnId": "<retry column id>"}`), pointing at
`/webhooks/monday/benevity-retry?secret=<BENEVITY_WEBHOOK_SECRET>`. Provisioned on the sandbox
board 2026-10-19: Retry status column `color_mm89sfqw` (labels Needs review / Retry / Queued /
Done), Key text column `text_mm892fps`, and the Retry webhook `655429553`; all three are wired
into `config/sandbox.json`.

Both routes authenticate with `?secret=<BENEVITY_WEBHOOK_SECRET>` because Monday can't send a
custom header. That is an accepted trade-off: the full request URL, secret included, is recorded
in this Worker's Workers Logs invocation records, readable by anyone with dashboard log access to
it. Keep that access limited to people who could read the secret anyway, never log `c.req.url`
here, and rotate the secret (new `wrangler secret put`, then delete and re-register **both**
Monday webhooks with the new URL) if logs are ever shared. See the root README's "Webhook
secrets in the URL" for who holds log access.

Provisioned and verified 2026-09-19: D1 `svbc-benevity-import-sandbox` (id in `wrangler.jsonc`),
both queues, both secrets, and Monday webhook `639785248` on the sandbox Uploads board. Register
that webhook as `change_specific_column_value` with `config: {"columnId": "<file column id>"}` —
Monday rejects `change_column_value` with a column config ("This event doesn't support config"),
and an unscoped subscription fires on every column edit. A synthetic one-row CSV (one $25 gift
plus a $25 match) produced the expected two Donations items — Anonymous Donor checked, Matched
By linked to the company, Gift Type and Fiscal Year Ending as text — and was then deleted along
with its D1 rows, so the sandbox tables start empty. That first upload also surfaced a real bug:
the gift splitter sent `{label}`/`{date}` objects to the two text columns and Monday rejected
every create (fixed in the same branch, `giftSplit.ts`).

**Remapped and re-verified 2026-09-30 on the `(sandbox v3)` boards.** The v2 Donations,
Organizations and Affiliations boards were deleted when v3 went up on 2026-09-20, so from then
until this remap an upload could not resolve a company or write a gift. `config/sandbox.json` now
targets Donations `18437342657`, Organizations `18437342579`, Affiliations `18437342615` and
People `18437342592`, with every column id read by title from the live schemas. The Uploads
board (`18431270204`, still titled "(sandbox v2)") and its webhook `639785248` were not rebuilt
and needed nothing. **Rebuilt 2026-10-09:** that v2 Uploads board was later deleted, so
`config/sandbox.json` now targets `Benevity Uploads (sandbox v3)` (`18439574423`; file column
`Report`, `Review` group, worklist columns Reason / Email / Company / Amount / Date).
`uploadsBoard.retry` and `worklistKeyColumn` were still `null` then (provisioned 2026-10-19, see Sandbox environment). **Webhook `639785248` went with the
old board**. **Re-registered 2026-10-15:** webhook `654180110` (`change_specific_column_value` on
file column `file_mm7z4ax3`) on the new board, with a freshly generated sandbox
`BENEVITY_WEBHOOK_SECRET` (Cloudflare secrets can't be read back, so the old one was replaced); no
test file has been sent through it yet. Still to do before the next upload: clear the D1 `uploads`
and `rows` worklist ids (see the reset table above).
Two things the 2026-09-30 rebuild did not carry over:

* **Donations (sandbox v3) had no `Benevity Disbursement Date` column.** Nothing in
  `salesforce-import` creates it, so it was added to the board by hand (`date_mm90rrgv`). Every
  rebuild, and production at cutover, needs it before the first upload: this Worker writes it on
  every gift, and Monday rejects a create that names a column the board doesn't have.
* **The deployed Worker.** Merging does not deploy the sandbox; `npm run deploy:sandbox` was run
  by hand after the remap.

Then the same check as 2026-09-19: a synthetic one-row CSV (company `Google, LLC`, donor
withheld, a $25 gift plus a $25 match, donation date 2026-09-20, period ending 2026-09-30)
attached to a new item on the Uploads board. The webhook fired, the file parsed into one
disbursement and one row, and 11 s later the consumer had written two items on Donations
(sandbox v3): `Anonymous - Donation 2026-09-20 (Benevity)` and `Google, LLC - Employer Matching
Anonymous 2026-09-20`, each with Amount 25, Date 2026-09-20, Benevity Disbursement Date
2026-09-30, Status Received, Anonymous Donor checked, no Donor link, Gift Type `Donation` /
`Matching Donation`, Benevity Transaction ID `…A` / `…A-match`, and Matched By → Google, LLC on
the match only. The two Donations items, the upload item and the three D1 rows were deleted
afterwards, so the sandbox tables are empty again. The whole check was then repeated, with the
same result, on a second deploy that also carries #40 (the gate on a disbursement's Period
Ending), which merged to `main` the same evening. One thing the check showed that is not part of
the remap: Fiscal Year Ending is written as `2027-06-30`, where `salesforce-import` and
`funraise-sync` write the bare year `2027`. `donation-rollups` falls back to deriving the year
from Date, so totals are unaffected, but the column is inconsistent for board filters.

Design: `../docs/superpowers/specs/2026-09-18-sandbox-environment-design.md`.

**Workers Builds:** connect a second Worker, `svbc-benevity-import-sandbox`, to this repo with
root directory `/benevity-import`, production branch `main`, and deploy command
`npx wrangler deploy --env sandbox`. The sandbox then tracks `main` alongside production. If the
dashboard refuses two connections on one root directory, fall back to the
`deploy-sandbox:benevity-import` job in `../.gitlab-ci.yml` — same command, gated on a
`CLOUDFLARE_API_TOKEN` CI variable so it stays inert until that variable is set.

## Deploying: the write switch

Every Monday write (worklist items and labels, Donations and the archive of a duplicate item) and
every row-status write is gated by the shared write switch (spec
`../docs/superpowers/specs/2026-10-26-write-switch-design.md`, module `src/flags.ts`, a
byte-identical copy of `member-portal/src/flags.ts`), read from the `FLAGS` KV namespace
(`wrangler.jsonc`; the ids are placeholders until the namespaces exist):

- `benevity-import:writes` — `on` writes normally; `hold` writes nothing; `off` writes nothing
  and logs one `"writeSwitch":"skipped"` line per would-be Monday write. **A missing key means
  `off`**, and a KV read error means hold.
- `benevity-import:log` — `debug` adds redacted payloads to those lines.

Unlike the other migration Workers, **the retry route writes to Monday itself**, so the switch
covers both webhook routes directly (the subscribe challenge is always echoed):

- `hold`/`unknown`: `/webhooks/monday/benevity-upload` and `/webhooks/monday/benevity-retry` answer
  **503** before any D1 or Monday call, so Monday redelivers once writes are back on.
- `off`: the upload route still records the upload and enqueues it, stamped `dropped`. The retry
  route logs a skip and returns 200 (the item stays at Retry).
- Queue consumer, ingesting an upload under `off` (or one stamped `dropped`, even if the mode is
  `on` by then): it still records disbursements and rows (so a re-upload isn't mistaken for new)
  and enqueues each row, stamped `dropped`; its worklist `createItem` / label changes / archive are
  logged, not made, and the worklist item id is not saved.
- Queue consumer, writing a row: `off` (or a `dropped` stamp) logs the Monday
  writes and skips `updateStatus` / `requeue*` / `claimWorklistItemId`; `hold` retries at 1 minute
  doubling to an hour (`max_retries` is 100, about four days). A message queued before this
  build has no stamp and is written under `on`. The daily `raw_row` purge is D1-only and runs in
  every mode.
- Dead-letter consumer: marks the row in D1 in every mode (a record of what happened, not a
  Monday write); posts its worklist item only under `on`. The daily dead-letter sweep runs only
  under `on`. See Dead letters.

Set it with the operator CLI at the repo root, never by hand:

```sh
node scripts/flags.mjs benevity-import writes on --env sandbox     # or --env production
```

**Set `writes on` before deploying** a build that carries the switch, or the deployed Worker
dry-runs everything.

**Reports uploaded while the switch was `off` are not written later by themselves** (spec: work
ingested under `off` stays a dry run). Their rows sit in D1 at `ingested`, never sent again, and
any block worklist item was never posted. To import one once writes are `on`, upload the same
report file again — as a new file on the Uploads board, since a redelivery of the original asset
is a no-op. The consumer finds the disbursement it already recorded, re-sends every row still at
`ingested` (unstamped, so it is written), and posts the block's worklist item if it needs one; a
held-back block is then released with Retry as usual. Retry alone can't do it: no worklist item
exists to set. Covered by `src/integration.test.ts` ("re-uploading a report ingested under off").

## Related changes elsewhere

* **Donations board:** provision a new `Benevity Disbursement Date` column before this Worker's
  first write. Unlike `Matched By`/`Benevity Transaction ID` below, this one needs no historical
  backfill — only this Worker ever writes it. `salesforce-import` does not create it, so a
  rebuilt board comes up without it: the sandbox v3 rebuild did (re-added by hand 2026-09-30),
  and the production boards will at cutover.
* **`salesforce-import`, before cutover — built 2026-09-08 on `feat/si-benevity-columns`:** add
  `Matched By` and `Benevity Transaction ID` to the Donations board definition; fill `Matched By`
  from `AccountId` whenever `RecordType.Name = 'Matching Donation'` (today the Donor link takes the
  Primary Contact and the paying company is dropped for the 2,182 matched gifts that have one);
  map Opportunities whose Primary Contact is the placeholder Contact "Anonymous Person" to
  Anonymous Donor = checked with **no** Donor link instead of linking a Person by that name (235
  gifts). That branch also fixes `Employer Name` on People, which read the empty 360MatchPro
  lookup instead of `Employer__c` — the name-plus-employer fallback above depends on it.
* **`donation-rollups`:** decide whether a `Matching Donation` linked to a Person counts toward
  that person's Lifetime Giving. Salesforce's rollups counted it (the employee was Primary
  Contact), so the import's validated totals include matches; keep that unless staff want a
  separate "Matched giving" figure. Organizational Giving under the affiliation model should
  count `Matched By` items for the company.
* **Staff process guide (`docs/06`, private repo):** the Donations section gains "Benevity
  disbursements: drop the report on the Benevity Uploads board; work the review group" once this
  ships.

## Known gaps in this build

Two places where the spec above describes more than what shipped:

* **Alias learning has no caller.** `db/aliases.ts`'s `learnAlias` exists and is tested, and
  Company → Organizations resolution reads from the alias table it feeds — but nothing in the
  shipped pipeline ever *writes* to it: the worklist Retry (see Worklist) re-runs a row after
  staff fix the Organization, but doesn't learn "this Company string means that Organization"
  from it. Teaching an alias means a `config/*.json` `organizationAliases` entry or a manual D1
  `aliases` table insert.
* **Comment/Reason/Source/Activity/Project fields are parsed but never posted anywhere.** See the
  Input format table above, corrected to say so — `ParsedRow.notes` carries the concatenated text
  through parsing and is retained for a future Updates-post feature, but nothing in this build
  writes it to Monday.

## Open questions

1. **Report delivery.** Ask Benevity support whether disbursement reports can be emailed as
   attachments or pulled by SFTP. Either removes the manual download; neither is required.
2. ~~Exact column names and preamble shape~~ — resolved 2026-09-15 against a real export; see
   Input format.
3. **Gross vs net.** The CRM records the gross gift (what the donor gave and is acknowledged
   for); fees are finance's concern in QuickBooks. Confirm that matches how finance reconciles
   Benevity deposits today, so the CRM and the books agree on the same number per gift.
4. **Who is the Donor on a match** — this README says the employee (matches Salesforce, keeps
   rollups stable), with the company in Matched By. If staff would rather see the company as the
   Donor and the employee as a secondary link, that's a config-level swap, but decide before the
   import fills the column.

## Sources

* Plan section: Benevity (Integrations) — `migration-plan.md` (private planning repo), with the
  live Salesforce counts behind the numbers above (queried 2026-09-08).
* [Benevity for Nonprofits](https://benevity.com/nonprofits)
* [Benevity API documentation](https://developer.benevity.org/) — corporate-client API, no cause-side endpoints
* [Where do I find my reports? — Benevity Causes help](https://causeshelp.benevity.org/hc/en-us/articles/115003003423-Where-do-I-find-my-reports)
* [Understanding donor reports — Benevity Causes help](https://causeshelp.benevity.org/hc/en-us/articles/360056082831-Understanding-donor-reports)
* [How can I find the donor and company information on my report? — Benevity Causes help](https://causeshelp.benevity.org/hc/en-us/articles/360056954871-How-can-I-find-the-donor-and-company-information-on-my-report)
* [New Causes Portal experience — Benevity Causes help](https://causeshelp.benevity.org/hc/en-us/articles/47976276289684-New-Introducing-the-New-Causes-Portal-Experience)
* `../funraise-sync/README.md` — the webhook → D1 → Queue shape and donor-matching conventions this Worker reuses
