# First-deploy runbook — member-portal

Ordered checklist for taking this Worker from "merged to main" to serving donors at
`member.bikesiliconvalley.org`. Written for the first deploy; later deploys are just
`npm run deploy` after config/secret changes. Forks: substitute your own domains, account id,
and board names throughout.

Both donor-facing features are **config-gated**, so the Worker can deploy safely before the
gates open: tax letters stay hidden until `taxLetter` sign-off language is filled in, and
change requests stay hidden until `changeRequests.boardId` + columns are real. Login and the
read-only portal (donations, membership, discounts) work as soon as Phase 1–5 are done.

## Who/what you need before starting

- **Monday.com admin** access to the production CRM workspace (not the UAT sandbox — it gets
  rebuilt before cutover, and board/column ids do not survive the rebuild)
- **Cloudflare** access to the SVBC account (`f323cb19…`, already in `wrangler.jsonc`) with
  Workers, D1, and Queues permissions; `wrangler` logged in locally (`wrangler whoami`)
- **DNS** control for `bikesiliconvalley.org` (it's on Cloudflare, so this is the same login) —
  no separate email vendor account needed: sending goes through Cloudflare's own Email Service

## Phase 1 — Monday: boards, columns, integration user

1. **Organizations board:** add two columns — `Discount Offered` (text) and `Discount Active`
   (checkbox) — and tag the partner bike shops. Without these the portal's discount section
   renders empty (v1's centerpiece).
2. **Change Requests board:** create a staff-owned board with five columns: connect-boards →
   People/Donors, `Field` (text), `Old Value` (text), `New Value` (text), `Submitted At`
   (date). Restrict board access to staff who process changes.
3. **Monday access (OAuth broker):** the portal reads Monday through the `svbc-monday-auth`
   broker's read-only `PortalToken` entrypoint and `member-portal-writer` writes Change Requests
   through `SyncToken` (service bindings in `wrangler.jsonc` / `wrangler.writer.jsonc`) — no
   Monday token is stored on either Worker, so skip the token steps below once the broker is
   deployed and consented. The paragraph that follows is the legacy fixed-token route (the
   `MONDAY_API_TOKEN` fallback `tokenProviderFor` still honours when `MONDAY_AUTH` is unbound):
   create a dedicated Monday user (e.g. `member-portal@bikesiliconvalley.org`)
   per the root README's least-privilege convention. Give it access to exactly five boards:
   Donors/People, Donations, Organizations, Membership (if separate), and Change Requests —
   the first four effectively read-only (viewer where the plan allows), Change Requests with
   item-create rights. Never reuse a staff member's token: this Worker is public-facing.
4. **Mint the API token** from that user's admin → API section. It becomes the
   `MONDAY_API_TOKEN` secret in Phase 4.

## Phase 2 — Fill `config/svbc.json`

Run the Worker's config against reality. Every value below must lose its placeholder before
the affected surface works; `validateConfig` throws on missing keys and on placeholder column
ids in the v1 set, so a bad fill fails loudly at first request, not silently.

- `monday.donorsBoardId`, `donationsBoardId`, `organizationsBoardId` — production board ids
  (numbers in the board URL)
- `monday.columns.*` — column ids (Monday column id strings, visible via board → column menu →
  "Column ID", or the API). 17 placeholders total, including the two new Organizations
  columns and `donorAddress`/`donorPhone`
- `changeRequests.boardId` + `changeRequests.columns.*` — from Phase 1 step 2 (gates the
  change-request feature)
- `email.fromAddress` / `fromName` — e.g. `login@mail.bikesiliconvalley.org` / `SVBC Member Portal`
- `auth.portalBaseUrl` — `https://member.bikesiliconvalley.org`
- `taxLetter.*` — **leave as `REPLACE_AFTER_SIGNOFF` until the ED/accountant sign-off lands**;
  this is the letters gate, not a deploy blocker
- Sanity-check the defaults: `auth` TTLs, `rateLimit`, `changeRequests.dedupeWindowHours` (72),
  `changeRequests.retentionDays`, `cardTokens.retentionDays` (30)

Commit the fill (config is deliberately in-repo; it holds ids, not secrets).

## Phase 3 — Cloudflare Email Sending + DNS

1. Onboard the dedicated sending subdomain (keeps the org's main mail flow untouched, per the
   README): `wrangler email sending enable mail.bikesiliconvalley.org`. Since the zone is already
   on Cloudflare, this auto-adds the SPF and DKIM records — no manual DNS copy-paste.
2. Verify: `wrangler email sending dns get mail.bikesiliconvalley.org`. DNS usually propagates
   within 5-15 minutes.
3. Add a DMARC record for the subdomain if one doesn't already exist (Cloudflare doesn't add this
   automatically): `v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@bikesiliconvalley.org`.
4. Send a test email to a staff address and confirm it lands in the inbox (not spam) before
   go-live:
   ```sh
   wrangler email sending send --from "login@mail.bikesiliconvalley.org" \
     --to "staff@bikesiliconvalley.org" --subject "Member portal test" --text "Test send."
   ```

## Phase 4 — Cloudflare provisioning

From `member-portal/`, in order:

```sh
# SVBC: the D1 already exists and its id is in wrangler.jsonc — skip the create. Forks: run it
# and paste the returned id into wrangler.jsonc database_id.
wrangler d1 create svbc-member-portal
wrangler d1 migrations apply svbc-member-portal --remote   # applies 0001–0007 (0006 hashes login_attempts; without it logins send no email; 0007 adds the login-code columns and table: apply it BEFORE deploying code that reads them)
wrangler queues create member-portal-change-requests
wrangler queues create member-portal-change-requests-dlq
wrangler queues create member-portal-letter-emails
wrangler queues create member-portal-letter-emails-dlq
# No MONDAY_API_TOKEN: Monday access is the MONDAY_AUTH broker binding (see Phase 1).
wrangler secret put LETTER_WEBHOOK_SECRET   # a fresh random string — never the sandbox value
                                             # (no email secret to set — the send_email binding
                                             # in wrangler.jsonc needs no API key)
```

Every queue above is bound in `wrangler.jsonc`, so a missing one fails the deploy — create all
four even if letters aren't turned on yet.

**"Send Giving Letter" button** (README "Operator setup", steps 1–2): add a Button column to the
Donors board and a Monday automation "When button column changes → Send a webhook to
`https://member.bikesiliconvalley.org/webhooks/monday/letters?secret=<LETTER_WEBHOOK_SECRET>`".
Do this after the deploy below, and confirm one real delivery's payload shape before telling
staff it works.

The custom domain is already declared in `wrangler.jsonc` (`workers_dev` is disabled, so without
it the Worker would deploy unreachable):

```jsonc
"routes": [{ "pattern": "member.bikesiliconvalley.org", "custom_domain": true }],
```

Commit the `database_id` edit. On any later deploy that adds a migration, run
`wrangler d1 migrations apply svbc-member-portal --remote` first, then deploy. The login code
(migration `0007`) ships with `auth.loginCodeEnabled: false`; flip it only after the AutoFill check
in the README's "Login code" section.

```sh
npm test && npm run typecheck
npm run deploy
npm run deploy:writer   # the change-requests consumer lives in member-portal-writer
```

Production's portal never consumed `member-portal-change-requests`, so either order works here;
portal first just matches the sandbox. Change requests wait in the queue until the writer is up.

**Zone rate-limit rule on the login form** (Security → WAF → Rate limiting rules; not in
`wrangler.jsonc`, so a fork adds it by hand). SVBC's rule was created 2026-11-03 as `member-portal:
rate limit login POST`:

| Setting | Value |
|---|---|
| Expression | `(http.host in {"member.bikesiliconvalley.org" "member.sandbox.bikesiliconvalley.org"} and http.request.method eq "POST" and http.request.uri.path eq "/")` |
| Counted by | `ip.src`, `cf.colo.id` |
| Threshold | 20 requests in 60 seconds |
| Action | Block for 600 seconds (429 with Cloudflare's default response) |

It stops a flood before the Worker runs, so blocked requests cost no invocations or D1 writes.
The threshold sits above `LOGIN_RATE_LIMITER` (10 a minute), so everything between the two still
gets the normal generic page. The two hostnames share one counter per IP, so heavy sandbox testing
can briefly block login on production from the same IP.

## Sandbox environment (independent of Phases 1–5)

The sandbox is a permanent parallel deployment, `svbc-member-portal-sandbox`, defined by
`wrangler.jsonc`'s `env.sandbox` and `config/sandbox.json` (CRM Sandbox board ids, filled in
2026-09-18). It shares nothing with production — name, D1, queues, secrets, rate-limit
namespace, cron — and can only email `sandbox@bikesiliconvalley.org`. Provision it once:

**Staff prerequisites (not Cloudflare):**

1. Google Workspace group `sandbox@bikesiliconvalley.org`, members = staff who test the portal.
   Its posting policy must accept mail from `login@mail.bikesiliconvalley.org` (an external
   sender to the group) or every redirected send bounces. Test before deploying:
   `wrangler email sending send --from "login@mail.bikesiliconvalley.org" --to "sandbox@bikesiliconvalley.org" --subject "Sandbox sink test" --text "Test."`
2. A Monday integration user with a monday CRM member seat (the CRM Sandbox moved to CRM on 2026-10-26) whose only board access is the
   CRM Sandbox workspace (`18210301`); mint its API token. One shared sandbox user serves every
   sandbox Worker (see the design doc §4).
3. Add `sandbox@bikesiliconvalley.org` as a **verified destination address** in the Cloudflare
   dashboard (Compute → Email Service → Email Routing → Destination Addresses) and click the
   verification link that lands in the group inbox. Sends to verified destination addresses
   are free and quota-exempt on every plan, and on Workers Free they are the only sends
   allowed — without this step the first sandbox send is rejected.

**Cloudflare, from `member-portal/`:**

```sh
wrangler d1 create svbc-member-portal-sandbox           # paste the id into env.sandbox.d1_databases[0].database_id
wrangler d1 migrations apply svbc-member-portal-sandbox --remote --env sandbox   # also before any deploy that adds a migration (0007: login code)
wrangler queues create member-portal-change-requests-sandbox
wrangler queues create member-portal-change-requests-sandbox-dlq
wrangler queues create member-portal-letter-emails-sandbox
wrangler queues create member-portal-letter-emails-sandbox-dlq
# No MONDAY_API_TOKEN: the sandbox broker binding (svbc-monday-auth-sandbox) supplies Monday access.
wrangler secret put LETTER_WEBHOOK_SECRET --env sandbox # any fresh random string
```

Phase 3 (Email Sending on `mail.bikesiliconvalley.org`) must already be done — the sandbox
sends from the same onboarded domain. Commit the `database_id`, then:

Before deploying, open the sandbox "Member Portal Letter Settings (sandbox)" board
(`18439574433`) and confirm **Auto-send is unchecked** on the "Letter emails" item. The sandbox
config arms the letter cron (`letterCron` filled, `taxLetter` test text present), so a checked
box with a past start date would queue up to `maxTriggersPerRun` (200) letter emails into the
`sandbox@` group on the first 09:00 UTC run. Re-check after any sandbox board reshuffle.

```sh
npm test && npm run typecheck
npm run deploy:sandbox          # first: drops the portal's change-requests consumer from its config
npm run deploy:writer:sandbox   # then: svbc-member-portal-writer-sandbox consumes change requests
```

**Portal first, then the writer.** Cloudflare Queues allows one consumer Worker per queue, and
`svbc-member-portal-sandbox` consumed `member-portal-change-requests-sandbox` until the consumer
moved to the writer, so the writer can't attach while the portal still does. Change requests the
portal enqueues in between simply wait in the queue. CI's `deploy-sandbox:member-portal-writer`
job `needs` the portal's for the same reason.

**One-time fallback, first deploy after the split:** `wrangler deploy` attaches the consumers a
config lists, but (as of wrangler 4.156) it doesn't detach one the config dropped, so the old
portal consumer may still be attached after `npm run deploy:sandbox`, and the writer's deploy
then fails on the second consumer. Check, and detach it if it is still there, before deploying
the writer:

```sh
npx wrangler queues consumer worker list member-portal-change-requests-sandbox   # who consumes it
npx wrangler queues consumer worker remove member-portal-change-requests-sandbox svbc-member-portal-sandbox
npm run deploy:writer:sandbox
npx wrangler queues info member-portal-change-requests-sandbox                    # one consumer: the writer
```

If CI ran the writer job before the detach, re-run that job afterwards. Production never had a
portal consumer, so this never applies there.

The deploy attaches the custom domain `member.sandbox.bikesiliconvalley.org` (declared in
`env.sandbox.routes`; the zone is on Cloudflare, so no manual DNS).

**Three different local-dev entrypoints — don't mix them up:**

| Command | Talks to | Needs secrets? |
|---|---|---|
| `npm run dev` | production config (`config/svbc.json`) | yes, real production secrets |
| `npm run dev:sandbox` (`wrangler dev --env sandbox`) | real CRM Sandbox boards + the `sandbox@` inbox, from your machine | yes — the sandbox integration user's `MONDAY_API_TOKEN` and `LETTER_WEBHOOK_SECRET` in `.dev.vars` |
| `npm run dev:local` (or the `run-member-portal` skill's `smoke.sh`) | nothing — in-memory fakes, no network | no |

Use `dev:sandbox` to debug a code change against real sandbox data before running
`deploy:sandbox`; use `dev:local`/`smoke.sh` for fast iteration with no secrets at all (see the
`run-member-portal` skill for the fake donors it ships with).

**Verify the rule holds, both layers:**

1. From `https://member.sandbox.bikesiliconvalley.org`, request a login link for a real donor
   email that exists on the sandbox People board. It must arrive **only** at `sandbox@`, with
   subject `[sandbox → <that address>] Your SVBC member portal login link`. Follow the link
   and press **Continue to your portal** (the link itself only shows that button — see README
   "Data flow"); the portal renders that donor's sandbox data.
2. `wrangler tail --env sandbox` shows one `{"sandboxOutbound":"email",…}` line per send.
3. Platform layer alone: in a scratch copy of `src/index.ts` make `emailBindingFor` return
   `env.EMAIL` unconditionally (do not commit), run `wrangler dev --env sandbox --remote`,
   POST the same login request to the local URL, and confirm the dev log shows
   `E_RECIPIENT_NOT_ALLOWED` and nothing arrives anywhere. Revert the scratch edit
   (`git checkout src/index.ts`). If remote dev refuses to attach the Email binding, use
   `wrangler versions upload --env sandbox` of the scratch edit and test the uploaded version's
   URL instead, then upload the reverted code.

**Workers Builds:** connect a second Worker, `svbc-member-portal-sandbox`, to this repo with root
directory `/member-portal`, production branch `main`, and deploy command
`npx wrangler deploy --env sandbox`. The sandbox then tracks `main` alongside production. If the
dashboard refuses two connections on one root directory, fall back to the
`deploy-sandbox` job in `../.github/workflows/workers.yml` — same command, gated on a
`CLOUDFLARE_API_TOKEN` `sandbox` environment secret so it stays inert until that secret is set. Every other
`env.sandbox` Worker in this repo follows the same two-connection-or-CI-fallback pattern; see
its own README's "Sandbox environment" section.

## Phase 5 — Pre-launch verification (staff-only, before announcing)

1. **GraphQL shape checks** — the three NOTE-flagged, unverified-against-live shapes in
   `src/monday/client.ts`. Verify each against the live boards with the integration token:
   items_page `query_params.rules` filtering by (a) email text column, (b) connect-boards
   column item id, (c) checkbox `compare_value` — plus the `create_item` column-values JSON
   shapes (connect `item_ids`, date `{date,time}`). A staff email login + one test change
   request exercises all of them end-to-end; fix and redeploy if Monday's API disagrees.
2. **Login round-trip:** request a link for a staff member who exists on the Donors board;
   confirm the email arrives, link logs in, donations/membership/discounts render correctly.
3. **Enumeration guard:** request a link for an address *not* on the board — response must be
   byte-identical "check your email," and no email arrives.
4. **Shared-email household:** log in with an email matched to 2+ donor items; confirm each
   person renders under their own name header.
5. **Gates:** `/portal/letters` shows the "not available yet" state (until sign-off);
   `/portal/change-request` shows the form (if Phase 1–2 done) — submit a test request and
   confirm the item lands on the Change Requests board with old/new values and the donor link.
6. **Rate limits:** >10 login posts in a minute from one IP get denied silently (same generic
   response); >20 get a Cloudflare 429 for 10 minutes (the zone rule in Phase 4, which also blocks
   that IP's login posts to the other hostname); repeated identical change requests report
   "already submitted."
7. **Logout + cache:** after logout, back-button must not show portal data (no-store headers).

## Go-live, rollback, and aftercare

- **Go-live** is announcing the URL to donors (site link, email footer) — the deploy itself is
  invisible until then.
- **Rollback:** `wrangler versions` + `wrangler rollback`, or remove the custom domain route —
  the Worker is read-only against Monday except the Change Requests board, and its only state
  (D1 sessions/tokens/change-request audit rows) is safe to leave in place. The exception is a
  board rebuild (a cutover retry): the People item ids in D1 are then dead — see the README's
  "Resetting for new board ids".
- **Aftercare:** watch Workers observability for error spikes the first week; check the
  `member-portal-change-requests-dlq` after any Monday outage (a non-empty DLQ is a replayable
  backlog, not a loss — see the root README's queue conventions); confirm the daily 09:00 UTC
  cron is purging `change_requests` rows past `retentionDays`, revoked `card_tokens` rows
  past `cardTokens.retentionDays`, and `login_attempts` past `rateLimit.attemptRetentionHours`
  plus expired `sessions`/`magic_link_tokens` (the "purged … login_attempts" log line; at most
  10,000 rows per table per run, so a first-run backlog drains over a few days).
- **When letter sign-off lands:** fill `taxLetter.*`, commit, `npm run deploy` — letters
  appear; verify one letter against a known donor's giving history and run a print preview
  before telling donors.
- **When the automatic January send should go live:** run
  `scripts/create-letter-settings-board.mjs` against the production workspace (as an admin
  user), grant the integration user read access to the board, paste the printed `letterCron`
  block into `config/svbc.json`, deploy — then staff arm it from the board itself (Auto-send
  checkbox + start date; see README v2.3). The date-`between` items_page filter in
  `listDonorIdsWithDonationsInYear` was verified live against the sandbox Donations board
  (2026-08-25), unlike the Phase 5 NOTE-flagged shapes. Subrequest budget: each triggered donor
  costs roughly one Monday fetch, a few D1 calls, and a queue send, so the default
  `letterCron.maxTriggersPerRun` of 200 lands around 800–900 subrequests per invocation against
  the paid plan's 1,000/invocation limit — lower it before raising anything else that runs in
  the same scheduled invocation.
