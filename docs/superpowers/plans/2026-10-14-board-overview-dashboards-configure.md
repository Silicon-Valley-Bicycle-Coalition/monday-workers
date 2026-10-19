# Board Overview Dashboards in `configure` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `salesforce-import configure` creates an **Overview** dashboard view on each of the 12 CRM boards, so the production cutover reproduces the sandbox dashboards by running a command.

**Architecture:** One `OVERVIEW_SPECS` table (new `overviewSpecs.ts`) names the widgets per board key. A pure planner resolves every widget against the board's live columns and refuses the whole Overview if any widget fails; an applier creates the view and its widgets in one pass, remembers them in `data/load/dashboards.json` under `overview:<board>`, adopts a hand-built Overview untouched, and replaces one only when asked. Widget resolution moves out of `dashboards.ts` into a shared `widgets.ts`. Two merge requests, B stacked on A.

**Tech Stack:** TypeScript (ES modules, strict, imports end in `.js`), Vitest 4, tsx, Node 26 (20+ supported), Monday GraphQL API version `2026-10`.

**Spec:** `docs/superpowers/specs/2026-10-14-board-overview-dashboards-configure-design.md` (this repo). The design it implements is `docs/31-board-dashboard-designs.md` in the private `monday-migration` repo, checked out beside this one.

## Global Constraints

- `$WS` is the workspace folder that holds `monday-workers`, both worktrees below and `monday-migration`: `export WS=/Users/dwk/Developer/gitlab.com/silicon-valley-bicycle-coalition`.
- All source paths below are relative to `salesforce-import/` in the worktree; `docs/…` paths are relative to the worktree root. Run tests with `npx vitest run <path>` and `npm run typecheck` from `salesforce-import/`.
- The view is named exactly `Overview` (`OVERVIEW_NAME`). State key is `overview:<board key>` in `data/load/dashboards.json`.
- **An Overview is created whole or not at all.** Widgets added to a board-view dashboard after it has been opened do not render. Every widget resolves before anything is written.
- `create_view` and `create_widget` go out with `{ idempotent: false, apiVersion: '2026-10' }` (`VIEW_API_VERSION`). Widget `settings` is a JSON object passed through GraphQL variables, never a string.
- A numeric widget filter value must be an array: `[0]`, never `0`. A bare number leaves the widget silently unfiltered.
- The Donations `Status = Received` rule applies to NUMBER, CHART and LISTVIEW widgets on Donations unless the widget sets `allStatuses: true`.
- Fiscal year runs July to June and is named by the calendar year it ends in (a gift on 2025-08-01 is FY2026). Labels are `FY` plus the year. The date is read in `America/Los_Angeles`. Never read the real clock in tests: inject `now`.
- The ordinary client and `MONDAY_API_TOKEN` are used for the Overview step. No dashboard-rights token.
- **Sandbox only.** Never run `configure` against production boards before the cutover. Confirm `config/svbc.json` `monday.workspaceId` is `17141226` and `data/load/boards.json` holds the `(sandbox v3)` ids before any live run.
- `scripts/check-log-safety.mjs` runs in the pre-commit hook and CI: no `console.*` call may log an email address.
- Conventional commits (`feat(configure): …`), each ending with the session's `Co-Authored-By` trailer. One agent per worktree, ever.
- No placeholders in the sandbox rehearsal: record real results in `docs/31` §9 in `monday-migration`.

## Review Focus

The inputs and failure modes the spec implies that most need a pinned test, most likely first. Each is pinned in the task named in brackets.

