import { fiscalYearLabel, fiscalYearRange, isFiscalYearValue } from './fiscal.js';
import { resolveLabelId } from './labels.js';
import type { CurrentColumn, ResolvedRule } from './plan.js';
import type { FilterRule } from './spec.js';

export interface WidgetSpec {
  name: string;
  kind: 'CHART' | 'NUMBER' | 'LISTVIEW' | 'CALENDAR';
  chart?: { board: string; graphType: string; x: string; xGroupBy: 'color' | 'date' | 'name' | 'group';
    dateGroupBy?: 'month' | 'quarter' | 'year'; y: string | 'count'; z?: string };
  number?: { boards: string[]; column?: string; count?: true; counter?: 'sum' | 'average'; prefix?: string; format?: 'currency' | 'number' };
  list?: { board: string; columns: string[] };
  calendar?: { board: string; dateColumn: string; colorBy?: string };
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
    if (typeof id !== 'string') return id;
    perBoard[String(columns.get(board)!.boardId)] = [id];
  }
  return {
    counter_data: { calculation_type: 'columns', counter_type: n.counter ?? 'sum', column_ids_per_board: perBoard,
      ...(n.format === 'currency' ? { counter_unit: { symbol: '$', direction: 'left' } } : {}) },
    ...(n.prefix ? { prefix: n.prefix } : {}),
    number_format: n.format ?? 'number',
  };
}

// '@FY' and '@FY-1' stand for the current and previous fiscal-year label, resolved from the clock.
const fiscalLabel = (label: string, now: Date): string =>
  label === '@FY' ? fiscalYearLabel(now) : label === '@FY-1' ? fiscalYearLabel(now, -1) : label;

export function widgetFilter(w: WidgetSpec, columns: Columns, now: Date = new Date()): { operator: 'and'; rules: ResolvedRule[] } | undefined | { error: string } {
  if (!w.filter) return undefined;
  const rules: ResolvedRule[] = [];
  for (const r of w.filter.rules) {
    const c = columns.get(w.filter.board)?.columns.find((x) => x.title === r.columnTitle);
    if (!c) return { error: `filter column "${r.columnTitle}" missing` };
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
    rules.push({ column_id: c.id, operator: r.operator, compare_value });
  }
  return { operator: 'and', rules };
}
