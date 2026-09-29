import { existsSync } from 'node:fs';
import { dataPath, readJson, writeJson } from '../artifacts.js';
import type { MondayClient } from '../load/monday.js';
import { resolveLabelId } from './labels.js';
import type { CurrentColumn, ResolvedRule } from './plan.js';
import type { FilterRule } from './spec.js';
import { DASHBOARD_SPECS } from './spec.js';
import type { ConfigureResult } from './index.js';

export interface WidgetSpec {
  name: string;
  kind: 'CHART' | 'NUMBER';
  chart?: { board: string; graphType: string; x: string; xGroupBy: 'color' | 'date' | 'name' | 'group';
    dateGroupBy?: 'month' | 'quarter'; y: string | 'count'; z?: string };
  number?: { boards: string[]; column: string; counter: 'sum' | 'average'; prefix?: string; format?: 'currency' | 'number' };
  filter?: { board: string; rules: FilterRule[] };
}
export interface DashboardSpec { name: string; boards: string[]; widgets: WidgetSpec[] }
export type DashboardState = Record<string, { id: string; widgets: Record<string, string> }>;
type Columns = Map<string, { boardId: number; columns: CurrentColumn[] }>;

const STATE_FILE = () => dataPath('load', 'dashboards.json');

function colId(columns: Columns, board: string, title: string): string | { error: string } {
  const b = columns.get(board);
  if (!b) return { error: `board "${board}" has no id` };
  if (title === 'name') return 'name';
  const c = b.columns.find((x) => x.title === title);
  return c ? c.id : { error: `board "${board}" has no column "${title}"` };
}

function widgetSettings(w: WidgetSpec, columns: Columns): unknown | { error: string } {
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

function widgetFilter(w: WidgetSpec, columns: Columns): { operator: 'and'; rules: ResolvedRule[] } | undefined | { error: string } {
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

export function planDashboard(spec: DashboardSpec, state: DashboardState[string] | undefined, columns: Columns) {
  const notes: string[] = [];
  const widgets: { name: string; kind: string; settings: unknown; filter?: unknown }[] = [];
  for (const w of spec.widgets) {
    if (state?.widgets[w.name]) continue;
    const settings = widgetSettings(w, columns);
    if (settings && typeof settings === 'object' && 'error' in settings) { notes.push(`widget "${w.name}" skipped — ${(settings as { error: string }).error}`); continue; }
    const filter = widgetFilter(w, columns);
    if (filter && 'error' in filter) { notes.push(`widget "${w.name}" skipped — ${filter.error}`); continue; }
    widgets.push({ name: w.name, kind: w.kind, settings, ...(filter ? { filter } : {}) });
  }
  return { createDashboard: !state, widgets, notes };
}

// Dashboards and widgets have no stable natural key in the API, so what configure created is
// remembered in data/load/dashboards.json (gitignored, like boards.json). State is saved after
// every successful create, so a run that dies midway never creates the same thing twice.
export async function configureDashboards(
  client: MondayClient, workspaceId: number, boardIds: Record<string, number>, dryRun: boolean,
): Promise<ConfigureResult> {
  const state: DashboardState = existsSync(STATE_FILE()) ? await readJson<DashboardState>(STATE_FILE()) : {};
  const columns: Columns = new Map();
  for (const [key, boardId] of Object.entries(boardIds)) {
    const res = await client.gql<{ boards: { columns: CurrentColumn[] }[] }>(
      'query ($ids: [ID!]) { boards (ids: $ids) { columns { id title type description settings_str } } }', { ids: [String(boardId)] });
    columns.set(key, { boardId, columns: res.boards[0]?.columns ?? [] });
  }
  const actions: string[] = [];
  const notes: string[] = [];
  for (const spec of DASHBOARD_SPECS) {
    const plan = planDashboard(spec, state[spec.name], columns);
    notes.push(...plan.notes.map((n) => `${spec.name}: ${n}`));
    if (dryRun) {
      if (plan.createDashboard) actions.push(`create dashboard "${spec.name}"`);
      if (plan.widgets.length) actions.push(`create ${plan.widgets.length} widget(s) on "${spec.name}"`);
      continue;
    }
    if (plan.createDashboard) {
      const ids = spec.boards.map((b) => boardIds[b]).filter((id): id is number => id !== undefined).map(String);
      const res = await client.gql<{ create_dashboard: { id: string } }>(
        `mutation ($name: String!, $ws: ID!, $boards: [ID!]!) {
           create_dashboard (name: $name, workspace_id: $ws, board_ids: $boards, kind: PUBLIC) { id } }`,
        { name: spec.name, ws: String(workspaceId), boards: ids });
      state[spec.name] = { id: res.create_dashboard.id, widgets: {} };
      await writeJson(STATE_FILE(), state);
      actions.push(`created dashboard "${spec.name}"`);
    }
    for (const w of plan.widgets) {
      const res = await client.gql<{ create_widget: { id: string } }>(
        `mutation ($parent: WidgetParentInput!, $kind: ExternalWidget!, $name: String!, $settings: JSON!, $filter: ItemsQueryGroup) {
           create_widget (parent: $parent, kind: $kind, name: $name, settings: $settings, filter: $filter) { id } }`,
        { parent: { kind: 'DASHBOARD', id: state[spec.name]!.id }, kind: w.kind, name: w.name,
          settings: w.settings, filter: w.filter });
      state[spec.name]!.widgets[w.name] = res.create_widget.id;
      await writeJson(STATE_FILE(), state);
    }
    if (plan.widgets.length) actions.push(`created ${plan.widgets.length} widget(s) on "${spec.name}"`);
  }
  return { ok: true, summary: actions.length ? actions.join('; ') : 'dashboards up to date', notes };
}
