import { describe, it, expect } from 'vitest';
import { OVERVIEW_SPECS, PROVISIONED_ELSEWHERE } from './overviewSpecs.js';
import { BOARD_SPECS } from './spec.js';
import { COLUMN_TYPES, CONNECT_COLUMNS } from '../load/boards.js';
import { widgetFilter, widgetSettings, type Columns, type WidgetSpec } from './widgets.js';
import { col } from './testFixtures.js';

const boardsOf = (w: WidgetSpec): string[] => [
  ...(w.chart ? [w.chart.board] : []), ...(w.number?.boards ?? []), ...(w.list ? [w.list.board] : []),
  ...(w.calendar ? [w.calendar.board] : []), ...(w.filter ? [w.filter.board] : []),
];
const columnTitlesOf = (w: WidgetSpec): string[] => {
  const t: string[] = [];
  if (w.chart) { t.push(w.chart.x); if (w.chart.y !== 'count') t.push(w.chart.y); if (w.chart.z) t.push(w.chart.z); }
  if (w.number?.column) t.push(w.number.column);
  if (w.list) t.push(...w.list.columns);
  if (w.calendar) { t.push(w.calendar.dateColumn); if (w.calendar.colorBy) t.push(w.calendar.colorBy); }
  for (const r of w.filter?.rules ?? []) t.push(r.columnTitle);
  return t.filter((x) => x !== 'name');
};
// Checks titles against a flat map across all boards (COLUMN_TYPES), so it catches typos but not a
// title that exists only on a different board; the sandbox rehearsal is what proves each spec
// resolves on its own board.
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

  it('has the five full dashboards from docs/31 §4', () => {
    const names = (k: string) => OVERVIEW_SPECS[k]!.widgets.map((w) => w.name);
    expect(names('people-live')).toEqual(expect.arrayContaining(['Gave last year, not this year', 'Raised last FY', 'New donors by month', 'Renewals due by year']));
    expect(names('organizations')).toEqual(expect.arrayContaining(['Raised last FY', 'Untyped', 'DNS reason missing', 'Raised this FY by donor level']));
    expect(names('donations')).toEqual(expect.arrayContaining(['Received this FY', 'Received last FY', 'Major gifts to thank', 'Revenue by month', 'Revenue by Funding Stream']));
    expect(names('recurring-gifts')).toEqual(expect.arrayContaining(['Active pledges', 'Expected next 30 days', 'Failed pledges']));
    expect(names('events')).toEqual(expect.arrayContaining(['Events', 'Upcoming', 'Calendar', 'Events by year']));
  });

  it('puts the Received rule on every Donations widget except the two that span every Status (D8)', () => {
    const received = (w: WidgetSpec) => (w.filter?.rules ?? []).some((r) => r.columnTitle === 'Status' && r.labelValues?.includes('Received'));
    for (const w of OVERVIEW_SPECS['donations']!.widgets) {
      const spans = ['Pending', 'Needs a donor'].includes(w.name);
      expect(received(w), w.name).toBe(!spans);
    }
  });

  it('a list and a tile that share a worklist share its filter, so tile and tab agree', () => {
    const rules = (k: string, n: string) => OVERVIEW_SPECS[k]!.widgets.find((w) => w.name === n)!.filter!.rules;
    expect(rules('donations', 'Major gifts to thank (list)')).toEqual(rules('donations', 'Major gifts to thank'));
    expect(rules('people-live', 'Gave last year, not this year (list)')).toEqual(rules('people-live', 'Gave last year, not this year'));
  });

  it('the Events Upcoming tile counts what the Upcoming view lists', () => {
    const tile = OVERVIEW_SPECS['events']!.widgets.find((w) => w.name === 'Upcoming')!;
    const tab = BOARD_SPECS['events']!.views!.find((v) => v.name === 'Upcoming')!;
    expect(tile.filter!.rules).toEqual(tab.filter!.rules);
  });

  it('writes fiscal years as @FY / @FY-1 and { fiscalYear } ranges, never literal years, dates or bare numbers', () => {
    for (const [board, s] of entries) for (const w of s.widgets) for (const r of w.filter?.rules ?? []) {
      const where = `${board} / ${w.name} / ${r.columnTitle}`;
      for (const l of r.labelValues ?? []) expect(l, where).not.toMatch(/^FY\d{4}$/);
      if (r.columnTitle === 'Gift Fiscal Year') for (const l of r.labelValues ?? []) expect(['@FY', '@FY-1'], where).toContain(l);
      expect(typeof r.compareValue, where).not.toBe('number');
      if (r.operator === 'between') {
        expect(r.compareValue, where).toEqual(expect.objectContaining({ fiscalYear: expect.any(String) }));
        expect(Array.isArray(r.compareValue), where).toBe(false);
      }
    }
  });

  it('covers all 12 CRM boards', () => {
    expect(Object.keys(OVERVIEW_SPECS).sort()).toEqual([
      'activities', 'affiliations', 'annual-giving-summary', 'campaigns', 'donations', 'event-registrations',
      'events', 'organizations', 'people-historical', 'people-live', 'recurring-gifts', 'volunteers']);
  });

  it('keeps the seven strips to docs/31 §5: one row of tiles, with a chart only where it earns one', () => {
    const strips = ['people-historical', 'affiliations', 'campaigns', 'annual-giving-summary', 'event-registrations', 'volunteers', 'activities'];
    for (const k of strips) {
      const w = OVERVIEW_SPECS[k]!.widgets;
      expect(w.filter((x) => x.kind === 'NUMBER').length, k).toBeGreaterThanOrEqual(3);
      expect(w.filter((x) => x.kind === 'LISTVIEW' || x.kind === 'CALENDAR'), k).toEqual([]);
      expect(w.filter((x) => x.kind === 'CHART').length, k).toBe(['annual-giving-summary', 'activities'].includes(k) ? 1 : 0);
    }
  });

  it('gives each strip one data-quality tile (docs/31 §5)', () => {
    const tile = (k: string, name: string) => OVERVIEW_SPECS[k]!.widgets.some((w) => w.name === name);
    expect(tile('people-historical', 'Gave this year')).toBe(true);
    expect(tile('affiliations', 'Drafts to confirm')).toBe(true);
    expect(tile('event-registrations', 'Unlinked attendees')).toBe(true);
    expect(tile('volunteers', 'Unlinked')).toBe(true);
    expect(tile('activities', 'Unlinked')).toBe(true);
  });

  it('counts the same Unlinked attendees as the tab, from both registration platforms (#57)', () => {
    const rules = [
      { columnTitle: 'Attendee', operator: 'is_empty' },
      { columnTitle: 'Source', operator: 'any_of', labelValues: ['Eventbrite', 'Funraise'] },
    ];
    const tab = BOARD_SPECS['event-registrations']!.views!.find((v) => v.name === 'Unlinked attendees')!;
    const tile = OVERVIEW_SPECS['event-registrations']!.widgets.find((w) => w.name === 'Unlinked attendees')!;
    expect(tab.filter!.rules).toEqual(rules);
    expect(tile.filter!.rules).toEqual(rules);
  });

  describe('Matching gifts by company (#115)', () => {
    const widget = OVERVIEW_SPECS['donations']!.widgets.find((w) => w.name === 'Matching gifts by company')!;
    const NOW = new Date('2026-11-12T12:00:00Z'); // FY2027
    // The same title on each environment's Donations board; the id comes from the board at apply time.
    const board = (boardId: number, matchedId: string): Columns => new Map([['donations', { boardId, columns: [
      col('amt', 'Amount'),
      col('st', 'Status', 'status', '{"labels":{"0":"Pending","1":"Received"}}'),
      col('gfy', 'Gift Fiscal Year', 'status', '{"labels":{"3":"FY2026","4":"FY2027"}}'),
      col(matchedId, 'Matched By Company', 'status', '{"labels":{"0":"Netflix","1":"Apple"}}'),
    ] }]]);

    it('sums Amount in bars grouped by the Matched By Company status column', () => {
      expect(widget.kind).toBe('CHART');
      expect(widget.chart).toEqual({ board: 'donations', graphType: 'column', x: 'Matched By Company', xGroupBy: 'color', y: 'Amount' });
    });

    it('counts only Received matching gifts this fiscal year', () => {
      expect(widget.filter!.rules).toEqual(expect.arrayContaining([
        { columnTitle: 'Gift Fiscal Year', operator: 'any_of', labelValues: ['@FY'] },
        { columnTitle: 'Matched By Company', operator: 'is_not_empty' },
        { columnTitle: 'Status', operator: 'any_of', labelValues: ['Received'] },
      ]));
    });

    it.each([
      ['sandbox', 18437342657, 'color_mm91qtay'],
      ['production', 18437909794, 'color_mm90qffq'],
    ])('resolves on the %s Donations board by title', (_env, boardId, matchedId) => {
      const cols = board(boardId, matchedId);
      const settings = widgetSettings(widget, cols) as Record<string, unknown>;
      expect(settings['x_axis_columns']).toEqual({ [String(boardId)]: [matchedId] });
      expect(settings['y_axis_columns']).toEqual({ [String(boardId)]: ['amt'] });
      expect(settings['calc_function_type']).toBe('sum');
      const filter = widgetFilter(widget, cols, NOW) as { rules: { column_id: string; operator: string }[] };
      expect(filter.rules).toEqual(expect.arrayContaining([expect.objectContaining({ column_id: matchedId, operator: 'is_not_empty' })]));
    });
  });
});
