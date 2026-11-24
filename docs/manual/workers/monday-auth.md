# monday-auth

[Appendix A](../reference/monday-auth.md) lists this Worker's routes, crons, queues, storage and bindings.

`monday-auth` is the Monday OAuth token broker. It deploys as `svbc-monday-auth` (production) and
`svbc-monday-auth-sandbox` (sandbox), reached at `svbc-monday-auth.svbc-account.workers.dev` and
`svbc-monday-auth-sandbox.svbc-account.workers.dev`. It has no custom domain. It is the source of
Monday access for every other Worker: it exposes the `PortalToken`, `SyncToken` and
`ReadOnlyToken` entrypoints over service bindings, and uses none itself.

## What it does

It holds the tokens for SVBC's three Monday OAuth apps (Portal, Staff sync, Read-only), all
authorized by one integration user (SVBC Integration in production, Sandbox Integration in the
sandbox). It keeps those tokens fresh and hands them to other Workers. If it stops, or an app
loses consent, every Worker on that app stops reading or writing Monday: gifts stop reaching
the Donations board, rollups go stale, and the donor portal cannot load donor data.

## Trigger and data flow

### Token requests (service binding RPC)

1. A consumer Worker calls `env.MONDAY_AUTH.token()` on its bound entrypoint. The entrypoint
   decides the app: `PortalToken` → `portal`, `SyncToken` → `sync`, `ReadOnlyToken` → `readonly`.
   The root README and [`monday-auth/README.md`](../../../monday-auth/README.md) list which Worker
   binds which.
2. The broker reads the app's row from D1 (`oauth_tokens`) and returns the access token. Tokens
   are stored encrypted (AES-256-GCM, `enc:v1:` prefix). Older plaintext rows still read and are
   encrypted on their next refresh.
3. A consumer that gets a 401 calls `token(rejected)` with the bad token. The broker then forces a
   refresh.
4. Only this Worker refreshes. Monday rotates refresh tokens on each use, so a D1 lease plus
   compare-and-swap ensures exactly one refresh at a time.

No route returns a token over HTTP.

### Cron, every 30 minutes (`*/30 * * * *`, production only)

- Refreshes any app whose token has under 8 hours left. Tokens last about 24 hours.
- Deletes abandoned consent rows from `oauth_pending`.
- If either step fails, it logs the cause and the invocation fails, so it shows as an error in
  the Worker's cron events.

Sandbox crons are disabled to save cost. Any `token()` call also refreshes a token with under
10 minutes left, so the sandbox still works on demand; run the scheduled handler by hand when
testing it.

### HTTP routes

| Route | Purpose |
|---|---|
| `GET /health` | Per app: `ok`, `needs_consent` or `missing`; plus whether Slack alerts are configured. Unauthenticated, so it shows no tokens or times. |
| `GET`/`POST /oauth/start/:app` | Consent flow. Form asks for `START_KEY`, then redirects to Monday (PKCE S256). |
| `GET /oauth/callback` | Exchanges the code. Refuses, and revokes, a token from any user other than `EXPECTED_USER_ID`. |
| `GET`/`POST /oauth/probe/:app` | Scope check report. 404 unless `PROBE_ENABLED` is exactly `true`. |
| `POST /oauth/webhooks/:app` | Creates, lists or deletes app-owned Monday webhooks. 404 unless `WEBHOOKS_ENABLED` is exactly `true`. A `create` URL must sit under a `WEBHOOK_URL_PREFIXES` entry. |

`POST /oauth/*` is rate-limited to 10 attempts a minute per client IP. The limiter fails open; the
`START_KEY` check is the gate.

### D1 tables

- `oauth_tokens`: one row per app; encrypted access and refresh tokens, expiry, and
  refresh-failure times (no error text).
- `oauth_pending`: in-flight consent state (PKCE verifier, redirect URI).

## Monday boards and columns

None. It reads no boards. It calls `auth.monday.com` for token exchange and the `me` query to
check the consenting user. The scopes of each app are defined in
[`src/apps.ts`](../../../monday-auth/src/apps.ts) and must match the Monday Developer Center
exactly:

