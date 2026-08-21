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
Donations, Membership, Organizations), kept separate from the token(s) the staff-facing Workers
use. Never ship a staff member's personal token into a Worker secret.

## Status at a glance

| Worker | Status | Priority | Owner |
|---|---|---|---|
| [`salesforce-import`](salesforce-import/README.md) | Decided — build | **Blocking.** Central migration deliverable | Unassigned — needs owner + time budget |
| [`funraise-sync`](funraise-sync/README.md) | Decided (Option B) — build | Blocking (feeds the import) | Unassigned |
| [`quickbooks-sync`](quickbooks-sync/README.md) | Decided — build | Post-migration, non-blocking | Unassigned |
| [`squarespace-forms`](squarespace-forms/README.md) | Decided — build | Post-migration, non-blocking | dwk |
| [`buffer-content-calendar`](buffer-content-calendar/README.md) | Recommended | Post-migration, non-blocking | Unassigned |
| [`instagram-threads-interactions`](instagram-threads-interactions/README.md) | Decided — greenlit | Post-migration, non-blocking | Unassigned |
| [`bluesky-interactions`](bluesky-interactions/README.md) | Recommended | Post-migration, non-blocking (after Instagram/Threads is stable) | Unassigned |
| [`committee-calendars`](committee-calendars/README.md) | Recommended | Post-migration, non-blocking | Unassigned |
| [`gemini-reports`](gemini-reports/README.md) | Recommended | Post-migration, non-blocking | Unassigned |
| [`volunteermatch-sync`](volunteermatch-sync/README.md) | Recommended, pending terms | Post-migration, non-blocking | dwk (confirms terms with Idealist first) |
| [`donor-portal`](donor-portal/README.md) | Decided — build | Post-migration, non-blocking (blocked on Membership design) | Unassigned |

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
Funraise transactions a month, occasional QuickBooks/Instagram/Bluesky events) is nowhere near
that ceiling; this is a genuine build-over-subscription fit, not a paid upgrade.

**Applies to:** `funraise-sync`, `quickbooks-sync`, `instagram-threads-interactions`,
`bluesky-interactions` — every Worker driven by a webhook or firehose with no natural retry of its
own. Each Worker's own README notes this in its Data Flow section.

**Lower risk, but not risk-free: the Cron-polled Workers** (`squarespace-forms`,
`committee-calendars`, `buffer-content-calendar`) self-heal on the next scheduled run if one poll
fails — no Queue needed there. But each one's D1 "last processed" cursor must only advance **after**
a confirmed Monday write, never before — otherwise a failed run silently skips whatever it was
supposed to process that cycle, with nothing to retry it and nothing telling anyone it happened.
Worth a Slack-automation ping (native, no build) on repeated failure, not just silent retry-next-
cycle.

**`salesforce-import` is different — a one-time batch job, not an ongoing sync.** A Queue is the
wrong tool for a run that happens once and is already validated by repeated sandbox dry-runs (see
Migration Method). What it needs instead: retry-with-backoff on individual Monday API writes
within the script itself, and a log of which records failed so a partial run can be resumed rather
than restarted from zero. See that Worker's README.

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
2. Everything else can happen in any order, gated mainly by owner availability (see the table
   above — most rows are unassigned) and, for `volunteermatch-sync`, by Idealist confirming terms.
3. **`donor-portal` specifically also needs the Membership board's minimal Status/Tier design
   finished first** (see `docs/06-staff-process-guide.md` §8, private planning repo) — it's the only Worker here with a
   dependency on another undecided piece of this plan, not just an owner.
