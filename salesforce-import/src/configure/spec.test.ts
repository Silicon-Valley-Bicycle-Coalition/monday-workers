import { describe, it, expect } from 'vitest';
import { BOARD_SPECS, PLUMBING, DASHBOARD_SPECS } from './spec.js';
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

  it('has the report replacements from the Salesforce usage survey', () => {
    const names = (k: string) => (BOARD_SPECS[k]!.views ?? []).map((v) => v.name);
    expect(names('people-live')).toEqual(expect.arrayContaining(
      ['Donors', 'Major donors', 'Donors to target', 'Gave last year, not this year', 'Appeal list', 'Members', 'By city']));
    expect(names('donations')).toEqual(expect.arrayContaining(
      ['Recent gifts', 'Revenue by funding stream', 'By gift size', 'By fiscal quarter', 'Major gifts to thank']));
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
