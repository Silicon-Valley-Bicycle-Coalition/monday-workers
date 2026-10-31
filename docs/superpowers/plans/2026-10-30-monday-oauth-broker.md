# Monday OAuth Broker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every deployed Worker gets its Monday access from a new `monday-auth` broker Worker holding OAuth 2.1 tokens for three apps (Portal, Staff sync, Read-only), all authorized by one *SVBC Integrations* user, instead of a personal `MONDAY_API_TOKEN`.

**Architecture:** `monday-auth` owns the OAuth client secrets and a D1 table of tokens per app, refreshes under a single-refresher lease with compare-and-swap (the `quickbooks-sync` token-store pattern), and exposes one `WorkerEntrypoint` per app. Consumers bind to their app's entrypoint (`MONDAY_AUTH`) and pass a token *provider* into the shared `graphql.ts` transport, which asks again once on a 401. The portal becomes read-only: its change-request queue is consumed by a second deploy of the same code, `member-portal-writer`, bound to the Staff sync token.

**Tech Stack:** Cloudflare Workers, Hono, TypeScript (strip-only for `graphql.ts`), D1, service bindings with named entrypoints (`WorkerEntrypoint` from `cloudflare:workers`), vitest + `@cloudflare/vitest-plugin`.

**Spec:** `docs/superpowers/specs/2026-10-30-monday-oauth-broker-design.md`

## Global Constraints

- Hono + TypeScript + D1, secrets via `wrangler secret put`, SVBC's Cloudflare account; every Worker has an `env.sandbox` block.
- `monday-backup/src/monday/graphql.ts` is canonical; the 11 copies listed in `.gitlab-ci.yml` job `monday-graphql-copies` stay byte-identical, and the file stays strip-only TypeScript (no constructor parameter properties, enums, namespaces).
- Tests never call `api.monday.com` or `auth.monday.com`; inject `fetchFn`.
- No HTTP response body and no log line ever contains an access or refresh token.
- Token endpoint `POST https://auth.monday.com/oauth_ms/oauth/token`; revoke `POST https://auth.monday.com/oauth_ms/oauth/revoke`; PKCE `S256` required; `expires_in` 3600.
- Refresh margin 10 minutes; proactive refresh cron every 30 minutes.
- Scopes — Portal: `boards:read me:read`. Staff sync: `boards:read boards:write updates:write assets:read users:read notifications:write me:read`. Read-only: `boards:read updates:read assets:read docs:read users:read workspaces:read me:read`.
- Admin/one-time tooling (salesforce-import, geo-filter, `scripts/*.mjs`, Workers' `scripts/*.mjs`, monday-backup restore CLI) keeps reading `MONDAY_API_TOKEN` from the operator's shell. Webhook registration stays human-owned.
- Type-check with `npm run typecheck` in each Worker, never bare `tsc`.
- Run `npm ci` once in any new Worker directory before its first test.

## Review Focus

1. **Two requests hit an expired token at once** (two isolates, or the cron and a consumer) → exactly one refresh call to Monday; the other waits and returns the new token. Pinned in Task 3.
2. **A consumer's token is revoked or expired mid-run** (backup's 15-minute run) → the transport asks the provider once with the rejected token, retries once, and on a second 401 throws `MondayApiError` with `httpStatus: 401` (no loop). Pinned in Task 1.
3. **Consent completed while logged into Monday as the wrong user** → token revoked, nothing stored, error page names the expected and actual user ids. Pinned in Task 4.
4. **Refresh rejected by Monday (`invalid_grant`)** → app marked `needs_consent`, one Slack alert per state change (not one per request), callers get a thrown error that their queues retry. Pinned in Task 3.
5. **A Worker deployed with neither a `MONDAY_AUTH` binding nor `MONDAY_API_TOKEN`** → construction throws a config error naming both, rather than sending an empty `Authorization` header. Pinned in Task 1.

---

## Human prerequisites (David, in the Monday and Cloudflare UIs; not agent work)

These gate Task 6 onward in sandbox and step 0.4 in production. Code tasks 1–5 don't need them.

