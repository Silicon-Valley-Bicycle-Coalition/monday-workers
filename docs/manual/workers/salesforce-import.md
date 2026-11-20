# salesforce-import

[Appendix A](../reference/salesforce-import.md) lists this Worker's routes, crons, queues, storage and bindings.

`salesforce-import` is not a deployed Worker. It is a Node.js 20+ command-line tool (TypeScript, run with `tsx`) that an operator runs on their own machine. It has no Cloudflare resources, no hostname and no `monday-auth` binding: it calls the Monday API directly with a `MONDAY_API_TOKEN` from the operator's shell. It did the one-time Salesforce/NPSP to Monday migration at cutover. It stays in the repo because its `configure` step and repair scripts still maintain board setup, and its output (`data/`) is the migration's audit record.

## What it does

It read SVBC's Salesforce org once, cleaned and linked the data (person/organization split, duplicate matching, donation → donor → household links, geocoding), and wrote it to Monday's CRM boards in the Donors & Contacts workspace. Salesforce stayed read-only throughout. Nothing runs on a schedule, so nothing breaks if it is left alone. You would run it again only to rebuild boards, re-apply board configuration (views, Overview dashboards), or repair data that a later decision changed.

## Trigger and data flow

Trigger: run by an operator. No cron, webhook or queue. The pipeline is a set of CLI subcommands, each registered in `src/commands.ts`:

1. `extract` — shells out to the `sf` CLI to export Salesforce to `data/extract/`. Also writes backup-only exports to `data/backup/` that nothing loads. Takes a fresh Mailchimp audience export (`--consent`), because Mailchimp, not Salesforce, is the consent system of record. Refuses to run while Funraise sync errors exist in Salesforce.
2. `enrich` (optional) — fills website and address gaps on organization accounts from Google Places. Exact matches merge; the rest go to human review.
3. `geocode` — Census batch geocoder, with Google as an optional fallback.
4. `transform` — builds `data/transform/payloads.ndjson` and fails on assertion violations (`data/transform/report.json`). Writes review CSVs under `data/review/` that a person must decide on.
5. `load` — creates boards and items on Monday, writes links, archives old donations. Records every created item in a resumable ledger under `data/load/`, and board ids in `data/load/boards.json`.
6. `validate` — checks the load against its own ledger. `--live` reads every board back by `Salesforce ID`.
7. `reconcile` — the go/no-go gate. Compares the frozen extract with what Monday reports, per fiscal year, per board and for the top donors. Exit 0 GO, 1 NO-GO, 2 setup error.
8. `configure` — applies board descriptions, groups, additive columns, column descriptions, saved views and Overview dashboards to the boards in `data/load/boards.json`. Idempotent.
9. `backfill-org-notes` — posts each Salesforce `Account.Description` to its Organization's Emails & Activities timeline.

**Storage.** Everything lives in the local, gitignored `data/` directory. It holds donor PII, so the CLI creates it owner-only (0700 directories, 0600 files). The ledger, `boards.json`, the review decisions in `data/enrich/` and the extracts cannot be regenerated once Salesforce is gone. Never delete `data/` or a worktree holding it without copying it out first. The production run's artifacts are archived in the private planning repo's `backup/` directory.

## Monday boards and columns

Board ids are not in config: `config/svbc.json` has `null` board ids and the Donors & Contacts workspace id, and `load` creates or finds the boards and records their ids in `data/load/boards.json`. There is no `config/sandbox.json`. For a sandbox run, set `monday.boardSuffix` (for example `" (sandbox)"`) and point at the sandbox workspace.

Boards it creates and writes: Donations, Activities, People, People (Historical), Organizations, Affiliations, Recurring Gifts, Events, Event Registrations, Campaigns and Volunteers. Every imported item carries its Salesforce Id in the `Salesforce ID` text column. That column is how re-runs avoid duplicates and the only searchable link back to the source record. Keep it.

Other Workers took their production board ids from this tool's production load, so do not rebuild boards without updating every Worker's `config/svbc.json`.

## Secrets

All are environment variables in the operator's shell. None are Worker secrets.

| Name | Purpose | Issued by | Rotate |
|---|---|---|---|
| `MONDAY_API_TOKEN` | All Monday reads and writes | The SVBC Integration user (production) or Sandbox Integration user, never a personal admin token | When the integration user's token is regenerated |
| `MONDAY_DASHBOARD_TOKEN` (optional) | `configure`'s dashboard step; the integration user gets 403 on `create_dashboard`/`create_widget` | The operator's own admin token. `configure` falls back to `MONDAY_API_TOKEN`, so set this only when that token is an integration user's | With that user's token |
| `GOOGLE_MAPS_API_KEY` (optional) | `enrich` (required) and `geocode` fallback | Google Cloud console (Maps Geocoding API). The project is recorded in the private appendix | In Google Cloud |
| `sf` CLI login | `extract` | Salesforce org login | The org stays live on Salesforce's free tier for reference, read-only for staff. The operator's `sf` alias is `svbc` (integration user), so `extract` can still run |

## Write switch

None. It is not a Worker and doesn't read `FLAGS`. Every write command offers a dry run (`load --dry-run`, `configure --dry-run`, `backfill-org-notes --dry-run`); use it first.

## Failure modes

