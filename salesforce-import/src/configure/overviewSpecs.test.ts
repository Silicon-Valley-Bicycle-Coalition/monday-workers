import { describe, it, expect } from 'vitest';
import { OVERVIEW_SPECS, PROVISIONED_ELSEWHERE } from './overviewSpecs.js';
import { BOARD_SPECS } from './spec.js';
import { COLUMN_TYPES, CONNECT_COLUMNS } from '../load/boards.js';
import type { WidgetSpec } from './widgets.js';

const boardsOf = (w: WidgetSpec): string[] => [
  ...(w.chart ? [w.chart.board] : []), ...(w.number?.boards ?? []), ...(w.list ? [w.list.board] : []),
  ...(w.filter ? [w.filter.board] : []),
];
const columnTitlesOf = (w: WidgetSpec): string[] => {
  const t: string[] = [];
  if (w.chart) { t.push(w.chart.x); if (w.chart.y !== 'count') t.push(w.chart.y); if (w.chart.z) t.push(w.chart.z); }
  if (w.number?.column) t.push(w.number.column);
  if (w.list) t.push(...w.list.columns);
  for (const r of w.filter?.rules ?? []) t.push(r.columnTitle);
  return t.filter((x) => x !== 'name');
};
const known = (board: string) => new Set<string>([
  ...Object.keys(COLUMN_TYPES), ...CONNECT_COLUMNS,
  ...(BOARD_SPECS[board]?.columns ?? []).map((c) => c.title), ...(PROVISIONED_ELSEWHERE[board] ?? []),
]);

describe('OVERVIEW_SPECS', () => {
  const entries = Object.entries(OVERVIEW_SPECS);

  it('has an Overview for the lookup boards', () => {
    expect(Object.keys(OVERVIEW_SPECS)).toEqual(expect.arrayContaining(['people-live', 'organizations']));
  });

  it('names widgets uniquely per board', () => {
    for (const [board, s] of entries) {
      const names = s.widgets.map((w) => w.name);
      expect(new Set(names).size, board).toBe(names.length);
    }
  });

  it('every widget names only its own board', () => {
    for (const [board, s] of entries) for (const w of s.widgets) for (const b of boardsOf(w)) expect(b, `${board} / ${w.name}`).toBe(board);
  });

  it('every column title a widget uses is known to this repo or listed as provisioned elsewhere', () => {
    for (const [board, s] of entries) {
      const ok = known(board);
      for (const w of s.widgets) for (const title of columnTitlesOf(w)) expect(ok.has(title), `${board} / ${w.name} / ${title}`).toBe(true);
    }
  });

  it('keeps the as-built widget sets from #51', () => {
    expect(OVERVIEW_SPECS['people-live']!.widgets.map((w) => w.name)).toEqual(expect.arrayContaining(
      ['Active members', 'Memberships ending in 60 days', 'Donors this FY', 'Raised this FY', 'Donors by level', 'Members by status',
        'Find a person', 'Leadership and major donors']));
    expect(OVERVIEW_SPECS['organizations']!.widgets.map((w) => w.name)).toEqual(expect.arrayContaining(
      ['Organizations giving this FY', 'Raised this FY', 'Organizations by donor level', 'Find an organization', 'Funders and matching companies']));
  });
});