1. **A widget references a column or label that does not exist yet**, for example `FY2027` right after July 1 before `classify` has run. The Overview is refused, nothing is created, and `configure` exits non-zero. [A6 planner, A8 applier, B3 labels]
2. **A run killed between `create_view` and the last `create_widget`.** The next run must delete the half-built view and rebuild it whole, and must never leave or extend it. [A8]
3. **A refused plan next to an existing view.** The plan is computed before any delete, so a refusal never removes a view. [A8]
4. **A hand-built `Overview` that `configure` did not make** is adopted with no create, update or delete call. [A8]
5. **A run at 00:30 Pacific on July 1**, which is already July 1 in California but is June 30 in UTC for a few hours the day before. The label and range must follow Pacific time. [B2]
6. **`--rebuild-overviews` misuse:** no value, `all`, an unknown key, a key with no Overview spec. It exits 1 before any API call. [B9]
7. **Tiles that span every Status** (Pending, Needs a donor) must not get the Received rule. [B6]

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/configure/constants.ts` | create (A3) | `VIEW_API_VERSION`, shared without an import cycle |
| `src/configure/widgets.ts` | create (A3), extend (A4, A5, B3, B4, B5) | `WidgetSpec` and the pure resolvers `colId`, `widgetSettings`, `widgetFilter` |
| `src/configure/widgets.test.ts` | create (A4), extend | Resolver tests |
| `src/configure/dashboards.ts` | modify (A3) | Workspace dashboards only; imports the resolvers; exports `STATE_FILE` |
| `src/configure/overviews.ts` | create (A6, A8), extend (B9) | `planOverview`, `decideOverview`, `configureOverviews`, `overviewScope`, `parseRebuild` |
| `src/configure/overviews.test.ts` | create (A6, A8), extend | Planner, decision table, applier |
| `src/configure/overviewSpecs.ts` | create (A7), extend (B7, B8) | `OVERVIEW_SPECS`, `PROVISIONED_ELSEWHERE` |
| `src/configure/overviewSpecs.test.ts` | create (A7), extend | Spec consistency |
| `src/configure/fiscal.ts` | create (B2) | Fiscal label and range from an injected clock |
| `src/configure/fiscal.test.ts` | create (B2) | Fiscal tests |
| `src/configure/spec.ts` | modify (A2, B3, B6) | Find views; operator doc; `withReceivedRule` |
| `src/configure/index.ts` | modify (A3, A9, B9) | Wire the Overview step and flags into `runConfigure` |
| `README.md` | modify (A9, B10) | `configure` section |

---

# Merge request A — lookup boards (issue #51)

Branch `feat/configure-lookup-overviews`, worktree `$WS/monday-workers-overview-lookup` (already created, with `data/load/boards.json` and `extra-boards.json` copied in). The first commit on the branch is this spec and plan.

The spec's one MR A probe, what raw GraphQL reports as a Dashboard view's type, was run 2026-10-14 and is recorded in `docs/31` §9: it is `null`, so adoption matches on the view name only, as this plan implements. Nothing to probe here.

### Task A1: Worktree setup and baseline

**Files:** none (environment only)

- [ ] **Step 1: Install dependencies and the sandbox token**

```bash
cd "$WS/monday-workers-overview-lookup/salesforce-import"
npm ci
cp "$WS/monday-migration/.env" .env          # gitignored; MONDAY_API_TOKEN is the Sandbox Integration user
git status --short                         # expect: nothing (data/ and .env are ignored)
```

If `npm ci` fails inside the Claude Code sandbox for network reasons, rerun that one command with the sandbox off.

- [ ] **Step 2: Baseline**

Run: `npx vitest run src/configure && npm run typecheck`
Expected: all tests PASS, typecheck clean. If not, stop and report: the branch base is broken.

- [ ] **Step 3: Confirm the sandbox target**

```bash
python3 -c "import json;print(json.load(open('config/svbc.json'))['monday']['workspaceId'])"   # 17141226
python3 -c "import json;print(json.load(open('data/load/boards.json'))['organizations']['boardId'])"   # 18431577213
```

Expected: `17141226` and `18431577213`.

### Task A2: Find table views (#51 §1)

**Files:**
- Modify: `src/configure/spec.ts` (people-live line ~152, people-historical line ~211, organizations line ~237)
- Test: `src/configure/spec.test.ts`

**Interfaces:**
- Produces: first `views` entry of `people-live`, `people-historical` and `organizations` is a flat, unfiltered, ungrouped, Name-sorted `Reference` view.

- [ ] **Step 1: Write the failing test**

In `spec.test.ts`, inside `describe('BOARD_SPECS views', …)`, before `it('has the report replacements from the Salesforce usage survey'`:

```ts
  it('lookup boards open on a flat Find view, sorted by Name (#51)', () => {
    const first = (k: string) => BOARD_SPECS[k]!.views![0]!;
    expect(first('people-live').name).toBe('Find a person');
    expect(first('people-historical').name).toBe('Find a person');
    expect(first('organizations').name).toBe('Find an organization');
    for (const k of ['people-live', 'people-historical', 'organizations']) {
      const v = first(k);
      expect(v.tag, k).toBe('Reference');
      expect(v.filter, k).toBeUndefined();
      expect(v.groupBy, k).toBeUndefined();
      expect(v.sort, k).toEqual([{ columnTitle: 'Name' }]);
    }
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/configure/spec.test.ts -t "lookup boards"`
Expected: FAIL, `expected 'Donors' to be 'Find a person'`.

- [ ] **Step 3: Add the three views**

In `spec.ts`, people-live: replace the line `      { name: 'Donors', tag: 'Report',` with

```ts
      { name: 'Find a person', tag: 'Reference',
        columns: ['Personal Email', 'Phone', 'City', 'Organization', 'Membership Status', 'Donor Level'],
        sort: [{ columnTitle: 'Name' }] },
      { name: 'Donors', tag: 'Report',
```

people-historical: replace the line `      { name: 'People', tag: 'Reference', columns: ['Personal Email', 'City', 'Lifetime Giving', 'Last Gift Date'], sort: [{ columnTitle: 'Name' }] },` with

```ts
      { name: 'Find a person', tag: 'Reference', columns: ['Personal Email', 'Phone', 'City', 'Lifetime Giving', 'Last Gift Date'],
        sort: [{ columnTitle: 'Name' }] },
```

organizations: replace the line `      { name: 'Organizations', tag: 'Report', columns: ['Partner Type', 'City', 'Website', 'Lifetime Giving', 'Last Gift Date'],` with

```ts
      { name: 'Find an organization', tag: 'Reference', columns: ['Partner Type', 'City', 'Website', 'Phone', 'Donor Level'],
        sort: [{ columnTitle: 'Name' }] },
      { name: 'Organizations', tag: 'Report', columns: ['Partner Type', 'City', 'Website', 'Lifetime Giving', 'Last Gift Date'],
```

- [ ] **Step 4: Run the configure suite**

Run: `npx vitest run src/configure && npm run typecheck`
Expected: PASS (the existing "3–9 columns", "one tag", and "unique names" tests still hold).

- [ ] **Step 5: Commit**

```bash
git add src/configure/spec.ts src/configure/spec.test.ts
git commit -m "feat(configure): Find table views on People, People (Historical) and Organizations (#51)"
```

### Task A3: Extract the widget resolvers into `widgets.ts`

A pure move with no behaviour change, so the later tasks can share the resolvers. The existing `dashboards.test.ts` is the safety net.

**Files:**
- Create: `src/configure/constants.ts`, `src/configure/widgets.ts`
- Modify: `src/configure/dashboards.ts`, `src/configure/index.ts`

**Interfaces:**
- Produces: `VIEW_API_VERSION: string`; `WidgetSpec`; `Columns = Map<string, { boardId: number; columns: CurrentColumn[] }>`; `colId(columns, board, title): string | { error: string }`; `widgetSettings(w, columns): unknown | { error: string }`; `widgetFilter(w, columns): { operator: 'and'; rules: ResolvedRule[] } | undefined | { error: string }`; `STATE_FILE(): string`; `DashboardState` with optional `complete` and `adopted`.

- [ ] **Step 1: Create `constants.ts`**

```ts
// View mutations, and the board-view dashboards built on them, need API 2026-10; everything else
// stays on the client's pinned version. Lives here so index.ts and overviews.ts can share it
// without an import cycle.
export const VIEW_API_VERSION = '2026-10';
```

- [ ] **Step 2: Create `widgets.ts`** (the bodies are `dashboards.ts`'s, moved verbatim and exported)

```ts
import { resolveLabelId } from './labels.js';
import type { CurrentColumn, ResolvedRule } from './plan.js';
import type { FilterRule } from './spec.js';

export interface WidgetSpec {
  name: string;
  kind: 'CHART' | 'NUMBER';
  chart?: { board: string; graphType: string; x: string; xGroupBy: 'color' | 'date' | 'name' | 'group';
    dateGroupBy?: 'month' | 'quarter'; y: string | 'count'; z?: string };
  number?: { boards: string[]; column: string; counter: 'sum' | 'average'; prefix?: string; format?: 'currency' | 'number' };
  filter?: { board: string; rules: FilterRule[] };
}
export type Columns = Map<string, { boardId: number; columns: CurrentColumn[] }>;

export function colId(columns: Columns, board: string, title: string): string | { error: string } {
  const b = columns.get(board);
  if (!b) return { error: `board "${board}" has no id` };
  if (title === 'name') return 'name';
  const c = b.columns.find((x) => x.title === title);
  return c ? c.id : { error: `board "${board}" has no column "${title}"` };
}

export function widgetSettings(w: WidgetSpec, columns: Columns): unknown | { error: string } {
  if (w.chart) {
    const { board, graphType, x, xGroupBy, dateGroupBy, y, z } = w.chart;
    const boardId = String(columns.get(board)?.boardId);
    const xId = xGroupBy === 'group' ? 'group' : colId(columns, board, x);
    if (typeof xId !== 'string') return xId;
    const yId = y === 'count' ? 'default-label-count' : colId(columns, board, y);
    if (typeof yId !== 'string') return yId;
    const settings: Record<string, unknown> = { graph_type: graphType, x_axis_columns: { [boardId]: [xId] },
      y_axis_columns: { [boardId]: [yId] }, x_axis_group_by: xGroupBy,
      y_axis_group_by: y === 'count' ? 'default-label-count' : 'numeric' };
    if (y !== 'count') settings['calc_function_type'] = 'sum';
    if (dateGroupBy) settings['group_by'] = dateGroupBy;
    if (z) {
      const zId = colId(columns, board, z);
      if (typeof zId !== 'string') return zId;
      settings['z_axis_columns'] = { [boardId]: [zId] };
    }
    return settings;
  }
  const n = w.number!;
  const perBoard: Record<string, string[]> = {};
  for (const board of n.boards) {
    const id = colId(columns, board, n.column);
    if (typeof id !== 'string') return id;
    perBoard[String(columns.get(board)!.boardId)] = [id];
  }
  return {
    counter_data: { calculation_type: 'columns', counter_type: n.counter, column_ids_per_board: perBoard,
      ...(n.format === 'currency' ? { counter_unit: { symbol: '$', direction: 'left' } } : {}) },
    ...(n.prefix ? { prefix: n.prefix } : {}),
    number_format: n.format ?? 'number',
  };
}

export function widgetFilter(w: WidgetSpec, columns: Columns): { operator: 'and'; rules: ResolvedRule[] } | undefined | { error: string } {
  if (!w.filter) return undefined;
  const rules: ResolvedRule[] = [];
  for (const r of w.filter.rules) {
    const c = columns.get(w.filter.board)?.columns.find((x) => x.title === r.columnTitle);
    if (!c) return { error: `filter column "${r.columnTitle}" missing` };
    let compare_value: unknown = r.compareValue ?? [];
    if (r.labelValues) {
      const ids = r.labelValues.map((l) => resolveLabelId(c.type, c.settings_str, l));
      if (ids.some((i) => i === undefined)) return { error: `filter on "${r.columnTitle}" has an unknown label` };
      compare_value = ids;
    }
    rules.push({ column_id: c.id, operator: r.operator, compare_value });
  }
  return { operator: 'and', rules };
}
```

- [ ] **Step 3: Rewrite `dashboards.ts` to use them.** Replace the file's content from the top through the end of `widgetFilter` with:

```ts
import { existsSync } from 'node:fs';
import { dataPath, readJson, writeJson } from '../artifacts.js';
import type { MondayClient } from '../load/monday.js';
import type { CurrentColumn } from './plan.js';
import { DASHBOARD_SPECS } from './spec.js';
import type { ConfigureResult } from './index.js';
import { widgetFilter, widgetSettings, type Columns, type WidgetSpec } from './widgets.js';

export type { WidgetSpec } from './widgets.js';
export interface DashboardSpec { name: string; boards: string[]; widgets: WidgetSpec[] }
// `complete` and `adopted` are set only on `overview:<board>` entries (overviews.ts).
export type DashboardState = Record<string, { id: string; widgets: Record<string, string>; complete?: boolean; adopted?: boolean }>;

export const STATE_FILE = () => dataPath('load', 'dashboards.json');
```

Leave `planDashboard` and `configureDashboards` exactly as they are (they already call `widgetSettings`, `widgetFilter`, `STATE_FILE()`, and use the `Columns` type; the removed `resolveLabelId`, `ResolvedRule`, `FilterRule` imports are no longer needed there).

- [ ] **Step 4: Point `index.ts` at the shared constant.** In `src/configure/index.ts` add `import { VIEW_API_VERSION } from './constants.js';` after the `./dashboards.js` import, and delete the line `const VIEW_API_VERSION = '2026-10';` (keep the comment above it).

- [ ] **Step 5: Verify nothing changed**

Run: `npx vitest run src/configure && npm run typecheck`
Expected: PASS, same test count as Task A1's baseline plus A2's one.

- [ ] **Step 6: Commit**

```bash
git add src/configure
git commit -m "refactor(configure): move widget resolution into widgets.ts"
```

### Task A4: Count tiles and numeric filter arrays

**Files:**
- Modify: `src/configure/widgets.ts`, `src/configure/testFixtures.ts`
- Create: `src/configure/widgets.test.ts`

**Interfaces:**
- Consumes: `widgetSettings`, `widgetFilter`, `Columns`, `WidgetSpec` from Task A3.
- Produces: `WidgetSpec.number` becomes `{ boards: string[]; column?: string; count?: true; counter?: 'sum' | 'average'; prefix?; format? }`. A count widget resolves to `{ counter_data: { calculation_type: 'count', counter_type: 'sum', column_ids_per_board: { '<boardId>': [] }, should_count_items: true } }`. `widgetFilter` wraps a bare numeric `compareValue` into an array.

- [ ] **Step 1: Write the failing tests**

First add the shared column helper to `src/configure/testFixtures.ts` (append; keep `COLS`):

```ts
export const col = (id: string, title: string, type = 'numbers', settings_str = '{}'): CurrentColumn =>
  ({ id, title, type, description: null, settings_str });
```

Then create `src/configure/widgets.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { widgetFilter, widgetSettings, type Columns, type WidgetSpec } from './widgets.js';
import { col } from './testFixtures.js';

const COLUMNS: Columns = new Map([['people-live', { boardId: 20, columns: [
  col('name', 'Name', 'name'),
  col('ms', 'Membership Status', 'status', '{"labels":{"0":"Active","1":"Lapsed"}}'),
  col('tyc', 'This Year Count'),
  col('tya', 'This Year Amount'),
  col('mu', 'Member Until', 'date'),
] }]]);

describe('NUMBER count widgets', () => {
  it('counts items without naming a column', () => {
    const w: WidgetSpec = { name: 'Members', kind: 'NUMBER', number: { boards: ['people-live'], count: true } };
    expect(widgetSettings(w, COLUMNS)).toEqual({
      counter_data: { calculation_type: 'count', counter_type: 'sum', column_ids_per_board: { '20': [] }, should_count_items: true } });
  });

  it('errors on a count over a board with no id', () => {
    const w: WidgetSpec = { name: 'Members', kind: 'NUMBER', number: { boards: ['nope'], count: true } };
    expect(widgetSettings(w, COLUMNS)).toEqual({ error: 'board "nope" has no id' });
  });

  it('errors when a number widget has neither a column nor count', () => {
    const w: WidgetSpec = { name: 'Broken', kind: 'NUMBER', number: { boards: ['people-live'] } };
    expect(widgetSettings(w, COLUMNS)).toEqual({ error: 'number widget "Broken" needs a column or count' });
  });

  it('still sums a column exactly as before', () => {
    const w: WidgetSpec = { name: 'Raised', kind: 'NUMBER', number: { boards: ['people-live'], column: 'This Year Amount', counter: 'sum', format: 'currency' } };
    expect(widgetSettings(w, COLUMNS)).toEqual({ counter_data: { calculation_type: 'columns', counter_type: 'sum',
      column_ids_per_board: { '20': ['tya'] }, counter_unit: { symbol: '$', direction: 'left' } }, number_format: 'currency' });
  });
});

describe('widget filter compare values', () => {
  const f = (rules: NonNullable<WidgetSpec['filter']>['rules']) =>
    widgetFilter({ name: 'x', kind: 'NUMBER', number: { boards: ['people-live'], count: true }, filter: { board: 'people-live', rules } }, COLUMNS);

  it('wraps a bare number into an array, because a bare number leaves the widget unfiltered (#51)', () => {
    expect(f([{ columnTitle: 'This Year Count', operator: 'greater_than', compareValue: 0 }]))
      .toEqual({ operator: 'and', rules: [{ column_id: 'tyc', operator: 'greater_than', compare_value: [0] }] });
  });

  it('leaves arrays and the empty default alone', () => {
    expect(f([{ columnTitle: 'Member Until', operator: 'within_the_next', compareValue: ['DAYS', 60] }, { columnTitle: 'Membership Status', operator: 'is_empty' }]))
      .toEqual({ operator: 'and', rules: [
        { column_id: 'mu', operator: 'within_the_next', compare_value: ['DAYS', 60] },
        { column_id: 'ms', operator: 'is_empty', compare_value: [] }] });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/configure/widgets.test.ts`
Expected: FAIL (the count test returns column maths; the array test returns `compare_value: 0`).

- [ ] **Step 3: Implement.** In `widgets.ts` change the `number` type to

```ts
  number?: { boards: string[]; column?: string; count?: true; counter?: 'sum' | 'average'; prefix?: string; format?: 'currency' | 'number' };
```

and replace `  const n = w.number!;\n  const perBoard: Record<string, string[]> = {};\n  for (const board of n.boards) {\n    const id = colId(columns, board, n.column);` with

```ts
  const n = w.number;
  if (!n) return { error: `widget "${w.name}" needs a chart or number definition` };
  if (n.count) {
    const countPerBoard: Record<string, string[]> = {};
    for (const board of n.boards) {
      const b = columns.get(board);
      if (!b) return { error: `board "${board}" has no id` };
      countPerBoard[String(b.boardId)] = [];
    }
    return { counter_data: { calculation_type: 'count', counter_type: 'sum', column_ids_per_board: countPerBoard, should_count_items: true } };
  }
  if (!n.column) return { error: `number widget "${w.name}" needs a column or count` };
  const perBoard: Record<string, string[]> = {};
  for (const board of n.boards) {
    const id = colId(columns, board, n.column);
```

Change `counter_type: n.counter,` to `counter_type: n.counter ?? 'sum',`.

In `widgetFilter`, after `let compare_value: unknown = r.compareValue ?? [];` add:

```ts
    // Widgets silently ignore a bare numeric compare value (#51): always send an array.
    if (typeof compare_value === 'number') compare_value = [compare_value];
```

- [ ] **Step 4: Run**

Run: `npx vitest run src/configure && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/configure/widgets.ts src/configure/widgets.test.ts src/configure/testFixtures.ts
git commit -m "feat(configure): count tiles, and numeric filter values always sent as arrays"
```

### Task A5: LISTVIEW widget

**Files:**
- Modify: `src/configure/widgets.ts`
- Test: `src/configure/widgets.test.ts`

**Interfaces:**
- Produces: `WidgetSpec.kind` includes `'LISTVIEW'`; `WidgetSpec.list?: { board: string; columns: string[] }`. Settings: `{ order_columns: ['name', ...ids], show_hide_columns: <every other column id>, item_height: 'single', is_docked: true }`.

- [ ] **Step 1: Write the failing test.** Append to `widgets.test.ts`:

```ts
describe('LISTVIEW widgets', () => {
  const list = (columns: string[]): WidgetSpec => ({ name: 'Find', kind: 'LISTVIEW', list: { board: 'people-live', columns } });

  it('orders the named columns after Name and hides every other column', () => {
    expect(widgetSettings(list(['Membership Status', 'This Year Amount']), COLUMNS)).toEqual({
      order_columns: ['name', 'ms', 'tya'], show_hide_columns: ['tyc', 'mu'], item_height: 'single', is_docked: true });
  });

  it('errors on an unknown column or board', () => {
    expect(widgetSettings(list(['Nope']), COLUMNS)).toEqual({ error: 'board "people-live" has no column "Nope"' });
    expect(widgetSettings({ name: 'x', kind: 'LISTVIEW', list: { board: 'nope', columns: [] } }, COLUMNS)).toEqual({ error: 'board "nope" has no id' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/configure/widgets.test.ts -t LISTVIEW`
Expected: FAIL.

- [ ] **Step 3: Implement.** In `widgets.ts` widen `kind` to `'CHART' | 'NUMBER' | 'LISTVIEW'`, add `list?: { board: string; columns: string[] };` to `WidgetSpec`, and insert before `const n = w.number;`:

```ts
  if (w.list) {
    const b = columns.get(w.list.board);
    if (!b) return { error: `board "${w.list.board}" has no id` };
    const shown: string[] = [];
    for (const title of w.list.columns) {
      const id = colId(columns, w.list.board, title);
      if (typeof id !== 'string') return id;
      if (!shown.includes(id)) shown.push(id);
    }
    const hidden = b.columns.map((c) => c.id).filter((id) => id !== 'name' && !shown.includes(id));
    return { order_columns: ['name', ...shown], show_hide_columns: hidden, item_height: 'single', is_docked: true };
  }
```

- [ ] **Step 4: Run**

Run: `npx vitest run src/configure && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/configure/widgets.ts src/configure/widgets.test.ts
git commit -m "feat(configure): LISTVIEW widget settings"
```

### Task A6: The all-or-nothing planner

**Files:**
- Create: `src/configure/overviews.ts`, `src/configure/overviews.test.ts`

**Interfaces:**
- Consumes: `widgetSettings`, `widgetFilter`, `Columns`, `WidgetSpec` (A3–A5).
- Produces: `OVERVIEW_NAME = 'Overview'`; `OverviewSpec { widgets: WidgetSpec[] }`; `PlannedWidget { name; kind: WidgetSpec['kind']; settings: unknown; filter?: unknown }`; `OverviewPlan = { ok: true; widgets: PlannedWidget[] } | { ok: false; errors: string[] }`; `planOverview(spec: OverviewSpec, columns: Columns): OverviewPlan`.

- [ ] **Step 1: Write the failing tests.** Create `overviews.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { planOverview, type OverviewSpec } from './overviews.js';
import type { Columns } from './widgets.js';
import { col } from './testFixtures.js';

const COLS = [
  col('name', 'Name', 'name'),
  col('ms', 'Membership Status', 'status', '{"labels":{"0":"Active","1":"Lapsed"}}'),
  col('tya', 'This Year Amount'),
];
const COLUMNS: Columns = new Map([['people-live', { boardId: 20, columns: COLS }]]);
const SPEC: OverviewSpec = { widgets: [
  { name: 'Active members', kind: 'NUMBER', number: { boards: ['people-live'], count: true },
    filter: { board: 'people-live', rules: [{ columnTitle: 'Membership Status', operator: 'any_of', labelValues: ['Active'] }] } },
  { name: 'Raised this FY', kind: 'NUMBER', number: { boards: ['people-live'], column: 'This Year Amount', counter: 'sum', format: 'currency' } },
  { name: 'Members by status', kind: 'CHART', chart: { board: 'people-live', graphType: 'pie', x: 'Membership Status', xGroupBy: 'color', y: 'count' } },
] };

describe('planOverview', () => {
  it('resolves every widget in spec order, with its filter', () => {
    const plan = planOverview(SPEC, COLUMNS);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.widgets.map((w) => w.name)).toEqual(['Active members', 'Raised this FY', 'Members by status']);
    expect(plan.widgets[0]!.filter).toEqual({ operator: 'and', rules: [{ column_id: 'ms', operator: 'any_of', compare_value: [0] }] });
    expect(plan.widgets[1]!.filter).toBeUndefined();
  });

  it('refuses the whole Overview when one widget cannot resolve (an Overview is created whole or not at all)', () => {
    const cols: Columns = new Map([['people-live', { boardId: 20, columns: COLS.filter((c) => c.title !== 'This Year Amount') }]]);
    const plan = planOverview(SPEC, cols);
    expect(plan).toEqual({ ok: false, errors: ['widget "Raised this FY": board "people-live" has no column "This Year Amount"'] });
  });

  it('refuses an unknown label, naming the widget', () => {
    const spec: OverviewSpec = { widgets: [{ name: 'Gone', kind: 'NUMBER', number: { boards: ['people-live'], count: true },
      filter: { board: 'people-live', rules: [{ columnTitle: 'Membership Status', operator: 'any_of', labelValues: ['Nope'] }] } }] };
    const plan = planOverview(spec, COLUMNS);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.errors[0]).toMatch(/widget "Gone".*unknown label/);
  });

  it('refuses duplicate widget names, which would collide in the state file', () => {
    const plan = planOverview({ widgets: [SPEC.widgets[0]!, SPEC.widgets[0]!] }, COLUMNS);
    expect(plan).toEqual({ ok: false, errors: ['duplicate widget name "Active members"'] });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/configure/overviews.test.ts`
Expected: FAIL, cannot resolve `./overviews.js`.

- [ ] **Step 3: Implement.** Create `overviews.ts`:

```ts
import { widgetFilter, widgetSettings, type Columns, type WidgetSpec } from './widgets.js';

export const OVERVIEW_NAME = 'Overview';

export interface OverviewSpec { widgets: WidgetSpec[] }
export interface PlannedWidget { name: string; kind: WidgetSpec['kind']; settings: unknown; filter?: unknown }
export type OverviewPlan = { ok: true; widgets: PlannedWidget[] } | { ok: false; errors: string[] };

const isError = (v: unknown): v is { error: string } => typeof v === 'object' && v !== null && 'error' in v;

// An Overview is created whole or not at all: widgets added to a board-view dashboard after it has
// been opened do not render, so a half-resolvable spec must not produce a half-built view.
export function planOverview(spec: OverviewSpec, columns: Columns): OverviewPlan {
  const widgets: PlannedWidget[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const w of spec.widgets) {
    if (seen.has(w.name)) { errors.push(`duplicate widget name "${w.name}"`); continue; }
    seen.add(w.name);
    const settings = widgetSettings(w, columns);
    if (isError(settings)) { errors.push(`widget "${w.name}": ${settings.error}`); continue; }
    const filter = widgetFilter(w, columns);
    if (isError(filter)) { errors.push(`widget "${w.name}": ${filter.error}`); continue; }
    widgets.push({ name: w.name, kind: w.kind, settings, ...(filter ? { filter } : {}) });
  }
  return errors.length ? { ok: false, errors } : { ok: true, widgets };
}
```

- [ ] **Step 4: Run**

Run: `npx vitest run src/configure/overviews.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/configure/overviews.ts src/configure/overviews.test.ts
git commit -m "feat(configure): all-or-nothing Overview planner"
```

### Task A7: Overview specs for People and Organizations (as built) and spec consistency tests

The widget sets are exactly #51 §2, the ones built by hand on the sandbox on 2026-10-09.

**Files:**
- Create: `src/configure/overviewSpecs.ts`, `src/configure/overviewSpecs.test.ts`

**Interfaces:**
- Consumes: `OverviewSpec` (A6), `WidgetSpec`, `FilterRule` (`spec.ts`).
- Produces: `OVERVIEW_SPECS: Record<string, OverviewSpec>` with keys `people-live` and `organizations`; `PROVISIONED_ELSEWHERE: Record<string, string[]>`.

- [ ] **Step 1: Write the failing tests.** Create `overviewSpecs.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { OVERVIEW_SPECS, PROVISIONED_ELSEWHERE } from './overviewSpecs.js';
import { BOARD_SPECS } from './spec.js';
import { COLUMN_TYPES, CONNECT_COLUMNS } from '../load/boards.js';
import type { WidgetSpec } from './widgets.js';

const boardsOf = (w: WidgetSpec): string[] => [
  ...(w.chart ? [w.chart.board] : []), ...(w.number?.boards ?? []), ...(w.list ? [w.list.board] : []),
  ...(w.filter ? [w.filter.board] : []),
];
const columnTitlesOf = (w: WidgetSpec): string[] => {
  const t: string[] = [];
  if (w.chart) { t.push(w.chart.x); if (w.chart.y !== 'count') t.push(w.chart.y); if (w.chart.z) t.push(w.chart.z); }
  if (w.number?.column) t.push(w.number.column);
  if (w.list) t.push(...w.list.columns);
  for (const r of w.filter?.rules ?? []) t.push(r.columnTitle);
  return t.filter((x) => x !== 'name');
};
const known = (board: string) => new Set<string>([
  ...Object.keys(COLUMN_TYPES), ...CONNECT_COLUMNS,
  ...(BOARD_SPECS[board]?.columns ?? []).map((c) => c.title), ...(PROVISIONED_ELSEWHERE[board] ?? []),
]);

describe('OVERVIEW_SPECS', () => {
  const entries = Object.entries(OVERVIEW_SPECS);

  it('has an Overview for the lookup boards', () => {
    expect(Object.keys(OVERVIEW_SPECS)).toEqual(expect.arrayContaining(['people-live', 'organizations']));
  });

  it('names widgets uniquely per board', () => {
    for (const [board, s] of entries) {
      const names = s.widgets.map((w) => w.name);
      expect(new Set(names).size, board).toBe(names.length);
    }
  });

  it('every widget names only its own board', () => {
    for (const [board, s] of entries) for (const w of s.widgets) for (const b of boardsOf(w)) expect(b, `${board} / ${w.name}`).toBe(board);
  });

  it('every column title a widget uses is known to this repo or listed as provisioned elsewhere', () => {
    for (const [board, s] of entries) {
      const ok = known(board);
      for (const w of s.widgets) for (const title of columnTitlesOf(w)) expect(ok.has(title), `${board} / ${w.name} / ${title}`).toBe(true);
    }
  });

  it('keeps the as-built widget sets from #51', () => {
    expect(OVERVIEW_SPECS['people-live']!.widgets.map((w) => w.name)).toEqual(expect.arrayContaining(
      ['Active members', 'Memberships ending in 60 days', 'Donors this FY', 'Raised this FY', 'Donors by level', 'Members by status',
        'Find a person', 'Leadership and major donors']));
    expect(OVERVIEW_SPECS['organizations']!.widgets.map((w) => w.name)).toEqual(expect.arrayContaining(
      ['Organizations giving this FY', 'Raised this FY', 'Organizations by donor level', 'Find an organization', 'Funders and matching companies']));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/configure/overviewSpecs.test.ts`
Expected: FAIL, cannot resolve `./overviewSpecs.js`.

- [ ] **Step 3: Implement.** Create `overviewSpecs.ts`:

```ts
import type { OverviewSpec } from './overviews.js';
import type { FilterRule } from './spec.js';
import type { WidgetSpec } from './widgets.js';

// Overview dashboard views (docs/31 in the private planning repo; spec 2026-10-14). Columns are
// referred to by title and resolved to ids at apply time. Each Overview reads only its own board.

// Rollup columns the donation-rollups scripts create (setup-owner-columns.mjs,
// setup-classification-columns.mjs). This repo can't see them statically, so the spec-consistency
// test takes them from here.
export const PROVISIONED_ELSEWHERE: Record<string, string[]> = {
  'people-live': ['Donor Level', 'This Year Count', 'This Year Amount', 'Last Year Amount', 'Last Gift Date', 'Last Gift Amount'],
  organizations: ['Donor Level', 'This Year Count', 'This Year Amount', 'Last Year Amount', 'Last Gift Date'],
};

const is = (columnTitle: string, ...labelValues: string[]): FilterRule => ({ columnTitle, operator: 'any_of', labelValues });
const gt0 = (columnTitle: string): FilterRule => ({ columnTitle, operator: 'greater_than', compareValue: [0] });
const filterOn = (board: string, rules: FilterRule[]) => (rules.length ? { filter: { board, rules } } : {});

const count = (name: string, board: string, rules: FilterRule[] = []): WidgetSpec =>
  ({ name, kind: 'NUMBER', number: { boards: [board], count: true }, ...filterOn(board, rules) });
const sum = (name: string, board: string, column: string, rules: FilterRule[] = []): WidgetSpec =>
  ({ name, kind: 'NUMBER', number: { boards: [board], column, counter: 'sum', format: 'currency' }, ...filterOn(board, rules) });
const list = (name: string, board: string, columns: string[], rules: FilterRule[] = []): WidgetSpec =>
  ({ name, kind: 'LISTVIEW', list: { board, columns }, ...filterOn(board, rules) });
const pie = (name: string, board: string, x: string, rules: FilterRule[] = []): WidgetSpec =>
  ({ name, kind: 'CHART', chart: { board, graphType: 'pie', x, xGroupBy: 'color', y: 'count' }, ...filterOn(board, rules) });

export const OVERVIEW_SPECS: Record<string, OverviewSpec> = {
  'people-live': { widgets: [
    count('Active members', 'people-live', [is('Membership Status', 'Active')]),
    count('Memberships ending in 60 days', 'people-live',
      [is('Membership Status', 'Active'), { columnTitle: 'Member Until', operator: 'within_the_next', compareValue: ['DAYS', 60] }]),
    count('Donors this FY', 'people-live', [gt0('This Year Count')]),
    sum('Raised this FY', 'people-live', 'This Year Amount'),
    pie('Donors by level', 'people-live', 'Donor Level'),
    pie('Members by status', 'people-live', 'Membership Status'),
    list('Find a person', 'people-live', ['Personal Email', 'Phone', 'City', 'Organization', 'Membership Status', 'Donor Level']),
    list('Leadership and major donors', 'people-live',
      ['Donor Level', 'Lifetime Giving', 'Last Gift Date', 'Last Gift Amount', 'Personal Email', 'Phone'],
      [is('Donor Level', 'Leadership', 'Major')]),
  ] },
  organizations: { widgets: [
    count('Organizations giving this FY', 'organizations', [gt0('This Year Count')]),
    sum('Raised this FY', 'organizations', 'This Year Amount'),
    pie('Organizations by donor level', 'organizations', 'Donor Level'),
    list('Find an organization', 'organizations', ['Partner Type', 'City', 'Website', 'Phone', 'Donor Level']),
    list('Funders and matching companies', 'organizations',
      ['Partner Type', 'Lifetime Giving', 'Last Gift Date', 'This Year Amount', 'Donor Level'], [gt0('Lifetime Giving')]),
  ] },
};
```

- [ ] **Step 4: Run**

Run: `npx vitest run src/configure && npm run typecheck`
Expected: PASS. If the known-columns test names a column, it is missing from `COLUMN_TYPES`, `CONNECT_COLUMNS`, the board's `BoardSpec.columns` and `PROVISIONED_ELSEWHERE`: add it to `PROVISIONED_ELSEWHERE` only if a `donation-rollups` script creates it, otherwise fix the typo.

- [ ] **Step 5: Commit**

```bash
git add src/configure/overviewSpecs.ts src/configure/overviewSpecs.test.ts
git commit -m "feat(configure): Overview specs for People and Organizations at their as-built widget sets"
```

### Task A8: The applier — decision table, create, adopt, repair

**Files:**
- Modify: `src/configure/overviews.ts`
- Test: `src/configure/overviews.test.ts`

**Interfaces:**
- Consumes: `planOverview`, `OverviewSpec`, `PlannedWidget` (A6); `OVERVIEW_SPECS` (A7); `STATE_FILE`, `DashboardState` (A3); `VIEW_API_VERSION` (A3); `Columns` (A3); `ConfigureResult` from `./index.js` (type only).
- Produces:
  - `OverviewAction = { kind: 'create' } | { kind: 'adopt'; viewId: string } | { kind: 'replace'; viewId: string; why: 'half-built' } | { kind: 'leave'; note?: string }`
  - `decideOverview(input: { entry?: DashboardState[string]; viewId?: string; specNames: string[] }): OverviewAction`
  - `configureOverviews(client: MondayClient, boardIds: Record<string, number>, dryRun: boolean, specs?: Record<string, OverviewSpec>, opts?: { only?: string[] }): Promise<ConfigureResult>`

- [ ] **Step 1: Write the failing decision-table tests.** Append to `overviews.test.ts`:

```ts
import { decideOverview } from './overviews.js';

describe('decideOverview', () => {
  const names = ['A', 'B'];
  it('creates when the board has no Overview, even if state remembers one (stale)', () => {
    expect(decideOverview({ specNames: names })).toEqual({ kind: 'create' });
    expect(decideOverview({ entry: { id: 'v1', widgets: {}, complete: true }, specNames: names })).toEqual({ kind: 'create' });
  });
  it('adopts an Overview that state does not know, or knows under a different id', () => {
    expect(decideOverview({ viewId: 'v7', specNames: names })).toEqual({ kind: 'adopt', viewId: 'v7' });
    expect(decideOverview({ entry: { id: 'v1', widgets: {}, complete: true }, viewId: 'v7', specNames: names })).toEqual({ kind: 'adopt', viewId: 'v7' });
  });
  it('leaves an adopted or complete Overview alone', () => {
    expect(decideOverview({ entry: { id: 'v7', widgets: {}, adopted: true }, viewId: 'v7', specNames: names })).toEqual({ kind: 'leave' });
    expect(decideOverview({ entry: { id: 'v7', widgets: { A: 'w1', B: 'w2' }, complete: true }, viewId: 'v7', specNames: names })).toEqual({ kind: 'leave' });
  });
  it('replaces a half-built view that configure itself made', () => {
    expect(decideOverview({ entry: { id: 'v7', widgets: { A: 'w1' } }, viewId: 'v7', specNames: names })).toEqual({ kind: 'replace', viewId: 'v7', why: 'half-built' });
  });
  it('reports, and changes nothing, when a complete Overview is behind the spec', () => {
    const a = decideOverview({ entry: { id: 'v7', widgets: { A: 'w1' }, complete: true }, viewId: 'v7', specNames: names });
    expect(a.kind).toBe('leave');
    expect((a as { note?: string }).note).toMatch(/behind the spec \(missing: B\)/);
  });
});
```

- [ ] **Step 2: Write the failing applier tests.** Append to `overviews.test.ts`:

```ts
import { beforeEach } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureOverviews } from './overviews.js';
import { dataPath, readJson, writeJson } from '../artifacts.js';
import type { DashboardState } from './dashboards.js';
import type { MondayClient } from '../load/monday.js';

type Call = { query: string; variables: Record<string, unknown>; opts?: { idempotent?: boolean; apiVersion?: string } };
const BOARD_IDS = { 'people-live': 20 };
const SPECS = { 'people-live': SPEC };
const STATE = () => dataPath('load', 'dashboards.json');
const KEY = 'overview:people-live';

function fake(o: { views?: { id: string; name: string }[]; failOnWidget?: number; columns?: typeof COLS } = {}) {
  const calls: Call[] = [];
  const views = [...(o.views ?? [])];
  let widgets = 0;
  let viewSeq = 100;
  const client = { async gql(query: string, variables: Record<string, unknown> = {}, opts?: Call['opts']) {
    calls.push({ query, variables, opts });
    if (/^\s*query/.test(query)) return { boards: [{ columns: o.columns ?? COLS, views }] };
    if (/create_view/.test(query)) { const id = String(++viewSeq); views.push({ id, name: String(variables['name']) }); return { create_view: { id } }; }
    if (/delete_view/.test(query)) { const i = views.findIndex((v) => v.id === variables['view']); if (i >= 0) views.splice(i, 1); return { delete_view: { id: variables['view'] } }; }
    if (/create_widget/.test(query)) { widgets++; if (widgets === o.failOnWidget) throw new Error('boom'); return { create_widget: { id: `w${widgets}` } }; }
    throw new Error('unexpected ' + query);
  } } as unknown as MondayClient;
  return { client, calls, mutations: () => calls.filter((c) => /^\s*mutation/.test(c.query)) };
}

describe('configureOverviews', () => {
  beforeEach(() => { process.chdir(mkdtempSync(join(tmpdir(), 'sfimp-'))); });

  it('creates the view and every widget in order, as non-idempotent writes on API 2026-10, and records state', async () => {
    const f = fake();
    const r = await configureOverviews(f.client, BOARD_IDS, false, SPECS);
    expect(r.ok).toBe(true);
    const m = f.mutations();
    expect(m.map((c) => (/create_view/.test(c.query) ? 'view' : String(c.variables['name'])))).toEqual(['view', 'Active members', 'Raised this FY', 'Members by status']);
    for (const c of m) expect(c.opts).toEqual({ idempotent: false, apiVersion: '2026-10' });
    expect(m[1]!.variables['parent']).toEqual({ kind: 'BOARD_VIEW', id: '101' });
    expect((await readJson<DashboardState>(STATE()))[KEY]).toEqual(
      { id: '101', widgets: { 'Active members': 'w1', 'Raised this FY': 'w2', 'Members by status': 'w3' }, complete: true });
  });

  it('dry-run makes no mutations and writes no state', async () => {
    const f = fake();
    const r = await configureOverviews(f.client, BOARD_IDS, true, SPECS);
    expect(r.summary).toMatch(/would create Overview on people-live \(3 widgets\)/);
    expect(f.mutations()).toEqual([]);
    expect(existsSync(STATE())).toBe(false);
  });

  it('a second run creates nothing', async () => {
    await configureOverviews(fake().client, BOARD_IDS, false, SPECS);
    const again = fake({ views: [{ id: '101', name: 'Overview' }] });
    const r = await configureOverviews(again.client, BOARD_IDS, false, SPECS);
    expect(again.mutations()).toEqual([]);
    expect(r.summary).toBe('overviews up to date');
  });

  it('refuses when a widget cannot resolve: nothing is created, ok is false, the note says why (D1, D9)', async () => {
    const f = fake({ columns: COLS.filter((c) => c.title !== 'This Year Amount') });
    const r = await configureOverviews(f.client, BOARD_IDS, false, SPECS);
    expect(f.mutations()).toEqual([]);
    expect(r.ok).toBe(false);
    expect(r.notes.join()).toMatch(/people-live: Overview not created — widget "Raised this FY"/);
  });

  it('a refusal never deletes an existing half-built view', async () => {
    await writeJson(STATE(), { [KEY]: { id: 'v9', widgets: { 'Active members': 'w1' } } });
    const f = fake({ views: [{ id: 'v9', name: 'Overview' }], columns: COLS.filter((c) => c.title !== 'This Year Amount') });
    const r = await configureOverviews(f.client, BOARD_IDS, false, SPECS);
    expect(f.mutations()).toEqual([]);
    expect(r.ok).toBe(false);
  });

  it('adopts a hand-built Overview with no create, update or delete call', async () => {
    const f = fake({ views: [{ id: 'v7', name: 'Overview' }] });
    const r = await configureOverviews(f.client, BOARD_IDS, false, SPECS);
    expect(f.mutations()).toEqual([]);
    expect(r.summary).toMatch(/adopted existing Overview on people-live/);
    expect((await readJson<DashboardState>(STATE()))[KEY]).toEqual({ id: 'v7', widgets: {}, adopted: true });
  });

  it('replaces a half-built leftover whole: delete first, then create everything', async () => {
    await writeJson(STATE(), { [KEY]: { id: 'v9', widgets: { 'Active members': 'w1' } } });
    const f = fake({ views: [{ id: 'v9', name: 'Overview' }] });
    await configureOverviews(f.client, BOARD_IDS, false, SPECS);
    const m = f.mutations();
    expect(m.map((c) => (/delete_view/.test(c.query) ? 'delete' : /create_view/.test(c.query) ? 'view' : 'widget'))).toEqual(['delete', 'view', 'widget', 'widget', 'widget']);
    expect(m[0]!.variables).toEqual({ view: 'v9', board: '20' });
    expect((await readJson<DashboardState>(STATE()))[KEY]!.complete).toBe(true);
  });

  it('a run killed mid-way leaves state incomplete, and the next run rebuilds whole (Review Focus 2)', async () => {
    const failing = fake({ failOnWidget: 2 });
    await expect(configureOverviews(failing.client, BOARD_IDS, false, SPECS)).rejects.toThrow('boom');
    expect((await readJson<DashboardState>(STATE()))[KEY]).toEqual({ id: '101', widgets: { 'Active members': 'w1' } });

    const retry = fake({ views: [{ id: '101', name: 'Overview' }] });
    await configureOverviews(retry.client, BOARD_IDS, false, SPECS);
    expect(retry.mutations().map((c) => (/delete_view/.test(c.query) ? 'delete' : /create_view/.test(c.query) ? 'view' : 'widget'))).toEqual(['delete', 'view', 'widget', 'widget', 'widget']);
  });

  it('forgets stale state when the view is gone, and creates fresh without a delete', async () => {
    await writeJson(STATE(), { [KEY]: { id: 'v9', widgets: { 'Active members': 'w1' }, complete: true } });
    const f = fake();
    await configureOverviews(f.client, BOARD_IDS, false, SPECS);
    expect(f.mutations().some((c) => /delete_view/.test(c.query))).toBe(false);
    expect((await readJson<DashboardState>(STATE()))[KEY]!.id).toBe('101');
  });

  it('reports a complete Overview that is behind the spec and changes nothing', async () => {
    await writeJson(STATE(), { [KEY]: { id: 'v9', widgets: { 'Active members': 'w1' }, complete: true } });
    const f = fake({ views: [{ id: 'v9', name: 'Overview' }] });
    const r = await configureOverviews(f.client, BOARD_IDS, false, SPECS);
    expect(f.mutations()).toEqual([]);
    expect(r.notes.join()).toMatch(/people-live: Overview is behind the spec \(missing: Raised this FY, Members by status\)/);
  });

  it('skips a board with no id, with a note', async () => {
    const f = fake();
    const r = await configureOverviews(f.client, {}, false, SPECS);
    expect(f.calls).toEqual([]);
    expect(r.notes.join()).toMatch(/people-live: no board id/);
  });

  it('--only scopes to the named boards', async () => {
    const f = fake();
    await configureOverviews(f.client, BOARD_IDS, false, SPECS, { only: ['organizations'] });
    expect(f.calls).toEqual([]);
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run src/configure/overviews.test.ts`
Expected: FAIL, `decideOverview` and `configureOverviews` are not exported.

- [ ] **Step 4: Implement.** Replace the imports at the top of `overviews.ts` with:

```ts
import { existsSync } from 'node:fs';
import { readJson, writeJson } from '../artifacts.js';
import type { MondayClient } from '../load/monday.js';
import { VIEW_API_VERSION } from './constants.js';
import { STATE_FILE, type DashboardState } from './dashboards.js';
import type { ConfigureResult } from './index.js';
import { OVERVIEW_SPECS } from './overviewSpecs.js';
import type { CurrentColumn } from './plan.js';
import { widgetFilter, widgetSettings, type Columns, type WidgetSpec } from './widgets.js';
```

and append:

```ts
export type OverviewAction =
  | { kind: 'create' }                                     // no Overview on the board (any state entry is stale)
  | { kind: 'adopt'; viewId: string }                      // an Overview configure did not make: leave it, remember it
  | { kind: 'replace'; viewId: string; why: 'half-built' } // delete, then create whole
  | { kind: 'leave'; note?: string };

export interface DecideInput { entry?: DashboardState[string]; viewId?: string; specNames: string[] }

// The Overview on a board is found by name alone: the API reports a null type for dashboard views.
export function decideOverview({ entry, viewId, specNames }: DecideInput): OverviewAction {
  if (!viewId) return { kind: 'create' };
  if (!entry || entry.id !== viewId) return { kind: 'adopt', viewId };
  if (entry.adopted) return { kind: 'leave' };
  if (!entry.complete) return { kind: 'replace', viewId, why: 'half-built' };
  const missing = specNames.filter((n) => !(n in entry.widgets));
  return missing.length
    ? { kind: 'leave', note: `Overview is behind the spec (missing: ${missing.join(', ')}) — rebuild it with --rebuild-overviews` }
    : { kind: 'leave' };
}

async function fetchOverviewBoard(client: MondayClient, boardId: number): Promise<{ columns: CurrentColumn[]; views: { id: string; name: string }[] }> {
  const res = await client.gql<{ boards: { columns: CurrentColumn[]; views: { id: string; name: string }[] }[] }>(
    `query ($ids: [ID!]) { boards (ids: $ids) { columns { id title type description settings_str } views { id name } } }`,
    { ids: [String(boardId)] });
  const b = res.boards[0];
  if (!b) throw new Error(`configure: board ${boardId} not found`);
  return b;
}

// State is saved after every create, so a run that dies midway leaves `complete` unset and the next
// run replaces the half-built view instead of extending it.
async function buildOverview(client: MondayClient, boardId: number, stateKey: string, widgets: PlannedWidget[], state: DashboardState): Promise<void> {
  const created = await client.gql<{ create_view: { id: string } }>(
    `mutation ($board: ID!, $name: String!) { create_view (board_id: $board, type: DASHBOARD, name: $name) { id } }`,
    { board: String(boardId), name: OVERVIEW_NAME }, { idempotent: false, apiVersion: VIEW_API_VERSION });
  const entry = { id: created.create_view.id, widgets: {} as Record<string, string> };
  state[stateKey] = entry;
  await writeJson(STATE_FILE(), state);
  for (const w of widgets) {
    const res = await client.gql<{ create_widget: { id: string } }>(
      `mutation ($parent: WidgetParentInput!, $kind: ExternalWidget!, $name: String!, $settings: JSON!, $filter: ItemsQueryGroup) {
         create_widget (parent: $parent, kind: $kind, name: $name, settings: $settings, filter: $filter) { id } }`,
      { parent: { kind: 'BOARD_VIEW', id: entry.id }, kind: w.kind, name: w.name, settings: w.settings, filter: w.filter },
      { idempotent: false, apiVersion: VIEW_API_VERSION });
    entry.widgets[w.name] = res.create_widget.id;
    await writeJson(STATE_FILE(), state);
  }
  state[stateKey] = { ...entry, complete: true };
  await writeJson(STATE_FILE(), state);
}

export interface OverviewOptions { only?: string[] }

export async function configureOverviews(
  client: MondayClient, boardIds: Record<string, number>, dryRun: boolean,
  specs: Record<string, OverviewSpec> = OVERVIEW_SPECS, opts: OverviewOptions = {},
): Promise<ConfigureResult> {
  const state: DashboardState = existsSync(STATE_FILE()) ? await readJson<DashboardState>(STATE_FILE()) : {};
  const actions: string[] = [];
  const notes: string[] = [];
  let ok = true;

  for (const [key, spec] of Object.entries(specs)) {
    if (opts.only && !opts.only.includes(key)) continue;
    const boardId = boardIds[key];
    if (boardId === undefined) { notes.push(`${key}: no board id — skipped (run after \`load\`)`); continue; }

    const stateKey = `overview:${key}`;
    const board = await fetchOverviewBoard(client, boardId);
    const existing = board.views.find((v) => v.name === OVERVIEW_NAME);
    let entry = state[stateKey];
    if (entry && !existing) { delete state[stateKey]; entry = undefined; }

    const action = decideOverview({ entry, viewId: existing?.id, specNames: spec.widgets.map((w) => w.name) });
    if (action.kind === 'leave') { if (action.note) notes.push(`${key}: ${action.note}`); continue; }
    if (action.kind === 'adopt') {
      notes.push(`${key}: existing Overview left as built`);
      if (dryRun) { actions.push(`would adopt existing Overview on ${key}`); continue; }
      state[stateKey] = { id: action.viewId, widgets: {}, adopted: true };
      await writeJson(STATE_FILE(), state);
      actions.push(`adopted existing Overview on ${key}`);
      continue;
    }

    // create or replace: plan first, so a refusal never deletes anything.
    const columns: Columns = new Map([[key, { boardId, columns: board.columns }]]);
    const plan = planOverview(spec, columns);
    if (!plan.ok) { ok = false; notes.push(`${key}: Overview not created — ${plan.errors.join('; ')}`); continue; }
    if (dryRun) { actions.push(`would ${action.kind === 'replace' ? 'replace' : 'create'} Overview on ${key} (${plan.widgets.length} widgets)`); continue; }
    if (action.kind === 'replace') {
      await client.gql(`mutation ($view: ID!, $board: ID!) { delete_view (view_id: $view, board_id: $board) { id } }`,
        { view: action.viewId, board: String(boardId) });
      delete state[stateKey];
    }
    await buildOverview(client, boardId, stateKey, plan.widgets, state);
    actions.push(`${action.kind === 'replace' ? 'replaced' : 'created'} Overview on ${key} (${plan.widgets.length} widgets)`);
  }
  return { ok, summary: actions.length ? actions.join('; ') : 'overviews up to date', notes };
}
```

- [ ] **Step 5: Run**

Run: `npx vitest run src/configure && npm run typecheck`
Expected: PASS. If the "second run creates nothing" test fails because state was written under a different cwd, check that `beforeEach` runs `process.chdir` before the first `STATE()` call.

- [ ] **Step 6: Commit**

```bash
git add src/configure/overviews.ts src/configure/overviews.test.ts
git commit -m "feat(configure): create, adopt and repair Overview views, all-or-nothing"
```

### Task A9: Wire the step into `configure`, document it

**Files:**
- Modify: `src/configure/index.ts`, `src/configure/overviews.ts`, `README.md`
- Test: `src/configure/overviews.test.ts`

**Interfaces:**
- Consumes: `configureOverviews` (A8).
- Produces: `overviewScope(only: string[] | undefined): { run: boolean; boards?: string[] }`. `configure` runs the Overview step after the per-board loop and before the workspace dashboards.

- [ ] **Step 1: Write the failing test.** Append to `overviews.test.ts`:

```ts
import { overviewScope } from './overviews.js';

describe('overviewScope (--only handling)', () => {
  it('runs every board when --only is absent or names overviews', () => {
    expect(overviewScope(undefined)).toEqual({ run: true });
    expect(overviewScope(['overviews'])).toEqual({ run: true });
    expect(overviewScope(['dashboards', 'overviews'])).toEqual({ run: true });
  });
  it('scopes to the named boards, ignoring the dashboards keyword', () => {
    expect(overviewScope(['people-live', 'dashboards'])).toEqual({ run: true, boards: ['people-live'] });
  });
  it('does not run for --only dashboards alone', () => {
    expect(overviewScope(['dashboards'])).toEqual({ run: false });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/configure/overviews.test.ts -t overviewScope`
Expected: FAIL.

- [ ] **Step 3: Implement.** Append to `overviews.ts`:

```ts
/** `--only`: absent runs every board; `overviews` runs them all; board keys scope to those boards; `dashboards` alone skips the step. */
export function overviewScope(only: string[] | undefined): { run: boolean; boards?: string[] } {
  if (!only || only.includes('overviews')) return { run: true };
  const boards = only.filter((k) => k !== 'dashboards');
  return boards.length ? { run: true, boards } : { run: false };
}
```

In `index.ts` add `import { configureOverviews, overviewScope } from './overviews.js';`, and in `runConfigure` replace

```ts
  if (!only || only.includes('dashboards')) {
    const extraPath = dataPath('load', 'extra-boards.json');
    const extra = existsSync(extraPath) ? await readJson<Record<string, number>>(extraPath) : {};
    const boardIds: Record<string, number> = { ...Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v.boardId])), ...extra };
    try {
```

with

```ts
  const extraPath = dataPath('load', 'extra-boards.json');
  const extra = existsSync(extraPath) ? await readJson<Record<string, number>>(extraPath) : {};
  const boardIds: Record<string, number> = { ...Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v.boardId])), ...extra };

  // Overview dashboard views: ordinary token, no dashboard-rights user needed (verified 2026-10-14).
  const overviews = overviewScope(only);
  if (overviews.run) {
    try {
      const result = await configureOverviews(client, boardIds, dryRun, undefined, { only: overviews.boards });
      console.log(`configure: overviews — ${result.summary}`);
      for (const note of result.notes) console.log(`  note: ${note}`);
      if (!result.ok) ok = false;
    } catch (err) {
      console.error(`configure: overviews — FAILED: ${(err as Error).message}`);
      ok = false;
    }
  }

  if (!only || only.includes('dashboards')) {
    try {
```

- [ ] **Step 4: Document.** In `README.md`, after the paragraph beginning `The dashboards step (\`--only dashboards\`)` and its `extra-boards.json` sentence, add:

```markdown
The `overviews` step (`--only overviews`, or a board key such as `--only people-live`) creates an
**Overview** dashboard view on each board that has an entry in `src/configure/overviewSpecs.ts`.
It uses the ordinary `MONDAY_API_TOKEN`; no dashboard-rights user is needed. An Overview is created
whole or not at all, because widgets added to a board-view dashboard after it has been opened do not
render, so a widget that can't resolve (a missing column or label) stops the whole Overview and makes
`configure` exit non-zero. An existing view named `Overview` that `configure` did not make is
adopted and left exactly as built. What it created is remembered in `data/load/dashboards.json`
under `overview:<board key>`; a run that dies midway is repaired on the next run by replacing the
half-built view. Pinning the Overview as a tab, and widget size and position, have no API and stay
manual (private repo: `docs/22` §5).
```

- [ ] **Step 5: Run everything**

```bash
npx vitest run && npm run typecheck && (cd .. && node scripts/check-log-safety.mjs)
```

Expected: PASS everywhere.

- [ ] **Step 6: Commit**

```bash
git add src/configure README.md
git commit -m "feat(configure): run the Overview step from configure, and document it"
```

### Task A10: Sandbox check, then open merge request A

**Files:** none in this repo (results go to `docs/31` §9 in `monday-migration`)

- [ ] **Step 1: Dry run against the sandbox.** The sandbox blocks Node's DNS for `api.monday.com`; run this one command with the sandbox off.

```bash
cd "$WS/monday-workers-overview-lookup/salesforce-import"
npm run cli -- configure --dry-run --only overviews
```

Expected: People and Organizations print `existing Overview left as built` (adoption), and `would create Overview on <board>` does not appear for them. Other boards print nothing, because they have no spec yet in A.

- [ ] **Step 2: Live run, twice.**

```bash
npm run cli -- configure --only overviews    # records two adopted entries; creates nothing
npm run cli -- configure --only overviews    # expect: overviews up to date
```

Expected: `data/load/dashboards.json` gains `overview:people-live` and `overview:organizations` with `adopted: true`; both views are unchanged on the board (`boards { views { id name } }` shows `285684957` and `285685400` still there).

- [ ] **Step 3: Record in `monday-migration`.** Append a dated line to `docs/31` §9 "Probe results": configure adopted the two hand-built Overviews, the second run created nothing. Commit it there.

- [ ] **Step 4: Open the MR.** Pushing and opening a merge request are outward-facing: ask David first. Then:

```bash
git push -u origin feat/configure-lookup-overviews
```

Open the MR titled `feat(configure): Overview dashboard views and Find table views for the lookup boards (#51)`, body linking the spec and `docs/31`.

---

# Merge request B — the other boards, the extended sets, rebuild

Branch `feat/configure-board-overviews`, worktree `$WS/monday-workers-overview-all`, **stacked on A's branch**. When A merges to `main`, rebase: `git rebase --onto main feat/configure-lookup-overviews feat/configure-board-overviews`.

### Task B1: Worktree setup and baseline

**Files:** none (environment only)

- [ ] **Step 1: Create the worktree from A's branch and copy the gitignored state**

```bash
cd "$WS/monday-workers"
git worktree list                                   # confirm A's worktree is checked out and nothing else is on these branches
git worktree add ../monday-workers-overview-all -b feat/configure-board-overviews feat/configure-lookup-overviews
mkdir -p ../monday-workers-overview-all/salesforce-import/data/load
cp ../monday-workers-overview-lookup/salesforce-import/data/load/{boards,extra-boards,dashboards}.json ../monday-workers-overview-all/salesforce-import/data/load/
cd "$WS/monday-workers-overview-all/salesforce-import"
npm ci
cp "$WS/monday-migration/.env" .env
```

`dashboards.json` carries A's two adopted entries; without it the first B run would re-adopt them (harmless, but keep the record).

- [ ] **Step 2: Baseline**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

### Task B2: Fiscal-year helpers

**Files:**
- Create: `src/configure/fiscal.ts`, `src/configure/fiscal.test.ts`

**Interfaces:**
- Consumes: `fiscalYear(iso: string): string` from `src/transform/fields.ts` (returns the four-digit year a date's fiscal year ends in).
- Produces: `FiscalYearValue = { fiscalYear: 'current' | 'previous' }`; `isFiscalYearValue(v: unknown): v is FiscalYearValue`; `pacificDate(now: Date): string`; `fiscalYearEnding(now: Date, offset?: number): number`; `fiscalYearLabel(now: Date, offset?: number): string`; `fiscalYearRange(now: Date, offset?: number): [string, string]`.

- [ ] **Step 1: Write the failing tests.** Create `fiscal.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { fiscalYearEnding, fiscalYearLabel, fiscalYearRange, isFiscalYearValue, pacificDate } from './fiscal.js';

const at = (iso: string) => new Date(iso);

describe('fiscal year', () => {
  it('labels the year by the calendar year it ends in', () => {
    expect(fiscalYearLabel(at('2026-10-14T12:00:00Z'))).toBe('FY2027');
    expect(fiscalYearLabel(at('2026-10-14T12:00:00Z'), -1)).toBe('FY2026');
    expect(fiscalYearLabel(at('2027-03-01T12:00:00Z'))).toBe('FY2027');
    expect(fiscalYearEnding(at('2026-10-14T12:00:00Z'), 1)).toBe(2028);
  });

  it('returns the July-to-June range, inclusive of both ends', () => {
    expect(fiscalYearRange(at('2026-10-14T12:00:00Z'))).toEqual(['2026-07-01', '2027-06-30']);
    expect(fiscalYearRange(at('2026-10-14T12:00:00Z'), -1)).toEqual(['2025-07-01', '2026-06-30']);
  });

  it('follows Pacific time at the July 1 boundary (Review Focus 5)', () => {
    expect(fiscalYearLabel(at('2026-07-01T06:59:59Z'))).toBe('FY2026'); // 23:59:59 PDT, June 30
    expect(fiscalYearLabel(at('2026-07-01T07:00:00Z'))).toBe('FY2027'); // 00:00:00 PDT, July 1
  });

  it('reads a Pacific date in winter too, where California is UTC-8', () => {
    expect(pacificDate(at('2027-01-01T07:59:59Z'))).toBe('2026-12-31');
    expect(pacificDate(at('2027-01-01T08:00:00Z'))).toBe('2027-01-01');
  });

  it('recognises only the two fiscal-year compare values', () => {
    expect(isFiscalYearValue({ fiscalYear: 'current' })).toBe(true);
    expect(isFiscalYearValue({ fiscalYear: 'previous' })).toBe(true);
    expect(isFiscalYearValue({ fiscalYear: 'next' })).toBe(false);
    expect(isFiscalYearValue(['DAYS', 60])).toBe(false);
    expect(isFiscalYearValue(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/configure/fiscal.test.ts`
Expected: FAIL, cannot resolve `./fiscal.js`.

- [ ] **Step 3: Implement.** Create `fiscal.ts`:

```ts
import { fiscalYear } from '../transform/fields.js';

// SVBC's fiscal year runs July to June and is named by the calendar year it ends in: a gift on
// 2025-08-01 is FY2026. "Today" is read in California, so a run just after midnight Pacific on
// July 1 lands in the new year even though UTC is still the day before.
const TIME_ZONE = 'America/Los_Angeles';

export type FiscalYearValue = { fiscalYear: 'current' | 'previous' };

export function isFiscalYearValue(v: unknown): v is FiscalYearValue {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const y = (v as { fiscalYear?: unknown }).fiscalYear;
  return y === 'current' || y === 'previous';
}

/** YYYY-MM-DD of `now` as seen in California. */
export function pacificDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** The calendar year the fiscal year containing `now` ends in, plus `offset` years. */
export function fiscalYearEnding(now: Date, offset = 0): number {
  return Number(fiscalYear(pacificDate(now))) + offset;
}

export const fiscalYearLabel = (now: Date, offset = 0): string => `FY${fiscalYearEnding(now, offset)}`;

/** First and last day of the fiscal year, as ISO dates, both inclusive. */
export function fiscalYearRange(now: Date, offset = 0): [string, string] {
  const end = fiscalYearEnding(now, offset);
  return [`${end - 1}-07-01`, `${end}-06-30`];
}
```

- [ ] **Step 4: Run**

Run: `npx vitest run src/configure/fiscal.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/configure/fiscal.ts src/configure/fiscal.test.ts
git commit -m "feat(configure): fiscal-year label and range from an injected clock"
```

### Task B3: Relative dates and symbolic fiscal values in widget filters

**Files:**
- Modify: `src/configure/widgets.ts`, `src/configure/overviews.ts`, `src/configure/spec.ts` (comment only)
- Test: `src/configure/widgets.test.ts`

**Interfaces:**
- Consumes: `fiscalYearLabel`, `fiscalYearRange`, `isFiscalYearValue` (B2).
- Produces: `widgetFilter(w, columns, now?: Date)`. A rule's `labelValues` may contain `'@FY'` (current fiscal-year label) and `'@FY-1'` (previous). A rule's `compareValue` may be `{ fiscalYear: 'current' | 'previous' }`, which resolves to the two inclusive ISO dates. `within_the_last` and `within_the_next` pass through with their `[unit, n]` array. `planOverview(spec, columns, now?)`; `OverviewOptions.now?: Date`.

- [ ] **Step 1: Write the failing tests.** Append to `widgets.test.ts`:

```ts
describe('relative dates and fiscal values', () => {
  const NOW = new Date('2026-10-14T12:00:00Z'); // FY2027
  const cols: Columns = new Map([['donations', { boardId: 10, columns: [
    col('name', 'Name', 'name'), col('dt', 'Date', 'date'), col('fd', 'First Gift', 'date'),
    col('gfy', 'Gift Fiscal Year', 'status', '{"labels":{"3":"FY2026","4":"FY2027"}}'),
  ] }]]);
  const f = (rules: NonNullable<WidgetSpec['filter']>['rules'], now = NOW) =>
    widgetFilter({ name: 'x', kind: 'NUMBER', number: { boards: ['donations'], count: true }, filter: { board: 'donations', rules } }, cols, now);

  it('passes within_the_last through with its unit and count', () => {
    expect(f([{ columnTitle: 'First Gift', operator: 'within_the_last', compareValue: ['MONTHS', 24] }]))
      .toEqual({ operator: 'and', rules: [{ column_id: 'fd', operator: 'within_the_last', compare_value: ['MONTHS', 24] }] });
  });

  it('turns a fiscalYear compare value into the two inclusive ISO dates', () => {
    expect(f([{ columnTitle: 'Date', operator: 'between', compareValue: { fiscalYear: 'current' } }]))
      .toEqual({ operator: 'and', rules: [{ column_id: 'dt', operator: 'between', compare_value: ['2026-07-01', '2027-06-30'] }] });
    expect(f([{ columnTitle: 'Date', operator: 'between', compareValue: { fiscalYear: 'previous' } }]))
      .toEqual({ operator: 'and', rules: [{ column_id: 'dt', operator: 'between', compare_value: ['2025-07-01', '2026-06-30'] }] });
  });

  it('resolves @FY and @FY-1 to the label ids on the column', () => {
    expect(f([{ columnTitle: 'Gift Fiscal Year', operator: 'any_of', labelValues: ['@FY'] }]))
      .toEqual({ operator: 'and', rules: [{ column_id: 'gfy', operator: 'any_of', compare_value: [4] }] });
    expect(f([{ columnTitle: 'Gift Fiscal Year', operator: 'any_of', labelValues: ['@FY-1'] }]))
      .toEqual({ operator: 'and', rules: [{ column_id: 'gfy', operator: 'any_of', compare_value: [3] }] });
  });

  it('errors, naming the label, when the column has no label for the current year yet (Review Focus 1)', () => {
    const july = new Date('2027-07-02T12:00:00Z'); // FY2028 has no label until classify runs
    expect(f([{ columnTitle: 'Gift Fiscal Year', operator: 'any_of', labelValues: ['@FY'] }], july))
      .toEqual({ error: 'filter on "Gift Fiscal Year" has an unknown label "FY2028"' });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/configure/widgets.test.ts -t "fiscal values"`
Expected: FAIL.

- [ ] **Step 3: Implement.** In `widgets.ts` add `import { fiscalYearLabel, fiscalYearRange, isFiscalYearValue } from './fiscal.js';`, change the signature to

```ts
export function widgetFilter(w: WidgetSpec, columns: Columns, now: Date = new Date()): { operator: 'and'; rules: ResolvedRule[] } | undefined | { error: string } {
```

add above it:

```ts
// '@FY' and '@FY-1' stand for the current and previous fiscal-year label, resolved from the clock.
const fiscalLabel = (label: string, now: Date): string =>
  label === '@FY' ? fiscalYearLabel(now) : label === '@FY-1' ? fiscalYearLabel(now, -1) : label;
```

and replace the compare-value block in the loop (from `let compare_value` through the closing brace of `if (r.labelValues) {…}`) with:

```ts
    let compare_value: unknown = r.compareValue ?? [];
    if (isFiscalYearValue(compare_value)) compare_value = fiscalYearRange(now, compare_value.fiscalYear === 'previous' ? -1 : 0);
    // Widgets silently ignore a bare numeric compare value (#51): always send an array.
    else if (typeof compare_value === 'number') compare_value = [compare_value];
    if (r.labelValues) {
      const labels = r.labelValues.map((l) => fiscalLabel(l, now));
      const ids = labels.map((l) => resolveLabelId(c.type, c.settings_str, l));
      const missing = labels.find((_, i) => ids[i] === undefined);
      if (missing !== undefined) return { error: `filter on "${r.columnTitle}" has an unknown label "${missing}"` };
      compare_value = ids;
    }
```

In `overviews.ts` change `planOverview` to `planOverview(spec: OverviewSpec, columns: Columns, now: Date = new Date())`, call `widgetFilter(w, columns, now)`, add `now?: Date` to `OverviewOptions`, and call `planOverview(spec, columns, opts.now ?? new Date())` in `configureOverviews`.

In `spec.ts`, extend the `FilterRule` comment above `operator` to read:

```ts
  // any_of | not_any_of | is_empty | is_not_empty | contains_text | greater_than | between | ... |
  // within_the_next / within_the_last (relative date; compareValue ['DAYS' | 'MONTHS', n]).
  // Widgets only: labelValues may hold '@FY' / '@FY-1', and a date rule's compareValue may be
  // { fiscalYear: 'current' | 'previous' } (resolved at apply time from the clock, fiscal.ts).
```

- [ ] **Step 4: Run**

Run: `npx vitest run src/configure && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/configure
git commit -m "feat(configure): relative-date operators and run-time fiscal-year values in widget filters"
```

### Task B4: Donut charts and year grouping

**Files:**
- Modify: `src/configure/widgets.ts`
- Test: `src/configure/widgets.test.ts`

**Interfaces:**
- Produces: `chart.dateGroupBy` accepts `'month' | 'quarter' | 'year'`. `graphType` is already a free string; `'donut'` passes through.

- [ ] **Step 1: Write the failing test.** Append to `widgets.test.ts`:

```ts
describe('chart types', () => {
  const cols: Columns = new Map([['events', { boardId: 30, columns: [
    col('name', 'Name', 'name'), col('dt', 'Date', 'date'), col('pg', 'Program', 'status', '{"labels":{"0":"Public"}}'),
  ] }]]);

  it('groups a date axis by year', () => {
    const w: WidgetSpec = { name: 'Events by year', kind: 'CHART', chart: { board: 'events', graphType: 'column', x: 'Date', xGroupBy: 'date', dateGroupBy: 'year', y: 'count' } };
    expect(widgetSettings(w, cols)).toEqual({ graph_type: 'column', x_axis_columns: { '30': ['dt'] }, y_axis_columns: { '30': ['default-label-count'] },
      x_axis_group_by: 'date', y_axis_group_by: 'default-label-count', group_by: 'year' });
  });

  it('passes a donut graph type through', () => {
    const w: WidgetSpec = { name: 'By program', kind: 'CHART', chart: { board: 'events', graphType: 'donut', x: 'Program', xGroupBy: 'color', y: 'count' } };
    expect((widgetSettings(w, cols) as { graph_type: string }).graph_type).toBe('donut');
  });
});
```

- [ ] **Step 2: Run, implement, run**

Run: `npx vitest run src/configure/widgets.test.ts -t "chart types"`
Expected: the donut test PASSES already; the year test passes at runtime but `npm run typecheck` FAILS (`'year'` is not assignable). Fix by changing `dateGroupBy?: 'month' | 'quarter';` to `dateGroupBy?: 'month' | 'quarter' | 'year';` in `widgets.ts`.

Run: `npx vitest run src/configure && npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/configure/widgets.ts src/configure/widgets.test.ts
git commit -m "feat(configure): year grouping on chart date axes"
```

### Task B5: CALENDAR widget

**Files:**
- Modify: `src/configure/widgets.ts`
- Test: `src/configure/widgets.test.ts`

**Interfaces:**
- Produces: `WidgetSpec.kind` includes `'CALENDAR'`; `WidgetSpec.calendar?: { board: string; dateColumn: string; colorBy?: string }`. Settings: `{ columns: { '<boardId>': ['<dateId>'], all: false }, color_by_type, colorByIdPerBoardId: { '<boardId>': ['<colorId>'] }, view_mode: 'month', show_time_slots: false }`. Without `colorBy`, `color_by_type` is `'board'` and the colour id `'board'` (verified 2026-10-14). With `colorBy`, `color_by_type` is `'color'` and the colour id is the status column's id (from the widget schema's examples; verified by Task B7's probe).

- [ ] **Step 1: Write the failing tests.** Append to `widgets.test.ts`:

```ts
describe('CALENDAR widgets', () => {
  const cols: Columns = new Map([['events', { boardId: 30, columns: [
    col('name', 'Name', 'name'), col('dt', 'Date', 'date'), col('pg', 'Program', 'status', '{"labels":{"0":"Public"}}'),
  ] }]]);

  it('plots a date column, coloured by board when no colour column is named (the shape verified 2026-10-14)', () => {
    const w: WidgetSpec = { name: 'Calendar', kind: 'CALENDAR', calendar: { board: 'events', dateColumn: 'Date' } };
    expect(widgetSettings(w, cols)).toEqual({ columns: { '30': ['dt'], all: false }, color_by_type: 'board',
      colorByIdPerBoardId: { '30': ['board'] }, view_mode: 'month', show_time_slots: false });
  });

  it('colours by a status column when one is named', () => {
    const w: WidgetSpec = { name: 'Calendar', kind: 'CALENDAR', calendar: { board: 'events', dateColumn: 'Date', colorBy: 'Program' } };
    expect(widgetSettings(w, cols)).toEqual({ columns: { '30': ['dt'], all: false }, color_by_type: 'color',
      colorByIdPerBoardId: { '30': ['pg'] }, view_mode: 'month', show_time_slots: false });
  });

  it('errors on an unknown date column or board', () => {
    expect(widgetSettings({ name: 'c', kind: 'CALENDAR', calendar: { board: 'events', dateColumn: 'Nope' } }, cols))
      .toEqual({ error: 'board "events" has no column "Nope"' });
    expect(widgetSettings({ name: 'c', kind: 'CALENDAR', calendar: { board: 'nope', dateColumn: 'Date' } }, cols))
      .toEqual({ error: 'board "nope" has no id' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/configure/widgets.test.ts -t CALENDAR`
Expected: FAIL.

- [ ] **Step 3: Implement.** In `widgets.ts` widen `kind` to `'CHART' | 'NUMBER' | 'LISTVIEW' | 'CALENDAR'`, add `calendar?: { board: string; dateColumn: string; colorBy?: string };` to `WidgetSpec`, and insert before `if (w.list) {`:

```ts
  if (w.calendar) {
    const { board, dateColumn, colorBy } = w.calendar;
    const b = columns.get(board);
    if (!b) return { error: `board "${board}" has no id` };
    const dateId = colId(columns, board, dateColumn);
    if (typeof dateId !== 'string') return dateId;
    let colorId = 'board';
    let colorType = 'board';
    if (colorBy) {
      const id = colId(columns, board, colorBy);
      if (typeof id !== 'string') return id;
      colorId = id;
      colorType = 'color';
    }
    const boardId = String(b.boardId);
    return { columns: { [boardId]: [dateId], all: false }, color_by_type: colorType,
      colorByIdPerBoardId: { [boardId]: [colorId] }, view_mode: 'month', show_time_slots: false };
  }
```

- [ ] **Step 4: Run**

Run: `npx vitest run src/configure && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/configure/widgets.ts src/configure/widgets.test.ts
git commit -m "feat(configure): CALENDAR widget settings"
```

### Task B6: One Received-rule mapper, with an opt-out

**Files:**
- Modify: `src/configure/spec.ts`, `src/configure/widgets.ts`
- Test: `src/configure/spec.test.ts`

**Interfaces:**
- Produces: `WidgetSpec.allStatuses?: true`; `withReceivedRule(widgets: WidgetSpec[]): WidgetSpec[]` exported from `spec.ts`. `DASHBOARD_SPECS` is unchanged in content.

- [ ] **Step 1: Write the failing tests.** In `spec.test.ts` add `withReceivedRule` to the import from `./spec.js`, add `import type { WidgetSpec } from './widgets.js';`, and append:

```ts
describe('withReceivedRule', () => {
  const received = (w: WidgetSpec) => (w.filter?.rules ?? []).filter((r) => r.columnTitle === 'Status' && r.labelValues?.includes('Received')).length;
  const num = (over: Partial<WidgetSpec> = {}): WidgetSpec => ({ name: 'w', kind: 'NUMBER', number: { boards: ['donations'], count: true }, ...over });

  it('adds Received to NUMBER, CHART and LISTVIEW widgets on Donations', () => {
    const out = withReceivedRule([
      num(),
      { name: 'c', kind: 'CHART', chart: { board: 'donations', graphType: 'donut', x: 'Gift Size', xGroupBy: 'color', y: 'count' } },
      { name: 'l', kind: 'LISTVIEW', list: { board: 'donations', columns: ['Donor'] } },
    ]);
    for (const w of out) expect(received(w), w.name).toBe(1);
  });

  it('keeps a widget’s own rules and appends Received', () => {
    const own = { columnTitle: 'Thank You Sent', operator: 'is_empty' };
    const [w] = withReceivedRule([num({ filter: { board: 'donations', rules: [own] } })]);
    expect(w!.filter!.rules[0]).toEqual(own);
    expect(received(w!)).toBe(1);
  });

  it('skips a widget marked allStatuses, and widgets on other boards (Review Focus 7)', () => {
    const [spans, elsewhere] = withReceivedRule([
      num({ allStatuses: true }),
      { name: 'e', kind: 'NUMBER', number: { boards: ['events'], count: true } },
    ]);
    expect(received(spans!)).toBe(0);
    expect(received(elsewhere!)).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/configure/spec.test.ts -t withReceivedRule`
Expected: FAIL, `withReceivedRule` is not exported.

- [ ] **Step 3: Implement.** In `widgets.ts` add to `WidgetSpec`:

```ts
  allStatuses?: true;   // Donations only: skip the Received rule (a tile that spans every Status)
```

In `spec.ts` add `import type { WidgetSpec } from './widgets.js';` next to the `DashboardSpec` import, and replace the `export const DASHBOARD_SPECS … .map(…)` block (the one that follows the `RECEIVED_RULE` comment and constant) with:

```ts
// ANDs the Received rule onto every NUMBER, CHART and LISTVIEW widget on Donations, except one that
// sets `allStatuses` because it deliberately spans every Status (a Pending or no-donor tile).
export function withReceivedRule(widgets: WidgetSpec[]): WidgetSpec[] {
  return widgets.map((w) => {
    const onDonations = w.chart?.board === 'donations' || w.number?.boards.includes('donations') || w.list?.board === 'donations';
    if (!onDonations || w.allStatuses) return w;
    return { ...w, filter: { board: 'donations', rules: [...(w.filter?.rules ?? []), RECEIVED_RULE] } };
  });
}

export const DASHBOARD_SPECS: DashboardSpec[] = RAW_DASHBOARD_SPECS.map((d) => ({ ...d, widgets: withReceivedRule(d.widgets) }));
```

- [ ] **Step 4: Run**

Run: `npx vitest run src/configure && npm run typecheck`
Expected: PASS, including the existing `DASHBOARD_SPECS revenue filters` tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/configure
git commit -m "refactor(configure): one Received-rule mapper for Donations widgets, with an allStatuses opt-out"
```

### Task B7: Probes, then the five full Overview specs

**Files:**
- Modify: `src/configure/overviewSpecs.ts`, `src/configure/overviewSpecs.test.ts`
- Results go to `docs/31` §9 in `monday-migration`

**Interfaces:**
- Consumes: `withReceivedRule` (B6); `is`, `gt0`, `count`, `sum`, `list`, `pie` builders and `PROVISIONED_ELSEWHERE` (A7).
- Produces: `OVERVIEW_SPECS` gains `donations`, `recurring-gifts`, `events`; `people-live` and `organizations` grow to the `docs/31` §4.1 and §4.2 sets. The `pie`/`donut`/`bars`/`overTime`/`calendar` shorthands are file-private.

- [ ] **Step 1: Run the three probes on the sandbox.** Throwaway views named `zz probe …`, deleted at the end. Use the Monday MCP `all_monday_api` (it works inside the sandbox) and look at the results in the browser.

1. **Chart filter on a board view.** On Donations (18431577310) create a `DASHBOARD` view, then two CHART widgets (`graph_type: 'donut'`, x `color_mm7nwk15` Funding Stream, y `default-label-count`, `x_axis_group_by: 'color'`, `y_axis_group_by: 'default-label-count'`), one with no filter and one with `filter: { operator: 'and', rules: [{ column_id: 'color_mm79q3b3', operator: 'any_of', compare_value: [0] }] }` (Status = Received, label id 0). The two donuts must differ, and the filtered donut's slice counts must sum to the `COUNT_ITEMS` aggregate of the same rule. If the filter is ignored, filtered charts are dropped from the Overviews (use filtered NUMBER and LISTVIEW widgets only) and `docs/31` §4.3 is amended.
2. **`between` boundaries.** Pick a Donations `Date` that has items (`items_page` with a `Date` rule, or read one from the board). Run `aggregate` `COUNT_ITEMS` with `Date between [D, D]` and with `between [D-1, D]` and `between [D, D+1]`. A non-zero `[D, D]` count means both ends are inclusive. Then confirm a NUMBER count widget with `between [D, D]` shows that same number.
3. **Calendar colour by status.** On Events (18431577282) create a `DASHBOARD` view and a CALENDAR widget built exactly as Task B5 produces for `colorBy: 'Program'`. The calendar legend should list the Program labels.

Record all three in `docs/31` §9 (a dated bullet each), then delete the probe views and confirm with `boards { views { name } }` that no `zz` view remains. If probe 3 fails, change the Events spec below to omit `colorBy` and note it.

- [ ] **Step 2: Write the failing tests.** In `overviewSpecs.test.ts` replace the `boardsOf` and `columnTitlesOf` helpers so they know calendars, and add the new expectations:

```ts
const boardsOf = (w: WidgetSpec): string[] => [
  ...(w.chart ? [w.chart.board] : []), ...(w.number?.boards ?? []), ...(w.list ? [w.list.board] : []),
  ...(w.calendar ? [w.calendar.board] : []), ...(w.filter ? [w.filter.board] : []),
];
const columnTitlesOf = (w: WidgetSpec): string[] => {
  const t: string[] = [];
  if (w.chart) { t.push(w.chart.x); if (w.chart.y !== 'count') t.push(w.chart.y); if (w.chart.z) t.push(w.chart.z); }
  if (w.number?.column) t.push(w.number.column);
  if (w.list) t.push(...w.list.columns);
  if (w.calendar) { t.push(w.calendar.dateColumn); if (w.calendar.colorBy) t.push(w.calendar.colorBy); }
  for (const r of w.filter?.rules ?? []) t.push(r.columnTitle);
  return t.filter((x) => x !== 'name');
};
```

and inside `describe('OVERVIEW_SPECS', …)` add:

```ts
  it('has the five full dashboards from docs/31 §4', () => {
    const names = (k: string) => OVERVIEW_SPECS[k]!.widgets.map((w) => w.name);
    expect(names('people-live')).toEqual(expect.arrayContaining(['Gave last year, not this year', 'Raised last FY', 'New donors by month', 'Renewals due by year']));
    expect(names('organizations')).toEqual(expect.arrayContaining(['Raised last FY', 'Untyped', 'DNS reason missing', 'Raised this FY by donor level']));
    expect(names('donations')).toEqual(expect.arrayContaining(['Received this FY', 'Received last FY', 'Major gifts to thank', 'Revenue by month', 'Revenue by Funding Stream']));
    expect(names('recurring-gifts')).toEqual(expect.arrayContaining(['Active pledges', 'Expected next 30 days', 'Failed pledges']));
    expect(names('events')).toEqual(expect.arrayContaining(['Events', 'Upcoming', 'Calendar', 'Events by year']));
  });

  it('puts the Received rule on every Donations widget except the two that span every Status (D8)', () => {
    const received = (w: WidgetSpec) => (w.filter?.rules ?? []).some((r) => r.columnTitle === 'Status' && r.labelValues?.includes('Received'));
    for (const w of OVERVIEW_SPECS['donations']!.widgets) {
      const spans = ['Pending', 'Needs a donor'].includes(w.name);
      expect(received(w), w.name).toBe(!spans);
    }
  });

  it('a list and a tile that share a worklist share its filter, so tile and tab agree', () => {
    const rules = (k: string, n: string) => OVERVIEW_SPECS[k]!.widgets.find((w) => w.name === n)!.filter!.rules;
    expect(rules('donations', 'Major gifts to thank (list)')).toEqual(rules('donations', 'Major gifts to thank'));
    expect(rules('people-live', 'Gave last year, not this year (list)')).toEqual(rules('people-live', 'Gave last year, not this year'));
  });
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run src/configure/overviewSpecs.test.ts`
Expected: FAIL (the new names and boards are missing).

- [ ] **Step 4: Implement.** Replace the whole of `overviewSpecs.ts` with:

```ts
import type { OverviewSpec } from './overviews.js';
import { withReceivedRule, type FilterRule } from './spec.js';
import type { WidgetSpec } from './widgets.js';

// Overview dashboard views (docs/31 in the private planning repo; spec 2026-10-14). Columns are
// referred to by title and resolved to ids at apply time. Each Overview reads only its own board.

// Rollup columns the donation-rollups scripts create (setup-owner-columns.mjs,
// setup-classification-columns.mjs). This repo can't see them statically, so the spec-consistency
// test takes them from here.
export const PROVISIONED_ELSEWHERE: Record<string, string[]> = {
  'people-live': ['Donor Level', 'This Year Count', 'This Year Amount', 'Last Year Amount', 'Last Gift Date', 'Last Gift Amount'],
  organizations: ['Donor Level', 'This Year Count', 'This Year Amount', 'Last Year Amount', 'Last Gift Date'],
  donations: ['Gift Fiscal Year', 'Funding Stream', 'Gift Size'],
};

// ---- rule shorthand -------------------------------------------------------------------------
const is = (columnTitle: string, ...labelValues: string[]): FilterRule => ({ columnTitle, operator: 'any_of', labelValues });
const gt0 = (columnTitle: string): FilterRule => ({ columnTitle, operator: 'greater_than', compareValue: [0] });
const empty = (columnTitle: string): FilterRule => ({ columnTitle, operator: 'is_empty' });
const within = (columnTitle: string, operator: 'within_the_next' | 'within_the_last', unit: 'DAYS' | 'MONTHS', n: number): FilterRule =>
  ({ columnTitle, operator, compareValue: [unit, n] });
const thisFY = is('Gift Fiscal Year', '@FY');
const lastFY = is('Gift Fiscal Year', '@FY-1');

// The existing worklist views' own filters (spec.ts), reused so a tile and its tab agree.
const NOT_DNS: FilterRule = { columnTitle: 'Do Not Solicit', operator: 'is_empty' };
const LYBUNT: FilterRule[] = [gt0('Last Year Amount'), { columnTitle: 'This Year Count', operator: 'lower_than', compareValue: [1] }, NOT_DNS];
const MAJOR_TO_THANK: FilterRule[] = [is('Acknowledgment Tier', 'Major'), empty('Thank You Sent')];

// ---- widget shorthand -----------------------------------------------------------------------
const filterOn = (board: string, rules: FilterRule[]) => (rules.length ? { filter: { board, rules } } : {});
const count = (name: string, board: string, rules: FilterRule[] = []): WidgetSpec =>
  ({ name, kind: 'NUMBER', number: { boards: [board], count: true }, ...filterOn(board, rules) });
const sum = (name: string, board: string, column: string, rules: FilterRule[] = [], format: 'currency' | 'number' = 'currency'): WidgetSpec =>
  ({ name, kind: 'NUMBER', number: { boards: [board], column, counter: 'sum', format }, ...filterOn(board, rules) });
const avg = (name: string, board: string, column: string, rules: FilterRule[] = []): WidgetSpec =>
  ({ name, kind: 'NUMBER', number: { boards: [board], column, counter: 'average', format: 'currency' }, ...filterOn(board, rules) });
const list = (name: string, board: string, columns: string[], rules: FilterRule[] = []): WidgetSpec =>
  ({ name, kind: 'LISTVIEW', list: { board, columns }, ...filterOn(board, rules) });
const pie = (name: string, board: string, x: string, rules: FilterRule[] = []): WidgetSpec =>
  ({ name, kind: 'CHART', chart: { board, graphType: 'pie', x, xGroupBy: 'color', y: 'count' }, ...filterOn(board, rules) });
const donut = (name: string, board: string, x: string, rules: FilterRule[] = [], y: string = 'count'): WidgetSpec =>
  ({ name, kind: 'CHART', chart: { board, graphType: 'donut', x, xGroupBy: 'color', y }, ...filterOn(board, rules) });
const bars = (name: string, board: string, x: string, y: string, rules: FilterRule[] = []): WidgetSpec =>
  ({ name, kind: 'CHART', chart: { board, graphType: 'column', x, xGroupBy: 'color', y }, ...filterOn(board, rules) });
const overTime = (name: string, board: string, x: string, y: string, dateGroupBy: 'month' | 'quarter' | 'year',
  rules: FilterRule[] = [], extra: { graphType?: string; z?: string } = {}): WidgetSpec =>
  ({ name, kind: 'CHART', chart: { board, graphType: extra.graphType ?? 'column', x, xGroupBy: 'date', dateGroupBy, y, ...(extra.z ? { z: extra.z } : {}) }, ...filterOn(board, rules) });
const calendar = (name: string, board: string, dateColumn: string, colorBy?: string): WidgetSpec =>
  ({ name, kind: 'CALENDAR', calendar: { board, dateColumn, ...(colorBy ? { colorBy } : {}) } });
const allStatuses = (w: WidgetSpec): WidgetSpec => ({ ...w, allStatuses: true });

const RAW_OVERVIEW_SPECS: Record<string, OverviewSpec> = {
  // docs/31 §4.1 — widgets marked (built) exist on the sandbox Overview since 2026-10-09 (#51).
  'people-live': { widgets: [
    count('Active members', 'people-live', [is('Membership Status', 'Active')]),                                    // built
    count('Memberships ending in 60 days', 'people-live',
      [is('Membership Status', 'Active'), within('Member Until', 'within_the_next', 'DAYS', 60)]),               // built
    count('Donors this FY', 'people-live', [gt0('This Year Count')]),                                              // built
    sum('Raised this FY', 'people-live', 'This Year Amount'),                                                      // built
    count('Gave last year, not this year', 'people-live', LYBUNT),
    sum('Raised last FY', 'people-live', 'Last Year Amount'),
    list('Find a person', 'people-live', ['Personal Email', 'Phone', 'City', 'Organization', 'Membership Status', 'Donor Level']), // built
    list('Leadership and major donors', 'people-live',
      ['Donor Level', 'Lifetime Giving', 'Last Gift Date', 'Last Gift Amount', 'Personal Email', 'Phone'],
      [is('Donor Level', 'Leadership', 'Major')]),                                                                 // built
    list('Gave last year, not this year (list)', 'people-live', ['Last Year Amount', 'Phone', 'Personal Email'], LYBUNT),
    pie('Donors by level', 'people-live', 'Donor Level'),                                                          // built
    pie('Members by status', 'people-live', 'Membership Status'),                                                  // built
    overTime('New donors by month', 'people-live', 'First Gift', 'count', 'month', [within('First Gift', 'within_the_last', 'MONTHS', 24)]),
    overTime('Renewals due by year', 'people-live', 'Member Until', 'count', 'year', [is('Membership Status', 'Active')]),
  ] },

  // docs/31 §4.2
  organizations: { widgets: [
    count('Organizations giving this FY', 'organizations', [gt0('This Year Count')]),                              // built
    sum('Raised this FY', 'organizations', 'This Year Amount'),                                                    // built
    sum('Raised last FY', 'organizations', 'Last Year Amount'),
    count('Untyped', 'organizations', [empty('Partner Type')]),
    count('DNS reason missing', 'organizations', [is('DNS Reason Status', 'Missing')]),
    list('Find an organization', 'organizations', ['Partner Type', 'City', 'Website', 'Phone', 'Donor Level']),    // built
    list('Funders and matching companies', 'organizations',
      ['Partner Type', 'Lifetime Giving', 'Last Gift Date', 'This Year Amount', 'Donor Level'], [gt0('Lifetime Giving')]), // built
    pie('Organizations by donor level', 'organizations', 'Donor Level'),                                           // built
    bars('Raised this FY by donor level', 'organizations', 'Donor Level', 'This Year Amount'),
  ] },

  // docs/31 §4.3 — Received is added to all but the two allStatuses tiles (withReceivedRule below).
  donations: { widgets: [
    sum('Received this FY', 'donations', 'Amount', [thisFY]),
    count('Gifts this FY', 'donations', [thisFY]),
    avg('Average gift this FY', 'donations', 'Amount', [thisFY]),
    sum('Received last FY', 'donations', 'Amount', [lastFY]),
    count('Major gifts to thank', 'donations', MAJOR_TO_THANK),
    sum('Major gifts to thank, $', 'donations', 'Amount', MAJOR_TO_THANK),
    allStatuses(sum('Pending', 'donations', 'Amount', [is('Status', 'Pending')])),
    allStatuses(count('Needs a donor', 'donations', [empty('Donor'), empty('Anonymous Donor')])),
    list('Major gifts to thank (list)', 'donations', ['Donor', 'Amount', 'Date'], MAJOR_TO_THANK),
    overTime('Revenue by month', 'donations', 'Date', 'Amount', 'month', [], { graphType: 'stacked_column', z: 'Gift Fiscal Year' }),
    donut('Revenue by Funding Stream', 'donations', 'Funding Stream', [thisFY], 'Amount'),
    donut('Gifts by Gift Size', 'donations', 'Gift Size', [thisFY]),
  ] },

  // docs/31 §4.4
  'recurring-gifts': { widgets: [
    count('Active pledges', 'recurring-gifts', [is('Status', 'Active')]),
    sum('Annualized value', 'recurring-gifts', 'Annualized Value', [is('Status', 'Active')]),
    sum('Received to date', 'recurring-gifts', 'Received Amount'),
    sum('Expected next 30 days', 'recurring-gifts', 'Installment Amount', [is('Status', 'Active'), within('Next Payment', 'within_the_next', 'DAYS', 30)]),
    count('Failed', 'recurring-gifts', [is('Status', 'Failed')]),
    list('Failed pledges', 'recurring-gifts', ['Donor', 'Installment Amount', 'Next Payment'], [is('Status', 'Failed')]),
    donut('Active pledges by Frequency', 'recurring-gifts', 'Frequency', [is('Status', 'Active')]),
    overTime('Next installment by month', 'recurring-gifts', 'Next Payment', 'Installment Amount', 'month', [is('Status', 'Active')]),
    donut('Pledges by Status', 'recurring-gifts', 'Status'),
  ] },

  // docs/31 §4.5
  events: { widgets: [
    count('Events', 'events'),
    count('Upcoming', 'events', [is('Event Status', 'Upcoming')]),
    sum('Tickets sold', 'events', 'Tickets Sold', [], 'number'),
    count('Drafts', 'events', [is('Event Status', 'Draft')]),
    // coloured by board (verified); colorBy 'Program' is unverified, see docs/31 §9
    calendar('Calendar', 'events', 'Date'),
    donut('Events by Program', 'events', 'Program'),
    overTime('Events by year', 'events', 'Date', 'count', 'year'),
    bars('Tickets sold by Program', 'events', 'Program', 'Tickets Sold'),
  ] },
};

export const OVERVIEW_SPECS: Record<string, OverviewSpec> = Object.fromEntries(
  Object.entries(RAW_OVERVIEW_SPECS).map(([key, s]) => [key, { widgets: withReceivedRule(s.widgets) }]));
```


- [ ] **Step 5: Run**

Run: `npx vitest run src/configure && npm run typecheck`
Expected: PASS. A "known columns" failure names a title that isn't in `COLUMN_TYPES`, `CONNECT_COLUMNS`, the board's `BoardSpec.columns` or `PROVISIONED_ELSEWHERE`: add it to `PROVISIONED_ELSEWHERE` only if a `donation-rollups` script creates it; otherwise fix the typo.

- [ ] **Step 6: Commit**

```bash
git add src/configure
git commit -m "feat(configure): Overview specs for People, Organizations, Donations, Recurring Gifts and Events"
```

### Task B8: The seven health strips and full coverage

**Files:**
- Modify: `src/configure/overviewSpecs.ts`
- Test: `src/configure/overviewSpecs.test.ts`

**Interfaces:**
- Produces: `OVERVIEW_SPECS` has all 12 board keys. `annual-giving-summary` is keyed by its `extra-boards.json` name.

- [ ] **Step 1: Write the failing tests.** Add to `overviewSpecs.test.ts`, inside `describe('OVERVIEW_SPECS', …)`:

```ts
  it('covers all 12 CRM boards', () => {
    expect(Object.keys(OVERVIEW_SPECS).sort()).toEqual([
      'activities', 'affiliations', 'annual-giving-summary', 'campaigns', 'donations', 'event-registrations',
      'events', 'organizations', 'people-historical', 'people-live', 'recurring-gifts', 'volunteers']);
  });

  it('keeps the seven strips to docs/31 §5: one row of tiles, with a chart only where it earns one', () => {
    const strips = ['people-historical', 'affiliations', 'campaigns', 'annual-giving-summary', 'event-registrations', 'volunteers', 'activities'];
    for (const k of strips) {
      const w = OVERVIEW_SPECS[k]!.widgets;
      expect(w.filter((x) => x.kind === 'NUMBER').length, k).toBeGreaterThanOrEqual(3);
      expect(w.filter((x) => x.kind === 'LISTVIEW' || x.kind === 'CALENDAR'), k).toEqual([]);
      expect(w.filter((x) => x.kind === 'CHART').length, k).toBe(['annual-giving-summary', 'activities'].includes(k) ? 1 : 0);
    }
  });

  it('gives each strip one data-quality tile (docs/31 §5)', () => {
    const tile = (k: string, name: string) => OVERVIEW_SPECS[k]!.widgets.some((w) => w.name === name);
    expect(tile('people-historical', 'Gave this year')).toBe(true);
    expect(tile('affiliations', 'Drafts to confirm')).toBe(true);
    expect(tile('event-registrations', 'Unlinked attendees')).toBe(true);
    expect(tile('volunteers', 'Unlinked')).toBe(true);
    expect(tile('activities', 'Unlinked')).toBe(true);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/configure/overviewSpecs.test.ts`
Expected: FAIL (seven keys missing).

- [ ] **Step 3: Implement.** In `overviewSpecs.ts`, extend `PROVISIONED_ELSEWHERE` with

```ts
  'people-historical': ['This Year Amount'],
  'annual-giving-summary': ['Total Received'],
```

and add a `notEmpty` shorthand beside `empty`:

```ts
const notEmpty = (columnTitle: string): FilterRule => ({ columnTitle, operator: 'is_not_empty' });
const thisFYDates = (columnTitle: string): FilterRule => ({ columnTitle, operator: 'between', compareValue: { fiscalYear: 'current' } });
```

then insert these entries before the closing `};` of `RAW_OVERVIEW_SPECS`:

```ts
  // docs/31 §5 — health strips. Filters are the existing worklist views' own (spec.ts).
  'people-historical': { widgets: [
    count('People', 'people-historical'),
    sum('Lifetime giving', 'people-historical', 'Lifetime Giving'),
    count('Members ever', 'people-historical', [notEmpty('Membership Status')]),
    count('Gave this year', 'people-historical', [gt0('This Year Amount')]),       // should be 0: a donor here belongs on People
  ] },
  affiliations: { widgets: [
    count('Affiliations', 'affiliations'),
    count('Current', 'affiliations', [is('Status', 'Current')]),
    count('Drafts to confirm', 'affiliations', [is('Status', 'Draft')]),
    sum('Attributed giving', 'affiliations', 'Attributed Giving'),
  ] },
  campaigns: { widgets: [
    count('Campaigns', 'campaigns'),
    count('Active', 'campaigns', [notEmpty('Active')]),
    count('Ended this FY', 'campaigns', [thisFYDates('End')]),
  ] },
  'annual-giving-summary': { widgets: [
    count('Fiscal years', 'annual-giving-summary'),
    sum('Total received, all years', 'annual-giving-summary', 'Total Received'),
    sum('Gifts, all years', 'annual-giving-summary', 'Gift Count', [], 'number'),
    { name: 'Total received by fiscal year', kind: 'CHART',
      chart: { board: 'annual-giving-summary', graphType: 'column', x: 'name', xGroupBy: 'name', y: 'Total Received' } },
  ] },
  'event-registrations': { widgets: [
    count('Registrations', 'event-registrations'),
    count('Attended', 'event-registrations', [is('Attendance', 'Attended')]),
    sum('Volunteer hours', 'event-registrations', 'Hours', [], 'number'),
    count('Unlinked attendees', 'event-registrations', [empty('Attendee'), is('Source', 'Eventbrite')]),
  ] },
  volunteers: { widgets: [
    count('Shifts', 'volunteers'),
    sum('Hours', 'volunteers', 'Hours', [], 'number'),
    sum('Hours this FY', 'volunteers', 'Hours', [thisFYDates('Date')], 'number'),
    count('Unlinked', 'volunteers', [empty('Volunteer')]),
  ] },
  activities: { widgets: [
    count('Activities', 'activities'),
    count('Open', 'activities', [{ columnTitle: 'Status', operator: 'not_any_of', labelValues: ['Completed'] }]),
    count('Last 30 days', 'activities', [within('Date', 'within_the_last', 'DAYS', 30)]),
    count('Unlinked', 'activities', [empty('Person')]),
    donut('Activities by Activity Type', 'activities', 'Activity Type'),
  ] },
```

- [ ] **Step 4: Run**

Run: `npx vitest run src/configure && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/configure
git commit -m "feat(configure): Overview health strips on the seven reference boards"
```

### Task B9: `--rebuild-overviews`

**Files:**
- Modify: `src/configure/overviews.ts`, `src/configure/index.ts`
- Test: `src/configure/overviews.test.ts`

**Interfaces:**
- Consumes: `decideOverview`, `configureOverviews`, `OverviewOptions` (A8).
- Produces: `DecideInput.rebuild?: boolean`; `OverviewAction` replace variant `why: 'half-built' | 'rebuild'`; `OverviewOptions.rebuild?: string[]`; `parseRebuild(args: string[], knownKeys?: string[]): { keys: string[] } | { error: string } | undefined`.

- [ ] **Step 1: Write the failing tests.** Append to `overviews.test.ts`:

```ts
import { parseRebuild } from './overviews.js';

describe('parseRebuild', () => {
  const known = ['people-live', 'organizations'];
  it('is undefined when the flag is absent', () => { expect(parseRebuild(['--only', 'overviews'], known)).toBeUndefined(); });
  it('returns the board keys', () => { expect(parseRebuild(['--rebuild-overviews', 'people-live,organizations'], known)).toEqual({ keys: ['people-live', 'organizations'] }); });
  it('rejects a missing value, all, and unknown keys (Review Focus 6)', () => {
    expect(parseRebuild(['--rebuild-overviews'], known)).toMatchObject({ error: expect.stringMatching(/needs board keys/) });
    expect(parseRebuild(['--rebuild-overviews', '--dry-run'], known)).toMatchObject({ error: expect.stringMatching(/needs board keys/) });
    expect(parseRebuild(['--rebuild-overviews', 'all'], known)).toMatchObject({ error: expect.stringMatching(/never "all"/) });
    expect(parseRebuild(['--rebuild-overviews', 'people-live,nope'], known)).toMatchObject({ error: expect.stringMatching(/no Overview spec for nope/) });
  });
});

describe('decideOverview with rebuild', () => {
  it('replaces whatever Overview is on the board, adopted or complete', () => {
    expect(decideOverview({ viewId: 'v7', specNames: ['A'], rebuild: true })).toEqual({ kind: 'replace', viewId: 'v7', why: 'rebuild' });
    expect(decideOverview({ entry: { id: 'v7', widgets: { A: 'w1' }, complete: true }, viewId: 'v7', specNames: ['A'], rebuild: true }))
      .toEqual({ kind: 'replace', viewId: 'v7', why: 'rebuild' });
  });
  it('just creates when there is nothing to replace', () => {
    expect(decideOverview({ specNames: ['A'], rebuild: true })).toEqual({ kind: 'create' });
  });
});

describe('configureOverviews with rebuild', () => {
  beforeEach(() => { process.chdir(mkdtempSync(join(tmpdir(), 'sfimp-'))); });
  const kinds = (f: ReturnType<typeof fake>) => f.mutations().map((c) => (/delete_view/.test(c.query) ? 'delete' : /create_view/.test(c.query) ? 'view' : 'widget'));

  it('deletes a hand-built Overview first, then builds the full set, and says what is left to do by hand', async () => {
    const f = fake({ views: [{ id: 'v7', name: 'Overview' }] });
    const r = await configureOverviews(f.client, BOARD_IDS, false, SPECS, { rebuild: ['people-live'] });
    expect(kinds(f)).toEqual(['delete', 'view', 'widget', 'widget', 'widget']);
    expect(r.summary).toMatch(/replaced Overview on people-live/);
    expect(r.notes.join()).toMatch(/people-live: rebuilt — pin the new Overview first and re-size its widgets/);
    expect((await readJson<DashboardState>(STATE()))[KEY]!.complete).toBe(true);
  });

  it('replaces one that configure itself made and finished', async () => {
    await configureOverviews(fake().client, BOARD_IDS, false, SPECS);
    const f = fake({ views: [{ id: '101', name: 'Overview' }] });
    await configureOverviews(f.client, BOARD_IDS, false, SPECS, { rebuild: ['people-live'] });
    expect(kinds(f)).toEqual(['delete', 'view', 'widget', 'widget', 'widget']);
  });

  it('dry-run lists the replacement and makes no calls beyond reads', async () => {
    const f = fake({ views: [{ id: 'v7', name: 'Overview' }] });
    const r = await configureOverviews(f.client, BOARD_IDS, true, SPECS, { rebuild: ['people-live'] });
    expect(r.summary).toMatch(/would replace Overview on people-live \(3 widgets\)/);
    expect(f.mutations()).toEqual([]);
  });

  it('a refused plan never deletes the hand-built view it was going to replace', async () => {
    const f = fake({ views: [{ id: 'v7', name: 'Overview' }], columns: COLS.filter((c) => c.title !== 'This Year Amount') });
    const r = await configureOverviews(f.client, BOARD_IDS, false, SPECS, { rebuild: ['people-live'] });
    expect(f.mutations()).toEqual([]);
    expect(r.ok).toBe(false);
  });

  it('leaves boards not named in the rebuild list alone', async () => {
    const f = fake({ views: [{ id: 'v7', name: 'Overview' }] });
    await configureOverviews(f.client, BOARD_IDS, false, SPECS, { rebuild: ['organizations'] });
    expect(f.mutations().some((c) => /delete_view/.test(c.query))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/configure/overviews.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.** In `overviews.ts`:

Change the replace variant of `OverviewAction` to `{ kind: 'replace'; viewId: string; why: 'half-built' | 'rebuild' }`, and `DecideInput` to

```ts
export interface DecideInput { entry?: DashboardState[string]; viewId?: string; specNames: string[]; rebuild?: boolean }
```

Make the first line of `decideOverview`'s body (after the destructuring, which gains `rebuild`):

```ts
  if (rebuild) return viewId ? { kind: 'replace', viewId, why: 'rebuild' } : { kind: 'create' };
```

Add `rebuild?: string[]` to `OverviewOptions`; pass `rebuild: opts.rebuild?.includes(key)` into the `decideOverview` call; and after the `buildOverview(...)` call in `configureOverviews` add:

```ts
    if (action.kind === 'replace' && action.why === 'rebuild') {
      notes.push(`${key}: rebuilt — pin the new Overview first and re-size its widgets (UI-only, no API)`);
    }
```

Append:

```ts
/** `--rebuild-overviews people-live,organizations`: explicit keys only. Undefined when the flag is absent. */
export function parseRebuild(args: string[], knownKeys: string[] = Object.keys(OVERVIEW_SPECS)): { keys: string[] } | { error: string } | undefined {
  const i = args.indexOf('--rebuild-overviews');
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (!value || value.startsWith('--')) return { error: '--rebuild-overviews needs board keys, for example --rebuild-overviews people-live,organizations' };
  const keys = value.split(',').map((k) => k.trim()).filter(Boolean);
  if (keys.includes('all')) return { error: '--rebuild-overviews takes explicit board keys, never "all"' };
  const unknown = keys.filter((k) => !knownKeys.includes(k));
  if (unknown.length) return { error: `--rebuild-overviews: no Overview spec for ${unknown.join(', ')} (known: ${knownKeys.join(', ')})` };
  return { keys };
}
```

In `index.ts`, add `parseRebuild` to the `./overviews.js` import. Immediately after `const only = …;` in `runConfigure` add:

```ts
  const rebuild = parseRebuild(args);
  if (rebuild && 'error' in rebuild) { console.error(`configure: ${rebuild.error}`); return 1; }
```

and change the Overview step to

```ts
  const overviews = overviewScope(only);
  if (rebuild && !overviews.run) { console.error('configure: --rebuild-overviews needs the overviews step; drop --only dashboards'); return 1; }
  if (overviews.run) {
    try {
      const result = await configureOverviews(client, boardIds, dryRun, undefined, { only: overviews.boards, rebuild: rebuild?.keys });
```

(the rest of the block is unchanged). Because `parseRebuild` runs before the first API call, a bad flag exits 1 having touched nothing.

- [ ] **Step 4: Run**

Run: `npx vitest run src/configure && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/configure
git commit -m "feat(configure): --rebuild-overviews replaces an Overview whole, for explicit boards only"
```

### Task B10: Documentation

**Files:**
- Modify: `README.md` (this repo)
- Modify, in `monday-migration`: `docs/22-board-configuration-plan.md`, `docs/23-cutover-runbook.md`

- [ ] **Step 1: README.** In the Overview paragraph added in Task A9, append:

```markdown
`--rebuild-overviews people-live,organizations` deletes and recreates the named boards' Overviews
whole (explicit board keys only, never `all`), which also replaces a hand-built one. A new view has
no pin and default widget sizes, so the output lists what is left to do by hand. Fiscal-year widgets
(`@FY` labels, `{ fiscalYear: 'current' }` date ranges) are resolved from the clock on every run, so
a July run needs the `Gift Fiscal Year` column to already hold the new year's label (`classify`
creates it); otherwise the Donations Overview is refused and `configure` exits non-zero.
```

- [ ] **Step 2: `docs/23` step 4.1** (in `monday-migration`). Replace `saved views, and the three dashboards (needs \`MONDAY_DASHBOARD_TOKEN\`)` with `saved views, an Overview dashboard view on each of the 12 boards (ordinary token), and the three workspace dashboards (needs \`MONDAY_DASHBOARD_TOKEN\`)`.

- [ ] **Step 3: `docs/22` §5** (in `monday-migration`). In the carry-forward table, change the row beginning `Calendar (Date) and Kanban (Program) views — **not done yet**` to say Calendar is now an Overview widget built by `configure`, and only Kanban (Program) remains. Leave the pinning and widget-size rows from `docs/31` as they are.

- [ ] **Step 4: Commit in both repos**

```bash
git add README.md && git commit -m "docs(configure): the overviews step, rebuild flag and fiscal-year widgets"
# in monday-migration:
git add docs/22-board-configuration-plan.md docs/23-cutover-runbook.md && git commit -m "docs(22, 23): the Overview step in the cutover run, and Calendar as a widget"
```

### Task B11: Rehearsal on the sandbox, including the rebuild

Sandbox only. Node's DNS can't reach `api.monday.com` from the Claude Code sandbox: run each `npm run cli` command below with the sandbox off.

**Files:** none; results go to `docs/31` §9 and `docs/22` §5 in `monday-migration`.

- [ ] **Step 1: Pre-flight.** Confirm the sandbox target and the token's identity.

```bash
cd "$WS/monday-workers-overview-all/salesforce-import"
python3 -c "import json;print(json.load(open('config/svbc.json'))['monday']['workspaceId'], json.load(open('data/load/boards.json'))['organizations']['boardId'])"   # 17141226 18431577213
node --env-file=.env --input-type=module -e 'const r=await fetch("https://api.monday.com/v2",{method:"POST",headers:{"content-type":"application/json",authorization:process.env.MONDAY_API_TOKEN},body:JSON.stringify({query:"query { me { name } }"})});console.log(JSON.stringify(await r.json()))'   # Sandbox Integration
```

Also confirm the `Gift Fiscal Year` column has the current fiscal-year label (`FY2027` as of 2026-10-14); if not, run `classify` first, or the Donations Overview will be refused (that refusal is the correct behaviour).

- [ ] **Step 2: Dry run.**

```bash
npm run cli -- configure --dry-run --only overviews --rebuild-overviews people-live,organizations
```

Expected: `would replace Overview on people-live (13 widgets)` and `… organizations (9 widgets)`; `would create Overview on <board> (N widgets)` for the other ten, with N matching `docs/31` (donations 12, recurring-gifts 9, events 8, people-historical 4, affiliations 4, campaigns 3, annual-giving-summary 4, event-registrations 4, volunteers 4, activities 5). No refusals.

- [ ] **Step 3: Live run.**

```bash
npm run cli -- configure --only overviews --rebuild-overviews people-live,organizations
```

Expected: exit 0; two `replaced` and ten `created`; notes for the two rebuilds. `data/load/dashboards.json` holds twelve `overview:<board>` entries, all `complete: true`.

- [ ] **Step 4: Second run creates nothing.**

```bash
npm run cli -- configure --only overviews
```

Expected: `overviews up to date`, exit 0.

- [ ] **Step 5: Verify the tiles.** For at least one count tile per board, compare it with `aggregate` using the same rule (`aggregate(query: {from: {type: TABLE, id: "<board id>"}, select: [{type: FUNCTION, function: {function: COUNT_ITEMS}, as: "n"}], query: {rules: [...]}})`), and compare Donations "Received this FY" with the FY2026/FY2027 figures in the board-UX spec §9. Check that `People (Historical)` "Gave this year" is 0 and Annual Giving Summary's chart shows 18 bars (FY2005 to FY2025). Open each Overview in the browser signed in as a board member and confirm every widget renders (the render-after-open failure only shows in the UI), and that the Donations donuts and the Events calendar legend look right.

- [ ] **Step 6: Hand-off for David.** The rebuilt People and Organizations Overviews have lost their pin and widget sizes (UI-only, owner-only). Ask David to re-pin both first and re-size widgets, and to pin Overview second on the other ten boards. Do not attempt this through the API.

- [ ] **Step 7: Record.** Add dated results to `docs/31` §9 (counts, mismatches, anything that did not render) and mark the `docs/22` §5 rows done for the sandbox with the date. Commit in `monday-migration`. Once David has pinned and looked at the boards, add a short paragraph per board to `docs/06` (spec §10). Anything that failed here becomes a fix in this MR before it merges.

### Task B12: Open merge request B, and clean up

- [ ] **Step 1: Full check.** `npx vitest run && npm run typecheck && (cd .. && node scripts/check-log-safety.mjs)`. Expected: PASS.
- [ ] **Step 2: Open the MR** (ask David before pushing): `git push -u origin feat/configure-board-overviews`, titled `feat(configure): Overview dashboard views on all 12 CRM boards, with a sandbox rebuild flag`, stacked on MR A, body linking the spec and `docs/31`.
- [ ] **Step 3: After both merge, clean up** per the workspace `CLAUDE.md`. **First** run `git -C "$WS/monday-workers-overview-all" status --ignored --short | grep '^!!'` and copy out `salesforce-import/data/load/dashboards.json`: it is the only record of which view and widget ids `configure` made on the sandbox. `git worktree remove` silently deletes gitignored files. Then remove both worktrees and delete both local branches.
