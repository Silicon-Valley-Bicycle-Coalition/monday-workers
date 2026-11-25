# Extending the system

SVBC's needs will change. Staff will want a new integration, a new rollup, a new digest or a new
board. This chapter is the checklist for doing that the way the rest of the system is built, so
the conventions (and the CI checks that enforce them) keep holding.

## Before you build: is a Worker the right answer?

- **Monday can do it natively?** Automations, formulas, mirror columns, forms and dashboards cost
  nothing to maintain. Prefer them for simple rules. Workers exist for what Monday's Pro plan
  can't do: talking to outside APIs, recomputing across boards, scheduled email, donor-facing
  pages.
- **One-off?** A script in `scripts/` or a Worker's `scripts/` (or a CLI like `geo-filter`) is
  cheaper than a deployed Worker. Promote it to a Worker only when it becomes a recurring need.
- **Extending an existing Worker?** If the new work has the same trigger, the same vendor and the
  same Monday token level, add it to that Worker. Otherwise make a new one. Small Workers are
  cheap, and separate failure domains are worth a lot.

Write a short design document in `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` for
anything bigger than a small change. Say what it does, why, its data flow, its Monday targets,
and how it fails.

## Adding a new Worker: checklist

Copy the closest existing Worker as a starting point. Use `funraise-sync` for webhook ingestion,
`dtd-sync` for a cron poller, `contact-roles` for a stateless recompute, and `report-digests` for
outbound email. Then go through this list. The right-hand column names what enforces each item,
where something does.

