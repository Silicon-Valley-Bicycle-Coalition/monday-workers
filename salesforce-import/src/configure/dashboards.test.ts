import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planDashboard, configureDashboards, type DashboardSpec, type DashboardState } from './dashboards.js';
import { dataPath, readJson } from '../artifacts.js';
import type { MondayClient } from '../load/monday.js';
import type { CurrentColumn } from './plan.js';

const col = (id: string, title: string, type = 'numbers', settings_str = '{}'): CurrentColumn => ({ id, title, type, description: null, settings_str });
const COLUMNS = new Map([
  ['donations', { boardId: 10, columns: [col('am', 'Amount'), col('dt', 'Date', 'date'),
    col('fs', 'Funding Stream', 'status'), col('fq', 'Fiscal Quarter', 'status'), col('gfy', 'Gift Fiscal Year', 'status'),
    col('at', 'Acknowledgment Tier', 'status', '{"labels":{"0":"Standard","1":"Major"}}'), col('ty', 'Thank You Sent', 'checkbox')] }],
  ['people-live', { boardId: 20, columns: [col('tya', 'This Year Amount')] }],
  ['organizations', { boardId: 30, columns: [col('tya2', 'This Year Amount')] }],
]);

const SPEC: DashboardSpec = { name: 'Board Report', boards: ['donations', 'people-live', 'organizations'], widgets: [
  { name: 'Revenue by quarter and stream', kind: 'CHART',
    chart: { board: 'donations', graphType: 'stacked_column', x: 'Fiscal Quarter', xGroupBy: 'color', y: 'Amount', z: 'Funding Stream' } },
  { name: 'Raised this FY', kind: 'NUMBER',
    number: { boards: ['people-live', 'organizations'], column: 'This Year Amount', counter: 'sum', format: 'currency' } },
  { name: 'Major gifts not yet thanked', kind: 'NUMBER',
    number: { boards: ['donations'], column: 'Amount', counter: 'sum', format: 'currency' },
    filter: { board: 'donations', rules: [{ columnTitle: 'Acknowledgment Tier', operator: 'any_of', labelValues: ['Major'] },
      { columnTitle: 'Thank You Sent', operator: 'is_empty' }] } },
] };

describe('planDashboard', () => {
  it('creates the dashboard and every widget on first run', () => {
    const plan = planDashboard(SPEC, undefined, COLUMNS);
    expect(plan.createDashboard).toBe(true);
    expect(plan.widgets.map((w) => w.name)).toEqual(SPEC.widgets.map((w) => w.name));
  });

  it('resolves a stacked chart to column ids', () => {
    const w = planDashboard(SPEC, undefined, COLUMNS).widgets[0]!;
    expect(w.settings).toEqual({ graph_type: 'stacked_column', x_axis_columns: { '10': ['fq'] }, y_axis_columns: { '10': ['am'] },
      z_axis_columns: { '10': ['fs'] }, x_axis_group_by: 'color', y_axis_group_by: 'numeric', calc_function_type: 'sum' });
  });

  it('sums a number across boards with each board’s own column id', () => {
    const w = planDashboard(SPEC, undefined, COLUMNS).widgets[1]!;
    expect(w.settings).toEqual({ counter_data: { calculation_type: 'columns', counter_type: 'sum',
      column_ids_per_board: { '20': ['tya'], '30': ['tya2'] }, counter_unit: { symbol: '$', direction: 'left' } }, number_format: 'currency' });
  });

  it('resolves a widget filter with label ids', () => {
    const w = planDashboard(SPEC, undefined, COLUMNS).widgets[2]!;
    expect(w.filter).toEqual({ operator: 'and', rules: [
      { column_id: 'at', operator: 'any_of', compare_value: [1] }, { column_id: 'ty', operator: 'is_empty', compare_value: [] }] });
  });

  it('skips widgets already recorded in state, and does not recreate the dashboard', () => {
    const plan = planDashboard(SPEC, { id: 'd1', widgets: { 'Raised this FY': 'w1' } }, COLUMNS);
    expect(plan.createDashboard).toBe(false);
    expect(plan.widgets.map((w) => w.name)).not.toContain('Raised this FY');
  });

  it('skips a widget whose column is missing, with a note', () => {
    const cols = new Map(COLUMNS); cols.set('donations', { boardId: 10, columns: [col('am', 'Amount')] });
    const plan = planDashboard(SPEC, undefined, cols);
    expect(plan.widgets.map((w) => w.name)).not.toContain('Revenue by quarter and stream');
    expect(plan.notes.join()).toMatch(/Fiscal Quarter/);
  });
});


