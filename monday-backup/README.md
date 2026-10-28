# monday-backup

**Staff UAT script:** [`docs/uat/monday-backup.md`](../docs/uat/monday-backup.md) — what a non-technical tester can try in the sandbox and what they should see. Keep it in step with this README.

**Status:** Built (`feat/monday-backup`) — not deployed. Needs D1 provisioning (`database_id` in
`wrangler.jsonc` is a placeholder), a dedicated Monday backup integration user/token
(`MONDAY_API_TOKEN`), a Google service account added as a member (**Contributor**, not Content manager — see
"Service account key" below) of the destination **Shared Drive** (`GOOGLE_SERVICE_ACCOUNT_EMAIL` / `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`),
and `config/backup.json`'s `destinationParentFolderId` filled in with the id of a folder inside
that Shared Drive (or the Shared Drive's own id). Requires **Workers Paid** (see Cloudflare
config below). None of the GraphQL queries in `src/monday/client.ts` (item fragments, updates,
paginated `Doc.blocks`) nor the restore mutations in `src/restore/api.ts` have been exercised
against a live account yet — confirm them in Monday's API Explorer before the first real run.
**Restore:** `npm run restore` rebuilds a snapshot into a workspace — procedure in
[`RESTORE.md`](RESTORE.md). The end-to-end **restore rehearsal into the sandbox is still
outstanding** (it needs the provisioned sandbox, issue #14).
**Priority:** Post-migration, non-blocking, but time-relevant once `salesforce-import`'s load stage
runs: from that point on, Monday is holding real donor/donation data with no Salesforce copy to
fall back on if something goes wrong.
**Owner:** David (decided 2026-10-09).
**Stack:** Hono + TypeScript + D1, on a Cloudflare Cron Trigger instead of the usual
webhook-driven shape — see `../README.md`'s shared-stack note.

## The ask

Once Monday is the sole system of record, nothing keeps a durable, restorable history of it:

* Monday's own internal backups (25-day retention, [Is there data backup?](https://support.monday.com/hc/en-us/articles/115005325725-Is-there-data-backup))
  are for monday.com's own disaster recovery, not self-serve restore.
* The native **Export account data** feature (Admin settings) is real but manual — an admin has to
  remember to click it, it takes up to 24 hours, and it explicitly **excludes Monday Docs**
  ([How to export your entire account's data](https://support.monday.com/hc/en-us/articles/360002543719-How-to-export-your-entire-account-s-data)) —
  a real gap for SVBC, which leans on Docs for process documentation (`docs/06` §"Board
  Documentation Conventions" in the private planning repo).
* Rewind, the Monday-marketplace backup partner, offers real automated daily backups and granular
  restore, but it's a recurring third-party cost ($13–20/mo, independent of SVBC's own Monday
  plan) and — per its own marketing copy — appears to cover boards/items/columns only, not Docs
  either.

**Decided (dwk, 2026-08-25): build this instead of subscribing to Rewind.** SVBC has ample spare
Google Drive storage already, and this project's own default is build-over-subscription (see the
plan's Guiding Philosophy) — matches every other Worker here rather than introducing the one
paid third-party dependency in the stack.

**Scope, explicitly:** this is a periodic full-account *archival snapshot* — protection against
catastrophic loss (a bad bulk edit, a runaway automation, an account-level mistake), not a
Rewind-style "undo my last change" tool. It complements the one-time **Salesforce** export already
planned before the October cutover (`migration-plan.md`'s Backup section, private planning repo)
— that one covers the *old* system before it retires; this Worker covers the *new* one, ongoing,
after it's live.

## Data flow

```
Cloudflare Cron Trigger (proposed: daily)
  │
  ▼
Cloudflare Worker
  │  1. Enumerate every board across every workspace (Monday GraphQL API), active and archived,
  │     with its metadata (kind, description, folder, permissions, state, type)
  │  2. Per board: its schema (columns with settings, groups), then every item, paginated —
  │     column values (connect-boards/dependency linked item ids and mirror display values via
  │     their typed fragments, since `text` is null for those), state, created/updated time,
  │     creator, parent item (subitems), file metadata — then every update with its replies.
  │     Subitems boards are backed up like any other board.
  │  3. Pull every monday Doc's blocks, paginated, with nesting and position — the one thing the
  │     native export explicitly doesn't cover
  │  4. Stream each board and each doc, page by page, as JSON Lines (`board-<id>.jsonl`,
  │     `doc-<id>.jsonl`) into a Drive resumable upload — memory holds one page, never a board
  │  5. …into one folder per run inside the Shared Drive, named for the date and D1 run id
  │     (e.g. `SVBC Monday Backups/2026-08-25 run-17/`), so a same-day rerun never collides
  │  6. Write a manifest alongside the snapshot (format, run id, item counts per board, block
  │     counts per doc, any errors) so a stale or partial backup is obvious at a glance, not
  │     discovered at restore time
  ▼
Google Drive, one snapshot folder per run, kept indefinitely (see Retention below)
```

## APIs & auth

* **Monday.com GraphQL API** — a read-only token from a **dedicated backup integration user**
  with view access to every workspace, not a staff member's personal token. Follows the same
  least-privilege principle `../README.md` already states for every other Worker here: a token
  compromise should expose only what this Worker needs, not one person's full account access.
* **Google Drive API** — a service account that is a **member of a Shared Drive** (role:
  **Contributor**), not a personal OAuth grant tied to one staff member's account — a personal
  grant breaks the day that person leaves or changes their password. It must be a Shared Drive,
  not a My Drive folder shared with the service account: [service accounts have no storage
  quota](https://developers.google.com/workspace/drive/api/guides/about-shareddrives), so uploads
  into a shared My Drive folder fail `403 storageQuotaExceeded`. Every Drive call passes
  `supportsAllDrives=true` (and the folder lookup `includeItemsFromAllDrives=true&corpora=allDrives`);
  without those, Drive answers 404 for Shared Drive items. Snapshots count against the Shared
  Drive's (i.e. the Workspace's pooled) storage.

  **Contributor, not Content manager (issue #67).** The token carries the full `drive` scope
  (`ensureFolder` lists folders it didn't create), so the Shared Drive role is the real limit on
  a leaked key. A Contributor can list, create folders and upload, which is all the Worker does,
  but Drive refuses it any trash, move or delete; Content manager would let a leaked key trash
  every snapshot. What a Contributor key *can* still do is edit: upload new revisions over
  existing snapshot files or add junk files. Snapshots are dated folders written once and never
  edited, so a Shared Drive manager should treat any snapshot file with more than one revision
  as tampered with (Drive keeps the earlier revisions; restore one from the file's
  **Manage versions**). If that residual risk ever matters more, the next step is a second
  Shared Drive the account isn't a member of, filled by a copy it can't reach. Not built.

## Cloudflare config (fleet standard)

When this gets built, its `wrangler.jsonc` follows the conventions applied fleet-wide on
2026-08-24 (see any built Worker, e.g. `../svbc-calendars/wrangler.jsonc`):

* **Pinned `account_id`** (SVBC) so a deploy can't land on the wrong Cloudflare account,
  `upload_source_maps: true`, observability enabled, and `Env` generated via `wrangler types`
  in the `typecheck` script rather than hand-written.
* **Cron-only, no public surface.** No routes, and `workers_dev`/`preview_urls` stay `false` —
  nothing about a backup Worker should be reachable from the Internet at all; it only makes
  outbound calls.
* **Workers Builds on first ship.** Connect the Worker in the dashboard with root directory
  `/monday-backup`; after that, routine changes deploy by merging to `main`, and manual
  `wrangler deploy` is for provisioning or emergencies only (see the root README's Deploys
  section for why hand-deploys are distrusted here).
* **Plan limits — requires Workers Paid.** Workers Free caps a cron at 10ms CPU and 50
  subrequests; no real snapshot fits. On Paid, `wrangler.jsonc` sets `cpu_ms: 300000` (the
  configurable maximum — the fleet-wide 100ms cost cap silently killed every run, issue #29) and
  `subrequests: 50000`. The hard constraint is the cron trigger's **15-minute wall-time** limit:
  `runBackup` stops starting new boards/docs at 12 minutes (`DEFAULT_WALL_TIME_BUDGET_MS` in
  `src/backup.ts`); a shared deadline (`src/deadline.ts`) makes any Monday or Drive call still
  retrying give up at 13 minutes — every request timeout and retry wait is capped to the time
  left — and is then extended to 14.5 minutes for the manifest upload. Whatever was skipped is
  recorded in the manifest, so an oversized run ends as a visible *partial* snapshot with an
  alert, not a silent kill. If real runs start hitting that
  budget, the next step is splitting the snapshot across invocations (a Workflow step per board),
  not a bigger single run.
* **Failure visibility.** Any partial run and any total failure alerts Slack immediately. A
  second, hourly cron (`30 * * * *`, `src/watchdog.ts`) runs independently of the backup and
  alerts if a run is stuck in `running` for over an hour (the runtime killed it — marked
  `abandoned` in D1) or if no snapshot has succeeded in 36 hours.
* **Monday API daily usage.** The same hourly cron reads the account's API usage
  (`platform_api { daily_limit daily_analytics }`; this works on Pro, not only Enterprise) and
  alerts Slack once when today's calls pass **50%**, and again at **80%**, of the daily limit
  (`src/usage.ts`, at most two alerts per UTC day, tracked in D1 by migration 0003). Monday caps
  API calls per *account*, across every token: integration users, staff personal tokens, the
  hosted MCP. Pro allows 10,000 a day, resetting at midnight UTC, and from 2027 calls over the
  cap may fail with `DAILY_LIMIT_EXCEEDED`. The limit read is `total`, so a purchased API add-on
  raises the thresholds with it. Each check costs one call, 24 a day. Because the limit is
  account-wide and the sandbox shares the production account, only the deployment whose config
  sets `apiUsageAlerts: true` runs it: production does, and the sandbox doesn't. When an alert
  fires, `daily_analytics { by_user { user { name } usage } }` shows which user, and so which
  Worker, is using the calls.

## Sandbox environment — inbound only, no outbound data

`npm run deploy:sandbox` deploys `svbc-monday-backup-sandbox` (`wrangler.jsonc` `env.sandbox`),
which snapshots every board its **sandbox token** can see — mint it from a user whose only
access is the CRM Sandbox workspace, and the snapshot is the sandbox and nothing else — into the
Drive folder in `config/backup.sandbox.json` (chosen at request time by the `ENVIRONMENT` var,
`src/environment.ts`), alerting `#crm-sandbox` through the sandbox `SLACK_WEBHOOK_URL`. Both
sinks are staff-only; `config/split.test.ts` fails if the two configs ever share the folder id.
Own D1, same daily cron, no public surface. The sandbox config leaves `apiUsageAlerts` off,
because production already reports the shared account's API usage. Until production is
deployed, set it to `true` in `config/backup.sandbox.json` if you want the usage alert from the
sandbox instead; any token on the account can read the figure. Local development against the sandbox uses `npm run dev:sandbox`; `npm run dev` targets the production config and, once production secrets exist in `.dev.vars`, would write to production sinks. Secrets exist twice (`wrangler secret put … --env
sandbox`): the sandbox Monday token, a service account shared only into the sandbox folder
(also as Contributor), the
sandbox Slack webhook. `npm run deploy:sandbox` fails until `env.sandbox.d1_databases[0].database_id`
is replaced with the id `wrangler d1 create` prints. Design:
`../docs/superpowers/specs/2026-09-18-sandbox-environment-design.md`.

**Workers Builds:** connect a second Worker, `svbc-monday-backup-sandbox`, to this repo with
root directory `/monday-backup`, production branch `main`, and deploy command
`npx wrangler deploy --env sandbox`. The sandbox then tracks `main` alongside production. If the
dashboard refuses two connections on one root directory, fall back to the
`deploy-sandbox:monday-backup` job in `../.gitlab-ci.yml` — same command, gated on a
`CLOUDFLARE_API_TOKEN` CI variable so it stays inert until that variable is set.

The sandbox token scoped to the CRM Sandbox workspace (design doc §4) is the primary guard
against a sandbox run touching production boards or docs. `config/backup.sandbox.json` also sets
`workspaceIds: ["17141226"]`, a config-level belt-and-braces check: `runBackup` skips any board
or doc whose `workspaceId` isn't in the list, so a token that somehow gained broader access still
wouldn't back up outside the sandbox workspace. `workspaceIds` is optional — absent or empty (as
in `config/backup.json`) means no filter, today's "snapshot everything the token can see"
behaviour.

## Service account key

The Worker signs its own Google tokens from `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`, so that key is
the one long-lived Drive credential. It never expires on its own; rotate it yearly, whenever
someone who handled it leaves, and at once if it may have leaked. Production and sandbox use
different service accounts, so rotate each separately (add `--env sandbox` for the sandbox).

1. Google Cloud console → **IAM & Admin → Service accounts** → the backup account → **Keys** →
   **Add key → Create new key** (JSON). The file downloads to your machine.
2. Store its `private_key` value. Pasting it as it appears in the JSON, literal `\n`s and all,
   is fine (`src/drive/jwt.ts` accepts both forms):

   ```sh
   npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
   ```

   `GOOGLE_SERVICE_ACCOUNT_EMAIL` stays the same: a new key, not a new account.
3. Confirm the next nightly snapshot lands in Drive and no failure alert reaches Slack.
4. Back on **Keys**, delete the old key. Then delete the downloaded JSON file; the Wrangler
   secret is the only copy that should exist.

**Suspected leak:** delete the old key *first* (step 4), then steps 1–3. A missed night is
cheaper than a live leaked key, and the watchdog's 36-hour alert covers the gap. Afterwards a
Shared Drive manager checks the drive's activity panel for files or revisions the Worker didn't
write (see "Contributor, not Content manager" above), and confirms the account's role is still
Contributor under **Manage members**.

## Write switch

The `FLAGS` KV key `monday-backup:writes` (`on` | `hold` | `off`; missing or unrecognized means
`off`, a KV read error acts like `hold`) gates both crons, read once per run. Anything but `on`
makes the nightly backup log one skip line and return, with no `snapshot_runs` row, so the watchdog
does not count it as a failure. The watchdog always computes and keeps its D1 bookkeeping, but its
Slack alerts are logged as skips unless the mode is `on` (and a suppressed stale-snapshot alert is
not marked as sent, so it fires once the switch is on). After a long `off`/`hold`, expect the
36-hour staleness alert on the first watchdog run after flipping to `on`, until the next backup
succeeds. Set the key with `node scripts/flags.mjs`.

## Retention

SVBC has confirmed ample spare Drive storage, so the default is **keep every dated snapshot
indefinitely** rather than roll old ones off automatically. The existing Backup section
(`migration-plan.md`, private planning repo) already argues that indefinite retention deserves "a
written retention/review date rather than keeping it forever" for the *Salesforce* archive — the
same argument applies here eventually, just not urgently enough to block building this. Revisit
once there's a real base of snapshots to look at, not before.

## What this does *not* cover

* **File contents (item files and update attachments) — metadata only, by decision.** Each
  file's name, extension, size, upload time, uploader and Monday URL are in the snapshot; the
  bytes are not. Monday's `public_url` expires after an hour, so a durable copy would mean
  downloading every file and re-uploading it to Drive *every night* — with indefinite retention
  that is N full copies of every attachment, and the transfer competes with the board data for
  the cron's 15-minute wall-time budget. It also cuts against the Attachment & Note Migration
  Workstream (`migration-plan.md`, private planning repo): real documents are moving *out* of
  Monday into Google Drive directly (linked from items, not stored as Monday files), so file
  columns should be minimal. If a board turns out to rely on File columns for something that
  matters, the right fix is an incremental, content-addressed asset archive (download each asset
  id once, ever), not nightly copies — worth a one-time check before assuming it's a non-issue.
* **Archived *items* on active boards.** Monday's `items_page` returns active items only, and
  there's no API to list archived item ids. An archived item stays restorable from Monday's own
  board Archive, and every nightly snapshot taken while it was active still has it. Archived
  *boards* are backed up in full; deleted boards (Monday's 30-day trash) are skipped and listed in
  the manifest.
* **Automation and integration configuration** — recipe definitions, webhook subscriptions,
  column-automation rules. Nothing here fetches or reconstructs those; if an automation gets
  deleted or misconfigured, this backup won't help recreate it. Flagged as an honest gap, not
  solved by this Worker.
* **Things the restore tool can't put back exactly** — original item/update ids, authorship and
  timestamps (restored updates carry an "originally posted by … at …" line instead), board-level
  updates, board owners/subscribers and folder placement, mirror/formula column wiring (created,
  but check settings), and label colours/indexes (labels are restored by text). The restore
  reports each of these as a warning. Full list and procedure: [`RESTORE.md`](RESTORE.md).

## Related, not yet in scope here

* **Rewind** — ruled out above in favor of building this, but worth revisiting if this Worker's
  maintenance burden turns out higher than expected, or if granular point-in-time restore (not
  just archival snapshots) becomes a real, frequent need.

## Sources

* [Is there data backup? (monday.com)](https://support.monday.com/hc/en-us/articles/115005325725-Is-there-data-backup)
* [How to export your entire account's data (monday.com)](https://support.monday.com/hc/en-us/articles/360002543719-How-to-export-your-entire-account-s-data)
* [Rewind for monday.com](https://rewind.com/products/backups/monday/)
* Plan section: Backup — `migration-plan.md` (private planning repo)
