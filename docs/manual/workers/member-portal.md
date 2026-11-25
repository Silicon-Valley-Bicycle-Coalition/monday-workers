# member-portal

[Appendix A](../reference/member-portal.md) lists this Worker's routes, crons, queues, storage and bindings.

`member-portal` is two Workers built from one directory. The portal deploys as
`svbc-member-portal` on the custom domain `member.bikesiliconvalley.org` (sandbox
`svbc-member-portal-sandbox` on `member.sandbox.bikesiliconvalley.org`; `workers.dev` is off). It
reads Monday through the broker's `PortalToken` entrypoint, which has no write scope. The writer,
`svbc-member-portal-writer` (sandbox `svbc-member-portal-writer-sandbox`, config
`wrangler.writer.jsonc`), serves no traffic, consumes the change-request queue, and writes Monday
through `SyncToken`.

## What it does

It is SVBC's only donor-facing site. A donor signs in with an emailed link and sees their giving
history, membership and digital membership card, bike shop discounts, year-end tax letters,
volunteer history, events and pledges, and can ask staff to change their contact details or
preferences. If it stops, donors cannot sign in, shop clerks cannot verify membership cards, and
letter-ready emails do not go out.

## Trigger and data flow

### Portal requests (HTTPS)

1. A donor enters an email at `POST /`. The Worker rate-limits (per IP with
   `LOGIN_RATE_LIMITER`, per address in D1 `login_attempts`), looks the address up on People, and
   emails a magic link through Cloudflare Email Sending (`EMAIL` binding). The response is the
   same whether or not the address exists.
2. The link carries a single-use token in the URL fragment, valid 15 minutes. `GET /auth/callback`
   only renders a "Continue" button; the `POST` consumes the token, so mail scanners cannot burn it.
3. The Worker sets an httpOnly session cookie (session stored in D1 as a hash).
4. Every page reads live from Monday, scoped to the session's People item ids. One email that
   matches several people shows each under its own name.

Other routes: `GET /verify/:token` is the public membership card check (no session; reads
status live). `/:locale/portal/letters` renders tax letters as printable HTML. Every
state-changing form is CSRF-checked. The only third-party script (Double the Donation's
employer search) runs in a sandboxed, opaque-origin document at
`/:locale/portal/matching-gifts/search`.

### Change requests (queue → writer)

1. A donor submits an address, email, phone, employer or communication-preference change. The
   portal records it in D1 `change_requests` and enqueues it on `member-portal-change-requests`.
2. The writer creates an item on the staff Change Requests board. Staff apply the change to
   People by hand. The portal never edits donor records.
3. For an Employer answer that names exactly one Organization, the writer makes that affiliation
   Current and Primary on the Affiliations board and logs an `Employer (applied)` item.
   `donation-rollups` then updates Employer Name.

### Letter-ready emails

- **Staff button:** a Monday automation on People's "Send Giving Letter" button posts to
  `POST /webhooks/monday/letters?secret=…`. The portal records a `letter_sends` row and enqueues
  on `member-portal-letter-emails`, which the portal itself consumes and emails.
- **January cron:** the daily cron reads the Letter Settings board. Once Auto-send is checked and
  the start date has passed, it triggers the same send for every donor with countable gifts in the
  prior calendar year, up to `letterCron.maxTriggersPerRun` (200) a day.
- Each donor+year is sent at most once. Nothing sends until `taxLetter` is signed off.

### Cron: `0 9 * * *` (daily, production only)

Runs the January letter sweep and purges expired `sessions`, `magic_link_tokens`,
`login_attempts`, old `change_requests` and revoked `card_tokens` (at most 10,000 rows per table
per run).

### D1 tables

`sessions`, `magic_link_tokens`, `login_attempts` (hashed addresses), `card_tokens` (plaintext,
because the QR code is redrawn from them), `change_requests`, `letter_sends`. The writer shares
the same database.

## Monday boards and columns

Ids live in `config/svbc.json` (production), `config/sandbox.json` (sandbox) and
`config/local.json` (local dev). Most features are gated: a missing or `REPLACE_WITH_*` id hides
the feature rather than failing.

