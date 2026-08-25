# Digital Membership Card

**Date:** 2026-08-24
**Status:** Draft for review
**Worker:** `donor-portal` (extends v1 + v2; no new Worker)
**Prior art:** `2026-08-22-donor-portal-design.md` (v1), `2026-08-24-donor-portal-v2-design.md` (v2),
`donor-portal/README.md`'s "Future candidates" section

## Context

The README's v2 brainstorm ranked a digital membership card as the highest-value future
candidate: a rendered card (name, tier, expiry, QR) donors show at partner bike shops, directly
amplifying the existing discount feature. It named an Apple/Google Wallet pass as an optional
stretch.

Discovery narrowed the wallet question specifically. iOS 27 shipped a "Create a Pass" feature
(Wallet → +, scan a QR/barcode, Visual Intelligence builds a pass from Standard/Membership/Event
templates) that needs **no Apple Developer Program membership, no Pass Type ID certificate, and no
server-side signing** — but it's a one-way, user-initiated scan with no push-update channel, so a
pass created this way is a snapshot, not a live document. Google Wallet has no equivalent: it
still requires a full Issuer account, Google's approval, and demo-mode restrictions until that
approval lands. Building a real signed-pass pipeline for both platforms (Approach B, considered
and rejected — see below) would mean two new blocking preconditions (an Apple Developer account
and a Google Wallet Issuer account) and a genuinely new subsystem (certs, secrets, push-update
webhooks) for a "future candidate" nobody has committed real demand to yet.

**Decided:** don't build a pass-issuing backend at all. Build one thing — a live, session-scoped
web card whose QR always resolves to the same live, public verify page — and let iOS 27 donors
scan themselves into Wallet for free. This keeps the "render live from Monday, nothing goes
stale" architecture rule intact (same rule that shaped the letters feature in v2): even a pass
frozen at scan time still verifies live, because the QR is a link, not a data payload.

## Goals

1. A donor can view a styled digital membership card in the portal: name, a display member
   number, tier, status, and expiry.
2. A shop can confirm a card is currently valid by scanning its QR — full name, tier, status, and
   expiry, fetched live from Monday at scan time, not from whatever was true when the card was
   viewed or scanned into Wallet.
3. iOS 27 donors can self-serve the card into Apple Wallet using the OS's own "Create a Pass"
   feature. No SVBC-operated signing infrastructure.
4. If a card's QR/link ever leaks, the donor can invalidate it and get a new one without staff
   involvement.
5. The Worker's only Monday write stays `create_item` on the Change Requests board (v2). This
   feature adds no new Monday writes.

## Non-goals (deliberate cuts)

* **Signed native passes (Approach B).** No Apple Developer Program, no Pass Type ID cert, no
  Google Wallet Issuer account, no push-update webhook. Two new blocking preconditions and a new
  subsystem for unvalidated demand — not built now. If SVBC later wants automatic in-Wallet
  updates when status/tier changes, that's a separate scoping pass on top of this.
* **Android Wallet integration.** No native equivalent to iOS 27's scan-to-Wallet exists. Android
  donors use the web card directly. Revisit only if it becomes a real ask.
* **A new Monday board or item type.** No staff-facing surface changes; this is entirely donor
  self-service plus one new Donors-board column.
* **A stored/assigned member number.** The displayed number is derived from the existing Monday
  item id, not a new field to create and maintain.

## Feature — Digital membership card

### Data model change

`DonorPortalData` gains `membershipExpiry: string` (ISO date; empty string means no expiry —
e.g. a lifetime membership), read by extending the existing `getDonorPortalData` query's
`column_values(ids: [...])` list rather than adding a new bespoke Monday read — it's the same
"membership identity" data the portal home page already fetches.

New config column: `monday.columns.membershipExpiry`. New gate `cardEnabled(config)`, same shape
as `lettersEnabled`/`changeRequestsEnabled` in `src/config.ts`: true once that column isn't
`REPLACE_WITH_COLUMN_ID`. Checked for presence via `requireKeys` like `V2_DONOR_COLUMNS`, not
folded into `REQUIRED_COLUMNS` (not deploy-blocking — same reasoning as `donorAddress`/
`donorPhone` in v2).

This is a new blocking precondition, same pattern as v1's original Status/Tier requirement and
v2's `donorAddress`/`donorPhone`: **a Membership Expiry (date) column must exist on the Donors
board** before `cardEnabled` can be true.

### Card tokens

A card's QR encodes a link, not the card data itself, so a shop's scan is always live. That link
needs an identifier that is:

* **Not the raw Monday donor item id** — donor item ids appear elsewhere in this codebase (e.g.
  change-request payloads) and shouldn't double as a public, unauthenticated lookup key.
