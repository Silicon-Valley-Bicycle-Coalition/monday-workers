# contact-roles

**Staff UAT script:** [`docs/uat/contact-roles.md`](../docs/uat/contact-roles.md) — what a non-technical tester can try in the sandbox and what they should see. Keep it in step with this README.

**Status (checked 2026-11-19): deployed in both environments. Sandbox writes are `on`;
production writes are `off`**, so production dry-runs every 10 minutes. Production goes `on`
after the rollout checklist below (dry-run counts checked, backfill, smoke tests). A new
deployment of this Worker ships **off**: an unset write switch means `off`. Design: [`docs/superpowers/specs/2026-11-11-organization-contact-roles-design.md`](../docs/superpowers/specs/2026-11-11-organization-contact-roles-design.md)
(including "Calls made while writing this"); plan: [`docs/superpowers/plans/2026-11-11-organization-contact-roles.md`](../docs/superpowers/plans/2026-11-11-organization-contact-roles.md).
**Stack:** TypeScript on Cloudflare Workers, a 10-minute cron, no HTTP surface, **no D1, no queue**.

## The ask

Staff want an opportunity (a sponsorship, a grant, a matched donation) to show which people at
its organization are the contacts for it. The answer is a role on the person's **affiliation**
with the organization: "Jo is a Sponsorship contact at Acme". The Worker turns those roles into
a read-only `Contacts` column on each opportunity board, so nobody maintains the same list twice.

## Data flow

```
Cloudflare cron, */10 ──► read write mode (once): on → run · off → run as dry run · hold/unknown → skip
                              │
                              ▼
   read the Affiliations board once: keep Status = Current rows, read SVBC Roles
   (Proposed Roles is never read) → index: (organization, role) → people
                              │
                              ▼
   for each enabled board in config: read its items (Donations: sparse read), look up each
   item's organization link → the people holding that board's role at that organization
   → compare with the item's current Contacts → write only the items that differ
```

The pass is a pure recomputation from current Monday state, so there is no cursor and no catch-up:
the next `on` run after a `hold` or `off` period recomputes everything. A failed run is simply
redone ten minutes later.

## Columns

| Where | Column | Written by | Notes |
|---|---|---|---|
| Affiliations | `SVBC Roles` | Staff | Multi dropdown, the **confirmed** roles and the only column the Worker reads. Seed labels: Sponsorship, Grants, Bike Parking, Donation Matching, Classes |
| Affiliations | `Proposed Roles` | `scripts/backfill-proposed-roles.mjs` only | Same labels. A proposal never takes effect; staff confirm by moving a label into `SVBC Roles` (view `Roles to confirm`, a UI step) |
| Each enabled opportunity board | `Contacts` | This Worker | Read-only 🔒 connect-boards column to the People board(s) the Affiliations `Person` column links to. One-way: no reflection column on People |

Only affiliations with `Status` = `Current` (config `currentLabel`) count; a Former contact drops
off on the next run.

## Config (`config/svbc.json`, `config/sandbox.json`)

Chosen at request time by `env.ENVIRONMENT` (`src/environment.ts`); `config/split.test.ts` fails
if the two share an id. Validated at startup (`src/config.ts`).

* `affiliations`: `boardId`, `rolesColumn` (`SVBC Roles`), `statusColumn`, `personColumn`,
  `orgColumn`, `currentLabel`.
