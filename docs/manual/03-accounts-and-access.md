# Accounts and access

This chapter lists every account the system depends on: what it's used for, the role that
administers it, and where its credentials go. Who holds each role, and where each secret value
is stored, is in the **private appendix** ([chapter 0](00-about.md#whats-public-and-what-isnt)).

## Principles

- **Least privilege, by design.** Workers never use a person's credentials. Monday access goes
  through the broker's OAuth apps ([chapter 2](02-architecture.md#monday-access-the-token-broker)).
  Other vendors' keys are issued to SVBC's account and stored only as Cloudflare Worker secrets.
- **Secrets belong in two places only:** as Cloudflare Worker secrets (`npx wrangler secret put`),
  and in Google Cloud Secret Manager, which is not set up yet
  ([below](#where-secret-values-live-secret-manager)). Operators also keep local `.env` files at the repo root,
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
  - GitHub's `CLOUDFLARE_API_TOKEN` for sandbox deploys is **not set yet**, so the
    `deploy-sandbox` job fails on every merge that touches a sandbox Worker (see
    [chapter 6](06-ci-and-deploy.md)).
  - The GitHub `svbc-bike-lanes` environment holds its own `CLOUDFLARE_API_TOKEN` for the bike
    lanes site's weekly production deploy: Workers Editor scoped to that Worker and
    Workers Routes: Write on the zone (see [its chapter](workers/svbc-bike-lanes.md)).
- **Cloudflare Access** protects the staff-only Workers (`member-map`, `nearby-search`, `status-page`, `svbc-bike-lanes`). Each has
  (or, for `nearby-search`, will have once it's deployed) an Access application in Zero Trust → Access → Applications, allowing SVBC staff email
  addresses. `member-map`, `nearby-search` and `status-page` also verify the Access JWT themselves (`access.aud`
  and `access.teamDomain` in their config); `svbc-bike-lanes` is static files with no script, so
  Access is its only gate.
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
  `MONDAY_API_TOKEN` in the shell or the `.env.*` files. As of 2026-11-19 the operator
  `.env.production` file still held the **SVBC Integration** user's personal token (an account
  admin). Regenerate that token as the integration user (which invalidates it) and switch the
  file to your own.
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
| Funraise | `funraise-sync` | `FUNRAISE_WEBHOOK_SECRET` (our URL secret), `FUNRAISE_API_KEY` | Funraise: profile icon → Settings → Webhooks (signing secret under the ⋯ menu); API keys under Settings → API keys | Funraise allows one webhook per account. It points at production, so the sandbox Worker gets no live deliveries; replay by hand |
| Eventbrite | `eventbrite-sync`, `svbc-calendars` | `EVENTBRITE_PRIVATE_TOKEN`, `EVENTBRITE_WEBHOOK_SECRET` (URL secret); `svbc-calendars`: `EVENTBRITE_TOKEN` | Eventbrite → Account settings → Developer links → API keys | Same organization, separate webhook |
| Mailchimp | `mailchimp-sync` | `MAILCHIMP_API_KEY`, `MAILCHIMP_WEBHOOK_SECRET`, `MONDAY_WEBHOOK_SECRET` | Mailchimp → Profile → Extras → API keys | Separate "SVBC Sandbox" audience; the sandbox key may write only there |
| Double the Donation | `dtd-sync` | `DTD_PRIVATE_KEY` | 360MatchPro portal → Settings → API Keys (admins only) | None: DTD issues test keys only to integration partners |
| Zoom | `zoom-phone-sync` (not deployed) | `ZOOM_WEBHOOK_SECRET` (the S2S app's webhook secret token) | Zoom App Marketplace → Develop → the Server-to-Server OAuth app → Feature → Event Subscriptions | Its own S2S app on the same Zoom account, limited to one test line by `zoom.includeUsers` |
| Benevity | `benevity-import` | `BENEVITY_WEBHOOK_SECRET` (URL secret for the Monday webhook) | No API. Staff download the report from the Benevity Causes portal and upload it to Monday. | n/a |
| Google Workspace | `monday-backup` | `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`, `BACKUP_ENCRYPTION_KEY` | Google Cloud console → IAM → Service accounts → Keys. The account is a **Contributor** member of the backup Shared Drive. | Separate Drive folder (not yet configured) |
| Slack | `monday-auth`, `monday-backup`, `mailchimp-sync`, `svbc-calendars`, `sync-watchdog`; Workers Issues | `SLACK_WEBHOOK_URL` (an incoming webhook into the private staff channel) | api.slack.com/apps → the app → Incoming Webhooks (app collaborators only). Which app owns each URL is recorded in the private appendix | Mostly unset; sandbox Workers don't alert |
| Intuit QuickBooks | `quickbooks-sync` (postponed) | `QB_CLIENT_ID`, `QB_CLIENT_SECRET`, `QB_WEBHOOK_VERIFIER_TOKEN`, `QB_TOKEN_ENCRYPTION_KEY` | Intuit Developer portal | Intuit sandbox company |
| Box | Nobody in code | — | — | — |

Each Worker chapter lists its own secrets, including internal ones such as `START_KEY`,
`TOKEN_ENC_KEY`, `CUSTODIAN_SECRET`, `DIGESTS_SECRET` and `RECLASSIFY_SECRET`. Operators
generate those (`openssl rand -hex 32`) and no vendor issues them.

## Where secret values live: Secret Manager

> **Not set up yet (checked 2026-11-24).** The Secret Manager API is not enabled in the project
> described below, so the `gcloud secrets` commands fail. The rest of this section is the chosen
> design. A Worker secret can't be read back from Cloudflare, so don't assume another copy exists:
> confirm one before you rotate or delete anything, `BACKUP_ENCRYPTION_KEY` first. Setup is enabling
> the API, granting the access below, loading the secrets, recording the project and its holders in
> the private appendix, and then removing this note and the "not set up yet" notes that link here.

Every shared IT secret will have one home: **Google Cloud Secret Manager**, in the Google Cloud
project that owns `monday-backup`'s service account (the private appendix is to name the project
and its owner and backup holder). Staff keep their own logins in Google Passwords, but Google Passwords
can't share an item with anyone else, so it is not the place for anything here. The shared Box
note, Box files, email and chat are never the place either. (Staff on Google Passwords: Tech
Sync, 2026-11-20. Secret Manager for shared IT secrets: chosen the same day.)

What will go in it:

- every Worker secret, production and sandbox: webhook and operator secrets, vendor API keys,
  Slack webhook URLs, `START_KEY`, `TOKEN_ENC_KEY`, `BACKUP_ENCRYPTION_KEY`;
- the Monday OAuth apps' client secrets and Signing Secrets;
- the Google service account key and `sync-watchdog`'s Cloudflare token;
- the logins that only one account can use: the SVBC Integration and Sandbox Integration Monday
  users, and the Zoom accounts. Store the password and the second factor's recovery codes.

Shared mailboxes (admin@, acctpay@, membership@) don't need a shared password at all: give
people [delegated access](https://support.google.com/mail/answer/138350) or make the address a
[Collaborative Inbox](https://support.google.com/a/answer/167430), so each person signs in as
themselves.

**Access** will be by Google Workspace group, not by person: the IT group gets
`roles/secretmanager.secretAccessor` (read) and the owner and backup holder get
`roles/secretmanager.admin`. Adding or removing someone is a group membership change. Every read
will be in the project's [audit logs](https://cloud.google.com/secret-manager/docs/audit-logging).

**Naming:** `<environment>-<worker>-<NAME>`, with the Worker's own secret name, e.g.
`production-monday-auth-START_KEY` or `sandbox-funraise-sync-FUNRAISE_API_KEY`. Accounts that
aren't a Worker's use `<environment>-<account>-<what>`, e.g.
`production-monday-integration-password`.

```sh
gcloud config set project <project-id>      # from the private appendix

# Store a new secret without it touching your shell history or screen
openssl rand -hex 32 | tr -d '\n' | \
  gcloud secrets create sandbox-monday-auth-START_KEY --replication-policy=automatic --data-file=-

# Copy it into the Worker
gcloud secrets versions access latest --secret=sandbox-monday-auth-START_KEY | \
  (cd monday-auth && npx wrangler secret put START_KEY --env sandbox)

# Rotate: add a new version (the old one stays until you disable or destroy it)
openssl rand -hex 32 | tr -d '\n' | \
  gcloud secrets versions add sandbox-monday-auth-START_KEY --data-file=-

gcloud secrets list                          # names only
```

Old versions stay until destroyed (a disabled one can be re-enabled). Keep every old `BACKUP_ENCRYPTION_KEY` version as
long as its snapshots are kept, and never destroy one that a kept snapshot needs.

**One exception, by design:** Secret Manager is Google, and so is the backup Shared Drive, so
`BACKUP_ENCRYPTION_KEY` also needs a second copy outside Google and Cloudflare
([monday-backup](workers/monday-backup.md)). The private appendix says where.

Forks: substitute your own secret store; what matters is one shared place, group-based access,
and a second copy of the backup key outside the backup's own provider.

## Google Cloud: tools and AI agents

From January 1, 2027, Google's [Service Specific Terms](https://cloud.google.com/terms/service-terms)
(General Service Terms, section 17, "Google Cloud Platform Access Tools") limit what tools may do
with what they learn from Google Cloud. Continuing to use Google Cloud accepts them. What follows is
IT's reading (2026-11-24), not legal advice; the terms themselves decide.

**What counts.** An *access tool* is any software that gets data from Google Cloud through an API,
the `gcloud` command line, an MCP server or a connector. That covers scripts as well as AI agents.
*Google Technical Information* is what such a tool learns about the services: IAM, architecture,
costs, tool schemas, and summaries or findings about them. SVBC's own data (Customer Data) is not
included.

**The terms don't allow:**

- storing Google Technical Information for more than 30 days, or keeping it after the tool is
  disconnected or its access revoked;
- using it for anything but the active task you authorized;
- scraping or systematically probing beyond what that task needs;
- using it to train, fine-tune, evaluate or distill a model, or to build a service similar to
  Google's.

Google may restrict a tool or suspend access if it reasonably believes one of these happened. It
takes no responsibility for what a third-party tool does, including training on SVBC's data,
leaking it, or exposing credentials.

**SVBC's rules:**

1. Run `gcloud` yourself. Don't have an AI agent run it, or connect an agent to a Google Cloud MCP
   server, unless IT has agreed to it for a specific task.
2. Never let an agent read, create or copy a Secret Manager value. Whatever it sees can stay in its
   transcript.
3. If an agent did query Google Cloud, delete its transcript, notes and memory of the results
   within 30 days, and at once when you disconnect it. Check that they are gone; don't assume the
   tool expires them.
4. Don't paste Google Cloud output (IAM policies, architecture, costs) into tickets, chat, agent
   memory or this manual.
5. Before connecting a new tool to Google Cloud, give it the least access that works, and know who
   will remove it.

No Worker needs a change. `monday-backup` (Drive) and `salesforce-import` (Maps) handle SVBC's own
data, and Drive and Maps appear to be covered by their own terms.

## Listing and rotating secrets

```sh
cd funraise-sync
npx wrangler secret list                  # production names (never values)
npx wrangler secret list --env sandbox    # sandbox names
npx wrangler secret put FUNRAISE_API_KEY  # prompts for the new value; takes effect on the next request
```

**No `MONDAY_API_TOKEN` should be set on any Worker.** Several Workers' code still falls back to
that secret when their `MONDAY_AUTH` binding is missing. The leftover copies from before the
broker were deleted on 2026-11-19, along with an unused `FUNRAISE_WEBHOOK_SECRET` on production
`report-digests`. If `npx wrangler secret list` ever shows `MONDAY_API_TOKEN` again:

1. Confirm the deployed version has its `MONDAY_AUTH` binding (`npx wrangler deployments status`,
   then `npx wrangler versions view <id>`).
2. Delete the secret with `npx wrangler secret delete MONDAY_API_TOKEN [--env sandbox]`.

Secret listings can lag a minute or two after a change. Check the deployed version's bindings
rather than trusting a single listing.

To rotate a secret, change it at the issuer first if the issuer holds it. Then put the new value
in Secret Manager as a new version (once it is [set up](#where-secret-values-live-secret-manager)), then copy it into the Worker. For URL secrets, also update the URL at the
sender. A secret change applies immediately and needs no deploy.

## Quick access checklist for a new IT person

1. Secret Manager (once it is [set up](#where-secret-values-live-secret-manager)): added to the IT Google group, then `gcloud auth login` and
   `gcloud secrets list` against the project named in the private appendix.
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
