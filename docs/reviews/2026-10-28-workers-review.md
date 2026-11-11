# Workers review: best practices, security, staff documentation (2026-10-28)

Read-only review of every Worker and CLI in this repo, the CI config, and SVBC's staff
**Protocols** tree in Box (`Protocols/`, especially `Administrative protocols/Salesforce/` and
`Information Technology/Tech Admin/`). Each code finding below was re-checked against the source
before it went in; "checked and sound" lists what was looked at and held up.

Overall: no Critical findings. The security core is good — webhook auth fails closed everywhere,
every Monday query uses GraphQL variables, money is integer cents, the write switch is honoured on
every path checked, sandbox sinks are enforced, and member-portal's magic-link/session/CSRF/IDOR
handling is solid. The issues are mostly at the edges: secrets and tokens that reach logs via
query strings, a few missing timeouts, one lost-update race, one compliance ordering bug, and
pre-public-release CI/repo hygiene. The staff-documentation gap is larger than the code gap.

> **Point-in-time review.** Several findings below have since been fixed in code (as of
> 2026-11-11: #5 root `.gitignore`, #7 benevity DLQ consumer, Bearer auth on the custodian and
> reclassify routes, mailchimp's `secretsMatch`, quickbooks purge, svbc-calendars CORS, the
> `node:22` pin, Windfall data out of report-digests, `docs/uat/report-digests.md`). The
> `email-log` Worker and `log@` address it mentions were removed on 2026-11-04 (`1706453a`).
> Check the code before acting on any item here.

## Fix before production / before the repo goes public

Items 1–3 fixed on this branch (`e1f7553`, `74987e7`, `035da04`); item 2 needs migration
`0010_owner_leases.sql` applied to each remote D1 before its next deploy.

| # | Area | Finding | Fix |
|---|---|---|---|
| 1 | `mailchimp-sync` | `src/consumer/outbound.ts:103` runs `updateMember` before the Do Not Solicit unsubscribe (`:115`). A permanent Mailchimp error on a merge field is acked, so a **confirmed DNS donor is never unsubscribed**. | Do the DNS unsubscribe first, or in its own try block. |
| 2 | `donation-rollups` | Lost update: `max_concurrency: 3` and `recomputeOwner` (`src/consumer/processBatch.ts:362-441`) reads then writes the owner with no version check. A stale recompute can overwrite a fresh one; a plain amount edit gets no further webhook and reconcile only reports. README:558-560 claims re-convergence. | Serialize per owner (D1 in-flight marker / re-enqueue if a newer webhook arrived after fetch), or have reconcile enqueue recomputes for mismatches. Fix the README claim. |
| 3 | `people-reclassification` | `src/index.ts:68` passes `ledger.lastRun()` unfiltered to `decideCron`; a `?dryRun=true` preview stops continuation of an unfinished live pass, delays the threshold pass 7 days, and can consume the quarterly pass. | `lastRun({ dryRun: false })` for the cron decision; add a duties test. |
| 4 | CI | `.gitlab-ci.yml` runs on every `merge_request_event` and the deploy jobs use `$CLOUDFLARE_API_TOKEN`. Once public, an MR could echo an unprotected variable. | Mark the variable Protected + Masked, protect `main`, keep fork-MR parent pipelines off, scope the token to the sandbox scripts, consider a manual protected `environment:`. Pin `node:22` to a minor/digest. |
| 5 | Repo hygiene | `geo-filter` writes `geo-filter-matches.csv` (names + coordinates) into cwd with no ignore rule; `salesforce-import`'s `data/` resolves against cwd, and root `.gitignore` has no `data/`. | Add `geo-filter/.gitignore` (`*.csv`) and `data/` to the root `.gitignore`. |
| 6 | Repo hygiene | `salesforce-import/src/load/columnValues.test.ts:54,61,66` has oddly formatted phone numbers that look lifted from real rows. | Human check; replace with `555-01xx`. |
| 7 | `benevity-import` | DLQ declared (`wrangler.jsonc:27,79`) but never consumed; an exhausted gift expires silently, and re-upload is a no-op. | Add a DLQ consumer that marks the row failed and raises a worklist item. |

## Secrets and tokens in URLs (one theme, several Workers)

