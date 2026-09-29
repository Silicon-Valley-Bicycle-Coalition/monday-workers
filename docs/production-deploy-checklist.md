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
`quickbooks-sync`, `monday-backup`, `benevity-import`, `bp-feedback-notify`, and the
`salesforce-import` CLI. `svbc-calendars` isn't part of the migration and can ship on its own
schedule — its checklist is [its README's Deploy section](../svbc-calendars/README.md#deploy).

**Status as of 2026-09-29:** nothing below is done unless marked. `salesforce-import`'s
`cutoverDateISO` is `2026-10-09`.

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
      migrations 0001–0004, creates the `member-portal-letter-emails` queue + DLQ, sets
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
- [ ] **Raise the "Billing Budget Alert"** (Manage account → Notifications) above the $5 base
      subscription, or it fires immediately and means nothing.
- [ ] Confirm every Worker's `limits.cpu_ms: 100` is still present — it's the guard that matters
      once Paid's 30 s default applies.
- [ ] Resolve the open question whether rate-limit `namespace_id`s must be unique per account
      (sandbox design, Open items) before two Workers deploy with colliding ids.
- [ ] **Integration users and tokens, one per exposure class** (root README, "Least-privilege
      Monday tokens"). Create after the production workspace exists, scope before minting:
  - [ ] `member-portal` — its own user, read access to only the boards it reads.
  - [ ] Staff-facing sync Workers (`funraise-sync`, `donation-rollups`, `mailchimp-sync`,
        `benevity-import`, `quickbooks-sync`) — `donation-rollups`' README notes its dedicated
        token is "scheduled for production cutover".
  - [ ] `monday-backup` — view access to every workspace.
  - [ ] Never a staff member's personal token.
- [ ] **Mail domain:** `mail.bikesiliconvalley.org` onboarded for Email Sending, DMARC record in
      place (`member-portal/DEPLOY.md` Phase 2–3). `bp-feedback-notify` reuses it.
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
| `member-portal` | exists | `member-portal-change-requests`, `member-portal-letter-emails` | create queues; apply 0001–0004 |
| `funraise-sync` | exists, 0001–0003 applied | `funraise-sync-writes` | apply 0004 (subscriptions ledger) |
| `donation-rollups` | exists (kept through the §9 move) | `donation-rollups-recompute` | confirm 0001–0008 applied |
| `mailchimp-sync` | **create** — id is `REPLACE_WITH_D1_DATABASE_ID` | `mailchimp-sync-outbound`, `mailchimp-sync-inbound` | create D1 + queues; wire id; apply 0001–0004 |
| `quickbooks-sync` | **create** — placeholder id | `quickbooks-sync-writes` | create D1 + queue; wire id; apply 0001–0002 |
| `monday-backup` | **create** — placeholder id | — | create D1; wire id; apply 0001 |
| `benevity-import` | exists | `benevity-import-writes` | create queues; apply 0001 |
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
| `mailchimp-sync` | `MONDAY_API_TOKEN`, `MAILCHIMP_API_KEY`, `MONDAY_WEBHOOK_SECRET`, `MAILCHIMP_WEBHOOK_SECRET` |
| `quickbooks-sync` | `MONDAY_API_TOKEN`, `QB_CLIENT_ID`, `QB_CLIENT_SECRET`, `QB_WEBHOOK_VERIFIER_TOKEN`, `MONDAY_WEBHOOK_SECRET` |
| `monday-backup` | `MONDAY_API_TOKEN`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`, `SLACK_WEBHOOK_URL` |
| `benevity-import` | `MONDAY_API_TOKEN`, `BENEVITY_WEBHOOK_SECRET` |
| `bp-feedback-notify` | `WEBHOOK_SECRET` |

Webhook secrets must be **fresh production values**, never the sandbox ones.

- [ ] **Workers Builds:** each Worker has a production connection (root directory =
      its subdirectory, deploy command `npx wrangler deploy`, branch `main`) alongside its
      sandbox connection (root README, "Deploys"). Until a Worker's production config is real,
      keep its production connection off — otherwise the next merge to `main` deploys it with
      null board ids.

## Phase 3 — `salesforce-import` production load

Everything downstream needs the board ids this run creates.

- [ ] Salesforce data freeze started (private plan, Cutover Safeguards).
- [ ] Fresh Mailchimp consent export (`salesforce-import/README.md`).
- [ ] `config/svbc.json` switched to the production workspace and suffix.
- [ ] `extract` → `geocode` → `transform` → `load --dry-run` → `load` → `validate --live`.
- [ ] **Keep the run's `data/` directory** (ledger, payloads) — `donation-rollups`' bootstrap
      reads it, and it's gitignored, so `git worktree remove` silently destroys it.
- [ ] Go/no-go against the rollback threshold. No-go = don't cut over; Salesforce is untouched.
- [ ] Record every production board id, column id, and workspace id in one place for Phase 4.

## Phase 4 — Production config and deploy, in dependency order

For each Worker:

1. Fill `config/svbc.json` (or `production.json`/`backup.json`) with the Phase 3 ids — no
   `REPLACE_WITH_*`, no null board ids left for features you mean to enable.
2. `npm test && npm run typecheck` (split test proves no sandbox id leaked in).
3. Merge, then deploy: `npm run deploy` from `main` for the first deploy. (Merging alone deploys
   nothing but `svbc-calendars` until the Workers Builds item above is done — root README, "Deploys".)
4. Register its inbound feeds.
5. Run its verification before starting the next Worker.

Order matters: `donation-rollups` must be listening before anything writes Donations.

- [ ] **1. `donation-rollups`**
  - [ ] Config: Donations board id, owner boards, custodian workspace/alert/annual-summary ids,
        affiliations.
  - [ ] Owner/affiliation columns and annual summary board (`scripts/setup-owner-columns`,
        `setup-affiliation-columns`, `setup-annual-summary-board`).
  - [ ] Bootstrap links and gifts from the Phase 3 artifacts (`bootstrap-links-from-artifacts`,
        `bootstrap-gifts-from-artifacts`).
  - [ ] Monday webhooks via `scripts/setup-webhooks` → `/webhooks/monday/donations?secret=`.
  - [ ] Verify: edit one test gift, see the owner's rollups recompute; `/custodian/status` clean.
- [ ] **2. `funraise-sync`**
  - [ ] Config: Donations, Recurring Gifts, People boards + all `subscriptionsPoll.columns`,
        and a real `entityIdColumn` (adopt-before-create; the split test requires it, and
        without it the Worker duplicates migrated gifts).
  - [ ] Bootstrap the subscriptions poller locally *before* the deployed cron can fire
        (`funraise-sync/README.md`, `wrangler dev --remote --test-scheduled`).
  - [ ] **Repoint Funraise's single webhook** from the `-sandbox` Worker to
        `/webhooks/funraise/transaction?secret=` on production. The sandbox loses its Funraise
        feed from here on — expected.
  - [ ] Reconcile Funraise transactions dated between the Salesforce export and this step
        against the Donations board; nothing else catches gifts in that gap.
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

## Phase 5 — First week

- [ ] Daily: every production DLQ empty (only `donation-rollups`' DLQ has a consumer — the rest
      need a human to look).
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
- Whole-migration rollback (before Salesforce retires) is governed by the private plan's
  threshold, not by any one Worker.