| Symptom | Cause | What to do |
|---|---|---|
| `load` exits 1 with "not re-sent this run" | An ambiguous create (timeout, 5xx, lost response). Batched mode never re-sends those in the same run. | Run `load --batched` again. Its start-of-run scan adopts what landed and creates the rest. |
| `load: DUPLICATE <board>/<sfId>` | Monday holds a Salesforce Id twice. Listed under `duplicates` in `data/load/report.json`. | Remove the extra item by hand. The tool never deletes. |
| `load: READ-BACK FAILED for ...` | The duplicate check for that board errored. | Re-run `load` or `validate --live` before trusting that board. |
| `load` exits 1 with pending links | A link target's create failed. Archiving is held back. | Re-run `load` until pending is 0. |
| A batched run misbehaves | Unexpected Monday errors or relations not sticking. | Stop and re-run plain `load` (sequential); it resumes from the same ledger. Note: resuming a batched ledger sequentially has never been tested. |
| `DAILY_LIMIT_EXCEEDED` | Monday's daily API limit. Never retried. | Wait for the limit to reset, then re-run. |
| `configure` exits non-zero on an Overview | A widget couldn't resolve a column or label; the whole Overview is refused. In July, the new fiscal year's `Gift Fiscal Year` label may not exist yet. | Fix the column or label, then re-run. For lost `create_view` responses, use `--rebuild-overviews <board keys>`. |
| A rerun writes to the wrong boards or skips everything | A stale `data/load/` (ledger and `boards.json`) from another run. | Use the `data/` that matches the target workspace. Between sandbox rehearsals, delete `data/load/`. |
| Writes go to a sandbox board, or vice versa | `monday.boardSuffix` or `workspaceId` points at the wrong place. | Check `config/svbc.json` before every run. |

## Operator scripts

Run from `salesforce-import/` with `MONDAY_API_TOKEN` set. Every one-off script dry-runs by default; `--apply` needs `--expect <dry-run count>` so a board that changed since the dry run is refused.

| Script | When | Command |
|---|---|---|
| `configure` | Re-apply board descriptions, views and Overviews after board changes | `npm run cli -- configure --dry-run`, then `npm run cli -- configure [--only <keys>]` |
| `configure --rebuild-overviews` | Rebuild named boards' Overview dashboards (loses pin and widget sizes; not idempotent) | `npm run cli -- configure --rebuild-overviews <keys> --only <keys>` |
| `backfill-org-notes` | Post Account Descriptions to Organizations (needs a "Salesforce note" custom activity created in the UI) | `npm run cli -- backfill-org-notes --board <Organizations id> --activity-id <id> [--dry-run]` |
| `reconcile` | Prove Monday still matches the extract | `npm run cli -- reconcile [--top 50] [--boards <boards.json>]` |
| `backfill-org-like-accounts.ts` | Add Organizations and Affiliations for config `organizationAccountSfIds` on a board set loaded before they were handled | `tsx scripts/backfill-org-like-accounts.ts --organizations <id> --affiliations <id> --people-live <id> --people-historical <id> [--apply --expect N]` |
| `complete-past-upcoming-events.ts` | Move past Events rows from Upcoming to Completed | `tsx scripts/complete-past-upcoming-events.ts --board <id> [--apply --expect N]` |
| `relabel-partner-type.ts` | Replace the Organizations text Partner Type with a dropdown; then `configure --rebuild-overviews organizations` | `tsx scripts/relabel-partner-type.ts --board <id> [--apply --expect N]` |
| `probe-pools.ts` | Measure Monday write throughput, sandbox workspace only | `tsx scripts/probe-pools.ts --workspace <id> --check`, then `--run` |

The full pipeline (`extract` → `geocode` → `transform` → `load --batched` → `validate --live` → `reconcile`) is documented in the README's [Usage](../../../salesforce-import/README.md#usage) section. Production used `load --batched`; the CLI default is sequential, so pass `--batched` on every run and check the mode line.

## Changing it

- Key files: `src/cli.ts` and `src/commands.ts` (subcommand registry), one directory per stage under `src/`, `src/configure/spec.ts` and `overviewSpecs.ts` (board setup), `src/load/monday.ts` (its own Monday client).
- It deliberately does **not** use the shared `graphql.ts` transport. `gqlPartial()` handles per-alias results, and `gqlLegacy()` must stay verbatim for `load --sequential`. Port any new Monday failure mode by hand. See [Development](../05-development.md).
- Things `configure` does not do (by design): automations, doc views, stripping stock status labels, pinning Overview tabs, widget sizes. Those are UI steps.
- Tests: `npm test`, `npm run typecheck` (a plain `tsc --noEmit`; there's no Wrangler config).
- No deploy. No D1.

## Further reading

- [`salesforce-import/README.md`](../../../salesforce-import/README.md), especially [Usage](../../../salesforce-import/README.md#usage) and [Validation](../../../salesforce-import/README.md#validation)
- [Windfall private board runbook](../../../docs/runbooks/windfall-private-board.md)
- The private planning repo (`monday-migration`): `docs/05-migration-script-requirements.md` (authoritative field mapping) and `docs/22-board-configuration-plan.md`
- [Development](../05-development.md), [Troubleshooting](../08-troubleshooting.md)
