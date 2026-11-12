# One Opportunities Board and Two-Way Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give People, Organizations, Donations, Events and one merged Opportunities board two-way connect columns, and merge Grants & Contracts and Sponsorships into that Opportunities board.

**Architecture:** Extend the planning repo's existing board-link tooling (`scripts/provision-board-links.mjs`, `scripts/link-board-items.mjs`, `scripts/lib/board-links.mjs`) with a declarative `network` section in `config/board-links*.json`. A pure planner turns it into column creations; thin scripts apply it, backfill matched links, and move items. Everything is dry-run by default and rehearsed in the sandbox before production.

**Tech Stack:** Node 22+ ES modules (`.mjs`), `node:test`, `scripts/lib/monday.mjs` client, Monday GraphQL API. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-11-opportunities-network-links-design.md` (this repo). Tooling lives in the private `monday-migration` repo: work in a worktree of it (`git -C monday-migration worktree add ../monday-migration-opportunities -b feat/opportunities-network`), not the primary checkout.

## Global Constraints

- Node ES modules, vanilla JS, no new dependencies; tests use `node:test` and run as `node --test scripts/test/<file>.test.mjs`.
- Scripts are dry-run by default; writes need `--execute`. Re-running any script is a no-op once it has converged (find columns by `bareTitle` from `scripts/lib/column-titles.mjs` in monday-workers semantics: 🔒/📜 prefixes ignored).
- Sandbox first (`config/board-links.sandbox.json`); no production `--execute` before the sandbox rehearsal report is reviewed.
- Use the existing `mondayClient` (`scripts/lib/monday.mjs`); never use a staff member's personal token; never commit `.env` or `data/`.
- Never delete the old connect column or the old board until the replacement is verified; old boards become read-only, not deleted.
- A backfill links only unambiguous matches; ambiguous matches go to a review CSV and are never auto-linked. Monday refuses to connect archived items: report them as not linkable, as `link-board-items.mjs` does.
- Do not add or rename #16's planned columns (Received mirror, Balance Owed, Invoices sent mirror, Restriction, Type, 14-day reminder).
- New connect column titles must not collide with existing titles; the Events link on Opportunities is titled "Linked event", not "Event". Reuse `Sponsor`, `Primary Contact (People)`, `Donations` where `board-links.json` already names them.
- Production cutover waits for Clarrissa's sign-off on the board name and the stage vocabulary (svbc-monday-migration#109).

## Review Focus

1. A Donation that is in a closed fiscal year (archived) when its link is backfilled: expected: reported "not linkable", no crash, no partial write.
2. Primary Contact email blank, malformed, or shared by two People: expected: not linked; listed in the ambiguous/unmatched report.
3. A connect column that is replaced (new id): expected: every existing link is present on the new column before the old one is touched.
4. Moving items between boards: expected: subitems, files, updates and inbound links from Invoicing Tasks / Bike Education / Comms survive, with no item lost (count before equals count after).
5. Re-running provision, backfill or move after success: expected: reports zero changes, creates no duplicate column or link.

---

### Task 1: Sandbox probe — can reflection be enabled in place?

**Files:**
- Create: `scripts/probe-reflection.mjs`, `scripts/test/probe-reflection.test.mjs`
- Modify: `docs/superpowers/specs/2026-11-11-opportunities-network-links-design.md` (monday-workers worktree) — record the answer under open item 1

**Interfaces:**
- Produces: `export async function probeReflection(client, boardId, columnId): Promise<{ inPlace: boolean, detail: string }>` — attempts to turn `allowCreateReflectionColumn` on for an existing connect column on a sandbox board and reports whether the target board gained a reverse column.

- [ ] **Step 1: Write the failing test** in `probe-reflection.test.mjs`: with a fake client whose update mutation succeeds and whose second `boardColumns` call on the target shows a new board_relation, `probeReflection` returns `{ inPlace: true }`; with a fake where the target gains nothing, `{ inPlace: false }`.
- [ ] **Step 2: Run** `node --test scripts/test/probe-reflection.test.mjs` — expect FAIL (module missing).
- [ ] **Step 3: Implement `probeReflection`** using the `update_column` / `change_column_metadata` mutations (check `get_graphql_schema` for which exists); refuse to run unless the board id appears in `config/board-links.sandbox.json`.
- [ ] **Step 4: Run the test** — expect PASS.
- [ ] **Step 5: Run the probe against the sandbox** Donations "Donor" column (`node --env-file=.env scripts/probe-reflection.mjs --board <sandbox donations id> --column <id>`); copy the answer into the spec's open item 1 and commit in both repos.

### Task 2: `network` config section and pure planner

**Files:**
- Modify: `config/board-links.json`, `config/board-links.sandbox.json`, `scripts/lib/board-links.mjs`
- Create: `scripts/lib/network-links.mjs`, `scripts/test/network-links.test.mjs`

**Interfaces:**
- Produces: `validateConfig` also accepts `cfg.network: Array<{ a: string, b: string, aTitle: string, bTitle: string, replaces?: string }>` (`a`/`b` are CRM keys or board keys; `replaces` names an existing column title on `a` to supersede). `export function planNetwork(cfg, existingByBoard, targets): { create: Array<{ board: string, title: string, boardIds: number[], reflectionTitle: string }>, replace: Array<{ board, oldTitle, newTitle }>, reuse: string[], blocked: string[] }`.
- Consumes: `resolveTargets` and `connectTargets` from `scripts/provision-board-links.mjs` (export `connectTargets`).

- [ ] **Step 1: Write failing tests** in `network-links.test.mjs`: (a) a pair with no existing column yields one `create` with `allowCreateReflectionColumn` semantics and a `reflectionTitle`; (b) a pair whose `aTitle` already exists with matching targets yields `reuse`; (c) an existing column with other targets yields `replace` when `replaces` is set, else `blocked`; (d) a title collision on the target board (e.g. "Event" already on Sponsorships) is `blocked`; (e) `validateConfig` rejects a pair naming an unknown board.
- [ ] **Step 2: Run** `node --test scripts/test/network-links.test.mjs` — expect FAIL.
- [ ] **Step 3: Implement `planNetwork`** per the interface; extend `validateConfig`.
- [ ] **Step 4: Add the `network` array** to both config files from the spec's link matrix (production and sandbox ids), using titles from the spec; rerun tests — expect PASS.
- [ ] **Step 5: Commit** (`feat(board-links): declarative network link pairs`).

### Task 3: Provision the reflection pairs

**Files:**
- Modify: `scripts/provision-board-links.mjs`, `scripts/test/provision-board-links.test.mjs`

**Interfaces:**
- Consumes: `planNetwork` (Task 2).
- Produces: `--network` flag: prints and (with `--execute`) applies `create` entries via `create_column` with `defaults: { boardIds, allowMultipleItems: true, allowCreateReflectionColumn: true }`; if Task 1 found in-place works, also applies `reuse` upgrades via the probed mutation. Prints created ids as JSON for Task 4.

- [ ] **Step 1: Write failing test** that `main` in dry-run with `--network` lists planned creates and writes nothing (fake client records no mutation calls); and that a second planned run after creation reports zero creates.
- [ ] **Step 2: Run** `node --test scripts/test/provision-board-links.test.mjs` — expect FAIL.
- [ ] **Step 3: Wire `planNetwork` into `main`**; keep all existing behavior unchanged without `--network`.
- [ ] **Step 4: Run tests** — expect PASS. Then run `--network` dry-run against the sandbox and read the plan.
- [ ] **Step 5: Run `--network --execute` on the sandbox**, then again, expecting "create 0"; commit.

### Task 4: Replace-and-relink path and column-id reference report

Only needed for links where Task 1 says in-place is impossible.

**Files:**
- Create: `scripts/replace-connect-column.mjs`, `scripts/find-column-id-refs.mjs`, `scripts/test/replace-connect-column.test.mjs`, `scripts/test/find-column-id-refs.test.mjs`

**Interfaces:**
- Produces: `export async function copyLinks(client, boardId, oldColumnId, newColumnId): Promise<{ copied: number, skippedArchived: string[] }>` — reads every item's linked ids on the old column and writes them to the new one in batches of 25, never overwriting a non-empty value. `export function findRefs(roots: string[], columnIds: string[]): Array<{ file: string, line: number, id: string }>` — greps both repos' JSON/TS/MJS for the old ids.

- [ ] **Step 1: Write failing tests**: `copyLinks` copies two linked items, skips an archived link and lists it, leaves an already-filled new cell alone; `findRefs` finds an id in a config file and ignores `node_modules` and `data/`.
- [ ] **Step 2: Run** both test files — expect FAIL.
- [ ] **Step 3: Implement** both; `replace-connect-column.mjs` CLI creates the new column (via Task 3's plan), runs `copyLinks`, prints `findRefs` hits, and stops without deleting the old column.
- [ ] **Step 4: Run tests** — expect PASS.
- [ ] **Step 5: Rehearse on the sandbox** for one replaced column; confirm counts match; commit.

### Task 5: Backfill matched links

**Files:**
- Create: `scripts/backfill-network-links.mjs`, `scripts/test/backfill-network-links.test.mjs`
- Modify: `scripts/lib/match.mjs` only if a needed matcher is missing

**Interfaces:**
- Produces: `export function planBackfill(link: 'opportunity-people' | 'donation-event' | 'event-organization', sources, targets): { link: Array<{ itemId, targetIds }>, ambiguous: Array<{ itemId, reason, candidates }>, unmatched: string[] }`; CLI writes `backfill-<link>.csv` for ambiguous rows and prints linked / ambiguous / unmatched counts; `--execute` writes the links with the batch pattern of `link-board-items.mjs`.
- Consumes: `matchContact`, `normEmail` from `scripts/lib/match.mjs`.
- Rules: Opportunities → People by `Email` equal to a People email (exactly one hit); Donations → Events through the Event Registrations `Payment` link (exactly one event); Events → Organizations by sponsor names already recorded in sponsorship history (exact normalized org name, one hit).

- [ ] **Step 1: Write failing tests**: unique email links; two People with the same email is `ambiguous`; blank/malformed email is `unmatched`; a donation with two registrations for different events is `ambiguous`; a donation id that is archived is reported not linkable.
- [ ] **Step 2: Run** `node --test scripts/test/backfill-network-links.test.mjs` — expect FAIL.
- [ ] **Step 3: Implement `planBackfill` and the CLI**; never overwrite a non-empty connect value.
- [ ] **Step 4: Run tests** — expect PASS.
- [ ] **Step 5: Dry-run in the sandbox**, review the CSVs, `--execute`, re-run expecting 0 changes; commit.

### Task 6: Merge audit, mapping and item move

**Files:**
- Create: `scripts/audit-opportunity-columns.mjs`, `scripts/merge-opportunities.mjs`, `config/opportunities-merge.json`, `scripts/test/merge-opportunities.test.mjs`, `docs/opportunities-merge-runbook.md`

**Interfaces:**
- Produces: `config/opportunities-merge.json` `{ survivor: number, sources: Array<{ board: number, category: string, columnMap: Record<string,string>, statusMap: Record<string,string>, groupFrom: 'stage'|'year-event' }> }`; `export function planMove(sourceItems, mapping): { moves, unmappedColumns, unmappedStatuses }`; the audit prints, per source board, columns with no counterpart and status values with no mapping.
- `merge-opportunities.mjs --execute` uses `move_item_to_board` per item with the column mapping, sets Category, and verifies source count equals moved count.

- [ ] **Step 1: Write failing tests**: `planMove` maps a Sponsorships "Stage" value and a Grants "Status" value through `statusMap`; an unmapped status is reported, never dropped; Category is set from the source.
- [ ] **Step 2: Run** `node --test scripts/test/merge-opportunities.test.mjs` — expect FAIL.
- [ ] **Step 3: Implement the audit and `planMove`**; run the audit against the sandbox copies and write the first `columnMap`/`statusMap`. The stage vocabulary comes from #109; if undecided, map to the union and stop before production.
- [ ] **Step 4: Run tests** — expect PASS. Implement the `--execute` move with subitem/file/update preservation and the count check.
- [ ] **Step 5: In the runbook, list the UI steps** the API cannot do (recreate the Grants automations: Awarded → Kickoff meeting / Invoice funder / Final report subitems, the 1-week due-date reminder, status-to-group moves; item-view default tabs; board rename; making the old boards read-only).
- [ ] **Step 6: Rehearse on sandbox**: move, verify counts and inbound links from Invoicing Tasks, Bike Education Tracker and Comms/Marketing Requests; commit.

### Task 7: Rename, config and docs

**Files:**
- Modify: `config/board-links.json`, `config/board-links.sandbox.json` (collapse `grants-pipeline` and the sponsorship keys to one `opportunities` key; repoint dependents `invoicing-tasks`, `comms-requests`, `bike-education-lifecycle`), `docs/29-board-linking.md`, `docs/30-board-relationship-diagram.md`, `docs/38-*.md`, the protocols and Box Notes that name "Sponsorships" or "Grants & Contracts" (list via grep across `monday-migration`), and the `monday-workers` configs that name the boards (donation-rollups, benevity-import, eventbrite-sync, nearby-search) where an id or label changes.

- [ ] **Step 1: Write a failing test** in `board-links.test.mjs`: `validateConfig` accepts the new `opportunities` key and rejects a dependent that still targets a removed key.
- [ ] **Step 2: Run** `node --test scripts/test/board-links.test.mjs` — expect FAIL.
- [ ] **Step 3: Update configs and the schema check**; run — expect PASS.
- [ ] **Step 4: Update the docs/protocols** to the board name staff approved; run `find-column-id-refs` (Task 4) over both repos for any replaced column ids and fix each hit.
- [ ] **Step 5: In `monday-workers`, run `npm test` and `npm run typecheck`** inside each touched Worker, then `node scripts/check-log-safety.mjs`; commit per repo with conventional messages.

### Task 8: Sandbox rehearsal report and production runbook

**Files:**
- Create: `docs/opportunities-network-rehearsal.md` (planning repo), update `docs/opportunities-merge-runbook.md`

- [ ] **Step 1: Run the full sequence in the sandbox in order** — provision `--network`, replace-and-relink (if needed), backfill, merge — each dry-run then `--execute`, then again expecting zero changes.
- [ ] **Step 2: Write the rehearsal report**: counts before/after per board, backfill linked/ambiguous/unmatched per link, links verified in both directions (open a record on each of the five boards and confirm the reverse column lists it), and any UI steps still outstanding.
- [ ] **Step 3: Extend the runbook with the production order** and a rollback for each step (old columns and old boards are kept until verified); state the gate: Clarrissa's sign-off on name and stage vocabulary.
- [ ] **Step 4: Commit and send the report to the user for review.** Do not run any production `--execute` without their go-ahead.
