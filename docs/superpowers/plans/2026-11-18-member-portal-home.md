# Member Portal Home Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the long dashboard with a card-first home page (status, one next step, cards, five doors) and give each door its own page.

**Architecture:** A pure state resolver (`src/home/homeState.ts`) picks each person's state and the page's; a slim `/:locale/portal` route loads only membership fields, card tokens and (Jan 1–Apr 15) last year's letter, then renders `homeView`. Each door is its own server-rendered route reusing today's section renderers, moved out of `views.ts` into `src/doors/`. The session remembers which address it was signed in with, so "Your info & emails" can follow the household privacy rule.

**Tech Stack:** Hono + TypeScript on Cloudflare Workers, D1, Vitest in workerd, Monday GraphQL.

**Spec:** `docs/superpowers/specs/2026-11-18-member-portal-home-design.md`

**Depends on:** PR #17 (sign-in code, `verified_emails`, `ConsumedToken.emailHash`). This branch already contains it; rebase onto `main` once #17 merges.

## Global Constraints

- All commands from `member-portal/`. Type-check with `npm run typecheck` (never bare `tsc`); `npm test` and network commands need the shell sandbox disabled. `node ../scripts/check-log-safety.mjs` clean.
- No client JavaScript. Server-rendered views; CSS in `src/assets/portalStyles.ts` from `docs/design-system/tokens.json` values (gold `#FFC700` action only; black header; Manrope headings; Poppins body; pill buttons; card radius 16px). One gold button per view besides the header's Donate. Dark mode and print as today.
- Phone first: 16 px side gutter, no horizontal scroll. Desktop ≥ 768 px: message left, card(s) right, doors as a row of tiles.
- Every new string in `src/i18n/locales/en.ts` and the nine other locales (parity enforced), AI-drafted.
- Thresholds are config `home.newMemberDays` = 60, `home.renewalWarningDays` = 30, `home.taxLetterUntil` = `"04-15"` (MM-DD), in `config/svbc.json`, `config/sandbox.json`, `config/local.json`.
- Dates for state are compared as calendar dates in `America/Los_Angeles`.
- New Monday columns, gated with the `REPLACE_WITH_COLUMN_ID` placeholder pattern (feature off while placeholder): `memberSince` (prod `date_mm8nemca`, sandbox `date_mm8h79b2`), `memberType` (prod `color_mm8pz9ry`, sandbox `color_mm8jp69c`), `donorEmailConsent` (prod `color_mm8ntb35`, sandbox `color_mm8h9ee2`), `donorHouseholdEmailConsent` (prod `color_mm8nh158`, sandbox `color_mm8hkgaa`). Existing: `membershipStatus` (labels Active / Lapsed), `membershipTier` (Member / Lifetime), `membershipExpiry` = Member Until. Member Type labels: New / Continuing / Lapsed renewal / Lifetime. Consent labels: Subscribed / Unsubscribed / Cleaned / Not in Mailchimp.
- Renew/Join link: `funraiseLinks(config).renewMembershipUrl` when set, else `ORG_DONATE_URL` (`https://bikesiliconvalley.org/ways-to-give`).
- Every Monday read degrades per section / per person, as `loadPortalData` does; a gated-off feature hides its content, and a door with nothing left is not linked.
- Existing URLs keep working (redirect to their door): `/:locale/portal/card/:id`, `/:locale/portal/events`, `GET /:locale/portal/change-request`. `/:locale/portal/letters…`, `/pledges`, `/matching-gifts` stay as they are. POST routes unchanged. `next=` return paths (#127) keep validating against the `/:locale/portal` tree.
- Household email privacy: in a session covering one person, show that person's Personal and Household Email. In a session covering several people, show only the address the session was signed in with, under each person whose record holds it; never another person's other addresses. (Plan ruling refining the spec's rule; same intent: one person's address never shown to another.)

## Review Focus

1. **Session signed in by a letter-ready link or before this deploy** (no `email_hash`): "Your info & emails" shows a single person's addresses as usual and, for a household, shows no addresses plus a one-line note — never everyone's. Test in Task 6.
2. **Lifetime member** whose Member Until is blank: never Renewal due, card reads Lifetime, no "ends" date. Test in Task 2.
3. **A household where one person's records failed to load:** home shows the other person's state and card plus the existing "some records unavailable" note; the gold button never targets the missing person. Test in Task 3.
4. **January for a member with no gifts last year** (or volunteer-only): no tax-letter state, falls through to the next state. Test in Task 2.
5. **Old bookmarks** (`/en/portal/events`, `/en/portal/card/123`, `/en/portal/change-request`) land on the right door, and signed-out access to a door returns to it after sign-in. Test in Task 4 and Task 5.

---

## File structure

| File | Responsibility |
|---|---|
| `migrations/0008_session_email_hash.sql` | `ALTER TABLE sessions ADD COLUMN email_hash TEXT` |
| `src/db/sessions.ts`, `src/auth/session.ts` | session stores and returns the sign-in `emailHash` |
| `src/home/homeState.ts` (+ test) | pure state resolver |
| `src/home/loadHomeData.ts` (+ test) | slim loader for the home route |
| `src/home/homeView.ts` (+ test) | home page markup |
| `src/doors/*.ts` (+ tests) | one view module per door; section renderers moved from `views.ts` |
| `src/doors/emailLabels.ts` (+ test) | address list + Verified/Subscribed/On file/Bounced, privacy rule |
| `src/monday/client.ts` | `getMemberPortalData` reads `memberSince`/`memberType`; new `getDonorEmails` |
| `src/db/verifiedEmails.ts` | `verifiedFor` read |
| `src/routes.ts`, `src/views.ts`, `src/assets/portalStyles.ts`, `src/types.ts`, `src/config.ts`, `config/*.json`, `src/i18n/locales/*.ts` | wiring, removal of the old dashboard, styles, config |
| `README.md`, `../docs/uat/member-portal.md`, `../docs/design-system/README.md` | docs |

---

### Task 1: Session remembers its sign-in address

**Files:** Create `migrations/0008_session_email_hash.sql`. Modify `src/db/sessions.ts` (+ test), `src/auth/session.ts` (+ test), `src/routes.ts` (session helper), every `SessionStore` fake (grep `SessionStore`).

**Interfaces:**
- Produces: `NewSession.emailHash: string | null`; `interface SessionInfo { donorItemIds: string[]; emailHash: string | null }`; `SessionStore.getSession(sessionHash, nowISO): Promise<SessionInfo | null>`; in routes, `getSessionInfo(c, deps): Promise<SessionInfo | null>` with `getSessionDonorIds` kept as a thin wrapper.

- [ ] **Step 1: Failing tests** — sessions store: a session created with `emailHash: 'h1'` returns `{ donorItemIds, emailHash: 'h1' }`; one created with `null` returns `emailHash: null`; a pre-0008 row (insert without the column value) returns `null`. `startSession` passes `consumed.emailHash` into `createSession`.
- [ ] **Step 2: Run** `npm test -- src/db/sessions.test.ts src/auth` — FAIL.
- [ ] **Step 3: Implement**; migration header comment: apply to both D1s before merging (same reason as 0007; nullable, so old code is unaffected). README Development migration note lists 0008.
- [ ] **Step 4: Run** `npm test && npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(member-portal): remember which address a session signed in with`

---

### Task 2: Config, membership fields and the state resolver

**Files:** Modify `src/types.ts`, `src/config.ts` (+ test), `config/svbc.json`, `config/sandbox.json`, `config/local.json`, `src/monday/client.ts` (+ test). Create `src/home/homeState.ts` (+ test).

**Interfaces:**
- Produces:
  ```ts
  // MemberPortalData gains (empty string when gated off or blank):
  memberSince: string; memberType: string;
  interface HomeConfig { newMemberDays: number; renewalWarningDays: number; taxLetterUntil: string }
  interface LetterSummary { year: number; giftCount: number; totalFormatted: string }
  interface HomePerson { id: string; firstName: string; status: string; tier: string;
    until: string; since: string; memberType: string; letter: LetterSummary | null }
  type PersonState =
    | { kind: 'taxLetter'; letter: LetterSummary }
    | { kind: 'renew'; reason: 'due' | 'lapsed' | 'never'; date: string | null }
    | { kind: 'newMember' }
    | { kind: 'default' };
  const STATE_RANK: PersonState['kind'][] = ['taxLetter', 'renew', 'newMember', 'default'];
  personState(p: HomePerson, today: string /* YYYY-MM-DD, LA */, cfg: HomeConfig): PersonState
  interface PageState { kind: PersonState['kind']; personIds: string[] }   // who holds the winning kind
  pageState(people: { person: HomePerson; state: PersonState }[]): PageState
  todayInLosAngeles(now: Date): string
  ```

- [ ] **Step 1: Failing tests**
  - config: `home` block required with the three values; four new columns accepted as placeholder; shipped configs carry the ids in Global Constraints.
  - client: `getMemberPortalData` requests `memberSince`/`memberType` only when configured and returns their text.
  - `personState` table (today `2027-01-10` unless noted, cfg 60/30/"04-15"):
    - letter present, today Jan 10 → taxLetter; same on `2027-04-15` → taxLetter; `2027-04-16` → not taxLetter.
    - letter null in January (no gifts / volunteer-only) → falls through.
    - status Lapsed, until `2026-10-31` → renew lapsed, date `2026-10-31`.
    - Active, until `2027-02-09` (30 days) → renew due; until `2027-02-10` → not renew.
    - tier Lifetime, until blank → never renew; default.
    - status and tier blank (never a member) → renew never, date null.
    - memberType New, since `2026-11-11` (60 days before Jan 10) → newMember; since `2026-11-10` → default.
    - memberType Continuing, recent since → default.
  - `pageState`: [taxLetter(J), renew(S)] → taxLetter [J]; [renew(J), renew(S)] → renew [J,S]; [default, newMember] → newMember [that one]; single person passes through.
  - `todayInLosAngeles(new Date('2027-01-01T07:30:00Z'))` → `'2026-12-31'`.
- [ ] **Step 2: Run** `npm test -- src/home src/config.test.ts src/monday` — FAIL.
- [ ] **Step 3: Implement** (pure; no I/O in `homeState.ts`; first name = text before the first space of the item name).
- [ ] **Step 4: Run** `npm test && npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(member-portal): resolve each member's home-page state`

---

### Task 3: Home page

**Files:** Create `src/home/loadHomeData.ts`, `src/home/homeView.ts` (+ tests). Modify `src/routes.ts` (`GET /:locale/portal`), `src/assets/portalStyles.ts`, `src/i18n/locales/*.ts`.

**Interfaces:**
- Consumes: Task 2's resolver; existing `getOrCreateCardToken`, `buildCardData`, `generateQrSvg`, `memberCardWidget` (move it to `src/doors/card.ts` and export), `loadLetterData`, `someRecordsUnavailableNote`.
- Produces:
  ```ts
  interface HomeData { people: { person: HomePerson; state: PersonState; card: PortalCard | null }[]; discountCount: number | null;
    page: PageState; unavailableCount: number; doors: DoorLink[] }
  interface DoorLink { key: 'card' | 'giving' | 'letters' | 'activity' | 'info'; href: string; hint: string }
  loadHomeData(donorItemIds: string[], deps: AppDeps, locale: Locale): Promise<HomeData>
  homeView(data: HomeData, locale: Locale, renewUrl: string): string
  ```

- [ ] **Step 1: Failing tests**
  - loadHomeData: calls `getMemberPortalData(id, { includeDonations: false })` per person; calls `loadLetterData(id, lastYear)` only when today ≤ `taxLetterUntil` and the letters feature is enabled; calls `getDiscountOrganizations()` once, only for the shop count (`HomeData.discountCount: number | null`, null on failure); never loads events or volunteer shifts; one person's failed read → that person dropped and `unavailableCount` 1; a failed letter read → `letter: null` for that person.
  - homeView, one person: each of the four states renders its headline and, except default, exactly one element with the gold-button class; tax-letter state shows "3 gifts · $250.00 in 2026" from the `LetterSummary`; new-member copy names the shop count, and omits the number when `discountCount` is null; new-member button links to the card door; tax-letter button to `/{locale}/portal/letters`; renew button to `renewUrl`; never-member renders "Become a member", a "Join" button and a "Not a member yet" panel instead of a card; lapsed card has the lapsed class and "Ended MM/YYYY".
  - homeView, household (Jordan, Sam): greeting names both; Sam lapsed + Jordan default → headline names Sam, button text is `home.renewAny` ("Renew a membership") with the each-person line; both tax letters → "Get your tax letters"; Jordan tax letter + Sam lapsed → gold button is Jordan's letter and Sam's card carries a plain (non-gold) "Renew" link.
  - doors: five links in order card, giving, letters, activity, info; a door whose features are all gated off is absent.
  - route: `GET /en/portal` signed in → 200 with `homeView` output; the Review Focus #3 household-with-one-failed-record case shows the note and only the loaded person's button.
- [ ] **Step 2: Run** `npm test -- src/home src/routes.test.ts` — FAIL.
- [ ] **Step 3: Implement**; styles for status block, stacked cards, door list, desktop grid (≥ 768 px) and tiles; copy keys under `home.*` in all ten locales.
- [ ] **Step 4: Run** `npm test && npm run typecheck && node ../scripts/check-log-safety.mjs` — PASS.
- [ ] **Step 5: Commit** `feat(member-portal): card-first home page`

---

### Task 4: Card, Giving and Activity doors

**Files:** Create `src/doors/layout.ts` (door page frame: "‹ Home" link, title, per-person grouping), `src/doors/card.ts`, `src/doors/giving.ts`, `src/doors/activity.ts` (+ tests). Modify `src/routes.ts`, `src/views.ts` (remove what moved and the old `portalView`/tabs), `src/i18n/locales/*.ts`.

**Interfaces:**
- Produces: `doorPage(title: string, body: string, locale: Locale): string`; `personGroup(name: string, body: string, showName: boolean): string`; routes `GET /:locale/portal/card`, `/giving`, `/activity`.

- [ ] **Step 1: Failing tests**
  - card door: each person's card with QR and the existing regenerate form, then the discount list; discounts read failure → cards only.
  - giving door: donation table and total (respecting `donationHistoryEnabled`), impact summary, Funraise links, links to `/pledges` and `/matching-gifts` when those features are on; household → grouped under names.
  - activity door: event registrations (upcoming/past), volunteer history, Get involved links; events read failure → the other two still render.
  - redirects: `/en/portal/events` → `/en/portal/activity`; `/en/portal/card/123` → `/en/portal/card` (303/302 as existing redirects use); signed-out `GET /en/portal/giving` → `/?next=/en/portal/giving`.
  - the old dashboard markup (tabs radio inputs) no longer appears on any page.
- [ ] **Step 2: Run** `npm test -- src/doors src/routes.test.ts` — FAIL.
- [ ] **Step 3: Implement** by moving the existing renderers, not rewriting them.
- [ ] **Step 4: Run** `npm test && npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(member-portal): card, giving and activity doors`

---

### Task 5: Your info & emails door; letters door frame

**Files:** Create `src/doors/info.ts`, `src/doors/emailLabels.ts` (+ tests). Modify `src/monday/client.ts` (+ test), `src/db/verifiedEmails.ts` (+ test), `src/routes.ts`, the letters list view (door frame only), `src/i18n/locales/*.ts`.

**Interfaces:**
- Consumes: Task 1 `getSessionInfo`.
- Produces:
  ```ts
  interface DonorEmails { personal: string; household: string; personalConsent: string; householdConsent: string }
  MondayClient.getDonorEmails(donorItemId: string): Promise<DonorEmails>
  VerifiedEmailStore.verifiedFor(personItemIds: string[]): Promise<Set<string>>  // keys `${emailHash}:${personId}`
  type EmailLabel = 'verified' | 'subscribed' | 'onFile' | 'bounced'
  interface ShownEmail { address: string; kind: 'personal' | 'household'; label: EmailLabel }
  visibleEmails(people: { id: string; emails: DonorEmails }[], sessionEmailHash: string | null,
    verified: Set<string>, hash: (address: string) => Promise<string>): Promise<Record<string, ShownEmail[]>>
  ```
  Label rule: Cleaned → bounced; else verified row → verified; else Subscribed → subscribed; else onFile.

- [ ] **Step 1: Failing tests**
  - `visibleEmails`: one person, session by Personal → both addresses; household signed in by the shared Household Email → that address under each person holding it, no Personal Emails; household signed in by Jordan's Personal Email → only that address, under Jordan; household with `sessionEmailHash` null → nothing (Review Focus #1); labels for Cleaned, verified+Subscribed (verified wins), Subscribed, Unsubscribed (onFile).
  - `verifiedFor` returns the keys for the given people only.
  - info door: renders the existing change-request form and preferences, then the address list with labels as text; `GET /en/portal/change-request` → `/en/portal/info`; POSTs to `/change-request` still work and their result page links back to `/info`.
  - household with null session hash shows the one-line note `info.emailsHiddenHousehold`.
  - letters list renders inside the door frame with "‹ Home".
- [ ] **Step 2: Run** `npm test -- src/doors src/db src/monday src/routes.test.ts` — FAIL.
- [ ] **Step 3: Implement**; `getDonorEmails` reads `donorEmail`, `donorHouseholdEmail`, `donorEmailConsent`, `donorHouseholdEmailConsent` (gated ones only when configured); hash with the sign-in normalization (trim, lowercase, `sha256Hex`).
- [ ] **Step 4: Run** `npm test && npm run typecheck && node ../scripts/check-log-safety.mjs` — PASS.
- [ ] **Step 5: Docs** — README: replace the dashboard sections' description with home + doors (states, thresholds, door map, email privacy rule, migration 0008); `../docs/uat/member-portal.md`: what a tester sees per state and per door; `../docs/design-system/README.md`: portal tabs no longer used on the dashboard.
- [ ] **Step 6: Smoke** — `npm run dev:local` (never `npm run dev`): home, each door, an old bookmark. Stop the server.
- [ ] **Step 7: Commit** `feat(member-portal): your info & emails door with address labels`
