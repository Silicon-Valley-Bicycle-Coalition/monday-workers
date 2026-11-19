# contact-roles

[Appendix A](../reference/contact-roles.md) lists this Worker's routes, crons, queues, storage and bindings.

`contact-roles` runs as the Cloudflare Worker `svbc-contact-roles` (sandbox: `svbc-contact-roles-sandbox`). It has no hostname and no HTTP surface: every request gets a 404, and the only entry point is a cron. It reaches Monday through the `monday-auth` broker's `SyncToken` entrypoint (the Staff sync app). It ships with its write switch off. Check the root README's [Status at a glance](../../../README.md#status-at-a-glance) table for where it is deployed and whether writes are on.

## What it does

Staff record who the contacts at an organization are by giving each person a role on their affiliation with that organization, for example "Sponsorship" or "Donation Matching". Every ten minutes this Worker copies those roles into a read-only `Contacts` column on each opportunity board, such as Sponsorships and Donations. If it stops, `Contacts` goes stale: new or changed roles don't show up on opportunities, and people who left an organization stay listed. Nothing else breaks.

## Trigger and data flow

The production Worker has one cron, `*/10 * * * *`. The sandbox has no cron; run the handler by hand when testing. There is no D1, queue, or cursor. Each run recomputes everything from current Monday state, so a missed or failed run is fixed by the next one.

1. Read the write switch once (`contact-roles:writes`). `hold` or `unknown` ends the run with no Monday call.
2. Read the Affiliations board once. Keep rows whose `Status` is `Current` and build an index of (organization, role) → people from `SVBC Roles`.
3. For each board with `enabled: true` in config, read its items. Donations is read sparsely: only items with `Matched By` or `Contacts` set.
4. For each item, follow its organization link, look up the people who hold that board's role there, and compare them with the item's current `Contacts`.
5. Write only the items that differ (under `on`), or log what would be written (under `off`).
6. Log one `run-complete` line with the mode and, per board, `items`, `updates`, `written`, and any `skipped` or `failed`.

## Monday boards and columns

Board ids live in [`config/svbc.json`](../../../contact-roles/config/svbc.json) (production) and [`config/sandbox.json`](../../../contact-roles/config/sandbox.json). `src/environment.ts` picks one by `env.ENVIRONMENT`. Columns are matched by bare title, so the 🔒 marker doesn't break lookups.

| Board | Column | Read or write |
|---|---|---|
| Affiliations | `SVBC Roles` (multi dropdown: Sponsorship, Grants, Bike Parking, Donation Matching, Classes) | Read. The only role column the Worker uses. |
| Affiliations | `Status`, `Person`, `Organization` | Read. Only `Status` = `Current` counts. |
| Affiliations | `Proposed Roles` | Never read. Written only by the backfill script. Staff confirm a proposal by moving the label into `SVBC Roles`. |
| Each enabled opportunity board | Its organization link (`orgColumn` in config) | Read |
| Each enabled opportunity board | `Contacts` (connect-boards to People) | Write |

Each board in config has either one fixed `role` or a `typeColumn` plus `typeRoles` map (Leads uses the item's Type to choose the role).

In production, Sponsorships (`Organization` → Sponsorship) and Donations (`Matched By` → Donation Matching) are enabled. Grants & Contracts, BP Request Form, Bike Education Lifecycle Tracker and Leads are disabled because they have no link to the Organizations board. To turn one on, add the link on the board, point `orgColumn` at it, set `enabled: true`, and re-run the provisioning script so the board gets its `Contacts` column. The sandbox covers Sponsorships, Grants & Contracts and Donations.

## Secrets

The Worker has no secrets. Monday access comes from the `MONDAY_AUTH` service binding. See [Accounts and access](../03-accounts-and-access.md).

| Name | Purpose | Issued by | Rotate |
|---|---|---|---|
| `MONDAY_API_TOKEN` (operator shell only, not a Worker secret) | Lets the two operator scripts call Monday | The SVBC Integration user (production) or Sandbox Integration user (sandbox) in Monday | When the integration user's token is regenerated |

## Write switch

The key is `contact-roles:writes` in the `FLAGS` namespace (`sandbox-FLAGS` in the sandbox). See [Operations](../07-operations.md) for how the switch works.

| Mode | Behavior |
|---|---|
| `on` | Recompute and write `Contacts` where it differs. |
| `off` or unset | Dry run. Computes and logs the `run-complete` report and writes nothing. |
| `hold`, or `unknown` (KV read error) | The cron skips the run without calling Monday. |

There is no catch-up to worry about. The first `on` run after any `hold` or `off` period recomputes every item. That first large run may hit the Workers subrequest cap and finish over several ticks; each tick writes only what still differs.

## Failure modes

| Symptom | Cause | What to do |
|---|---|---|
| A board logs `skipped: "unknown-role"` every 10 minutes and its `Contacts` doesn't change | The board's role label was renamed or deleted in `SVBC Roles`. The Worker skips the board on purpose rather than blanking `Contacts`. | Restore the label in Monday, or change `role` / `typeRoles` in config to the new label and deploy. |
| Every board logs `skipped: "no-confirmed-roles"` and nothing is written | No Current affiliation has a confirmed role. The `SVBC Roles` column may be cleared, renamed, or read back empty. This guard stops a mass removal. | Check that `SVBC Roles` exists on Affiliations under that title and holds labels. Expected before staff have confirmed any roles. |
| `item-failed` lines, board `failed` count above 0 | A single item's write failed. The rest of the board still writes. | Read the error class in the log. The next run retries that item automatically. |
| `board-failed` or `failed: true` for a board | A read of that board failed (column missing, Monday outage, auth). | Check the board's organization and `Contacts` columns still exist under the bare titles in config. For 401s, see the `monday-auth` chapter. |
| `run-failed` | Reading Affiliations or config failed. | Same checks as above, against the Affiliations board. |
| `Contacts` never fills on a board you expected | The board is `enabled: false`, or the write switch is not `on`. | Check `config/svbc.json` and `node scripts/flags.mjs status`. |
| A reflection column appears on People after provisioning | Monday's `create_column` may ignore `allowCreateReflectionColumn: false`. | Delete the reflection column on People and People (Historical). |
| Staff typed into `Contacts` and it reverted | The column is Worker-owned and gets overwritten. | Change the role on the Affiliation instead. |

Logs carry counts and ids only, never names or emails.

## Operator scripts

Both scripts run from the repo root with `MONDAY_API_TOKEN` in the shell, and both are dry runs unless given `--execute`.

| Script | When | Command |
|---|---|---|
| `provision-contact-roles.mjs` | First setup in an environment, and after enabling a new board. Creates `SVBC Roles`, `Proposed Roles` and each enabled board's `Contacts` if missing. Exits 2 if the role labels did not land. | `node contact-roles/scripts/provision-contact-roles.mjs --env sandbox\|production [--execute]` |
| `backfill-proposed-roles.mjs` | Once, to suggest roles from old data (writes `Proposed Roles` only, never `SVBC Roles`). | `node contact-roles/scripts/backfill-proposed-roles.mjs --env sandbox\|production [--execute] [--report <file>]` |

After provisioning, mark `Contacts` read-only with `node scripts/mark-read-only-columns.mjs` and hide it on the "Enter a gift" form (`node scripts/check-donation-form.mjs --form <token>`). The README's rollout checklist has the full sequence.

## Changing it

- `src/reconcile.ts` holds the recompute and the guards. `src/contacts.ts` builds the role index. `src/config.ts` validates config at startup.
- `src/flags.ts` and `src/monday/graphql.ts` are byte-identical copies. Edit the canonical files and copy them over (see [Development](../05-development.md)).
- Roles are matched by label text. Renaming a label in Monday needs a matching config change.
- Tests: `cd contact-roles && npm test` (Worker, Vitest), `npm run test:scripts` (script `node:test` files), `npm run typecheck`.
- Deploy: `npm run deploy` (production), `npm run deploy:sandbox`. CI deploys the sandbox from `main`. There are no D1 migrations.

## Further reading

- [`contact-roles/README.md`](../../../contact-roles/README.md), including the [rollout checklist](../../../contact-roles/README.md#deploy-order-and-rollout-checklist) and the smoke tests
- [Staff UAT script](../../../docs/uat/contact-roles.md)
- [Design](../../../docs/superpowers/specs/2026-11-11-organization-contact-roles-design.md)
- [Write switch runbook](../../../docs/runbooks/migration-hold.md)
- [Operations](../07-operations.md), [Troubleshooting](../08-troubleshooting.md)