| Board | Portal reads | Writer writes |
|---|---|---|
| People | Email, name, Membership Status, Membership Tier, Member Until, Lifetime Giving, Address, Phone, Employer Name, Preferred Language, opt-out checkboxes | Nothing |
| Donations | Donor, Amount, Date, Status, Gift Type | Nothing |
| Organizations | Discount Offered, Discount Active; names (employer match) | Nothing |
| Change Requests | | Donor link, Field, Old Value, New Value, Submitted |
| Letter Settings | Auto-send, Auto-send start date, Email body template (and per-locale templates) | Nothing |
| Affiliations | Person, Organization, Status, Primary | Status, Primary, new affiliations |
| Volunteers, Event Registrations, Events, Pledges | Shift, registration and pledge columns | Nothing |

Rules that matter:

- Only Donations with Status `Received` or `Received (Historical)` count
  (`donations.countableStatuses`).
- Donation history shows gifts from `donations.historyStartISO` (2026-01-01) and appears only
  from `donations.historyVisibleFromISO` (2027-01-01).
- Tax letters and organization statements acknowledge only Gift Types in
  `taxLetter.acknowledgedGiftTypes` and list Donor Advised Fund gifts separately. A blank or new
  Gift Type is left off until it's added to a list.

## Secrets

| Name | Worker | Purpose | Issued by | Rotate |
|---|---|---|---|---|
| `LETTER_WEBHOOK_SECRET` | Portal | `?secret=` on the "Send Giving Letter" Monday automation URL (or `X-Webhook-Secret` header) | Generated by the operator; different per environment | `wrangler secret put`, then update the automation's URL in Monday. Rotate if logs are shared or a board admin leaves |
| `MONDAY_API_TOKEN` | Both | Optional fallback only; the broker binding is the normal path | Monday (SVBC Integration user) | Do not add new uses |

No email API key: the `send_email` binding needs none. The Double the Donation key in config is a
**public** plugin key, not a secret. The writer needs no secret of its own: it uses the shared D1,
`FLAGS` and the `MONDAY_AUTH` binding.

## Write switch

Key `member-portal:writes` in `FLAGS` (`sandbox-FLAGS`), shared by the portal and the writer. Set
with `node scripts/flags.mjs member-portal writes on|hold|off --env production|sandbox`.

| Path | `on` | `hold` | `off` | KV error |
|---|---|---|---|---|
| Login, change-request POSTs, card regenerate | Live | 503 page | 503 page | 503 page |
| GETs, `/auth/callback` POST, logout | Live | Live | Live | Live |
| `POST /webhooks/monday/letters` | Live | Recorded; queue paused | Skip line, 200, no row | 503 (Monday retries) |
| Letter cron | Runs | Skips | Skips | Skips |
| Retention purges | Run | Run | Run | Run |

**Set `writes on` before deploying.** A missing key means `off`, and under `off` donors cannot
sign in. A dry-run change request stays `queued` and is never written later. See
[Operations](../07-operations.md).

### Writer

The writer reads the same key. Under `hold` change requests wait on the queue. Under `off` it
reads but logs skip lines instead of creating items or affiliations.

## Failure modes

| Symptom | Cause | What to do |
|---|---|---|
| Donors see "temporarily unavailable" on sign-in | Write switch is `hold`, `off`, missing, or KV unreadable | `node scripts/flags.mjs status --env production`; set `writes on` |
| "Check your email" but no email arrives | Address not on People; per-address cap (1 a minute, 5 per 15 minutes, 10 a day); migration `0006` missing; Email Sending issue | Check Workers Logs. Confirm the address on People |
| Login POST returns Cloudflare 429 | Zone WAF rule: over 20 POSTs a minute from one IP (shared by the sandbox and production hosts) | Wait 10 minutes. Heavy sandbox testing can block production for that IP |
| Link says invalid | Expired, already used, or JavaScript off (the fragment cannot be read) | Request a new link |
| Change requests not on the board | Writer not deployed or failing; switch on `hold` | Check the writer's logs; check `member-portal-change-requests-dlq` after a Monday outage |
| Every request fails config validation after a deploy | A new config stanza missing (each version requires its stanza to exist) | Copy the stanza from `config/svbc.json` |
| Letter never sent for one donor | `letter_sends` row stuck `sending` (crash between claim and send) or `skipped` (no email) | Fix the data; for `sending`, `UPDATE letter_sends SET status = 'queued' WHERE id = …`, then click the button |
| Letter emails send twice after a board rebuild | `letter_sends` dedupe keyed on old item ids | Follow README "Resetting for new board ids" and settle with staff before re-arming |
| Card verify page fails for everyone | Board rebuilt; `card_tokens` point at old items | Clear `card_tokens` (README reset); donors get new tokens on next visit |
| Writer deploy fails to attach | Queues allow one consumer; the portal still consumes the change queue | Deploy the portal first, then `npm run deploy:writer` |

