# benevity-import

[Appendix A](../reference/benevity-import.md) lists this Worker's routes, crons, queues, storage and bindings.

Deployed as `svbc-benevity-import` (production) and `svbc-benevity-import-sandbox` (sandbox). It
has no custom hostname: Monday calls it on its `*.workers.dev` URL. It gets Monday access from the
`monday-auth` broker's `SyncToken` entrypoint (the Staff sync OAuth app).

## What it does

Employer matching gifts arrive through Benevity, which pays SVBC in disbursements and publishes a
CSV report for each one. Staff drop that report on the **Benevity Uploads** board. This Worker
turns each row into Donations items (an employee gift and/or a company match), linked to the
paying Organization and, when Benevity disclosed it, the employee in People. Anything it can't
resolve goes on a worklist instead of being guessed. If it stops, matching gifts must be keyed by
hand again.

## Trigger and data flow

Two Monday webhooks, a queue with a dead-letter queue, and a daily cron.

| Trigger | What it does |
|---|---|
| `POST /webhooks/monday/benevity-upload?secret=…` | Monday `change_specific_column_value` webhook on the Uploads board's file column |
| `POST /webhooks/monday/benevity-retry?secret=…` | Monday `change_specific_column_value` webhook on the worklist **Retry** status column |
| `GET /health` | Liveness check |
| Queue `benevity-import-writes` | Ingests uploads and writes rows |
| Queue `benevity-import-writes-dlq` | Consumed by this Worker; turns dead gifts into worklist items |
| Cron `15 9 * * *` (production only) | Purges raw rows from D1, then (writes `on` only) posts worklist items for dead-lettered rows, 25 per run |

Flow for one upload:

1. A staff member attaches the Benevity report to an item on the Benevity Uploads board.
2. The upload route records the upload in D1 `uploads` and enqueues one message. It does not fetch
   or parse in the request.
3. The consumer fetches the file through Monday's `assets` query. Files over 2 MB are refused and
   the upload is marked `error`.
4. The file is split into one or more disbursement blocks (a download can bundle several). Each
   block is validated on its own header and on its trailer total against the sum of its rows, and
   stored in D1 `disbursements`.
5. Rows are upserted into D1 `rows`, keyed on Benevity Transaction ID. The key is global, so the
   same gift in two overlapping files is one row. One queue message is sent per row not yet written.
6. Per row: resolve the company to an Organization (exact name, then config aliases), resolve the
   employee to a Person (email, then name plus Current employer affiliation), split into gift and
   match, write the Donations items. Each item is stamped with its Transaction ID before the row is
   marked `written`.
7. Unresolved company, ambiguous person, non-USD currency, negative amount or a failed block total
   → no write; a worklist item is posted on the Uploads board with a Reason, and the row goes to
   `needs-review`.
8. Staff fix the cause in Monday and set the item's Retry column to **Retry**. The retry route
   re-enqueues the row (or every held-back row of a block) and sets the item to **Queued**. The
   consumer then sets it to **Done**, or back to **Needs review** with a new Reason.

Before creating a Donations item the consumer searches for the Transaction ID, so a retry after a
lost status update adopts the existing item rather than creating a duplicate. Worklist items work
the same way through the worklist `Key` column.

Disbursements whose **Period Ending** is before `benevityImport.minDisbursementDate` are skipped
whole, because migrated Salesforce history has no Transaction IDs. Each skipped disbursement still
gets a worklist item ("Skipped, not imported") with its row count, date range and total. Setting
Retry on it imports it anyway; only do that if staff never keyed it into Salesforce.

## Monday boards and columns

Board and column ids live in `config/svbc.json` (production) and `config/sandbox.json`, validated
on the first request.

| Board | Columns | Access |
|---|---|---|
| Donations | Donor, Matched By, Amount, Date, Benevity Disbursement Date, Fiscal Year Ending, Status, Gift Type, Anonymous Donor, Benevity Transaction ID | Write (and read Transaction ID) |
| People | Personal Email, Household Email, Employer | Read |
| Affiliations | Person, Organization, Work Email, Status | Read (only `Current` counts) |
| Organizations | Name | Read |
| Benevity Uploads | File column; worklist group; Reason, Email, Company, Amount, Date, Key; Retry status | Read file; write worklist |

Labels the Worker depends on, which must exist exactly:

