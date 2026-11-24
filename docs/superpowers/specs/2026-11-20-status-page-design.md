# Staff status page (`status.bikesiliconvalley.org`) — design

Date: 2026-11-20. Status: draft, awaiting approval.

## Intent

When something seems broken — a gift hasn't shown up in Monday, a Mailchimp tag didn't land, a
form won't load — a staff member needs one place that answers **"is it us, a vendor, or
Cloudflare?"** before they file a ticket or wait it out. Today that answer is spread across
a private Slack channel (sync-watchdog alerts written in Worker names), the Cloudflare dashboard
(which staff can't see), and a dozen vendor status pages nobody has bookmarked.

The page shows, in plain language and in this order:

1. **SVBC syncs** — whether each of our own integrations is running, from `sync-watchdog`'s
   hourly checks.
2. **Cloudflare** — the platform status of the Cloudflare products our stack runs on.
3. **Services we use** — each SaaS vendor, with its live status where the vendor publishes a
   machine-readable feed, and always a link to its official status page.

Audience: SVBC staff (all staff have `@bikesiliconvalley.org` accounts). Not public.

## Goals

- One staff-only URL that says, within a minute of reality, whether any vendor or Cloudflare
  product SVBC depends on is having an incident, and whether SVBC's own syncs are healthy.
- Every vendor row links to the vendor's official status page, even when we can't read its status.
- Plain-language names staff recognize ("Funraise donations → Monday"), not Worker names.
- Forkable: the vendor list, Cloudflare components and sync labels are config.

## Non-goals

- **Alerting.** `sync-watchdog` (Slack) and Workers Issues automations already alert. This page
  is pulled, never pushed. (Approach B below is the upgrade path if vendor-outage alerts are
  ever wanted.)
- History, uptime percentages or graphs.
- Errors *inside* Workers — those stay in Workers Issues.
- A public status page for donors or members.

## Anti-goals (would make it a failure even if it works)

- **Showing green when it couldn't check.** A timed-out feed, an unparseable response or a stale
  watchdog snapshot must render as "Couldn't check", never as OK.
- **A slow vendor making the page slow or blank.** One feed's failure affects only its row.
- **A new credential on an internet-facing Worker.** The page holds no API token and no webhook.
- **Exposing internal structure publicly.** Access in front, and the Worker re-verifies the JWT.

## Approaches considered

| | Approach | Trade-off | Outcome |
|---|---|---|---|
| **A** | New `status-page` Worker; fetches vendor feeds on each page view (parallel, 3 s timeout, ~60 s cache); reads a snapshot `sync-watchdog` writes | Least to build and run (no cron, no own storage); status ≤ ~1 min old; a slow vendor can add up to 3 s; can't alert | **Chosen** |
| B | Same Worker, plus a 5-minute cron that collects vendor status into KV; page reads only KV | Instant page; enables future Slack alerts on vendor outages; one more cron, KV namespace and watchdog coverage entry | Upgrade path — the page's rendering doesn't change, only where vendor data comes from |
| C | Serve the page from `sync-watchdog` itself | One fewer Worker, but the Worker holding the Cloudflare API token and Slack webhook becomes internet-facing — against the repo's least-privilege convention | Rejected |
| — | Paid aggregator (e.g. StatusGator) | Can't show SVBC's own syncs | Rejected |
| — | Browser fetches feeds directly | Vendor CORS policies vary; syncs still need a Worker | Rejected |

## Design

### The Worker

- Directory `status-page/`, script `svbc-status-page`, standard Hono stack like `member-map`.
- Route `status.bikesiliconvalley.org` (`custom_domain: true`), `workers_dev: false`,
  `preview_urls: false`. Sandbox: `svbc-status-page-sandbox` at `status.sandbox.bikesiliconvalley.org`.
- **Access**: copy `member-map/src/access.ts` (RS256 JWT check against
  `access.teamDomain` / `access.aud` / `access.allowedEmailDomain` from config, plus the
  localhost-only `ACCESS_DEV_BYPASS`). Every route, assets included, passes the check; failure is
  a 403 that logs no identity. Operator step: create two Access applications (production,
  sandbox) as `member-map`'s README describes.
- **Bindings**: `WATCHDOG_STATE` — the `sync-watchdog` STATE KV namespace (same id), read only in
  practice (the code only calls `get`). A `REQUEST_RATE_LIMITER` with a new unique
  `namespace_id` (the `check-rate-limit-namespaces` step enforces uniqueness).
- **No** Monday access, no `MONDAY_AUTH` binding, no secrets, no write switch (it writes nothing;
  it stays out of `check-worker-flags.mjs`'s `IN_SCOPE`).
- Server-rendered HTML, no client JS required. `<meta http-equiv="refresh" content="120">` so a
  tab left open stays current *(my call)*.

### What the page looks like

```
┌──────────────────────────────────────────────────────────────┐
│ ■ SVBC  System Status                       Checked 10:41 AM │
├──────────────────────────────────────────────────────────────┤
│ ⚠ 2 things need attention                                    │
│   Cloudflare Queues: degraded performance                    │
│   Mailchimp sync → Monday: last ran 4 hours ago              │
├──────────────────────────────────────────────────────────────┤
│ SVBC syncs                     (watchdog checked 10:40 AM)   │
│  ✓ Funraise donations → Monday           Running             │
│  ✕ Mailchimp ↔ Monday                    Not running  ▸ why  │
│  ✓ Eventbrite orders → Monday            Running             │
│  …                                                           │
├──────────────────────────────────────────────────────────────┤
│ Cloudflare                                   cloudflarestatus│
│  ✓ Workers   ⚠ Queues (degraded)   ✓ D1   ✓ KV   ✓ Access …  │
│  Incident: "Network performance issues in IAD" ↗             │
├──────────────────────────────────────────────────────────────┤
│ Services we use                                              │
│  ✓ Monday.com        CRM                      Status page ↗  │
│  ✓ Funraise          Online donations         Status page ↗  │
│  – Eventbrite        Event tickets   No public status page   │
│  – Mailchimp         Email newsletters        Status page ↗  │
│  …                                                           │
└──────────────────────────────────────────────────────────────┘
```

- A summary banner at the top: "All systems normal" or "N things need attention", listing them.
  **What counts** *(my call)*: any SVBC sync row that isn't Running (Paused included — the
  watchdog only flags a write switch that differs from its `expectedWrites`, so a hold staff
  weren't told about is exactly what this page should surface; a planned hold should update
  `expectedWrites`), and any Cloudflare component or vendor at **Outage**. Degraded,
  Maintenance and Couldn't check show on their rows only — Cloudflare marks components degraded
  often enough that counting them would keep the banner permanently amber.
- Every state has an icon **and** a word (✓ Operational, ⚠ Degraded / Maintenance,
  ✕ Outage / Not running, ? Couldn't check, – Link only), never colour alone.
- Times in Pacific, written as "10:41 AM" / "4 hours ago".
- Styling from `docs/design-system/` tokens (black header bar, sand/white sections, light and
  dark via `prefers-color-scheme`); fonts self-hosted by adding a `status-page` target to
  `scripts/build-font-modules.mjs`. No Google Fonts link.

### Section 1 — SVBC syncs (from `sync-watchdog`)

`sync-watchdog`'s `STATE` KV holds only per-subject alert state (`bad`, `detail`); it records
no run time and leaves `check-failed` subjects untouched. So:

**Change to `sync-watchdog` (small, part of this work):** at the end of every run, after the
alert loop, write one key `snapshot:latest`:

```json
{
  "runAt": "2026-11-20T18:40:03Z",
  "subjects": [
    { "subject": "cron:funraise-sync:0 * * * *", "status": "ok" },
    { "subject": "writes:mailchimp-sync", "status": "bad", "detail": "writes is hold, expected on" },
    { "subject": "queue:funraise-sync-writes", "status": "check-failed", "detail": "<error>" }
  ]
}
```

Written in both environments (sandbox runs are manual, so the sandbox page will usually show the
snapshot as stale — expected). A failed snapshot write is logged and doesn't affect alerting.
Subject names follow the watchdog's existing `cron:` / write-switch / `queue:` prefixes; the
builder matches whatever `checks.ts` actually emits.

**Rendering:** `status-page/config/svbc.json` holds a `syncs` list, each entry a staff label, a
one-line description, and the watchdog subjects it rolls up — the Worker's cron subjects,
write-switch subject and the queues it owns, e.g.

```json
{ "label": "Funraise donations → Monday", "worker": "funraise-sync",
  "queues": ["funraise-sync-writes"] }
```

(cron and write-switch subjects are found by the `worker` prefix; queues are listed because
queue names don't always start with the Worker name).

A row's state is the worst of its subjects: any `bad` → **Not running** (cron), **Paused**
(write switch), or **Backed up** (queue), with the watchdog's `detail` behind a "why"
disclosure; any `check-failed` → **Couldn't check**; else **Running**. "Last ran 4 hours
ago" comes from the timestamp already in the watchdog's cron `detail` ("no run since <ISO>"),
so the snapshot format needs no extra field. Staff words are the
builder's to finalize, but they must not be Worker or cron jargon.

**Staleness:** if `snapshot:latest` is missing or `runAt` is more than 2 hours old (the watchdog
runs hourly), the whole section shows "The watchdog hasn't reported since …" with every row as
Couldn't check — never the last known good state.

Workers in the watchdog's `notLive` list, and staff-invisible plumbing (`monday-auth`,
`member-portal`'s writer), are not shown unless config lists them *(my call: show only what a
staff member would recognize; `monday-auth` failing shows up as the syncs that depend on it)*.

### Section 2 — Cloudflare

From `https://www.cloudflarestatus.com/api/v2/summary.json` (Atlassian Statuspage format),
filtered to the components named in config. Initial list, from what the stack's `wrangler.jsonc`
files use: **Workers, Workers KV, D1, Queues, R2, Email Routing** (`send_email`), **Access,
Authoritative DNS, CDN/Cache**, and the **San Jose (SJC)** data centre. Shown: each component's
status, plus any unresolved incident or scheduled maintenance whose `components` include one of
them (name + link to its shortlink). Today (2026-11-20) Workers and Queues show
`degraded_performance` — a live test case.

### Section 3 — Services we use

`config/svbc.json` → `vendors`, each `{ name, usedFor, statusPageUrl, feed }`, where `feed` is
one of:

| `feed.kind` | Source | Vendors (verified 2026-11-20) |
|---|---|---|
| `statuspage` | `<base>/api/v2/summary.json`; page `status.indicator` | Monday.com (`status.monday.com`), Funraise (`status.funraise.org`), Box, QuickBooks (`status.quickbooks.intuit.com`), Zoom (`www.zoomstatus.com`), Zapier, Squarespace |
| `slack` | `https://slack-status.com/api/v2.0.0/current` (`status`, `active_incidents`) | Slack |
| `google` | `https://www.google.com/appsstatus/dashboard/incidents.json`; unresolved incidents (`end` null) affecting configured products (Gmail, Drive, Calendar, Meet) | Google Workspace |
| `none` | link only | Mailchimp (`status.mailchimp.com`, HTML only), Benevity, Double the Donation, Windfall (no status page found — row says "No public status page") |
| — | — | **Eventbrite**: `status.eventbrite.com` redirects to an unrelated event listing; no official page found. Row shows "No public status page" and links Eventbrite's help centre *(my call)* |

Salesforce is excluded (retired). Statuspage `indicator` maps `none` → Operational,
`minor` → Degraded, `major`/`critical` → Outage, `maintenance` → Maintenance; any active
incident name is shown under the row with its link.

### Fetching

- All feeds fetched in parallel on each request, each with a **3 s timeout**
  (`AbortSignal.timeout`), each cached ~60 s at the edge (Cache API or `cf.cacheTtl`; builder's
  choice) so repeated loads and multiple staff don't hit vendors each time.
- A timeout, non-2xx, or parse failure makes only that row **Couldn't check** and is logged
  (vendor name + reason; no request identity).
- The `fetch` handler never throws on feed errors; the page always renders.

### Sandbox

Per the repo convention: `env.sandbox` with its own name and route, `WATCHDOG_STATE` bound to
the sandbox STATE namespace, `config/sandbox.json` chosen by `env.ENVIRONMENT` (copy
`member-portal`'s `environment.ts`), and a `config/split.test.ts` that fails if sandbox and
production share an Access `aud` or KV id. Vendor and Cloudflare lists can be identical.

### Repo integration

- `.github/workers.json` roster entry (with `sandbox`); `.gitlab-ci.yml` mirror.
- No production crons, so `sync-watchdog/config/coverage.test.ts` needs no `watched` entry; add
  it to `notLive`/`watched` only if that test demands it.
- Root `README.md` "Status at a glance" row; `status-page/README.md` as the per-Worker spec
  (Access setup, config, deploy).
- `check-log-safety`: never log the Access email.

### Testing

- Unit: each feed parser against recorded fixtures (operational, degraded, incident, maintenance,
  malformed); the timeout path; Cloudflare component/incident filtering; sync roll-up (ok, bad,
  check-failed, missing snapshot, stale snapshot); Access check (copy `member-map`'s tests).
- `sync-watchdog`: the snapshot is written with every subject including `check-failed`, and a
  KV put failure doesn't stop alerts.
- Manual: sandbox deploy behind Access, page loads with a vendor feed URL pointed at a dead host
  to see Couldn't check.

## Left to the builder

- Exact staff wording for row states and descriptions (plain language, no Worker/cron jargon).
- Cache mechanism (Cache API vs `cf.cacheTtl`).
- Precise Cloudflare component names (verify against the live feed, e.g. R2's).
- Page markup and CSS within the design system.