| App | Scopes |
|---|---|
| `portal` | `boards:read`, `me:read` |
| `sync` | `boards:read`, `boards:write`, `updates:write`, `assets:read`, `users:read`, `notifications:write`, `docs:write`, `webhooks:read`, `webhooks:write`, `me:read` |
| `readonly` | `boards:read`, `updates:read`, `assets:read`, `docs:read`, `users:read`, `workspaces:read`, `me:read` |

The `portal` token can read every board the integration user can see, not only the boards the
portal shows. This is an accepted risk. Keep the integration user off private boards it does not
need. See [Accounts and access](../03-accounts-and-access.md).

## Secrets

Set with `npx wrangler secret put NAME [--env sandbox]`. Sandbox and production have separate
sets of three apps, so each environment has its own values.

| Name | Purpose | Issued by | Rotate |
|---|---|---|---|
| `PORTAL_CLIENT_ID`, `PORTAL_CLIENT_SECRET` | Portal app credentials | Monday Developer Center, Portal app | Regenerate the secret, `wrangler secret put`, then re-run consent for `portal` |
| `SYNC_CLIENT_ID`, `SYNC_CLIENT_SECRET` | Staff sync app credentials | Monday Developer Center, Staff sync app | Same, for `sync` |
| `READONLY_CLIENT_ID`, `READONLY_CLIENT_SECRET` | Read-only app credentials | Monday Developer Center, Read-only app | Same, for `readonly` |
| `START_KEY` | Operator key for `/oauth/start`, `/oauth/probe`, `/oauth/webhooks`. At least 32 characters (`openssl rand -hex 32`); a shorter key is refused | Generated by the operator; belongs in Secret Manager ([not set up yet](../03-accounts-and-access.md#where-secret-values-live-secret-manager)) | `wrangler secret put` a new value; nothing else depends on it |
| `TOKEN_ENC_KEY` | AES-256-GCM key for the token columns in D1 (`openssl rand -base64 32`) | Generated by the operator; different per environment | Changing or losing it means re-running consent for all three apps. Set it before deploying any build that reads it |
| `SLACK_WEBHOOK_URL` | Alert channel. Required in production (`/health` must show `"alerts": "configured"`); optional in sandbox | Slack app incoming webhook (manifest: [`slack-app-manifest.yml`](../../../monday-auth/slack-app-manifest.yml)) | Issue a new webhook URL in Slack, `wrangler secret put` |

Non-secret vars in `wrangler.jsonc`: `EXPECTED_USER_ID` (the integration user's Monday id),
`MONDAY_SUBDOMAIN`, `PROBE_ENABLED`, `WEBHOOKS_ENABLED`, `WEBHOOK_URL_PREFIXES`, `ENVIRONMENT`.

## Write switch

No write switch. The broker writes nothing to Monday, and holding it would stop every other
Worker at once. To stop Workers writing, use each Worker's own switch
([Operations](../07-operations.md)). To cut off an app entirely, uninstall it from the Monday
account.

## Failure modes

Alerts go to `SLACK_WEBHOOK_URL` once per state change, never with a token or Monday's response
body.

| Symptom | Cause | What to do |
|---|---|---|
| Slack "needs consent"; `/health` shows `needs_consent` | Monday returned `invalid_grant`: app uninstalled, integration user deactivated, or token revoked | Log in to Monday as the integration user in a private window, open `/oauth/start/<app>`, enter `START_KEY`, authorize. Consumer queues hold and retry meanwhile |
| Slack "rejected the … app's client credentials" | `invalid_client` / `unauthorized_client`: wrong or rotated client secret, or app uninstalled | Fix the secret with `wrangler secret put`, or reinstall the app and re-run consent. Urgent: the stored token works only until it expires |
| Slack "token refresh keeps failing" | Refresh failures (Monday auth outage, network, 5xx) with under 6 hours left on the token | Check `npx wrangler tail` and Monday status. When the token expires, every consumer of that app fails until a refresh succeeds; queues retry |
| Cron event shows an error | A refresh or purge failed in the scheduled run | Read the logged cause in Workers Logs |
| Every consumer fails at once; `/health` shows `missing` | No token stored for that app (for example, a new environment) | Run consent for the app |
| All token reads and writes fail after a deploy | `TOKEN_ENC_KEY` not set in that environment | Set it, redeploy |
| Consent ends on a "wrong user" page | Logged in to Monday as someone other than the integration user | The token was revoked and nothing stored. Switch users and retry |
| A consumer gets "missing required scopes" | App lacks a scope it now needs | Add the scope in the Developer Center and in `src/apps.ts`, deploy, re-consent that app. Old tokens keep old scopes |
| `/oauth/webhooks` refuses a create | URL is outside `WEBHOOK_URL_PREFIXES` | Add the Worker's `/webhooks/monday/` prefix to the var for that environment |
| `delete_webhook` returns `null` | Monday lets only a webhook's creator delete it | Delete it with the token that created it |

## Operator scripts

This Worker has no `scripts/` directory. Operator actions are HTTP routes:

- **Run or re-run consent** for an app: open `https://<host>/oauth/start/<app>` (`portal`, `sync`,
  `readonly`) as the integration user and enter `START_KEY`.
- **Check health:** `curl -s https://svbc-monday-auth.svbc-account.workers.dev/health`.
- **Measure an app's real scope:** deploy once with the probe on, run it, redeploy to turn it off:
  ```sh
  npx wrangler deploy --var PROBE_ENABLED:true   # add --env sandbox for sandbox
  # open /oauth/probe/<app>, enter START_KEY and a workspace id (optional board id)
  npm run deploy                                 # restores PROBE_ENABLED=false
  ```
- **Register app-owned webhooks:** deploy with
  `npx wrangler deploy [--env sandbox] --var WEBHOOKS_ENABLED:true`, run
  `donation-rollups/scripts/setup-webhooks.mjs` and
  `people-reclassification/scripts/setup-promote.mjs` with `MONDAY_AUTH_URL` and `START_KEY` set,
  then redeploy normally. The broker allows 10 calls a minute, so the scripts wait out 429s.
- **Check what a token can reach:** `node scripts/check-monday-token-scope.mjs --workspace <id>`
  from the repo root.

## Changing it

Key files: [`src/index.ts`](../../../monday-auth/src/index.ts) (entrypoints, cron),
[`src/broker.ts`](../../../monday-auth/src/broker.ts) (refresh, lease, alerts),
[`src/apps.ts`](../../../monday-auth/src/apps.ts) (scopes),
[`src/routes.ts`](../../../monday-auth/src/routes.ts),
[`src/tokenStore.ts`](../../../monday-auth/src/tokenStore.ts),
[`src/tokenCipher.ts`](../../../monday-auth/src/tokenCipher.ts),
[`src/webhooks.ts`](../../../monday-auth/src/webhooks.ts).

Gotchas:

- **Deploys are by hand.** CI runs tests and typecheck but has no sandbox deploy job for this
  Worker, because D1 migrations must be applied before the code that needs them. Per environment,
  migrate, then deploy:
  ```sh
  npx wrangler d1 migrations apply svbc-monday-auth-sandbox --env sandbox --remote
  npm run deploy:sandbox
  npx wrangler d1 migrations apply svbc-monday-auth --remote
  npm run deploy
  ```
- Turn on `PROBE_ENABLED` or `WEBHOOKS_ENABLED` with a command-line `--var` for one deploy, never
  by editing `wrangler.jsonc`. Confirm afterward that the route returns 404.
- A new consumer Worker binds an entrypoint (`MONDAY_AUTH` service binding) rather than holding
  a `MONDAY_API_TOKEN`. The `monday-auth-bindings` CI step checks the mapping.
- A scope change needs the Developer Center, `src/apps.ts` and a re-consent to agree.

Tests and checks: `npm test` (never touches Monday), `npm run typecheck`.

## Further reading

- [`monday-auth/README.md`](../../../monday-auth/README.md): routes, alerts, probe and webhook procedures.
- [`monday-auth/SETUP.md`](../../../monday-auth/SETUP.md): first-time setup of the integration user, apps, secrets and consent.
- [Design spec](../../superpowers/specs/2026-10-30-monday-oauth-broker-design.md).
- Root README: [Webhook secrets in the URL](../../../README.md#webhook-secrets-in-the-url-secret) and Monday's signed webhook JWT.
- [Architecture](../02-architecture.md), [Accounts and access](../03-accounts-and-access.md), [Troubleshooting](../08-troubleshooting.md).
