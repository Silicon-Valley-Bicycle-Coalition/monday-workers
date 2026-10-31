# Monday OAuth broker: one integration user, scoped app tokens

Date: 2026-10-30. Status: design approved in chat, not built. Calls marked *(design-author's
call)* were made by the author while writing this up, not discussed — check them.

## Intent

Today every Worker that talks to Monday holds a **personal API token** (`MONDAY_API_TOKEN`) for a
dedicated integration user, one user per exposure class (root README, "Least-privilege Monday
tokens"). On monday CRM each such user takes a paid **CRM member seat**, and SVBC has decided to
stay within CRM's free 10 seats (private repo `migration-plan.md`, Seats per product, #70; #78).
Three integration users would spend three of those ten, and every seat an integration user holds
is one a staff member or volunteer can't have without a purchase decision.

This design replaces the personal tokens with **Monday OAuth app tokens, all authorized by one
dedicated user, _SVBC Integrations_** (mirroring the single `SVBC Integration` user Salesforce's
connected apps ran as). That costs **one** CRM member seat. The per-Worker narrowing that separate
users used to provide comes instead from **OAuth scopes, one app per exposure class**.

Why this works and what it trades away:

- Monday has **no app identity**: an OAuth token "belongs to the user" who authorized the app, so
  a seat is still needed — one, shared.
- Scopes limit the **kind** of operation (`boards:read`, `boards:write`, `updates:write`…), never
  **which boards**. Every Worker can reach every board SVBC Integrations can see. The board-level
  isolation separate users gave (with private boards, runbook step 3.8) is given up.
- Monday's **OAuth 2.1 flow** adds expiring access tokens (`expires_in` 3600 s), rotating
  refresh tokens, and revocation, so a leaked access token is useful for about an hour and a whole
  app can be cut off by revoking or uninstalling it.

## Decided (in conversation, 2026-10-30)

- One dedicated user, **SVBC Integrations**, authorizes every production app. CRM member seat;
  plus a Work Management seat, because `monday-backup` reads every workspace (WM has 20 paid
  seats, so this costs nothing new).
- OAuth apps **per exposure class**, three of them (table below).
- **Accepted risk, to be documented where operators will see it:** `member-portal` is
  internet-facing, and its token can **read** every board SVBC Integrations can see, not only the
  ones the portal displays. Accepted because the alternative (its own user) costs a seat.
- **The portal is read-only** (`boards:read` only). `boards:write` isn't board-limited, so a
  portal holding it could change or archive items on Donations or any other board; that write
  exposure is **not** accepted. The portal's one write, `create_item` for change requests, moves
  to a staff-side Worker (see "Change requests leave the portal").
- **Schedule:** built over the cutover weekend (2026-10-31 to 11-01), in parallel with the
  production load, with dwk doing QA. Production Workers still deploy straight onto the broker;
  there is no interim personal token.
- **Live at cutover**: production Workers go live on OAuth tokens, not on a personal token with a
  later switch-over. Step 0.4 of the cutover runbook (#78) becomes "create SVBC Integrations,
  install and authorize the three apps" instead of "create three users, mint three tokens".
- A token broker Worker and the three-app grouping below (proposed by the author, approved).

## Goals

- Production Workers authenticate to Monday only through short-lived OAuth access tokens.
- One CRM seat for all integrations.
- Each Worker gets only its exposure class's scopes; a Worker can't obtain another class's token.
- Exactly one component ever refreshes a given app's token (Monday rotates refresh tokens; two
  refreshers racing would lock each other out).
- No route anywhere returns a Monday token over HTTP.
- Sandbox runs the same mechanism so cutover is rehearsed.

## Non-goals

- Board-level restriction. That remains private boards plus subscriptions (runbook step 3.8,
  `scripts/make-boards-private.mjs`), and still matters for keeping the **Sandbox Integration**
  user off production boards.
- Admin and one-time tooling. These keep using a human admin's personal token, as today:
  `salesforce-import` (load, configure, `MONDAY_DASHBOARD_TOKEN` for dashboards),
  `scripts/make-boards-private.mjs`, `member-portal/scripts/setup-production-boards.mjs`,
  `member-portal/scripts/create-letter-settings-board.mjs`, `donation-rollups/scripts/*`
  (including `setup-webhooks.mjs`), `monday-backup`'s restore CLI, `geo-filter`.
- `svbc-calendars` (doesn't call Monday).
- A UI beyond the two OAuth pages the consent flow needs.

## Anti-goals (would be a failure even if it works)

- A Worker breaks at 3 a.m. because a refresh token rotated under it, and nobody hears about it.
- A token ends up authorized by the wrong Monday user (a staff member clicking the consent link
  while logged in as themselves) and nobody notices.
- Webhooks silently disappear because an app was uninstalled.

## Apps and scopes

| App | Workers | Scopes |
|---|---|---|
| **Portal** | `member-portal` | `boards:read`, `me:read` |
| **Staff sync** | `funraise-sync`, `donation-rollups`, `mailchimp-sync`, `benevity-import`, `email-log`, `eventbrite-sync`, `people-reclassification`, `bp-feedback-notify`, `quickbooks-sync` (postponed, wired anyway) | `boards:read`, `boards:write`, `updates:write`, `assets:read`, `users:read`, `notifications:write`, `docs:write`, `me:read` |
| **Read-only** | `monday-backup`, `report-digests` | `boards:read`, `updates:read`, `assets:read`, `docs:read`, `users:read`, `workspaces:read`, `me:read` |

2026-10-30: me:read added after live consent; the consent check queries `me`.

2026-10-31: docs:write added to Staff sync. On the sandbox broker, `donation-rollups`' gift-history
description write (`set_item_description_content`) was refused with "missing required scopes"
under `boards:write` alone (open question 2 below).

Per-Worker operations behind this mapping (surveyed 2026-10-30 on `main`):

- `member-portal`: `items_page`/`next_items_page`/`items`/`items_page_by_column_values`. Its one
  write, `create_item` (change requests), moves out (below).
- `donation-rollups`: reads plus `change_multiple_column_values`, `set_item_description_content`,
  `create_item`, `archive_item`, `create_update`.
- `benevity-import`: also `assets(ids){public_url}`. `email-log`, `report-digests`: `users`.
  `eventbrite-sync`: `create_notification`. `people-reclassification`: `move_item_to_board`.
- `monday-backup`: `boards(state:all)`, `items_page`, `updates`, `assets`, `docs{blocks}`,
  `platform_api{daily_limit, daily_analytics}`.

**To verify against Monday before building** (the builder's first task):

1. Which scope, if any, covers `platform_api` (backup's usage stats). If none, drop that query
   from the backup or fail it soft.
2. That `set_item_description_content` is `boards:write` and not `docs:write`. **Answered
   2026-10-31: `boards:write` is not enough** ("missing required scopes" on the sandbox broker);
   Staff sync now requests `docs:write`.
3. That `workspaces:read` is needed for `boards(workspace_ids:…)` filtering, or not.
4. Whether the OAuth token takes `Authorization: Bearer <token>`; the shared transport sends the
   bare token (`graphql.ts:240-242`), which works for personal tokens.
5. Whether one app can register two redirect URIs (production and sandbox broker), and whether one
   app can be authorized by two users (SVBC Integrations and Sandbox Integration) with
   independent tokens.
6. Whether Monday's per-minute complexity budget is per user, per app, or per token. All Workers
   now share one user; if the budget is per user, the backup's hourly run and a donation burst
   compete. Measure in sandbox.

Fallbacks *(design-author's calls)*: none of these blocks the design, so verification runs
alongside the build rather than gating it. Item 5: if one app can't serve both environments,
create a second set of three apps for sandbox (tokens are per app per user, so this always
works). Item 6: if the budget is per user, throttle `monday-backup` (it already runs under a
15-minute deadline and can resume) and move its runs off the hour; a separate user for the backup
is the last resort, since it costs the seat this design exists to save.

## Architecture

### `monday-auth` Worker (new)

A new Worker, `monday-auth`, owns the OAuth apps' credentials and tokens and is the only thing
that talks to `auth.monday.com`.

- **Storage:** its own D1, one row per app: refresh token, current access token and its expiry
  (from the JWT `exp`), a `version` for compare-and-swap, a refresh lease, the authorizing user's
  Monday id, and timestamps. Reuse the pattern from `quickbooks-sync/src/quickbooks/tokenStore.ts`
  (table `qb_oauth_tokens`, migrations `0001` and `0003`: single-refresher lease plus CAS) and the
  refresh loop in `quickbooks-sync/src/quickbooks/client.ts:103-185`.
- **Secrets:** each app's client id and client secret (`wrangler secret put`, entered by a human),
  and the expected SVBC Integrations user id per environment (a var, not a secret).
- **Refresh:** on request, return the cached access token if it has more than a margin
  *(design-author's call: 10 minutes)* left; otherwise take the lease, refresh at
  `POST https://auth.monday.com/oauth_ms/oauth/token`, store the **new** refresh token and access
  token in one CAS write, release. A loser of the lease waits briefly and re-reads. A cron
  *(design-author's call: every 30 minutes)* refreshes proactively so that a quiet app's refresh
  token is exercised and a broken one is noticed before a Worker needs it.
- **Failure:** if a refresh is rejected (refresh token revoked or expired), mark the app
  `needs_consent`, log loudly, and alert *(design-author's call: the Slack webhook `monday-backup`
  already uses, as a broker secret)*. Workers asking for that app's token get an error; their
  queues retry under the write switch's escalating-delay policy
  (`2026-10-26-write-switch-design.md`), so nothing is lost while someone re-authorizes.

### Handing tokens to Workers: service bindings with one entrypoint per app

Workers never call the broker over HTTP. The broker exports **one RPC entrypoint per app**
(`WorkerEntrypoint` subclasses, e.g. `PortalToken`, `SyncToken`, `ReadOnlyToken`), each with a
single method returning a current access token for its app only. Each consumer Worker's
`wrangler.jsonc` declares a service binding (e.g. `MONDAY_AUTH`) to `monday-auth` with the
`entrypoint` for its class. So `member-portal` is physically bound to `PortalToken` and has no way
to ask for the Staff sync token. *(design-author's call: entrypoint-per-app rather than a
parameter, so the mapping is enforced by config, not by code paths.)*

Service bindings are environment-specific: sandbox Workers bind to the sandbox broker, production
to production. Each environment's `config/split.test.ts` (or equivalent) should assert that.

### Consumer change

- The shared transport `src/monday/graphql.ts` (canonical copy in `monday-backup`, 12
  byte-identical copies, CI job `monday-graphql-copies`) takes a **token provider**
  (`() => Promise<string>`) instead of a fixed string. Keep accepting a string for the CLIs and
  tests. On a 401, ask the provider once more and retry once (the token may have expired
  mid-run), then fail.
- Each Worker's `index.ts` builds its client from the binding instead of `env.MONDAY_API_TOKEN`.
  Clients are already built per request / batch / cron run, so this is local.
- `bp-feedback-notify/src/mondayApi.ts` has its own `fetch`; give it the same provider.
- Long runs (`monday-backup`'s 15-minute cron, `donation-rollups`' custodian,
  `people-reclassification`'s daily pass) rely on the provider being called per request, not once
  per run.
- Remove `MONDAY_API_TOKEN` from production Worker secrets once a Worker is on the broker, so a
  stale personal token can't linger. *(design-author's call: keep reading `MONDAY_API_TOKEN` as a
  fallback only for local dev / tests, never in a deployed environment.)*

### Change requests leave the portal

Change requests already go through a queue: the portal produces to
`member-portal-change-requests` (`CHANGE_QUEUE`) and today consumes it itself, calling
`create_item` (`member-portal/wrangler.jsonc:44-62`, `-sandbox` variants at :120-136). Keep the
producer in `member-portal`; move the **consumer** to a Worker bound to the Staff sync token, so
the deployed portal holds only the read-only `PortalToken` binding. *(left to the builder: a small
new consumer Worker, or adding the consumer to an existing staff-side Worker; keep
`max_concurrency: 1`, `max_retries: 100` and the DLQ.)* The message body is the contract between
the two: validate it on the consumer side, since it originates from an internet-facing Worker.

Check whether the `member-portal-letter-emails` consumer writes to Monday (for example a status
column after sending). If it does, it moves the same way; if it only reads and sends email, it
stays.

### Consent flow (once per app per environment, and after any revocation)

The broker's only public routes: `GET /oauth/start/:app`, `GET /oauth/callback`, `GET /health`.

1. An operator, **logged into Monday as SVBC Integrations** (or Sandbox Integration for the
   sandbox broker), opens `/oauth/start/:app`.
2. The broker generates `state` and a PKCE verifier (S256, required by the 2.1 flow), stores them
   short-lived, and redirects to Monday's authorize URL with the app's scopes and the account
   `subdomain` pinned.
3. `/oauth/callback` checks `state`, exchanges the code with the verifier, then calls `me` with
   the new token and **refuses to store it unless the user id matches the configured SVBC
   Integrations id** (anti-goal: wrong user). On mismatch it revokes the token
   (`POST https://auth.monday.com/oauth_ms/oauth/revoke`) and shows an error.
4. Success page shows app, user, scopes granted, and expiry — never the token.

Protecting `/oauth/start`: *(left to the builder)* — Cloudflare Access on the broker's hostname,
or a one-time operator secret. The user-id check above is the backstop either way.

### Webhooks

Monday webhooks here are either UI automation recipes or created by
`donation-rollups/scripts/setup-webhooks.mjs`. Both stay owned by a **human admin**, not an app:
webhooks created through an app's token may be removed when the app is uninstalled (anti-goal).
Receivers keep their existing shared-secret checks; nothing about inbound webhooks changes.

## Environments and rollout

- **Order over the weekend** *(design-author's call)*: broker and shared-client change first;
  then `donation-rollups`, which the runbook deploys first after the load; then
  `report-digests`, which must be live before Monday 08:00; then the rest, with the portal's
  change-request consumer move last. If a Worker's runbook deploy step arrives before its broker
  move has passed sandbox QA, that Worker's deploy waits; it does not fall back to a personal
  token.
- **Sandbox first** *(design-author's call)*: deploy `monday-auth --env sandbox`, authorize the
  three apps as Sandbox Integration, move sandbox Workers over, run each Worker's existing sandbox
  verification, and `scripts/check-monday-token-scope.mjs` (it needs a token; give it a way to
  run through the broker without printing one — left to the builder). The sandbox README rule
  "every sandbox token comes from Sandbox Integration" still holds; the token just arrives via the
  broker.
- **Production, as cutover step 0.4**: create SVBC Integrations (CRM member + WM), deploy
  `monday-auth`, enter the apps' client ids/secrets, install the apps in the account, authorize
  each as SVBC Integrations. Production Workers deploy already bound to the broker. Runbook,
  deploy checklist, #78, and the root README's token policy are updated to match (private repo
  docs `23`, `25`, `migration-plan.md`).
- **Manual by design** (a human, in the Monday and Cloudflare UIs): creating the user, creating the
  three apps in the Developer Center (with the **New OAuth Flow** toggle), copying client
  secrets into `wrangler secret put`, and clicking through consent.

## Constraints

- Hono + TypeScript + D1, `wrangler secret put`, SVBC's Cloudflare account (root README).
- The 12 `graphql.ts` copies must stay byte-identical (CI).
- Tests never touch Monday or `auth.monday.com`.
- The broker must not log tokens, and no response body may contain one.

## Left to the builder

- Exact D1 schema, lease timeout, and refresh margins (within the calls above).
- How `/oauth/start` is protected.
- How the scope-check script runs through the broker.
- Whether production and sandbox share the three apps or each gets its own set (depends on
  verification item 5).
- Order of moving Workers over in sandbox.

## Documentation to update

- Root `README.md`, "Least-privilege Monday tokens": replace per-user tokens with the broker, and
  state the accepted `member-portal` read exposure plainly.
- Each in-scope Worker's README: secrets table (`MONDAY_API_TOKEN` → service binding).
- Private repo: `docs/23` step 0.4, `docs/25`, `migration-plan.md` seats table (CRM 9/10 → 7/10),
  issue #78, and #19 (folds into the Staff sync app).
