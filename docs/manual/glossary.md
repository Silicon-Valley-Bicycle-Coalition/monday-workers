# Glossary

**Access (Cloudflare Access).** Cloudflare's login gate in front of a hostname. It protects the
staff-only Workers (`member-map`, `nearby-search`). The Worker also checks the Access JWT.

**Affiliation.** A Monday item linking a person to an organization with a role: employer,
sponsor contact, board member. Current and Former Affiliations are separate boards.

**Binding.** A named handle a Worker uses to reach a Cloudflare resource (`DB` for D1,
`WRITE_QUEUE` for a queue, `FLAGS` for KV, `MONDAY_AUTH` for a service). Bindings are declared in
`wrangler.jsonc`, and Appendix A lists them.

**Board, group, item, subitem, column.** Monday's data model. A board is a table, an item is a
row, and a column is a field with a type (status, text, date, connect-boards, mirror, formula…).
Groups are sections within a board. Code refers to boards and columns by **id**. Ids differ
between production and sandbox, so they live in config.

**`bareTitle`.** The helper that strips the 🔒 or 📜 marker from a column title before comparing
it. See "Read-only column markers" in chapter 2.

**Broker.** The `monday-auth` Worker, which holds the Monday OAuth tokens and hands them to other
Workers.

**Canonical file / copy roster.** A module shared by being copied byte for byte into several
Workers. The canonical file is the one you edit. The roster is the CI list of copies that must
match it.

**Challenge (Monday webhook).** The one-time request Monday sends when a webhook subscription is
created. The route must echo it back.

**Connect-boards column.** A Monday column linking an item to items on another board. For
example, a Donation links to a person on People.

**Consent (OAuth).** The one-time authorization the integration user gives an OAuth app.
"Re-consent" repeats it after a revocation or a scope change.

**Cron Trigger.** A schedule in `wrangler.jsonc` (`triggers.crons`, in UTC) that invokes the
Worker's `scheduled()` handler.

**Cursor.** A value in D1 recording how far a polling Worker has processed. It must advance only
after a confirmed Monday write.

**D1.** Cloudflare's serverless SQLite database. Each Worker has its own, one per environment.

**DLQ (dead-letter queue).** Where a queue message goes after its retries run out. Most DLQs here
have a consumer that records the failure in D1 and logs an error. `member-portal`'s two DLQs have
none, so inspect them by hand (its chapter).

**Dry run.** What a Worker does under the `off` write switch: it computes and logs, and writes
nothing.

**Entrypoint (`PortalToken`, `SyncToken`, `ReadOnlyToken`).** The broker's named RPC interfaces.
A Worker binds to one, and that decides which OAuth app's token it gets.

**`ENVIRONMENT`.** The Worker variable (`production` or `sandbox`) that selects the config file.

**Hono.** The small web framework most Workers use for HTTP routing.

**Integration user.** A Monday user that exists only to authorize the OAuth apps: SVBC Integration
in production, Sandbox Integration in the sandbox.

**KV (Workers KV).** Cloudflare's key-value store. Here it holds the write switch (`FLAGS`) and
some caches.

**Main board / private board.** A Main board in an open workspace is visible to every Monday team
member. A private board is visible only to its subscribers. This is why board privacy matters
for token reach.

**Miniflare / workerd.** The local simulator and the open-source Workers runtime that `wrangler
dev` and the tests use.

**Mirror column.** A Monday column that displays a value from linked items. It's read-only, and
the API can't write to it.

**OAuth app.** A Monday Developer Center app (Portal, Staff sync, Read-only) whose token has a
fixed set of scopes.

**Outage breaker.** `src/monday/outage.ts`. It stops a queue batch from calling Monday after one
outage-type failure.

**Queue (Cloudflare Queues).** A durable message queue. A producer binding sends, and the
Worker's `queue()` handler consumes. Each queue has one consumer.

**R2.** Cloudflare's object storage, used for `member-map` snapshots.

**Re-drive.** Putting failed or dead-lettered work back through the normal path once the cause is
fixed. Each Worker that needs it has a script.

**Rollup.** A value computed from many items: Lifetime Giving, This Year, Last Gift Date,
membership tier. `donation-rollups` maintains them.

**Sandbox.** The second, isolated environment, with its own Workers, data, broker and Monday
workspace.

**SBFM (Super Bot Fight Mode).** The zone's bot protection, which challenges non-browser
clients. A WAF rule exempts webhook and feed paths.

**Secret (Worker secret).** An encrypted environment value set with `wrangler secret put`. It
isn't in the repo or in `wrangler.jsonc`.

**Service binding.** A direct Worker-to-Worker call inside Cloudflare, with no public HTTP.

**Signing Secret.** A Monday OAuth app's key for signing webhook JWTs. It isn't the client
secret.

**Split test.** `config/split.test.ts`, which proves production and sandbox configs share no ids
or sinks.

**Strip-only TypeScript.** TypeScript that Node can run by deleting type annotations: no enums,
namespaces or parameter properties. Required for modules the `.mjs` scripts import.

**Workers Builds.** Cloudflare's Git-connected CI/CD. It deploys `svbc-calendars` and
`monday-backup` on merge to `main`.

**Workers Issues.** Cloudflare's error grouping for Workers. Dashboard automations post issues to
Slack.

**Workflow (Cloudflare Workflows).** Durable multi-step execution for jobs longer than one
invocation. `monday-backup` uses it.

**Worktree.** A second working directory of the same Git repository on another branch. Here,
each topic gets its own worktree.

**Wrangler.** Cloudflare's CLI and config format (`wrangler.jsonc`) for building, deploying and
managing Workers.

**Write switch.** The per-Worker `on`, `hold` or `off` mode in KV that gates every Monday write
and email send.

**🔒 / 📜.** Markers on Monday column titles. 🔒 means a Worker writes it. 📜 means Salesforce
history.
