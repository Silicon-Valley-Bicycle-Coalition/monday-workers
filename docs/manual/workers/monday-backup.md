# monday-backup

[Appendix A](../reference/monday-backup.md) lists this Worker's routes, crons, queues, storage and bindings.

`monday-backup` deploys as `svbc-monday-backup` (production) and `svbc-monday-backup-sandbox`
(sandbox), each with a Cloudflare Workflow (`svbc-monday-backup-snapshot`,
`svbc-monday-backup-snapshot-sandbox`). It has no routes and no public surface: `workers_dev` and
preview URLs are off. It reads Monday through the broker's `ReadOnlyToken` entrypoint (no write
scope). It requires the Workers Paid plan.

## What it does

Every night it takes a full, encrypted snapshot of the Monday account (every board, item,
update and Doc the integration user can see) and stores it in a Google Shared Drive. It also
watches the account's Monday API usage. If it stops, there is no off-Monday copy of the CRM to
recover from after a bad bulk edit, a runaway automation or an account-level mistake, and
nobody is warned before the account hits Monday's daily API cap.

## Trigger and data flow

### Nightly snapshot: cron `0 9 * * *` → Workflow

The cron only starts the Workflow. A cron invocation is killed at 15 minutes and a full run
takes about 45 minutes, so the Workflow runs one retried step per board or doc.

1. List every board in every workspace (active and archived) the token can see. With
   `priorityWorkspaceIds`, the CRM workspace goes first.
2. Per board: schema (columns, settings, groups), every item page (500 at a time; column values,
   linked item ids, mirror values, subitem parents, file metadata), every update and reply.
3. Per Doc: every block, with nesting and position.
4. Stream each board or doc as JSON Lines, encrypted with AES-256-GCM, into a Drive resumable
   upload: `board-<id>.jsonl.enc`, `doc-<id>.jsonl.enc`.
5. Files land in one folder per run inside the Shared Drive, named for the date and run id
   (for example `2026-08-25 run-17/`).
6. Write `manifest.json`: run id, capture window, per-board and per-doc times and counts, errors,
   the list of files, the key id, and an HMAC so a restore can trust it.

A step gets three tries. A failed step is recorded in the manifest and the run continues; ten
failures in a row stop the run with an alert. Each step has a 25-minute deadline. A step that
runs twice first checks whether its file already exists (a Contributor cannot delete duplicates).

A run is `success` only when nothing failed and every board in `requiredBoardIds` was captured.
Any partial or failed run alerts Slack at once.

### Hourly watchdog: cron `30 * * * *`

Runs independently of the snapshot:

- Marks a run stuck in `running` over 12 hours `abandoned` and alerts.
- Alerts if no **complete** snapshot has landed in 36 hours. A partial run does not reset the clock.
- In production (`apiUsageAlerts: true`), reads Monday's account-wide API usage and alerts once
  each at 50%, 80% and 100% of the daily limit, naming the users (and so the Workers) with the
  most calls.

Silence is the healthy state. Sandbox crons are disabled.

### D1 tables

`snapshot_runs` (one row per run: status, counts, errors) and `run_alert_state` (watchdog and
API-usage alert state, including the per-user usage totals).

### Not covered