DLQs (`member-portal-change-requests-dlq`, `member-portal-letter-emails-dlq`) have no consumer.
A non-empty DLQ is a backlog to inspect by hand; messages expire at the queue's retention.

## Operator scripts

Run from `member-portal/` as a Monday admin (board creation needs more than the integration
user has).

| Script | When | Command |
|---|---|---|
| `setup-production-boards.mjs` | Once per environment: the Organizations discount columns and the Change Requests board | `MONDAY_API_TOKEN=... node scripts/setup-production-boards.mjs --org-board-id <id> --donors-board-id <id> --historical-board-id <id> --workspace <id> [--name "Change Requests"]` |
| `create-letter-settings-board.mjs` | Once per environment, before the January send; prints the `letterCron` config block | `MONDAY_API_TOKEN=... node scripts/create-letter-settings-board.mjs --workspace <id>`; `--add-locale-columns <boardId>` upgrades an older board |

## Changing it

Key files: `src/index.ts` (portal entry, queue and cron), `src/writer.ts` (writer entry),
`src/routes.ts`, `src/flags.ts` (**canonical** write-switch module; copy it to every other Worker
after editing), `src/writeSwitch.ts`, `src/securityHeaders.ts`, `src/email/`,
`src/changeRequests/` (`employerName.ts` is canonical; `impact-attribution` holds a copy),
`src/letters/`, `config/*.json`.

Gotchas:

- Never add `allow-same-origin` to `SEARCH_SANDBOX_FLAGS`.
- `config/split.test.ts` pins each environment's `portalBaseUrl` to its custom domain and keeps
  sandbox and production sinks apart. The sandbox `EMAIL` binding only allows
  `sandbox@bikesiliconvalley.org`, and the code rewrites every recipient to it.
- Every new config stanza must exist in all configs before code that reads it deploys.
- `npm run dev` uses production config; use `npm run dev:sandbox` or `npm run dev:local`
  (`wrangler.local.jsonc`, local D1).

Tests: `npm test` (workerd, D1 migrations per run), `npm run typecheck`. Deploy in this order:

```sh
npx wrangler d1 migrations apply svbc-member-portal --remote   # add --env sandbox and the -sandbox name for sandbox
npm run deploy            # or deploy:sandbox
npm run deploy:writer     # or deploy:writer:sandbox
```

The zone WAF rate-limit rule on the login form lives in the Cloudflare dashboard, not in
`wrangler.jsonc` (see `DEPLOY.md` Phase 4).

## Further reading

- [`member-portal/README.md`](../../../member-portal/README.md), especially [Security notes](../../../member-portal/README.md#security-notes), [Deploying: the write switch](../../../member-portal/README.md#deploying-the-write-switch) and [Resetting for new board ids](../../../member-portal/README.md#resetting-for-new-board-ids).
- [`member-portal/DEPLOY.md`](../../../member-portal/DEPLOY.md): first-deploy runbook, sandbox, rollback.
- [UAT script](../../uat/member-portal.md).
- Design specs: [donor portal](../../superpowers/specs/2026-08-22-donor-portal-design.md), [donor letter emails](../../superpowers/specs/2026-08-24-donor-letter-emails-design.md), [digital membership card](../../superpowers/specs/2026-08-24-digital-membership-card-design.md), [donor employer answer](../../superpowers/specs/2026-11-16-donor-employer-answer-design.md), [sandbox environment](../../superpowers/specs/2026-09-18-sandbox-environment-design.md).
- [`monday-auth`](monday-auth.md) for the accepted risk of the portal's read token.
- [Operations](../07-operations.md), [Troubleshooting](../08-troubleshooting.md).