- **H1.** Create the *SVBC Integrations* Monday user (CRM member + Work Management member). Note its user id.
- **H2.** In the Developer Center, create apps `SVBC Portal`, `SVBC Staff Sync`, `SVBC Read-only`. For each: OAuth & Permissions → scopes per Global Constraints; redirect URIs `https://svbc-monday-auth-sandbox.svbc-account.workers.dev/oauth/callback` and `https://svbc-monday-auth.svbc-account.workers.dev/oauth/callback`; draft version → **New OAuth Flow** on → promote live. Install each in the account.
- **H3.** After Task 6 deploys the sandbox broker: `wrangler secret put` (in `monday-auth`, `--env sandbox`) `PORTAL_CLIENT_ID`, `PORTAL_CLIENT_SECRET`, `SYNC_CLIENT_ID`, `SYNC_CLIENT_SECRET`, `READONLY_CLIENT_ID`, `READONLY_CLIENT_SECRET`, `START_KEY` (any long random string), `SLACK_WEBHOOK_URL`. Then, logged into Monday as **Sandbox Integration**, open `/oauth/start/portal?key=…`, `/sync`, `/readonly` and approve. Same for production with SVBC Integrations at cutover step 0.4.

---

### Task 1: Token provider in the shared transport

**Files:**
- Modify: `monday-backup/src/monday/graphql.ts:186-245` (constructor, header)
- Modify: the 11 copies listed in `.gitlab-ci.yml:87` (copy the canonical file over each)
- Test: `monday-backup/src/monday/graphql.test.ts`

**Interfaces:**
- Produces, exported from `graphql.ts`:
  - `type TokenProvider = (rejected?: string) => Promise<string>` — `rejected` is the token Monday just answered 401 to.
  - `interface MondayTokenSource { token(rejected?: string): Promise<string> }` — the shape of a consumer's `MONDAY_AUTH` binding.
  - `function tokenProviderFor(env: { MONDAY_AUTH?: MondayTokenSource; MONDAY_API_TOKEN?: string }): TokenProvider` — binding wins; else the string token; else throws `Error('monday auth: neither the MONDAY_AUTH service binding nor MONDAY_API_TOKEN is set')`.
  - `MondayGraphQL` constructor's second parameter widens to `string | TokenProvider`.

- [ ] **Step 1: Write the failing tests** in `graphql.test.ts`:
  - `'calls the provider per request'`: provider `vi.fn().mockResolvedValue('tokA')`, two `request()` calls → provider called twice, both fetches carry header `Authorization: 'tokA'`.
  - `'asks the provider again once after a 401, passing the rejected token'`: provider returns `'old'` then `'new'`; responses `[401, 200 {data:{ok:1}}]` → resolves `{ok:1}`; `provider.mock.calls` equals `[[], ['old']]`; second fetch header `'new'`.
  - `'a second 401 throws MondayApiError httpStatus 401 without a third call'`: responses `[401, 401]` → rejects `{ httpStatus: 401 }`; `fetchMock` called 2 times.
  - `'a string token never retries a 401'`: existing behavior, one fetch (keep the existing test at line ~137 green).
  - `'tokenProviderFor prefers the binding, falls back to the string, throws on neither'`: three asserts, the throw matching `/neither the MONDAY_AUTH service binding nor MONDAY_API_TOKEN/`.
  - `'401 retry does not count against maxAttempts'` — with `maxAttempts: 1`, responses `[401, 200]` → resolves.

- [ ] **Step 2: Run** `cd monday-backup && npm test -- src/monday/graphql.test.ts` — Expected: the new tests FAIL.

- [ ] **Step 3: Implement** in `graphql.ts`: store `private readonly tokenFor: TokenProvider` (wrap a string as `async () => s`), and a `private readonly refreshable: boolean` (true only for a function). Resolve the token at the top of each attempt. On `response.status === 401` with `refreshable` and no 401 retry used yet: resolve again with `rejected` set to the token just sent, and re-run the same attempt (don't increment `attempt`, don't sleep). Keep the bare header (no `Bearer`); Task 7 confirms.

- [ ] **Step 4: Run** `npm test && npm run typecheck` in `monday-backup` — Expected: PASS. Then `node --input-type=module -e "await import('./monday-backup/src/monday/graphql.ts')"` from the repo root — Expected: exits 0.

- [ ] **Step 5: Copy and verify**: `for c in $(grep -o '[a-z-]*/src/monday/graphql.ts' .gitlab-ci.yml | sort -u); do cp monday-backup/src/monday/graphql.ts $c; done`, then run the CI job's `cmp` loop from `.gitlab-ci.yml:86-93` — Expected: no output, exit 0. Run `npm test` in `donation-rollups` and `member-portal` — Expected: PASS (string tokens unchanged).

- [ ] **Step 6: Commit** `feat(graphql): token provider with one 401 re-ask; tokenProviderFor(env)`.

