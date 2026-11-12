# monday-auth

**Status:** **Production deployed 2026-10-31** at cutover step 0.4 and consented as SVBC Integration
the same day (all three apps `ok`); redeployed 2026-11-04 after migration `0003`, latest
production deploy 2026-11-09 (version `3b31d518`). Sandbox built and verified 2026-10-31. The #104
hardening (`/oauth` rate limit, 32-character `START_KEY` minimum, encrypted token columns, trimmed
`/health`) and the `cpu_ms` limit (#117) are on `main` but not yet deployed to either environment
(as of 2026-11-11 neither has a `TOKEN_ENC_KEY` secret, which that build needs): set it first,
then deploy ("Secrets" below).
First-time setup (the integration user, the OAuth apps, secrets, consent) is in
[`SETUP.md`](SETUP.md). Design and verification results:
[`docs/superpowers/specs/2026-10-30-monday-oauth-broker-design.md`](../docs/superpowers/specs/2026-10-30-monday-oauth-broker-design.md).
**Stack:** Hono + TypeScript + D1, with a Cron Trigger (see `../README.md`'s shared-stack note).

## What it does

One Monday user (SVBC Integration in production, Sandbox Integration in the sandbox) authorizes
three Monday OAuth apps. This Worker holds their client credentials and tokens, is the only thing
that talks to `auth.monday.com`, and hands short-lived access tokens to the other Workers over
service bindings. Nothing returns a token over HTTP. Monday rotates refresh tokens, so exactly one
component may refresh an app's token; this is it (a D1 lease plus compare-and-swap, with a cron
every 30 minutes that refreshes once an app's token has under 8 hours left; tokens last about
24 hours).

Each consumer Worker binds to one entrypoint, so its binding decides which app it can reach:

| Entrypoint | App | Used by |
|---|---|---|
| `PortalToken` | `portal` | `member-portal` |
| `SyncToken` | `sync` | `funraise-sync`, `donation-rollups`, `dtd-sync`, `mailchimp-sync`, `benevity-import`, `eventbrite-sync`, `people-reclassification`, `bp-feedback-notify`, `quickbooks-sync`, `member-portal-writer`, `nearby-search` |
| `ReadOnlyToken` | `readonly` | `monday-backup`, `report-digests`, `member-map` |

Each exposes `token(rejected?)`, which returns the app's current access token (pass the token that
got a 401 as `rejected` to force a refresh).

## The three apps

Defined in [`src/apps.ts`](src/apps.ts); the Developer Center settings must match exactly.

| Key | Scopes |
|---|---|
| `portal` | `boards:read`, `me:read` |
| `sync` | `boards:read`, `boards:write`, `updates:write`, `assets:read`, `users:read`, `notifications:write`, `docs:write`, `me:read` |
| `readonly` | `boards:read`, `updates:read`, `assets:read`, `docs:read`, `users:read`, `workspaces:read`, `me:read` |

`me:read` is on every app because the consent check queries `me`. Sandbox and production use
separate sets of three apps (see `SETUP.md` step 2).

## Accepted risk: the portal's read exposure

**Accepted risk, to be documented where operators will see it:** `member-portal` is
internet-facing, and its token can **read** every board SVBC Integration can see, not only the
ones the portal displays. Accepted because the alternative (its own user) costs a seat.

Measured in the sandbox, a `boards:read` token saw 547 boards, 446 of them outside the sandbox
workspace. Keep the integration user off private boards it doesn't need.

## Consent and re-consent

Consent happens once per app per environment, and again after any revocation or scope change.
When an app's refresh token is rejected (app uninstalled, user deactivated, token revoked) the
Worker marks it `needs_consent` and posts a Slack alert. To fix it, log into Monday as the
integration user in a private window and open `/oauth/start/<app>` on the broker, enter the
`START_KEY`, and click Authorize. The callback refuses any other Monday user: it revokes the token
and stores nothing.

Adding a scope to an app means re-consenting that app; existing tokens keep their old scopes.
Consumers' queues hold their writes and retry in the meantime.

## Alerts

All go to `SLACK_WEBHOOK_URL`, once per state change (not once per failed request or cron run),
and never include a token, secret or Monday's response body:

| Alert | Cause | State |
|---|---|---|
| "needs consent" | `invalid_grant`: the refresh token is dead (app uninstalled, user deactivated, token revoked) | `needs_consent`; consumers fail until consent is re-run |
| "rejected the … app's client credentials" | `invalid_client` / `unauthorized_client`: wrong or rotated client secret, or the app was uninstalled; sent at once, since no retry fixes it | still `ok`; the stored token is handed out until it expires |
| "token refresh keeps failing" | any other refresh failure (Monday outage, network, 5xx) that persists, sent by the cron once under 6 hours are left on the stored token | still `ok`; consumers fail once it expires |

Failure state is in D1 (migration `0003`: times only, no error text) and cleared by the next
successful refresh or consent. A cron run whose refresh failed also logs the cause and then fails
the invocation, so it shows as an error in the Worker's cron events.

## Routes

