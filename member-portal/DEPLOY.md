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
3. **Integration user:** create a dedicated Monday user (e.g. `member-portal@bikesiliconvalley.org`)
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
wrangler d1 create svbc-member-portal        # paste the returned id into wrangler.jsonc database_id
wrangler d1 migrations apply svbc-member-portal --remote   # applies 0001 + 0002
wrangler queues create member-portal-change-requests
wrangler queues create member-portal-change-requests-dlq
wrangler secret put MONDAY_API_TOKEN        # paste Phase 1 token
                                             # (no email secret to set — the send_email binding
                                             # in wrangler.jsonc needs no API key)
```

The custom domain is already declared in `wrangler.jsonc` (`workers_dev` is disabled, so without
it the Worker would deploy unreachable):

```jsonc
"routes": [{ "pattern": "member.bikesiliconvalley.org", "custom_domain": true }],
```

Commit the `database_id` edit, then:

```sh
npm test && npm run typecheck
npm run deploy
```

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
2. A Monday integration user with a Work Management member seat whose only board access is the
   CRM Sandbox workspace (`17141226`); mint its API token. One shared sandbox user serves every
   sandbox Worker (see the design doc §4).
3. Add `sandbox@bikesiliconvalley.org` as a **verified destination address** in the Cloudflare
   dashboard (Compute → Email Service → Email Routing → Destination Addresses) and click the
   verification link that lands in the group inbox. Sends to verified destination addresses
   are free and quota-exempt on every plan, and on Workers Free they are the only sends
   allowed — without this step the first sandbox send is rejected.

**Cloudflare, from `member-portal/`:**

```sh
wrangler d1 create svbc-member-portal-sandbox           # paste the id into env.sandbox.d1_databases[0].database_id
wrangler d1 migrations apply svbc-member-portal-sandbox --remote --env sandbox
wrangler queues create member-portal-change-requests-sandbox
wrangler queues create member-portal-change-requests-sandbox-dlq
wrangler queues create member-portal-letter-emails-sandbox
wrangler queues create member-portal-letter-emails-sandbox-dlq
wrangler secret put MONDAY_API_TOKEN --env sandbox      # the sandbox integration user's token
wrangler secret put LETTER_WEBHOOK_SECRET --env sandbox # any fresh random string
```

Phase 3 (Email Sending on `mail.bikesiliconvalley.org`) must already be done — the sandbox
sends from the same onboarded domain. Commit the `database_id`, then:

Before deploying, open the sandbox "Member Portal Letter Settings (sandbox)" board
(`18428114991`) and confirm **Auto-send is unchecked** on the "Letter emails" item. The sandbox
config arms the letter cron (`letterCron` filled, `taxLetter` test text present), so a checked
box with a past start date would queue up to `maxTriggersPerRun` (200) letter emails into the
`sandbox@` group on the first 09:00 UTC run. Re-check after any sandbox board reshuffle.

```sh
npm test && npm run typecheck
npm run deploy:sandbox
```

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
   subject `[sandbox → <that address>] Your SVBC member portal login link`. Follow the link;
   the portal renders that donor's sandbox data.
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
dashboard refuses two connections on one root directory, fall back to a GitLab CI job on `main`
that runs `npm ci && npx wrangler deploy --env sandbox` from `member-portal/` with a
`CLOUDFLARE_API_TOKEN` CI variable.

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
   response); repeated identical change requests report "already submitted."
7. **Logout + cache:** after logout, back-button must not show portal data (no-store headers).

## Go-live, rollback, and aftercare

- **Go-live** is announcing the URL to donors (site link, email footer) — the deploy itself is
  invisible until then.
- **Rollback:** `wrangler versions` + `wrangler rollback`, or remove the custom domain route —
  the Worker is read-only against Monday except the Change Requests board, and its only state
  (D1 sessions/tokens/change-request audit rows) is safe to leave in place.
- **Aftercare:** watch Workers observability for error spikes the first week; check the
  `member-portal-change-requests-dlq` after any Monday outage (a non-empty DLQ is a replayable
  backlog, not a loss — see the root README's queue conventions); confirm the daily 09:00 UTC
  cron is purging `change_requests` rows past `retentionDays` and revoked `card_tokens` rows
  past `cardTokens.retentionDays`.
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