---

### Task 2: `monday-auth` scaffold, app table, and token store

**Files:**
- Create: `monday-auth/package.json` (copy `monday-backup/package.json`; name `monday-auth`; drop `restore`, `tsx`, `tsconfig.scripts.json` from typecheck), `tsconfig.json`, `vitest.config.ts` (copy `monday-backup`'s), `test/apply-migrations.ts`, `test/env.d.ts` (copy `monday-backup`'s)
- Create: `monday-auth/wrangler.jsonc`
- Create: `monday-auth/migrations/0001_oauth.sql`
- Create: `monday-auth/src/apps.ts`, `monday-auth/src/tokenStore.ts`
- Test: `monday-auth/src/apps.test.ts`, `monday-auth/src/tokenStore.test.ts`

**Interfaces:**
- Produces:
  - `type AppKey = 'portal' | 'sync' | 'readonly'`
  - `const APPS: Record<AppKey, { scopes: string[]; clientIdVar: string; clientSecretVar: string }>` (scopes verbatim from Global Constraints; vars `PORTAL_CLIENT_ID` etc.)
  - `interface StoredAppToken { app: AppKey; accessToken: string; refreshToken: string; accessTokenExpiresAt: string; authorizedUserId: string; status: 'ok' | 'needs_consent'; version: number }`
  - `class D1AppTokenStore` with `get(app)`, `save(token: Omit<StoredAppToken,'version'|'status'>)` (upsert, bumps version, status `ok`, clears lease), `acquireRefreshLease(app, version, leaseToken, now: Date, ttlMs)`, `saveRefreshed(app, {accessToken, refreshToken, accessTokenExpiresAt}, expectedVersion, leaseToken): Promise<boolean>`, `releaseRefreshLease(app, leaseToken)`, `markNeedsConsent(app): Promise<boolean>` (true only if it changed the status), `putPending(state, app, codeVerifier, now)`, `takePending(state, now): Promise<{app, codeVerifier} | null>` (deletes the row; null if missing or older than 10 minutes).
  - `Env` (in `src/env.ts`): `DB: D1Database; ENVIRONMENT: 'production' | 'sandbox'; EXPECTED_USER_ID: string; MONDAY_SUBDOMAIN: string; START_KEY: string; SLACK_WEBHOOK_URL?: string;` plus the six client id/secret strings.

- [ ] **Step 1: Write `wrangler.jsonc`**: `name: "monday-auth"`, `main: "src/index.ts"`, `workers_dev: true`, `triggers.crons: ["*/30 * * * *"]`, D1 binding `DB` database `monday-auth`, vars `ENVIRONMENT: "production"`, `EXPECTED_USER_ID: ""`, `MONDAY_SUBDOMAIN: "<SVBC's monday subdomain — copy from any monday.com URL in the cutover runbook>"`; `env.sandbox` with `name: "monday-auth-sandbox"`, D1 `monday-auth-sandbox`, `ENVIRONMENT: "sandbox"`, `EXPECTED_USER_ID: "117112617"` (Sandbox Integration). Leave `database_id`s as placeholders for Task 6.

- [ ] **Step 2: Write `0001_oauth.sql`**: `oauth_tokens(app TEXT PRIMARY KEY, access_token TEXT NOT NULL, refresh_token TEXT NOT NULL, access_token_expires_at TEXT NOT NULL, authorized_user_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ok', version INTEGER NOT NULL DEFAULT 1, refresh_lease_token TEXT, refresh_lease_until TEXT, updated_at TEXT NOT NULL)` and `oauth_pending(state TEXT PRIMARY KEY, app TEXT NOT NULL, code_verifier TEXT NOT NULL, created_at TEXT NOT NULL)`.

- [ ] **Step 3: Write the failing tests**:
  - `apps.test.ts`: `'Portal is read-only'` → `APPS.portal.scopes` equals `['boards:read']`; `'no app requests a write scope it does not list in the spec'` → exact arrays for `sync` and `readonly`.
  - `tokenStore.test.ts` (against the real D1 from migrations): `'only one of two leases wins'`; `'saveRefreshed fails when the version moved'`; `'saveRefreshed fails when another caller holds the lease'`; `'markNeedsConsent returns true once, then false'`; `'save after needs_consent resets status to ok'`; `'takePending returns null after 10 minutes and deletes on read'`.

- [ ] **Step 4: Run** `cd monday-auth && npm ci && npm test` — Expected: FAIL (modules missing).

