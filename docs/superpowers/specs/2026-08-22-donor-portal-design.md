# donor-portal: implementation design

**Status:** Approved for implementation (2026-08-22).
**Owner:** dwk.
**Builds on:** `donor-portal/README.md` (since renamed `member-portal`; current spec: [`member-portal/README.md`](../../../member-portal/README.md)), which is the decided
product/business spec. This document covers the implementation-level decisions that README leaves
open.

## Scope recap (from the README, not re-decided here)

Public-facing Hono + TypeScript Worker, D1 for tokens/sessions only (Monday stays the system of
record). Donor enters email → if it matches one or more Donors-board items, a signed single-use
magic-link token is emailed; no confirmation either way if it doesn't (email-enumeration guard).
Clicking the link sets a session cookie. The portal renders, server-side, each matched donor's
donation history + running total and membership status/tier/discount-benefit lookup, scoped only
to the session's resolved donor item id(s) — never a client-supplied id or email. Read-only: no
writes back to Monday, no tax receipts, no self-service editing (both explicitly out of v1 per the
README).

## Decisions made in this design pass

* **Workspace:** new git worktree `monday-workers-donor-portal`, branch `feat/donor-portal`, off
  `main` — same one-worktree-per-feature-branch pattern as `monday-workers-si` and
  `monday-workers-membership-reminders`.
* **Email provider: Resend, wired for real in v1** — not a stub. Unlike `membership-reminders`
  (where a logging stub was fine because reminders aren't the only path to renewal), this Worker's
  entire login flow is inert without real delivery. This is a genuine pre-launch dependency, not
  just a code task — see Pre-launch checklist below.
* **Monday board/column IDs:** the Donors-board columns this Worker depends on (Membership Status,
  Membership Tier) and the Organizations-board columns (Discount Offered, Discount Active) don't
  exist in production yet. All IDs live in `config/svbc.json` as placeholders, following
  `salesforce-import`/`membership-reminders`'s config-as-JSON pattern. End-to-end testing against
  real Monday data waits until those columns exist; until then, all tests mock the GraphQL client
  at its boundary.
* **Multi-donor-match session model.** One email can match multiple Donor items (household/couple
  email sharing — confirmed in the dedup analysis). The magic-link request resolves the matching
  Donor item(s) **once, server-side, at request time**, and that resolved set of ids is what gets
  stored against the token and later the session — not the email. The callback and the portal
  render never re-derive matches from an email; they only ever read the id set already attached to
  the verified session. This keeps "never accept a donor-id or email as a client-supplied
  parameter for whose data to show" intact even for a session covering more than one person.
* **Rate limiting: per-IP *and* per-email, not just per-IP.** Cloudflare's native Rate Limiting
  binding throttles the login-request endpoint by IP. That alone doesn't stop someone targeting one
  specific donor's email from many IPs (e.g. rotating through a botnet or proxy pool), so a
  D1-backed per-email counter backs it up. Both limits return the identical generic "check your
  email" response as a real request — a distinct rate-limit message would itself leak whether an
  address is in the system, defeating the enumeration guard.
* **Token/session hashing:** SHA-256 via Web Crypto's `subtle.digest`, storing only the hash in D1
  (never the raw token), per the README's requirement.

## Components

* `config/svbc.json` — Donors/Donations/Organizations board IDs, column ID placeholders (Membership
  Status, Membership Tier, Discount Offered, Discount Active), Resend from-address and sending
  subdomain, magic-link TTL (~15 min), session TTL (hours to low days).
* `src/config.ts` — typed config loader, validated at startup.
* `src/monday.ts` — Monday GraphQL client: donor lookup by email (returns zero/one/many matches),
  donation history + running total fetch, membership status/tier fetch, discount-active
  organizations fetch. Every read takes a donor item id, never an email, as its scoping parameter.
* `src/auth.ts` — magic-link token generation, hashing, D1 storage keyed to the hash, single-use
  invalidation on verification, expiry enforcement.
* `src/session.ts` — session cookie issuance and verification, D1-backed session store (hash-keyed,
  same reasoning as tokens), server-enforced TTL so logout/expiry isn't cookie-only.
* `src/email.ts` — `sendLoginEmail()` via Resend.
* `src/ratelimit.ts` — combined IP (Cloudflare Rate Limiting binding) + email (D1 counter) throttle,
  both collapsing to the same response as a normal request.
* `src/index.ts` — Hono app: `GET /login` (email form), `POST /login` (resolve matches, issue
  token, send email), `GET /auth/callback` (verify token, set session cookie), `GET /portal`
  (render the session's donor(s) data), `POST /logout`. Server-rendered via Hono's `html` helper —
  no client-side framework, page is too small to need one.

## Error handling

Monday API failures, D1 read/write failures, expired or invalid magic-link tokens, and rate-limit
hits all collapse to the same generic user-facing message ("something went wrong" / "check your
email") — fail closed, and never let error variance become a side channel for whether an email
matched or a token was valid. A D1 write failure on session or token storage denies the login
rather than failing open.

## Testing

Vitest, TDD. Unit-test:

* Magic-link token generation, hashing, single-use invalidation, expiry.
* Session issuance, verification, and TTL enforcement.
* Multi-donor-match resolution (one/many/zero matches) and the resulting session id-set handling.
* Combined IP + email rate-limit logic.
* Monday GraphQL client, mocked at the boundary (donor lookup, donation history, membership/
  discount reads).
* Resend client, mocked — no live send in tests.

No live integration test against real Monday or Resend is possible until the sandbox board's
Membership/Discount columns exist and the sending domain is verified.

## Pre-launch checklist

Since this design commits to real Resend delivery (unlike `membership-reminders`'s deferred stub),
these are genuine blockers on going live, not just code:

* Provision `mail.bikesiliconvalley.org` as a dedicated sending subdomain, verified in Resend, with
  its own SPF/DKIM records, kept separate from the main domain's mail flow.
* Confirm the Donors-board Membership Status/Tier columns and the Organizations-board Discount
  Offered/Active columns actually exist in production Monday (config placeholders become real IDs).
* Mint a dedicated Monday integration-user API token scoped to only Donors, Donations, Membership,
  and Organizations — never a staff member's personal token (see the root README's
  least-privilege-token note).

## Deliberately not in v1

Extends the README's existing "deliberately cut from v1" list (tax receipts, editing donor info):

* Any additional auth method (SSO, password login) — magic link only.
* Multi-language support.
* Slack or other failure alerting on rate-limit/error spikes — error-level logging only for now,
  same posture `membership-reminders` took, revisit if it proves insufficient in practice.
