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
`quickbooks-sync`, `monday-backup`, `benevity-import`, `bp-feedback-notify`, `eventbrite-sync`
(post-cutover, time-boxed by the Oct 22 Summit backfill), and the `salesforce-import` CLI. `svbc-calendars` isn't part of the migration and can ship on its own
schedule — its checklist is [its README's Deploy section](../svbc-calendars/README.md#deploy).

**Status as of 2026-10-06:** nothing below is done unless marked (Phase 1 items resolved
2026-09-29, 2026-10-01 and 2026-10-06 are ticked). `salesforce-import`'s
`cutoverDateISO` is `2026-10-09`. Phase 3/4 order brought in line with the private cutover
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
- [ ] **`salesforce-import/config/svbc.json` still targets the sandbox workspace**
      (`boardSuffix: " (sandbox v2)"`, `workspaceId: 17141226`). Prepare the production values in
      the cutover MR; don't flip them early.
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
- [ ] Confirm every Worker's `limits.cpu_ms: 100` is still present — it's the guard that matters
      once Paid's 30 s default applies. Audited 2026-10-06: present at top level and in
      `env.sandbox` for every Worker except `monday-backup`, which deliberately runs
      `cpu_ms: 300000` and `subrequests: 50000` (a full-workspace snapshot) — keep that exception.
- [x] **Rate-limit `namespace_id`s are unique per account** (resolved 2026-10-01). Cloudflare's
      docs: the id "uniquely defines this rate limiting namespace within your Cloudflare
      account", and two bindings with the same id share counters, even across Workers. Every
      id in this repo is already distinct (`1001`–`1004`, `2001`–`2061`); keep it that way when
      adding a Worker.
- [ ] **Integration users and tokens, one per exposure class** (root README, "Least-privilege
      Monday tokens"). Create after the production workspace exists, scope before minting:
  - [ ] `member-portal` — its own user, read access to only the boards it reads.
  - [ ] Staff-facing sync Workers (`funraise-sync`, `donation-rollups`, `mailchimp-sync`,
        `benevity-import`, `quickbooks-sync`) — `donation-rollups`' README notes its dedicated
        token is "scheduled for production cutover".
  - [ ] `monday-backup` — view access to every workspace.
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
  - [ ] Google service account + destination Drive folder for `monday-backup`; Slack webhook.
  - [ ] Intuit production app: self-assessment questionnaire, production keys
        (`quickbooks-sync/README.md`). Likely lags cutover — fine, it's non-blocking.

## Phase 2 — Cloudflare resources (no board ids needed)

Provision what doesn't depend on Monday, so cutover weekend is only config + deploy.

| Worker | D1 (production) | Queues (+ `-dlq` each) | Still to do |
|---|---|---|---|
| `member-portal` | exists | `member-portal-change-requests`, `member-portal-letter-emails` (both exist with DLQs, verified 2026-10-08) | nothing — 0001–0005 already applied (verified 2026-10-08) |
| `funraise-sync` | exists, 0001–0004 applied (verified 2026-10-08) | `funraise-sync-writes` | apply 0005 (subscription claims) — the D1 is reset before first deploy anyway (Phase 4 step 2) |
| `donation-rollups` | exists (kept through the §9 move) | `donation-rollups-recompute` | confirm 0001–0008 applied |
| `mailchimp-sync` | created 2026-10-08, id wired | `mailchimp-sync-outbound`, `mailchimp-sync-inbound` (created 2026-10-08) | nothing — 0001–0005 applied 2026-10-08 |
| `quickbooks-sync` | created 2026-10-08, id wired | `quickbooks-sync-writes` (created 2026-10-08) | nothing — 0001–0006 applied 2026-10-08 |
| `monday-backup` | created 2026-10-08, id wired | — | nothing — 0001–0002 applied 2026-10-08 |
| `benevity-import` | exists, 0001 applied (verified 2026-10-08) | `benevity-import-writes` (created 2026-10-08) | apply 0002–0003; 0002 adds a unique constraint on disbursement id, so check the table for duplicates first |
| `eventbrite-sync` | **create** — id is `REPLACE_WITH_D1_ID` (sandbox is also a placeholder) | `eventbrite-sync-writes` | create D1 + queues; wire id; apply 0001 — post-cutover, see Phase 4 step 9 |
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
| `member-portal` | `MONDAY_API_TOKEN`, `LETTER_WEBHOOK_SECRET` |
| `funraise-sync` | `MONDAY_API_TOKEN`, `FUNRAISE_WEBHOOK_SECRET`, `FUNRAISE_API_KEY` |
| `donation-rollups` | `MONDAY_API_TOKEN`, `MONDAY_WEBHOOK_SECRET` |
| `mailchimp-sync` | `MONDAY_API_TOKEN`, `MAILCHIMP_API_KEY`, `MONDAY_WEBHOOK_SECRET`, `MAILCHIMP_WEBHOOK_SECRET`; optional `SLACK_WEBHOOK_URL` (gates its alerts) |
| `quickbooks-sync` | `MONDAY_API_TOKEN`, `QB_CLIENT_ID`, `QB_CLIENT_SECRET`, `QB_WEBHOOK_VERIFIER_TOKEN`, `MONDAY_WEBHOOK_SECRET` |
| `monday-backup` | `MONDAY_API_TOKEN`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`, `SLACK_WEBHOOK_URL` |
| `benevity-import` | `MONDAY_API_TOKEN`, `BENEVITY_WEBHOOK_SECRET` |
| `bp-feedback-notify` | `WEBHOOK_SECRET`; optional `MONDAY_API_TOKEN` (only if the Sent/Failed write-back is enabled) |
| `eventbrite-sync` | `MONDAY_API_TOKEN`, `EVENTBRITE_PRIVATE_TOKEN`, `EVENTBRITE_WEBHOOK_SECRET` |

Webhook secrets must be **fresh production values**, never the sandbox ones.

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
- [ ] **`donation-rollups`**, from `donation-rollups/`, in this order:
  - [ ] Config and deploy (Phase 4's per-Worker steps 1–3): Donations board id, owner boards,
        custodian workspace/alert ids.
  - [ ] Provision columns and the summary board: `scripts/setup-owner-columns.mjs` (the
        rollup set, including Donor Level on People and Organizations),
        `setup-affiliation-columns.mjs`, `setup-annual-summary-board.mjs`, and
        `scripts/setup-classification-columns.mjs <donationsBoardId>` (Funding Stream, Gift
        Size, Fiscal Quarter, Gift Fiscal Year on Donations). Each prints a config block;
        paste them in and repeat Phase 4's steps 2–3 so the deployed config has the new ids.
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
        (`POST /custodian/run/classify?secret=…`, repeated until `detail.remaining` is `0` —
        at most 300 gifts a run) → **`sweep`** (one recompute per ledger owner; fills Donor
        Level) → **`archive`** (restates the Annual Giving Summary). Budget 8–12 hours;
        unmeasured at production scale.
  - [ ] Verify: `GET /custodian/status` clean, recompute queue drained with an empty DLQ, a
        spot-checked donor shows Donor Level and Lifetime Giving.
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

For each Worker:

1. Fill `config/svbc.json` (or `production.json`/`backup.json`) with the Phase 3 ids — no
   `REPLACE_WITH_*`, no null board ids left for features you mean to enable.
2. `npm test && npm run typecheck` (split test proves no sandbox id leaked in).
3. Merge, then deploy: `npm run deploy` from `main` for the first deploy. (Merging alone deploys
   nothing but `svbc-calendars` until the Workers Builds item above is done — root README, "Deploys".)
4. Register its inbound feeds.
5. Run its verification before starting the next Worker.

Order matters: `donation-rollups` must be listening before anything writes Donations, which is
why it was already deployed, bootstrapped and subscribed in Phase 3.

- [ ] **1. `donation-rollups`** — deployed in Phase 3. Here, only the live check: edit one test
      gift, see the owner's rollups recompute; `/custodian/status` clean.
- [ ] **2. `funraise-sync`**
  - [ ] Config: Donations, Recurring Gifts, People boards + all `subscriptionsPoll.columns`,
        and a real `entityIdColumn` (adopt-before-create; the split test requires it, and
        without it the Worker duplicates migrated gifts).
  - [ ] **Reset the production-named D1 before the first deploy.** `svbc-funraise-sync` still
        holds what was copied out of it on 2026-09-19 — 1,175 ledger rows, cursors and six
        events, all pointing at deleted sandbox items. README, "Resetting for new board ids",
        step 2 and 3b.
  - [ ] Bootstrap the subscriptions poller locally *before* the deployed cron can fire
        (`funraise-sync/README.md`, `wrangler dev --remote --test-scheduled`).
  - [ ] **Repoint Funraise's single webhook** from the `-sandbox` Worker to
        `/webhooks/funraise/transaction?secret=` on production. The sandbox loses its Funraise
        feed from here on — expected.
  - [ ] Reconcile Funraise transactions dated between the Salesforce export and this step
        against the Donations board; nothing else catches gifts in that gap. Replay them with
        `scripts/replay-window.mjs --since <repoint time>` (README, "Replaying one Worker's
        deliveries into another").
  - [ ] Confirm `funraiseSync.oldestActiveFiscalYear` in `config/svbc.json` equals the importer's
        `cutoffFY` (2026 for this cutover), then query `events` rows with
        `status = 'needs_review'`: an edited or refunded gift from an archived fiscal year is
        flagged there and written to no board.
  - [ ] Verify: Funraise Test-button delivery → Donations item with every column right →
        `donation-rollups` rolls it up (the README's three steps); delete the test items.
- [ ] **3. `member-portal`** — follow [`DEPLOY.md`](../member-portal/DEPLOY.md) Phases 1–5.
      Notable: Organizations discount columns, Change Requests board,
      `taxLetter.benefitStatement` sign-off, `funraise.renewMembershipUrl`, the letters Monday
      automation. Verify with its Phase 5 (login round-trip, enumeration guard, feature gates,
      rate limits).
- [ ] **4. `mailchimp-sync`** — Campaigns board + connect/State columns; Monday webhook
      `/webhooks/monday/donors?secret=`; Mailchimp audience webhook
      `/webhooks/mailchimp/audience?secret=` with the **API source unchecked**. No documented
      verification yet — at minimum, change one Donor's email and confirm the audience member
      updates (and that no member is *created*).
- [ ] **5. `benevity-import`** — add the `Benevity Disbursement Date` column and confirm the
      `Matched By`/`Benevity Transaction ID` columns (`benevity-import/README.md`); webhook of
      type `change_specific_column_value` on the Uploads file column →
      `/webhooks/monday/benevity-upload?secret=`. Verify with a one-row upload, then delete the
      items. Don't backfill through this Worker.
- [ ] **6. `monday-backup`** — Drive folder id in `config/backup.json`; confirm the first daily
      snapshot lands and Slack reports it.
- [ ] **7. `bp-feedback-notify`** — deploy, then add the `Post-Event Feedback` column and the
      automation (`bp-feedback-notify/README.md`, "Monday automation setup"); verify with
      `wrangler tail` on one real trigger.
- [ ] **8. `quickbooks-sync`** — when Intuit production keys exist: Customers/Invoices/Products
      boards, seed `qb_oauth_tokens` via the OAuth Playground, Intuit webhook
      `/webhooks/quickbooks`, Monday webhook `/webhooks/monday?secret=`. Not a cutover blocker.
- [ ] **9. `eventbrite-sync`** (post-cutover; the Summit backfill is due after Oct 22 sales) —
      add the `Eventbrite Order ID` text column and the `Refunded` Status label to the
      production Donations board (the label is also missing on sandbox v3, and `funraise-sync`
      shares it); fill `config/svbc.json` (all placeholders today); create D1 + queues; set
      fresh secrets; deploy; register the Eventbrite webhook; *then* run
      `scripts/backfill-orders.mjs` (`--dry-run` first). Sequence per
      [`eventbrite-sync/README.md`](../eventbrite-sync/README.md): deploy → register webhook →
      backfill, so no order falls in a gap. Provision the sandbox first.

## Phase 5 — First week

- [ ] Daily: every production DLQ empty. `donation-rollups`, `funraise-sync`, `mailchimp-sync`
      (both), `quickbooks-sync` and `eventbrite-sync` have a DLQ consumer; `member-portal` and
      `benevity-import` do not, so those need a human to look.
- [ ] Daily: D1 write usage per database, now that the Free cap is gone and nothing stops a loop.
- [ ] Each cron fired once and did what it should (Workers → Logs, or `wrangler tail`).
- [ ] Per-Worker CPU time well under the 100 ms cap.
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
  disable the Funraise/Mailchimp/Intuit webhook, or remove `member-portal`'s custom domain.
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