- [ ] **Step 5: Implement** `apps.ts`, `env.ts`, `tokenStore.ts` — port `quickbooks-sync/src/quickbooks/tokenStore.ts`, keyed by `app` instead of `id = 1`.

- [ ] **Step 6: Run** `npm test && npm run typecheck` — Expected: PASS.

- [ ] **Step 7: Commit** `feat(monday-auth): scaffold, app scopes, D1 token store`.

---

### Task 3: Monday OAuth client and the refresh broker

**Files:**
- Create: `monday-auth/src/mondayOAuth.ts`, `monday-auth/src/broker.ts`, `monday-auth/src/alert.ts`
- Test: `monday-auth/src/mondayOAuth.test.ts`, `monday-auth/src/broker.test.ts`

**Interfaces:**
- Consumes: `D1AppTokenStore`, `APPS`, `Env` (Task 2).
- Produces:
  - `mondayOAuth.ts`: `authorizeUrl({clientId, redirectUri, scopes, state, codeChallenge, subdomain}): string` (base `https://auth.monday.com/oauth2/authorize`, `code_challenge_method=S256`); `pkcePair(): Promise<{verifier, challenge}>`; `exchangeCode({clientId, clientSecret, code, redirectUri, verifier}, fetchFn)`, `refresh({clientId, clientSecret, refreshToken}, fetchFn)` → `Promise<{accessToken, refreshToken, expiresAt: string}>` (expiry from `expires_in`, else JWT `exp`); `revoke({clientId, clientSecret, token}, fetchFn)`; `fetchMe(accessToken, fetchFn): Promise<{id: string, name: string}>`. A non-2xx from the token endpoint with `error: 'invalid_grant'` throws `RefreshRejectedError`; any other failure throws `Error` (retryable).
  - `broker.ts`: `class TokenBroker { constructor(deps: { store; env: Env; fetchFn; now: () => Date; sleep: (ms) => Promise<void>; alert: (text: string) => Promise<void> }); token(app: AppKey, rejected?: string): Promise<string>; refreshAllIfDue(): Promise<void> }`. Constants: `REFRESH_MARGIN_MS = 10 * 60_000`, `LEASE_TTL_MS = 30_000`, loser re-reads up to 10 times, 300 ms apart.
  - `alert.ts`: `slackAlert(webhookUrl: string | undefined, fetchFn): (text) => Promise<void>` (no-op when unset; never throws).

- [ ] **Step 1: Write the failing tests**:
  - `mondayOAuth.test.ts`: `'authorizeUrl pins subdomain, S256 and space-joined scopes'`; `'exchangeCode posts code_verifier and grant_type authorization_code to oauth_ms/oauth/token'`; `'refresh returns the rotated refresh token'`; `'invalid_grant throws RefreshRejectedError'`; `'expiresAt falls back to JWT exp when expires_in is missing'`.
  - `broker.test.ts` (D1 store + fake `fetchFn` counting token-endpoint calls):
    - `'returns the stored token while more than 10 minutes remain'` — 0 refresh calls.
    - `'refreshes inside the margin and stores the rotated refresh token'`.
    - `'two concurrent token() calls on an expiring token make one refresh call'` — `Promise.all` of two → both equal the new token; refresh calls === 1. *(Review Focus 1)*
    - `'rejected token equal to the stored one forces a refresh even if not near expiry'`; `'rejected token that is already stale returns the stored token without refreshing'`.
    - `'invalid_grant marks needs_consent, alerts once, and throws'` — two `token()` calls → alert called once; both reject `/needs consent/`. *(Review Focus 4)*
    - `'token() on a needs_consent or missing app throws without calling Monday'`.
    - `'refreshAllIfDue refreshes only apps inside the margin and isolates failures'`.
    - `'no thrown message or alert text contains the access or refresh token'` — assert on every captured string.

- [ ] **Step 2: Run** `npm test -- src/mondayOAuth.test.ts src/broker.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement** `mondayOAuth.ts` (Web Crypto for PKCE: 32 random bytes base64url verifier, SHA-256 challenge), `alert.ts`, then `broker.ts`. Token-flow algorithm: read row → if missing/`needs_consent` throw → if `rejected` is set and differs from the stored access token, return stored → if not forced and expiry − now > margin, return stored → acquire lease at the row's version → on win: `refresh()`, `saveRefreshed()`, return new; on `RefreshRejectedError`: release, `markNeedsConsent()` and alert if it returned true, throw → on loss: sleep and re-read until the version moves, then return the stored token.

- [ ] **Step 4: Run** `npm test && npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit** `feat(monday-auth): OAuth 2.1 client and single-refresher broker`.

