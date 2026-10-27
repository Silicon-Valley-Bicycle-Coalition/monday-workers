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
exposes everything that user can see — the whole workspace, if it's a staff member's own token.
Mint tokens from dedicated integration users, scoped per exposure class: at minimum, the
public-facing `member-portal` gets its own user with access to only the boards it reads (Donors,
Donations, Membership, Organizations — plus Event Registrations, Events, and Volunteers once
the gated event-registrations and volunteer-history features are configured), kept separate
from the token(s) the staff-facing Workers use. Never ship a staff member's personal token into
a Worker secret.

Sandbox tokens are the one deliberate exception to per-exposure-class users: every Worker's
`--env sandbox` `MONDAY_API_TOKEN` comes from a single shared **Sandbox Integration** user. Use
that user's token when provisioning any new sandbox environment — don't mint another. See
[the sandbox design](docs/superpowers/specs/2026-09-18-sandbox-environment-design.md) §4.

**A Monday user's "access" is wider than it looks — measure a token before calling it scoped
(#18).** Monday shows every *Main* board in every open workspace to every team member, and by
default lets them edit it, whether or not they were ever added to the board or the workspace;
closed workspaces are Enterprise-only. So on SVBC's Pro plan a member user cannot be limited to
one workspace of Main boards. Measured 2026-09-30: the Sandbox Integration user belongs to no
workspace at all and still reaches 212 active boards outside the CRM Sandbox, 199 of them
editable — the design's "a production board id in a sandbox config fails with
`USER_UNAUTHORIZED`" does **not** hold. The same applies to every production integration user:
"access to only the boards it reads" is true only of boards created **private** (or shareable,
for a guest user). Until boards are restricted that way, what keeps a sandbox Worker off
production is each Worker's `config/split.test.ts` (the two configs share no id) and
`monday-backup`'s `workspaceIds`, not the token. To see what a token really reaches:

```sh
MONDAY_API_TOKEN=... node scripts/check-monday-token-scope.mjs --workspace 17141226
```

It exits non-zero and lists the workspaces if the token reaches any board outside the ones named.

**Making the production donor boards private (#41).** `salesforce-import` creates its boards
`board_kind: public`, so after the cutover load every member token reaches and can edit them.
Do this **after the load and before any Worker's production deploy**:

1. Rehearse on a sandbox board first (dry run, then `--apply` on one throwaway board).
2. Dry run against production: `MONDAY_API_TOKEN=... node scripts/make-boards-private.mjs
   --workspace <id> --prefix "<board name prefix>" --sandbox-user <Sandbox Integration user id>`.
   It lists each matching board's kind, subscribers and team subscribers and changes nothing.
   Use the load user's or an admin's token, not a Worker integration user's.
3. Re-run with `--apply`. It calls `change_board_kind(board_id, kind: PRIVATE)` and re-reads the
   boards to confirm. (`update_board` cannot do this; its `board_attribute` has no `board_kind`.)
4. In Monday, subscribe the staff team, and each production integration user to **only** the
   boards its Worker reads or writes. The script reports subscribers; it does not add them.
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
| [`salesforce-import`](salesforce-import/README.md) | Built (merged) — full extract → geocode → transform → load → validate exercised against the **sandbox v2** workspace (rehearsal 2026-08-28, incremental Eventbrite-history resume 2026-09-08 — see monday-migration `docs/18` §9 for the resume-run limits). **Batched load re-rehearsed 2026-10-09 → 12** (aliased link and archive writes, !211) on fresh `(batched rehearsal)` boards in the sandbox workspace: 27 h 51 min end to end against a ≈ 26.7 h projection, `validate --live` 18 OK / 2 FAIL (the two pre-existing `recon-funraise-*` checks); those boards were deleted 2026-10-14. Since then: `configure` builds Find table views and an Overview dashboard on each of the 12 CRM boards (!216, !217, merged 2026-10-20; rehearsed on the sandbox 2026-10-14), the Sponsorships widget is gone from the Board Report dashboard (2026-10-15), and the importer stamps `Eventbrite Order ID` on migrated ticket gifts (2026-10-19). **No production boards exist yet** | **Blocking.** Central migration deliverable — the production load is the cutover weekend, Oct 23–25 |
| [`funraise-sync`](funraise-sync/README.md) | **Deployed to the sandbox 2026-09-18** (`svbc-funraise-sync`, hand `wrangler deploy`; D1 `svbc-funraise-sync` provisioned with migrations 0001–0003, both secrets set) and proven end to end the same day: Funraise's documented example delivery went route → D1 → queue → consumer, created the donor and the Donations item with every column right (amount, `Complete → Received`, epoch-ms date, Fiscal Year Ending, Gift Type, Thank You Sent, Donor link), PII stripped at rest, and `donation-rollups` rolled the gift up on its own; test items and ledger rows removed afterwards. Wired to the sandbox v2 boards 2026-09-17; route/config/matching rewritten to the real webhook shape 2026-09-18. **Funraise webhook registered and Enabled 2026-09-18** (transaction path), then proven a second time with Funraise's own Test-button delivery and cleaned up — see its README "Deployed and verified". Funraise fires that one webhook for transactions only; **decided 2026-09-18:** feed Recurring Gifts by polling subscriptions hourly inside this Worker and drop the registration path (no registration resource exists in Funraise's API; events are Eventbrite's) — design in [`docs/superpowers/specs/2026-09-18-funraise-subscriptions-poller-design.md`](docs/superpowers/specs/2026-09-18-funraise-subscriptions-poller-design.md). **Poller built and deployed 2026-09-18, bootstrap walk done 2026-09-19** (hourly cron, D1 ledger with adopt-before-create, installments linked to their Recurring Gift, Event Ticket gift type): the Recurring Gifts board now mirrors Funraise's 1,175 subscriptions exactly (604 adopted from the importer, the rest created — including 568 Redacted historical agreements, decided 2026-09-18). **Moved onto the sandbox environment 2026-09-19; production name retired until cutover** — runs as `svbc-funraise-sync-sandbox` (`npm run deploy:sandbox`, `config/sandbox.json`, its own D1/queues/secrets), Funraise's webhook repointed and re-proven with its Test button; [the sandbox design](docs/superpowers/specs/2026-09-18-sandbox-environment-design.md) §9, funraise-sync half. **Remapped to the `(sandbox v3)` boards 2026-09-30**: the v2 Donations and Recurring Gifts boards it targeted were deleted on 2026-09-20, so 41 real gifts had dead-lettered and the poll had stalled. Config remapped and redeployed, the D1 ledger and cursors cleared and the bootstrap walk re-run (604 adopted, 572 created, ledger 1,176 = board 1,176), and the 53 held gifts re-driven onto Donations (sandbox v3) — see its README "Rebuilt boards". **Sandbox redeployed from `main` 2026-10-09** (archived-fiscal-year flag, one-item-per-Funraise-ID check, replay-window script); no D1 migrations were pending. | Blocking (feeds the import) |
| [`quickbooks-sync`](quickbooks-sync/README.md) | Built (merged) — production not deployed; needs real board ids. The Intuit app-review question is resolved 2026-09-21 (a private single-company app still needs Intuit's ~40-minute self-assessment questionnaire, but not the full app-store review). Has a **sandbox environment** on Intuit's sandbox host, deployed as `svbc-quickbooks-sync-sandbox` (by hand — `npm run deploy:sandbox`; merging does not deploy it, see "Deploys"). **D1 and queues provisioned and verified 2026-09-22**: `svbc-quickbooks-sync-sandbox` D1 (id wired 2026-09-20) had a pending migration (`0002_qb_events_pending_monday_item_id`, added 2026-09-21) that had never actually run against it — closed today, both migrations now applied and confirmed via schema check; both queues (`quickbooks-sync-writes-sandbox` and its `-dlq`) confirmed provisioned; config split test, typecheck, unit tests, and a `wrangler deploy --dry-run --env sandbox` all pass. **`MONDAY_API_TOKEN` and `MONDAY_WEBHOOK_SECRET` set 2026-09-22** (the former reuses the shared `Sandbox Integration` user already used by the other sandbox Workers; the latter's local copy is lost, so regenerate and re-set it when the Monday webhook is registered). **Sandbox Customers/Invoices/Products boards created and wired 2026-09-29.** **Still blocked** on staff-side prerequisites before it can process anything live: an Intuit sandbox company and development keys, and a token pair seeded via the OAuth Playground (`QB_CLIENT_ID`/`QB_CLIENT_SECRET`/`QB_WEBHOOK_VERIFIER_TOKEN` remain unset) — see [the sandbox design](docs/superpowers/specs/2026-09-18-sandbox-environment-design.md) **Sandbox redeployed from `main` 2026-10-09** (canonical Monday transport, dead-letter retry delay after a D1 failure, production D1 id wired); no D1 migrations were pending. | Post-migration, non-blocking |
| [`svbc-calendars`](svbc-calendars/README.md) | **Deployed and live** in production at `events.bikesiliconvalley.org` / `committees.bikesiliconvalley.org` — the one Worker here with a Workers Builds connection, so every merge to `main` redeploys it (verified 2026-09-28). See [svbc-calendars/README.md](svbc-calendars/README.md)'s Deploy section for how it was set up. **Its `.ics` feeds depend on a WAF custom rule in the Cloudflare zone** — added 2026-10-02 to exempt `GET /calendars/*.ics` on both hostnames from Super Bot Fight Mode, which had been serving calendar clients a managed-challenge page since 2026-09-25; the rule lives in the dashboard, not in this repo, so see that README's Deploy step 7 for the expression and how to check it is still in place. Merged 2026-08-27 from `events-widgets`, `committee-calendars`, and the standalone `bike-calendars` project (history: see [the merge design doc](docs/superpowers/specs/2026-08-27-events-bike-calendars-merge-design.md)) | Not migration-related; predates this repo |
| [`member-portal`](member-portal/README.md) | Code-complete (v1, 2026-08-22) — not yet deployed to production; blocked on the spec's Pre-launch checklist (domain verification, real Monday column ids, dedicated integration token). Has a **sandbox environment** (`npm run deploy:sandbox`, `wrangler.jsonc` `env.sandbox`) against the CRM Sandbox boards that can only email `sandbox@bikesiliconvalley.org` — **sandbox provisioned and verified 2026-09-22** (live at `member.sandbox.bikesiliconvalley.org`; a real login-link request produced a clean `sandboxOutbound` log line) — see [the sandbox design](docs/superpowers/specs/2026-09-18-sandbox-environment-design.md); the other Workers gain the same split in later steps. **Sandbox redeployed from `main` 2026-10-09** (v8 impact summary, canonical Monday transport, email addresses kept out of logs); no D1 migrations were pending. | Post-migration, non-blocking (Membership dependency resolved 2026-08-21) |
| [`mailchimp-sync`](mailchimp-sync/README.md) | Built — repurposed from the never-deployed `membership-reminders` (2026-08-26); not deployed to production, blocked on the Donors board (same as everything downstream of `salesforce-import`) plus a Mailchimp audience with the required merge fields/Interest Categories. **Sandbox provisioned and verified 2026-09-22** (`npm run deploy:sandbox`, `config/sandbox.json`) against a live "SVBC Sandbox" Mailchimp audience that may only write to a sandbox audience — see [the sandbox design](docs/superpowers/specs/2026-09-18-sandbox-environment-design.md). Verification also caught two bugs invisible to the unit suite (an unbound `fetch` causing "Illegal invocation" on every live HTTP call, and a malformed GraphQL variable type on the email lookup) — see `mailchimp-sync/README.md` **Sandbox redeployed from `main` 2026-10-09** (canonical Monday transport, email addresses kept out of logs, production D1 id wired); no D1 migrations were pending. | Post-migration, **time-sensitive** — newsletter segmentation and both membership email journeys depend on it once Salesforce retires |
| [`donation-rollups`](donation-rollups/README.md) | **Running in the sandbox as `svbc-donation-rollups-sandbox`, live against the `(sandbox v3)` boards**: config remapped 2026-09-20, D1 ledger re-bootstrapped from the importer's artifacts and webhooks re-subscribed on Donations (sandbox v3) on 2026-09-29 (five subscriptions, confirmed 2026-09-30), Donor Level and the four chart-classification columns provisioned the same day (ddcdc7b). History: first live against the sandbox v2 boards (`svbc-donation-rollups`, hand `wrangler deploy`) from the 2026-08-31 webhook cutover: D1 bootstrapped with 37,286 donation→owner links, two webhooks on the single archive-in-place Donations board, membership renewal write path enabled 2026-09-17 (migration 0005), Fiscal Year Ending read from the text column with a blank cell derived from Date, recompute re-verified live 2026-09-17. Since then: diff-only fact refresh and per-owner recompute coalescing to cut D1 writes. **Operational finding, since unblocked:** while the account was on Workers Free, D1's 100k-writes/day cap stalled the consumer on 09-03 and 09-09 (2,865 rows stuck `queued`) — see its README "Status and verification — operational findings, 2026-09-17". The account is on Workers Paid now (confirmed 2026-09-29), which lifts that cap and unblocks the repair. Production board ids wait on cutover. **Moved onto the sandbox environment 2026-09-20; production name retired until cutover** — runs as `svbc-donation-rollups-sandbox` (`npm run deploy:sandbox`, `config/sandbox.json`, its own D1 with every table copied and verified, queues, secrets), both Monday webhooks re-subscribed at the `-sandbox` URL, a recompute re-proven; [the sandbox design](docs/superpowers/specs/2026-09-18-sandbox-environment-design.md) §9, rollups half **Sandbox redeployed from `main` 2026-10-09** (3 in-process Monday attempts, Donor Level and classification columns, transport fixes); no D1 migrations were pending. **Activity-based membership rule merged 2026-10-11** (!213: membership derived from gift and volunteer check-in history under the 13-month rule, migration 0009, the membership columns and Event Registrations webhooks) and run on the sandbox (7,683 owners recomputed). **Webhook deletions fixed 2026-10-12** (!214, `a27a0bc`): Monday's delete/restore payloads carry `itemId`, which every earlier build rejected, so a deleted gift never left its owner's totals; sandbox redeployed the same day. Production must deploy a build at or after `a27a0bc`. | Post-migration, non-blocking — `salesforce-import` ships correct initial values; this Worker keeps This/Last Year, Largest/Smallest/Average, and Last Gift from going stale afterward |
| [`monday-backup`](monday-backup/README.md) | Built (merged) — production not deployed; its production D1 exists (provisioned 2026-10-08), and it still needs a dedicated Monday backup integration user/token, and a Google service account that is a member of the destination **Shared Drive** (Workers Paid, the other prerequisite, is in place as of 2026-09-29). **`svbc-monday-backup-sandbox` has been deployed since 2026-09-22** with its own D1 and the sandbox Monday token, but has never completed a backup: `config/backup.sandbox.json`'s destination folder is still a placeholder and the Google service-account and Slack secrets are unset. Ships a restore CLI ([`RESTORE.md`](monday-backup/RESTORE.md)); the sandbox restore rehearsal is pending #14. Has a **sandbox environment** (`npm run deploy:sandbox`, `config/backup.sandbox.json`) that snapshots the sandbox workspace into a separate Drive folder — see [the sandbox design](docs/superpowers/specs/2026-09-18-sandbox-environment-design.md) **Sandbox redeployed from `main` 2026-10-09** (typed `MondayApiError` transport, production D1 id wired); no D1 migrations were pending. | Post-migration, non-blocking, but time-relevant once real donor data lives in Monday with no Salesforce copy to fall back on |
| [`benevity-import`](benevity-import/README.md) | Built (`feat/benevity-import`) — production not deployed; **sandbox provisioned and verified 2026-09-19** (`svbc-benevity-import-sandbox`: a synthetic one-row upload on the sandbox Uploads board produced the gift and match items on the sandbox Donations board), **remapped to the `(sandbox v3)` boards and re-verified the same way 2026-09-30** after the v2 boards it targeted were deleted (the missing `Benevity Disbursement Date` column was added to Donations (sandbox v3) by hand); production D1 provisioned and sandbox board/column ids wired 2026-09-18 (c28c224); still needs production board/column ids at cutover and Monday webhook + integration-user token setup. Needs two `salesforce-import` column changes before cutover (see its README). Has a **sandbox environment** (`npm run deploy:sandbox`, `config/sandbox.json`) — see [the sandbox design](docs/superpowers/specs/2026-09-18-sandbox-environment-design.md) **Sandbox redeployed from `main` 2026-10-09** (sandbox config repointed at the rebuilt Uploads board); no D1 migrations were pending. **Sandbox redeployed again 2026-10-19** with the Retry and Key columns and the Retry webhook provisioned on the sandbox boards, worklist emails written as `{email, text}` with withheld addresses skipped, and anonymous worklist items named after the company. | Post-migration, non-blocking — staff can keep hand-entering matches on the board meanwhile |
| [`eventbrite-sync`](eventbrite-sync/README.md) | Built (`feat/eventbrite-orders`, 2026-10-06; design [`docs/superpowers/specs/2026-10-06-eventbrite-orders-design.md`](docs/superpowers/specs/2026-10-06-eventbrite-orders-design.md)) — **not deployed anywhere.** Paid Eventbrite orders → Donations items (Status `Received`, Gift Type `Event Ticket`, buyer matched on People by email; refunds → `Refunded`), decided 2026-09-30 (migration repo #56). The webhook delivery is only a pointer, so the consumer re-fetches each order from Eventbrite and the D1 ledger holds nothing personal. **Since 2026-10-19 the `Eventbrite Order ID` column (its idempotency key) comes from the load:** `salesforce-import` stamps it on migrated ticket gifts and creates the column, so Bike Summit 2026 (Oct 22, before the Oct 23 cutover) reaches Monday through the import and this Worker adopts those gifts by order id instead of duplicating them. **Still blocked on:** reading that column's id into config after the load, an Eventbrite private token, D1/queues/secrets, the webhook registration, and the `Refunded` label it shares with `funraise-sync`. Has a **sandbox environment** (`npm run deploy:sandbox`, `config/sandbox.json`), unprovisioned. Ships `scripts/backfill-orders.mjs` for the gap between the final extract and the webhook registration; never backfill an event that sold tickets before 2026 (those migrated gifts have no order id) | Post-cutover — takes every Eventbrite order after the final extract |
| [`bp-feedback-notify`](bp-feedback-notify/README.md) | Built — production not deployed (needs `WEBHOOK_SECRET`, then the `Post-Event Feedback` column and webhook automation added to the live `BP Request Form` board by someone with write access; see its README "Monday automation setup"). **Sandbox confirmed working end-to-end 2026-09-21** (`svbc-bp-feedback-notify-sandbox`): a real status change on `BP Request Form (sandbox)` fired the webhook and the email reached the sandbox sink. Optional Sent/Failed write-back to the item ships disabled (`sendStatus: null`) **Sandbox redeployed from `main` 2026-10-09** (send-outcome logging with redacted recipients, background status write-back, Workers Issues); no D1 migrations were pending. | Post-migration, non-blocking — closes the Organizer Feedback Form gap; nothing depends on it |
| [`email-log`](email-log/README.md) | Built, not deployed (2026-10-20; design [`docs/superpowers/specs/2026-10-19-email-log-design.md`](docs/superpowers/specs/2026-10-19-email-log-design.md)). Staff BCC or forward a significant email to `log@log.bikesiliconvalley.org` and it becomes an Activities (Logged) item linked to the matching People, replacing the Salesforce Gmail extension's one-click logging; a reply goes out only when an address didn't match. **Blocked on** the Activities (Logged) board, D1/queues, the Monday integration user, Email Routing on `log.bikesiliconvalley.org`, and the `Authentication-Results` authserv-id live check (it rejects all mail until set). Has a **sandbox environment** (`npm run deploy:sandbox`, `config/sandbox.json`), unprovisioned | Post-cutover, non-blocking — replaces the Salesforce Gmail extension's one-click email logging |
| [`people-reclassification`](people-reclassification/README.md) | **Built, not deployed** (`feat/people-reclassification`, 2026-10-09). The periodic pass the plan's "Still open" first bullet asks for: moves People items whose latest activity (Last Gift Date, Member Until, counted event registrations, volunteer hours; Lifetime members and Funraise-linked people never age out) is outside a rolling **7-year** window to People (Historical), and reactivated Historical people back — daily cron that fires a pass on the first of each quarter, when People crosses 85% of the ceiling, or to continue unfinished work; `POST /reclassify/run` on demand. Every write is **dry-run** until the write switch (`people-reclassification:writes`) is `on`; a D1 ledger records every decision. Warns (and optionally raises an IT Requests item) when Historical nears its own ceiling. Not provisioned anywhere; move behaviour (connect-column survival across `move_item_to_board`) still needs the one-item live check in its README | Post-cutover, non-blocking — People lands at ~74% of the ceiling; this keeps it there |

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
Cloudflare Queues retries automatically (3 attempts by default, configurable, with delay/backoff)
and, once retries are exhausted, routes the message to a
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
the source of truth; `bp-feedback-notify/src/email/layout.ts` is a copy, same reasoning as every
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
`quickbooks-sync`, `monday-backup`, `benevity-import`, `bp-feedback-notify`, `eventbrite-sync`)
gets a *second*
Workers Builds connection to the same repo and root directory, deploy command
`npx wrangler deploy --env sandbox`, also tracking `main` — see each Worker's README "Sandbox
environment" section for its specific Worker name. **Verify in the dashboard before relying on
it:** if Cloudflare refuses two connections on one root directory, `.gitlab-ci.yml`'s
`deploy-sandbox:<worker>` jobs are the fallback — same deploy command, run on `main`, gated on a
`CLOUDFLARE_API_TOKEN` CI variable so they stay inert until that variable is actually set (so
turning on the fallback never risks a double deploy alongside a working dashboard connection).

**Current state (verified 2026-09-28) — merging deploys only `svbc-calendars`.** All eight
provisioned sandbox Workers were last hand-deployed from `main` on 2026-10-09 (none had pending D1
migrations); `eventbrite-sync` and `people-reclassification` still carry placeholder sandbox D1
ids and were skipped, and `email-log` (built after that deploy, not yet deployed) carries them
too. It is the only
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