* **Not single-use** — unlike login/magic-link tokens, the same QR gets scanned repeatedly over a
  membership period.
* **Revocable** — Feature goal 4.

New table (migration `0003_create_card_tokens.sql`):

```sql
CREATE TABLE card_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  donor_item_id TEXT NOT NULL,
  token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX idx_card_tokens_token ON card_tokens (token);
CREATE INDEX idx_card_tokens_donor ON card_tokens (donor_item_id);
```

`src/db/cardTokens.ts` — `CardTokenStore` interface, `D1CardTokenStore` implementation:

```ts
export interface CardTokenStore {
  createToken(donorItemId: string, token: string, createdAtISO: string): Promise<void>;
  findActiveDonorId(token: string): Promise<string | null>; // null: unknown or revoked
  getActiveToken(donorItemId: string): Promise<string | null>;
  revokeAllForDonor(donorItemId: string, revokedAtISO: string): Promise<void>;
}
```

**Correction from the first draft of this spec:** tokens are stored **in plaintext**, not
hashed. The session/magic-link pattern (`sha256Hex` before storage) doesn't transfer here: those
tokens are bearer credentials that must stay secret from everyone but their owner, so a D1 read
alone must not yield a usable one. A card token is the opposite by design — the donor's whole
point in generating it is to hand it to a shop via the QR, and `GET /portal/card/:donorItemId`
must be able to redisplay the *same* QR on a repeat visit (`getActiveToken`), which is only
possible if the raw value is recoverable, not just its hash. The token's unguessability (32-byte
random, same `generateToken()` used for sessions/magic-links) and revocability are what carry the
security weight here, not storage secrecy. `findActiveDonorId` does not consume the token on
lookup — a card token is looked up on every scan, not once.

**Invariant: at most one active (non-revoked) token per donor at a time.** `GET
/portal/card/:donorItemId` only calls `createToken` when `getActiveToken` returns null; `POST
.../regenerate` always revokes before creating. `getActiveToken` and `revokeAllForDonor` assume
this invariant holds — no code path calls `createToken` without first checking or clearing any
existing active token.

### Routes

* **`GET /portal/card/:donorItemId`** — authenticated. Follows the existing
  `getSessionDonorIds(c, deps)` → redirect-to-`/login`-if-null pattern from `src/routes.ts`, then
  404s (via `errorView`) if `donorItemId` isn't one of the session's own ids — identical scoping
  rule to the letters routes. `Cache-Control: private, no-store, max-age=0` (`NO_STORE`).
  `cardEnabled(deps.config)` false → a `cardUnavailableView()`, matching `lettersUnavailableView`.
  Otherwise: look up an active token via `getActiveToken`; if none exists, mint one
  (`createToken`) — auto-provisioned on first view, no separate "generate" step. Renders name, a
  derived member number (`Member #<donorItemId>`), tier, status, expiry (or "No expiration" if
  blank), an inline SVG QR encoding `${config.auth.portalBaseUrl}/verify/${token}`, and a
  "Regenerate card" form.

* **`POST /portal/card/:donorItemId/regenerate`** — authenticated, same session/scoping check.
  Calls `revokeAllForDonor` then `createToken`, redirects back to `GET /portal/card/:donorItemId`.
  D1-only — no Monday write, preserving the v1/v2 invariant that the portal's only Monday write is
  the Change Requests `create_item`.

