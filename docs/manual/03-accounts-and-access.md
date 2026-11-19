# Accounts and access

This chapter lists every account the system depends on: what it's used for, the role that
administers it, and where its credentials go. Who holds each role, and where each secret value
is stored, is in the **private appendix** ([chapter 0](00-about.md#whats-public-and-what-isnt)).

## Principles

- **Least privilege, by design.** Workers never use a person's credentials. Monday access goes
  through the broker's OAuth apps ([chapter 2](02-architecture.md#monday-access-the-token-broker)).
  Other vendors' keys are issued to SVBC's account and stored only as Cloudflare Worker secrets.
- **Secrets live in two places only:** as Cloudflare Worker secrets (`npx wrangler secret put`),
  and as values in the password manager. Operators also keep local `.env` files at the repo root,
  which are gitignored: `.env` (dev), `.env.sandbox` and `.env.production`. These hold the
  operator's own personal tokens for running scripts. Never commit a secret, paste one into an
  issue or chat, or log one.
- **Production and sandbox have separate credentials** for every service that has a sandbox. No
  secret is shared between environments.
- **Rotate on departure.** When someone with admin access leaves:
  - remove them from each console below;
  - rotate any secret they could have read, which includes every webhook secret if they could
    read Worker logs;
  - re-check Cloudflare's member list.

## Cloudflare

| What | Detail |
|---|---|
| Account | "SVBC Account", id `f323cb191edeb5d30acc4d289427a010` (public in every `wrangler.jsonc`) |
| Plan | Workers Paid; the zone is on Business through Project Galileo |
| Zone | `bikesiliconvalley.org`: Worker custom domains, Email sending, Access, WAF |
| `workers.dev` subdomain | `svbc-account.workers.dev` (e.g. `https://svbc-monday-auth.svbc-account.workers.dev`) |
| Admin role | **Cloudflare Super Administrator**. As of this writing every member holds this role, and there are no read-only members. |
| Used by | Every Worker; `scripts/flags.mjs`; deploys |

Things to know:

- **Log access equals webhook-secret access** (secrets are in URLs, see
  [chapter 2](02-architecture.md#webhook-secrets-in-the-url)). Don't add a member with Workers
  observability or Log Share access unless they could rotate secrets anyway. Never mint an API
  token with those permissions for a third party.
- **Your own access from a terminal:** run `npx wrangler login`, which opens a browser to sign
  in, then `npx wrangler whoami`. Wrangler stores an OAuth token in your user profile.
- **API tokens in use:**
  - `sync-watchdog` holds a `CLOUDFLARE_API_TOKEN` to read queue backlogs and cron history. It
    is an account token with only Account Analytics Read and Queues Read.
  - The two Workers Builds connections (`svbc-calendars`, `monday-backup`) use a build token
    Cloudflare created, named "svbc-events-widgets build token".
  - GitHub's optional `CLOUDFLARE_API_TOKEN` for sandbox deploys is **not set** (see
    [chapter 6](06-ci-and-deploy.md)).
- **Cloudflare Access** protects the staff-only Workers (`member-map`, `nearby-search`). Each has
  an Access application in Zero Trust → Access → Applications, allowing SVBC staff email
  addresses. The Worker also verifies the Access JWT itself (`access.aud` and `access.teamDomain`
  in its config).
- **WAF / Super Bot Fight Mode.** The zone challenges non-browser clients. Calendar apps polling
  `.ics` feeds and vendors posting webhooks to a custom domain would be blocked, so a WAF custom
  rule skips SBFM for those paths. **Any new custom-domain route that serves non-browser clients
  must be added to that rule** (see [`svbc-calendars/README.md`](../../svbc-calendars/README.md),
  Deploy step 7). Routes on `*.workers.dev` aren't affected.
- **Billing alert:** Manage account → Notifications → "Billing Budget Alert", $10 a month.
- **Email sending** (`send_email` bindings) from `member-portal`, `bp-feedback-notify` and
  `report-digests` uses Cloudflare Email Routing on the zone. Sandbox bindings may send only to
  `sandbox@bikesiliconvalley.org` (`allowed_destination_addresses` in `wrangler.jsonc`).

## GitHub

| What | Detail |
|---|---|
| Repository | `github.com/Silicon-Valley-Bicycle-Coalition/monday-workers` (public, MIT) |
| Private repo | `Silicon-Valley-Bicycle-Coalition/monday-migration` (migration plan, private appendix) |
| Admin role | **GitHub organization owner** |
| Branch protection | A ruleset on `main` requires a pull request and the `ci-ok` and `checks` status checks, and forbids force-pushes |
| Actions secrets | `sandbox` environment (restricted to `main`): `CLOUDFLARE_API_TOKEN`, currently unset |
| History | GitLab (`gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers`) is the read-only record before 2026-11-17. `GL#NN` in files means a GitLab issue. |

## Monday.com

| What | Detail |
|---|---|
| Account | `bikesiliconvalley.monday.com`, account id `26331880`, Pro plan |
| Workspaces | Production: Donors & Contacts (`18201685`) and others. Sandbox: CRM Sandbox v4 (`18210301`). |
| Admin role | **Monday account admin** |
| Integration users | **SVBC Integration** (production, user `120827741`, CRM and Work Management seats). **Sandbox Integration** (user `117112617`). |
| OAuth apps | Developer Center, owned by an admin: `SVBC Portal`, `SVBC Staff Sync`, `SVBC Read-only`, and the same three with a `(sandbox)` suffix |
| Used by | Every Worker through `monday-auth`; operator scripts with the operator's own token |

Rules:

- **Never create or use a personal API token for an integration user.** It would be unscoped and
  never expire. Operator scripts use the operator's own personal admin token, in
  `MONDAY_API_TOKEN` in the shell or the `.env.*` files.
- **Integration users' email.** Monday emails a user each time they're subscribed to a board.
  Turn off email notifications in the integration user's profile, or filter that subject in its
  mailbox.
- **Board privacy.** Make donor boards **private**. Subscribe SVBC Integration only to the
  private boards its Workers need. Subscribe Sandbox Integration to no production board.
- **Signing secrets.** Each app has a Signing Secret (Developer Center → app → Basic
  Information). It is different from the OAuth client secret. `donation-rollups` and
  `people-reclassification` hold the Staff sync app's as `MONDAY_SIGNING_SECRET`.
- Setup, consent and re-consent: [`monday-auth/SETUP.md`](../../monday-auth/SETUP.md).

## Vendor accounts

| Service | Used by | Credentials (Worker secret names) | Issued where | Sandbox |
|---|---|---|---|---|
| Funraise | `funraise-sync` | `FUNRAISE_WEBHOOK_SECRET` (our URL secret), `FUNRAISE_API_KEY` | Funraise admin → integrations / webhooks (**To verify** menu path) | Same Funraise account, separate webhook to the sandbox Worker |
| Eventbrite | `eventbrite-sync`, `svbc-calendars` | `EVENTBRITE_PRIVATE_TOKEN`, `EVENTBRITE_WEBHOOK_SECRET` (URL secret); `svbc-calendars`: `EVENTBRITE_TOKEN` | Eventbrite → Account settings → Developer links → API keys | Same organization, separate webhook |
| Mailchimp | `mailchimp-sync` | `MAILCHIMP_API_KEY`, `MAILCHIMP_WEBHOOK_SECRET`, `MONDAY_WEBHOOK_SECRET` | Mailchimp → Profile → Extras → API keys | Separate "SVBC Sandbox" audience; the sandbox key may write only there |
| Double the Donation | `dtd-sync` | `DTD_PRIVATE_KEY` | DTD dashboard (**To verify** menu path) | **To verify** whether DTD offers a test key |
| Benevity | `benevity-import` | `BENEVITY_WEBHOOK_SECRET` (URL secret for the Monday webhook) | No API. Staff download the report from the Benevity Causes portal and upload it to Monday. | n/a |
| Google Workspace | `monday-backup` | `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`, `BACKUP_ENCRYPTION_KEY`; var `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Google Cloud console → IAM → Service accounts → Keys. The account is a **Contributor** member of the backup Shared Drive. | Separate Drive folder (not yet configured) |
| Slack | `monday-auth`, `monday-backup`, `mailchimp-sync`, `svbc-calendars`, `sync-watchdog`; Workers Issues | `SLACK_WEBHOOK_URL` (an incoming webhook into the private staff channel) | Slack app → Incoming Webhooks (**To verify** which Slack app owns them) | Mostly unset; sandbox Workers don't alert |
| Intuit QuickBooks | `quickbooks-sync` (postponed) | `QB_CLIENT_ID`, `QB_CLIENT_SECRET`, `QB_WEBHOOK_VERIFIER_TOKEN`, `QB_TOKEN_ENCRYPTION_KEY` | Intuit Developer portal | Intuit sandbox company |
| Box | Nobody in code | — | — | — |

Each Worker chapter lists its own secrets, including internal ones such as `START_KEY`,
`TOKEN_ENC_KEY`, `CUSTODIAN_SECRET`, `DIGESTS_SECRET` and `RECLASSIFY_SECRET`. Operators
generate those (`openssl rand -hex 32`) and no vendor issues them.

## Listing and rotating secrets

```sh
cd funraise-sync
npx wrangler secret list                  # production names (never values)
npx wrangler secret list --env sandbox    # sandbox names
npx wrangler secret put FUNRAISE_API_KEY  # prompts for the new value; takes effect on the next request
```

To rotate a secret, change it at the issuer first if the issuer holds it. Then put the new value
in the Worker, then update the password manager. For URL secrets, also update the URL at the
sender. A secret change applies immediately and needs no deploy.

## Quick access checklist for a new IT person

1. Password manager: access to the SVBC IT vault (see the private appendix).
2. Cloudflare: invited as a member of SVBC Account. Run `npx wrangler login`, then
   `npx wrangler whoami`.
3. GitHub: a member of the `Silicon-Valley-Bicycle-Coalition` organization with write access to
   both repos.
4. Monday: an admin seat for yourself and a personal API token in your `.env.production` and
   `.env.sandbox`. Never use the integration users' tokens.
5. Slack: a member of the private staff alert channel.
6. Google: Manager on the backup Shared Drive, to restore from backups.
7. Vendor consoles (Funraise, Eventbrite, Mailchimp, DTD): admin logins as listed in the private
   appendix.
