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
public-facing `donor-portal` gets its own user with access to only the boards it reads (Donors,
Donations, Membership, Organizations — plus Event Registrations, Events, and Volunteers once
the gated event-registrations and volunteer-history features are configured), kept separate
from the token(s) the staff-facing Workers use. Never ship a staff member's personal token into
a Worker secret.

## Status at a glance

| Worker | Status | Priority |
|---|---|---|
| [`salesforce-import`](salesforce-import/README.md) | Built (merged) — full extract → geocode → transform → load → validate exercised against the **sandbox v2** workspace (rehearsal 2026-08-28, incremental Eventbrite-history resume 2026-09-08 — see monday-migration `docs/18` §9 for the resume-run limits); **no production boards exist yet** | **Blocking.** Central migration deliverable — needs a time budget for the load/validate/cutover runs |
| [`funraise-sync`](funraise-sync/README.md) | **Deployed to the sandbox 2026-09-18** (`svbc-funraise-sync`, hand `wrangler deploy`; D1 `svbc-funraise-sync` provisioned with migrations 0001–0003, both secrets set) and proven end to end the same day: Funraise's documented example delivery went route → D1 → queue → consumer, created the donor and the Donations item with every column right (amount, `Complete → Received`, epoch-ms date, Fiscal Year Ending, Gift Type, Thank You Sent, Donor link), PII stripped at rest, and `donation-rollups` rolled the gift up on its own; test items and ledger rows removed afterwards. Wired to the sandbox v2 boards 2026-09-17; route/config/matching rewritten to the real webhook shape 2026-09-18. **Funraise webhook registered and Enabled 2026-09-18** (transaction path), then proven a second time with Funraise's own Test-button delivery and cleaned up — see its README "Deployed and verified". Funraise fires that one webhook for transactions only; **decided 2026-09-18:** feed Recurring Gifts by polling subscriptions hourly inside this Worker and drop the registration path (no registration resource exists in Funraise's API; events are Eventbrite's) — design in [`docs/superpowers/specs/2026-09-18-funraise-subscriptions-poller-design.md`](docs/superpowers/specs/2026-09-18-funraise-subscriptions-poller-design.md), not yet built | Blocking (feeds the import) |
| [`quickbooks-sync`](quickbooks-sync/README.md) | Built (merged) — not deployed; needs D1 provisioning, real board ids, and the Intuit app-review question resolved | Post-migration, non-blocking |
| [`svbc-calendars`](svbc-calendars/README.md) | Code-complete, not yet deployed — see [svbc-calendars/README.md](svbc-calendars/README.md)'s Deploy section for the cutover checklist (KV provisioning, secrets, Web Analytics token, Workers Builds root directory, then reassigning `events.bikesiliconvalley.org`/`committees.bikesiliconvalley.org` from the two Workers it replaces). Merged 2026-08-27 from `events-widgets`, `committee-calendars`, and the standalone `bike-calendars` project (history: see [the merge design doc](docs/superpowers/specs/2026-08-27-events-bike-calendars-merge-design.md)) | Not migration-related; predates this repo |
| [`donor-portal`](donor-portal/README.md) | Code-complete (v1, 2026-08-22) — not yet deployed; blocked on the spec's Pre-launch checklist (domain verification, real Monday column ids, dedicated integration token). Has a **sandbox environment** (`npm run deploy:sandbox`, `wrangler.jsonc` `env.sandbox`) against the CRM Sandbox boards that can only email `sandbox@bikesiliconvalley.org` — see [the sandbox design](docs/superpowers/specs/2026-09-18-sandbox-environment-design.md); the other Workers gain the same split in later steps. | Post-migration, non-blocking (Membership dependency resolved 2026-08-21) |
| [`mailchimp-sync`](mailchimp-sync/README.md) | Built — repurposed from the never-deployed `membership-reminders` (2026-08-26); not deployed, blocked on the Donors board (same as everything downstream of `salesforce-import`) plus a Mailchimp audience with the required merge fields/Interest Categories | Post-migration, **time-sensitive** — newsletter segmentation and both membership email journeys depend on it once Salesforce retires |
| [`donation-rollups`](donation-rollups/README.md) | **Deployed to the sandbox and live against the sandbox v2 boards** (`svbc-donation-rollups`, hand `wrangler deploy`, latest 2026-09-17) since the 2026-08-31 webhook cutover: D1 bootstrapped with 37,286 donation→owner links, two webhooks on the single archive-in-place Donations board, membership renewal write path enabled 2026-09-17 (migration 0005), Fiscal Year Ending read from the text column with a blank cell derived from Date, recompute re-verified live 2026-09-17. Since then: diff-only fact refresh and per-owner recompute coalescing to cut D1 writes. **Known operational issue:** the account is still Workers Free, and D1's 100k-writes/day cap stalled the consumer on 09-03 and 09-09 (2,865 rows stuck `queued`, DLQ has no consumer) — see its README "Status and verification — operational findings, 2026-09-17"; Workers Paid is the fix. Production board ids wait on cutover | Post-migration, non-blocking — `salesforce-import` ships correct initial values; this Worker keeps This/Last Year, Largest/Smallest/Average, and Last Gift from going stale afterward |
| [`monday-backup`](monday-backup/README.md) | Built (`feat/monday-backup`) — not deployed; needs D1 provisioning, a dedicated Monday backup integration user/token, and a Google service account scoped to the destination Drive folder | Post-migration, non-blocking, but time-relevant once real donor data lives in Monday with no Salesforce copy to fall back on |
| [`benevity-import`](benevity-import/README.md) | Built (`feat/benevity-import`) — not deployed; needs D1 provisioning, real board/column ids, and Monday webhook + integration-user token setup. Needs two `salesforce-import` column changes before cutover (see its README) | Post-migration, non-blocking — staff can keep hand-entering matches on the board meanwhile |

Two related builds are **deliberately not Workers** and don't get a subdirectory here — see the
plan for both:

* **Bike-lane / geography proximity script** — explicitly scoped as "a one-off TypeScript script
  (Node.js), not standing infrastructure," run on request per project. Only worth wrapping as a
  persistent Worker if it becomes a frequent, recurring ask. See "Bike-lane GIS proximity" in the
  plan.
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
   above). `donor-portal`'s former dependency on the Membership design was resolved 2026-08-21 — the
   Status/Tier slice it needs is now part of the import scope.