| Route | Purpose |
|---|---|
| `GET /health` | `{ "alerts": "configured" \| "unconfigured", "apps": [...] }`: whether `SLACK_WEBHOOK_URL` is set (never its value), and per app `ok`, `needs_consent` or `missing`. No tokens, and no expiry or refresh-error times (unauthenticated; #104). Alerts and the cron's logs carry the failure detail. |
| `GET`/`POST /oauth/start/:app` | Key form, then redirect to Monday's authorize URL (PKCE S256). The key is posted, never in the URL. |
| `GET /oauth/callback` | Checks `state`, exchanges the code, verifies the authorizing user id, stores the tokens. |
| `GET`/`POST /oauth/probe/:app` | Verification aid: runs `me`, scope, header-form, `platform_api` and complexity checks with the app's token and returns a report (never the token). An optional numeric `board` field also reads that board by id and reports only `{ "id", "empty" }`, whether the token got nothing back; an error comes back as `{ "ok": false, ... }` and isn't empty. Same key gate; **404 unless `PROBE_ENABLED` is exactly `true`** (off in both environments; turn it on for one deploy while verifying). |

## Secrets and vars

Set with `npx wrangler secret put NAME [--env sandbox]` (values come from that environment's apps):

| Secret | Notes |
|---|---|
| `PORTAL_CLIENT_ID`, `PORTAL_CLIENT_SECRET` | Portal app |
| `SYNC_CLIENT_ID`, `SYNC_CLIENT_SECRET` | Staff sync app |
| `READONLY_CLIENT_ID`, `READONLY_CLIENT_SECRET` | Read-only app |
| `START_KEY` | Operator key for `/oauth/start` and `/oauth/probe`. At least 32 characters (`openssl rand -hex 32`); a shorter key is refused outright. Keep it in the password manager. |
| `TOKEN_ENC_KEY` | AES-256-GCM key (`openssl rand -base64 32`) for the `access_token`/`refresh_token` columns in D1 (`enc:v1:` values, column name bound as associated data; `src/tokenCipher.ts`, from quickbooks-sync). **Set it before deploying** a build that reads it: without it every token read and write fails. Rows written earlier as plaintext still read, and the next refresh or consent encrypts them. Losing the key means re-running consent for each app. Use a different value per environment. |
| `SLACK_WEBHOOK_URL` | The alerts above. Optional in sandbox (alerts then only reach the logs); **required in production**: `/health` must show `"alerts": "configured"`. |

| Var (`wrangler.jsonc`) | Meaning |
|---|---|
| `EXPECTED_USER_ID` | The only Monday user whose consent is accepted (production `120827741`, sandbox `117112617`). |
| `MONDAY_SUBDOMAIN` | `bikesiliconvalley`; pins the account on the authorize URL. |
| `PROBE_ENABLED` | `"true"` turns on `/oauth/probe`; anything else makes it 404. |
| `ENVIRONMENT` | `production` or `sandbox`. |

`POST /oauth/*` is limited to 10 attempts a minute per client IP (the `REQUEST_RATE_LIMITER` binding,
namespaces 2101 production / 2102 sandbox), so `START_KEY` can't be guessed online. The limiter fails open
if it errors; the key check is the gate.

## Commands

Run from `monday-auth/`:

```sh
npm test                                   # vitest; never touches Monday
npm run typecheck                          # wrangler types, then tsc --noEmit
npm run deploy:sandbox                     # wrangler deploy --env sandbox
npm run deploy                             # production
npx wrangler d1 migrations apply svbc-monday-auth-sandbox --env sandbox --remote
npx wrangler d1 migrations apply svbc-monday-auth --remote
```

## Deploying

By hand, on purpose: CI runs the tests and typecheck but has no `deploy-sandbox:monday-auth` job,
because the D1 migrations must be applied before the code that needs them goes out. For each
environment, apply the migrations (above), then deploy. Migration `0003` (refresh-failure state)
must be applied before deploying any version that has it.

## Measuring production scope with the probe

`/oauth/probe` is off in both environments (`PROBE_ENABLED` is `"false"` in `wrangler.jsonc`). To run the
scope check there, turn it on for one deploy from the command line rather than editing the file,
so the next ordinary deploy turns it off again:

1. From `monday-auth/`: `npx wrangler deploy --var PROBE_ENABLED:true` (production; the
   command-line `--var` overrides the file's value for this deploy only).
2. Run the probe: open `https://svbc-monday-auth.svbc-account.workers.dev/oauth/probe/<app>` for
   `portal`, `sync` and `readonly`, enter `START_KEY` and workspace `18201685`, and paste each JSON
   report into the cutover log.
3. `npm run deploy`, which restores `"false"`.
4. Confirm it is off: `curl -s -o /dev/null -w '%{http_code}\n' https://svbc-monday-auth.svbc-account.workers.dev/oauth/probe/portal`
   prints `404`.

To check that an app can't read one private board, also enter its id in step 2's optional board
field. `"board": { "id": "...", "empty": true }` means that app's token got nothing back. The
report never says more about the board than that.

