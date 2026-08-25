# First-deploy runbook — donor-portal

Ordered checklist for taking this Worker from "merged to main" to serving donors at
`portal.bikesiliconvalley.org`. Written for the first deploy; later deploys are just
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
3. **Integration user:** create a dedicated Monday user (e.g. `donor-portal@bikesiliconvalley.org`)
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
- `email.fromAddress` / `fromName` — e.g. `login@mail.bikesiliconvalley.org` / `SVBC Donor Portal`
- `auth.portalBaseUrl` — `https://portal.bikesiliconvalley.org`
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
     --to "staff@bikesiliconvalley.org" --subject "Donor portal test" --text "Test send."
   ```

## Phase 4 — Cloudflare provisioning

From `donor-portal/`, in order:

```sh
wrangler d1 create svbc-donor-portal        # paste the returned id into wrangler.jsonc database_id
wrangler d1 migrations apply svbc-donor-portal --remote   # applies 0001 + 0002
wrangler queues create donor-portal-change-requests
wrangler queues create donor-portal-change-requests-dlq
wrangler secret put MONDAY_API_TOKEN        # paste Phase 1 token
                                             # (no email secret to set — the send_email binding
                                             # in wrangler.jsonc needs no API key)
```

Then add the custom domain to `wrangler.jsonc` (currently absent — `workers_dev` is already
disabled, so without this the Worker deploys unreachable):

```jsonc
"routes": [{ "pattern": "portal.bikesiliconvalley.org", "custom_domain": true }],
```

Commit the `database_id` + `routes` edits, then:

```sh
npm test && npm run typecheck
npm run deploy
```

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
  `donor-portal-change-requests-dlq` after any Monday outage (a non-empty DLQ is a replayable
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
  checkbox + start date; see README v2.2). The date-`between` items_page filter in
  `listDonorIdsWithDonationsInYear` was verified live against the sandbox Donations board
  (2026-08-25), unlike the Phase 5 NOTE-flagged shapes. Subrequest budget: each triggered donor
  costs roughly one Monday fetch, a few D1 calls, and a queue send, so the default
  `letterCron.maxTriggersPerRun` of 200 lands around 800–900 subrequests per invocation against
  the paid plan's 1,000/invocation limit — lower it before raising anything else that runs in
  the same scheduled invocation.
