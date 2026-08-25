# Digital Membership Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a donor view a live membership card in the portal (name, member number, tier,
status, expiry) with a QR code that always resolves to a live, public verify page — and let iOS 27
donors self-serve the card into Apple Wallet via the OS's own scan-to-Wallet feature, with no
signing infrastructure on our side.

**Architecture:** Extends the existing `donor-portal` Worker (Hono + D1). Two new authenticated
routes (`GET /portal/card/:donorItemId`, `POST /portal/card/:donorItemId/regenerate`) plus one
new public route (`GET /verify/:token`). A new D1 table holds revocable, plaintext (not hashed —
see the spec's correction note) card tokens. The card's QR encodes a link to the verify route, not
the card data itself, so a shop's scan is always live even if the pass in someone's Wallet is
stale.

**Tech Stack:** Hono + TypeScript on Cloudflare Workers, D1, `qrcode-generator` (new dependency —
this plan's only addition beyond Hono), Vitest with `@cloudflare/vitest-plugin` (real D1 +
migrations in tests).

**Spec:** `docs/superpowers/specs/2026-08-24-digital-membership-card-design.md` — read it first,
including the "Correction from the first draft" note in the Card tokens section; this plan argues
from it.

## Global Constraints

- All commands run from `donor-portal/` inside the `monday-workers` repo (`cd donor-portal` first). There is no root package.json.
- ES modules only; vanilla TypeScript. This plan adds exactly one new runtime dependency, `qrcode-generator` — nothing else.
- TDD: every task writes the failing test first, sees it fail, then implements. Run `npm test` and `npm run typecheck` before every commit.
- Conventional commits, scoped `donor-portal` (e.g. `feat(donor-portal): …`).
- SVBC-specific values live in `config/svbc.json`, never in source. Placeholder column ids are the literal string `REPLACE_WITH_COLUMN_ID`.
- The Worker's only Monday write stays `create_item` on the Change Requests board (v2). This plan adds no new Monday writes — card tokens are D1-only.
- **Card tokens are stored in plaintext, not hashed.** Do not apply the session/magic-link `sha256Hex`-before-storage pattern here — see the spec's "Correction from the first draft" note for why a hash is unworkable for this feature.
- The two card routes under `/portal/card/...` are session-scoped exactly like the letters routes (`donorItemId` path param must be one of the session's own ids, or 404). `GET /verify/:token` is deliberately public/unauthenticated — that is the feature, not an oversight.
- All donor-visible and verify pages set `Cache-Control: private, no-store, max-age=0` (the existing `NO_STORE` constant in `src/routes.ts`).
- All user- or Monday-sourced strings are HTML-escaped at render via the existing `escapeHtml` (`src/views.ts`).
- Never commit real donor data. Test fixtures use invented names/dates only.

---

### Task 1: Config + types groundwork + Monday client extension for `membershipExpiry`

Adds the `membershipExpiry` column end-to-end: the config gate, the type, and the actual Monday
read. These are one compile unit — `DonorPortalData` gaining a required field means
`HttpMondayClient.getDonorPortalData`'s return statement must satisfy it in the same commit, or
`npm run typecheck` fails. That in turn means every test fixture building a full `DonorPortalData`
or `MondayColumns` literal needs the new field in this same task.

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `src/config.test.ts`
- Modify: `src/monday/client.ts`
- Modify: `src/monday/client.test.ts`
- Modify: `src/views.test.ts`
- Modify: `src/routes.test.ts`
- Modify: `src/portal/loadPortalData.test.ts`
- Modify: `src/letters/loadLetterData.test.ts`
- Modify: `config/svbc.json`

**Interfaces:**
- Consumes: existing `Config`, `MondayColumns`, `DonorPortalData` from `src/types.ts`; `validateConfig`, `PLACEHOLDER_COLUMN_VALUE` from `src/config.ts`.
- Produces (later tasks rely on these exact names):
  - `types.ts`: `MondayColumns` gains `membershipExpiry: string`; `DonorPortalData` gains `membershipExpiry: string` (empty string = no expiry).
  - `config.ts`: `export function cardEnabled(config: Config): boolean`.
  - `monday/client.ts`: `getDonorPortalData` now returns `membershipExpiry` sourced live from Monday.

- [ ] **Step 1: Write the failing tests**

Append to `src/config.test.ts` — first add `membershipExpiry: 'expiry_col'` to `validConfig.monday.columns` (after `donorPhone: 'phone_1',`), then add:

```ts
// Inside the existing describe('validateConfig', ...) block, alongside the other missing-column test:
it('throws when monday.columns is missing membershipExpiry', () => {
  const { membershipExpiry, ...missingExpiry } = validConfig.monday.columns;
  const broken = { ...validConfig, monday: { ...validConfig.monday, columns: missingExpiry } };
  expect(() => validateConfig(broken)).toThrow(/membershipExpiry/);
});
```

```ts
// New top-level describe block, after the existing changeRequestsEnabled block:
describe('cardEnabled', () => {
  it('is true when membershipExpiry is a real column id', () => {
    const cfg = validateConfig(validConfig);
    expect(cardEnabled(cfg)).toBe(true);
  });

  it('is false while membershipExpiry is still the placeholder', () => {
    const raw = structuredClone(validConfig);
    raw.monday.columns.membershipExpiry = 'REPLACE_WITH_COLUMN_ID';
    expect(cardEnabled(validateConfig(raw))).toBe(false);
  });
});
```

Update the top import line to add `cardEnabled`:

```ts
import { validateConfig, lettersEnabled, changeRequestsEnabled, cardEnabled } from './config';
```

Append to `src/monday/client.test.ts` — first add `membershipExpiry: 'expiry_col',` to the top-level `columns` const (after `donorPhone: 'phone_col',`), then update the existing `HttpMondayClient.getDonorPortalData` test's mock response and expectation:

```ts
// Inside the existing 'combines the donor item fields with its linked donations' test, the first
// mockResolvedValueOnce's column_values array gains a fourth entry:
column_values: [
  { id: 'status_col', text: 'Active' },
  { id: 'tier_col', text: 'Member' },
  { id: 'donated_col', text: '500' },
  { id: 'expiry_col', text: '2026-12-31' },
],
```

```ts
// And the final expect(data).toEqual({...}) gains the new field:
expect(data).toEqual({
  id: 'donor-1',
  name: 'Jane Donor',
  membershipStatus: 'Active',
  membershipTier: 'Member',
  totalDonated: '500',
  donations: [{ amount: '100', date: '2026-01-01', description: 'Annual gift' }],
  membershipExpiry: '2026-12-31',
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/config.test.ts src/monday/client.test.ts`
Expected: FAIL — `cardEnabled` not exported; `membershipExpiry` missing from `MondayColumns`/`validateConfig`; the `getDonorPortalData` test's expectation doesn't match the (unchanged) implementation's output.

- [ ] **Step 3: Implement the type changes** — `src/types.ts`:

```ts
export interface MondayColumns {
  donorEmail: string;
  membershipStatus: string;
  membershipTier: string;
  dollarDonated: string;
  donationDonorLink: string;
  donationAmount: string;
  donationDate: string;
  donationDescription: string;
  discountOffered: string;
  discountActive: string;
  donorAddress: string;
  donorPhone: string;
  membershipExpiry: string;
}
```

```ts
export interface DonorPortalData {
  id: string;
  name: string;
  membershipStatus: string;
  membershipTier: string;
  totalDonated: string;
  donations: DonationRecord[];
  membershipExpiry: string;
}
```

- [ ] **Step 4: Implement the config gate** — `src/config.ts`:

Add the column list near `V2_DONOR_COLUMNS`:

```ts
// CARD_COLUMNS deliberately isn't merged into REQUIRED_COLUMNS: this column only matters to the
// membership-card feature, which is gated (cardEnabled), not deploy-blocking. Checked for
// *presence* only, not placeholder-freedom — same treatment as V2_DONOR_COLUMNS.
const CARD_COLUMNS: (keyof MondayColumns)[] = ['membershipExpiry'];
```

In `validateConfig`, right after the existing `requireKeys(columns, 'monday.columns', V2_DONOR_COLUMNS);` line, add:

```ts
  requireKeys(columns, 'monday.columns', CARD_COLUMNS);
```

Add the gate function near `changeRequestsEnabled`:

```ts
export function cardEnabled(config: Config): boolean {
  return config.monday.columns.membershipExpiry !== PLACEHOLDER_COLUMN_VALUE;
}
```

- [ ] **Step 5: Implement the Monday read** — `src/monday/client.ts`:

In `getDonorPortalData`, extend the `column_values(ids: [...])` list:

```ts
      query ($itemId: ID!) {
        items(ids: [$itemId]) {
          id
          name
          column_values(ids: ["${this.columns.membershipStatus}", "${this.columns.membershipTier}", "${this.columns.dollarDonated}", "${this.columns.membershipExpiry}"]) {
            id
            text
          }
        }
      }
```

And the returned object:

```ts
    return {
      id: donorItem.id,
      name: donorItem.name,
      membershipStatus: columnText(donorItem, this.columns.membershipStatus),
      membershipTier: columnText(donorItem, this.columns.membershipTier),
      totalDonated: columnText(donorItem, this.columns.dollarDonated),
      donations,
      membershipExpiry: columnText(donorItem, this.columns.membershipExpiry),
    };
```

- [ ] **Step 6: Update `config/svbc.json`**

Add to `monday.columns`, after `"donorPhone": "REPLACE_WITH_COLUMN_ID"`:

```jsonc
"membershipExpiry": "REPLACE_WITH_COLUMN_ID"
```

- [ ] **Step 7: Propagate the new required field to every other `DonorPortalData` fixture**

`grep -rn "membershipStatus:" src/` after Steps 3–6 to confirm the full list; as of this plan it's
exactly these three remaining files (each constructs a `DonorPortalData` literal that must gain
`membershipExpiry: ''` — the value is irrelevant to what each test actually checks, so an empty
string keeps the diff minimal):

`src/views.test.ts` — three occurrences, in the `portalView` describe block: the two donors in the
top-level `data` fixture (`donor-1` "Jane Donor" and `donor-2` "Jane Also") and the one donor in
the inline `maliciousData` fixture inside the escaping test. Add `membershipExpiry: ''` to each of
the three object literals (alongside their existing `totalDonated` line).

`src/routes.test.ts` — two occurrences: the `fakeMonday` helper's `getDonorPortalData` mock
(`Promise.resolve({ id, name: ..., membershipStatus: 'Active', membershipTier: 'Member',
totalDonated: '0', donations: [] })`) and the `fakeMondayWithDonations` helper's mock. Add
`membershipExpiry: ''` to both resolved objects.

`src/portal/loadPortalData.test.ts` — the `donor()` helper:

```ts
function donor(id: string, name: string): DonorPortalData {
  return { id, name, membershipStatus: 'Active', membershipTier: 'Member', totalDonated: '100', donations: [], membershipExpiry: '' };
}
```

`src/letters/loadLetterData.test.ts` — the `donor()` helper gains `membershipExpiry: ''` in its
returned object (alongside the existing `totalDonated: '0'` default).

- [ ] **Step 8: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add config/svbc.json src/types.ts src/config.ts src/config.test.ts src/monday/client.ts src/monday/client.test.ts src/views.test.ts src/routes.test.ts src/portal/loadPortalData.test.ts src/letters/loadLetterData.test.ts
git commit -m "feat(donor-portal): read membershipExpiry from Monday and add the cardEnabled gate"
```

---

### Task 2: Card data module (member number + expiry formatting)

Pure logic: turn a `DonorPortalData` into the display-ready shape both the card view and the
verify view render. No Monday or D1 access — this task is data transformation only.

**Files:**
- Create: `src/card/loadCardData.ts`
- Test: `src/card/loadCardData.test.ts`

**Interfaces:**
- Consumes: `DonorPortalData` from `../types` (Task 1).
- Produces (Tasks 4 and 6 rely on this exact shape):

```ts
export interface CardData {
  donorId: string;
  donorName: string;
  memberNumber: string;
  membershipTier: string;
  membershipStatus: string;
  expiryDisplay: string;
}

export function formatMemberNumber(donorItemId: string): string;
export function formatExpiry(membershipExpiry: string): string;
export function buildCardData(donor: DonorPortalData): CardData;
```

- [ ] **Step 1: Write the failing tests** — `src/card/loadCardData.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { formatMemberNumber, formatExpiry, buildCardData } from './loadCardData';
import type { DonorPortalData } from '../types';

describe('formatMemberNumber', () => {
  it('prefixes the donor item id', () => {
    expect(formatMemberNumber('4821053')).toBe('Member #4821053');
  });
});

describe('formatExpiry', () => {
  it('formats an ISO date as a long-form date', () => {
    expect(formatExpiry('2026-12-31')).toBe('December 31, 2026');
  });

  it('treats an empty string as no expiration', () => {
    expect(formatExpiry('')).toBe('No expiration');
  });

  it('treats an unparseable value as no expiration', () => {
    expect(formatExpiry('not-a-date')).toBe('No expiration');
  });
});

describe('buildCardData', () => {
  it('combines member number, tier, status, and formatted expiry', () => {
    const donor: DonorPortalData = {
      id: 'donor-1',
      name: 'Jane Example',
      membershipStatus: 'Active',
      membershipTier: 'Champion',
      totalDonated: '$500.00',
      donations: [],
      membershipExpiry: '2026-12-31',
    };

    expect(buildCardData(donor)).toEqual({
      donorId: 'donor-1',
      donorName: 'Jane Example',
      memberNumber: 'Member #donor-1',
      membershipTier: 'Champion',
      membershipStatus: 'Active',
      expiryDisplay: 'December 31, 2026',
    });
  });

  it('shows "No expiration" for a lifetime membership with no expiry set', () => {
    const donor: DonorPortalData = {
      id: 'donor-2',
      name: 'Sam Example',
      membershipStatus: 'Active',
      membershipTier: 'Lifetime',
      totalDonated: '$1000.00',
      donations: [],
      membershipExpiry: '',
    };

    expect(buildCardData(donor).expiryDisplay).toBe('No expiration');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/card/loadCardData.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement** — `src/card/loadCardData.ts`:

```ts
import type { DonorPortalData } from '../types';

export interface CardData {
  donorId: string;
  donorName: string;
  memberNumber: string;
  membershipTier: string;
  membershipStatus: string;
  expiryDisplay: string;
}

const NO_EXPIRATION = 'No expiration';

export function formatMemberNumber(donorItemId: string): string {
  return `Member #${donorItemId}`;
}

export function formatExpiry(membershipExpiry: string): string {
  if (membershipExpiry.length === 0) {
    return NO_EXPIRATION;
  }
  const date = new Date(`${membershipExpiry}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    return NO_EXPIRATION;
  }
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

export function buildCardData(donor: DonorPortalData): CardData {
  return {
    donorId: donor.id,
    donorName: donor.name,
    memberNumber: formatMemberNumber(donor.id),
    membershipTier: donor.membershipTier,
    membershipStatus: donor.membershipStatus,
    expiryDisplay: formatExpiry(donor.membershipExpiry),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/card/loadCardData.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/card/loadCardData.ts src/card/loadCardData.test.ts
git commit -m "feat(donor-portal): membership card data — member number and expiry formatting"
```

---

### Task 3: QR SVG generator

A thin, self-contained wrapper around the new `qrcode-generator` dependency. No I/O — takes a
URL string, returns an inline SVG string.

**Files:**
- Create: `src/card/qr.ts`
- Test: `src/card/qr.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces (Task 4 consumes this): `export function generateQrSvg(text: string): string`.

- [ ] **Step 1: Install the dependency**

Run: `npm install qrcode-generator`

This updates `package.json` (`"qrcode-generator": "^1.4.4"` under `dependencies`) and
`package-lock.json`. The package ships its own TypeScript type definitions — no `@types/*`
package is needed.

- [ ] **Step 2: Write the failing tests** — `src/card/qr.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { generateQrSvg } from './qr';

describe('generateQrSvg', () => {
  it('returns an inline SVG for the given text', () => {
    const svg = generateQrSvg('https://portal.example.org/verify/abc123');
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
  });

  it('produces different output for different input text', () => {
    const a = generateQrSvg('https://portal.example.org/verify/token-a');
    const b = generateQrSvg('https://portal.example.org/verify/token-b');
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- src/card/qr.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement** — `src/card/qr.ts`:

```ts
import qrcode from 'qrcode-generator';

// NOTE: createSvgTag's options-object call shape ({ cellSize, margin }) is written from current
// qrcode-generator documentation but not exercised against every version of the library — if
// Step 3's test fails on this call shape specifically (not on the dependency being missing),
// check the installed version's README for the exact overload it expects.
export function generateQrSvg(text: string): string {
  const qr = qrcode(0, 'M'); // typeNumber 0 = auto-detect the smallest size that fits the data
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2 });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- src/card/qr.test.ts && npm run typecheck`
Expected: PASS. If `typecheck` fails on the `qrcode-generator` import itself (no default export,
or a different shape than expected), inspect
`node_modules/qrcode-generator/qrcode.d.ts` and adjust the import/call to match — this is the one
step in this plan most likely to need adjustment against the actual installed version.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/card/qr.ts src/card/qr.test.ts
git commit -m "feat(donor-portal): inline SVG QR code generator for membership cards"
```

---

### Task 4: Card + verify views

Server-rendered HTML for the card page, its disabled state, the public verify page, and its
not-valid state.

**Files:**
- Create: `src/card/cardViews.ts`
- Test: `src/card/cardViews.test.ts`

**Interfaces:**
- Consumes: `escapeHtml` from `../views`; `CardData` from `./loadCardData`.
- Produces (Task 6 renders these):

```ts
export function cardView(data: CardData, verifyUrl: string, qrSvg: string): string;
export function cardUnavailableView(): string;
export function verifyView(data: CardData): string;
export function verifyNotValidView(): string;
```

- [ ] **Step 1: Write the failing tests** — `src/card/cardViews.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { cardView, cardUnavailableView, verifyView, verifyNotValidView } from './cardViews';
import type { CardData } from './loadCardData';

const data: CardData = {
  donorId: 'donor-1',
  donorName: 'Jane <script> Example',
  memberNumber: 'Member #donor-1',
  membershipTier: 'Champion',
  membershipStatus: 'Active',
  expiryDisplay: 'December 31, 2026',
};

describe('cardView', () => {
  it('contains the donor identity, tier, status, expiry, verify link, and QR', () => {
    const html = cardView(data, 'https://portal.example.org/verify/tok123', '<svg data-testid="qr"></svg>');
    expect(html).toContain('Member #donor-1');
    expect(html).toContain('Champion');
    expect(html).toContain('Active');
    expect(html).toContain('December 31, 2026');
    expect(html).toContain('https://portal.example.org/verify/tok123');
    expect(html).toContain('<svg data-testid="qr">');
  });

  it('escapes donor-sourced text', () => {
    const html = cardView(data, 'https://portal.example.org/verify/tok123', '<svg></svg>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('points the regenerate form at this donor’s own regenerate route', () => {
    const html = cardView(data, 'https://portal.example.org/verify/tok123', '<svg></svg>');
    expect(html).toContain('action="/portal/card/donor-1/regenerate"');
    expect(html).toContain('method="post"');
  });
});

describe('cardUnavailableView', () => {
  it('says cards are not available yet', () => {
    expect(cardUnavailableView()).toContain('not available yet');
  });
});

describe('verifyView', () => {
  it('shows the donor identity, tier, status, and expiry, but not a member number', () => {
    const html = verifyView(data);
    expect(html).toContain('Jane &lt;script&gt; Example');
    expect(html).toContain('Champion');
    expect(html).toContain('Active');
    expect(html).toContain('December 31, 2026');
  });
});

describe('verifyNotValidView', () => {
  it('says the card is not valid', () => {
    expect(verifyNotValidView()).toContain('not valid');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/card/cardViews.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement** — `src/card/cardViews.ts`:

```ts
import { escapeHtml } from '../views';
import type { CardData } from './loadCardData';

export function cardView(data: CardData, verifyUrl: string, qrSvg: string): string {
  return `
    <h1>Your membership card</h1>
    <article class="card">
      <p><strong>${escapeHtml(data.donorName)}</strong></p>
      <p>${escapeHtml(data.memberNumber)}</p>
      <p>Tier: ${escapeHtml(data.membershipTier)}</p>
      <p>Status: ${escapeHtml(data.membershipStatus)}</p>
      <p>Expires: ${escapeHtml(data.expiryDisplay)}</p>
      <div class="qr">${qrSvg}</div>
      <p><a href="${escapeHtml(verifyUrl)}">${escapeHtml(verifyUrl)}</a></p>
      <p><small>Show this card, or let a shop scan the QR code or open the link above, to confirm your membership.</small></p>
    </article>
    <form action="/portal/card/${encodeURIComponent(data.donorId)}/regenerate" method="post">
      <button type="submit">Regenerate card</button>
    </form>
    <p><small>Regenerating invalidates the old QR code and link immediately — use this if you think your card link has leaked.</small></p>
    <p><a href="/portal">Back to your portal</a></p>
  `;
}

export function cardUnavailableView(): string {
  return `
    <h1>Your membership card</h1>
    <p>Digital membership cards are not available yet. Please check back soon.</p>
    <p><a href="/portal">Back to your portal</a></p>
  `;
}

export function verifyView(data: CardData): string {
  return `
    <h1>Membership verification</h1>
    <article class="card">
      <p><strong>${escapeHtml(data.donorName)}</strong></p>
      <p>Tier: ${escapeHtml(data.membershipTier)}</p>
      <p>Status: ${escapeHtml(data.membershipStatus)}</p>
      <p>Expires: ${escapeHtml(data.expiryDisplay)}</p>
    </article>
    <p><small>This information is fetched live from our records.</small></p>
  `;
}

export function verifyNotValidView(): string {
  return `
    <h1>Membership verification</h1>
    <p>This card is not valid. It may have been regenerated or is no longer active.</p>
  `;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/card/cardViews.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/card/cardViews.ts src/card/cardViews.test.ts
git commit -m "feat(donor-portal): membership card and verify page views"
```

---

### Task 5: Card tokens D1 migration + store

The durable record behind the QR: which token maps to which donor, and whether it's still active.
Stored in **plaintext** — see the Global Constraints note above and the spec's correction.

**Files:**
- Create: `migrations/0003_create_card_tokens.sql`
- Create: `src/db/cardTokens.ts`
- Test: `src/db/cardTokens.test.ts`

**Interfaces:**
- Consumes: `D1Database` (Workers types); test env via `cloudflare:workers`, same idiom as
  `src/db/changeRequests.test.ts` — migrations apply automatically via `test/apply-migrations.ts`
  once the SQL file exists.
- Produces (Task 6 relies on these exact shapes):

```ts
export interface CardTokenStore {
  createToken(donorItemId: string, token: string, createdAtISO: string): Promise<void>;
  findActiveDonorId(token: string): Promise<string | null>;
  getActiveToken(donorItemId: string): Promise<string | null>;
  revokeAllForDonor(donorItemId: string, revokedAtISO: string): Promise<void>;
}
export class D1CardTokenStore implements CardTokenStore { constructor(db: D1Database) }
```

- [ ] **Step 1: Write the migration** — `migrations/0003_create_card_tokens.sql`:

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

- [ ] **Step 2: Write the failing tests** — `src/db/cardTokens.test.ts`:

```ts
import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1CardTokenStore } from './cardTokens';

describe('D1CardTokenStore', () => {
  it('creates a token and finds its donor id while active', async () => {
    const store = new D1CardTokenStore(env.DB);
    await store.createToken('donor-1', 'token-a', '2026-08-24T10:00:00.000Z');

    expect(await store.findActiveDonorId('token-a')).toBe('donor-1');
  });

  it('returns null for an unknown token', async () => {
    const store = new D1CardTokenStore(env.DB);
    expect(await store.findActiveDonorId('no-such-token')).toBeNull();
  });

  it('returns the active token for a donor, or null if none exists', async () => {
    const store = new D1CardTokenStore(env.DB);
    expect(await store.getActiveToken('donor-2')).toBeNull();

    await store.createToken('donor-2', 'token-b', '2026-08-24T10:00:00.000Z');
    expect(await store.getActiveToken('donor-2')).toBe('token-b');
  });

  it('stops a token from resolving once revoked, for both lookup directions', async () => {
    const store = new D1CardTokenStore(env.DB);
    await store.createToken('donor-3', 'token-c', '2026-08-24T10:00:00.000Z');

    await store.revokeAllForDonor('donor-3', '2026-08-24T11:00:00.000Z');

    expect(await store.findActiveDonorId('token-c')).toBeNull();
    expect(await store.getActiveToken('donor-3')).toBeNull();
  });

  it('lets a donor get a fresh active token after revocation', async () => {
    const store = new D1CardTokenStore(env.DB);
    await store.createToken('donor-4', 'token-old', '2026-08-24T10:00:00.000Z');
    await store.revokeAllForDonor('donor-4', '2026-08-24T11:00:00.000Z');
    await store.createToken('donor-4', 'token-new', '2026-08-24T11:00:01.000Z');

    expect(await store.getActiveToken('donor-4')).toBe('token-new');
    expect(await store.findActiveDonorId('token-old')).toBeNull();
    expect(await store.findActiveDonorId('token-new')).toBe('donor-4');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- src/db/cardTokens.test.ts`
Expected: FAIL — module does not exist. (If it fails with "no such table" instead, the migration
file wasn't picked up — confirm it landed in `migrations/` alongside `0001_...` and `0002_...`.)

- [ ] **Step 4: Implement** — `src/db/cardTokens.ts`:

```ts
export interface CardTokenStore {
  createToken(donorItemId: string, token: string, createdAtISO: string): Promise<void>;
  findActiveDonorId(token: string): Promise<string | null>;
  getActiveToken(donorItemId: string): Promise<string | null>;
  revokeAllForDonor(donorItemId: string, revokedAtISO: string): Promise<void>;
}

export class D1CardTokenStore implements CardTokenStore {
  constructor(private db: D1Database) {}

  async createToken(donorItemId: string, token: string, createdAtISO: string): Promise<void> {
    await this.db
      .prepare(`INSERT INTO card_tokens (donor_item_id, token, created_at) VALUES (?1, ?2, ?3)`)
      .bind(donorItemId, token, createdAtISO)
      .run();
  }

  async findActiveDonorId(token: string): Promise<string | null> {
    const row = await this.db
      .prepare(`SELECT donor_item_id FROM card_tokens WHERE token = ?1 AND revoked_at IS NULL`)
      .bind(token)
      .first<{ donor_item_id: string }>();
    return row === null ? null : row.donor_item_id;
  }

  async getActiveToken(donorItemId: string): Promise<string | null> {
    const row = await this.db
      .prepare(
        `SELECT token FROM card_tokens WHERE donor_item_id = ?1 AND revoked_at IS NULL
         ORDER BY created_at DESC LIMIT 1`
      )
      .bind(donorItemId)
      .first<{ token: string }>();
    return row === null ? null : row.token;
  }

  async revokeAllForDonor(donorItemId: string, revokedAtISO: string): Promise<void> {
    await this.db
      .prepare(`UPDATE card_tokens SET revoked_at = ?1 WHERE donor_item_id = ?2 AND revoked_at IS NULL`)
      .bind(revokedAtISO, donorItemId)
      .run();
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- src/db/cardTokens.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add migrations/0003_create_card_tokens.sql src/db/cardTokens.ts src/db/cardTokens.test.ts
git commit -m "feat(donor-portal): card_tokens table and D1 store"
```

---

### Task 6: Routes — card, regenerate, and verify

Wires everything from Tasks 1–5 into the Hono app: the two authenticated card routes, the public
verify route, a discoverability link from the main portal page, and the `index.ts` production
wiring.

**Files:**
- Modify: `src/routes.ts`
- Test: `src/routes.test.ts` (append)
- Modify: `src/views.ts`
- Modify: `src/views.test.ts` (append)
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `cardEnabled` (Task 1); `buildCardData`, `CardData` (Task 2); `generateQrSvg` (Task
  3); `cardView`, `cardUnavailableView`, `verifyView`, `verifyNotValidView` (Task 4);
  `CardTokenStore`, `D1CardTokenStore` (Task 5); existing `AppDeps`, `getSessionDonorIds`,
  `NO_STORE`, `page`, `errorView`, `generateToken` (`src/crypto/token.ts`).
- Produces: `AppDeps` gains `cardTokenStore: CardTokenStore`; routes `GET
  /portal/card/:donorItemId`, `POST /portal/card/:donorItemId/regenerate`, `GET /verify/:token`.

- [ ] **Step 1: Write the failing tests** — append to `src/routes.test.ts`.

First add an in-memory fake store (near the other `inMemory*Store` helpers) and wire it into
`makeDeps`:

```ts
import type { CardTokenStore } from './db/cardTokens';

function inMemoryCardTokenStore(): CardTokenStore {
  const byDonor = new Map<string, string>();
  const byToken = new Map<string, string>();
  return {
    async createToken(donorItemId, token) {
      byDonor.set(donorItemId, token);
      byToken.set(token, donorItemId);
    },
    async findActiveDonorId(token) {
      return byToken.get(token) ?? null;
    },
    async getActiveToken(donorItemId) {
      return byDonor.get(donorItemId) ?? null;
    },
    async revokeAllForDonor(donorItemId) {
      const token = byDonor.get(donorItemId);
      if (token !== undefined) {
        byToken.delete(token);
        byDonor.delete(donorItemId);
      }
    },
  };
}
```

Add `cardTokenStore: inMemoryCardTokenStore(),` to the object returned by `makeDeps` (alongside
the existing `changeStore`/`changeQueue` entries).

Then append the test suites:

```ts
describe('GET /portal/card/:donorItemId', () => {
  it('redirects to /login without a session', async () => {
    const res = await createApp(makeDeps()).request('/portal/card/donor-1');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('renders the card with a verify link, QR, and no-store caching', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/portal/card/donor-1', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Member #donor-1');
    expect(html).toContain('/verify/');
    expect(html).toContain('<svg');
    expect(res.headers.get('cache-control')).toBe('private, no-store, max-age=0');
  });

  it('reuses the same verify link across repeat visits', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const first = await (await app.request('/portal/card/donor-1', { headers: { Cookie: cookie } })).text();
    const second = await (await app.request('/portal/card/donor-1', { headers: { Cookie: cookie } })).text();

    const verifyLink = /https?:\/\/\S*\/verify\/\S+/.exec(first)?.[0];
    expect(verifyLink).toBeDefined();
    expect(second).toContain(verifyLink as string);
  });

  it("404s for a donor item id that is not the session's own", async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/portal/card/other-donor', { headers: { Cookie: cookie } });
    expect(res.status).toBe(404);
  });

  it('shows the unavailable state while the membership expiry column is unset', async () => {
    const gatedConfig = structuredClone(config);
    (gatedConfig.monday.columns as Record<string, string>).membershipExpiry = 'REPLACE_WITH_COLUMN_ID';
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender, config: gatedConfig }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/portal/card/donor-1', { headers: { Cookie: cookie } });
    expect(await res.text()).toContain('not available yet');
  });

  it('shows a friendly error page when the Monday lookup throws', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    (monday.getDonorPortalData as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('monday: HTTP 500'));

    const res = await app.request('/portal/card/donor-1', { headers: { Cookie: cookie } });
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('We could not load your card right now');
  });
});

describe('POST /portal/card/:donorItemId/regenerate', () => {
  it('redirects to /login without a session', async () => {
    const res = await createApp(makeDeps()).request('/portal/card/donor-1/regenerate', { method: 'POST' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it("404s for a donor item id that is not the session's own", async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const res = await app.request('/portal/card/other-donor/regenerate', { method: 'POST', headers: { Cookie: cookie } });
    expect(res.status).toBe(404);
  });

  it('invalidates the previous verify link and issues a new one', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');

    const before = await (await app.request('/portal/card/donor-1', { headers: { Cookie: cookie } })).text();
    const oldVerifyPath = /\/verify\/\S+/.exec(before)?.[0] as string;

    const regenRes = await app.request('/portal/card/donor-1/regenerate', { method: 'POST', headers: { Cookie: cookie } });
    expect(regenRes.status).toBe(302);
    expect(regenRes.headers.get('location')).toBe('/portal/card/donor-1');

    const oldVerifyRes = await app.request(oldVerifyPath, { headers: { Cookie: cookie } });
    expect(await oldVerifyRes.text()).toContain('not valid');

    const after = await (await app.request('/portal/card/donor-1', { headers: { Cookie: cookie } })).text();
    const newVerifyPath = /\/verify\/\S+/.exec(after)?.[0] as string;
    expect(newVerifyPath).not.toBe(oldVerifyPath);
  });
});

describe('GET /verify/:token', () => {
  async function getVerifyPath(app: ReturnType<typeof createApp>, cookie: string): Promise<string> {
    const html = await (await app.request('/portal/card/donor-1', { headers: { Cookie: cookie } })).text();
    return /\/verify\/\S+/.exec(html)?.[0] as string;
  }

  it('renders live membership info for a valid token', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');
    const verifyPath = await getVerifyPath(app, cookie);

    const res = await app.request(verifyPath);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Donor donor-1');
    expect(html).toContain('Member');
    expect(res.headers.get('cache-control')).toBe('private, no-store, max-age=0');
  });

  it('shows the not-valid state for an unknown token', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/verify/no-such-token');
    expect(await res.text()).toContain('not valid');
  });

  it('reflects a Monday update made after the card was first viewed', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(makeDeps({ monday, emailSender }));
    const cookie = await loginAndGetCookie(app, emailSender, 'donor@example.org');
    const verifyPath = await getVerifyPath(app, cookie);

    (monday.getDonorPortalData as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'donor-1',
      name: 'Donor donor-1',
      membershipStatus: 'Lapsed',
      membershipTier: 'Member',
      totalDonated: '$40.00',
      donations: [],
      membershipExpiry: '',
    });

    const res = await app.request(verifyPath);
    expect(await res.text()).toContain('Lapsed');
  });

  it('rate-limits by IP', async () => {
    const monday = fakeMondayWithDonations();
    const emailSender = { sendLoginEmail: vi.fn().mockResolvedValue(undefined) };
    const permissive = makeDeps({ monday, emailSender });
    const loginApp = createApp(permissive);
    const cookie = await loginAndGetCookie(loginApp, emailSender, 'donor@example.org');
    const verifyPath = await getVerifyPath(loginApp, cookie);

    const ipLimiter = { limit: vi.fn().mockResolvedValue({ success: false }) };
    const limitedApp = createApp({ ...permissive, ipLimiter });

    const res = await limitedApp.request(verifyPath);
    expect(res.status).toBe(429);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/routes.test.ts`
Expected: new tests FAIL (404 from Hono for unknown routes, or `cardTokenStore` missing from
`AppDeps`); pre-existing tests PASS.

- [ ] **Step 3: Implement** in `src/routes.ts`:

Extend the imports:

```ts
import type { CardTokenStore } from './db/cardTokens';
import { changeRequestsEnabled, lettersEnabled, cardEnabled } from './config';
import { generateToken } from './crypto/token';
import { buildCardData } from './card/loadCardData';
import { generateQrSvg } from './card/qr';
import { cardView, cardUnavailableView, verifyView, verifyNotValidView } from './card/cardViews';
```

Extend `AppDeps`:

```ts
export interface AppDeps {
  monday: MondayClient;
  tokenStore: MagicLinkTokenStore;
  sessionStore: SessionStore;
  attemptStore: LoginAttemptStore;
  emailSender: EmailSender;
  ipLimiter: IpRateLimiter;
  config: Config;
  now: () => Date;
  changeStore: ChangeRequestStore;
  changeQueue: { send(message: ChangeQueueMessage): Promise<void> };
  cardTokenStore: CardTokenStore;
}
```

Add title constants near the existing ones:

```ts
const TITLE_CARD = `Your Membership Card — ${SITE_TITLE}`;
const TITLE_VERIFY = `Membership Verification — ${SITE_TITLE}`;
```

Add the three routes inside `createApp`, after the change-request routes and before `POST
/logout`:

```ts
  app.get('/portal/card/:donorItemId', async (c) => {
    const donorItemIds = await getSessionDonorIds(c, deps);
    if (donorItemIds === null) return c.redirect('/login');

    c.header('Cache-Control', NO_STORE);
    if (!cardEnabled(deps.config)) {
      return c.html(page(TITLE_CARD, cardUnavailableView()));
    }

    const donorItemId = c.req.param('donorItemId');
    if (!donorItemIds.includes(donorItemId)) {
      return c.html(page(TITLE_ERROR, errorView('That card does not exist.')), 404);
    }

    let donor;
    try {
      donor = await deps.monday.getDonorPortalData(donorItemId);
    } catch (err) {
      console.error(`donor-portal card load failed: ${err instanceof Error ? err.message : String(err)}`);
      return c.html(page(TITLE_ERROR, errorView('We could not load your card right now. Please try again in a few minutes.')), 500);
    }

    let token = await deps.cardTokenStore.getActiveToken(donorItemId);
    if (token === null) {
      token = generateToken();
      await deps.cardTokenStore.createToken(donorItemId, token, deps.now().toISOString());
    }

    const verifyUrl = `${deps.config.auth.portalBaseUrl}/verify/${token}`;
    const qrSvg = generateQrSvg(verifyUrl);
    return c.html(page(TITLE_CARD, cardView(buildCardData(donor), verifyUrl, qrSvg)));
  });

  app.post('/portal/card/:donorItemId/regenerate', async (c) => {
    const donorItemIds = await getSessionDonorIds(c, deps);
    if (donorItemIds === null) return c.redirect('/login');

    const donorItemId = c.req.param('donorItemId');
    if (!donorItemIds.includes(donorItemId)) {
      return c.html(page(TITLE_ERROR, errorView('That card does not exist.')), 404);
    }

    const now = deps.now().toISOString();
    await deps.cardTokenStore.revokeAllForDonor(donorItemId, now);
    await deps.cardTokenStore.createToken(donorItemId, generateToken(), now);

    return c.redirect(`/portal/card/${encodeURIComponent(donorItemId)}`);
  });

  app.get('/verify/:token', async (c) => {
    c.header('Cache-Control', NO_STORE);

    const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
    const ipResult = await deps.ipLimiter.limit(`verify:${ip}`);
    if (!ipResult.success) {
      return c.html(page(TITLE_VERIFY, errorView('Too many requests — please try again in a minute.')), 429);
    }

    const token = c.req.param('token');
    let donorItemId: string | null;
    try {
      donorItemId = await deps.cardTokenStore.findActiveDonorId(token);
    } catch (err) {
      console.error(`donor-portal verify lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      return c.html(page(TITLE_ERROR, errorView('We could not verify this card right now. Please try again in a few minutes.')), 500);
    }
    if (donorItemId === null) {
      return c.html(page(TITLE_VERIFY, verifyNotValidView()));
    }

    let donor;
    try {
      donor = await deps.monday.getDonorPortalData(donorItemId);
    } catch (err) {
      console.error(`donor-portal verify load failed: ${err instanceof Error ? err.message : String(err)}`);
      return c.html(page(TITLE_ERROR, errorView('We could not verify this card right now. Please try again in a few minutes.')), 500);
    }

    return c.html(page(TITLE_VERIFY, verifyView(buildCardData(donor))));
  });
```

Add a per-donor link in `src/views.ts`'s `donorSection` (so the card is reachable from the main
portal page — unlike letters/change-requests, the card is inherently per-donor, not a single
portal-level link):

```ts
function donorSection(donor: PortalView['donors'][number]): string {
  return `
    <section>
      <h2>${escapeHtml(donor.name)}</h2>
      <p>Membership: ${escapeHtml(donor.membershipStatus)} (${escapeHtml(donor.membershipTier)})</p>
      <p>Total donated: ${escapeHtml(donor.totalDonated)}</p>
      <p><a href="/portal/card/${encodeURIComponent(donor.id)}">Membership card</a></p>
      <table>
        <thead>
          <tr><th>Date</th><th>Amount</th><th>Description</th></tr>
        </thead>
        <tbody>
          ${donor.donations.map(donationRow).join('')}
        </tbody>
      </table>
    </section>
  `;
}
```

Append a test to `src/views.test.ts`'s `portalView` describe block confirming the link:

```ts
it('links each donor to their own membership card', () => {
  const html = portalView(data);
  expect(html).toContain('/portal/card/donor-1');
  expect(html).toContain('/portal/card/donor-2');
});
```

- [ ] **Step 4: Wire production dependencies** — `src/index.ts`:

```ts
import { D1CardTokenStore } from './db/cardTokens';
```

Add `cardTokenStore: new D1CardTokenStore(env.DB),` to the `createApp({...})` object inside
`fetch()`, alongside the existing `changeStore: new D1ChangeRequestStore(env.DB),`.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes.ts src/routes.test.ts src/views.ts src/views.test.ts src/index.ts
git commit -m "feat(donor-portal): membership card, regenerate, and public verify routes"
```

---

### Task 7: Documentation

Records the new feature and its blocking precondition in `donor-portal/README.md`, and removes
the shipped item from the "Future candidates" list — matching how v2's routes commit was followed
by its own docs commit.

**Files:**
- Modify: `donor-portal/README.md`

- [ ] **Step 1: Update the README**

In the "Future candidates" section (added by the v2 brainstorm), remove item 1 ("Digital
membership card") from the numbered list — it's shipped, not a candidate anymore — and renumber
the remaining seven items accordingly.

Add a new section after "## v2 — Year-end tax letters and change requests" (matching that
section's structure):

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add donor-portal/README.md
git commit -m "docs(donor-portal): document the digital membership card feature and its precondition"
```
