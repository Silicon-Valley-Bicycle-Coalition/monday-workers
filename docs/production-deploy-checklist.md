# Production deploy checklist — migration cutover

One ordered checklist for taking every migration Worker from "running in the sandbox" to
production, around the `salesforce-import` production load. Copy it into the cutover issue/MR and
tick boxes there; fix this file when a step turns out wrong.

It is the umbrella, not the detail: each Worker's README (and `member-portal/DEPLOY.md`) remains
the source of truth for its own steps, and this file links to them. SVBC-specific go/no-go rules
(data-freeze window, the 5%-core-integrity rollback threshold, cutover-weekend DRIs) live in the
private plan's "Cutover Safeguards" section. Forks: substitute your own account, domains, and
boards throughout.

**Scope:** `member-portal`, `funraise-sync`, `donation-rollups`, `mailchimp-sync`,
`monday-backup`, `benevity-import`, `bp-feedback-notify`, `eventbrite-sync`
(post-cutover, time-boxed by the Oct 22 Summit backfill), `report-digests` (live before the first
Monday 08:00 after cutover; its README, "Production (cutover weekend)"), and the `salesforce-import`
CLI. `monday-auth` (the Monday token broker) deploys **before** all of these and
`member-portal-writer` with `member-portal` (`member-portal/DEPLOY.md`). `dtd-sync`, `member-map`
and `nearby-search` are post-migration additions with their own READMEs. The private
runbook's other step-6 items (6.11 board linking, 6.12 invoicing Tasks) are scripts, not deploys. `svbc-calendars` isn't part of the migration and can ship on its own
schedule — its checklist is [its README's Deploy section](../svbc-calendars/README.md#deploy).
`quickbooks-sync` is postponed indefinitely (decided 2026-10-28) and is out of scope: don't
deploy it, set its secrets, or register its webhooks at cutover. Its `writes` key stays `off`.

**Status as of 2026-10-06, wording refreshed 2026-10-30** (readiness review): nothing below is done unless marked (Phase 1 items resolved
2026-09-29, 2026-10-01 and 2026-10-06 are ticked). **Since then (2026-11-11), per the root README's
status table, these have deployed to production without their boxes here being ticked:**
`report-digests` (2026-11-01), `funraise-sync` and `benevity-import` and `eventbrite-sync`
(2026-11-02), `bp-feedback-notify`, `monday-backup`, `people-reclassification` and `member-map`
(2026-11-03). Treat the root README as the source of truth for what is live. `salesforce-import`'s
`cutoverDateISO` is `2026-10-30` (moved from `2026-10-09` on 2026-10-09, from `2026-10-16` on 2026-10-19, then from `2026-10-23` on 2026-10-26, with the cutover weekend; `donation-rollups` `membership.fromISO` moves with it). `benevity-import` `minDisbursementDate` is `2026-10-30` too (from 2026-10-28): the freeze date, not a confirmed Period Ending, so a disbursement keyed before the freeze can't be imported twice and any unkeyed one before it is reviewed from its "Skipped, not imported" worklist item. Phase 3/4 order brought in line with the private cutover
runbook (`docs/23-cutover-runbook.md`, step 4.0) on 2026-09-30: `donation-rollups` now deploys
in Phase 3, before `configure` and the go/no-go.

---

## Phase 0 — Repo fixes before cutover (do these now)

These are landmines in the repo itself that break the cutover MR if left alone.

- [x] **Split tests that pinned production to placeholders** (fixed 2026-09-25). They would
      have gone red the moment real ids landed in `config/svbc.json`; each now asserts
      "placeholder **or** differs from sandbox", like the other Workers' split tests:
  - `donation-rollups/config/split.test.ts` — expected production `boardId` `0`, owner-board keys
    `['0']`, `custodian.workspaceId` `0`, `alertItemId`/`annualSummaryBoardId` null.
  - `quickbooks-sync/config/split.test.ts` — expected `sandbox.quickbooksSync` to deep-equal
    production (true only while both use stand-in column ids).
- [x] **`member-portal/DEPLOY.md` was stale** (fixed 2026-09-25). Phase 4 now applies
      migrations 0001–0005, creates the `member-portal-letter-emails` queue + DLQ, sets
      `LETTER_WEBHOOK_SECRET`, and covers the "Send Giving Letter" automation.
- [x] **`salesforce-import/config/svbc.json` targets production.** `boardSuffix` is `""` and
      `workspaceId` is 18201685, the Donors & Contacts workspace (set 2026-10-26, 3fcaa80; merged !235).
      The sandbox workspace is now CRM Sandbox v4 (18210301, built 2026-10-28; 4fe2c97).
- [ ] Decide the open `donation-rollups` item "retire the numeric Fiscal Year column?" (its
      README, "Not yet done") — it changes which column ids go into production config.

## Phase 1 — Account and staff prerequisites (no board ids needed)

- [x] **Move the Cloudflare account to Workers Paid.** Done — on Workers Paid through Project
      Galileo (confirmed 2026-09-29). Was needed twice over: D1's 100k-writes/day
      Free cap already stalled `donation-rollups` in the sandbox (its README, "operational
      findings, 2026-09-17"), and donor-facing email to non-verified destinations requires Paid
      (sandbox design, Open items).
- [x] **"Billing Budget Alert" stays at $10** (reviewed 2026-10-06). Galileo covers the Business
      plan, not Workers Paid, so the $5 base is billed and $10 means $5 of real usage overage —
      an early warning, not noise.
- [x] **Every Worker carries `limits.cpu_ms`** (re-audited 2026-10-21) — the guard that matters
      once Paid's 30 s default applies. Present at top level and in `env.sandbox` for every
      Worker (re-checked 2026-11-11; `monday-auth` gained its `100` then, #117). Seven run above 100 ms on
      purpose, each with the reason in a comment beside the setting: `monday-backup`
      (`cpu_ms: 300000` and `subrequests: 50000`, a full-workspace snapshot), `member-map`
      (`300000`), `donation-rollups` and `dtd-sync` (`30000`), `nearby-search` (`2000`),
      `people-reclassification` (`1000`, a board sweep) and `report-digests` (`500`). Keep those
      exceptions; re-check
      the rest before the production deploy if a `wrangler.jsonc` changes.
- [x] **Rate-limit `namespace_id`s are unique per account** (resolved 2026-10-01). Cloudflare's
      docs: the id "uniquely defines this rate limiting namespace within your Cloudflare
      account", and two bindings with the same id share counters, even across Workers. Every
      id in this repo is distinct (`1001`–`1004`, `2001`–`2096`; `nearby-search` moved off
      `member-map`'s `2093`/`2094` on 2026-11-11); keep it that way when adding a Worker.
- [ ] **Monday access through the `monday-auth` broker** (root README, "Least-privilege
      Monday tokens"): one integration user authorizes three OAuth apps (Portal, Staff sync,
      Read-only), and each Worker binds `MONDAY_AUTH` to its entrypoint (`PortalToken`,
      `SyncToken`, `ReadOnlyToken`). Deploy `monday-auth` and consent the three apps
      (`monday-auth/SETUP.md`) before any Worker that binds it.
  - [ ] Never a staff member's personal token.
- [ ] **Mail domain:** `mail.bikesiliconvalley.org` onboarded for Email Sending, DMARC record in
      place (`member-portal/DEPLOY.md` Phase 2–3). `bp-feedback-notify` reuses it. The name is
      free: until 2026-10-06 `mail.bikesiliconvalley.org` was a proxied CNAME to
      `ghs.googlehosted.com` (a Google Workspace shortcut that had been failing with a 525, since
      Google presented no certificate for it); that record and the four sibling shortcuts
      (`calendar.`, `docs.`, `groups.`, `sites.`) were deleted that day.
- [ ] **Third-party accounts ready:**
  - [ ] Funraise production API key.
  - [ ] Mailchimp production audience with the 6 merge fields, Interest Category, and Journeys
        (`mailchimp-sync/README.md`, "Prerequisites before this can run against real data").
  - [ ] Google service account + destination Drive folder for `monday-backup` (account added to the
    Shared Drive as **Contributor**, not Content manager — #67); Slack webhook.

## Phase 2 — Cloudflare resources (no board ids needed)

Provision what doesn't depend on Monday, so cutover weekend is only config + deploy.

| Worker | D1 (production) | Queues (+ `-dlq` each) | Still to do |
|---|---|---|---|
| `member-portal` | exists | `member-portal-change-requests`, `member-portal-letter-emails` (both exist with DLQs, verified 2026-10-08) | nothing — 0001–0006 applied (0001–0005 verified 2026-10-08; 0006, `hash_login_attempts`, applied 2026-10-29 on an empty `login_attempts`) |
| `funraise-sync` | exists, 0001–0005 applied (0005 applied 2026-10-08) | `funraise-sync-writes` | nothing — the D1 is still reset before first deploy (Phase 4 step 2) |
| `donation-rollups` | exists (kept through the §9 move); 0001–0008 applied (0008, `gifts_removed_at`, applied 2026-10-08 — it had been missing; all 37,367 gifts read `removed_at` NULL afterwards); 0009 (membership rule) applied 2026-10-23 and 0010 (`owner_leases`, the per-owner recompute lease) applied 2026-10-29 — both had to land **before** the builds that read them (same ordering rule as 0005/0006) | `donation-rollups-recompute` | apply 0011–0014 (roll call credits, sponsorship facts, recognition year, recompute hashes) before the build that reads them, unless already applied — not recorded here |
| `mailchimp-sync` | created 2026-10-08, id wired | `mailchimp-sync-outbound`, `mailchimp-sync-inbound` (created 2026-10-08) | nothing — 0001–0005 applied 2026-10-08 |
| `monday-backup` | created 2026-10-08, id wired | — | 0001–0003 applied (0003, `usage_alert_state`, applied 2026-10-29); 0004 (`usage_tracking`) not recorded here — check before deploy |
| `benevity-import` | exists, 0001–0003 applied (0002–0003 applied 2026-10-08; the tables were empty, so 0002's dedupe had nothing to merge) | `benevity-import-writes` (created 2026-10-08) | nothing |
| `eventbrite-sync` | created, id wired (production deployed 2026-11-02) | `eventbrite-sync-writes` | apply 0001–0003 |
| `bp-feedback-notify` | — | — | nothing |

For each row:

- [ ] D1 created and its id committed to `wrangler.jsonc` (split tests compare `database_id`s,
      so a production id equal to the sandbox one fails CI — good).
- [ ] `npx wrangler d1 migrations apply <db> --remote` — **before** the build that needs them
      goes live (`donation-rollups/README.md`).
- [ ] Queues and DLQs created.
- [ ] Secrets set with `npx wrangler secret put` (top-level env, not `--env sandbox`):

| Worker | Secrets |
|---|---|
| `member-portal` | `LETTER_WEBHOOK_SECRET` |
| `funraise-sync` | `FUNRAISE_WEBHOOK_SECRET`, `FUNRAISE_API_KEY` |
| `donation-rollups` | `MONDAY_WEBHOOK_SECRET`, `CUSTODIAN_SECRET` (Bearer for `/custodian/*`; not a webhook secret, never in a URL) |
| `mailchimp-sync` | `MAILCHIMP_API_KEY`, `MONDAY_WEBHOOK_SECRET`, `MAILCHIMP_WEBHOOK_SECRET`; optional `SLACK_WEBHOOK_URL` (gates its alerts) |
| `monday-backup` | `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`, `SLACK_WEBHOOK_URL` |
| `benevity-import` | `BENEVITY_WEBHOOK_SECRET` |
| `bp-feedback-notify` | `WEBHOOK_SECRET` |
| `eventbrite-sync` | `EVENTBRITE_PRIVATE_TOKEN`, `EVENTBRITE_WEBHOOK_SECRET`, `CLASS_EMAIL_SECRET` (header `X-Class-Email-Secret` from the class email send page; not a webhook secret, never in a URL) |
| `report-digests` | `DIGESTS_SECRET` (Bearer for `POST /digests/run`) |

Monday access comes from the `MONDAY_AUTH` binding, not a secret: a `MONDAY_API_TOKEN` is only a
cutover-era fallback where a Worker still declares one, and is not set for production.

Webhook secrets must be **fresh production values**, never the sandbox ones. Save each in the
password manager before `wrangler secret put` — the same value goes into the registration URL
below, and a lost copy means re-setting the secret and re-registering the webhook.

**The password manager is Google Passwords**, in the deploying operator's
`@bikesiliconvalley.org` account: the only approved store, per SVBC's Information Technology and
Cyber Security protocols. Worker secrets, webhook secrets (and the registration URLs that contain
them) and Monday integration-user credentials **never** go in the shared Box note, a Box file,
email or chat. Forks: substitute your own password manager.

**Webhook registration URLs.** Register each after its Worker's production deploy, in that
Worker's Phase 3/4 step; `<SECRET>` is the value set above. The secret is part of the URL, so
**re-register the subscription if a secret is ever rotated**. Until a secret is set the route
fails closed (401s everything). `<host>` is `https://svbc-<worker>.svbc-account.workers.dev`
(`workers.dev` pattern as in the sandbox READMEs; the production hosts don't exist until each
Worker's first deploy) except `member-portal`, which is
`https://member.bikesiliconvalley.org`. `monday-backup` is cron-only: no webhooks.

| Worker | Registered in | URL |
|---|---|---|
| `donation-rollups` | `scripts/setup-webhooks.mjs` — subscribes `create_item`, `change_column_value`, `item_deleted`, `item_archived`, `item_restored` on every board in `config/svbc.json`, and `create_item`, `change_column_value`, `item_deleted`, `item_restored` on every `volunteerBoards` (Event Registrations) board, plus `create_item` and `change_column_value` on Affiliations when `affiliations.employerSync` is set. Run it before the first custodian sweep; it reads the env var `WEBHOOK_SECRET` (not `MONDAY_WEBHOOK_SECRET`). **Deletions only work on a build at or after `a27a0bc` (2026-10-12, !214):** Monday's `delete_pulse` / `restore_pulse` payloads carry `itemId`, not `pulseId`, and every earlier build rejected them as "no pulseId", so a deleted gift never left its owner's totals and a deleted check-in kept counting. | `<host>/webhooks/monday/donations?secret=<SECRET>` |
| `funraise-sync` | Funraise dashboard (transactions only; recurring gifts come from the hourly poller). Repointing the existing sandbox registration moves the feed off the sandbox. | `<host>/webhooks/funraise/transaction?secret=<SECRET>` |
| `mailchimp-sync` | Monday webhook on the Donors board and on People (Historical) (`18437909784`), same URL | `<host>/webhooks/monday/donors?secret=<MONDAY_WEBHOOK_SECRET>` |
| `mailchimp-sync` | Mailchimp audience webhook, **API source unchecked** | `<host>/webhooks/mailchimp/audience?secret=<MAILCHIMP_WEBHOOK_SECRET>` |
| `benevity-import` | Monday webhook `change_specific_column_value` on the Uploads file column | `<host>/webhooks/monday/benevity-upload?secret=<SECRET>` |
| `benevity-import` | Monday webhook on the worklist Retry status column (needs `uploadsBoard.retry` provisioned; until then the route ignores every event) | `<host>/webhooks/monday/benevity-retry?secret=<SECRET>` |
| `member-portal` | Monday "Send Giving Letter" automation | `https://member.bikesiliconvalley.org/webhooks/monday/letters?secret=<LETTER_WEBHOOK_SECRET>` |
| `bp-feedback-notify` | Monday automation on the `Post-Event Feedback` column (note: singular `webhook`) | `<host>/webhook/bp-feedback?secret=<WEBHOOK_SECRET>` |
| `eventbrite-sync` | Eventbrite API, one organization-wide webhook (`order.placed`, `order.updated`, `order.refunded`) — `POST /v3/organizations/{org}/webhooks/` (see its README) | `<host>/webhooks/eventbrite/order?secret=<SECRET>` |

Checked against the route definitions on `main` (2026-10-08). Not verified: the production
`workers.dev` hostnames, and the exact Monday event types for the `mailchimp-sync` and
`benevity-retry` subscriptions — take those from each Worker's README.

- [ ] **Workers Builds:** each Worker has a production connection (root directory =
      its subdirectory, deploy command `npx wrangler deploy`, branch `main`) alongside its
      sandbox connection (root README, "Deploys"). Until a Worker's production config is real,
      keep its production connection off — otherwise the next merge to `main` deploys it with
      null board ids.

## Phase 3 — `salesforce-import` production load, `donation-rollups`, go/no-go

Everything downstream needs the board ids this run creates.

`donation-rollups` deploys here, **before `configure` and before the go/no-go**, not in Phase 4
(private runbook step 4.0; the order comes from the private plan's `docs/22` §5). Donor Level,
the four chartable gift columns and the Annual Giving Summary don't exist or are empty until it
has run, and both `configure`'s dashboards and the go/no-go sample review look at them.

- [ ] Salesforce data freeze started (private plan, Cutover Safeguards).
- [ ] Fresh Mailchimp consent export (`salesforce-import/README.md`).
- [ ] `config/svbc.json` switched to the production workspace and suffix.
- [ ] `extract` → `geocode` → `transform` → `load --dry-run` → `load`.
- [ ] **Keep the run's `data/` directory** (ledger, payloads) — `donation-rollups`' bootstrap
      reads it, and it's gitignored, so `git worktree remove` silently destroys it.
- [ ] Record every production board id, column id, and workspace id in one place
      (`data/load/boards.json` has the boards) for the next item and Phase 4.
- [ ] **Make the donor boards private (#41), before any Worker deploy that holds a production
      token** (including `donation-rollups` below): `salesforce-import` creates them public, so
      until this is done every member token, the Sandbox Integration user's included, reaches and
      can edit them. Rehearse on a sandbox board first. Then
      `node scripts/make-boards-private.mjs --workspace <id> --prefix "<prefix>" --sandbox-user <id>`
      (dry run), review the subscriber list, re-run with `--apply`. Details: root README, "Making
      the production donor boards private".
  - [ ] Subscribe the staff team, and each integration user to only the boards its Worker
        reads/writes; the Sandbox Integration user to none.
  - [ ] Run `node scripts/check-monday-token-scope.mjs --workspace <id>` for each production
        token (and the sandbox token) and paste the results in the cutover log. Don't call a
        token scoped before this.
- [ ] **`donation-rollups`**, from `donation-rollups/`, in this order:
  - [ ] Config and deploy (Phase 4's per-Worker steps 1–3): Donations board id, owner boards,
        custodian workspace/alert ids.
  - [ ] Provision columns and the summary board: `scripts/setup-owner-columns.mjs` (the
        rollup set, including Donor Level on People and Organizations),
        `setup-affiliation-columns.mjs`, `setup-annual-summary-board.mjs`, and
        `scripts/setup-classification-columns.mjs <donationsBoardId>` (Funding Stream, Gift
        Size, Fiscal Quarter, Gift Fiscal Year on Donations). Each prints a config block;
        paste them in and repeat Phase 4's steps 2–3 so the deployed config has the new ids.
  - [ ] Membership labels: the Donations board's Membership Type values written from now on
        are `New` / `Continuing` / `Lapsed renewal` / `Lifetime` (a text column, no label setup
        needed). The People `Member Type` status column must carry the labels New / Continuing
        / Lapsed renewal — `scripts/setup-membership-columns.mjs` creates them — because owner
        writes do not pass `createLabelsIfMissing`.
  - [ ] Bootstrap D1 from the load's artifacts: `bootstrap-links-from-artifacts.mjs` and
        `bootstrap-gifts-from-artifacts.mjs`, then apply each SQL file with
        `npx wrangler d1 execute svbc-donation-rollups --remote --file <file> -y`. Keep the
        `-y`: without a TTY, wrangler's prompt cancels silently with exit 0.
  - [ ] If the D1 carries Annual Giving Summary rows from an earlier board set (it was kept
        through the sandbox move; also true on any cutover retry), clear the stale pointers
        right after the bootstrap, or `archive` fails with "Item not found in board":
        `npx wrangler d1 execute svbc-donation-rollups --remote -y --command "UPDATE annual_summaries SET monday_item_id = NULL"`
  - [ ] Monday webhooks via `scripts/setup-webhooks.mjs` →
        `/webhooks/monday/donations?secret=`. Subscribed **before** the first sweep.
  - [ ] Custodian passes, in this order: **`classify`**
        (`POST /custodian/run/classify` with `Authorization: Bearer <CUSTODIAN_SECRET>`, repeated until `detail.remaining` is `0` —
        at most 300 gifts a run) → **`sweep`** (one recompute per ledger owner; fills Donor
        Level) → **`archive`** (restates the Annual Giving Summary). Budget 8–12 hours;
        unmeasured at production scale.
  - [ ] Verify: `GET /custodian/status` clean, recompute queue drained with an empty DLQ, a
        spot-checked donor shows Donor Level and Lifetime Giving.
        Then delete the test gift: its owner's Lifetime Giving and Gift Count must drop within a
        minute (the `delete_pulse` path, which no build before `a27a0bc` ever handled — !214).
- [ ] `configure --dry-run`, then `configure` — only after the `donation-rollups` item is
      done; its dashboards chart the columns that item creates and fills. Then the manual
      board configuration (private plan, `docs/22` §5).
- [ ] `validate`, then `validate --live`.
- [ ] `reconcile` (extract vs Monday, per fiscal year, per board, top-N donors; read-only; exit 0 = GO).
      Paste `data/reconcile/report.md` into the cutover log. Run it before the sync Workers go
      live so "items with no Salesforce Id" is 0. See `salesforce-import/README.md`, "`reconcile`".
- [ ] Go/no-go against the rollback threshold. No-go = don't cut over; Salesforce is untouched,
      but `donation-rollups` is already live against the new boards — see [Rollback](#rollback).

## Phase 4 — Production config and deploy, in dependency order

**Gate:** the donor boards are private and the integration users subscribed (Phase 3,
"Make the donor boards private", #41) before the first production deploy below. The private
runbook (`monday-migration` `docs/23-cutover-runbook.md`) does not have this step yet: **outstanding**,
add it after the load and before the Worker production deploys.

For each Worker:

1. Fill `config/svbc.json` (or `production.json`/`backup.json`) with the Phase 3 ids — no
   `REPLACE_WITH_*`, no null board ids left for features you mean to enable.
2. `npm test && npm run typecheck` (split test proves no sandbox id leaked in).
3. Merge, then deploy: `npm run deploy` from `main` for the first deploy. (Merging alone deploys
   nothing but `svbc-calendars` and `monday-backup` until the Workers Builds item above is done — root README, "Deploys".)
4. Turn its write switch on, `node scripts/flags.mjs <worker> writes on --env production` (a
   missing key reads as `off`, and work ingested under `off` is never written). `funraise-sync`:
   before its bootstrap walk. `donation-rollups` goes on in Phase 3, after its webhooks
   (`node scripts/flags.mjs donation-rollups writes on --env production`).
5. Register its inbound feeds.
6. Run its verification before starting the next Worker.

At the end, `node scripts/flags.mjs status --env production`: every deployed Worker reads
`writes=on`. Undeployed Workers (`nearby-search`, `dtd-sync`, `quickbooks-sync`) read `off`, and
those with queues read `missing`, so `status` exits 1; that is expected.

Order matters: `donation-rollups` must be listening before anything writes Donations, which is
why it was already deployed, bootstrapped and subscribed in Phase 3.

- [ ] **1. `donation-rollups`** — deployed in Phase 3. Here, only the live check: edit one test
      gift, see the owner's rollups recompute, delete it and see Lifetime Giving and Gift Count
      drop within a minute; `/custodian/status` clean.
- [ ] **2. `funraise-sync`**
  - [ ] **Add the `Refunded` label to the production Donations board's Status column first.**
        The consumer maps a Funraise refund to it, so a refund replayed below (or arriving live)
        is rejected (`failed`, error prefixed `not retried: `, since #75) and leaves the gift
        `Received` until it exists. It is not created by the
        import and is missing on sandbox v3 too. `eventbrite-sync` (step 9) needs the same label.
  - [ ] Config: Donations, Recurring Gifts, People boards + all `subscriptionsPoll.columns`,
        and a real `entityIdColumn` (adopt-before-create; the split test requires it, and
        without it the Worker duplicates migrated gifts).
  - [ ] **Reset the production-named D1 before the first deploy.** `svbc-funraise-sync` still
        holds what was copied out of it on 2026-09-19 — 1,175 ledger rows, cursors and six
        events, all pointing at deleted sandbox items. README, "Resetting for new board ids",
        step 2 and 3b.
  - [ ] `node scripts/flags.mjs funraise-sync writes on --env production` **before the walk**:
        the local walk reads production `FLAGS`; under `off` it dry-runs but still advances its
        cursor, so the walk is wasted, and under `hold` it doesn't run.
  - [ ] Bootstrap the subscriptions poller locally (`funraise-sync/README.md`, `wrangler dev
        --remote --test-scheduled`), starting right after :00; since #25 an overlap with the
        deployed cron is safe.
  - [ ] **Repoint Funraise's single webhook** from the `-sandbox` Worker to
        `/webhooks/funraise/transaction?secret=` on production, and note the time. The sandbox
        loses its Funraise feed from here on — expected.
  - [ ] **Replay the cutover gap** — every delivery the sandbox Worker took between the final
        extract and the repoint — with `funraise-sync/scripts/replay-window.mjs`
        (`funraise-sync/README.md`, "Replaying one Worker's deliveries into another"). The
        bootstrap walk above must be done first, so each replayed installment finds its
        Recurring Gift in the ledger. `--since` is when the final extract **started**, not the
        repoint: the overlap is harmless, because adopt-before-create updates a gift the import
        already carried.
        1. `node scripts/replay-window.mjs --since <extract start, ISO UTC> --dry-run` prints
           the plan from the sandbox D1 and needs no secret or URL. It is also the reachability
           check: a failure is reported with wrangler's own reason (most likely an expired
           `wrangler login`); fix it before the real run.
        2. `FUNRAISE_WEBHOOK_SECRET=<production's secret> node scripts/replay-window.mjs
           --since <same> --worker-url https://<production-host>`, at the default
           `--pause-ms 2000`. The route allows 60 requests a minute per client address, shared
           by every run from that address, and a `429` counts as `failed`.
        3. Exit 0 is clean. Exit 1: a delivery failed, or the secret was rejected (the run
           stops at the first row). Wait a minute and re-run until every row reads
           `already present`; re-running is safe. A row rejected for good (`not retried: `,
           e.g. a refund before the `Refunded` label) never converges this way: add the label,
           then `scripts/redrive-failed.mjs --worker-url <production> --older-than-min 0`.
           Before the run, check `flags.mjs status` shows `funraise-sync` `writes=on`: a gift
           ingested under `off` stays `queued` and the replay only answers `duplicate`
           (recovery: `UPDATE events SET status = 'failed' WHERE status = 'queued'`, then
           `redrive-failed.mjs`). Exit 2: rows whose payload the retention
           purge emptied — recover those from Funraise by hand.
        The script reports *enqueued*, not *written*: the production consumer makes the Monday
        writes one gift at a time afterwards. A refunded gift in the window is rejected (`failed`,
        `not retried: `) if the `Refunded` label (first item of this step) was not added before
        the replay.
  - [ ] Confirm `funraiseSync.oldestActiveFiscalYear` in `config/svbc.json` equals the importer's
        `cutoffFY` (2026 for this cutover), then query `events` rows with
        `status = 'needs_review'`: an edited or refunded gift from an archived fiscal year —
        a replayed one included — is flagged there and written to no board.
  - [ ] **Post-repoint window check** (private runbook `docs/23`, step 5), once the replay's
        queue has drained. Its five checks are the gate, not the script's counts: ledger to
        ledger (every sandbox id in the window is `written` in production with a
        `monday_item_id`; no `status = 'failed'` rows, which covers both `dead-lettered after
        retries: ` and `not retried: `), against Funraise's own dashboard
        (the only check that catches a delivery the sandbox Worker never received), nothing
        doubled on the Donations board, no archived-year item created since the repoint, and
        the `Refunded` label in place. Only the first is a query, plus check 3 (one Donations
        item per Funraise ID), which `node scripts/check-funraise-ids.mjs` runs read-only (exit
        0 required; not yet rehearsed against production); the rest are by hand on the board.
  - [ ] After Gate C, not before: pause Funraise → Salesforce sync by blocking the `Funraise`
        connected app (Salesforce Setup → Connected Apps OAuth Usage → Block). The paused-state
        check and the later disconnect are in the private runbook (`docs/23`, Salesforce after
        Gate C, step 4).
  - [ ] Verify: Funraise Test-button delivery → Donations item with every column right →
        `donation-rollups` rolls it up (the README's three steps); delete the test items.
- [ ] **3. `member-portal`** — follow [`DEPLOY.md`](../member-portal/DEPLOY.md) Phases 1–5.
      Notable: Organizations discount columns, Change Requests board,
      `taxLetter.benefitStatement` sign-off, `funraise.renewMembershipUrl`, the letters Monday
      automation. Verify with its Phase 5 (login round-trip, enumeration guard, feature gates,
      rate limits).
- [ ] **4. `mailchimp-sync`** — Campaigns board + connect/State columns; Monday webhook
      `/webhooks/monday/donors?secret=` on People and on People (Historical); Mailchimp audience webhook
      `/webhooks/mailchimp/audience?secret=` with the **API source unchecked**. No documented
      verification yet — at minimum, change one Donor's email and confirm the audience member
      updates (and that no member is *created*).
- [ ] **5. `benevity-import`** — add the `Benevity Disbursement Date` column and confirm the
      `Matched By`/`Benevity Transaction ID` columns (`benevity-import/README.md`); provision the
      worklist's Retry status column (Needs review / Retry / Queued / Done) and Key text column
      and fill `uploadsBoard.retry.column` and `worklistKeyColumn` (both
      filled in `config/svbc.json`). **Two** webhooks of type `change_specific_column_value`:
      the Uploads file column → `/webhooks/monday/benevity-upload?secret=`, and the Retry column
      → `/webhooks/monday/benevity-retry?secret=` (without it Retry does nothing). Verify with a
      one-row upload built for it: a **synthetic** Disbursement ID and Transaction ID, and Period
      Ending on or after `minDisbursementDate` (`2026-10-30`; the cutoff is strict, so an older
      row is only skipped). Then delete its Monday items and its D1 rows in the README reset's
      foreign-key order (`rows`, `disbursements`, `uploads`); a real row deleted from Monday
      but left in D1 stays `written` and is skipped forever. Don't backfill through this Worker.
- [x] **6. `monday-backup`** — Drive folder id in `config/backup.json`; confirm the first daily
      snapshot lands in Drive and `snapshot_runs` records it. A clean run posts nothing to Slack;
      only a partial or failed run alerts. **Deployed 2026-11-03 with `writes on`; Slack alerts
      verified (#52). The first run (2026-11-04) captured 19 of about 262 boards, so the snapshot
      moved to a Workflow. Every daily 09:00 UTC run from 2026-11-05 to 2026-11-09 recorded
      `success` with no errors (264 to 272 boards, 24 to 25 docs, 37 to 54 minutes).**
- [ ] **7. `bp-feedback-notify`** — deploy, then add the `Post-Event Feedback` column and the
      automation (`bp-feedback-notify/README.md`, "Monday automation setup"); verify with
      `wrangler tail` on one real trigger.
- **8. `quickbooks-sync`** — postponed indefinitely (decided 2026-10-28); nothing to do at
  cutover. Its production D1 and `quickbooks-sync-writes` queue were provisioned 2026-10-08 and
  are left in place, unused.
- [ ] **9. `eventbrite-sync`** (post-cutover; the Summit backfill is due after Oct 22 sales) —
      the `Eventbrite Order ID` column on production Donations comes from the cutover load
      (`salesforce-import` stamps it on migrated ticket gifts; transform warns if
      `eb4sf_orders.ndjson` is missing from the extract — re-extract before loading if it does),
      so read its id from the load's `boards.json` (the `Refunded` Status label it also needs was
      added in step 2; it is missing on sandbox v3);
      fill `config/svbc.json` (the order path and attendee feed are filled; Home Zip and five Volunteers
      attendee-sync columns are still placeholders, pending the Volunteers cutover); create D1 + queues; set fresh secrets;
      deploy; register the Eventbrite webhook; *then* run `scripts/backfill-orders.mjs`
      (`--dry-run` first). Sequence per
      [`eventbrite-sync/README.md`](../eventbrite-sync/README.md): deploy → register webhook →
      backfill, so no order falls in a gap. Provision the sandbox first.
      Backfill owner: David (decided 2026-10-09); run on/after 2026-10-23 with the Summit's event id.
      Summit orders in the cutover load carry their order id and are adopted, not duplicated;
      never backfill an event that sold tickets before 2026 (those gifts have no id).

## Phase 5 — First week

- [ ] Daily: every production DLQ empty. `donation-rollups`, `funraise-sync`, `mailchimp-sync`
      (both), `eventbrite-sync` and `benevity-import` (since 2026-10-28) have a DLQ consumer;
      `member-portal` does not, so it needs a human to look. A `not retried: ` row never
      reaches a DLQ: also check each D1 for `status = 'failed'`.
- [ ] Daily: D1 write usage per database, now that the Free cap is gone and nothing stops a loop.
- [ ] Each cron fired once and did what it should (Workers → Logs, or `wrangler tail`).
- [ ] Per-Worker CPU time well under each Worker's `limits.cpu_ms`.
- [ ] Update the root README status table and each Worker's README "Status" line.
- [ ] Sandbox Workers still deploy and still can't reach production sinks.

## Rollback

Decide these before deploying, not during.

**Triggers — roll back a Worker if any of these happen:**

- A write lands on the wrong board or the wrong person (any occurrence).
- Its DLQ grows for more than one retry cycle.
- Duplicate Donations appear for one Funraise transaction.
- `member-portal` shows one donor another donor's data (any occurrence — take it offline).
- `mailchimp-sync` creates audience members or changes consent it shouldn't.

**How:**

- **Code regression:** `npx wrangler versions list` then `npx wrangler rollback <version-id>`
  — for a D1 schema change, only if the old code tolerates the new schema.
- **Stop inbound without redeploying:** disable the Monday webhook/automation, repoint or
  disable the Funraise/Mailchimp/Eventbrite webhook, or remove `member-portal`'s custom domain.
  Queued messages sit (and eventually DLQ) instead of writing.
- **After the fix:** replay the DLQ, then reconcile anything that arrived while inbound was off.
- **Boards rebuilt (a cutover retry):** every deployed Worker's D1 still holds the old boards'
  item ids — reset each before redeploying it, per its README's "Resetting for new board ids"
  ([`funraise-sync`](../funraise-sync/README.md#resetting-for-new-board-ids),
  [`mailchimp-sync`](../mailchimp-sync/README.md#resetting-for-new-board-ids),
  [`benevity-import`](../benevity-import/README.md#resetting-for-new-board-ids),
  [`member-portal`](../member-portal/README.md#resetting-for-new-board-ids)); for
  `donation-rollups`, re-run its Phase 3 item, `annual_summaries` step included.
- Whole-migration rollback (before Salesforce retires) is governed by the private plan's
  threshold, not by any one Worker.
