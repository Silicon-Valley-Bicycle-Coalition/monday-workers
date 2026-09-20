---
name: run-member-portal
description: Build, run, and drive member-portal (SVBC's Cloudflare Worker donor self-service portal). Use when asked to start member-portal, run its local preview, log in as a fake donor, take a screenshot of its UI, run its tests, or interact with the running app for debugging.
---

member-portal is a Hono + TypeScript Cloudflare Worker (server-rendered HTML, no SPA
framework). It has a purpose-built local-preview entrypoint
(`src/index.local.ts` + `wrangler.local.jsonc`) that swaps Monday's API and Cloudflare
Email Sending for in-memory fakes, so it runs with **no secrets, no Monday token, and
no network calls**. Drive it with the committed curl-based driver —
`.claude/skills/run-member-portal/smoke.sh` — rather than a browser: every route here is
plain server-rendered HTML, so curl exercises the real request/response/cookie flow
end to end without needing a browser automation dependency.

All paths below are relative to `member-portal/` (this Worker's own directory — one of
many subdirectories in the `monday-workers` monorepo; there's no root-level
`package.json`).

## Prerequisites

Standard Node.js + npm (this was verified against Node v26.5.0 / npm 11.17.0, but any
reasonably current version works — nothing here is version-sensitive). No OS packages
needed; this runs on macOS or Linux with no `apt-get`/`brew` step.

## Setup

```bash
npm install
```

The repo's `package-lock.json` already lists every dependency (including
`qrcode-generator`, used by the digital-membership-card feature) — a fresh clone just
needs `node_modules` populated. No env vars, no `.env` file, no secrets: the local
entrypoint never reads any.

## Run (agent path)

Use the driver, `.claude/skills/run-member-portal/smoke.sh`:

```bash
.claude/skills/run-member-portal/smoke.sh demo
```

That one command: runs D1 migrations, boots `wrangler dev:local` in the background,
waits for it to be ready, logs in as the fake household donor
(`family@example.com`), fetches the authenticated portal page, prints which donor
names it found, and shuts the server down. Exit code 0 = it worked.

For interactive debugging, drive it step by step instead of the all-in-one `demo`:

```bash
.claude/skills/run-member-portal/smoke.sh start              # boot + wait for readiness
.claude/skills/run-member-portal/smoke.sh login jordan@example.com
.claude/skills/run-member-portal/smoke.sh login family@example.com   # log in as someone else — no restart needed
# ... poke it further with curl -b $TMPDIR/member-portal-run/cookies.txt ...
.claude/skills/run-member-portal/smoke.sh stop
```

| command | what it does |
|---|---|
| `start` | applies D1 migrations, boots `wrangler dev:local` in the background on :8787, polls until it responds |
| `login [email]` | clears that email's rate-limit counter, POSTs the login form, pulls the magic link from the server log, follows it, saves the session cookie |
| `reset` | clears the `login_attempts` table directly (rarely needed standalone — `login` already does this) |
| `stop` | kills the :8787 listener *and* the `wrangler dev` process itself (see Gotchas) |
| `demo [email]` | `start` → `login` → print matched donor names → `stop`, default email `family@example.com` |

**Fake donor emails** (`src/monday/fakeClient.ts`):
- `jordan@example.com` — single donor (Jordan Alvarez)
- `family@example.com` — **two** donor items share this email (Sam & Riley Rivera) —
  exercises the "one email, multiple household members" UI (README: "show all matches,
  explicitly labeled")
- `casey@example.com` — single donor (Casey Nguyen)

**Artifacts** land in `$TMPDIR/member-portal-run/` — note this is **not** literally
`/tmp` on macOS (`$TMPDIR` is a per-user path like
`/var/folders/xx/.../T/`); always resolve the env var rather than hardcoding `/tmp`.

- `server.log` — the running wrangler dev output, including `[dev email] Login link
  for ...` lines (the "sent" magic links — nothing is actually emailed)
- `cookies.txt` — curl cookie jar from the last `login`
- `portal.html` — the authenticated portal page from the last `login`
- `migrate.log` — D1 migration output from the last `start`

To poke further by hand after `start`/`login`, e.g. checking a different page as the
same logged-in donor:

```bash
curl -sS -b "$TMPDIR/member-portal-run/cookies.txt" http://localhost:8787/en/portal/pledges
```

## Run (human path)

```bash
npm run dev:local
```

Runs in the foreground; `Ctrl-C` to stop. Same local-preview entrypoint as the driver,
just without the login automation — open `http://localhost:8787` in a real browser,
submit an email, and read the magic link from the terminal output.

`npm run dev` (no `:local`) boots the **real** entrypoint (`src/index.ts` against
`wrangler.jsonc`) — that needs a real Monday API token and Cloudflare Email Sending
configured, and is not what you want for local debugging.

## Test

```bash
npm test
```

Verified: 54 test files, 588 tests, all passing, ~10s.

```bash
npm run typecheck
```

## Gotchas

- **`/` never checks the session cookie — it's always the login form.** The
  authenticated page lives at `/:locale/portal` (e.g. `/en/portal`), which is where the
  magic-link callback redirects to. Hitting `/` after logging in and expecting to see
  donor data is the mistake to not make here — it silently looks like the session
  didn't take, when it actually did. `smoke.sh login` already fetches the right URL by
  following the callback's redirect.

- **Login is rate-limited at 5 attempts / 15 min per email**
  (`config/local.json`'s `rateLimit`), and a rate-limited request returns the *exact
  same* "Check Your Email" 200 response as a real send — deliberate anti-enumeration
  design (see the main README's Auth section), but it means hammering the same fake
  donor email while iterating silently stops producing magic links, with no error
  anywhere in the response. `smoke.sh login` clears the `login_attempts` D1 table
  before every attempt so this never bites during normal use; if you're driving it by
  hand outside the script and logins mysteriously stop working, that's why — run
  `smoke.sh reset` or `npx wrangler d1 execute svbc-member-portal-local --local
  --config wrangler.local.jsonc --command "DELETE FROM login_attempts;"`.

- **Killing the `:8787` listener doesn't kill `wrangler dev`.** `wrangler dev` forks a
  separate `workerd` process that's the actual TCP listener; killing just that PID
  (e.g. `lsof -ti:8787 | xargs kill`) leaves the parent `wrangler`/npm process running
  orphaned. Do that a few times while iterating manually and you get a pile of zombie
  wrangler processes all watching (and rewriting) the same `.wrangler/state`
  directory — which makes the *next* server flap ("Connection status updated" over and
  over in the log, never reaching "Ready on") instead of booting cleanly. `smoke.sh
  stop` kills both the port listener and the `wrangler dev --config
  wrangler.local.jsonc` process by exact command line; if you're stopping it by hand,
  do the same — `pkill -f` with that specific config-file pattern is safe (it won't
  match anything else), a bare port-kill isn't enough.

- **The server log can lag a beat behind the response.** wrangler's console output is
  block-buffered when redirected to a file, so the `[dev email] Login link for ...`
  line can appear up to ~1s after the POST that triggered it already returned 200.
  `smoke.sh login` polls for the line (up to 5s) rather than grepping once
  immediately.

- **Locale is picked from fake donor data, not your request.** The login email's
  locale (the `?lang=` on the magic link) comes from each fake donor's
  `Preferred Language` — e.g. `family@example.com` often lands on `lang=es` because
  one of the two matched household donors has Spanish set. This is expected, not a
  bug in the driver.
