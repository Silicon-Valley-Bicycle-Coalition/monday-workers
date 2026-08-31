# Donor letter emails — design

**Worker:** `donor-portal`
**Status:** Design
**Depends on:** v2 tax letters (`docs/superpowers/specs/2026-08-24-donor-portal-v2-design.md`), already merged
**Follows up on:** README "Future candidates" #2, "January letter email distribution"

## The ask

The portal already renders each donor's year-end giving letter live from Monday
(`GET /portal/letters/:donorItemId/:year`), but nothing tells a donor it exists — they'd have to
log into the portal and think to look. This adds a staff-triggered send: a button on a Donor's
Monday item that emails that donor a "your letter is ready" notification with a link to log in.

A fully automatic January cron that emails every eligible donor is **explicitly deferred** — this
ships the send primitive (webhook → queue → email) a cron can call later without rework, per the
README's original framing. Building the cron now would mean blasting untested letter content and
untested eligibility logic at every donor before anyone's reviewed a single real send.

## Decisions (locked in during brainstorming)

* **Trigger:** Monday.com button column on the Donors board, wired via a Monday automation to POST
  to a new webhook route. Not a staff-auth'd page in the portal (no staff-auth surface exists in
  this Worker yet, and building one is out of scope for this feature) — reuses infrastructure
  that already exists (Monday automations) instead.
* **Which year:** always the most recently completed calendar year. No year picker. If that donor
  has no gifts in that year, the send is a silent no-op (matches `loadLetterData`'s existing
  behavior of returning `null` for an empty year).
* **Email content:** a notification email ("your {year} giving letter is ready") containing a
  normal magic-link login to the portal home — not the letter content itself, not a PDF
  attachment. Donor logs in and clicks through to Letters themselves.
* **Auth reuse:** the existing magic-link token schema and `/auth/callback` flow are used
  unmodified — the token still only carries "which donor(s)", same as a normal login request.
  Landing directly on the letter page would require extending the token to carry a redirect
  target; deferred as a future enhancement, not needed for this feature.
* **Duplicate-send guard:** yes. A `letter_sends` D1 table (donorId, year, sentAt) is checked
  before enqueueing; a repeat button click for a donor+year already sent is a silent no-op. This
  also doubles as an audit trail of what was sent when.
* **Gating:** inert until `taxLetter` config is signed off (same `REPLACE_AFTER_SIGNOFF` gate the
  portal-facing letters already use), since this calls the same `loadLetterData` function.

## Architecture

Follows this repo's standard webhook-driven Worker shape (same as `funraise-sync`/
`quickbooks-sync`): a Hono route validates and dedupes the incoming event into D1, then enqueues
to a Cloudflare Queue; a separate queue consumer does the actual write (here, an email send instead
of a Monday write). Queues retry automatically and route to a DLQ on exhaustion.

```
Staff clicks "Send Giving Letter" button on a Donor item in Monday
  ▼
Monday automation: POST donor-portal's webhook route, body { donorItemId }
  ▼
Hono route (src/letters/letterSendWebhook.ts)
  │  validates payload; verifies request came from Monday (shared-secret header check,
  │  same pattern as funraise-sync's inbound webhook validation)
  │  checks letter_sends D1 table for an existing (donorId, mostRecentCompletedYear) row
  │    → if present: 200 no-op, nothing enqueued (duplicate-send guard)
  │  writes a provisional letter_sends row, enqueues { donorItemId, year } to
  │    donor-portal-letter-emails queue
  ▼
Queue consumer (src/letters/sendLetterEmail.ts)
  │  loadLetterData(donorItemId, year, monday, taxLetter, now)
  │    → null (no gifts that year, or config not signed off) → no-op, done
  │  mint a magic-link token exactly as requestLogin does (same tokenStore, same TTL)
  │  emailSender.sendLetterReadyEmail({ to: donor.email, year, loginUrl })
  ▼
Donor receives "your {year} giving letter is ready" email, clicks through, logs in,
navigates to Letters tab, views/prints the letter (existing v2 flow, unchanged)
```

If the queue consumer fails after the D1 row is already written (email send throws), the queue's
built-in retry re-runs the consumer; the D1 row is written by the webhook route before enqueueing,
not by the consumer, so a retry doesn't double-write it. (Open question flagged below: this means
a permanently-failing send — e.g. bad email address — leaves a `letter_sends` row claiming a send
happened once the DLQ is hit, even though the donor never got it. Documented as a known limitation;
staff can check the DLQ for genuinely failed sends.)

## New pieces

* **`src/letters/letterSendWebhook.ts`** — Hono handler for the Monday automation POST. Validates
  `donorItemId` is present, verifies the shared-secret header, computes the most-recently-completed
  year, checks/writes the D1 dedupe row, enqueues.
* **`src/letters/sendLetterEmail.ts`** — queue consumer. Calls `loadLetterData`, mints a token via
  the existing `MagicLinkTokenStore`/`generateToken`/`sha256Hex` (same as `requestLogin.ts`), calls
  a new `emailSender.sendLetterReadyEmail(...)` method.
* **`src/email/resend.ts`** — add `sendLetterReadyEmail({ to, year, loginUrl })` alongside the
  existing `sendLoginEmail`. New subject/body copy, not gated by `taxLetter` (it's just a
  notification, no tax language in it).
* **D1 migration `000X_create_letter_sends.sql`** — `letter_sends(donor_id, year, sent_at)`,
  same shape/pattern as the existing `change_requests` migration.
* **`db/letterSends.ts`** — thin D1 accessor (check-exists, insert), same pattern as
  `db/changeRequests.ts`.
* **Queue + DLQ:** `donor-portal-letter-emails` / `donor-portal-letter-emails-dlq`, declared in
  `wrangler.jsonc` alongside the existing `donor-portal-change-requests` queue pair.
* **Config:** no new `svbc.json` keys required — reuses `resend`, `auth`, `taxLetter` as-is. The
  webhook's shared-secret lives as a Worker secret (`wrangler secret put`), not in `config/*.json`,
  consistent with how other inbound-webhook secrets are handled in this repo.

## Monday-side setup (operator task — documented in README, not built by this Worker)

1. Add a Button column ("Send Giving Letter") to the Donors board.
2. Create a Monday automation: "when button clicked → webhook" targeting the new route's URL,
   with the shared secret configured as a custom header.
3. Set the webhook secret as a Worker secret.
4. Create the `donor-portal-letter-emails` queue and its DLQ before deploying.
5. Apply the `letter_sends` D1 migration.

## Testing

Vitest, matching existing coverage style for `changeRequests/`:

* `letterSendWebhook.test.ts` — payload validation, secret-header check, dedupe-hit no-op,
  dedupe-miss enqueues
* `sendLetterEmail.test.ts` — null `loadLetterData` no-ops, happy path mints token and calls
  `sendLetterReadyEmail`, mocked Monday/Resend/D1
* `resend.test.ts` — extend for `sendLetterReadyEmail`
* D1 migration test for `letter_sends`, same shape as the `change_requests` migration test

## Explicitly out of scope

* The automatic January cron (future work, reuses `sendLetterEmail` consumer logic unchanged)
* A year picker / resend-an-older-year UI
* Redirecting straight to the letter page (requires extending the magic-link token schema)
* A staff-auth'd page inside the portal itself
* Any change to the `taxLetter` sign-off gating already in place
