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
