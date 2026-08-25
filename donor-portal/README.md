# donor-portal

**Status:** Live — v1 deployed (login + read-only donation history and member discounts). v2 in
development.
**Priority:** Post-migration, non-blocking on the October cutover.
**Owner:** Unassigned.
**Stack:** Hono + TypeScript, D1 (tokens/sessions and queued change requests — Monday stays the
system of record for donor data).

## The ask

Let donors log in themselves to see their own donation history and their membership benefits —
specifically, discounts at local bike shops. Everything else in this plan is staff-facing; this is
the first donor-facing surface.

## Why this is a different kind of build than everything else here

Every other Worker in this plan sits inside SVBC's own trust boundary — staff, volunteers, board
members, already on Slack/Google Workspace. This one is public-facing, handles another person's
financial history, and needs a real login. Treat it with the caution that implies: read-only, no
password storage, tightly scoped data access, and two things deliberately **cut from v1** rather
than silently assumed in:

* **Tax-deductibility receipts.** Showing a donor their own giving history is not the same
  document as an IRS-compliant annual acknowledgment letter. Monday has no receipting primitive
  (same gap noted in the Funraise Option B/C discussion in the plan) and generating compliant tax
  documents is real compliance surface this build doesn't take on. **Decided 2026-08-21: scoped
  as its own separate deliverable** (likely a Workers cron generating year-end letters from the
  Donations board — see the plan's Post-Migration Follow-ups). Say so explicitly in the UI copy
  so donors don't mistake this portal for a tax document.
* **Editing their own info.** Read-only, for the same rollback-safety reason
  `workers/salesforce-import` never writes back to Salesforce. A self-service edit path needs its
  own scope (validation, an audit trail, a staff review step) and shouldn't ride along with "let
  them see their data."

## Blocking precondition — resolved

**Resolved 2026-08-21: the minimal Status/Tier slice is confirmed stable to build against**, ahead
of the full renewal-workflow design. The original reasoning, kept for context:

**The Membership board needs a Status and a Tier field before this can be built at all** —
"membership benefits" is meaningless without knowing whether someone's membership is current and
which tier they're in. Per
`docs/06-staff-process-guide.md` (private planning repo) §8, **no Membership
board design exists yet**, full stop. This Worker needs only that minimal two-field slice, not the
full renewal-workflow design (what triggers a reminder, what "lapsed" means operationally) — but
that slice is a real prerequisite, not a nice-to-have. Don't let this Worker's existence pressure
that design into being rushed; if the minimal slice isn't stable, wait.

## Data flow

```
Donor visits the portal (a subdomain, e.g. portal.bikesiliconvalley.org), enters their email
  ▼
Cloudflare Worker (Hono + TypeScript, D1 for tokens/sessions)
  │  looks up the email against the Donors board via Monday's GraphQL API
  │  generates a signed, single-use token (short expiry — e.g. 15 min) and stores it in D1
  │  emails a magic link containing the token
  ▼
Donor clicks the link
  │  Worker verifies the token against D1 (single-use — invalidate on first use), issues a
  │  signed, httpOnly session cookie
  ▼
Portal renders, server-side (Hono — no SPA framework needed for a page this small), reading
live from Monday, scoped only to the authenticated Donor's own item id (never client-supplied):
  │  • Donations connected to this Donor → history list + running total (the existing
  │    $ Donated mirror column already computes this)
  │  • Membership Status/Tier on this Donor → matching Organizations tagged
  │    Discount Active = true → their discount terms
  ▼
Nothing is written back to Monday at any point.
```

## Auth: passwordless email magic link, not username/password

SVBC has no reason to store donor passwords — pure breach liability with no offsetting benefit at
this scale, and one more credential for a donor to forget. A donor enters their email; if it
matches a Donors-board item, they get a login link; if it doesn't, show the same "check your email"
message either way (don't reveal whether an address is in the system — an email-enumeration
guard). No account-creation step, nothing to reset.

**Decided (2026-08-21): one email matching multiple Donor items → show all matches, explicitly
labeled.** Households and couples share email addresses, and dedup analysis proved collisions
exist in this data. The portal renders each matched person's history under its own name header —
people sharing an inbox already receive each other's receipts, and explicit labeling prevents
silent misattribution. Never fall into the accidental default (first match wins), which can show
one family member another's giving history unlabeled.

**Cloudflare Access (Zero Trust) was considered and ruled out for this specific use.** It's the
right fit for gating small internal tools to a handful of staff — its free tier caps at 50 users —
but this needs to serve every donor with an email on file, not a small team. Custom magic-link auth
is the correct scope match here, not a shortcut around a better-fit product.

**Rate-limit login requests** (per email and per IP) to blunt abuse of the email-sending step —
this is the one place this Worker can be used to spam an inbox if left unguarded.

## Sending the email

**Do not use Cloudflare's old free MailChannels-Workers integration — it's dead.** MailChannels
ended free sending for Workers on 2024-08-31; any tutorial or example referencing it predates that
and will not work. Two live options as of this writing, confirm current terms at build time since
pricing pages change:

* **[Resend](https://resend.com/pricing)** — free tier: 3,000 emails/month, 100/day, 3 domains.
  Simple REST API, well-documented Workers integration, no daily-limit surprises at SVBC's likely
  volume (a few hundred to low-thousands of donor logins, not 100+/day). Recommended default.
* **[MailChannels Email API](https://support.mailchannels.com/hc/en-us/articles/4565898358413-Sending-Email-from-Cloudflare-Workers-using-MailChannels-Email-API)**
  — the successor to the old free integration, also free up to 100 emails/day. A viable
  alternative if Resend's domain-verification flow doesn't fit.

Either way: a dedicated sending subdomain (e.g. `mail.bikesiliconvalley.org`) with its own SPF/DKIM
records, kept separate from the main domain's mail flow, is standard practice for transactional
email and worth setting up regardless of provider.

## Data model dependencies

* **Membership Status + Tier** on the Donors board (or a linked Membership board, once designed) —
  blocking precondition above.
* **Discount Offered (text) + Discount Active (checkbox)** on the Organizations board (proposed,
  not yet built — see `docs/06-staff-process-guide.md` §1). Extends the existing partner-type
  cleanup rather than requiring a new board: the Data Inventory section of the plan already found
  `Outdoor Shop` as an existing, if stale, picklist value on Account, confirming bike shops are
  already modeled as Organizations, just not consistently tagged for this yet.
* **Donations board's existing Donor connection and $ Donated mirror** — already live, no changes
  needed; see `docs/06-staff-process-guide.md` §2.

## Security notes

* Session and magic-link tokens: signed, single-use for the magic link, short expiry, stored in D1
  keyed to a hash of the token (not the raw token) so a D1 read doesn't itself leak a usable
  credential.
* Session cookies get an explicit server-side TTL too (hours to low days, not indefinite) —
  sessions live in D1, so expiry and logout are server-enforced, not cookie-only.
* The Worker's Monday API token comes from a dedicated integration user with access to only the
  boards this portal reads (Donors, Donations, Membership, Organizations) — never a staff member's
  personal token, which would make this public-facing Worker a door to the whole workspace. See
  `../README.md`'s least-privilege-token note.
* Every data read is scoped server-side to the authenticated session's Donor item id — the portal
  never accepts a donor-id or email as a client-supplied parameter for "whose data to show."
* HTTPS only, on its own subdomain, separate from any staff-facing tooling.
* No permanent duplicate of donation records in D1 — read live from Monday (or cache with a short
  TTL, e.g. a few minutes, purely for rate-limit headroom against Monday's API), so Monday stays
  the single place donation data actually lives.

## v2 — Year-end tax letters and change requests

Design: `../docs/superpowers/specs/2026-08-24-donor-portal-v2-design.md`. Two independent,
config-gated features:

* **Tax letters** (`GET /portal/letters`, `GET /portal/letters/:donorItemId/:year`): a
  consolidated per-year giving letter rendered live from the Donations board as HTML with print
  CSS — the browser's Print → Save as PDF is the delivery mechanism; nothing is generated or
  stored server-side. Only completed calendar years with at least one donation get a letter.
  **Gated on `taxLetter` config:** every string in it ships as `REPLACE_AFTER_SIGNOFF` and the
  feature shows a friendly "not available yet" state until SVBC signs off on the IRS
  acknowledgment language (both the plain no-goods-or-services statement and the
  benefit/quid-pro-quo variant used for tiers listed in `taxLetter.benefitTiers`) and an
  operator fills in the real wording.
* **Change requests** (`GET`/`POST /portal/change-request`): a donor submits a new address,
  email, or phone; the Worker records it in D1 (dedupe window:
  `changeRequests.dedupeWindowHours`) and a queue consumer creates an item on a staff-owned
  Change Requests board (donor link, field, old value, new value, submitted-at). Staff apply
  approved changes to the Donors board by hand — the portal never writes donor records.
  **Gated on `changeRequests.boardId`** plus its column ids and the `donorAddress`/`donorPhone`
  Donors-board column ids in config.

Operator setup for v2, in addition to the v1 steps: create the Change Requests board (five
columns: connect-boards to Donors, three text, one date) and fill in
`changeRequests.boardId`/`columns`; fill in `monday.columns.donorAddress` and
`monday.columns.donorPhone`; grant the portal's integration user **write access to the Change
Requests board only**; create the `donor-portal-change-requests` queue and its
`donor-portal-change-requests-dlq` dead-letter queue before deploying; apply D1 migration
`0002_create_change_requests.sql`; and, once the letter language is signed off, replace every
`REPLACE_AFTER_SIGNOFF` in `taxLetter`.

## v3 — Digital membership card

Design: `../docs/superpowers/specs/2026-08-24-digital-membership-card-design.md`. A donor views a
live card (`GET /portal/card/:donorItemId`) — name, member number, tier, status, expiry — with a
QR code and a plain-text link to a public verify page (`GET /verify/:token`) that always fetches
current status live from Monday, never from whatever was true when the card was viewed or
scanned. iOS 27 donors can self-serve the card into Apple Wallet via the OS's own "Create a Pass"
camera-scan feature — no Apple Developer account or signing infrastructure on our side. Android
has no equivalent yet, so Android donors use the web card directly.

**Gated on `monday.columns.membershipExpiry`:** the whole feature shows a "not available yet"
state until that column is set to a real Monday column id (same treatment as v2's
`donorAddress`/`donorPhone`). If a card's link ever leaks, the donor can invalidate it and get a
fresh one any time from `/portal/card/:donorItemId` ("Regenerate card").

Operator setup for v3, in addition to the v1/v2 steps: add a Membership Expiry (date) column to
the Donors board and fill in `monday.columns.membershipExpiry`; apply D1 migration
`0003_create_card_tokens.sql`. No new Monday write access, no new queue, no new secret.

## Future candidates (discussed 2026-08-24, not committed)

Ideas from the v2 brainstorm, in rough value order — recorded so they aren't re-derived from
scratch. None are scheduled; each needs its own scoping pass before build.

1. **January letter email distribution** — portal-only was a deliberate first-cut choice; the
   letter renderer (`src/letters/`) is an importable module so a future cron can email letters
   (or links to them) without rework. A staff-triggered per-donor "send letter" button is the
   discussed middle ground.
2. **Recurring-gift management / membership renewal** — deliberately *link out* to Funraise's
   own donor account surface and checkout rather than building anything; keeps this Worker
   entirely out of PCI scope. "Build" here means adding deep links, nothing more.
3. **Communication preferences** (email opt-outs, mailing prefs) — natural extension of the
   existing change-request queue: new form fields, same staff-review write path.
4. **Impact summary** — "your giving supported X" per year or tier; cheap even as a static
   annual number.
5. **Volunteer history** — show hours/shifts alongside donations once volunteer data lives in
   Monday post-migration.
6. **Event registrations** — upcoming/past events, dependent on the Eventbrite integration
   (itself post-migration).
7. **Pledge tracking / employer matching-gift lookup** — commonly an embedded Double the
   Donation widget; discussed, not prioritized.

**Considered and ruled out:** peer-to-peer fundraising pages and DAF tooling (Funraise's job;
heavy build, low value at SVBC's scale), and full self-serve profile editing (the review-queue
model won for rollback safety and audit trail — revisit direct writes only if the queue proves
pure overhead). Two standing architecture decisions to preserve: letters render live from
Monday (no stored PDFs to go stale after a data correction), and Cloudflare Access stays ruled
out for donor auth (free tier caps at 50 users; magic-link auth is the scope match).

## Sources

* `migration-plan.md` (private planning repo) — Integrations: Donor self-service portal
* `docs/06-staff-process-guide.md` (private planning repo) §§1, 2, 8
* [Resend pricing](https://resend.com/pricing)
* [MailChannels — End of Life Notice (Cloudflare Workers free integration)](https://support.mailchannels.com/hc/en-us/articles/26814255454093-End-of-Life-Notice-Cloudflare-Workers)
* [MailChannels Email API — sending from Cloudflare Workers](https://support.mailchannels.com/hc/en-us/articles/4565898358413-Sending-Email-from-Cloudflare-Workers-using-MailChannels-Email-API)