- File contents: only metadata (name, size, uploader, URL). The bytes are not copied.
- Archived items on active boards (Monday's API cannot list them). Archived boards are covered.
- Automations, integrations and webhook subscriptions.
- Private boards the integration user is not subscribed to. The token cannot see them, so the
  run cannot report them missing.

## Monday boards and columns

Reads every board and Doc the SVBC Integration user can see; writes nothing to Monday. Config
lives in `config/backup.json` (production) and `config/backup.sandbox.json` (sandbox), not
`svbc.json`:

| Key | Meaning |
|---|---|
| `destinationParentFolderId` | The Shared Drive (or folder in it) that holds run folders |
| `requiredBoardIds` | CRM boards a complete run must capture. Add a board here when it matters, and subscribe the integration user to it |
| `workspaceIds` | Workspace filter. Empty in production (everything); `18210301` (CRM Sandbox v4) in the sandbox. Do not remove the sandbox filter: the sandbox token can read production's open boards |
| `excludeBoardIds` | Boards to skip |
| `priorityWorkspaceIds` | Workspaces captured first |
| `apiUsageAlerts` | `true` in production only (the limit is account-wide) |

Subscribing the integration user to a board also opens it to `member-portal`'s read token. See
[`monday-auth`](monday-auth.md).

## Secrets

| Name | Purpose | Issued by | Rotate |
|---|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | The service account's address | Google Cloud console → IAM & Admin → Service accounts | Stays the same across key rotations |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | Signs the Worker's Google tokens. The one long-lived Drive credential | Google Cloud console → the backup service account → Keys → Add key (JSON) | Yearly, when a holder leaves, or at once on a leak: create a new key, `wrangler secret put`, confirm the next run, delete the old key and the downloaded file. On a suspected leak, delete the old key first |
| `BACKUP_ENCRYPTION_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts every snapshot file and MACs the manifest. **Required**: without it a run fails before uploading anything | Generated by the operator; different per environment | Set the new key before the next run, store a copy with its key id, keep every old key as long as its snapshots are kept. **Losing a key loses every snapshot made with it** |
| `SLACK_WEBHOOK_URL` | Failure, watchdog and API-usage alerts (production: a private staff channel; sandbox: `#crm-sandbox`) | Slack incoming webhook | New URL, `wrangler secret put` |
| `MONDAY_API_TOKEN` | Optional fallback only; normal access is the broker. The restore CLI reads one from the operator's shell | Monday | Do not add new uses |

Keep a copy of `BACKUP_ENCRYPTION_KEY` outside Cloudflare and Google (for example the restore
operator's password manager), named for the environment and key id. Where the copies live is in
the private appendix.

The service account is a **Contributor** on the Shared Drive, not Content manager: it can upload
but cannot trash, move or delete. Shared Drive members should be only the service account and the
restore operators (Managers). A snapshot file with more than one revision has been tampered with.

## Write switch

Key `monday-backup:writes` in `FLAGS` (`sandbox-FLAGS`). Set with
`node scripts/flags.mjs monday-backup writes on|hold|off --env production|sandbox`.

| Mode | Nightly snapshot | Run in progress | Watchdog |
|---|---|---|---|
| `on` | Runs | Continues | Computes and alerts |
| `hold` / `off` (or missing key) | Logs one skip line; no `snapshot_runs` row | Stops before the next board or doc, recorded `stopped`, no manifest, no alert | Computes; alerts logged as skips |
| KV read error | Treated like `hold` at start | The step retries | Alerts logged as skips |

After a long `hold` or `off`, expect the 36-hour staleness alert on the first watchdog run after
switching back `on`, until the next backup succeeds.

## Failure modes

| Symptom | Cause | What to do |
|---|---|---|
| Slack: partial backup | One or more boards or docs failed after three tries, or a required board was not captured | Read `manifest.json` errors. A required board missing usually means the integration user is not subscribed to it |
| Slack: run stopped after 10 failures in a row | Monday outage, broker token problem, or Drive failure | Check `monday-auth` `/health` and Monday status, then trigger a new run |
| Slack: no complete snapshot in 36 hours | Runs failing, partial, or not starting (switch off, Workflow not triggered, D1 unwritable) | Check `snapshot_runs` and Workers Logs; trigger by hand |
| Slack: run stuck `running` over 12 hours | Workflow stalled | It is marked `abandoned`; trigger a new run |
| Run fails at the folder step | `BACKUP_ENCRYPTION_KEY` missing or malformed | Set it; nothing was uploaded in the clear |
| Drive `403 storageQuotaExceeded` | Destination is a My Drive folder, not a Shared Drive | Use a Shared Drive |
| Drive 404 on a folder that exists | A call missing `supportsAllDrives` | Code bug; check `src/drive/` |
| Every run killed early | `cpu_ms` lowered from 300000, or Workers Free | Restore `limits.cpu_ms` in `wrangler.jsonc`; needs Workers Paid |
| Slack: API usage at 50/80/100% | Account-wide Monday calls (every Worker, staff tokens, MCP) near 10,000 a day | The alert names the top users. From 2027 calls over the cap may fail |
| A board is absent but no error | Private board the integration user is not subscribed to | Subscribe the user; add the board to `requiredBoardIds` |
| Restore refuses a file | File edited, renamed, from another run, or plaintext beside a key | Recover the original from Drive's Manage versions |

## Operator scripts

Run from `monday-backup/`.

| Task | Command |
|---|---|
| Start a snapshot now | `npx wrangler workflows trigger svbc-monday-backup-snapshot` (sandbox: `svbc-monday-backup-snapshot-sandbox`) |
| Decrypt one file | `npm run decrypt -- <file>.jsonl.enc --key-file <path>` |
| Restore, dry run | `npm run restore -- "<snapshot dir>" --workspace <target id> --key-file <path> [--boards <ids>] [--docs <ids>\|none] [--suffix "..."]` |
| Restore, for real | `MONDAY_API_TOKEN='<write token>' npm run restore -- "<snapshot dir>" --workspace <target id> --key-file <path> --execute` |

Pre-encryption snapshots (`monday-backup/2`) need `--allow-plaintext-snapshot` instead of
`--key-file`. Restore never overwrites: it builds new boards in a target workspace and logs every
object it creates to `restore-ledger.jsonl`. It cannot restore original ids, authorship,
automations, owners, or label colors. Follow [`RESTORE.md`](../../../monday-backup/RESTORE.md).

**Restore is unrehearsed.** Its mutations have never run against a live account; `RESTORE.md`'s
rehearsal log is empty as of 2026-11-19. Do the sandbox rehearsal ("Restore rehearsal") before
relying on it.

## Changing it

Key files: `src/index.ts` (crons), `src/workflow.ts` (snapshot steps), `src/backup.ts`,
`src/watchdog.ts`, `src/usage.ts`, `src/drive/` (Drive client, JWT, encryption wrapper),
`src/crypto/snapshotCipher.ts` (format), `src/monday/client.ts`, `src/restore/`,
`scripts/restore.ts`, `scripts/decrypt.ts`.

Gotchas:

- `src/monday/graphql.ts` is the **canonical** Monday transport. After editing it, copy it to
  every Worker listed in the `monday-graphql-copies` step of `checks.yml`.
- Production deploys through **Workers Builds** on merge to `main` (root `/monday-backup`).
  Hand deploys are for provisioning or emergencies. Set any new secret before merging code that
  needs it.
- Every batched Monday read needs an explicit limit; every Drive call needs
  `supportsAllDrives=true`.
- `npm run typecheck` also checks `tsconfig.scripts.json` (the restore CLI).
- `npm run dev` uses the production config; use `npm run dev:sandbox`.

Tests: `npm test`, `npm run typecheck`. Deploy: `npm run deploy:sandbox`, `npm run deploy`.
Migrations:

```sh
npx wrangler d1 migrations apply svbc-monday-backup-sandbox --env sandbox --remote
npx wrangler d1 migrations apply svbc-monday-backup --remote
```

## Further reading

- [`monday-backup/README.md`](../../../monday-backup/README.md), especially [Service account key](../../../monday-backup/README.md#service-account-key), [Snapshot encryption](../../../monday-backup/README.md#snapshot-encryption) and [Shared Drive membership](../../../monday-backup/README.md#shared-drive-membership).
- [`monday-backup/RESTORE.md`](../../../monday-backup/RESTORE.md): restore procedure.
- [UAT script](../../uat/monday-backup.md).
- [Complete snapshot design](../../superpowers/specs/2026-11-04-monday-backup-complete-snapshot-design.md).
- [Operations](../07-operations.md) (backups), [Troubleshooting](../08-troubleshooting.md).
