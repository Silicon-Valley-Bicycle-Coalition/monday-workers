# monday-backup

**Staff UAT script:** [`docs/uat/monday-backup.md`](../docs/uat/monday-backup.md) — what a non-technical tester can try in the sandbox and what they should see. Keep it in step with this README.

**Status:** **Production deployed 2026-11-03** from `main` (e4f0678, version `43d05351`): both
crons, `writes on`, D1 migrations applied, `MONDAY_AUTH` bound to the `monday-auth` broker's
Read-only app, a Google service account as a member (**Contributor**, not Content manager — see
"Service account key" below) of the destination **Shared Drive**, and `config/backup.json`'s
`destinationParentFolderId` set to it. **The first 09:00 UTC run (2026-11-04) captured 19 of about
262 boards and no docs:** a complete run takes about an hour and a cron invocation gets 15 minutes,
so the snapshot now runs as a Workflow, one step per board or doc (design:
`../docs/superpowers/specs/2026-11-04-monday-backup-complete-snapshot-design.md`). **First complete
snapshot 2026-11-04 (run 3):** 264 boards, 24 docs, 63,380 items, 782 updates and 816 doc blocks in
43 minutes, with no errors or retries; Drive checked against the manifest. Not covered: 41 private
copies in the sandbox workspaces, and 4 legacy or scratch boards, none of which SVBC Integration is
subscribed to. Requires **Workers
Paid** (see Cloudflare config below). The restore mutations in `src/restore/api.ts` have not been
exercised against a live account yet.
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
Cloudflare Cron Trigger (daily), which only starts the Workflow
  │
  ▼
Cloudflare Workflow (src/workflow.ts), one retried step per board or doc, about an hour in all
  │  1. Enumerate every board across every workspace (Monday GraphQL API), active and archived,
  │     with its metadata (kind, description, folder, permissions, state, type)
  │  2. Per board: its schema (columns with settings, groups), then every item, paginated —
  │     column values (connect-boards/dependency linked item ids and mirror display values via
  │     their typed fragments, since `text` is null for those), state, created/updated time,
  │     creator, parent item (subitems), file metadata — then every update with its replies.
  │     Subitems boards are backed up like any other board.
  │  3. Pull every monday Doc's blocks, paginated, with nesting and position — the one thing the
  │     native export explicitly doesn't cover
  │  4. Stream each board and each doc, page by page, as JSON Lines encrypted on the way out
  │     (`board-<id>.jsonl.enc`, `doc-<id>.jsonl.enc`; see "Snapshot encryption") into a Drive
  │     resumable upload — memory holds one page, never a board
  │  5. …into one folder per run inside the Shared Drive, named for the date and D1 run id
  │     (e.g. `SVBC Monday Backups/2026-08-25 run-17/`), so a same-day rerun never collides
  │  6. Write a manifest alongside the snapshot (format, run id, the capture window, when each
  │     board and doc was captured, item counts per board, block counts per doc, any errors) so a
  │     stale or partial backup is obvious at a glance, not discovered at restore time
  ▼
