import { describe, it, expect } from 'vitest';
import { BOARD_SPECS, PLUMBING, DASHBOARD_SPECS, withReceivedRule } from './spec.js';
import type { WidgetSpec } from './widgets.js';
import { STATUS_LABELS } from '../load/boards.js';

describe('BOARD_SPECS columns', () => {
  it('Stakeholder Type carries exactly the labels load seeds, so whichever step creates it agrees (#46)', () => {
    const col = BOARD_SPECS['people-live']!.columns!.find((c) => c.title === 'Stakeholder Type')!;
    expect(col.type).toBe('status');
    expect(col.labels).toEqual(STATUS_LABELS['Stakeholder Type']);
    expect(col.labels).toContain('Elected Official');
  });
});

describe('BOARD_SPECS views', () => {
  const all = Object.entries(BOARD_SPECS).flatMap(([board, s]) => (s.views ?? []).map((v) => ({ board, v })));

  it('every view has exactly one tag', () => {
    for (const { board, v } of all) expect(v.tag, `${board} / ${v.name}`).toMatch(/^(Worklist|Report|Reference)$/);
  });

  it('no working view shows a plumbing column', () => {
    for (const { board, v } of all) for (const col of v.columns ?? []) expect(PLUMBING, `${board} / ${v.name}`).not.toContain(col);
  });

  it('working views show 3–9 columns besides Name', () => {
    for (const { board, v } of all) if (v.columns) expect(v.columns.length, `${board} / ${v.name}`).toBeGreaterThanOrEqual(3);
    for (const { board, v } of all) if (v.columns) expect(v.columns.length, `${board} / ${v.name}`).toBeLessThanOrEqual(9);
  });

  it('view names are unique per board', () => {
    for (const s of Object.values(BOARD_SPECS)) {
      const names = (s.views ?? []).map((v) => v.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('lookup boards open on a flat Find view, sorted by Name (#51)', () => {
    const first = (k: string) => BOARD_SPECS[k]!.views![0]!;
    expect(first('people-live').name).toBe('Find a person');
    expect(first('people-historical').name).toBe('Find a person');
    expect(first('organizations').name).toBe('Find an organization');
    for (const k of ['people-live', 'people-historical', 'organizations']) {
      const v = first(k);
      expect(v.tag, k).toBe('Reference');
      expect(v.filter, k).toBeUndefined();
      expect(v.groupBy, k).toBeUndefined();
      expect(v.sort, k).toEqual([{ columnTitle: 'Name' }]);
    }
  });

  it('has the report replacements from the Salesforce usage survey', () => {
    const names = (k: string) => (BOARD_SPECS[k]!.views ?? []).map((v) => v.name);
    expect(names('people-live')).toEqual(expect.arrayContaining(
      ['Donors', 'Major donors', 'Donors to target', 'Gave last year, not this year', 'Appeal list', 'Members', 'By city']));
    expect(names('donations')).toEqual(expect.arrayContaining(
      ['Recent gifts', 'Revenue by funding stream', 'By gift size', 'By fiscal quarter', 'Major gifts to thank']));
  });

  it('"Postal appeal list" needs an address and suppresses Do Not Solicit and Do Not Mail', () => {
    const v = BOARD_SPECS['people-live']!.views!.find((x) => x.name === 'Postal appeal list')!;
    const rules = v.filter!.rules.map((r) => `${r.columnTitle} ${r.operator}`);
    expect(rules).toEqual(expect.arrayContaining(
      ['Address is_not_empty', 'Do Not Solicit is_empty', 'Do Not Mail is_empty', 'Gift Count greater_than']));
    expect(rules.some((r) => r.startsWith('Personal Email'))).toBe(false);
  });
});

describe('DASHBOARD_SPECS revenue filters', () => {
  const widgets = DASHBOARD_SPECS.flatMap((d) => d.widgets.map((w) => ({ d: d.name, w })));
  const onDonations = widgets.filter(({ w }) => w.chart?.board === 'donations' || w.number?.boards.includes('donations'));

  it('finds the donations widgets', () => { expect(onDonations.length).toBeGreaterThanOrEqual(6); });

  it('every donations widget counts only Received gifts', () => {
    for (const { d, w } of onDonations) {
      expect(w.filter?.board, `${d} / ${w.name}`).toBe('donations');
      expect(w.filter?.rules, `${d} / ${w.name}`).toContainEqual(
        { columnTitle: 'Status', operator: 'any_of', labelValues: ['Received'] });
    }
  });

  it('keeps existing filters (Major gifts not yet thanked)', () => {
    const w = widgets.find(({ w }) => w.name === 'Major gifts not yet thanked')!.w;
    expect(w.filter?.rules.map((r) => r.columnTitle)).toEqual(expect.arrayContaining(['Acknowledgment Tier', 'Thank You Sent', 'Status']));
  });
});

describe('final-review spec rulings', () => {
  const view = (b: string, n: string) => BOARD_SPECS[b]!.views!.find((v) => v.name === n)!;

  it('"Gave last year, not this year" keys on This Year Count < 1 (rollups write 0.00, never blank)', () => {
    const rules = view('people-live', 'Gave last year, not this year').filter!.rules;
    expect(rules).toContainEqual({ columnTitle: 'This Year Count', operator: 'lower_than', compareValue: 1 });
    expect(rules.map((r) => r.columnTitle)).not.toContain('This Year Amount');
  });

  it('"Recent gifts" has no colouring (red means needs action)', () => {
    expect(view('donations', 'Recent gifts').coloring).toBeUndefined();
  });

  it('describes the computed columns as rollup-owned', () => {
    for (const b of ['people-live', 'organizations']) expect(BOARD_SPECS[b]!.columnDescriptions!['Donor Level']).toMatch(/Leadership.*Overwritten|Edits are overwritten/s);
    for (const c of ['Funding Stream', 'Gift Size', 'Fiscal Quarter', 'Gift Fiscal Year'])
      expect(BOARD_SPECS['donations']!.columnDescriptions![c]).toMatch(/donation-rollups integration from Gift Type, Amount, and Date\. Edits are overwritten\.$/);
  });
});

describe('withReceivedRule', () => {
  const received = (w: WidgetSpec) => (w.filter?.rules ?? []).filter((r) => r.columnTitle === 'Status' && r.labelValues?.includes('Received')).length;
  const num = (over: Partial<WidgetSpec> = {}): WidgetSpec => ({ name: 'w', kind: 'NUMBER', number: { boards: ['donations'], count: true }, ...over });

  it('adds Received to NUMBER, CHART and LISTVIEW widgets on Donations', () => {
    const out = withReceivedRule([
      num(),
      { name: 'c', kind: 'CHART', chart: { board: 'donations', graphType: 'donut', x: 'Gift Size', xGroupBy: 'color', y: 'count' } },
      { name: 'l', kind: 'LISTVIEW', list: { board: 'donations', columns: ['Donor'] } },
    ]);
    for (const w of out) expect(received(w), w.name).toBe(1);
  });

  it('keeps a widget’s own rules and appends Received', () => {
    const own = { columnTitle: 'Thank You Sent', operator: 'is_empty' };
    const [w] = withReceivedRule([num({ filter: { board: 'donations', rules: [own] } })]);
    expect(w!.filter!.rules[0]).toEqual(own);
    expect(received(w!)).toBe(1);
  });

  it('skips a widget marked allStatuses, and widgets on other boards (Review Focus 7)', () => {
    const [spans, elsewhere] = withReceivedRule([
      num({ allStatuses: true }),
      { name: 'e', kind: 'NUMBER', number: { boards: ['events'], count: true } },
    ]);
    expect(received(spans!)).toBe(0);
    expect(received(elsewhere!)).toBe(0);
  });
});