Workers Logs record full request URLs, and observability is on everywhere.

- **`member-portal`**: magic-link and tax-letter tokens are GET query parameters; letter links
  live 168h. Anyone with log access can redeem an unclicked one. Move the token to the URL
  fragment (copied into the confirm form by an inline script), or document it and shorten
  `letterLinkTtlHours`.
- **`donation-rollups`**: the custodian routes (`archive`, `sweep`) are protected by
  `MONDAY_WEBHOOK_SECRET` (`src/index.ts:87`), the same value that sits in the Monday webhook URL.
  Give them their own secret in a header.
- **`people-reclassification`**: operator `POST /reclassify/run?secret=`. Switch to
  `Authorization: Bearer`, as `report-digests` already does.
- **Webhook `?secret=`** (Funraise, Eventbrite, Monday can't send headers): accepted trade-off,
  documented in funraise-sync only. Say so in quickbooks-sync and benevity-import too, and restrict
  log access.

## Other security findings

- **`bp-feedback-notify`** sends to `payload.organizerEmail` with free-text `eventName` straight
  from the request body (`src/index.ts:105-109`): anyone holding the URL secret can send
  SVBC-branded mail anywhere. Take only `itemId` from the payload and read the rest from the board.
  `eventName` also reaches the Subject without CR/LF stripping — reuse email-log's `oneLine()`.
  No dedupe on retries (accepted in README; a KV "sent" key is cheap).
- **`member-portal` login**: every request past the IP limiter is recorded against the email
  even when denied (`src/ratelimit.ts:37-40`), so rotating IPs can keep a donor locked out and
  send ~480 emails/day. Count only sends; add a per-address cooldown and daily cap. Also: keep only
  exact (case-insensitive) email matches from `findDonorsByEmail`; hash emails in `login_attempts`.
- **`monday-backup`**: service account is Content manager with full `drive` scope — a leaked key
  can delete every snapshot. Use Contributor (check `ensureFolder`), or copy to a second drive;
  document key rotation.
- **`quickbooks-sync`**: Customer/Invoice PII and the OAuth refresh token kept in D1 indefinitely
  in plain text, no purge (funraise and benevity purge daily). Add the purge; consider
  AES-GCM-encrypting the refresh token. Monday secret compared with `!==`
  (`src/monday/webhook/route.ts:31`); missing `QB_WEBHOOK_VERIFIER_TOKEN` fails closed only by a
  500.
- **`mailchimp-sync`**: secret compares use `!==` (`webhook/outboundRoute.ts:38`,
  `inboundRoute.ts:30`). Copy `secretsMatch`.
- **`report-digests`**: production `send_email` binding has no `allowed_destination_addresses`;
  digests include Windfall wealth-screening data. Restrict recipients to staff addresses or reject
  non-`@bikesiliconvalley.org` users.
- **`check-monday-token-scope.mjs`** queries `boards(state: active)` only, so a token that still
  reads archived donor boards reports OK. Use `state: all`.
- **`svbc-calendars`**: CORS allowlist is a no-op (falls back to `*`) and responses are cached
  without `Vary: Origin` — just send `*`. Public 502s and `/status.json` expose upstream error
  detail. Widget puts `logo_url`/`url` into `innerHTML` unescaped.
- **`email-log`**: go-live must stay blocked on the documented `Authentication-Results` live
  check; everything else in its sender authentication held up.

## Reliability / Workers best practices

- **Missing fetch timeouts**: quickbooks-sync Intuit calls (a hung token refresh can outlive its
  30 s lease and trigger the double-refresh lockout), mailchimp-sync (single-concurrency queue
  stalls), svbc-calendars adapters (a hung source blocks the KV fallback and the daily cron loop).
  Add `AbortSignal.timeout(...)`.
- **benevity-import** parses the whole CSV inside the webhook request with no size/time cap and one
  D1 round trip per row. Record and enqueue, parse in the consumer; batch the upserts.
- **Retry everything**: funraise-sync and eventbrite-sync retry deterministic 4xx for ~4 days.
  Borrow quickbooks-sync's `TerminalError`.
- eventbrite-sync: use `sendBatch` for attendee fan-out. Eventbrite and QuickBooks amounts ignore
  currency (benevity routes non-USD to review).
- people-reclassification: no lock between an HTTP run and the cron.
- benevity-import: no operator path back for rows ingested under `off` — add a runbook note.

## Checked and sound

Fail-closed, constant-time webhook auth in funraise, eventbrite, benevity, donation-rollups,
bp-feedback-notify, member-portal; QuickBooks HMAC over the raw body plus realm check; Monday
challenge behind the secret; no GraphQL interpolation anywhere; Eventbrite pointer-only refetch
with origin validation; integer-cent money; Pacific-time/fiscal-year handling; write-switch
dry-run proxies; DLQs consumed (except benevity); email-log DKIM alignment, SMTP reject (no
backscatter), replies only to authenticated staff; mailchimp-sync never resubscribes;
member-portal 256-bit hashed tokens, single-use atomic consume on POST, `HttpOnly; Secure;
SameSite=Lax`, app-wide CSRF, no IDOR, no login enumeration, escaped HTML, safe `/lang` redirect;
monday-backup RS256 JWT, cron-only surface, dry-run-default restore CLI; report-digests escaping
and sandbox sink; `.env`/`.dev.vars` ignored and no secrets or data in git history; log-safety
hook wired. svbc-calendars 105/105 and monday-backup 227/227 tests pass; the other Workers had no
`node_modules`, so their suites were not run.

## Staff documentation vs. the Box Protocols

The repo's staff docs (`docs/uat/`, per-Worker README "Staff use" sections) are good, but nothing
in Box — SVBC's official protocol library — reflects the new system yet.

1. **The Box index and tech protocols still describe Salesforce.** `Index of Protocols.docx` (last
   edited 2024-02) has a Salesforce section and no Monday one; `Tech Tools protocol` says Monday is
   "being considered"; `Information Technology.docx` lists Salesforce, Events Made Easy and
   EventsCalendar.co, and nothing about Monday, Cloudflare, or the Workers. Add a Monday CRM section
   and an IT entry naming each integration, its owner, and where its runbook lives.
2. **Protocols the Workers replace have no successor**, in the Box template format (`Office
   Protocol: …`, Records Location, Author, dates):
   - `Logging Emails to Salesforce` → BCC/forward to `log@log.bikesiliconvalley.org`
     (email-log README "Staff use").
   - `Funraise and Salesforce`, `Entering payments in Salesforce`, `Donation Cloning and Email
     Acknowledgement` → how gifts now land (funraise-sync, benevity-import upload + Retry,
     hand entry on Donations).
   - `SVBC Salesforce Duplicate Management` → duplicates filed on IT Requests.
   - `Updating Email Renewal Reminders`, membership protocols → mailchimp-sync journeys and
     donation-rollups' 13-month rule.
   - `Protocol for Dataloading Contacts + Campaigns` → still "not testable yet" in
     `docs/uat/monday-boards.md`; needs a decision before it can be written.
   - The seven Salesforce report subscriptions → report-digests (who receives what, and that a
     digest due under `hold` isn't resent).
   Mark each superseded Salesforce protocol as such rather than deleting it.
3. **Stale Box copy of the UAT guide.** `Salesforce/2026 CRM Transition/Monday CRM User
   Acceptance Testing Guide.md` (2026-08-25) predates the People rename and the Drive distribution
   described in `docs/uat/README.md`. Replace it with a pointer to the Drive copies.
4. **UAT coverage gaps**: no `docs/uat/` script for `report-digests` (sandbox-deployed 2026-10-26)
   or `email-log`; the UAT index status table was last refreshed 2026-10-06.
5. **Security protocols conflict and leak.** `Cyber Security Protocol` says shared credentials go
   in a Box note; `Information Technology.docx` says Google Passwords with peer-to-peer sharing
   only, and itself contains the office Wi-Fi password in plain text. The repo's deploy checklist
   says "the password manager" without naming it. Pick one, remove the plaintext password, and
   state explicitly that Worker secrets, webhook secrets and Monday integration-user credentials
   never go in the shared Box note.
6. **Privacy policy.** The published donor privacy policy doesn't mention wealth screening
   (Windfall data now emailed in digests) or the donor portal's login emails and session cookie.
   Worth a review by whoever owns the policy — not a legal opinion.
