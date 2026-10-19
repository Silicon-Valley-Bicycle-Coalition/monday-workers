import { existsSync } from 'node:fs';
import { registerCommand } from '../commands.js';
import { loadConfig } from '../config.js';
import { dataPath, readJson } from '../artifacts.js';
import { MondayClient } from '../load/monday.js';
import type { BoardMap } from '../load/boards.js';
import { configureDashboards } from './dashboards.js';
import { configureOverviews, overviewScope, parseRebuild, checkRebuildScope } from './overviews.js';
import { VIEW_API_VERSION } from './constants.js';
import { BOARD_SPECS, type ColumnSpec } from './spec.js';
import { planBoardBase, planColumnDescriptions, planViews, type ResolvedView, type CurrentBoard, type CurrentColumn } from './plan.js';

interface BoardQueryResult {
  boards: { description: string | null; groups: { id: string; title: string }[];
    columns: { id: string; title: string; type: string; description: string | null; settings_str: string }[];
    views: { id: string; name: string }[] }[];
}

async function fetchBoard(client: MondayClient, boardId: number): Promise<CurrentBoard & { views: { id: string; name: string }[] }> {
  const res = await client.gql<BoardQueryResult>(
    `query ($ids: [ID!]) { boards (ids: $ids) {
       description
       groups { id title }
       columns { id title type description settings_str }
       views { id name } } }`,
    { ids: [String(boardId)] });
  const b = res.boards[0];
  if (!b) throw new Error(`configure: board ${boardId} not found`);
  return { description: b.description, groups: b.groups, columns: b.columns, views: b.views };
}

function columnDefaults(col: ColumnSpec): string | undefined {
  if ((col.type === 'status' || col.type === 'dropdown') && col.labels) {
    if (col.type === 'status') return JSON.stringify({ labels: Object.fromEntries(col.labels.map((l, i) => [i, l])) });
    return JSON.stringify({ labels: col.labels.map((l, i) => ({ id: i + 1, name: l })) });
  }
  return undefined;
}

const VIEW_ARGS = `$board: ID!, $name: String, $filter: ItemsQueryGroup, $sort: [ItemsQueryOrderBy!],
  $tags: [String!], $settings: TableViewSettingsInput, $conditional_formatting_settings: [ConditionalFormattingConditionInput!]`;
const VIEW_PASS = `board_id: $board, name: $name, filter: $filter, sort: $sort, tags: $tags,
  settings: $settings, conditional_formatting_settings: $conditional_formatting_settings`;

// conditional_formatting_settings on create/update_view_table exists only in API 2026-10.

const viewIds = (board: { views: { id: string; name: string }[] }) => new Map(board.views.map((v) => [v.name, v.id]));

function viewVars(boardId: number, v: ResolvedView) {
  return {
    board: String(boardId), name: v.name,
    filter: v.rules.length ? { operator: v.filterOperator, rules: v.rules } : undefined,
    sort: v.sort.length ? v.sort : undefined,
    tags: v.tags.length ? v.tags : undefined,
    settings: v.settings,
    conditional_formatting_settings: v.conditionalFormatting.length ? v.conditionalFormatting : undefined,
  };
}

export interface ConfigureResult { ok: boolean; summary: string; notes: string[] }

export async function configureBoard(
  client: MondayClient, boardId: number, spec: (typeof BOARD_SPECS)[string], dryRun: boolean,
): Promise<ConfigureResult> {
  const current = await fetchBoard(client, boardId);
  const base = planBoardBase(current, spec);
  const notes = [...base.notes];
  const actions: string[] = [];

  if (dryRun) {
    if (base.description) actions.push('set description');
    if (base.groupRename) actions.push(`rename default group to "${base.groupRename.newTitle}"`);
    if (base.columnsToCreate.length) actions.push(`create ${base.columnsToCreate.length} column(s): ${base.columnsToCreate.map((c) => c.title).join(', ')}`);
    if (base.viewsToDelete.length) actions.push(`delete ${base.viewsToDelete.length} stray view(s)`);
    const descPlan = planColumnDescriptions(current.columns, spec);
    const viewPlan = planViews(current.columns, viewIds(current), spec, boardId);
    if (descPlan.updates.length) actions.push(`set ${descPlan.updates.length} column description(s)`);
    if (viewPlan.views.create.length) actions.push(`create ${viewPlan.views.create.length} view(s): ${viewPlan.views.create.map((v) => v.name).join(', ')}`);
    if (viewPlan.views.update.length) actions.push(`re-apply ${viewPlan.views.update.length} view(s)`);
    notes.push(...descPlan.notes, ...viewPlan.notes,
      'dry-run preview only — descriptions/views referencing columns created in this same run may resolve differently once applied for real');
    return { ok: true, summary: actions.length ? `would ${actions.join('; ')}` : 'already up to date', notes };
  }

  if (base.description) {
    await client.gql(`mutation ($board: ID!, $value: String!) {
      update_board (board_id: $board, board_attribute: description, new_value: $value) }`,
      { board: String(boardId), value: base.description });
    actions.push('set description');
  }
  if (base.groupRename) {
    await client.gql(`mutation ($board: ID!, $group: String!, $value: String!) {
      update_group (board_id: $board, group_id: $group, group_attribute: title, new_value: $value) { id } }`,
      { board: String(boardId), group: base.groupRename.groupId, value: base.groupRename.newTitle });
    actions.push(`renamed default group to "${base.groupRename.newTitle}"`);
  }
  for (const col of base.columnsToCreate) {
    await client.gql<{ create_column: { id: string } }>(
      `mutation ($board: ID!, $title: String!, $type: ColumnType!, $defaults: JSON) {
         create_column (board_id: $board, title: $title, column_type: $type, defaults: $defaults) { id } }`,
      { board: String(boardId), title: col.title, type: col.type, defaults: columnDefaults(col) });
  }
  if (base.columnsToCreate.length) actions.push(`created ${base.columnsToCreate.length} column(s)`);
  for (const v of base.viewsToDelete) {
    await client.gql(`mutation ($view: ID!, $board: ID!) { delete_view (view_id: $view, board_id: $board) { id } }`,
      { view: v.viewId, board: String(boardId) });
  }
  if (base.viewsToDelete.length) actions.push(`deleted ${base.viewsToDelete.length} stray view(s)`);

  // Re-fetch columns so descriptions/views can target columns just created above.
  const refreshed: CurrentColumn[] = base.columnsToCreate.length || base.description || base.groupRename
    ? (await fetchBoard(client, boardId)).columns
    : current.columns;

  const descPlan = planColumnDescriptions(refreshed, spec);
  for (const u of descPlan.updates) {
    await client.gql(`mutation ($board: ID!, $col: String!, $value: String) {
      change_column_metadata (board_id: $board, column_id: $col, column_property: description, value: $value) { id } }`,
      { board: String(boardId), col: u.columnId, value: u.text });
  }
  if (descPlan.updates.length) actions.push(`set ${descPlan.updates.length} column description(s)`);
  notes.push(...descPlan.notes);

  const viewPlan = planViews(refreshed, viewIds(current), spec, boardId);
  for (const v of viewPlan.views.create) {
    await client.gql(`mutation (${VIEW_ARGS}) { create_view_table (${VIEW_PASS}) { id } }`, viewVars(boardId, v), { apiVersion: VIEW_API_VERSION, idempotent: false });
  }
  for (const v of viewPlan.views.update) {
    await client.gql(`mutation ($view: ID!, ${VIEW_ARGS}) { update_view_table (view_id: $view, ${VIEW_PASS}) { id } }`,
      { view: v.viewId, ...viewVars(boardId, v) }, { apiVersion: VIEW_API_VERSION });
  }
  if (viewPlan.views.create.length) actions.push(`created ${viewPlan.views.create.length} view(s)`);
  if (viewPlan.views.update.length) actions.push(`re-applied ${viewPlan.views.update.length} view(s)`);
  notes.push(...viewPlan.notes);

  return { ok: true, summary: actions.length ? actions.join('; ') : 'already up to date', notes };
}

