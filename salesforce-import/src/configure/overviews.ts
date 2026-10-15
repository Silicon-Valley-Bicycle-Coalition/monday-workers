import { existsSync } from 'node:fs';
import { readJson, writeJson } from '../artifacts.js';
import type { MondayClient } from '../load/monday.js';
import { VIEW_API_VERSION } from './constants.js';
import { STATE_FILE, type DashboardState } from './dashboards.js';
import type { ConfigureResult } from './index.js';
import { OVERVIEW_SPECS } from './overviewSpecs.js';
import type { CurrentColumn } from './plan.js';
import { widgetFilter, widgetSettings, type Columns, type WidgetSpec } from './widgets.js';

export const OVERVIEW_NAME = 'Overview';

export interface OverviewSpec { widgets: WidgetSpec[] }
export interface PlannedWidget { name: string; kind: WidgetSpec['kind']; settings: unknown; filter?: unknown }
export type OverviewPlan = { ok: true; widgets: PlannedWidget[] } | { ok: false; errors: string[] };

const isError = (v: unknown): v is { error: string } => typeof v === 'object' && v !== null && 'error' in v;

// An Overview is created whole or not at all: widgets added to a board-view dashboard after it has
// been opened do not render, so a half-resolvable spec must not produce a half-built view.
export function planOverview(spec: OverviewSpec, columns: Columns, now: Date = new Date()): OverviewPlan {
  const widgets: PlannedWidget[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const w of spec.widgets) {
    if (seen.has(w.name)) { errors.push(`duplicate widget name "${w.name}"`); continue; }
    seen.add(w.name);
    const settings = widgetSettings(w, columns);
    if (isError(settings)) { errors.push(`widget "${w.name}": ${settings.error}`); continue; }
    const filter = widgetFilter(w, columns, now);
    if (isError(filter)) { errors.push(`widget "${w.name}": ${filter.error}`); continue; }
    widgets.push({ name: w.name, kind: w.kind, settings, ...(filter ? { filter } : {}) });
  }
  return errors.length ? { ok: false, errors } : { ok: true, widgets };
}

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

export interface OverviewOptions { only?: string[]; now?: Date }

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
    const plan = planOverview(spec, columns, opts.now ?? new Date());
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

/** `--only`: absent runs every board; `overviews` runs them all; board keys scope to those boards; `dashboards` alone skips the step. */
export function overviewScope(only: string[] | undefined): { run: boolean; boards?: string[] } {
  if (!only || only.includes('overviews')) return { run: true };
  const boards = only.filter((k) => k !== 'dashboards');
  return boards.length ? { run: true, boards } : { run: false };
}