* **`GET /verify/:token`** — public, unauthenticated, mounted at the app root (not under
  `/portal`, since it must work without a session — a shop staff member's phone has no donor
  session). `findActiveDonorId(token)`; unknown or revoked → the same generic
  "This card is not valid" message either way, mirroring the login flow's email-enumeration guard
  (don't let the response distinguish "never existed" from "revoked"). On a hit, fetches **fresh**
  donor data live from Monday (`getDonorPortalData`) — never trusts anything cached from scan
  time — and renders full name, tier, status, expiry. `Cache-Control: private, no-store,
  max-age=0`. Rate-limited per IP via the existing `deps.ipLimiter.limit(ip)` (the Cloudflare
  rate-limiter binding already used by `checkLoginRateLimit`) — this route skips the D1
  per-email attempt tracking half of that helper, since there's no email at this endpoint, and
  calls `ipLimiter.limit` directly.

### Data flow

```
GET /portal/card/:donorItemId
  │  session check → donorItemId ∈ session's matched ids; cardEnabled gate
  ▼
getActiveToken(donorItemId) → mint via createToken if none
  ▼
getDonorPortalData(donorItemId)  (existing Monday read, extended with membershipExpiry)
  ▼
Render src/card/cardView.ts → HTML card + inline SVG QR → /verify/:token

Shop scans QR:
GET /verify/:token
  │  findActiveDonorId(token) → 404-equivalent "not valid" if none
  ▼
getDonorPortalData(donorItemId)   (fresh Monday read, every scan)
  ▼
Render src/card/verifyView.ts → name, tier, status, expiry
```

### QR generation

Inline SVG, generated server-side with a small zero-I/O QR-encoding library (e.g.
`qrcode-generator`) rather than a hand-rolled encoder or a third-party QR image API — the latter
would leak the PII-bearing verify URL to an external service. This is the first runtime dependency
added to `donor-portal` beyond Hono; it does no network I/O and produces a matrix consumed
in-Worker to build the SVG.

### Privacy tradeoff (deliberate)

`/verify/:token` shows full name, tier, status, and expiry to anyone holding the link — no login
required. This is a conscious choice: shop staff need an exact name match, not a masked one, for
the discount to be checkable in practice. The mitigations are the token's unguessability
(32-byte random, same generation as session/magic-link tokens), per-IP rate limiting on the verify
route, and donor-initiated revocation (`POST /portal/card/:donorItemId/regenerate`) if a card
link ever leaks. This is the same class of tradeoff v1 already made for bike-shop discounts
(honor-system, no scan infrastructure) — this feature adds a QR but keeps the same trust model,
one link away from the same information a shop clerk would see on a physical card.

### Edge cases

* Donor has no `membershipExpiry` value set (e.g. lifetime membership) → card and verify page
  show "No expiration" rather than a blank or a parse error.
* Donor requests their card before staff have filled in `monday.columns.membershipExpiry` →
  `cardEnabled` is false at the config level, so the whole feature shows the unavailable state
  for every donor, not a per-donor error.
* Multiple donor matches under one session (shared-email households, per v1) → each donor gets
  their own card and their own token at `/portal/card/:donorItemId`, exactly like the letters
  routes' per-donor scoping.
* Regenerating invalidates the *old* token immediately (`revokeAllForDonor` runs before
  `createToken`) — a shop that scanned the old QR seconds earlier already has whatever it fetched
  live at that moment; the QR itself simply stops resolving afterward.

## Config additions (`config/svbc.json`)

```jsonc
"monday": {
  "columns": {
    // …existing keys unchanged…
    "membershipExpiry": "REPLACE_WITH_COLUMN_ID"
  }
}
```

No new top-level config section — unlike `taxLetter`/`changeRequests`, this feature needs no
board id, no wording sign-off, no per-org knobs beyond the one column id. `auth.portalBaseUrl`
(existing) is reused to build the verify link.

## Error handling

* Monday API failure while loading card or verify data → friendly retry page (`errorView`),
  same convention as the letters routes' 500 handling — never a partial card.
* D1 failure while minting/revoking a token → the route returns an error; nothing is rendered
  with a token that wasn't durably stored, so a donor never sees a QR that can't resolve.
* Unknown, malformed, or revoked token at `/verify/:token` → identical "not valid" response in
  all three cases (no distinguishing signal).
* Rate limit exceeded on `/verify/:token` → 429, same copy convention as the existing 429 in
  `src/routes.ts`.

## Testing (vitest, per existing per-module convention)

* `card/loadCardData.ts` (or equivalent pure module): member-number formatting, expiry
  formatting/blank handling, tier/status pass-through.
* `db/cardTokens.ts`: real-D1 tests via the `cloudflare:workers` env idiom (matches
  `sessions.test.ts`/`changeRequests.test.ts`) — create/lookup, revoke invalidates lookup,
  multiple tokens per donor over time.
* Views: card and verify view render tests (escaping of donor-sourced strings, QR SVG present,
  "No expiration" branch).
* Routes: session scoping (redirect when logged out, 404 on a foreign `donorItemId`), gated-off
  behavior while `membershipExpiry` is a placeholder, regenerate invalidates the prior token
  (old token 404s at `/verify`, new one resolves), verify route's generic response for
  unknown/revoked tokens, verify route fetches fresh data (not stale) on each call, rate-limit
  429 on the verify route.

## Dependencies and rollout order

1. **Monday:** staff add a Membership Expiry (date) column to the Donors board and fill in
   `monday.columns.membershipExpiry` — gates the entire feature (`cardEnabled`).
2. No people-dependency equivalent to v2's letter-language sign-off — nothing here needs SVBC
   copy approval before it can ship.
3. No new Monday write access needed — the portal's integration user keeps its existing
   read-only-plus-Change-Requests-board posture.
4. Future promotion path (not built now, not blocked by this): if Android Wallet support or
   automatic in-Wallet updates become a real ask, that's Approach B from Context — a separate
   scoping pass covering the Apple Developer Program and Google Wallet Issuer preconditions.