/** Dashboard mutations need a user allowed to create dashboards; the integration user gets 403. */
export function dashboardToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env['MONDAY_DASHBOARD_TOKEN'] || env['MONDAY_API_TOKEN'] || undefined;
}

export async function runConfigure(args: string[], deps: { client?: MondayClient; dashboardClient?: MondayClient } = {}): Promise<number> {
  const cfg = loadConfig();
  const dryRun = args.includes('--dry-run');
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 ? args[onlyIdx + 1]?.split(',') : undefined;
  const rebuild = parseRebuild(args);
  if (rebuild && 'error' in rebuild) { console.error(`configure: ${rebuild.error}`); return 1; }
  const overviews = overviewScope(only);
  const scopeError = checkRebuildScope(rebuild?.keys, overviews);
  if (scopeError) { console.error(`configure: ${scopeError}`); return 1; }

  const boardsPath = dataPath('load', 'boards.json');
  if (!existsSync(boardsPath)) {
    console.error('configure: data/load/boards.json not found — run `load` first so board ids exist');
    return 1;
  }
  const map = await readJson<BoardMap>(boardsPath);

  const token = process.env['MONDAY_API_TOKEN'];
  if (!dryRun && !token) { console.error('configure: MONDAY_API_TOKEN not set'); return 1; }
  const client = deps.client ?? new MondayClient({ apiUrl: cfg.monday.apiUrl, token: token ?? '' });

  let ok = true;
  for (const [key, spec] of Object.entries(BOARD_SPECS)) {
    if (only && !only.includes(key)) continue;
    const entry = map[key];
    if (!entry) { console.log(`configure: ${key} — no board id in data/load/boards.json, skipping`); continue; }
    try {
      const result = await configureBoard(client, entry.boardId, spec, dryRun);
      console.log(`configure: ${key} (${entry.boardId}) — ${result.summary}`);
      for (const note of result.notes) console.log(`  note: ${note}`);
      if (!result.ok) ok = false;
    } catch (err) {
      console.error(`configure: ${key} (${entry.boardId}) — FAILED: ${(err as Error).message}`);
      ok = false;
    }
  }
  const extraPath = dataPath('load', 'extra-boards.json');
  const extra = existsSync(extraPath) ? await readJson<Record<string, number>>(extraPath) : {};
  const boardIds: Record<string, number> = { ...Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v.boardId])), ...extra };

  // Overview dashboard views: ordinary token, no dashboard-rights user needed (verified 2026-10-14).
  if (overviews.run) {
    try {
      const result = await configureOverviews(client, boardIds, dryRun, undefined, { only: overviews.boards, rebuild: rebuild?.keys });
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
      if (cfg.monday.workspaceId == null) throw new Error('monday.workspaceId is not set in config — cannot create dashboards');
      const dashToken = dashboardToken();
      const dashClient = deps.dashboardClient
        ?? (dashToken && dashToken !== token ? new MondayClient({ apiUrl: cfg.monday.apiUrl, token: dashToken }) : client);
      const result = await configureDashboards(dashClient, cfg.monday.workspaceId, boardIds, dryRun);
      console.log(`configure: dashboards — ${result.summary}`);
      for (const note of result.notes) console.log(`  note: ${note}`);
    } catch (err) {
      console.error(`configure: dashboards — FAILED: ${(err as Error).message}`);
      ok = false;
    }
  }
  return ok ? 0 : 1;
}

registerCommand('configure', (args) => runConfigure(args));
