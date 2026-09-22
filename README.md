# SVBC Cloudflare Workers

The custom backend builds for [Silicon Valley Bicycle Coalition](https://bikesiliconvalley.org/)'s
Salesforce → Monday.com CRM migration, one subdirectory per Worker. Each has its own `README.md`
with the requirements needed to build it — the ask, data flow, APIs and auth, Monday.com targets,
build shape, and open questions.

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

## Status at a glance

| Worker | Status | Priority |
|---|---|---|
| [`salesforce-import`](salesforce-import/README.md) | Built (merged) — full extract → geocode → transform → load → validate exercised against the **sandbox v2** workspace (rehearsal 2026-08-28, incremental Eventbrite-history resume 2026-09-08 — see monday-migration `docs/18` §9 for the resume-run limits); **no production boards exist yet** | **Blocking.** Central migration deliverable — needs a time budget for the load/validate/cutover runs |
| [`funraise-sync`](funraise-sync/README.md) | **Deployed to the sandbox 2026-09-18** (`svbc-funraise-sync`, hand `wrangler deploy`; D1 `svbc-funraise-sync` provisioned with migrations 0001–0003, both secrets set) and proven end to end the same day: Funraise's documented example delivery went route → D1 → queue → consumer, created the donor and the Donations item with every column right (amount, `Complete → Received`, epoch-ms date, Fiscal Year Ending, Gift Type, Thank You Sent, Donor link), PII stripped at rest, and `donation-rollups` rolled the gift up on its own; test items and ledger rows removed afterwards. Wired to the sandbox v2 boards 2026-09-17; route/config/matching rewritten to the real webhook shape 2026-09-18. **Funraise webhook registered and Enabled 2026-09-18** (transaction path), then proven a second time with Funraise's own Test-button delivery and cleaned up — see its README "Deployed and verified". Funraise fires that one webhook for transactions only; **decided 2026-09-18:** feed Recurring Gifts by polling subscriptions hourly inside this Worker and drop the registration path (no registration resource exists in Funraise's API; events are Eventbrite's) — design in [`docs/superpowers/specs/2026-09-18-funraise-subscriptions-poller-design.md`](docs/superpowers/specs/2026-09-18-funraise-subscriptions-poller-design.md). **Poller built and deployed 2026-09-18, bootstrap walk done 2026-09-19** (hourly cron, D1 ledger with adopt-before-create, installments linked to their Recurring Gift, Event Ticket gift type): the Recurring Gifts board now mirrors Funraise's 1,175 subscriptions exactly (604 adopted from the importer, the rest created — including 568 Redacted historical agreements, decided 2026-09-18). **Moved onto the sandbox environment 2026-09-19; production name retired until cutover** — runs as `svbc-funraise-sync-sandbox` (`npm run deploy:sandbox`, `config/sandbox.json`, its own D1/queues/secrets), Funraise's webhook repointed and re-proven with its Test button; [the sandbox design](docs/superpowers/specs/2026-09-18-sandbox-environment-design.md) §9, funraise-sync half. | Blocking (feeds the import) |
| [`quickbooks-sync`](quickbooks-sync/README.md) | Built (merged) — not deployed; needs D1 provisioning, real board ids, and the Intuit app-review question resolved. Has a **sandbox environment** (`npm run deploy:sandbox`) on Intuit's sandbox host, with the API host now in config — see [the sandbox design](docs/superpowers/specs/2026-09-18-sandbox-environment-design.md) | Post-migration, non-blocking |
| [`svbc-calendars`](svbc-calendars/README.md) | Code-complete, not yet deployed — see [svbc-calendars/README.md](svbc-calendars/README.md)'s Deploy section for the cutover checklist (KV provisioning, secrets, Web Analytics token, Workers Builds root directory, then reassigning `events.bikesiliconvalley.org`/`committees.bikesiliconvalley.org` from the two Workers it replaces). Merged 2026-08-27 from `events-widgets`, `committee-calendars`, and the standalone `bike-calendars` project (history: see [the merge design doc](docs/superpowers/specs/2026-08-27-events-bike-calendars-merge-design.md)) | Not migration-related; predates this repo |
| [`member-portal`](member-portal/README.md) | Code-complete (v1, 2026-08-22) — not yet deployed to production; blocked on the spec's Pre-launch checklist (domain verification, real Monday column ids, dedicated integration token). Has a **sandbox environment** (`npm run deploy:sandbox`, `wrangler.jsonc` `env.sandbox`) against the CRM Sandbox boards that can only email `sandbox@bikesiliconvalley.org` — **sandbox provisioned and verified 2026-09-22** (live at `member.sandbox.bikesiliconvalley.org`; a real login-link request produced a clean `sandboxOutbound` log line) — see [the sandbox design](docs/superpowers/specs/2026-09-18-sandbox-environment-design.md); the other Workers gain the same split in later steps. | Post-migration, non-blocking (Membership dependency resolved 2026-08-21) |
| [`mailchimp-sync`](mailchimp-sync/README.md) | Built — repurposed from the never-deployed `membership-reminders` (2026-08-26); not deployed, blocked on the Donors board (same as everything downstream of `salesforce-import`) plus a Mailchimp audience with the required merge fields/Interest Categories. Has a **sandbox environment** (`npm run deploy:sandbox`, `config/sandbox.json`) that may only write to a sandbox audience — see [the sandbox design](docs/superpowers/specs/2026-09-18-sandbox-environment-design.md) | Post-migration, **time-sensitive** — newsletter segmentation and both membership email journeys depend on it once Salesforce retires |
| [`donation-rollups`](donation-rollups/README.md) | **Deployed to the sandbox and live against the sandbox v2 boards** (`svbc-donation-rollups`, hand `wrangler deploy`, latest 2026-09-17) since the 2026-08-31 webhook cutover: D1 bootstrapped with 37,286 donation→owner links, two webhooks on the single archive-in-place Donations board, membership renewal write path enabled 2026-09-17 (migration 0005), Fiscal Year Ending read from the text column with a blank cell derived from Date, recompute re-verified live 2026-09-17. Since then: diff-only fact refresh and per-owner recompute coalescing to cut D1 writes. **Known operational issue:** the account is still Workers Free, and D1's 100k-writes/day cap stalled the consumer on 09-03 and 09-09 (2,865 rows stuck `queued`, DLQ has no consumer) — see its README "Status and verification — operational findings, 2026-09-17"; Workers Paid is the fix. Production board ids wait on cutover. **Moved onto the sandbox environment 2026-09-20; production name retired until cutover** — runs as `svbc-donation-rollups-sandbox` (`npm run deploy:sandbox`, `config/sandbox.json`, its own D1 with every table copied and verified, queues, secrets), both Monday webhooks re-subscribed at the `-sandbox` URL, a recompute re-proven; [the sandbox design](docs/superpowers/specs/2026-09-18-sandbox-environment-design.md) §9, rollups half | Post-migration, non-blocking — `salesforce-import` ships correct initial values; this Worker keeps This/Last Year, Largest/Smallest/Average, and Last Gift from going stale afterward |
| [`monday-backup`](monday-backup/README.md) | Built (`feat/monday-backup`) — not deployed; needs D1 provisioning, a dedicated Monday backup integration user/token, and a Google service account scoped to the destination Drive folder. Has a **sandbox environment** (`npm run deploy:sandbox`, `config/backup.sandbox.json`) that snapshots the sandbox workspace into a separate Drive folder — see [the sandbox design](docs/superpowers/specs/2026-09-18-sandbox-environment-design.md) | Post-migration, non-blocking, but time-relevant once real donor data lives in Monday with no Salesforce copy to fall back on |
| [`benevity-import`](benevity-import/README.md) | Built (`feat/benevity-import`) — production not deployed; **sandbox provisioned and verified 2026-09-19** (`svbc-benevity-import-sandbox`: a synthetic one-row upload on the sandbox Uploads board produced the gift and match items on the sandbox Donations board); production D1 provisioned and sandbox board/column ids wired 2026-09-18 (c28c224); still needs production board/column ids at cutover and Monday webhook + integration-user token setup. Needs two `salesforce-import` column changes before cutover (see its README). Has a **sandbox environment** (`npm run deploy:sandbox`, `config/sandbox.json`) — see [the sandbox design](docs/superpowers/specs/2026-09-18-sandbox-environment-design.md) | Post-migration, non-blocking — staff can keep hand-entering matches on the board meanwhile |

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

**The account is still on Workers Free** (donation-rollups' README documents the D1 100k-writes/day
cap that already bit it once), and Workers Paid is the known next step once that D1 quota needs
raising. Free plan usage costs nothing no matter the volume, but it also means every Worker here
was built without ever having to bound a request's cost — nothing stops a traffic spike (a bot
crawl, a flood against a discovered webhook URL, a viral link) from becoming an expensive one the
day the account moves to Paid. Two guardrails, applied now so they predate that move rather than
following a surprise bill:

**Per-IP request rate limiting**, via Cloudflare's [Workers Rate Limiting
binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) — GA,
included on every plan, no upgrade needed. Every publicly-reachable Worker (`member-portal`,
`svbc-calendars`, and every webhook receiver: `benevity-import`, `bp-feedback-notify`,
`donation-rollups`, `funraise-sync`, `mailchimp-sync`, `quickbooks-sync`) checks a blanket
`REQUEST_RATE_LIMITER` binding — keyed on `CF-Connecting-IP` — before any routing, D1, or Monday
work happens, in each Worker's own `src/rateLimit.ts` (`member-portal`'s is
`src/requestRateLimit.ts`, since this filesystem is case-insensitive and it already has a
`ratelimit.ts` for its login-specific limiting). This is deliberately coarser than each Worker's
own webhook-secret or signature check: that check still runs and still rejects a bogus delivery,
but a flood of requests — valid secret or not — now costs at most the configured rate instead of
one full request (D1 lookup, JSON parse, Monday-shaped work) per delivery. Webhook receivers are
set to 60 requests/min/IP (generous against real volume — a few hundred events a month); the two
public-facing Workers (`svbc-calendars`, and `member-portal`'s blanket limit on top of its
existing tighter login/change/verify limits) are set to 120/min/IP. `monday-backup` has no public
HTTP surface (`workers_dev`/`preview_urls` both `false`, no routes) and is excluded;
`salesforce-import` is a local CLI, not a deployed Worker, and is excluded too. Tune the numbers
in each Worker's `wrangler.jsonc` `ratelimits` block as real traffic patterns emerge.

