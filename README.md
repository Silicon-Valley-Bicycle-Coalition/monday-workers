# SVBC Cloudflare Workers

The custom backend builds for [Silicon Valley Bicycle Coalition](https://bikesiliconvalley.org/)'s
Salesforce → Monday.com CRM migration, one subdirectory per Worker. Each has its own `README.md`
with the requirements needed to build it — the ask, data flow, APIs and auth, Monday.com targets,
build shape, and open questions.

**Staff UAT scripts live in [`docs/uat/`](docs/uat/README.md)**: one plain-language script per
Worker and one for the Monday boards themselves, saying what a non-technical tester can try in
the sandbox and what they should see. The migration's own data-validation UAT (the sample
review) stays in the private planning repo; everything that keeps running after cutover is
tested from here. When a Worker's sandbox behaviour changes, update its script in the same merge
request.

**Open-sourced so other nonprofits can fork and redeploy** any of these against their own
Monday.com/CRM setup. When building, avoid hardcoding SVBC-specific values (board IDs, field
names, city lists) where a config value or environment variable would do — another org's fork
should be a config change, not a rewrite.

References in these READMEs to `migration-plan.md` and `docs/*` point at SVBC's **private
planning repo** — the full migration plan and the Salesforce data-survey documents behind these
requirements. They contain SVBC-internal operational detail and aren't published; each Worker's
README here is written to be buildable without them, and the private references mark where deeper
SVBC-specific background exists.

Shared stack, used by every Worker here unless its README says otherwise: **Hono + TypeScript +
D1** (`npm create cloudflare@latest`), secrets via `wrangler secret put`, deployed to SVBC's
existing Cloudflare account. This is the default pattern set in the plan's Guiding Philosophy
(build over subscription) and repeated build-for-build rather than restated per worker.

**Least-privilege Monday tokens, also shared across every Worker here:** a Monday personal API
token carries the full permissions of the user who minted it, so a compromise of any one Worker
exposes everything that user can see. No Worker holds a Monday token of its own. SVBC uses **one
dedicated integration user, SVBC Integration** (a CRM seat and a Work Management seat), which
authorizes **three Monday OAuth apps** (Portal, Staff sync, Read-only) with different scopes. The
[`monday-auth`](monday-auth/README.md) broker Worker holds their client credentials and tokens and
hands short-lived access tokens to the other Workers over service bindings; each Worker's binding
(`PortalToken`, `SyncToken` or `ReadOnlyToken`) decides which app it can reach, so the public
`member-portal` can only ever hold a read-only token with no write scopes. No consumer Worker has a
`MONDAY_API_TOKEN` secret. Never ship a staff member's personal token into a Worker secret.

Accepted risk: one user means the internet-facing `member-portal`'s token can **read** every board
SVBC Integration can see, not only the ones the portal displays (the alternative, its own user,
costs a CRM seat). Its writes can't happen at all: the portal only queues change requests, which
the `member-portal-writer` Worker (`SyncToken`) applies. Deploy `member-portal` first, then
`member-portal-writer`: Cloudflare Queues allows one consumer Worker per queue, so the queue's
old consumer (the sandbox portal) must be detached before the writer is published, and change
requests wait in the queue in between. Production never had a portal consumer, so either order
works there. Because the read exposure is accepted, board privacy still
matters: before production consent, remove the integration user from private boards it doesn't
need (measured in the sandbox, its token saw 12 private boards outside the sandbox workspace), and
make the donor boards private (see "Making the production donor boards private" below).

Sandbox is the same shape with its own pieces: the existing **Sandbox Integration** user authorizes
a separate set of three sandbox apps through the sandbox broker (`svbc-monday-auth-sandbox`);
production's apps cannot be reused there. Setup, consent and re-consent are in
[`monday-auth/SETUP.md`](monday-auth/SETUP.md); the design and the sandbox verification results are
in [the broker design](docs/superpowers/specs/2026-10-30-monday-oauth-broker-design.md). The
sandbox design's [section 4](docs/superpowers/specs/2026-09-18-sandbox-environment-design.md) predates the broker.

