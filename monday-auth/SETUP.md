# monday-auth setup cheat sheet

The one-time Monday and Cloudflare steps a person does by hand: an agent never creates accounts
or handles client secrets or tokens. Step 1 creates the production integration user (the sandbox
already has **Sandbox Integration**). Steps 2 and 3 are done per environment (sandbox first, then production at cutover step 0.4):
each environment has its own three apps.

Monday's Developer Center labels below come from Monday's docs and may differ slightly on screen.
If a label doesn't match, look for the nearest equivalent and note it here.

## 1. The integration user (production, once)

Production's user, **SVBC Integration** (user id `120827741`), already exists (created
2026-10-30); this step is for rebuilding it.

- [ ] Admin → Users → Invite: **SVBC Integration**, on an address you control
      (e.g. `integrations@bikesiliconvalley.org`).
- [ ] Accept the invite and set its password (store it in the password manager, not here).
- [ ] Seats: **CRM member** and **Work Management member** (the backup reads every workspace).
- [ ] Note its **user id** (open its profile; the number in the URL). It isn't secret — send it
      over so it can go in `wrangler.jsonc` as production `EXPECTED_USER_ID`.

> **Never create a personal API token for SVBC Integration**, and if one exists, never use it.
> Like every Monday user, it has a personal token under avatar → **Developers** → **My access
> tokens**; nobody should ever open that page as this user. That token is unscoped and never
> expires, so it would undo everything the broker's scoped, expiring app tokens buy. Operator
> scripts (`MONDAY_API_TOKEN=…` in the runbook) use the operator's **own** personal admin token,
> and Workers get theirs from the broker. If a personal token was ever generated for this user,
> regenerate it there (which invalidates the old one) and don't record the new one.

## 2. Three OAuth apps per environment

Sandbox and production each need their **own** three apps. An app authorized by the other
environment's integration user fails: on 2026-10-31 Sandbox Integration got Monday's "Invalid
scope / Requested scopes are not authorized for this app" page authorizing the production apps,
while SVBC Integration could authorize them fine. Three separate sandbox apps, created in the
same `bikesiliconvalley` account (the sandbox is a workspace, not a separate account), worked.

Do this logged in as **yourself** (an admin), so the apps are owned by the account, not by the
integration user. Developer Center: avatar menu → **Developers** → **Create app**. Repeat the
whole step for each environment, naming the sandbox set with a `(sandbox)` suffix.

| Production app name | Sandbox app name | Key | Scopes (exactly these, nothing else) |
|---|---|---|---|
| `SVBC Portal` | `SVBC Portal (sandbox)` | `portal` | `boards:read`, `me:read` |
| `SVBC Staff Sync` | `SVBC Staff Sync (sandbox)` | `sync` | `boards:read`, `boards:write`, `updates:write`, `assets:read`, `users:read`, `notifications:write`, `docs:write`, `me:read` |
| `SVBC Read-only` | `SVBC Read-only (sandbox)` | `readonly` | `boards:read`, `updates:read`, `assets:read`, `docs:read`, `users:read`, `workspaces:read`, `me:read` |

`me:read` is needed for the consent user check (the callback queries `me`).

For **each** app (six in all, three per environment):

- [ ] **Create app** → the name from the table for this environment.
- [ ] **OAuth & Permissions → Scopes**: tick exactly the scopes in its row.
- [ ] **OAuth & Permissions → Redirect URLs**: add only this environment's callback:
  - sandbox apps: `https://svbc-monday-auth-sandbox.svbc-account.workers.dev/oauth/callback`
  - production apps: `https://svbc-monday-auth.svbc-account.workers.dev/oauth/callback`
- [ ] Turn on the **New OAuth Flow** (OAuth 2.1). It's set per version: create a **draft
      version**, turn the toggle on in that draft, then **promote it to live**. Without it,
      Monday issues the old never-expiring tokens and refreshes fail.
- [ ] **Install** the app in the SVBC account.
- [ ] Leave the **Client ID** and **Client Secret** where they are (Basic information). Don't
      paste them into chat, an issue, or this file; step 3 copies them straight into Cloudflare.