**A per-invocation CPU cap**, via [`limits.cpu_ms`](https://developers.cloudflare.com/workers/wrangler/configuration/#limits)
in every Worker's `wrangler.jsonc` (`monday-backup` included, even without a public surface — a
cost guardrail against a runaway invocation, not only a traffic one). Cloudflare's own pricing
docs name this the specific mitigation for "accidental runaway bills or denial-of-wallet attacks."
It matters here because Workers Free already hard-caps CPU time at 10ms/invocation — so this has
no effect today — but Workers Paid's *default* is 30 seconds/request (up to 5 minutes, or 15
minutes for a cron on a >=1hr interval), a 3000x jump. Every Worker here is set to a 100ms cap: 5–50x
this repo's typical CPU usage (Cloudflare's docs cite 2–20ms as normal for most workloads,
including ones parsing large payloads), so it shouldn't interfere with real work, but it means the
account can never accidentally bill 30 seconds of CPU for one request. Raise it per-Worker if real
usage ever approaches it — the Cloudflare dashboard's per-Worker CPU-time metrics are the source
of truth for that, not a guess made here.

**Account-level spend alerting is not code-configurable** — Cloudflare has no API/wrangler-managed
hard spend cap, only a dashboard Notification on a usage threshold. One already exists on this
account: a Cloudflare-auto-created "Billing Budget Alert" at **$10/month**, emailing SVBC staff.
Worth raising once the account is actually on Workers Paid — at $10 it will fire almost
immediately off the $5/month base subscription alone, before telling you anything about a real
spike. Manage it at **Manage account → Notifications** in the Cloudflare dashboard.

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

The live Workers deploy automatically via [Cloudflare Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/):
a merge to `main` builds and deploys each connected Worker from its subdirectory (root directory
set per Worker in the Cloudflare dashboard, e.g. `/svbc-calendars`), and non-production branches
upload preview versions. Manual `npm run deploy` still works for
first-time provisioning or emergencies, but routine changes should ship by merging — this repo
previously drifted from production for months when a Worker was deployed by hand and its CI
connection silently broke.

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
