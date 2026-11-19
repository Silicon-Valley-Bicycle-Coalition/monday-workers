# Member Portal Sign-in Code and Addresses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every sign-in email carries a 6-digit code beside the link, members can sign in with Personal or Household Email, and each completed sign-in records the address as verified.

**Architecture:** `POST /` sets a `__Host-login-request` cookie (an opaque request id) whenever the rate limiters let the request through; the deferred `requestLogin` writes the code's hash beside the link token on the same `magic_link_tokens` row. A new `POST /auth/code` binds the typed code to that row through the cookie, capped at 5 tries per request and 10 wrong codes per address per 24 h. Either path ends in one shared `startSession` that also upserts `verified_emails`.

**Tech Stack:** Hono + TypeScript on Cloudflare Workers, D1, Vitest (`@cloudflare/vitest-pool-workers`), Monday GraphQL.

**Spec:** `docs/superpowers/specs/2026-11-18-member-portal-sign-in-code-and-addresses-design.md`

## Global Constraints

- All commands run from `member-portal/`. Type-check with `npm run typecheck`, never bare `tsc`. Worker tests need the sandbox disabled (workerd binds a port).
- D1 stores only SHA-256 hex (`sha256Hex` from `src/crypto/hash.ts`) of tokens, request ids, codes and addresses; addresses are hashed lowercased and trimmed, as `login_attempts` does.
- Code: 6 digits, uniform 000000–999999, rejection-sampled from `crypto.getRandomValues`. `code_hash = sha256Hex(requestId + ':' + code)`.
- Magic-link TTL `auth.magicLinkTtlMinutes` (15) bounds the row, the code and the cookie.
- Per-request cap: 5 tries (constant `MAX_CODE_ATTEMPTS = 5`). Per-address cap: config `rateLimit.codeFailuresPerAddressDaily` = 10 (both configs), counted over the last 24 h.
- `POST /` stays indistinguishable for matching and non-matching addresses: same body, same `Set-Cookie` names, Monday lookup and send stay deferred via `waitUntil`.
- A rate-limit denial in `POST /` sets no `__Host-login-request` cookie (an existing one stays).
- Letter-ready emails and links are unchanged: no code, no `email_hash`, nothing verified.
- No Work Email, no Other Emails. Household Email column ids: production `email_mm8n2wzk`, sandbox `email_mm8hj3f8` (People boards 18437909781 / 18437342592, same ids `benevity-import` uses).
- Every new string in `src/i18n/locales/en.ts` and all nine other locales (locale tests enforce key parity), AI-drafted as existing strings are.
- `POST /auth/code` is CSRF-checked (not in `CSRF_EXEMPT`), not gated by `writeGate`, per-IP limited with the existing `ipLimiter` under key `code:${ip}` (no new rate-limit namespace).
- Code wrong / missing cookie / spent / expired / capped all render the same check-email page with one error line; nothing says which.
- `log-safety`: no `console.*` with an address; log only `errorText(err)`.

## Review Focus

1. **A typed code with spaces or a pasted "123 456"** — accept it: strip whitespace before checking `^\d{6}$`. Test in Task 5.
2. **Two browsers, one address, both asked** — each browser's cookie reaches only its own request's code; the other's code fails there. Test in Task 4 (store level) and Task 5 (route).
3. **Link clicked after the code was used (or the reverse)** — the second one fails with the expired-link / wrong-code page. Test in Task 4 and Task 5.
4. **The per-address window outlives the 15-minute row** — failures are counted from their own table, purged on `attemptRetentionHours` (≥ 24 h), not from `magic_link_tokens` (purged as soon as expired). Test in Task 3.
5. **Household Email shared by two people** — both are signed in together and both get a `verified_emails` row. Test in Task 2 (lookup) and Task 5 (verified rows).

---

## File structure

