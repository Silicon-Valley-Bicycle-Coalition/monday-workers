# Architecture

Every Worker is small, but they share a handful of patterns. Learn these once and each Worker
chapter reads as a variation on them. The root [`README.md`](../../README.md) and
[`CLAUDE.md`](../../CLAUDE.md) are the detailed record. This chapter is the map.

## The stack

- **Runtime:** Cloudflare Workers (V8 isolates, not Node.js), written in **TypeScript** and
  bundled by **Wrangler**, Cloudflare's CLI. Most Workers route HTTP with **Hono**.
- **Storage:**
  - **D1** (SQLite) for each Worker's own state: idempotency records, cursors, ledgers.
  - **Queues** for durable Monday writes.
  - **KV** for the shared write switch and small caches.
  - **R2** for files such as `member-map`'s snapshots.
- **Scheduling:** Cron Triggers, plus one Cloudflare **Workflow** (`monday-backup`'s snapshot) for
  work too long for a single invocation.
- **Tests:** Vitest with `@cloudflare/vitest-pool-workers`. These run in a local copy of the real
  runtime (workerd), with D1 and queues simulated.
- **Each Worker is self-contained.** It has its own `package.json`, lockfile, `wrangler.jsonc`,
  `config/`, `migrations/` and tests. The repo has no root `package.json` and no shared npm
  package. [Copied, not shared](#copied-not-shared-modules) explains how shared code works.

## Pattern 1: webhook → D1 → queue → Monday

Most Workers that receive events from outside use this shape. `funraise-sync` is the reference
implementation.

```
sender ──HTTP──▶ route: check secret, rate limit
                  │ insert event in D1 (dedupe on the sender's event id)
                  │ enqueue a message that references it
                  ▼
               queue ──▶ consumer (the Worker's queue() handler)
                          │ read event from D1, write to Monday
                          ├─ success → ack, mark D1 row written
                          ├─ outage (429, 5xx, timeout) → retry with backoff
                          └─ retries exhausted → dead-letter queue (DLQ)
```

Why it's built this way:

- **The route answers fast.** Senders such as Funraise and Eventbrite time out or disable
  webhooks that answer slowly or with errors, so the route does no Monday work.
- **D1 is the idempotency store.** A webhook delivered twice is recognized by its id and doesn't
  create a second Donations item. A D1 status of "ingested" means received, not written to
  Monday.
- **The queue makes the write durable.** A failed `fetch()` to Monday retries automatically:
  `min(60 × 2^(attempt−1), 3600)` seconds between tries, raised to any `Retry-After` hint, up to
  100 retries (about four days). Messages then go to a **dead-letter queue**, so a gift that
  can't be written becomes a visible backlog instead of disappearing. Queues and DLQs keep
  messages for 14 days.
- **Outage breaker.** When one message in a batch fails because Monday itself is unavailable, the
  consumer stops calling Monday for the rest of that batch and retries everything later
  (`src/monday/outage.ts`). This keeps one bad minute from spending every message's retries.
- **DLQ consumers** mark the D1 row as dead-lettered and log one error. The error raises a
  Workers Issues alert in Slack. (`member-portal`'s two DLQs are the exception: they have no
  consumer.) Several Workers ship a re-drive script that puts dead letters back through the
  normal path once the cause is fixed ([chapter 7](07-operations.md#queues-and-dead-letters)).

## Pattern 2: cron-polled Workers and the cursor rule

A Worker that polls on a schedule (`dtd-sync`, `funraise-sync`'s recurring-gift poll,
`mailchimp-sync`'s consent columns) needs no queue, because a failed poll is retried by the next
run. One rule matters: **a "last processed" cursor in D1 advances only after Monday confirms the
write.** If it advanced first, a failed run would silently skip the records it was supposed to
process, with nothing to retry them.

Some crons recompute everything on every run (`contact-roles`, `mailchimp-sync`'s consent
columns). They have no cursor and need no catch-up after an outage.

A Workers cron invocation has CPU and wall-time limits, so long jobs split their work. They
either continue on the next run from a D1 checkpoint, or use a Workflow (`monday-backup`).

## Pattern 3: Monday webhooks into Workers

Some Workers react to changes staff make in Monday. Examples:
- `donation-rollups` recomputes a donor when a gift changes;
- `benevity-import` runs when a report file is uploaded;
- `bp-feedback-notify` runs when a status changes.

These Workers register **Monday webhook subscriptions** on the board, pointing at their route.

- Monday sends a **challenge** when the subscription is created, and the route must echo it.
- Monday retries failed deliveries for a while, then gives up. The Workers that need reliability
  enqueue straight away (pattern 1).
- Subscriptions created through the broker's Staff sync app carry a **signed JWT**, which
  `donation-rollups` and `people-reclassification` verify. Subscriptions created with a personal
  token aren't signed. Monday also lets only the creator delete a subscription, so register
  them through the broker ([`monday-auth`](workers/monday-auth.md)), never with your personal
  token.

### Webhook secrets in the URL

Funraise, Eventbrite and Monday can't send a custom header this code can verify, so each
webhook route checks a shared secret in the URL (`?secret=…`). Two consequences:

- **Anyone who can read the Worker's logs can read the secret**, because Cloudflare's invocation
  logs record the full URL. Give log access only to people who could rotate the secret anyway.
- **Never log `c.req.url`** in Worker code.

Rotating a webhook secret means two steps: set the new secret with
`npx wrangler secret put <NAME>`, then update the URL registered at the sender. For Monday,
delete the subscription and register it again. The full rationale is in the root README,
"Webhook secrets in the URL".

## Monday access: the token broker

A Monday personal API token can do everything its user can. That is too much power to put in an
internet-facing Worker. So SVBC uses:

- **One integration user per environment.** Production uses **SVBC Integration**, which holds a
  CRM seat and a Work Management seat. The sandbox uses **Sandbox Integration**.
- **Three Monday OAuth apps per environment**, each with its own scopes:

  | App | Broker entrypoint | Scopes (summary) | Used by |
  |---|---|---|---|
  | Portal | `PortalToken` | read boards | `member-portal` |
  | Staff sync | `SyncToken` | read and write boards, webhooks, updates, docs | every Worker that writes |
  | Read-only | `ReadOnlyToken` | read boards, docs, workspaces | `monday-backup`, `report-digests`, `member-map` |

- **`monday-auth`**, a broker Worker that holds the apps' client secrets and tokens and refreshes
  them. Monday rotates refresh tokens on every use, so only one component may refresh, and this
  is it. Other Workers get an access token through a **service binding** to one entrypoint. The
  binding in each Worker's `wrangler.jsonc` decides which app, and so which permissions, that
  Worker can use. CI (`scripts/check-monday-auth-bindings.mjs`) enforces the mapping.
- The broker never returns a token over HTTP.

What this does and doesn't protect against:

- **It does stop a compromised read-only Worker from writing.**
- **It doesn't stop it reading.** In Monday, any team member can see every *Main* board in every
  open workspace. So the portal's read-only token can read everything SVBC Integration can see.
  That is an accepted risk. The mitigation is to make sensitive boards **private** and to add
  the integration user only to the private boards it needs.
- Never call a token "scoped" without measuring it:
  `node scripts/check-monday-token-scope.mjs --workspace <id>`.

If the broker loses consent (the app was uninstalled, the user deactivated, the token revoked),
it posts to Slack and every Worker's Monday calls fail until someone re-consents. See
[`monday-auth`](workers/monday-auth.md) and [`monday-auth/SETUP.md`](../../monday-auth/SETUP.md).

### One Monday API version

Every Worker sends the same `API-Version` header, the `MONDAY_API_VERSION` constant in
`src/monday/graphql.ts` (currently `2026-07`). Monday quietly serves a deprecated version as its
current maintenance version, so an old pin drifts onto behavior nothing was tested against.
Monday releases new versions quarterly (Jan 15, Apr 1, Jul 1, Oct 1). Bump the pin at least
every two quarters ([chapter 7](07-operations.md#recurring-chores)).

## The write switch

Every Worker that writes to Monday or sends email reads a per-Worker mode from a shared KV
namespace (`FLAGS` in production, `sandbox-FLAGS` in the sandbox), so an operator can stop
writes in seconds without a deploy:

| Mode | Behavior |
|---|---|
| `on` | Write normally. |
| `hold` | Write nothing and keep the work. Queues pause and retry. Crons skip and their cursors stay put. |
| `off` | Dry run: log what would have been written. Work received while `off` is marked dropped and never written later. |

**A missing key reads as `off`, and a KV read error reads as `hold`.** Set a Worker's key to `on`
before deploying it for the first time. Operating the switch with `scripts/flags.mjs` is covered
in [chapter 7](07-operations.md#the-write-switch). The design is in
[`docs/superpowers/specs/2026-10-26-write-switch-design.md`](../superpowers/specs/2026-10-26-write-switch-design.md).

## Configuration, not hardcoding

SVBC-specific values (board ids, column ids, label names, city lists, email addresses, schedules)
live in each Worker's `config/svbc.json` for production and `config/sandbox.json` for the
sandbox. They are validated when the Worker starts. `src/environment.ts` picks the file from the
`ENVIRONMENT` variable at request time. This has three consequences:

- Changing a board or column a Worker uses is a config change plus a deploy, not a code change.
- A fork for another organization is a config change.
- Each Worker's `config/split.test.ts` fails if production and sandbox configs share any id or
  outbound address, so a sandbox can't write to production by accident.

## Copied, not shared, modules

The repo has no shared library. Code several Workers need is **copied byte for byte** into each
one, and CI fails if a copy drifts from the canonical file. To change one, edit the canonical
file, copy it over every listed copy, and commit them together.

| Module | Canonical file | Copies checked by (`.github/workflows/checks.yml` step) |
|---|---|---|
| Monday GraphQL transport (429s, complexity budget, timeouts, typed errors) | `monday-backup/src/monday/graphql.ts` | `monday-graphql-copies` |
| Queue outage breaker | `funraise-sync/src/monday/outage.ts` | `monday-outage-copies` |
| Write switch | `member-portal/src/flags.ts` | `worker-flags-copies` |
| Employer-name matching | `member-portal/src/changeRequests/employerName.ts` | `employer-name-copies` |
| Corridor and point geometry | `geo-filter/src/geometry.ts` | `geo-geometry-copies` |
| Monday webhook JWT check | `donation-rollups/src/mondayJwt.ts` (also in `people-reclassification`) | No CI step. Keep identical by hand (`cmp` them). |
| Branded email layout | `member-portal/src/email/layout.ts` | Copies in `bp-feedback-notify` and `report-digests`, kept by hand |

These files must stay **strip-only TypeScript**: no enums, namespaces or constructor parameter
properties. Operator `.mjs` scripts import them directly through Node's built-in type stripping
(Node 22.18 or later).

## Read-only column markers

Staff-facing Monday column titles carry a marker:

- **🔒** means a Worker writes the column. A hand edit will be overwritten.
- **📜** means Salesforce history, loaded once. Keep it for the audit trail.

Monday has no per-column lock that applies to staff but not to the Workers' tokens, so the marker
is the reminder. Code and config always use the **bare** title, and anything that finds a column
by title must compare through `bareTitle()` in
[`scripts/lib/column-titles.mjs`](../../scripts/lib/column-titles.mjs). A plain
`title === "Lifetime Giving"` misses the marked column, and an idempotent setup script would
then create a duplicate. When a Worker starts writing a new column, add it to `MARKED_COLUMNS`
in `scripts/mark-read-only-columns.mjs` and run that script.

## Guardrails on cost and abuse

- **Per-IP rate limiting.** Every public route checks a `REQUEST_RATE_LIMITER` binding before it
  does anything else. Webhook receivers allow 60 requests a minute; the portal and calendars
  allow 120. Each limiter needs a unique `namespace_id` (CI: `rate-limit-namespaces`).
- **CPU cap.** Every Worker sets `limits.cpu_ms`, so a runaway invocation can't bill Workers
  Paid's 30-second default. Webhook receivers and the portal use 100 ms, far above their normal
  use. Cron Workers that do real work per run are set higher, sized to measured use, from 500 ms
  (`report-digests`), 1,000 ms (`mailchimp-sync`, `contact-roles`, `people-reclassification`,
  `sync-watchdog`) and 2,000 ms (`nearby-search`) up to 30,000 ms (`donation-rollups`, `dtd-sync`, `impact-attribution`) and
  300,000 ms (`monday-backup`, `member-map`). Appendix A has each value. A CPU-limit kill can't
  be caught, so raise a cap when the dashboard's CPU metrics approach it.
- **Preview URLs off** (`preview_urls: false`) everywhere, so branch uploads can't run with
  production bindings (CI: `preview-urls`).
- **No email addresses in logs.** Workers Issues forwards the logs around an error to Slack, so
  log a Monday item id, not an address. CI's `log-safety` step and the pre-commit hook enforce
  this.
- **Spend alert.** A Cloudflare billing notification at $10 a month emails staff. Cloudflare has
  no hard spend cap.

## Observability

Every Worker has Workers Logs and **Workers Issues** turned on (`observability` in
`wrangler.jsonc`). Issues groups uncaught exceptions, 5xx responses and `console.error()` output
into one issue per bug. Dashboard automations post new and recurring issues to the private
staff Slack channel. `sync-watchdog` covers the opposite failure, a Worker that goes quiet
without logging an error. See [chapter 7](07-operations.md#alerts-and-what-they-mean).