---

### Task 4: Consent routes, entrypoints, cron

**Files:**
- Create: `monday-auth/src/routes.ts`, `monday-auth/src/index.ts`
- Test: `monday-auth/src/routes.test.ts`, `monday-auth/src/index.test.ts`

**Interfaces:**
- Consumes: Tasks 2–3.
- Produces:
  - `createApp(deps: { store; env: Env; fetchFn; now }): Hono` with `GET /health` (JSON `{ app, status: 'ok'|'needs_consent'|'missing', expiresAt? }[]` — no tokens), `GET /oauth/start/:app?key=` (403 unless `key === env.START_KEY` compared in constant time; 404 for an unknown app; else store pending + 302 to `authorizeUrl` with `redirectUri = new URL('/oauth/callback', request.url).href`), `GET /oauth/callback?code&state`.
  - `src/index.ts` default export `{ fetch, scheduled }` (scheduled → `broker.refreshAllIfDue()`), and named exports `class PortalToken`, `SyncToken`, `ReadOnlyToken` extending `WorkerEntrypoint<Env>`, each with `token(rejected?: string): Promise<string>` calling `TokenBroker.token('portal' | 'sync' | 'readonly', rejected)`.

- [ ] **Step 1: Write the failing tests**:
  - `routes.test.ts`: `'start without the key is 403 and stores nothing'`; `'start redirects to auth.monday.com with the stored state and S256 challenge'`; `'callback with an unknown or expired state is 400'`; `'callback for the expected user stores the token and the page shows app, user and scopes but not the token'`; `'callback for another user revokes the token, stores nothing, and the page names both user ids'` *(Review Focus 3)*; `'/health never includes a token'`.
  - `index.test.ts`: `'each entrypoint asks the broker for its own app only'` — instantiate `PortalToken` with a stub env, assert the broker saw `'portal'`; `'scheduled calls refreshAllIfDue'`.

- [ ] **Step 2: Run** `npm test` — Expected: FAIL.

- [ ] **Step 3: Implement** `routes.ts` and `index.ts`. HTML pages are plain text-ish (`c.html` with escaped values); no styling needed.

- [ ] **Step 4: Run** `npm test && npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit** `feat(monday-auth): consent flow with user check, per-app entrypoints, refresh cron`.

---

### Task 5: Probe route for the Monday verifications

**Files:**
- Create: `monday-auth/src/probe.ts`; modify `monday-auth/src/routes.ts`
- Test: `monday-auth/src/probe.test.ts`

**Interfaces:**
- Consumes: `TokenBroker.token`, `summarizeScope` imported from `../../scripts/check-monday-token-scope.mjs` (pure; if the bundler rejects the import, move `summarizeScope` and `listBoards` into `scripts/lib/token-scope.mjs` and import from both).
- Produces: `GET /oauth/probe/:app?key=&workspace=<id>` → JSON report, no tokens:
  - `me` (id, name); `scope` (the `summarizeScope` result for `workspace`)
  - `bareHeader` and `bearerHeader`: each `{ ok: boolean, error?: string }` for `{ me { id } }`
  - `platformApi`: `{ ok, error? }` for `{ platform_api { daily_limit { base } } }`
  - `complexity`: `{ before, after, resetInSeconds }` from `{ complexity { before after reset_in_x_seconds } me { id } }`

- [ ] **Step 1: Write the failing tests**: `'probe requires the key'`; `'probe reports each check independently when one fails'` (fake fetch failing only `platform_api`); `'probe output never contains the token'`.
- [ ] **Step 2: Run** `npm test -- src/probe.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `probe.ts` with direct `fetch` (not `MondayGraphQL`: the header variants are the point).
- [ ] **Step 4: Run** `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(monday-auth): probe route for scope, header, platform_api and complexity checks`.

---

### Task 6: Deploy the sandbox broker and run the verifications

Needs H1–H2. Operator steps run by David where marked; the agent records results.

**Files:**
- Modify: `monday-auth/wrangler.jsonc` (real D1 ids)
- Create: `monday-auth/README.md`
- Modify: `docs/superpowers/specs/2026-10-30-monday-oauth-broker-design.md` (append "Verification results, 2026-10-31")