| File | Change |
|---|---|
| `migrations/0007_sign_in_codes.sql` | new: columns on `magic_link_tokens`, tables `verified_emails`, `code_failures` |
| `src/crypto/code.ts` (+ test) | new: `generateCode()` |
| `src/db/tokens.ts` (+ test) | extended row; `consumeToken` returns `ConsumedToken`; `takeCodeAttempt`, `claimByRequest` |
| `src/db/verifiedEmails.ts` (+ test) | new store |
| `src/db/codeFailures.ts` (+ test) | new store |
| `src/db/authRetention.ts`, `src/auth/purgeExpiredAuth.ts` (+ tests) | purge `code_failures` |
| `src/types.ts`, `src/config.ts`, `config/*.json` (+ test) | `donorHouseholdEmail` column, `codeFailuresPerAddressDaily` |
| `src/monday/client.ts` (+ test) | lookup over both columns |
| `src/auth/requestLogin.ts` (+ test) | request id, code, `email_hash` |
| `src/email/types.ts`, `cloudflareEmail.ts`, `devEmail.ts` (+ test) | code in login email |
| `src/auth/session.ts` (new), `verifyLogin.ts`, `verifyCode.ts` (new) (+ tests) | shared session start + verification |
| `src/routes.ts`, `src/views.ts`, `src/index.ts`, `src/index.local.ts` (+ `routes.test.ts`) | cookie, form, `POST /auth/code`, wiring |
| `src/i18n/locales/*.ts` | new keys |
| `README.md`, `../docs/uat/member-portal.md` | docs |

---

### Task 1: Migration and code generator

**Files:**
- Create: `migrations/0007_sign_in_codes.sql`, `src/crypto/code.ts`, `src/crypto/code.test.ts`

**Interfaces:**
- Produces: `generateCode(): string` (6 ASCII digits). Schema below, used by Tasks 3–5.

- [ ] **Step 1: Write the migration**

```sql
ALTER TABLE magic_link_tokens ADD COLUMN request_hash TEXT;
ALTER TABLE magic_link_tokens ADD COLUMN code_hash TEXT;
ALTER TABLE magic_link_tokens ADD COLUMN email_hash TEXT;
ALTER TABLE magic_link_tokens ADD COLUMN failed_code_attempts INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_magic_link_tokens_request_hash ON magic_link_tokens (request_hash);

CREATE TABLE verified_emails (
  email_hash TEXT NOT NULL,
  person_item_id TEXT NOT NULL,
  first_verified_at TEXT NOT NULL,
  last_verified_at TEXT NOT NULL,
  PRIMARY KEY (email_hash, person_item_id)
);

CREATE TABLE code_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_hash TEXT NOT NULL,
  failed_at TEXT NOT NULL
);
CREATE INDEX idx_code_failures_email_hash_time ON code_failures (email_hash, failed_at);
CREATE INDEX idx_code_failures_failed_at ON code_failures (failed_at);
```

