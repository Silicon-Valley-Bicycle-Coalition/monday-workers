# monday-backup

**Status:** Built (`feat/monday-backup`) — not deployed. Needs D1 provisioning (`database_id` in
`wrangler.jsonc` is a placeholder), a dedicated Monday backup integration user/token
(`MONDAY_API_TOKEN`), a Google service account with access to the destination Drive folder
(`GOOGLE_SERVICE_ACCOUNT_EMAIL` / `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`), and
`config/backup.json`'s `destinationParentFolderId` filled in with that folder's real id. The
`Doc.blocks` GraphQL query in `src/monday/client.ts` hasn't been exercised against a live
account — confirm its shape against Monday's API Explorer before the first real run.
**Priority:** Post-migration, non-blocking, but time-relevant once `salesforce-import`'s load stage
runs: from that point on, Monday is holding real donor/donation data with no Salesforce copy to
fall back on if something goes wrong.
**Owner:** Unassigned.
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
  │  1. Enumerate every board across every workspace (Monday GraphQL API)
  │  2. Per board: pull full item + column-value data, paginated, plus the board's own schema
  │     (columns, groups, settings) — enough to reconstruct the board's shape, not just its rows
  │  3. Pull every monday Doc's content (blocks) too — the one thing the native export explicitly
  │     doesn't cover
  │  4. Serialize each board and each doc to JSON
  │  5. Upload to Google Drive via the Drive API, into a dated folder
  │     (e.g. `SVBC Monday Backups/2026-08-25/`)
  │  6. Write a manifest alongside the snapshot (board count, item counts per board, any errors)
  │     so a stale or partial backup is obvious at a glance, not discovered at restore time
  ▼
Google Drive, one dated snapshot per run, kept indefinitely (see Retention below)
```

## APIs & auth

* **Monday.com GraphQL API** — a read-only token from a **dedicated backup integration user**
  with view access to every workspace, not a staff member's personal token. Follows the same
  least-privilege principle `../README.md` already states for every other Worker here: a token
  compromise should expose only what this Worker needs, not one person's full account access.
* **Google Drive API** — a service account added as a collaborator on the destination folder
  (or domain-wide delegation, if SVBC's Google Workspace setup supports it), not a personal OAuth
  grant tied to one staff member's account — a personal grant breaks the day that person leaves
  or changes their password.

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
* **Plan limits.** A full-account snapshot in a single cron invocation can brush against
  Free-plan CPU and subrequest limits. This is moot if the Workers Paid upgrade (already
  required by `funraise-sync`/`quickbooks-sync` for Queues) has landed by build time;
  otherwise, budget for paginating the snapshot across invocations rather than assuming one
  run covers every board.

## Sandbox environment — inbound only, no outbound data

`npm run deploy:sandbox` deploys `svbc-monday-backup-sandbox` (`wrangler.jsonc` `env.sandbox`),
which snapshots every board its **sandbox token** can see — mint it from a user whose only
access is the CRM Sandbox workspace, and the snapshot is the sandbox and nothing else — into the
Drive folder in `config/backup.sandbox.json` (chosen at request time by the `ENVIRONMENT` var,
`src/environment.ts`), alerting `#crm-sandbox` through the sandbox `SLACK_WEBHOOK_URL`. Both
sinks are staff-only; `config/split.test.ts` fails if the two configs ever share the folder id.
Own D1, same daily cron, no public surface. Local development against the sandbox uses `npm run dev:sandbox`; `npm run dev` targets the production config and, once production secrets exist in `.dev.vars`, would write to production sinks. Secrets exist twice (`wrangler secret put … --env
sandbox`): the sandbox Monday token, a service account shared only into the sandbox folder, the
sandbox Slack webhook. `npm run deploy:sandbox` fails until `env.sandbox.d1_databases[0].database_id`
is replaced with the id `wrangler d1 create` prints. Design:
`../docs/superpowers/specs/2026-09-18-sandbox-environment-design.md`.

## Retention

SVBC has confirmed ample spare Drive storage, so the default is **keep every dated snapshot
indefinitely** rather than roll old ones off automatically. The existing Backup section
(`migration-plan.md`, private planning repo) already argues that indefinite retention deserves "a
written retention/review date rather than keeping it forever" for the *Salesforce* archive — the
same argument applies here eventually, just not urgently enough to block building this. Revisit
once there's a real base of snapshots to look at, not before.

## What this does *not* cover

* **Native Monday file-column attachments.** Per the Attachment & Note Migration Workstream
  (`migration-plan.md`, private planning repo), real documents are already moving *out* of Monday
  into Google Drive directly (linked from Monday items, not stored as native Monday files) as the
  long-term design — so file-column content should be minimal going forward, not the primary
  document store this Worker needs to protect. Worth a one-time check for any board still using
  File columns for anything substantive before assuming this is a non-issue.
* **Automation and integration configuration** — recipe definitions, webhook subscriptions,
  column-automation rules. Nothing here fetches or reconstructs those; if an automation gets
  deleted or misconfigured, this backup won't help recreate it. Flagged as an honest gap, not
  solved by this Worker.
* **One-click restore.** This Worker only produces the snapshot. Turning a JSON snapshot back into
  live Monday boards would need its own tool — likely reusable logic from `salesforce-import`'s
  `load` stage, which already knows how to create Monday items from structured data — but that's
  explicitly out of scope here, not assumed solved.

## Related, not yet in scope here

* **Rewind** — ruled out above in favor of building this, but worth revisiting if this Worker's
  maintenance burden turns out higher than expected, or if granular point-in-time restore (not
  just archival snapshots) becomes a real, frequent need.

## Sources

* [Is there data backup? (monday.com)](https://support.monday.com/hc/en-us/articles/115005325725-Is-there-data-backup)
* [How to export your entire account's data (monday.com)](https://support.monday.com/hc/en-us/articles/360002543719-How-to-export-your-entire-account-s-data)
* [Rewind for monday.com](https://rewind.com/products/backups/monday/)
* Plan section: Backup — `migration-plan.md` (private planning repo)
