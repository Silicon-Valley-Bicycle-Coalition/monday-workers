# Funding Leads board (sandbox) — runbook

Design: `docs/superpowers/specs/2026-11-11-funding-leads-board-design.md`. Tool: `scripts/funding-leads-board.mjs`
(logic and tests: `scripts/lib/funding-leads.mjs`, `scripts/funding-leads-board.test.mjs`).

Sandbox only (CRM Sandbox v4, workspace 18210301). Every command refuses another workspace, **and**
refuses any board id that is not in that workspace. That guard is the protection: the shared token in
`monday-migration/.env` is *not* sandbox-scoped. `check-monday-token-scope.mjs --workspace 10001654`
fails for it (it reaches many other workspaces; the known #18 limitation).

Sandbox boards: Funding Leads `18439612347`, Opportunities (Deals) `18439612351`; Organizations
`18437342579`, People `18437342592`.

```sh
export MONDAY_API_TOKEN=...   # operator token; never committed
node scripts/funding-leads-board.mjs build   --workspace 18210301 --organizations 18437342579 --contacts 18437342592 [--apply]
node scripts/funding-leads-board.mjs convert --workspace 18210301 --leads 18439612347 --deals 18439612351 [--apply]
node scripts/funding-leads-board.mjs seed    --workspace 18210301 --leads 18439612347 --orgs 18437342579 --data <dir> [--apply]
```

Every command is a dry run until `--apply`. `build` and `convert` are idempotent.

## After `build`

- **Check Pledged is "done"** on the Stage column. `create_column` ignores `is_done`, so set it with
  the Monday `update_column` tool (keep each label's existing id and color; Monday refuses recoloring
  default labels).
- **Create the views** Open (Stage not Pledged/Lost), Pledged, Lost; the GraphQL API cannot.
- Monday adds a sample item "Task 1" and a "Group Title" group; delete/rename by hand.

## convert

Creates one Deals item per Pledged lead whose **Deal** link is empty and links it back; the link is
the dedupe key, so re-running or moving Stage out of Pledged and back creates nothing. Relation links
are read from `linked_item_ids` (the plain `value` of a relation column is null). If the Deal is
created but linking fails, it prints both ids; link them by hand, then re-run.

## seed

Reads `active.csv`, `prospects.csv`, `lapsed.csv` (exported from the "2027 Sponsor List" tabs
"2026 BTWD, Summit, Misc", "Prospects", "Lapsed Donors") from `--data`, which must live outside this
repo (convention: `monday-migration/data/funding-leads/`, gitignored). It writes `review.txt`
(near-match organization names, never merged) and `ledger.json` (resume). Owners and contacts are not
linked in this pass; `review.txt` counts rows with contact data.

## Not done yet

- The live seed (needs the three CSV exports).
- Production promotion: a separate decision.