Adding a scope to an app later (as `docs:write` was for `sync`) means **re-consenting that app**:
update the scope list in the Developer Center and in `src/apps.ts`, then re-run its
`/oauth/start/<app>` as the integration user. Existing tokens keep the old scopes until then.

## 3. Secrets and consent (per environment)

Waits until the broker is deployed (plan Task 6 for sandbox; cutover step 0.4 for production).
Run from `monday-auth/`; drop `--env sandbox` for production. The client ids and secrets come
from **that environment's** apps (step 2), never the other environment's. Each command prompts
for the value without echoing it.

```sh
npx wrangler secret put PORTAL_CLIENT_ID --env sandbox
npx wrangler secret put PORTAL_CLIENT_SECRET --env sandbox
npx wrangler secret put SYNC_CLIENT_ID --env sandbox
npx wrangler secret put SYNC_CLIENT_SECRET --env sandbox
npx wrangler secret put READONLY_CLIENT_ID --env sandbox
npx wrangler secret put READONLY_CLIENT_SECRET --env sandbox
npx wrangler secret put START_KEY --env sandbox          # e.g. `openssl rand -hex 32`; keep it in the password manager
npx wrangler secret put SLACK_WEBHOOK_URL --env sandbox  # optional; see below
```

`SLACK_WEBHOOK_URL` is optional: without it, "needs consent" alerts only reach the Worker's logs.
Fine for sandbox; **required before production**. SVBC's production `monday-auth`, `monday-backup`
and `mailchimp-sync` share one webhook to a private staff channel (set 2026-11-04). A fork creates
one Slack app, *SVBC Integration Alerts*, from
[`slack-app-manifest.yml`](slack-app-manifest.yml) (api.slack.com/apps → Create New App → From a
manifest), then adds a webhook for `#crm-sandbox` and one for the production alerts channel
(Incoming Webhooks → Add New Webhook to Workspace), and uses them for those Workers.

Then, in a private browser window **logged into Monday as the right user** — **Sandbox
Integration** for sandbox, **SVBC Integration** for production — open each of these and click
Authorize (production: same paths on `svbc-monday-auth.svbc-account.workers.dev`):

- [ ] `https://svbc-monday-auth-sandbox.svbc-account.workers.dev/oauth/start/portal`
- [ ] `…/oauth/start/sync`
- [ ] `…/oauth/start/readonly`

Each page asks for `START_KEY` (paste it from the password manager) and posts it; the key never
goes in the URL, where Workers Logs and browser history would keep it.

Each should end on a page naming the app, the Monday user and the scopes. A "wrong user" page
means you were logged in as someone else: the token was revoked and nothing was stored; switch
users and try again.

- [ ] Check: `https://svbc-monday-auth-sandbox.svbc-account.workers.dev/health` shows all three
      apps `ok`, and `"alerts": "configured"` once `SLACK_WEBHOOK_URL` is set (required in
      production).

## If something goes wrong later

- **Slack alert "needs consent"** for an app: Monday rejected its refresh token (app uninstalled,
  user deactivated, or token revoked). Re-run that app's `/oauth/start/<app>` as the integration
  user. Workers' queues hold their writes and retry meanwhile.
- **Slack alert "rejected the … app's client credentials"** (`invalid_client` /
  `unauthorized_client`): the client id or secret in Cloudflare doesn't match the Developer
  Center (a rotated or mis-pasted secret), or the app was uninstalled. Fix the secret with
  `wrangler secret put`, or re-install and re-run consent. The stored token keeps being handed out
  until it expires, so this is urgent but not yet an outage.
- **Slack alert "token refresh keeps failing"**: refreshes have failed for hours (Monday auth
  outage, network) and under 6 hours are left on the stored token. Check `wrangler tail` and
  `/health` (`lastRefreshErrorAt`). When it expires, every Worker on that app fails until a
  refresh succeeds; their queues retry.
- **Rotate a client secret**: regenerate it in the Developer Center, `wrangler secret put` the new
  value, then re-run consent for that app.
- **Cut off an app entirely**: uninstall it from the account. Every Worker on that app stops
  getting tokens at once.
