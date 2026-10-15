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
  client: MondayClient, workspaceId: number, boardIds: Record<string, number>, dryRun: boolean, specs: DashboardSpec[] = DASHBOARD_SPECS,
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
  for (const spec of specs) {
    const plan = planDashboard(spec, state[spec.name], columns);
    notes.push(...plan.notes.map((n) => `${spec.name}: ${n}`));
    // A dashboard created without all its boards would silently lose data sources, and state
    // would then mark it done — so refuse until every board has an id.
    const missing = spec.boards.filter((b) => boardIds[b] === undefined);
    if (plan.createDashboard && missing.length) {
      notes.push(`${spec.name}: not created — no board id for ${missing.join(', ')} (run without --only, after \`load\`)`);
      continue;
    }
    if (dryRun) {
      if (plan.createDashboard) actions.push(`create dashboard "${spec.name}"`);
      if (plan.widgets.length) actions.push(`create ${plan.widgets.length} widget(s) on "${spec.name}"`);
      continue;
    }
    if (plan.createDashboard) {
      const ids = spec.boards.map((b) => String(boardIds[b]));
      const res = await client.gql<{ create_dashboard: { id: string } }>(
        `mutation ($name: String!, $ws: ID!, $boards: [ID!]!) {
           create_dashboard (name: $name, workspace_id: $ws, board_ids: $boards, kind: PUBLIC) { id } }`,
        { name: spec.name, ws: String(workspaceId), boards: ids }, { idempotent: false });
      state[spec.name] = { id: res.create_dashboard.id, widgets: {} };
      await writeJson(STATE_FILE(), state);
      actions.push(`created dashboard "${spec.name}"`);
    }
    for (const w of plan.widgets) {
      const res = await client.gql<{ create_widget: { id: string } }>(
        `mutation ($parent: WidgetParentInput!, $kind: ExternalWidget!, $name: String!, $settings: JSON!, $filter: ItemsQueryGroup) {
           create_widget (parent: $parent, kind: $kind, name: $name, settings: $settings, filter: $filter) { id } }`,
        { parent: { kind: 'DASHBOARD', id: state[spec.name]!.id }, kind: w.kind, name: w.name,
          settings: w.settings, filter: w.filter }, { idempotent: false });
      state[spec.name]!.widgets[w.name] = res.create_widget.id;
      await writeJson(STATE_FILE(), state);
    }
    if (plan.widgets.length) actions.push(`created ${plan.widgets.length} widget(s) on "${spec.name}"`);
  }
  return { ok: true, summary: actions.length ? actions.join('; ') : 'dashboards up to date', notes };
}