- Donations **Status** `Received`; **Gift Type** `Donation` / `Matching Donation`.
- Uploads **Retry**: `Needs review`, `Retry`, `Queued`, `Done` (names configurable in
  `uploadsBoard.retry.labels`).

Fiscal Year Ending is written as the bare ending year (`2027` for a 2026-09-20 gift), the same
shape `funraise-sync` and `salesforce-import` use. The Benevity Disbursement Date column is not
created by `salesforce-import`; a rebuilt Donations board needs it added by hand before the first
upload, or every create fails.

## Secrets

| Name | Purpose | Issued by | Rotate |
|---|---|---|---|
| `BENEVITY_WEBHOOK_SECRET` | `?secret=` on both Monday webhook URLs; routes return 401 without it | Generated by the operator (any random string) | `wrangler secret put BENEVITY_WEBHOOK_SECRET` (add `--env sandbox` for sandbox), then delete and re-register **both** Monday webhooks with the new URL |
| `MONDAY_API_TOKEN` (optional) | Fallback Monday token from the OAuth cutover; the `MONDAY_AUTH` binding is preferred | Monday (SVBC Integration user) | Delete once the binding is confirmed working. Don't add new uses. See [accounts and access](../03-accounts-and-access.md) |

The secret appears in Workers Logs request URLs. Keep log access limited, and rotate if logs are
ever shared (root README, "Webhook secrets in the URL").

## Write switch

Key `benevity-import:writes`. Unlike most queue Workers, the retry route writes to Monday itself,
so the switch gates both webhook routes. The subscribe challenge is always answered.

| Mode | Behavior |
|---|---|
| `on` | Normal. |
| `hold` / `unknown` | Both webhook routes return **503** before any D1 or Monday call, so Monday redelivers later. Queued row writes retry with backoff. The dead-letter sweep doesn't run. |
| `off` | Upload route still records the upload and enqueues it stamped `dropped`. The consumer records disbursements and rows but makes no Monday write (logged as `"writeSwitch":"skipped"`). Retry route logs a skip and returns 200; the item stays at Retry. |

The daily raw-row purge is D1-only and runs in every mode. The dead-letter consumer marks rows in
D1 in every mode but posts worklist items only under `on`.

**A report uploaded under `off` is not written later on its own.** Its rows stay `ingested`. Once
writes are `on`, upload the same file again as a new file on the Uploads board; the consumer finds
the recorded disbursement and re-sends every row still at `ingested`.

See [Operations](../07-operations.md) for the switch itself.

## Failure modes

| Symptom | Cause | What to do |
|---|---|---|
| Upload item does nothing; Worker logs 401 | Webhook URL secret doesn't match `BENEVITY_WEBHOOK_SECRET` | Re-register the webhook with the current secret, or rotate (see Secrets) |
| Upload ignored after webhook rebuild | Webhook registered as `change_column_value` with a column config (Monday rejects it) or unscoped | Register `change_specific_column_value` with `config: {"columnId": "<file column id>"}` |
| Every Donations create rejected | A column in config is missing on the board, often Benevity Disbursement Date after a rebuild | Add the column, update config, redeploy |
| Worklist item: company didn't resolve | Benevity company string doesn't match an Organization name or alias | Create or rename the Organization, or add an `organizationAliases` entry in config; then set Retry |
| Worklist item lists several candidate people | Shared household email, or ambiguous name + employer | Fix the Person in Monday (add the disclosed email), then Retry |
| Block item about totals; no rows written | Row sum didn't match the block's reported gross total | Check the report. If the rows are right, set Retry; all held rows are released |
| Block whose header failed | File malformed | Retry does nothing. Fix the file and upload it as a new file |
| Retry puts item back to Needs review, reason about retention | Row's raw data was purged after `unresolvedRowRetentionDays` (365) | Enter the gift by hand from the report |
| Worklist item "Couldn't write this gift to Monday…" | Row dead-lettered after about four days of failed writes | Fix the cause (often a Monday outage or a bad column), then Retry |
| Upload marked `error`, `console.error` names the asset | File over 2 MB, or the asset fetch or a D1 block write kept failing (upload dead-lettered) | Fix the cause, upload the same file again; it resumes from what's recorded |
| Re-uploading a report imports nothing | Expected. Rows already seen are skipped; re-upload is not a retry | Use the worklist Retry column |
| Nothing happens under `hold`; Monday shows failed deliveries | 503 by design | Set writes `on`; Monday redelivers |
| Retry column change ignored | `uploadsBoard.retry` is `null` in config, or the Retry webhook isn't registered | Provision the column and webhook, update config |
| Gifts uploaded again after boards were rebuilt are skipped | D1 still marks them `written` against the old boards | Reset D1 (see Operator scripts) |

