# Environments

There are two environments, **production** and **sandbox**, plus your laptop. The sandbox
exists so you can test a change against real services without touching donors, real email or
production boards. Design:
[`docs/superpowers/specs/2026-09-18-sandbox-environment-design.md`](../superpowers/specs/2026-09-18-sandbox-environment-design.md).

## How the split works

Every deployed Worker has a `sandbox` Wrangler environment: an `env.sandbox` block in its
`wrangler.jsonc`. `svbc-calendars`' sandbox is different: it only isolates its cache and
analytics, and it doesn't follow the rest of this chapter. `member-portal`'s writer has one too, in
`wrangler.writer.jsonc`.

| | Production | Sandbox |
|---|---|---|
| Deploy command | `npm run deploy` (`wrangler deploy`) | `npm run deploy:sandbox` (`wrangler deploy --env sandbox`) |
| Worker name | `svbc-<worker>` | `svbc-<worker>-sandbox` |
| Config file | `config/svbc.json` | `config/sandbox.json` |
| `ENVIRONMENT` var | unset or `production` | `sandbox` |
| D1, queues, KV, R2 | Their own | Their own, with names suffixed `-sandbox` |
| Write switch namespace | `FLAGS` | `sandbox-FLAGS` |
| Monday broker | `svbc-monday-auth` (SVBC Integration) | `svbc-monday-auth-sandbox` (Sandbox Integration) |
| Monday boards | Production workspaces (e.g. Donors & Contacts) | The CRM Sandbox workspace |
| Email | Real recipients | Only `sandbox@bikesiliconvalley.org` |
| Alerts | Slack, Workers Issues automations | None |
| Crons | On | Off (`crons: []` in every sandbox) to save cost; run handlers by hand |

Wrangler doesn't let an environment inherit **bindings** (vars, D1, queues, KV, services, email,
secrets) from the top level, so a sandbox deployment can't pick up a production binding by
accident. It does inherit some keys, such as routes, triggers, limits and observability. A new
`env` block must set `routes: []` explicitly, or its first deploy can take over production's
custom domain. Appendix A shows each environment's resolved values.

### Choosing the config at runtime

Each Worker's `src/environment.ts` reads `env.ENVIRONMENT` and picks `config/svbc.json` or
`config/sandbox.json`, validating it once per isolate. An unknown value throws.
`monday-backup` names its files `config/backup.json` and `config/backup.sandbox.json`.
`monday-auth` has no config directory.

### What stops the sandbox reaching production

The Monday token **doesn't**. Sandbox Integration can see most of the account's Main boards,
because Monday shows every Main board in open workspaces to every member. The guards are:

1. **Separate configs, checked by a test.** `config/split.test.ts` in each Worker fails if
   `svbc.json` and `sandbox.json` share any board id, column id, audience, address or other
   sink.
2. **No shared bindings.** Separate D1, queues, KV namespaces and secrets.
3. **Platform email allowlist.** The sandbox `send_email` binding can only deliver to the sandbox
   sink. Code also rewrites the subject to `[sandbox → original recipient]`.
4. **Separate vendor sandboxes** where the vendor has one: a separate Mailchimp audience and
   Intuit's sandbox company.

When you change a config, keep the two files from sharing anything. If a split test fails, don't
"fix" it by weakening the test.

## The sandbox Monday workspace

The sandbox boards live in the **CRM Sandbox v4** workspace (`18210301`) in the same Monday
account. Some sandbox configs still name boards in an older "(sandbox v3)" workspace. The root
README's status table notes which. Sandbox data is synthetic or scrubbed, so treat it as test
data.

The sandbox Funraise and Eventbrite webhooks point at the sandbox Workers' `workers.dev` URLs.
Sandbox Mailchimp traffic goes to the "SVBC Sandbox" audience.

## Testing a change in the sandbox

1. Merge the change to `main` through a pull request. You can also test from a branch, but then
   the sandbox runs unmerged code.
2. Deploy the sandbox by hand. Merging doesn't deploy sandbox Workers
   ([chapter 6](06-ci-and-deploy.md#what-deploys-when)):

   ```sh
   cd <worker>
   npm ci
   npx wrangler d1 migrations apply svbc-<worker>-sandbox --env sandbox --remote   # if migrations changed
   npm run deploy:sandbox
   ```

3. Make sure the Worker's sandbox write switch is `on`:
   `node scripts/flags.mjs status --env sandbox`.
4. Exercise it. Some ways to do that:
   - trigger the vendor's test webhook;
   - change an item on a sandbox board;
   - call a cron handler on demand, through the Worker's operator route or with
     `npx wrangler dev --remote --test-scheduled --env sandbox`, which runs against the real
     sandbox bindings, and then `curl "http://localhost:8787/__scheduled?cron=<url-encoded cron>"`.
5. Watch it with `npx wrangler tail svbc-<worker>-sandbox` in another terminal.
6. Walk through the Worker's staff test script in [`docs/uat/`](../uat/README.md) if the change is
   visible to staff.

## Local development

`npm run dev` runs a Worker on your laptop with simulated D1, queues and KV (Miniflare). It
reads secrets from `<worker>/.dev.vars`, which is gitignored.

> **Careful:** `npm run dev` uses the **production** config. If `.dev.vars` holds real secrets,
> local runs write to production sinks. Use `npm run dev:sandbox` (`wrangler dev --env sandbox`)
> unless you specifically need production behavior.

Tests (`npm test`) never touch real services. They run in workerd with simulated bindings and
fake Monday responses.