* `boards[]`, one per opportunity board: `name`, `boardId`, `orgColumn` (the column linking to
  Organizations), `contactsColumn`, `enabled`, and either `role` (one fixed role label) or
  `typeColumn` + `typeRoles` (the role follows the item's Type; Leads uses this). `sparse: true`
  reads only items with `Matched By` or `Contacts` set (Donations is far too large to read in full).

Roles are matched by label. Columns are found by bare title (`bareTitle`), so the 🔒 marker never
breaks a lookup.

## Which boards are on

**Production enabled:** 2027 PROSPECTING - Sponsorships (reads `Sponsor (Organization)`) and Donations
(Donations reads `Matched By`, sparse). Since staff split the opportunity boards on 2026-11-19, the
historic Sponsorships board has no Contacts column, so its rule is off; a new year's prospecting
board needs its own entry.

**Production disabled, and what switches each on** (add the Organization link, then set
`enabled: true` in `config/svbc.json`):

| Board | Why off | To enable |
|---|---|---|
| BP Request Form | The live board has no organization link, only text columns | Add an Organization link, point `orgColumn` at it |
| Sponsorships | Past cycles only since 2026-11-19; staff deleted its Contacts column | Re-add a `Contacts` link to People |
| Grants & Contracts | `Funder (Organization)` points at the Grant Providers board, not Organizations (its `Sponsor` link does point at Organizations) | Point `orgColumn` at an Organizations link |
| 2027 PROSPECTING - Grants & Contracts | Not listed: no Contacts column, and `Funder (Organization)` points at Grant Providers | Add a `Contacts` link and an Organizations link, then a rule |
| Bike Education Lifecycle Tracker | No organization link | Add one |
| Leads | Needs an Organization link and final Type values; role follows Type (sponsorship → Sponsorship, grant → Grants) | Enable when the Leads redesign lands, after checking `typeRoles` against the final Type labels |

**Sandbox v4** covers Sponsorships (reads its `Sponsor` link, which points at sandbox
Organizations), Grants & Contracts (`Funder`) and Donations (`Matched By`) only.

## Write modes

| Mode (`contact-roles:writes`) | Behaviour |
|---|---|
| `on` | Reconcile and write `Contacts` where it differs |
| `off` (or unset) | Dry run: computes and logs what it would write, writes nothing |
| `hold` / `unknown` (KV read error) | The cron skips; no Monday call |

Behaviours worth knowing:

* An enabled board whose role label is missing from `SVBC Roles` (a renamed or deleted label) is
  **skipped with a warning every 10 minutes, on purpose**, and its `Contacts` is left untouched,
  never blanked.
* **Mass-removal guard:** if the Affiliations read holds no affiliation with a confirmed role at
  all (the roles column cleared, renamed or read back empty), the run writes nothing, logs one
  `no-confirmed-roles` warning (counts only) and reports every board `skipped:
  "no-confirmed-roles"`. A legitimately empty roles state therefore leaves `Contacts` as it is
  until a role exists.
* One item whose write fails does not stop its board: it is logged once (`item-failed`, with the
  item id and error class) and counted in the board's `failed`; the rest still write. A read error
  fails the whole board (`failed: true`).
* Every run ends with one `run-complete` log line: the mode and, per board, `items`, `updates`,
  `written` and any `skipped`/`failed`. Under `off` it is the dry-run report.
* The first large `on` run may hit the Workers subrequest cap and finish over later ticks; each
  tick only writes what still differs.
* Logs carry counts and ids, never names or emails (`check-log-safety.mjs`).

## Monday access

Through the `monday-auth` broker's Staff sync app (`SyncToken` entrypoint of the `MONDAY_AUTH`
service binding). No `MONDAY_API_TOKEN` secret. Transport: the byte-identical copy of
`monday-backup/src/monday/graphql.ts` (see the root `CLAUDE.md`).

## Operator scripts

Both are dependency-free Node scripts that import the Worker's transport directly (Node 22.18+),
run from the repo root with `MONDAY_API_TOKEN` in the environment (an operator's shell, as with
the other operator scripts). Both are dry runs unless given `--execute`.

* `contact-roles/scripts/provision-contact-roles.mjs --env sandbox|production [--execute]`:
  creates `SVBC Roles` and `Proposed Roles` on Affiliations and each **enabled** board's
  `contactsColumn` (`Contacts`), whatever is missing (idempotent by bare title). A disabled board is
  listed as skipped: re-run it when that board is enabled. A same-titled column of the wrong type
  is reported as skipped, never duplicated. After `--execute` it re-reads and exits 2 unless the
  Affiliations role dropdowns really hold all five seed labels (Monday silently accepts a
  malformed `defaults` payload and makes a dropdown with none). Prints the UI-only steps it cannot do.
* `contact-roles/scripts/backfill-proposed-roles.mjs --env sandbox|production [--execute] [--report <file>]`:
  proposes roles into `Proposed Roles` only (merged with labels already there; `SVBC Roles` is
  never written; Current affiliations only). Prints counts, writes an ids-only report outside the repo.
  On today's production data only the `Sponsor Contact` (→ Sponsorship) and `Grant/Contract Contact`
  (→ Grants) checkboxes on Affiliations produce proposals. The BP Request Form, Grants & Contracts
  and Sponsorships sources skip or report `no-person-link` (Sponsorships `Primary Contact` is plain text).