Header comment: apply before deploying the build that reads it; all new token columns are nullable or defaulted so letter rows and pre-deploy rows keep working. (`code_failures` replaces the spec's "count over `magic_link_tokens`": those rows are purged once expired, 15 minutes in, which would reset a 24-hour count.)

- [ ] **Step 2: Write the failing test** `src/crypto/code.test.ts`
  - `generateCode returns six digits`: 1,000 calls all match `/^\d{6}$/`.
  - `generateCode keeps leading zeros`: stub `crypto.getRandomValues` to fill `0x00000007` → `'000007'`.
  - `generateCode rejects values above the last full million`: stub returning `0xFFFFFFFF` then `42` → `'000042'`.

- [ ] **Step 3: Run** `npm test -- src/crypto/code.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 4: Implement `generateCode(): string`** — read one `Uint32Array(1)`, reject values ≥ `Math.floor(2**32 / 1e6) * 1e6`, return `(v % 1e6)` padded to 6.

- [ ] **Step 5: Run** `npm test -- src/crypto/code.test.ts` and `npm test -- src/db` — Expected: PASS (the migration applies through `test/apply-migrations.ts`).

- [ ] **Step 6: Commit** `feat(member-portal): add sign-in code generator and migration 0007`

---

### Task 2: Sign in with Household Email

**Files:**
- Modify: `src/types.ts`, `src/config.ts`, `config/svbc.json`, `config/sandbox.json`, `src/monday/client.ts:198-245`
- Test: `src/config.test.ts`, the client's existing test file for `findDonorsByEmail`

**Interfaces:**
- Produces: `MondayColumns.donorHouseholdEmail: string`; `findDonorsByEmail(email)` unchanged signature, now matching either column.

- [ ] **Step 1: Write the failing tests**
  - config: `donorHouseholdEmail` is optional like `preferredLanguage` (accepted as `REPLACE_WITH_COLUMN_ID`, no throw); both shipped configs carry the ids in Global Constraints.
  - client, `donorHouseholdEmail` configured: the request body's `query_params` has two rules (`donorEmail`, `donorHouseholdEmail`, both `compare_value: [$email]`, `any_of`) and `operator: or`; an item whose Household Email equals the address (case/whitespace-insensitive) is returned; an item matching neither exactly (Monday's fuzzy hit) is dropped; two items sharing the Household Email are both returned.
  - client, placeholder: the query is the single Personal Email rule, no `operator`, and `donorHouseholdEmail` isn't in `column_values(ids:)`.

- [ ] **Step 2: Run** `npm test -- src/config.test.ts src/monday` — Expected: FAIL.

- [ ] **Step 3: Implement** — add `'donorHouseholdEmail'` to `MondayColumns` and to an optional list beside `PREFERRED_LANGUAGE_COLUMN` (same comment style); in `findDonorsByEmail` request the column and add the rule only when configured; the exact-match filter keeps an item if either column equals `wanted`.

- [ ] **Step 4: Verify the `or` query against the sandbox** — run the built query once with the sandbox token from `../.env.sandbox` (e.g. a throwaway `node` script using `MondayGraphQL`) for an address present only as a Household Email. Expected: the item comes back. If Monday rejects `operator: or`, stop and report.

- [ ] **Step 5: Run** `npm test && npm run typecheck` — Expected: PASS.

- [ ] **Step 6: Commit** `feat(member-portal): accept Household Email at sign-in`

---

### Task 3: Token, verified-address and failure stores

**Files:**
- Modify: `src/db/tokens.ts`, `src/db/tokens.test.ts`, `src/db/authRetention.ts` (+ test), `src/auth/purgeExpiredAuth.ts` (+ test), `src/config.ts`, `config/*.json`
- Create: `src/db/verifiedEmails.ts` (+ test), `src/db/codeFailures.ts` (+ test)

**Interfaces:**
- Produces:
  ```ts
  interface NewMagicLinkToken { tokenHash: string; donorItemIds: string[]; expiresAt: string;
    requestHash?: string; codeHash?: string; emailHash?: string }
  interface ConsumedToken { donorItemIds: string[]; emailHash: string | null }
  interface CodeAttempt { codeHash: string; emailHash: string }
  interface MagicLinkTokenStore {
    createToken(params: NewMagicLinkToken): Promise<void>;
    consumeToken(tokenHash: string, nowISO: string): Promise<ConsumedToken | null>;
    // Atomically counts one try (UPDATE … SET failed_code_attempts = failed_code_attempts + 1
    // WHERE request_hash = ?1 AND used_at IS NULL AND expires_at > ?2 AND failed_code_attempts < ?3
    // AND code_hash IS NOT NULL RETURNING code_hash, email_hash). null = nothing usable.
    takeCodeAttempt(requestHash: string, nowISO: string, maxAttempts: number): Promise<CodeAttempt | null>;
    // UPDATE … SET used_at = ?2 WHERE request_hash = ?1 AND used_at IS NULL AND expires_at > ?2
    // RETURNING donor_item_ids, email_hash.
    claimByRequest(requestHash: string, nowISO: string): Promise<ConsumedToken | null>;
  }
  interface VerifiedEmailStore { recordVerified(emailHash: string, personItemIds: string[], atISO: string): Promise<void> }
  interface CodeFailureStore { recordFailure(emailHash: string, atISO: string): Promise<void>;
    countSince(emailHash: string, sinceISO: string): Promise<number> }
  AuthRetentionStore.purgeCodeFailuresBefore(cutoffISO: string): Promise<number>
  PurgeExpiredAuthResult.codeFailures: number | null
  RateLimitConfig / config: rateLimit.codeFailuresPerAddressDaily: number  // positive integer, 10
  ```

- [ ] **Step 1: Write the failing tests**
  - tokens: `consumeToken` returns `{ donorItemIds, emailHash }` (null `emailHash` for a row created without one); `takeCodeAttempt` returns the hashes and allows exactly 5 calls, the 6th returns null; returns null for an expired row, a used row, a row with no `code_hash`, an unknown request hash; `claimByRequest` claims once (second call null) and after a claim `consumeToken` on the same row returns null; after `consumeToken`, `takeCodeAttempt` returns null; two rows with different request hashes don't see each other.
  - verifiedEmails: first call inserts with `first_verified_at = last_verified_at = at`; a later call keeps `first_verified_at`, moves `last_verified_at`; two person ids → two rows.
  - codeFailures: `countSince` counts only that `email_hash` and only rows at or after `sinceISO`.
  - authRetention / purge: `code_failures` rows before the cutoff are deleted and counted in `codeFailures`; a failing purge returns null for it without skipping the others.
  - config: `rateLimit.codeFailuresPerAddressDaily` required, positive integer.

- [ ] **Step 2: Run** `npm test -- src/db src/auth/purgeExpiredAuth.test.ts src/config.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement** the interfaces above (`INSERT … ON CONFLICT(email_hash, person_item_id) DO UPDATE SET last_verified_at = excluded.last_verified_at`; batch one statement per id). `consumeToken` keeps its claim-then-read shape and also selects `email_hash`. Add `codeFailuresPerAddressDaily: 10` to both configs. Purge `code_failures` with the existing `attemptRetentionHours` cutoff. Update every caller of `consumeToken` (`verifyLogin`) to read `.donorItemIds` so the build stays green.

- [ ] **Step 4: Run** `npm test && npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit** `feat(member-portal): store sign-in codes, verified addresses and code failures`

---

### Task 4: Request with a code; shared session start; code verification

**Files:**
- Modify: `src/auth/requestLogin.ts` (+ test), `src/auth/verifyLogin.ts` (+ test), `src/email/types.ts`, `src/email/cloudflareEmail.ts` (+ test), `src/email/devEmail.ts`, `src/i18n/locales/*.ts`
- Create: `src/auth/session.ts`, `src/auth/verifyCode.ts` (+ test)

**Interfaces:**
- Consumes: Task 1 `generateCode`; Task 3 stores.
- Produces:
  ```ts
  // requestLogin gains requestId (raw, from the route) after localeHint:
  requestLogin(email: string, localeHint: Locale, requestId: string, deps: RequestLoginDeps, next?: string | null): Promise<void>
  SendLoginEmailParams.code: string
  // src/auth/session.ts
  interface StartSessionDeps { sessionStore: SessionStore; verifiedEmailStore: VerifiedEmailStore; sessionTtlHours: number; now: () => Date }
  startSession(consumed: ConsumedToken, deps: StartSessionDeps): Promise<string>  // raw session token
  // verifyLogin(rawToken, deps: StartSessionDeps & { tokenStore }) — same return as today
  // src/auth/verifyCode.ts
  const MAX_CODE_ATTEMPTS = 5
  interface VerifyCodeDeps extends StartSessionDeps { tokenStore: MagicLinkTokenStore; codeFailureStore: CodeFailureStore; codeFailuresPerAddressDaily: number }
  verifyCode(requestId: string, code: string, deps: VerifyCodeDeps): Promise<string | null>
  ```

- [ ] **Step 1: Write the failing tests**
  - requestLogin, match: one `createToken` with `requestHash = sha256Hex(requestId)`, `codeHash = sha256Hex(requestId + ':' + code)`, `emailHash = sha256Hex(email)`; `sendLoginEmail` called with the same 6-digit `code`. No match: no row, no email.
  - cloudflareEmail: HTML and text both contain the code, and the code appears before the link in each.
  - startSession: creates a session for `donorItemIds`; with `emailHash` set, `recordVerified(emailHash, donorItemIds, now)`; with `emailHash` null, not called; a throwing `recordVerified` is logged and the session token still returned.
  - verifyLogin: unchanged behavior through `startSession` (existing tests pass).
  - verifyCode, in order of the algorithm: no row → null, no failure recorded; per-address failures ≥ 10 in the last 24 h → null even with the right code, no claim; wrong code → null and one `recordFailure`; right code → session token, row claimed; right code after the row was claimed by the link → null; the 6th try on one request → null even with the right code. Code comparison uses `secretsMatch` from `src/crypto/secretsMatch.ts`.

- [ ] **Step 2: Run** `npm test -- src/auth src/email` — Expected: FAIL.

- [ ] **Step 3: Implement** — `verifyCode`: `takeCodeAttempt(sha256(requestId), now, MAX_CODE_ATTEMPTS)` → `countSince(emailHash, now − 24 h)` ≥ cap → null → compare hashes → mismatch: `recordFailure` → null → `claimByRequest` → `startSession`. Add i18n keys (English, then all nine others): `email.codeIntro` ("Your sign-in code:"), `email.codeHint` ("Type it on the page where you asked to sign in, or use the button below. Both expire in 15 minutes and work once."). Update `email.subject` to "Your SVBC member portal sign-in code and link". `devEmail` prints the code too (it's local-only).

- [ ] **Step 4: Run** `npm test && npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit** `feat(member-portal): send a sign-in code with the link and verify it`

---

### Task 5: Routes, page, wiring and docs

**Files:**
- Modify: `src/routes.ts` (`POST /` ~331-397, `POST /auth/callback` ~432-475, new `POST /auth/code`), `src/views.ts` (`checkEmailView`), `src/index.ts`, `src/index.local.ts`, `src/routes.test.ts`, `src/i18n/locales/*.ts`, `README.md`, `../docs/uat/member-portal.md`

**Interfaces:**
- Consumes: Task 4 `requestLogin`, `verifyLogin`, `verifyCode`; Task 3 stores.
- Produces: `AppDeps.verifiedEmailStore: VerifiedEmailStore`, `AppDeps.codeFailureStore: CodeFailureStore`; cookie `LOGIN_REQUEST_COOKIE = '__Host-login-request'`; `checkEmailView(locale: Locale, next: string | null, codeError?: boolean): string`.

- [ ] **Step 1: Write the failing route tests** (extend the in-memory stores in `routes.test.ts` with the Task 3 methods)
  - `POST /` matching vs non-matching: identical body, and both responses set `__Host-login-request` (HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age=900).
  - `POST /` malformed address: sets the cookie too.
  - `POST /` denied by the per-address limiter: no `__Host-login-request` in `Set-Cookie`.
  - Check-email page has a form posting to `/auth/code` with `inputmode="numeric"`, `autocomplete="one-time-code"`, `maxlength="6"`, and a hidden `next` when the sign-in form carried one.
  - Full code flow: request → read the code from the `sendLoginEmail` mock → `POST /auth/code` with the cookie and `code` → 303 to `/{locale}/portal` (or `next`), session cookie set, `__Host-login-request` cleared, one `verified_emails` row.
  - Code `"123 456"` (with a space) signs in when the code is `123456`.
  - Wrong code / no cookie / cookie from a second browser's request: 200, check-email page with the `checkEmail.codeError` line and the form.
  - Link then code: the code fails. Code then link: the link shows `error.expiredLink`.
  - Shared Household Email: the signed-in session covers both people and both get `verified_emails` rows.
  - Cross-origin `POST /auth/code` → rejected by the CSRF check like `POST /auth/callback`.
  - Under `hold`, `POST /auth/code` still works (mirror the existing `POST /auth/callback stays live under hold` test).

- [ ] **Step 2: Run** `npm test -- src/routes.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**
  - `POST /`: generate `requestId` with `generateToken()`. Set the cookie unless `checkLoginRateLimit` returned `false` (set it for an empty/malformed address and when the limiter throws). Pass `requestId` to the deferred `requestLogin`. Render `checkEmailView(locale, next)`.
  - `POST /auth/code`: `ipLimiter.limit('code:' + ip)` denied → the code-error page; strip whitespace, require `^\d{6}$`, else the code-error page without touching D1; `verifyCode`; success → same session cookie and 303 redirect as `POST /auth/callback` (no `lang`, so `next` as-is or `/${detectLocale}/portal`) and delete `__Host-login-request`; failure → `checkEmailView(locale, next, true)`.
  - `POST /auth/callback`: pass `verifiedEmailStore` through to `verifyLogin`.
  - i18n: `checkEmail.body` now mentions the code ("…a sign-in link and code are on their way…"); new `checkEmail.codeLabel` ("Got a code? Enter it here"), `checkEmail.codeSubmit` ("Sign in"), `checkEmail.codeError` ("That code didn't work. Check it, or ask for a new email."), in all ten locales.
  - Wire `D1VerifiedEmailStore` and `D1CodeFailureStore` in `index.ts` and `index.local.ts`.
  - README "Auth" section: the code, the cookie, the two caps, Household Email, `verified_emails`; Development/deploy notes: apply migration 0007 first. UAT script: a "sign in with the code" step and a "sign in with your Household Email" step, with what the tester should see.

- [ ] **Step 4: Run** `npm test && npm run typecheck && node ../scripts/check-log-safety.mjs` — Expected: PASS.

- [ ] **Step 5: Smoke-test locally** — `npm run dev:local` (the `wrangler.local.jsonc` preview with `devEmail`, driven by `.claude/skills/run-member-portal/`; never `npm run dev`, which is production). Request sign-in, take the code from the dev log, type it on the check-email page. Expected: lands on the portal.

- [ ] **Step 6: Commit** `feat(member-portal): sign in with the emailed code`