describe('configureDashboards (apply path)', () => {
  beforeEach(() => { process.chdir(mkdtempSync(join(tmpdir(), 'sfimp-'))); });

  const BOARD_IDS = { donations: 10, 'people-live': 20, organizations: 30 };
  const SIMPLE: DashboardSpec = { name: 'Board Report', boards: ['donations', 'people-live', 'organizations'],
    widgets: SPEC.widgets.slice(0, 3) };
  type Call = { query: string; variables: Record<string, unknown>; opts?: { idempotent?: boolean } };

  function fake(failOnWidget?: number) {
    const calls: Call[] = [];
    let widgets = 0;
    const client = { async gql(query: string, variables: Record<string, unknown> = {}, opts?: { idempotent?: boolean }) {
      calls.push({ query, variables, opts });
      if (/^\s*query/.test(query)) {
        const id = Number((variables['ids'] as string[])[0]);
        const [, b] = [...COLUMNS].find(([, v]) => v.boardId === id)!;
        return { boards: [{ columns: b.columns }] };
      }
      if (/create_dashboard/.test(query)) return { create_dashboard: { id: 'dash1' } };
      if (/create_widget/.test(query)) {
        widgets++;
        if (widgets === failOnWidget) throw new Error('boom');
        return { create_widget: { id: `w${widgets}` } };
      }
      throw new Error('unexpected ' + query);
    } } as unknown as MondayClient;
    return { client, calls, mutations: () => calls.filter((c) => /^\s*mutation/.test(c.query)) };
  }

  it('dry-run makes no mutations and writes no state', async () => {
    const f = fake();
    const r = await configureDashboards(f.client, 1, BOARD_IDS, true, [SIMPLE]);
    expect(r.summary).toMatch(/create dashboard "Board Report"/);
    expect(f.mutations()).toEqual([]);
    expect(existsSync(dataPath('load', 'dashboards.json'))).toBe(false);
  });

  it('creates the dashboard and widgets as non-idempotent writes', async () => {
    const f = fake();
    await configureDashboards(f.client, 1, BOARD_IDS, false, [SIMPLE]);
    const m = f.mutations();
    expect(m).toHaveLength(4);
    for (const c of m) expect(c.opts).toEqual({ idempotent: false });
  });

  it('resumes after a failed widget create without duplicating anything', async () => {
    const failing = fake(2);
    await expect(configureDashboards(failing.client, 1, BOARD_IDS, false, [SIMPLE])).rejects.toThrow('boom');
    const state = await readJson<DashboardState>(dataPath('load', 'dashboards.json'));
    expect(state['Board Report']).toEqual({ id: 'dash1', widgets: { [SIMPLE.widgets[0]!.name]: 'w1' } });

    const working = fake();
    await configureDashboards(working.client, 1, BOARD_IDS, false, [SIMPLE]);
    const m = working.mutations();
    expect(m.some((c) => /create_dashboard/.test(c.query))).toBe(false);
    expect(m.filter((c) => /create_widget/.test(c.query)).map((c) => c.variables['name'])).toEqual(SIMPLE.widgets.slice(1).map((w) => w.name));
    const after = await readJson<DashboardState>(dataPath('load', 'dashboards.json'));
    expect(Object.keys(after['Board Report']!.widgets)).toHaveLength(3);
  });

  it('refuses to create a dashboard when a spec board has no id, and writes no state', async () => {
    const f = fake();
    const r = await configureDashboards(f.client, 1, { donations: 10, 'people-live': 20 }, false, [SIMPLE]);
    expect(f.mutations()).toEqual([]);
    expect(r.notes.join()).toMatch(/Board Report: not created — no board id for organizations/);
    expect(existsSync(dataPath('load', 'dashboards.json'))).toBe(false);
  });
});