To list dead-lettered rows:

```sh
npx wrangler d1 execute svbc-benevity-import --remote --command \
  "SELECT transaction_id, worklist_item_id, error FROM rows WHERE error LIKE 'dead-lettered after retries: %'"
```

## Operator scripts

The Worker has no `scripts/` directory. Operator actions are Wrangler and the repo-root CLIs:

- Set the write switch:
  `node scripts/flags.mjs benevity-import writes on --env production` (or `--env sandbox`).
- **Reset D1 after the Donations, People or Organizations boards are rebuilt** (webhooks off
  first). Export first to a directory outside the repo, since raw rows hold donor PII:

  ```sh
  npx wrangler d1 export svbc-benevity-import --remote --output <dir>/svbc-benevity-import.sql
  npx wrangler d1 execute svbc-benevity-import --remote -y --command \
    "DELETE FROM rows; DELETE FROM disbursements; DELETE FROM uploads; DELETE FROM aliases;"
  ```

  Delete in that order (foreign keys). For the sandbox, use `svbc-benevity-import-sandbox` and add
  `--env sandbox`. Afterwards the Worker no longer knows what it imported, so set
  `minDisbursementDate` to the new data freeze date and make sure no disbursement is both keyed by
  hand and uploaded.

## Changing it

Key files:

- `src/webhook/route.ts`: both webhook routes, secret check, write-switch gate.
- `src/consumer/ingestUpload.ts`, `src/parse/`: fetch, size cap, block splitting, CSV parsing.
- `src/consumer/processBatch.ts`, `src/matching/`, `src/mapping/giftSplit.ts`: resolution and the
  Donations write.
- `src/consumer/deadLetters.ts`: DLQ consumer and daily sweep.
- `src/config.ts`: config validation. `config/split.test.ts` fails if sandbox and production share
  an id.
- `migrations/`: D1 schema (`uploads`, `disbursements`, `rows`, `aliases`).

Gotchas:

- `src/flags.ts`, `src/monday/graphql.ts` and `src/monday/outage.ts` are byte-identical copies.
  Edit the canonical file and copy it over (see [Development](../05-development.md)).
- Alias learning is not wired up: `learnAlias` exists but nothing calls it. Teach an alias through
  `organizationAliases` in config or a manual insert into D1 `aliases`.
- The Comment, Reason, Source, Activity and Project fields are parsed into `ParsedRow.notes` but
  never written to Monday.
- Never write a donor's postal address to Monday from this Worker.

Test and deploy from `benevity-import/`:

```sh
npm test
npm run typecheck
npm run deploy             # production
npm run deploy:sandbox     # sandbox
npx wrangler d1 migrations apply svbc-benevity-import --remote
npx wrangler d1 migrations apply svbc-benevity-import-sandbox --remote --env sandbox
```

Local development against the sandbox config is `npm run dev:sandbox`; plain `npm run dev` uses
production config. Local dev has no broker, so put a `MONDAY_API_TOKEN` in `.dev.vars`. See
[CI and deploy](../06-ci-and-deploy.md).

## Further reading

- [benevity-import/README.md](../../../benevity-import/README.md): input format, gift splitting,
  resolution rules, idempotency and the migrated-history cutoff in full.
- [Staff UAT script](../../../docs/uat/benevity-import.md)
- [Write switch design](../../../docs/superpowers/specs/2026-10-26-write-switch-design.md)
- [Sandbox environment design](../../../docs/superpowers/specs/2026-09-18-sandbox-environment-design.md)
- [Monday OAuth broker design](../../../docs/superpowers/specs/2026-10-30-monday-oauth-broker-design.md)
- [Migration hold runbook](../../../docs/runbooks/migration-hold.md)
- Core chapters: [Architecture](../02-architecture.md), [Operations](../07-operations.md),
  [Troubleshooting](../08-troubleshooting.md)