Google Drive, one snapshot folder per run, kept indefinitely (see Retention below)
```

## APIs & auth

* **Monday.com GraphQL API** — from the `monday-auth` broker, not a stored token. Both deployments
  bind `MONDAY_AUTH` (`wrangler.jsonc` `services`) to its `ReadOnlyToken` entrypoint — the *SVBC
  Read-only* OAuth app (read scopes only, no `boards:write`), consented as SVBC Integration with
  view access to every workspace — production (`svbc-monday-backup`) to `svbc-monday-auth`, sandbox
  (`--env sandbox`) to `svbc-monday-auth-sandbox` (Sandbox Integration). `src/monday/graphql.ts`
  `tokenProviderFor` asks it per request and re-asks once on a 401, so a token refreshed mid-run
  doesn't fail the backup. A `MONDAY_API_TOKEN` secret is only the fallback while the cutover is
  under way (delete it once the binding works); with neither, building the Monday client throws a
  config error naming both. The restore CLI (`scripts/restore.ts`) keeps reading `MONDAY_API_TOKEN`
  from the operator's shell. Local `wrangler dev` has no broker to call, so put a `MONDAY_API_TOKEN`
  in `.dev.vars` for it. Design: `docs/superpowers/specs/2026-10-30-monday-oauth-broker-design.md`.
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
  **Manage versions**). Since snapshot encryption, an edited encrypted file fails authentication at
  restore, as does an edited manifest, and the restore refuses plaintext `.jsonl` files whenever a
  key is given, so a
  tampered file can't be restored by mistake; it still has to be recovered from **Manage
  versions**. If that residual risk ever matters more, the next step is a second
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
* **Workers Builds connected 2026-11-03** (root directory `/monday-backup`, branch `main`, watch
  path `monday-backup/*`, preview builds off); no build has run yet, so the first merge touching
  `monday-backup/src/` is what proves the watch path. Routine changes deploy by merging to `main`, and manual
  `wrangler deploy` is for provisioning or emergencies only (see the root README's Deploys
  section for why hand-deploys are distrusted here).
* **Plan limits — requires Workers Paid.** Workers Free caps a cron at 10ms CPU and 50
  subrequests; no real snapshot fits. On Paid, `wrangler.jsonc` sets `cpu_ms: 300000` (the
  configurable maximum — the fleet-wide 100ms cost cap silently killed every run, issue #29) and
  `subrequests: 50000`; a complete run makes roughly 3,000.
* **Why a Workflow.** A cron invocation is killed at 15 minutes, and a complete run takes about an
  hour (43 minutes on 2026-11-04): roughly 2–4 s per 100 items, and about 4 s per board even when
  it's empty, across about 264 boards and 24 docs. Each board fits easily in a step (the largest, People, took about 5.5 minutes), and a Workflow step has no
  wall-time limit. A step gets three tries; one that still fails is recorded in the manifest and the
  run carries on, unless 10 fail in a row, when it stops and alerts rather than spend 14 hours on an
  outage (rerun it once that's fixed). A step can run twice, so it first looks for its file in the run folder: Drive
  allows duplicate names and a Contributor can't delete one. Each step has a 25-minute deadline
  (`src/deadline.ts`) inside its 30-minute timeout. Start a run by hand with:

  ```sh
  npx wrangler workflows trigger svbc-monday-backup-snapshot
  ```

  Each file logs one line with its counts, duration, requests and retries.
* **Failure visibility.** `success` means complete: nothing failed, and every board in
  `requiredBoardIds` was captured. Any partial run and any total failure alerts Slack immediately
  (if the very first step can't write to D1, there's no run to report, and the watchdog catches it). A
  second, hourly cron (`30 * * * *`, `src/watchdog.ts`) runs independently of the backup and alerts
  if a run is stuck in `running` for over 12 hours (marked `abandoned` in D1) or if no **complete**
  snapshot has landed in 36 hours. A partial run doesn't reset that clock, so one board failing
  nightly gets both alerts, on purpose. A clean run posts nothing, so silence is the healthy state.
  Production Slack alerts verified 2026-11-03/04: real API usage and partial-backup alerts arrived.
  The watchdog uses the same webhook but hasn't fired yet. Production alerts go to a private staff
  channel (#52).
* **Boards the token can't see.** The token never lists a private board its user isn't subscribed
  to, so a run can't report what it can't see. This hid Activities and Campaigns from the first run.
  `requiredBoardIds` in `config/backup.json` names the CRM boards a complete run must hold: when a
  new board matters, subscribe SVBC Integration to it and add it there. All three OAuth apps act as
  that one user, so subscribing it also opens the board to `member-portal`'s read-only token (see the
  root README). Listings differ by token too, so to audit coverage, compare the manifest with a list
  from an admin's own token.
* **Monday API daily usage.** The same hourly cron reads the account's API usage
  (`platform_api { daily_limit daily_analytics }`; this works on Pro, not only Enterprise) and
  alerts Slack once each when today's calls pass **50%**, **80%** and **100%** of the daily limit
  (`src/usage.ts`, at most three alerts per UTC day, tracked in D1 by migration 0003). Monday caps
  API calls per *account*, across every token: integration users, staff personal tokens, the
  hosted MCP. Pro allows 10,000 a day, resetting at midnight UTC, and from 2027 calls over the
  cap may fail with `DAILY_LIMIT_EXCEEDED`. A complete snapshot costs an estimated 500–700
  calls (read from the code, not yet measured live; issue #95 cut it from 1,500–2,000): one request
  per board for its schema, first items page and first updates page together, then items 500 to a
  page (`src/monday/client.ts`, which halves a page that hits the per-query complexity cap or times
  out). Once the cap is enforced, hitting it fails each remaining board at once rather than
  retrying (`priorityWorkspaceIds` means the CRM workspace is already captured by then). The limit
  read is `total`, so a purchased API add-on
  raises the thresholds with it. Each check costs one call, 24 a day. Because the limit is
  account-wide and the sandbox shares the production account, only the deployment whose config
  sets `apiUsageAlerts: true` runs it: production does, and the sandbox doesn't. An alert names
  the users with the most calls that day, and so which Workers made them (Sandbox Integration
  means a sandbox Worker). Monday's `by_user` only totals its whole 14-day window, so each hourly
  check stores those totals and adds up the growth (migration 0004). The count starts at the
  00:30 UTC check, so it misses the first half hour, and it is empty until the second check after
  this is deployed.

## Sandbox environment — inbound only, no outbound data

`npm run deploy:sandbox` deploys `svbc-monday-backup-sandbox` (`wrangler.jsonc` `env.sandbox`),
which snapshots every board its **sandbox token** can see — mint it from a user whose only
access is the CRM Sandbox workspace, and the snapshot is the sandbox and nothing else — into the
Drive folder in `config/backup.sandbox.json` (chosen at request time by the `ENVIRONMENT` var,
`src/environment.ts`), alerting `#crm-sandbox` through the sandbox `SLACK_WEBHOOK_URL`. Both
sinks are staff-only; `config/split.test.ts` fails if the two configs ever share the folder id.
Own D1, same daily cron, no public surface. The sandbox config leaves `apiUsageAlerts` off,
because production already reports the shared account's API usage. Local development against the sandbox uses `npm run dev:sandbox`; `npm run dev` targets the production config and, once production secrets exist in `.dev.vars`, would write to production sinks. Secrets exist twice (`wrangler secret put … --env
sandbox`): the sandbox Monday token, a service account shared only into the sandbox folder
(also as Contributor), the
sandbox Slack webhook, and the sandbox's own `BACKUP_ENCRYPTION_KEY` (see "Snapshot encryption"). `npm run deploy:sandbox` fails until `env.sandbox.d1_databases[0].database_id`
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
`workspaceIds: ["18210301"]`, a config-level belt-and-braces check: `runSnapshot` skips any board
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

## Snapshot encryption

Every board and doc file is encrypted before it leaves the Worker (issue #112), so the Shared
Drive holds ciphertext: an over-broad Drive membership, a compromised staff Google account or a
leaked service-account key no longer yields a bulk copy of the CRM. `src/drive/encrypted.ts`
wraps the Drive client; the format is documented at the top of `src/crypto/snapshotCipher.ts`
(manifest `format: monday-backup/3`, `encryption.scheme: monday-backup-aes256gcm-stream/1`):

* **AES-256-GCM, streamed in 64 KiB frames**, with a per-file key derived by HKDF-SHA256 from the
  secret and a random per-file salt. Each frame is authenticated, numbered and bound to the file
  header, and the last one is marked, so a changed, reordered, spliced or truncated file fails to
  decrypt instead of restoring wrong data.
* **One secret, `BACKUP_ENCRYPTION_KEY`**: 32 random bytes, base64. **Required.** Without it (or
  with a malformed one) a run fails at its folder step, before anything is uploaded, and alerts
  Slack; nothing is ever uploaded in the clear. Production and sandbox each have their own key.
* **The manifest stays plaintext but is authenticated** (ids, counts, timestamps, error lines, and
  `encryption.keyId`, the first 8 bytes of the key's SHA-256), so a stale or partial run is
  still obvious from Drive. Its last field, `manifestMac`, is an HMAC-SHA256 over the JSON of
  everything before it, under a key HKDF-derived from the secret. The restore checks it before it
  trusts any field.
* **Files are bound to their run.** Every frame also authenticates the file's binding,
  `<snapshot folder>/<file name>` (e.g. `2026-08-25 run-17/board-1.jsonl`). The MACed manifest
  lists the run's `snapshotFolder` and every file it wrote (`files`). The restore requires the
  `.enc` files to be exactly that list, with nothing extra and nothing missing, and decrypts each
  under its binding. A genuine file copied in from another night, or renamed into another board's
  place, therefore fails. A download folder still named like a run must be the manifest's run.
* **No downgrade at restore.** With a key given, or any `.enc` file in the folder, the restore
  refuses every plaintext `.jsonl` whatever the manifest says. It also refuses a manifest that fails
  its MAC, and a `monday-backup/3`-or-later manifest without `encryption`. Swapping the ciphertext
  for plaintext and stripping the manifest back to v2 therefore fails. A snapshot with no encrypted
  files is refused unless the operator passes `--allow-plaintext-snapshot`, with no key; it then
  restores with a warning that nothing in it is authenticated. That is only for v2 snapshots, from
  before encryption.
* **Symmetric, not public-key.** The issue suggested encrypting to a public key whose private
  half only the restore operator holds. The Worker has to read its own files back (a retried
  step re-counts a file it already uploaded, `tallyBoardFile` in `src/backup.ts`), so it holds
  the key itself. What that costs: someone who can read this Worker's secrets can decrypt the
  snapshots. Only the account's Super Administrators can, and they can already read the live CRM
  through the Monday binding, so the threat the issue names (the Drive side) is covered.
* **Reading a snapshot back** is `npm run restore -- … --key-file <path>` (RESTORE.md "The
  encryption key"), or `npm run decrypt -- <file>.jsonl.enc --key-file <path>` for one file. The
  restore still reads older `monday-backup/2` snapshots, which are plaintext and need no key
  but do need `--allow-plaintext-snapshot`.

**Losing the key loses every snapshot encrypted with it.** Keep a copy outside the Shared Drive,
somewhere the restore operator can reach without Cloudflare or Google, such as a password
manager they control, as a secure note named for the environment and the key id. Setting it up (production; add
`--env sandbox` and use a different key for the sandbox):

1. `openssl rand -base64 32` — the key. Don't save it to a file in a repo or on the Shared Drive.
2. `npx wrangler secret put BACKUP_ENCRYPTION_KEY` and paste it, **before** a build carrying
   this code deploys (Workers Builds deploys on merge to `main`); otherwise that night's run fails
   and alerts until it's set.
3. Store the copy there, with the key id from the next run's
   `manifest.json` (`encryption.keyId`).
4. After the next run, check the manifest's `format` is `monday-backup/3`, the files are
   `*.jsonl.enc`, and `npm run decrypt` with the stored copy opens one of them. That proves the
   stored copy is the deployed key.

**Rotating** (whenever someone who held the key leaves, or at once if it may have leaked):
repeat steps 1–4 with a new key. Older snapshots keep needing the old key, so keep the old copy,
labelled with its key id, for as long as those snapshots are kept (Retention: indefinitely). The
restore names the key id a snapshot needs. A leaked key exposes every snapshot it encrypted, and
a Contributor can't delete them: after rotating, a Shared Drive manager decides whether to trash
the old snapshots.

## Shared Drive membership

Shared Drive membership is still what controls who can download the snapshot files, and the
plaintext manifests. Older `monday-backup/2` snapshots (2026-11-04 until encryption is deployed)
are full plaintext CRM copies and stay that way. Keep the membership to the people who could
restore the CRM anyway, the same rule the root README applies to Cloudflare account members:

* the backup service account, as **Contributor** (see "Contributor, not Content manager");
* the restore operator(s), as Manager;
* nobody else, and no groups or "anyone with the link" sharing.

Review it under the Shared Drive's **Manage members** whenever staff change, and at least
quarterly. Record each review here, with the member list, and remove anyone who doesn't fit
the list above.

_Membership reviews:_ none recorded yet. Record the first one with the member list as found.

## Write switch

The `FLAGS` KV key `monday-backup:writes` (`on` | `hold` | `off`; missing or unrecognized means
`off`, a KV read error acts like `hold`) gates both crons. Anything but `on`
makes the nightly backup log one skip line and return, with no `snapshot_runs` row, so the watchdog
does not count it as a failure. A run already under way reads the switch before each board and doc, because it
lasts an hour and `hold` has to take effect: an explicit `hold` or `off` stops it, recorded as
`stopped` in D1, with no manifest and no alert. A KV read error instead retries the step, so a blip
can't silently end a night's backup. The watchdog always computes and keeps its D1 bookkeeping, but its
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
  that is N full copies of every attachment. It also cuts against the Attachment & Note Migration
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