Tests: `cd contact-roles && npm test` runs the Worker's Vitest suite; `npm run test:scripts` runs
the scripts' `node:test` files (Vitest is kept off them). Also `npm run typecheck`.

## Deploy order and rollout checklist

Each step needs the user's go-ahead. The Worker ships with the write switch **off** (an unset
`contact-roles:writes` key reads as `off`), and it stays `off` until the dry-run counts look right
and staff have confirmed roles: see "Write modes". CI deploys the sandbox Worker from `main`
(`deploy-sandbox:contact-roles`), which is a harmless dry run for the same reason. Never use
`all writes on` (root `README.md`, [`docs/runbooks/migration-hold.md`](../docs/runbooks/migration-hold.md)).
For the order of namespaces, keys and first deploy, see the runbook's "Merging / first deploy sequencing".

1. **Sandbox**
   1. `MONDAY_API_TOKEN=... node scripts/check-monday-token-scope.mjs --workspace 18210301`
      before the first sandbox write, to see what the integration token can really reach ([GL#18](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/18)).
   2. `node contact-roles/scripts/provision-contact-roles.mjs --env sandbox` (dry run), then `--execute`
      (it verifies the role labels landed).
   3. Inspect People and People (Historical) for an unwanted reflection column (the legacy
      `create_column` may ignore `allowCreateReflectionColumn: false`); remove it if present.
   4. Create the `Roles to confirm` view on Affiliations (filter: `Proposed Roles` is not empty).
   5. Hide `Contacts` on the sandbox "Enter a gift" form, then
      `node scripts/check-donation-form.mjs --form 2325fd7745d3a2d425086d38358e4bd5`.
   6. `node scripts/mark-read-only-columns.mjs --workspace 18210301 --suffix " (sandbox v4)"` (dry run), then the same with `--apply` (puts 🔒 on `Contacts`). Production: `--workspace 18201685`, no `--suffix`.
   7. `npm run deploy:sandbox` with the write switch left **off**. Read the `run-complete` log
      line (`npx wrangler tail`, or Workers Logs): it carries each board's `items` and `updates`
      counts. Confirm the counts are plausible, which proves the `is_not_empty` / `or` filters and
      the label parsing behave. A board `skipped: "unknown-role"` or a `run-failed`/`board-failed`
      line means fix that first. `skipped: "no-confirmed-roles"` is expected until roles exist.
   8. Run the backfill dry run, then `--execute` (it writes `Proposed Roles` only).
   9. Staff confirm a few roles into `SVBC Roles` ([UAT](../docs/uat/contact-roles.md)).
   10. `node scripts/flags.mjs contact-roles writes on --env sandbox`, then watch the next
       reconcile: `written` should equal the earlier `updates`, and a second run writes nothing.
   11. Run the smoke tests below.
2. **Production**: the same steps with production ids (form token `567223ac739c23567e56e9057d81dbf5`, `npm run deploy`, `--workspace 18201685`).
3. **Enable more boards** as their Organization links appear; Leads when its redesign lands.
   Re-run `provision-contact-roles.mjs` for each newly enabled board so it gets its `Contacts` column.
4. **Later, separate:** retire the `Sponsor Contact` checkbox once staff have confirmed the backfill.

## Smoke tests (not provable by unit tests; verify in the sandbox first)

* `is_not_empty` with `compare_value: []` in `items_page` `query_params` works for board_relation
  and dropdown columns, including the `or` group the sparse read uses.
* Writing `{"item_ids": []}` actually clears a connect-boards column (fallback: write null / `{}`).
* The `DropdownValue { values { label } }` item read shape (the column-level `settings_str` shape is `{labels: [{id, name}]}`) and the dropdown write shape `{labels: [...]}`.
* `next_items_page` keeps `query_params` across pages.
* The Status label text equals `Current`.
* `create_column` accepts the dropdown `defaults` payload.
* No reflection column appears on People after provisioning.
