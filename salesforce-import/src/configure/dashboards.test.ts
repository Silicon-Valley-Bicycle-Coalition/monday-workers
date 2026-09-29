import { describe, it, expect } from 'vitest';
import { planDashboard, type DashboardSpec } from './dashboards.js';
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