- [ ] **Step 1:** `cd monday-auth && npx wrangler d1 create svbc-monday-auth-sandbox` and `npx wrangler d1 create svbc-monday-auth`; put the ids in `wrangler.jsonc`. `npx wrangler d1 migrations apply svbc-monday-auth-sandbox --remote --env sandbox`. `npm run deploy:sandbox` — Expected: deploy succeeds; `curl https://svbc-monday-auth-sandbox.svbc-account.workers.dev/health` lists three apps `missing`.
- [ ] **Step 2 (David):** H3 for sandbox. Expected: `/health` shows three apps `ok`.
- [ ] **Step 3:** For each app, open `/oauth/probe/<app>?key=…&workspace=17141226` (David pastes the JSON, or the agent uses the browser pane with David's approval of the key). Record per spec item: (1) `platformApi.ok` on `readonly`; (4) which header variant works; (6) run `probe/sync` then immediately `probe/readonly` — if `readonly`'s `complexity.before` is lower than its fresh budget by `sync`'s spend, the budget is per user. Item 5 is answered by Step 2 succeeding with one app per two redirect URIs.
- [ ] **Step 4: Act on results.** Bearer required → in Task 1's `graphql.ts`, prefix `Bearer ` only for provider-sourced tokens, add a test `'provider tokens are sent as Bearer'`, recopy, commit. `platform_api` uncovered → in `monday-backup/src/usage.ts` treat an auth/scope error as "usage unavailable" (log, no alert), with a test. Per-user budget → in `monday-backup/wrangler.jsonc` move the hourly cron from `30 * * * *` to `45 * * * *` and note the per-user budget in its README.
- [ ] **Step 5:** Write `monday-auth/README.md`: purpose; the three apps and scopes; the accepted `member-portal` read exposure verbatim from the spec; consent and re-consent procedure (`needs_consent` alert → open `/oauth/start/<app>` as the integration user); secrets table; the probe route. Append results to the spec.
- [ ] **Step 6: Commit** `chore(monday-auth): sandbox deployed; verification results`.

---

### Task 7: Move `donation-rollups` onto the broker (pattern-setting)

**Files:**
- Modify: `donation-rollups/src/index.ts:53,117,130`, `donation-rollups/src/types.ts:192`, `donation-rollups/src/monday/client.ts` (constructor accepts `string | TokenProvider`, passes through), `donation-rollups/wrangler.jsonc` (services), `donation-rollups/README.md` (secrets table)
- Test: `donation-rollups/src/index.test.ts` (or the existing test that builds deps)

**Interfaces:**
- Consumes: `tokenProviderFor`, `MondayTokenSource` (Task 1); entrypoint `SyncToken` (Task 4).
- Produces: the per-Worker recipe Task 8 repeats: `Env` gains `MONDAY_AUTH?: MondayTokenSource` and `MONDAY_API_TOKEN` becomes optional; every `new HttpMondayClient(url, env.MONDAY_API_TOKEN, …)` becomes `new HttpMondayClient(url, tokenProviderFor(env), …)`; `wrangler.jsonc` top level `"services": [{ "binding": "MONDAY_AUTH", "service": "svbc-monday-auth", "entrypoint": "SyncToken" }]`, and `env.sandbox` the same with `"service": "svbc-monday-auth-sandbox"`.

- [ ] **Step 1: Write the failing test** `'builds its Monday client from the MONDAY_AUTH binding when bound'`: env with `MONDAY_AUTH: { token: vi.fn().mockResolvedValue('brokered') }` and no `MONDAY_API_TOKEN`; trigger one handler path that reads Monday with a stubbed `fetch`; assert the request header is `'brokered'`.
- [ ] **Step 2: Run** `npm test` — Expected: FAIL.
- [ ] **Step 3: Implement** the recipe above.
- [ ] **Step 4: Run** `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Sandbox QA:** `npm run deploy:sandbox`; `npx wrangler secret delete MONDAY_API_TOKEN --env sandbox`; run the Worker's README sandbox verification (a test donation edit recomputes the donor's rollups). David confirms in the CRM Sandbox. Expected: rollup columns update **and the donor's item description is rewritten** (this answers spec verification item 2: `set_item_description_content` works under the Staff sync scopes, which have no `docs:write`); `wrangler tail --env sandbox` shows no 401 or scope error.
- [ ] **Step 6: Commit** `feat(donation-rollups): Monday token from the monday-auth broker`.

---

### Task 8: Move the remaining Workers onto the broker

Repeat Task 7's recipe and test for each, in this order (runbook deploy order): `report-digests` (`ReadOnlyToken`; must pass sandbox QA before Monday 08:00), `funraise-sync`, `mailchimp-sync`, `benevity-import`, `email-log`, `eventbrite-sync`, `people-reclassification`, `quickbooks-sync` (all `SyncToken`), `monday-backup` (`ReadOnlyToken`; its `env.ts:10`), `bp-feedback-notify` (`SyncToken`; its own `src/mondayApi.ts` takes a `TokenProvider` and applies the same one re-ask on 401 — test `'re-asks once on 401'`).

**Files:** per Worker, the `index.ts` lines and `types.ts`/`env.ts` field listed in the spec's survey (`MONDAY_API_TOKEN` sites from `grep -rn MONDAY_API_TOKEN <worker>/src`), its `src/monday/client.ts` constructor (widen the token parameter to `string | TokenProvider`), `wrangler.jsonc`, README secrets table.

- [ ] **Step 1:** For each Worker: failing test as in Task 7 Step 1 → implement → `npm test && npm run typecheck` PASS → `npm run deploy:sandbox` → delete its sandbox `MONDAY_API_TOKEN` → its README's sandbox check passes → commit `feat(<worker>): Monday token from the monday-auth broker`.
- [ ] **Step 2:** `eventbrite-sync/src/index.ts:127-129` and `bp-feedback-notify/src/index.ts:101-103` check `MONDAY_API_TOKEN` directly: replace with a `tokenProviderFor(env)` call inside a try, keeping each Worker's existing log/throw message but naming both settings.
- [ ] **Step 3:** `monday-backup` sandbox QA: trigger one backup run (its README's manual run); Expected: completes inside the 15-minute deadline with no 401, Drive files written, and the boards listed match its `workspaceIds` (answers spec verification item 3: `boards(workspace_ids:…)` works under the Read-only scopes).

---

### Task 9: Portal read-only; `member-portal-writer` consumes change requests

**Files:**
- Create: `member-portal/wrangler.writer.jsonc`, `member-portal/src/writer.ts`
- Modify: `member-portal/wrangler.jsonc:44-62,120-136` (remove the `member-portal-change-requests` consumers; keep producers and the letter-emails consumer), `member-portal/src/index.ts` (client from `tokenProviderFor(env)`, binding `PortalToken`), `member-portal/src/monday/client.ts:123-147` (token parameter widens to `string | TokenProvider`), `member-portal/src/types.ts:347`, `member-portal/package.json` (scripts `deploy:writer`, `deploy:writer:sandbox`), `member-portal/README.md`
- Test: `member-portal/src/writer.test.ts`, `member-portal/src/index.test.ts`

**Interfaces:**
- Consumes: `routeQueueBatch` and `consumeChangeQueueBatch` (`member-portal/src/index.ts:70-83`), `HttpMondayClient`, `tokenProviderFor`.
- Produces: `src/writer.ts` default export `{ queue(batch: MessageBatch<ChangeQueueMessage>, env) }` that builds the same deps as `index.ts`'s `queue()` but only for `member-portal-change-requests` (throws on any other queue name), with `monday` from `tokenProviderFor(env)`. `wrangler.writer.jsonc`: `name: "member-portal-writer"`, `main: "src/writer.ts"`, `workers_dev: false`, same `DB` database id and `FLAGS` KV as `wrangler.jsonc`, the change-requests consumer block moved verbatim (`max_retries: 100`, `max_concurrency: 1`, DLQ), services `MONDAY_AUTH` → `monday-auth` / `SyncToken`; `env.sandbox` mirrors with `-sandbox` names.

- [ ] **Step 1: Write the failing tests**:
  - `writer.test.ts`: `'writes a change request through the SyncToken provider'`; `'rejects a message whose fields fail validation and acks it to the DLQ path'` (reuse the existing validation in `consumeChangeQueueBatch`; if it trusts the message shape, add the check there and test it); `'throws on any queue other than change-requests'`.
  - `index.test.ts`: `'the portal never calls a Monday mutation'` — grep-style test: read `wrangler.jsonc` (strip JSONC as `scripts/check-worker-flags.mjs` `stripJsonc` does) and assert no consumer for `member-portal-change-requests` in either env, and the portal's `MONDAY_AUTH` entrypoint is `PortalToken`.
- [ ] **Step 2: Run** `npm test` — Expected: FAIL.
- [ ] **Step 3: Implement.** Add `wrangler.writer.jsonc` to `worker-flags-copies`' FLAGS id check in `scripts/check-worker-flags.mjs` if it scans config files by name.
- [ ] **Step 4: Run** `npm test && npm run typecheck` (typecheck both configs: `wrangler types -c wrangler.writer.jsonc` into a separate file if needed) — Expected: PASS.
- [ ] **Step 5: Sandbox QA:** deploy writer first (`npm run deploy:writer:sandbox`), then the portal (`npm run deploy:sandbox`); delete the portal's sandbox `MONDAY_API_TOKEN`; submit a change request in the sandbox portal. Expected: item appears on the sandbox Change Requests board; portal pages render; `wrangler tail` on the portal shows no mutation.
- [ ] **Step 6: Commit** `feat(member-portal): read-only portal; member-portal-writer consumes change requests`.

---

### Task 10: CI check for bindings

**Files:**
- Create: `scripts/check-monday-auth-bindings.mjs`, `scripts/test/check-monday-auth-bindings.test.mjs` (follow whatever test location `check-worker-flags.mjs` uses)
- Modify: `.gitlab-ci.yml` (new job `monday-auth-bindings`, same `rules.changes` shape as `worker-flags-copies` plus `monday-auth/**`)

**Interfaces:**
- Produces: `EXPECTED: Record<string, 'PortalToken'|'SyncToken'|'ReadOnlyToken'>` for every Worker in Tasks 7–9 including `member-portal-writer` (file `member-portal/wrangler.writer.jsonc`); `checkBindings(configs): string[]` returning problems.

- [ ] **Step 1: Write failing tests**: `'flags a Worker bound to the wrong entrypoint'`; `'flags a sandbox env bound to production monday-auth'`; `'flags a Worker with no MONDAY_AUTH binding'`; `'passes the repo as it is'`.
- [ ] **Step 2–4:** run (FAIL) → implement (reuse `stripJsonc` from `check-worker-flags.mjs` by import) → run (PASS).
- [ ] **Step 5: Commit** `ci: check every Worker binds its monday-auth entrypoint`.

---

### Task 11: Documentation, both repos

**Files (monday-workers):** `README.md` ("Least-privilege Monday tokens" section rewritten: one SVBC Integrations user, broker, three apps, Sandbox Integration for sandbox via the sandbox broker, the accepted portal read exposure, board privacy still required), `CLAUDE.md` ("Monday API tokens are least-privilege by design" paragraph; add `monday-auth` to the sandbox Worker list).

**Files (monday-migration, its own worktree per its CLAUDE.md):** `docs/23-cutover-runbook.md` row 0.4 (create SVBC Integrations; deploy `monday-auth`; H2–H3 for production; `/health` shows three `ok`), rows 3.8 (subscribe SVBC Integrations, not three users) and 4.x deploy rows (each Worker deploys with its binding, no `MONDAY_API_TOKEN`); `docs/25-remaining-tasks.md` #78 line; `migration-plan.md` seats table (integration users 4 → 2: SVBC Integrations, Sandbox Integration; CRM 7/10); `README.md` index if it lists specs.

- [ ] **Step 1:** Edit the files. **Step 2:** `grep -rn "three integration users\|member-portal.*own user\|MONDAY_API_TOKEN" README.md CLAUDE.md */README.md` in monday-workers — Expected: remaining hits are only admin/CLI tooling. **Step 3:** Commit in each repo (`docs: one integration user via the monday-auth broker`).
- [ ] **Step 4 (needs David's OK before posting):** update #78's description checklist and #19 to the one-user plan via `glab`.

---

### Task 12: Production at cutover step 0.4

Operator task, in runbook order; listed so nothing is forgotten.

- [ ] H1 done; `EXPECTED_USER_ID` set to SVBC Integrations' id in `monday-auth/wrangler.jsonc`; commit.
- [ ] `npx wrangler d1 migrations apply svbc-monday-auth --remote`; `npm run deploy` in `monday-auth`; H3 for production as SVBC Integrations; `/health` three `ok`; `/oauth/probe/sync?key=…&workspace=18201685` shows `me` = SVBC Integrations.
- [ ] Each Worker's production deploy (runbook 4.x) uses its binding; no production `MONDAY_API_TOKEN` is ever set on a Worker. `member-portal-writer` deploys before `member-portal`.
- [ ] Runbook 3.8 board privacy: subscribe SVBC Integrations to the Workers' boards.