**Mute the integration users' Monday email.** Monday emails a user every time someone subscribes
them to a board, so setting up sandbox boards sends a burst of "[You're subscribed]" mail to the
Sandbox Integration address (a plus-alias of an operator's inbox). No Worker sends these and the
API has no switch for them: sign in to Monday as the integration user and turn the email
notifications off under the profile's Notifications settings, or filter that subject in the
receiving mailbox. Keep any mail filter that narrow, because sign-in and verification mail for the
user arrives at the same address. Subscribe an integration user only to the private boards its
Workers need; it already reaches every Main board without being subscribed (#18, below).

**A Monday user's "access" is wider than it looks — measure a token before calling it scoped
(#18).** Monday shows every *Main* board in every open workspace to every team member, and by
default lets them edit it, whether or not they were ever added to the board or the workspace;
closed workspaces are Enterprise-only. So on SVBC's Pro plan a member user cannot be limited to
one workspace of Main boards. Measured 2026-09-30, before the broker: the Sandbox Integration user belongs to no
workspace at all and still reaches 212 active boards outside the CRM Sandbox, 199 of them
editable — the design's "a production board id in a sandbox config fails with
`USER_UNAUTHORIZED`" does **not** hold. The same applies to SVBC Integration:
"access to only the boards it reads" is true only of boards created **private** (or shareable,
for a guest user). Until boards are restricted that way, what keeps a sandbox Worker off
production is each Worker's `config/split.test.ts` (the two configs share no id) and
`monday-backup`'s `workspaceIds`, not the token. To see what a token really reaches:

```sh
MONDAY_API_TOKEN=... node scripts/check-monday-token-scope.mjs --workspace 18210301
```

(`MONDAY_API_TOKEN` here is the operator tool's own environment variable, not a Worker secret. The
broker never returns a token over HTTP; to measure an app's token as the broker holds it, use its
`/oauth/probe/:app` scope check, which is on in sandbox and off in production unless `PROBE_ENABLED`
is set to `true` for the check — see [`monday-auth/README.md`](monday-auth/README.md).)

It exits non-zero and lists the workspaces if the token reaches any board outside the ones named.

**Making the production donor boards private (#41).** `salesforce-import` creates its boards
`board_kind: public`, so after the cutover load every member token reaches and can edit them.
Do this **after the load and before any Worker's production deploy**:

1. Rehearse on a sandbox board first (dry run, then `--apply` on one throwaway board). The
   script selects archived and deleted boards too (#71), so include one archived throwaway board:
   `change_board_kind` on a non-active board hasn't been exercised yet.
2. Dry run against production: `MONDAY_API_TOKEN=... node scripts/make-boards-private.mjs
   --workspace <id> --prefix "<board name prefix>" --sandbox-user <Sandbox Integration user id>`.
   It lists each matching board's kind, subscribers and team subscribers and changes nothing.
   Use the load user's or an admin's token, not a Worker integration user's.
3. Re-run with `--apply`. It calls `change_board_kind(board_id, kind: PRIVATE)` on API version
   `2026-10` (the only call that overrides the pin below; the mutation doesn't exist in `2026-07`)
   and re-reads the boards to confirm. (`update_board` cannot do this; its `board_attribute` has
   no `board_kind`.) **As of 2026-11-02 `--apply` has never succeeded on SVBC's account:** Monday
   answers `USER_UNAUTHORIZED` even to an admin's personal token on a public board that same user
   just created. The production boards were made private in the Monday UI. If `--apply` fails
   that way, change each board's kind in the UI, then re-run the dry run to confirm.
4. In Monday, subscribe the staff team, and SVBC Integration to **only** the
   boards its Workers read or write. The script reports subscribers; it does not add them.
   The Sandbox Integration user must be on none (`--sandbox-user` makes the script exit 1 if so).
5. Measure every token with `check-monday-token-scope.mjs` and record the result. A token is not
   "scoped" until that has been run against it.

**One Monday `API-Version` pin, also shared:** every Worker sends the `MONDAY_API_VERSION`
constant from its copy of the shared GraphQL transport (`src/monday/graphql.ts`, currently
`2026-07`) and never overrides it for ordinary calls; the two clients without a transport copy
(`salesforce-import`, `bp-feedback-notify`) carry an explicit literal of their own. Monday serves
a request for a *deprecated* version as the maintenance version rather than erroring, so an old
pin drifts silently onto an API version nothing was tested against. Bump the constant at least
every two quarters (Monday rolls versions on Jan 15, Apr 1, Jul 1 and Oct 1), re-run every
Worker's tests, and confirm with `{ version { value kind } }` that the pinned version is still
served as itself — see #39.

## Status at a glance

For the picture version, see [`docs/systems-map.html`](docs/systems-map.html): one row per
Worker (upstream system, trigger shape, where the data lands), the shared webhook → D1 → Queue
reliability pattern, and a sandbox/production state table. It is a self-contained HTML page, so
open it in a browser. Keep it in step with this table — it carries an "as of" date in its header.

| Worker | Status | Priority |
|---|---|---|
| [`monday-auth`](monday-auth/README.md) | **Production deployed 2026-10-31** (cutover step 0.4) and consented as SVBC Integration the same day; latest production deploy 2026-11-09 (version `3b31d518`). Sandbox verified 2026-10-31. The #104 hardening (rate-limited `/oauth`, encrypted token columns, trimmed `/health`) and `limits.cpu_ms` (#117) are merged but not deployed: each environment needs a `TOKEN_ENC_KEY` secret first ([README](monday-auth/README.md), "Secrets"). | Migration-blocking: every Monday-writing Worker gets its token here |
| [`salesforce-import`](salesforce-import/README.md) | Built (merged). **Production config targets the Donors & Contacts workspace (18201685) since 2026-10-26** (3fcaa80, merged !235), and the production boards exist: `donation-rollups`' production config took its board ids from this tool's production load (`boards.json`) on 2026-11-01 (1526652). This repo doesn't record the production load's run dates or its `validate` results. History: full pipeline rehearsed against the **sandbox v2** workspace (2026-08-28, resume 2026-09-08 — monday-migration `docs/18` §9); **batched load re-rehearsed 2026-10-09 → 12** (!211): 27 h 51 min against a ≈ 26.7 h projection, `validate --live` 18 OK / 2 FAIL (the two pre-existing `recon-funraise-*` checks); `configure` builds Find views and an Overview dashboard on each of the 12 CRM boards (!216, !217, merged 2026-10-20), and the importer stamps `Eventbrite Order ID` on migrated ticket gifts (2026-10-19) | **Blocking.** Central migration deliverable — the production load was the cutover |
| [`funraise-sync`](funraise-sync/README.md) | **Production:** every id in `config/svbc.json` filled 2026-11-01 for Donations, Recurring Gifts and People in workspace 18201685 (aa45bb1); production's first Worker-written gifts came from it on 2026-11-02 (`donation-rollups/README.md`, Acknowledgment Tier backstop). This repo doesn't record when Funraise's webhook was repointed from the sandbox Worker to production. **Sandbox:** `svbc-funraise-sync-sandbox` since 2026-09-19; its `config/sandbox.json` still names the `(sandbox v3)` Donations board (18431577310), not CRM Sandbox v4. History: first deployed and proven end to end 2026-09-18 (route → D1 → queue → consumer, Funraise webhook registered and Enabled, re-proven with its Test button); hourly Recurring Gifts poller built 2026-09-18 and bootstrapped 2026-09-19 (1,175 subscriptions mirrored; design [`docs/superpowers/specs/2026-09-18-funraise-subscriptions-poller-design.md`](docs/superpowers/specs/2026-09-18-funraise-subscriptions-poller-design.md)); remapped to `(sandbox v3)` 2026-09-30 (ledger rebuilt, 53 held gifts re-driven — README "Rebuilt boards"); write switch rehearsed in the sandbox 2026-10-27/28 (hold → on → off; README "Deploying: the write switch"). | Blocking (feeds the import) |
| [`quickbooks-sync`](quickbooks-sync/README.md) | **Postponed indefinitely (decided 2026-10-28)** — not shipping at migration. Sandbox write switch set `off` 2026-10-28 (production was already `off`) and its `deploy-sandbox` CI job removed; the code, tests and CI test job stay so it can be picked up again. History: built (merged) — production not deployed; needs real board ids. The Intuit app-review question is resolved 2026-09-21 (a private single-company app still needs Intuit's ~40-minute self-assessment questionnaire, but not the full app-store review). Has a **sandbox environment** on Intuit's sandbox host, deployed as `svbc-quickbooks-sync-sandbox` (by hand — `npm run deploy:sandbox`; merging does not deploy it, see "Deploys"). **D1 and queues provisioned and verified 2026-09-22**: `svbc-quickbooks-sync-sandbox` D1 (id wired 2026-09-20) had a pending migration (`0002_qb_events_pending_monday_item_id`, added 2026-09-21) that had never actually run against it — closed today, both migrations now applied and confirmed via schema check; both queues (`quickbooks-sync-writes-sandbox` and its `-dlq`) confirmed provisioned; config split test, typecheck, unit tests, and a `wrangler deploy --dry-run --env sandbox` all pass. **`MONDAY_API_TOKEN` and `MONDAY_WEBHOOK_SECRET` set 2026-09-22** (the former reuses the shared `Sandbox Integration` user already used by the other sandbox Workers; the latter's local copy is lost, so regenerate and re-set it when the Monday webhook is registered). **Sandbox Customers/Invoices/Products boards created and wired 2026-09-29.** **Still blocked** on staff-side prerequisites before it can process anything live: an Intuit sandbox company and development keys, and a token pair seeded via the OAuth Playground (`QB_CLIENT_ID`/`QB_CLIENT_SECRET`/`QB_WEBHOOK_VERIFIER_TOKEN` remain unset) — see [the sandbox design](docs/superpowers/specs/2026-09-18-sandbox-environment-design.md) **Sandbox redeployed from `main` 2026-10-09** (canonical Monday transport, dead-letter retry delay after a D1 failure, production D1 id wired); no D1 migrations were pending. | Postponed indefinitely — not part of cutover |
| [`svbc-calendars`](svbc-calendars/README.md) | **Deployed and live** in production at `events.bikesiliconvalley.org` / `committees.bikesiliconvalley.org` — the one Worker here with a Workers Builds connection, so every merge to `main` redeploys it (verified 2026-09-28). See [svbc-calendars/README.md](svbc-calendars/README.md)'s Deploy section for how it was set up. **Its `.ics` feeds depend on a WAF custom rule in the Cloudflare zone** — added 2026-10-02 to exempt `GET /calendars/*.ics` on both hostnames from Super Bot Fight Mode, which had been serving calendar clients a managed-challenge page since 2026-09-25; the rule lives in the dashboard, not in this repo, so see that README's Deploy step 7 for the expression and how to check it is still in place. Merged 2026-08-27 from `events-widgets`, `committee-calendars`, and the standalone `bike-calendars` project (history: see [the merge design doc](docs/superpowers/specs/2026-08-27-events-bike-calendars-merge-design.md)) | Not migration-related; predates this repo |
| [`member-portal`](member-portal/README.md) | Code-complete through v8, plus the donor-supplied employer (v4.1, #127; the writer now also writes Affiliations). **Production config filled 2026-11-02** (813261b, !299: People, Donations, Organizations and Volunteers ids in workspace 18201685); this repo doesn't record a production deploy yet. Remaining `config/svbc.json` placeholders are feature gates, not deploy blockers (opt-out and language columns, the Change Requests board, letters, event registrations, pledges, renew URL — see its README). The deploy order is the `monday-auth` broker first, then the portal, then `member-portal-writer` ([DEPLOY.md](member-portal/DEPLOY.md)). **Sandbox** live at `member.sandbox.bikesiliconvalley.org` since 2026-09-22, emailing only `sandbox@bikesiliconvalley.org` ([the sandbox design](docs/superpowers/specs/2026-09-18-sandbox-environment-design.md)); its `config/sandbox.json` still names the `(sandbox v3)` Donations board (18431577310). | Post-migration, non-blocking (Membership dependency resolved 2026-08-21) |
| [`mailchimp-sync`](mailchimp-sync/README.md) | Built — repurposed from the never-deployed `membership-reminders` (2026-08-26). **Production deployed and writing, outbound only** (since at least 2026-11-14). **Hourly consent column sync built 2026-11-16** ([design](docs/superpowers/specs/2026-11-16-mailchimp-consent-columns-design.md)): keeps Personal, Household and Work Email Consent at Mailchimp's status; on in the sandbox, `consent.enabled: false` in production until David's go-ahead. **Sandbox provisioned and verified 2026-09-22** (`npm run deploy:sandbox`, `config/sandbox.json`) against a live "SVBC Sandbox" Mailchimp audience that may only write to a sandbox audience — see [the sandbox design](docs/superpowers/specs/2026-09-18-sandbox-environment-design.md) | Post-migration, **time-sensitive** — newsletter segmentation and both membership email journeys depend on it once Salesforce retires |
| [`donation-rollups`](donation-rollups/README.md) | **Sandbox moved to the CRM Sandbox v4 workspace (18210301) 2026-10-28** (4fe2c97, !251: boards, rollup/classification/membership/affiliation columns and a new Annual Giving Summary board; recompute consumer to batch 10, concurrency 3), recurring duty turned on there (be736a6). **Production config filled 2026-11-01** from `salesforce-import`'s production load (1526652), with the private Donor Roll Call board added 2026-11-02 (fdba786); this repo doesn't record a production deploy yet. Since 2026-10-28: the donor roll call board, an Acknowledgment Tier nightly backstop (3190fe6) and trashed gifts/owners treated as gone (535a390). **The sandbox is split:** five other Workers' sandbox configs still name the `(sandbox v3)` Donations board, so their sandbox gifts don't reach the v4 board this Worker watches. History: live in the sandbox since 2026-08-31 (sandbox v2, then `(sandbox v3)` from 2026-09-29); D1's Free-tier write cap stalled it twice (README "operational findings, 2026-09-17"), lifted by Workers Paid (2026-09-29); activity-based membership rule 2026-10-11 (!213); webhook deletions fixed 2026-10-12 (!214, `a27a0bc`) — production must run a build at or after it. | Post-migration, non-blocking — `salesforce-import` ships correct initial values; this Worker keeps This/Last Year, Largest/Smallest/Average, and Last Gift from going stale afterward |
| [`monday-backup`](monday-backup/README.md) | **Production deployed 2026-11-03** from `main` (e4f0678, version `43d05351`) with both crons, `writes on` and the production Shared Drive destination; Monday access through the `monday-auth` broker's `ReadOnlyToken`. **Workers Builds connected 2026-11-03** (`main` only, previews off, watch path `monday-backup/*`); no build had run as of then. **The first 09:00 UTC run (2026-11-04) captured 19 of about 262 boards**, because a complete run takes longer than a cron gets, so the snapshot now runs as a Workflow ([design](docs/superpowers/specs/2026-11-04-monday-backup-complete-snapshot-design.md)). **First complete snapshot 2026-11-04 (run 3): 264 boards, 24 docs, no errors.** **Production Slack alerts verified 2026-11-03/04** (real usage and partial-backup alerts delivered); moved to a private staff channel 2026-11-04 (#52). **`svbc-monday-backup-sandbox` has been deployed since 2026-09-22** with its own D1 and the sandbox Monday token, but has never completed a backup: `config/backup.sandbox.json`'s destination folder is still a placeholder and the Google service-account and Slack secrets are unset. Ships a restore CLI ([`RESTORE.md`](monday-backup/RESTORE.md)); the sandbox restore rehearsal is pending #14. Has a **sandbox environment** (`npm run deploy:sandbox`, `config/backup.sandbox.json`) that snapshots the sandbox workspace into a separate Drive folder — see [the sandbox design](docs/superpowers/specs/2026-09-18-sandbox-environment-design.md) **Sandbox redeployed from `main` 2026-10-09** (typed `MondayApiError` transport, production D1 id wired); no D1 migrations were pending. | Post-migration, non-blocking, but time-relevant once real donor data lives in Monday with no Salesforce copy to fall back on |
| [`benevity-import`](benevity-import/README.md) | **Deployed to production 2026-11-02** (ddfccfe; production config 97267bc), `writes on`: `Benevity Uploads` board and a `Benevity Disbursement Date` column on Donations created that day, both Monday webhooks (upload and Retry) registered. No report has been uploaded to production yet. **Sandbox** verified end to end 2026-09-19, remapped to `(sandbox v3)` and re-verified 2026-09-30, redeployed 2026-10-19 with the Retry and Key columns and Retry webhook; its `config/sandbox.json` still names the `(sandbox v3)` Donations board. Needs two `salesforce-import` column changes (see its README). | Post-migration, non-blocking — staff can keep hand-entering matches on the board meanwhile |
| [`dtd-sync`](dtd-sync/README.md) | **Built, sandbox not yet deployed** (2026-11-03; design [`docs/superpowers/specs/2026-11-03-dtd-sync-design.md`](docs/superpowers/specs/2026-11-03-dtd-sync-design.md)): hourly pull of Double the Donation match status onto Donations and People, push of eligible non-Funraise gifts to DTD, Matching Donation pairing, nightly Matching Gift Program summary. Columns created on CRM Sandbox v4; production ids still placeholders. Needs the rotated `DTD_PRIVATE_KEY`, D1 migrations and a deploy (README "Operator setup") | Post-migration, non-blocking — donors outside Funraise get no matching-gift prompt until it ships |
| [`eventbrite-sync`](eventbrite-sync/README.md) | **Deployed: sandbox 2026-10-26, production 2026-11-02** (its README "Deploy"; production config and D1 c579d0d, !291). Pledge to Ride board and dashboard built, not yet configured (its README "Pledge to Ride"). Paid Eventbrite orders → Donations items (Status `Received`, Gift Type `Event Ticket`, buyer matched on People by email; refunds → `Refunded`); design [`docs/superpowers/specs/2026-10-06-eventbrite-orders-design.md`](docs/superpowers/specs/2026-10-06-eventbrite-orders-design.md). Production's order path is filled (`Eventbrite Order ID` `text_mm8n459q`, stamped on migrated ticket gifts by `salesforce-import`); its attendee feed is configured (2026-11-03; class emails go through the send page, not yet deployed) and its webhook is registered, with the 17 live upcoming events backfilled. The production order webhook was registered the same day; the 8 orders placed before that were all $0. **The sandbox order path can't write yet:** `orderIdColumn` in `config/sandbox.json` is `REPLACE_WITH_COLUMN_ID`. Its README doesn't record whether the `Refunded` label (shared with `funraise-sync`) has been added. Ships `scripts/backfill-orders.mjs` for the gap between the final extract and the webhook registration; never backfill an event that sold tickets before 2026 **Grant report built, not deployed (2026-11-06):** a validated Home Zip per registration, off until `homeZipColumn` is set; Grant and the report view are Monday-side setup (its README "Grant report"). | Post-cutover — takes every Eventbrite order after the final extract |
| [`bp-feedback-notify`](bp-feedback-notify/README.md) | **Live in production 2026-11-03**: writes on, `Post-Event Feedback` column and webhook automation on the live `BP Request Form` board, handshake answered 200; no real item has gone through it yet. **Sandbox confirmed working end-to-end 2026-09-21** (`svbc-bp-feedback-notify-sandbox`): a real status change on `BP Request Form (sandbox)` fired the webhook and the email reached the sandbox sink. Optional Sent/Failed write-back to the item ships disabled (`sendStatus: null`) **Sandbox redeployed from `main` 2026-10-09** (send-outcome logging with redacted recipients, background status write-back, Workers Issues); no D1 migrations were pending. | Post-migration, non-blocking — closes the Organizer Feedback Form gap; nothing depends on it |
| [`people-reclassification`](people-reclassification/README.md) | **Live in production and sandbox, writes on** (2026-11-03). Sandbox: one live move, then a full pass of 400 moves verified, 0 failed. Production: first live pass 2027-01-01, quarterly; its dry run planned 400 aged-out moves. Board limit is **100,000 items** (decided 2026-11-03; it was sized against 10,000). The periodic pass the plan's "Still open" first bullet asks for: moves People items whose latest activity (Last Gift Date, Member Until, counted event registrations, volunteer hours; Lifetime members and Funraise-linked people never age out) is outside a rolling **7-year** window to People (Historical), and reactivated Historical people back — daily cron that fires a pass on the first of each quarter, when People crosses 85% of the ceiling, or to continue unfinished work; `POST /reclassify/run` on demand. Every write is **dry-run** until the write switch (`people-reclassification:writes`) is `on`; a D1 ledger records every decision. Warns (and optionally raises an IT Requests item) when Historical nears its own ceiling. Staff can promote someone from their item, and a logged call or meeting brings someone back by the next morning (built, not deployed). | Post-cutover, non-blocking — both People boards are at ~8% of the 100,000-item limit; this keeps People to the last seven years of activity |
| [`contact-roles`](contact-roles/README.md) | **Built, not deployed; no live Monday write has been run** (2026-11-11; design [`docs/superpowers/specs/2026-11-11-organization-contact-roles-design.md`](docs/superpowers/specs/2026-11-11-organization-contact-roles-design.md)). Stateless 10-minute cron that rewrites a read-only `Contacts` column on opportunity boards from confirmed `SVBC Roles` on Current Affiliations (no D1, no queue). Production enabled: Sponsorships and Donations; Grants & Contracts, BP Request Form, Bike Education Lifecycle Tracker and Leads stay disabled until each has an Organization link. Ships **off** (`contact-roles:writes` unset); sandbox rollout and smoke tests come first (its README "Deploy order and rollout checklist"). | Post-migration, non-blocking — staff keep opportunity contacts by hand until it ships |
| [`impact-attribution`](impact-attribution/README.md) | **Built, not deployed; no live Monday write has been run** (2026-11-16, #125; design [`docs/superpowers/specs/2026-11-16-employer-affiliation-proposals-design.md`](docs/superpowers/specs/2026-11-16-employer-affiliation-proposals-design.md)). Nightly cron that proposes a **Draft** Affiliation (Current or Former) when the same company has matched a person at least twice within 365 days, from a D1 match history bootstrapped from the import artifacts (archived gifts read empty on Monday). Ships **off**; production `on` waits on a reviewed `excludedPayers` list (its README "Operator setup"). The email resolver this Worker is named for is not built | Post-migration, non-blocking — employer data from matches otherwise never reaches Affiliations |
| [`report-digests`](report-digests/README.md) | **Deployed: sandbox 2026-10-26, deployed to production 2026-11-01 with writes on** (`svbc-report-digests-sandbox`, secrets set). The recent-gifts digest dropped its Windfall columns (committed 2026-11-06, deployed to production 2026-11-11; the old wealth digest was still sent 2026-11-09, see #81). Five scheduled email digests of Monday board views that replace the seven Salesforce report subscriptions still live in October 2026 (unmatched gifts, membership renewals, recent gifts of $400 and up, with no wealth-screening data, the fiscal year by gift size, last week's gifts). Hourly cron, Pacific schedules in config, recipients as Monday user ids. Why not Monday: scheduled dashboard email is Enterprise-only, and Pro's 5 scheduled PDF exports can't skip an empty run or join a donor's columns. Sandbox sends currently bounce at the sink mailbox (see its README). Every send is gated by the write switch (`report-digests:writes`); a digest due under `hold` is not caught up | Done at cutover: it replaced the Salesforce subscriptions, which would have emailed frozen data from then on |
| [`member-map`](member-map/README.md) | **Production deployed 2026-11-03** (`map.bikesiliconvalley.org`, behind Access; sandbox on `map.sandbox.bikesiliconvalley.org`). Staff-only map of members over OpenStreetMap, shading the Census block groups where membership is thin (population gap, warm-lead gap, bike lane density), with an Equity Priority Communities outline and member dots linking to Monday. Weekly cron snapshot to private R2; privately geocodes people with no Lat/Lng; read-only (no write switch). Production deploys by hand (`npm run deploy`); CI deploys only the sandbox | Post-migration, non-blocking |
| [`nearby-search`](nearby-search/README.md) | **Built; sandbox rollout pending** (2026-11-02; design [`docs/superpowers/specs/2026-11-02-nearby-search-design.md`](docs/superpowers/specs/2026-11-02-nearby-search-design.md)). Staff-only map search for People, People (Historical) and Organizations near an address, intersection or road segment (OpenStreetMap), behind Cloudflare Access; confirming a search queues one results-board row per match and a Nearby label on each person, which `mailchimp-sync` syncs as a Mailchimp tag. Hourly Census geocode backfill for contacts without coordinates. Not deployed anywhere: needs D1/queues, the Access application, real board and column ids. Every Monday write is gated by the write switch (`nearby-search:writes`) | Post-cutover, non-blocking — replaces the Salesforce Bike-lane GIS proximity lookups |
| [`sponsor-outreach`](sponsor-outreach/README.md) | **Requirements only; setup script built, not yet applied** (2026-11-09; design [`docs/superpowers/specs/2026-11-09-sponsor-outreach-board-design.md`](docs/superpowers/specs/2026-11-09-sponsor-outreach-board-design.md)). Martha's yearly corporate sponsor emails, started from a Monday board: segments from 15 years of sponsorship history, Sponsor Contact affiliations with opt-outs excluded, sent through her Gmail like the event send page. `scripts/sponsor-outreach-setup.mjs` adds the columns, links the Sponsorships board to Organizations and marks prospects and contacts ([runbook](docs/runbooks/sponsor-outreach-setup.md)). The board, Worker and send page wait on Martha's review and on `mailchimp-sync`'s consent column sync going on in production (built 2026-11-16) | Post-cutover, non-blocking — replaces the Salesforce report and spreadsheet mail merge |

Two related builds are **deliberately not Workers**:

* **[`geo-filter`](geo-filter/README.md)** — "contacts near a point or corridor," generalized
  2026-09-21 from the original bike-lane-specific design (svbc-monday-migration#24) into zip,
  radius, and arbitrary-corridor modes for any campaign. Explicitly scoped as "a one-off
  TypeScript script (Node.js), not standing infrastructure," run on request per project. Only
  worth wrapping as a persistent Worker if it becomes a frequent, recurring ask. See "Bike-lane
  GIS proximity" in the plan for the original design this generalizes.
* **Per-contact bike-lane map** — a static Leaflet.js + CyclOSM page with no backend logic, hosted
  on **Cloudflare Pages**, not a Worker. See "Mapping a contact relative to bike lanes" in the plan.

## Reliability: webhook ingestion and retries

**A gap in every webhook-driven Worker's design as originally written, caught by an outside
reviewer, not found internally:** a failed `fetch()` to Monday's API — a rate limit, a transient
5xx, a network blip — just dies. Nothing in a plain Cloudflare Worker retries it automatically.
Each webhook-driven Worker's Data Flow section described "ingest to D1, then a separate step
writes to Monday" as if that separation were itself a durability guarantee; it isn't — it only
means ingestion and matching can be *tested* independently, not that a failed *write* survives.

**Fix, now the standard shape for every webhook-driven Worker in this plan:** put a
[Cloudflare Queue](https://developers.cloudflare.com/queues/) between "event ingested into D1" and
"written to Monday." The webhook handler writes the deduped event to D1 as before, then enqueues a
message referencing it. A separate queue consumer does the actual Monday write. On failure,
Cloudflare Queues retries automatically and, once retries are exhausted (see "Outage retry" below
for this repo's policy), routes the message to a
[Dead Letter Queue](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)
instead of silently discarding it — so a persistent failure becomes a visible backlog someone can
inspect and replay, not a donation that quietly never reached Monday.

**Cost: effectively free at SVBC's volume.** Cloudflare Queues
[shipped on the Workers Free plan](https://developers.cloudflare.com/changelog/post/2026-02-04-queues-free-plan/)
in February 2026 — 10,000 operations/day included. SVBC's actual event volume (a few hundred
Funraise transactions a month, occasional QuickBooks events) is nowhere near
that ceiling; this is a genuine build-over-subscription fit, not a paid upgrade.

**Applies to:** `funraise-sync`, `quickbooks-sync` — every Worker driven by a webhook or firehose
with no natural retry of its own. Each Worker's own README notes this in its Data Flow section.

**Lower risk, but not risk-free: a Cron-polled Worker** self-heals on the next scheduled run if a
poll fails — no Queue needed there. But its D1 "last processed" cursor must only advance **after**
a confirmed Monday write, never before — otherwise a failed run silently skips whatever it was
supposed to process that cycle, with nothing to retry it and nothing telling anyone it happened.
Worth a Slack-automation ping (native, no build) on repeated failure, not just silent
retry-next-cycle. (`svbc-calendars`'s cron is a KV-fallback warm, not a Monday write, so this
invariant doesn't apply there — it's documented here as the general pattern for any future
cron-polled, Monday-writing Worker.)

**`salesforce-import` is different — a one-time batch job, not an ongoing sync.** A Queue is the
wrong tool for a run that happens once and is already validated by repeated sandbox dry-runs (see
Migration Method). What it needs instead: retry-with-backoff on individual Monday API writes
within the script itself, and a log of which records failed so a partial run can be resumed rather
than restarted from zero. See that Worker's README.

## Webhook secrets in the URL (`?secret=`)

Funraise and Eventbrite webhooks can't send a custom header or a per-delivery signature this
repo can verify, and Monday signs only webhooks created by an app (below), so every Worker they
call authenticates the delivery by a shared secret embedded in the registered URL: `funraise-sync`, `eventbrite-sync`, `donation-rollups`,
`mailchimp-sync` (Monday and Mailchimp routes), `benevity-import`, `member-portal`'s letters
route, `people-reclassification`'s promote route, `quickbooks-sync`'s Monday route and
`bp-feedback-notify`. (Intuit signs its own
deliveries, so `quickbooks-sync`'s `/webhooks/quickbooks` has no `?secret=`.) Each route fails
closed while its secret is unset.

The accepted trade-off (#65): a URL secret lands wherever the full request URL is recorded —
above all Cloudflare's **Workers Logs** invocation records, which every Worker here keeps
(`observability.enabled`). Anyone who can read a Worker's logs in the dashboard, or holds an API
token with Workers observability or Log Share read, can read its webhook secret and forge
deliveries. Mitigations, in every such Worker:

- **Keep log access limited to people who could read the secret anyway.** As of 2026-10-28 the
  SVBC Cloudflare account has three members, all Super Administrators (who can already rotate
  any Worker secret); there are no read-only or log-only members. Before adding anyone below
  that level, give them a role without Workers observability or Log Share access, and never mint
  an API token with those permissions for a third party. Re-check the list under
  Manage Account → Members whenever staff change, and update this paragraph.
- **Never log `c.req.url`** (or the raw query string) in Worker code. Callers that *can* set
  headers — scripts, hand replays — use `X-Webhook-Secret` where the route accepts it, so their
  secret never reaches a URL.
- **Rotate if logs are ever shared or exported:** `wrangler secret put <NAME>` with a new value,
  then edit the URL at the sender (Monday subscriptions must be deleted and re-registered).
- A secret used only in a URL authenticates webhooks and nothing else. Operator endpoints take
  their own secret in a header (`Authorization: Bearer`, as `report-digests` does), not
  `?secret=`.

### Monday's signed webhook JWT (second factor, #110)

A Monday webhook created **by an app** (with that app's OAuth token) carries
`Authorization: <JWT>`, HS256-signed with the app's **Signing Secret**; one created with a
personal API token carries none. `donation-rollups` and `people-reclassification` verify it
after the URL secret (`src/mondayJwt.ts`, byte-identical in both: WebCrypto HMAC verify, HS256
only). Every app request is signed with the same secret, so the token is also bound to its use:
`accountId` (or `dat.account_id`) must equal config `monday.accountId` (26331880, the
`bikesiliconvalley` account, which holds both the production and sandbox boards; read with
`query { account { id } }`), `aud`, when present, must name the request's origin and path, and
`exp`/`nbf`/`iat` are checked when present with 60 s skew, refusing a lifetime (`exp - iat`) or
age over an hour. Monday's integration docs show `accountId`, `aud` (the endpoint URL), `iat` and
a 300 s `exp`, but its webhook docs don't list the claims, so `exp` and `aud` stay optional until a
live sandbox delivery shows them. A signing secret with no `monday.accountId` rejects everything.
The subscription challenge skips the JWT:
its echo has no side effect and the URL secret already gates it. Rollout is by config, so a
deploy ahead of the secret drops nothing:

| `MONDAY_SIGNING_SECRET` (secret) | `MONDAY_WEBHOOK_JWT_REQUIRED` (var) | Delivery without a JWT | Delivery with a JWT |
|---|---|---|---|
| unset | not `"true"` | accepted (URL secret only, as before) | accepted, not checked |
| set | not `"true"` | accepted, logged `delivery carried no Authorization JWT` | must verify, else 401 |
| set | `"true"` | 401 | must verify, else 401 |
| unset | `"true"` | 401 (fails closed) | 401 |

Operator path, per Worker and per environment (sandbox first):

1. Copy the Signing Secret of the app that will own the subscriptions: monday.com Developer
   Center → *SVBC Staff Sync* (the sandbox's own Staff sync app for `--env sandbox`) → Basic
   Information → Signing Secret. It is not the OAuth client secret (`SYNC_CLIENT_SECRET`).
2. `wrangler secret put MONDAY_SIGNING_SECRET` (add `--env sandbox` for the sandbox) in
   `donation-rollups/` and `people-reclassification/`. Any JWT that arrives is now checked.
3. Re-register the subscriptions as that app, through the monday-auth broker's
   `/oauth/webhooks/sync` route (the broker never hands its token out): turn the route on for one
   deploy, then run `setup-webhooks.mjs --prune <boards>` (donation-rollups) and
   `setup-promote.mjs --worker-url … --replace-webhooks` with `MONDAY_AUTH_URL` and `START_KEY`
   set. Steps in `monday-auth/README.md` "Re-registering webhooks". Until this is done,
   deliveries stay unsigned and the warning above keeps firing.
4. Confirm on a live sandbox delivery that the warning stops and nothing is rejected
   (`wrangler tail --env sandbox`, look for `JWT`). A `wrong-audience` or `wrong-account`
   rejection means Monday's webhook claims differ from its integration docs: fix the binding in
   `src/mondayJwt.ts` before production. If deliveries always carry `exp`, make it required there.
5. Then set `"MONDAY_WEBHOOK_JWT_REQUIRED": "true"` in that environment's `vars` in
   `wrangler.jsonc` and deploy. Keep `?secret=` as well: it gates the per-IP limiter exemption
   and costs nothing.

## Write switch: off / hold / on

Every Worker that writes to Monday (or sends email) reads a per-Worker mode from a shared
Workers KV namespace, `FLAGS`, so a migration or an incident can stop writes in seconds without a
deploy. Design: [`docs/superpowers/specs/2026-10-26-write-switch-design.md`](docs/superpowers/specs/2026-10-26-write-switch-design.md);
the migration procedure: [`docs/runbooks/migration-hold.md`](docs/runbooks/migration-hold.md).
In scope, fourteen Workers: `benevity-import`, `bp-feedback-notify`, `contact-roles`, `donation-rollups`, `dtd-sync`,
`eventbrite-sync`, `funraise-sync`, `mailchimp-sync`, `member-portal`,
`monday-backup`, `nearby-search`, `people-reclassification`, `quickbooks-sync` and
`report-digests` (`svbc-calendars` excluded).

| Mode | Behaviour |
|---|---|
| `on` | Write normally. |
| `hold` | `member-portal` is donor-visibly unavailable under `hold`, `unknown` and `off`: login, change-request and card-regenerate POSTs render a 503 "temporarily unavailable" page (reads still work). Write nothing and keep the work: queue consumers retry, the Worker's main queues are paused, crons skip (their cursors do not advance). Leaving `hold` with `on` writes everything that queued up. |
| `off` | Write nothing, log what would have been written (dry run). Pollers' cursors advance, so what they would have fetched is skipped for good. Work ingested under `off` is stamped `dropped` and is **never** written later, even after a flip to `on`. |

**Keys** (KV namespace `FLAGS` in production, `sandbox-FLAGS` in the sandbox; both bound as
`FLAGS`): `<worker>:writes` is `on`, `hold` or `off`; `<worker>:log` set to
`debug` adds redacted payloads (names, emails, phones and addresses masked, free text as length
only) to the skip lines. `<worker>` is the directory name. **A missing key, or any other value,
reads as `off`; a KV read error is `unknown` and behaves like `hold`** (never write, retry, crons
skip). Reads are edge-cached for 30 s, so a flip takes up to that long to reach a warm location.
`bp-feedback-notify` has no queue: under `hold`/`unknown` it returns 503 and only Monday's own
retries apply, so a request fired mid-migration may need re-triggering by hand. Both
`benevity-import` routes also return 503 under `hold`/`unknown` (repeat the upload or Retry after
the flip). A `member-portal` letter queued under `hold` but consumed under `off` stays stranded
as `queued` until a staff re-click — one more reason to leave `hold` with `on`.

**Set `on` before deploying.** Because a missing key is `off`, set `<worker>:writes on` for every
Worker that should keep writing *before* deploying the build that reads the switch (otherwise, for
example, `member-portal` login returns 503). CI deploys the sandbox from `main`, so the first time:
create the namespaces, put the sandbox keys `on` (with the real ids filled in locally), and only
then commit the real ids — the runbook's "Merging / first deploy sequencing" has the steps. Set
keys one Worker at a time, **never `all writes on`**: `contact-roles` stays `off` until its dry-run counts have been checked and its sandbox smoke tests pass, `people-reclassification` stays `off` until
its staged one-item live check passes, and `donation-rollups` goes `on` only after its webhooks
are subscribed.

**Operator CLI** (`scripts/flags.mjs`, shells out to `npx wrangler`; run from the repo root):

```sh
node scripts/flags.mjs member-portal writes hold --env production
```

```sh
node scripts/flags.mjs funraise-sync writes on --env production
```

```sh
node scripts/flags.mjs funraise-sync log debug --env sandbox
```

```sh
node scripts/flags.mjs status --env production
```

```sh
node scripts/flags.mjs retention --env production
```

`writes` writes the KV key first, then pauses (`hold`) or resumes (`on`/`off`) the Worker's main
queues, so a consumer never sees a delivered message while KV still says `hold`; DLQs are never
paused. For `on` it waits 60 s between the KV write and the resume (printing a one-line notice),
so the flip has reached every KV edge cache first. If the KV write succeeds but the queue step
fails, the command exits non-zero and says KV and the queue disagree; `status` then marks the row
`MISMATCH`. A queue wrangler reports missing is a failure, never a skip: create a Worker's queues
(deploy it once) before setting its key. `all` runs every Worker even after one fails, then lists
each failure (Worker, step, and any KV/queue mismatch) and exits non-zero. wrangler runs from
`member-portal/` (its pinned version), with a 120 s timeout per call. `status` prints, per Worker,
the mode, log level, and each queue's paused/delivering state and backlog (`?` where a value could
not be read or wrangler's output could not be parsed), and exits non-zero on any `MISMATCH` or
`?`. `retention` sets 14-day message retention (1,209,600 s) on every main
queue and DLQ; it is operational, not in `wrangler.jsonc`. Leave `hold` with `on`, not `off`:
`hold` to `off` drops what was held. After a `writes hold`, wait about a minute (the KV cache
window) before starting anything that relies on it, such as the load; the CLI already waits
before resuming queues on `on`.

**Outage retry.** Main-queue consumers retry with a delay of `min(60 x 2^(attempts-1), 3600)`
seconds (1 minute doubling to 1 hour), raised to any longer hint (`Retry-After`, midnight for a
daily limit; hinted waits capped at 12 h), with `max_retries: 100` (about 4 days) before the DLQ.
Combined with 14-day retention, a multi-day Monday outage or a long `hold` queues up instead of
dead-lettering. Error classification (retryable vs terminal) is unchanged per Worker.

**KV namespaces** were created 2026-10-27: `FLAGS` (`1dec1f10ebcc41e7a464179ba2b37628`) and
`sandbox-FLAGS` (`a80c21a348064e07bb9c1bff16bee1a4`). All 14 in-scope `wrangler.jsonc` files carry
both ids (forks: create your own with `npx wrangler kv namespace create FLAGS` and
`npx wrangler kv namespace create sandbox-FLAGS`, and replace them);
`node scripts/check-worker-flags.mjs --strict` (CI job `worker-flags-copies`) verifies they match and that every Worker's `src/flags.ts` is
byte-identical to the canonical `member-portal/src/flags.ts`.

## Reliability: traffic and cost limits

**The account is on Workers Paid**, through Cloudflare's Project Galileo (confirmed 2026-09-29). That lifts
the D1 100k-writes/day Free cap that stalled `donation-rollups` twice in September (its README has
the details). Every Worker here was built on Workers Free, though, where usage cost nothing no
matter the volume and nothing ever had to bound a request's cost — and on Paid, nothing stops a
traffic spike (a bot crawl, a flood against a discovered webhook URL, a viral link) from becoming
an expensive one. Two guardrails, applied before the move so they predated it rather than
following a surprise bill:

**Per-IP request rate limiting**, via Cloudflare's [Workers Rate Limiting
binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) — GA,
included on every plan, no upgrade needed. Every publicly-reachable Worker (`member-portal`,
`svbc-calendars`, and every webhook receiver: `benevity-import`, `bp-feedback-notify`,
`donation-rollups`, `funraise-sync`, `mailchimp-sync`, `quickbooks-sync`) checks a blanket
`REQUEST_RATE_LIMITER` binding — keyed on `CF-Connecting-IP` — before any routing, D1, or Monday
work happens, in each Worker's own `src/rateLimit.ts` (`member-portal`'s is
`src/requestRateLimit.ts`, since this filesystem is case-insensitive and it already has a
`ratelimit.ts` for its login-specific limiting). One exception to "before any routing":
`svbc-calendars` checks it only on a cache MISS for its cached routes, since calendar apps poll
`.ics` feeds from a few shared IPs and a cache HIT costs nothing to serve. (Those same calendar
apps are non-browser clients, so the zone's Super Bot Fight Mode would challenge them; a WAF custom
rule exempts only the `.ics` paths — `svbc-calendars/README.md`, Deploy step 7.) This is deliberately coarser than each Worker's
own webhook-secret or signature check: that check still runs and still rejects a bogus delivery,
but a flood of requests — valid secret or not — now costs at most the configured rate instead of
one full request (D1 lookup, JSON parse, Monday-shaped work) per delivery. Webhook receivers are
set to 60 requests/min/IP (generous against real volume — a few hundred events a month; one
exception: `donation-rollups` exempts deliveries that pass its webhook-secret check, because a
bulk edit on the Donations board makes Monday itself exceed 60/min from a handful of IPs); the two
public-facing Workers (`svbc-calendars`, and `member-portal`'s blanket limit on top of its
existing tighter login/change/verify limits) are set to 120/min/IP. `monday-backup` has no public
HTTP surface (`workers_dev`/`preview_urls` both `false`, no routes) and is excluded;
`salesforce-import` is a local CLI, not a deployed Worker, and is excluded too. Tune the numbers
in each Worker's `wrangler.jsonc` `ratelimits` block as real traffic patterns emerge.

**A per-invocation CPU cap**, via [`limits.cpu_ms`](https://developers.cloudflare.com/workers/wrangler/configuration/#limits)
in every Worker's `wrangler.jsonc` — a cost guardrail against a runaway invocation, not only a
traffic one. Cloudflare's own pricing
docs name this the specific mitigation for "accidental runaway bills or denial-of-wallet attacks."
It matters because Workers Paid's *default* is 30 seconds/request (up to 5 minutes, or 15
minutes for a cron on a >=1hr interval), a 3000x jump from Workers Free's 10ms hard cap. Every Worker here is set to a 100ms cap: 5–50x
this repo's typical CPU usage (Cloudflare's docs cite 2–20ms as normal for most workloads,
including ones parsing large payloads), so it shouldn't interfere with real work, but it means the
account can never accidentally bill 30 seconds of CPU for one request. Raise it per-Worker if real
usage ever approaches it — the Cloudflare dashboard's per-Worker CPU-time metrics are the source
of truth for that, not a guess made here. **Exception: `monday-backup`** runs at `cpu_ms: 300000`
(the configurable maximum) — a nightly full-account snapshot cannot fit in 100ms, and a CPU-limit
kill is uncatchable, so the cap silently killed every run (issue #29; see its `wrangler.jsonc`).
**`donation-rollups`** runs at `cpu_ms: 30000` (Workers Paid's default) for the same reason: its
nightly custodian cron reads every People item for the donor roll call (see its `wrangler.jsonc`).

**Account-level spend alerting is not code-configurable** — Cloudflare has no API/wrangler-managed
hard spend cap, only a dashboard Notification on a usage threshold. One already exists on this
account: a Cloudflare-auto-created "Billing Budget Alert" at **$10/month**, emailing SVBC staff.
Project Galileo covers the zone's Business plan, not Workers Paid, so expect the $5/month Workers
base subscription on the bill; the $10 alert then fires once usage overage passes $5 — a useful
early warning, so leave it (reviewed 2026-10-06). Manage it at **Manage account → Notifications**
in the Cloudflare dashboard.

## Error monitoring: Workers Issues

Every Worker, production and sandbox, sets `observability.issues.enabled` in its `wrangler.jsonc`
([Workers Issues](https://developers.cloudflare.com/workers/observability/issues/), open beta, free
during the beta). The runtime groups uncaught exceptions, 5xx responses, `console.error()` output,
and logs that carry a stack trace into one issue per bug, with no SDK involved. Keep the key in
every env block: a Wrangler deploy whose config omits it turns Issues **off** for that Worker. It
also needs Wrangler ≥ 4.145, since older versions don't recognize the key.

**Automations** (sending an issue to a coding agent, webhook, or chat when it crosses an occurrence
threshold or comes back after a quiet period) live in the Cloudflare dashboard, or the `cf` CLI,
not in this repo. The payload includes the logs around the failure, so **never log an email
address**: name the donor's Monday item ID instead. `mailchimp-sync` and `member-portal` each
carry a `src/logSafe.ts` whose `errorText()`/`redactEmails()` scrub addresses from error text
before it's logged, because Mailchimp and email-send errors quote the recipient. `mailchimp-sync`
logs a Mailchimp member by its `memberId()`, the subscriber hash Mailchimp's API and UI use.

CI enforces this with the `log-safety` job: [`scripts/check-log-safety.mjs`](scripts/check-log-safety.mjs)
fails on any `console.*()` call whose arguments name an `email`/`recipient` identifier or a
`.to`/`.cc`/`.bcc` field, unless it's wrapped in one of those helpers. Run it locally with
`node scripts/check-log-safety.mjs`. It can't see through indirection (a variable holding an
object with an address in it), so it's a backstop, not a proof. A deliberate exception takes
`// log-safety: allow — <reason>` on the line above, as in `member-portal`'s local-only
`ConsoleEmailSender`, which never deploys.

## Branded email template

Outbound HTML email (donor login links, letter-ready notices, bike valet feedback requests) shares
one branded layout — dark SVBC-gold header with the logo, light/dark-mode-aware body, plain-text
part — rather than each Worker sending bare, unstyled HTML. `member-portal/src/email/layout.ts` is
the source of truth; `bp-feedback-notify/src/email/layout.ts` and
`report-digests/src/email/layout.ts` are copies, same reasoning as every
other per-Worker copy in this repo (see "Concurrency" above). The logo itself is a PNG (email
clients don't render the site's inline SVG logo) served by member-portal at `GET /email/logo.png`
and referenced by every Worker's email config as an absolute URL — regenerate it from
`member-portal/src/assets/logo.ts`'s SVG source with a tool like
[resvg-js](https://github.com/thx/resvg-js) if the artwork ever changes.

Monday.com automation emails (configured in Monday's own UI, not deployed code) use a separate
static template — see [`docs/email-branding/`](docs/email-branding/) — since Monday's automation
composer can't run this repo's code.

## Deploys

**First production deploy at cutover:** follow
[`docs/production-deploy-checklist.md`](docs/production-deploy-checklist.md) — the ordered,
cross-Worker checklist around the `salesforce-import` production load.

Workers are meant to deploy automatically via [Cloudflare Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/):
a merge to `main` builds and deploys each *connected* Worker from its subdirectory (root directory
set per Worker in the Cloudflare dashboard, e.g. `/svbc-calendars`), and non-production branches
upload preview versions. Manual `npm run deploy` still works for
first-time provisioning or emergencies, but routine changes should ship by merging — this repo
previously drifted from production for months when a Worker was deployed by hand and its CI
connection silently broke.

**Sandbox deploys double that connection, per Worker.** Every Worker with a `sandbox` Wrangler
environment (`member-portal`, `funraise-sync`, `donation-rollups`, `mailchimp-sync`,
`quickbooks-sync`, `monday-backup`, `benevity-import`, `bp-feedback-notify`, `eventbrite-sync`,
`report-digests`, `member-map`)
gets a *second*
Workers Builds connection to the same repo and root directory, deploy command
`npx wrangler deploy --env sandbox`, also tracking `main` — see each Worker's README "Sandbox
environment" section for its specific Worker name. **Verify in the dashboard before relying on
it:** if Cloudflare refuses two connections on one root directory, `.gitlab-ci.yml`'s
`deploy-sandbox:<worker>` jobs are the fallback — same deploy command, run on `main`, gated on a
`CLOUDFLARE_API_TOKEN` CI variable so they stay inert until that variable is actually set (so
turning on the fallback never risks a double deploy alongside a working dashboard connection).
When adding it (#58): mark it **Protected, Masked and Hidden** — Protected is what keeps it out of
merge-request pipelines, which run unreviewed branch code — and mint it in Cloudflare with only
*Workers Scripts: Edit* (plus D1/Queues/KV edit only if a deploy needs them) on SVBC's account,
never a broad account token. Keep `main` protected (Maintainers only) and leave **Run pipelines in
the parent project for fork MRs** off. The deploy jobs declare a `sandbox` environment for deploy
history, but it is not an approval gate: Protected environments need GitLab Premium and this group
is on Free, so the Protected variable and protected `main` are the boundary.

**Keep non-production branch builds off on every Workers Builds connection (#58).** A branch build
installs that branch's `package.json` and runs its `wrangler`, so branch code runs with the
connection's build token, the same token production deploys use. GitLab's Protected variables and
fork settings don't apply to it. Cloudflare's docs don't say whether fork MRs can trigger these
builds, so answer that before turning them on in a public repo. `svbc-calendars` builds `main` only;
its "Deploy non-production branches" trigger was removed on 2026-11-03.

**Current state (verified 2026-09-28) — merging deploys only `svbc-calendars`.** All eight
provisioned sandbox Workers were last hand-deployed from `main` on 2026-10-09 (none had pending D1
migrations); `eventbrite-sync` and `people-reclassification` still carry placeholder sandbox D1
ids and were skipped. `svbc-calendars` is the only
Worker with a Workers Builds connection (production, live). No sandbox connection exists and the
`CLOUDFLARE_API_TOKEN` CI variable is not set, so the `deploy-sandbox:<worker>` jobs never run: a
merge to `main` does **not** redeploy any sandbox Worker. After merging, deploy the sandbox by
hand from an up-to-date `main` checkout — `cd <worker> && npm ci && npm run deploy:sandbox` —
applying any new D1 migrations first. None of the migration Workers exists in production yet
(their first production deploy is the cutover checklist). Update this paragraph when a connection
or the CI variable is added.
Design: [`docs/superpowers/specs/2026-09-18-sandbox-environment-design.md`](docs/superpowers/specs/2026-09-18-sandbox-environment-design.md)
§8.

## License

MIT — see [`LICENSE`](LICENSE). Chosen specifically so other nonprofits can fork, adapt, and
redeploy any of these against their own Monday.com/CRM setup with no copyleft obligations or legal
review overhead — the goal here is adoption, not protecting this code from reuse.

This repo exists as a deliberate split from SVBC's private planning repo, so the migration plan
and data-survey docs (which contain SVBC-internal detail) stay private while the Workers can be
public. (As of 2026-08-21 this repo is still set to private on GitLab — flipping it public is
pending.) Keep the split clean either way: nothing from the private repo's `docs/` tree belongs
here.

## Build order

1. **`salesforce-import`** and **`funraise-sync`** first — both are blocking on the October
   Salesforce cutover; everything else here is explicitly post-migration and non-blocking.
2. **`mailchimp-sync` next** — it's post-migration but time-sensitive: Salesforce's
   renewal-reminder automation and newsletter segmentation die at retirement, and members stop
   being asked to renew and segmented for newsletters until this ships.
3. Everything else can happen in any order, gated mainly by available time (see the table
   above). `member-portal`'s former dependency on the Membership design was resolved 2026-08-21 — the
   Status/Tier slice it needs is now part of the import scope.
