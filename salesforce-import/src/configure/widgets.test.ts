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

  it('errors when a number widget has both count and a column', () => {
    const w: WidgetSpec = { name: 'Both', kind: 'NUMBER', number: { boards: ['people-live'], count: true, column: 'This Year Amount' } };
    expect(widgetSettings(w, COLUMNS)).toEqual({ error: 'number widget "Both" has both count and column' });
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
