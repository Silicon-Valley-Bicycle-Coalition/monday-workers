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