| # | Do this | Enforced by |
|---|---|---|
| 1 | Create `<worker>/` with `package.json`, lockfile, `wrangler.jsonc`, `tsconfig.json`, `src/`, `test/`, `README.md` (the spec) | — |
| 2 | Add it to **`.github/workers.json`**, with `extraPaths` if it imports `scripts/lib/**`, and `sandbox: {}` if CI should deploy its sandbox (then also add it to the [deploy token](06-ci-and-deploy.md#the-sandbox-deploy-token) once its sandbox Worker exists) | `ci-changed-workers.mjs` fails on an unlisted directory |
| 3 | Name it `svbc-<worker>`, set `preview_urls: false` at the top level and in `env.sandbox` | `preview-urls` check |
| 4 | Add an **`env.sandbox`** block with its own D1, queues (names suffixed `-sandbox`), KV, vars `{ "ENVIRONMENT": "sandbox" }`, and `routes: []` unless it has its own sandbox domain | Review; Appendix A shows the result |
| 5 | Add `config/svbc.json`, `config/sandbox.json`, `src/environment.ts` and **`config/split.test.ts`**, copied from `member-portal` | The split test |
| 6 | Monday access: bind **`MONDAY_AUTH`** to the right broker entrypoint (`SyncToken` to write, `ReadOnlyToken` to read) in both environments. Never add a `MONDAY_API_TOKEN` secret. | `monday-auth-bindings` check (add the Worker to `EXPECTED` in `scripts/check-monday-auth-bindings.mjs`) |
| 7 | Copy **`src/monday/graphql.ts`** from `monday-backup` and add its path to the `monday-graphql-copies` roster in `checks.yml` | `monday-graphql-copies` |
| 8 | If it consumes a queue that writes to Monday: copy **`src/monday/outage.ts`** from `funraise-sync`, add it to the `monday-outage-copies` roster, and add a DLQ with its own consumer | `monday-outage-copies` |
| 9 | If it writes to Monday or sends email: copy **`src/flags.ts`** from `member-portal`, bind `FLAGS` (both namespace ids), add the Worker to `IN_SCOPE` in `scripts/check-worker-flags.mjs` | `worker-flags-copies` |
| 10 | Public routes: a `REQUEST_RATE_LIMITER` binding with a **unique `namespace_id`** per environment | `rate-limit-namespaces` |
| 11 | Set `limits.cpu_ms` (100 unless measured otherwise) and `observability: { enabled: true, issues: { enabled: true } }` in **every** env block | Review |
| 12 | Never log an email address, token or request URL | `log-safety` and the pre-commit hook |
| 13 | Any column it writes: add to `MARKED_COLUMNS` and run `scripts/mark-read-only-columns.mjs`. Find columns via `bareTitle()`. | Review |
| 14 | New Donations column? Hide it on the "Enter a gift" form and run `check-donation-form.mjs` | The script |
| 15 | Webhook secrets in the URL: fail closed while unset, accept `X-Webhook-Secret` too, document in its README | Review |
| 16 | Add **`docs/manual/workers/<worker>.md`** with the nine template headings | `manual` check |
| 17 | Add a staff test script in `docs/uat/<worker>.md` if staff can see what it does | Review |
| 18 | Add a row to the root README's status table, and update `docs/systems-map.html` | Review |
| 19 | Production crons: add it to `sync-watchdog/config/svbc.json` (`watched`, or `notLive` until it's live) | `sync-watchdog/config/coverage.test.ts` |
| 20 | Go live: create D1 and queues, set secrets, set `writes off`, deploy, read dry-run logs, then `writes on`. Add the two Workers Issues automations. | [Chapter 6](06-ci-and-deploy.md), [chapter 7](07-operations.md#adding-a-worker-to-monitoring) |
| 21 | A new custom domain for non-browser clients? Add it to the WAF Super Bot Fight Mode skip rule. | [Chapter 3](03-accounts-and-access.md#cloudflare) |

## Adding a Monday column or board that a Worker uses

1. Create the column on the **sandbox** board first, then production. Use the same title and
   type. The ids will differ.
2. Put both ids in `config/sandbox.json` and `config/svbc.json`, and extend the config validator
   and its test. The split test keeps the ids distinct.
3. If staff shouldn't edit it, mark it 🔒 (`MARKED_COLUMNS`).
4. If it's on Donations, hide it on the staff form (item 14 above).
5. If the Worker needs a new status or dropdown label, create the label in Monday **before**
   deploying. Writing a label that doesn't exist is rejected and fills the dead-letter queue.
6. A private board: subscribe the integration user (production) to it, and nobody else's
   integration user.
7. Deploy sandbox, test, deploy production.

Some Workers ship idempotent setup scripts (`setup-*.mjs`) that create their columns and
webhooks. Prefer extending those to clicking in the UI, so a rebuild is repeatable.

## Adding a new outside service

- Store its credentials only as Worker secrets, per environment. Prefer a sandbox or test account
  for the sandbox Worker, and record any it lacks in the Worker's README.
- If it can sign webhooks, verify the signature. If not, use a URL secret (and accept its
  logging trade-off), or poll on a cron instead.
- Add it to [chapter 3](03-accounts-and-access.md)'s vendor table and the private appendix: who
  administers it, where the key is issued, how to rotate it.
- If it has a rate limit, respect `Retry-After` and use the queue's backoff rather than tight
  loops.

## Changing shared code

- **Copied modules:** edit the canonical file, copy it to every path in its roster, and run every
  affected Worker's tests (`for d in …; do (cd $d && npm test); done`). CI runs only the Workers
  the change touched, and a copied file counts as a change to each.
- **Monday API version bump:** see [chapter 7](07-operations.md#recurring-chores).
- **The write switch:** `member-portal/src/flags.ts` is canonical. Changes to its semantics also
  need the runbook and [chapter 2](02-architecture.md#the-write-switch) updated.
- **Broker scopes:** adding a scope to an OAuth app means changing it in the Developer Center
  and `monday-auth/src/apps.ts`, then re-consenting that app in each environment
  ([`monday-auth/SETUP.md`](../../monday-auth/SETUP.md)).

## Forking for another organization

The repo is MIT-licensed so other nonprofits can reuse it. A fork replaces:

- the account id in every `wrangler.jsonc`;
- D1, queue, KV and R2 ids;
- the `FLAGS` namespace ids;
- every `config/*.json`;
- the email domain;
- the broker's `EXPECTED_USER_ID` and `MONDAY_SUBDOMAIN`.

Then it creates its own integration user and OAuth apps. Nothing SVBC-specific should need a
code change. If it does, that's a bug worth fixing upstream.

## Keeping this manual alive

- Change the Worker's chapter in the same pull request as the Worker.
- Add a troubleshooting entry ([chapter 8](08-troubleshooting.md)) whenever an incident teaches
  you something.
- Rebuild the PDF and upload a new Box version after significant changes
  ([`docs/manual/README.md`](README.md)).
