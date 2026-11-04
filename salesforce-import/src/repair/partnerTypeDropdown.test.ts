import { describe, it, expect } from 'vitest';
import { findPartnerTypeColumns, planRelabel, type RelabelRow } from './partnerTypeDropdown.js';

const row = (id: string, source: string, current = ''): RelabelRow => ({ id, name: `Org ${id}`, source, current });

describe('planRelabel', () => {
  it('writes the mapped label where the dropdown is empty', () => {
    const plan = planRelabel([row('1', 'Public Sector'), row('2', 'Corporation;Bike Shop')]);
    expect(plan.write).toEqual([
      { id: '1', name: 'Org 1', source: 'Public Sector', current: '', label: 'Municipal' },
      { id: '2', name: 'Org 2', source: 'Corporation;Bike Shop', current: '', label: 'Bike Shop' },
    ]);
  });

  it('leaves a set dropdown alone, so a re-run after the swap never undoes a staff edit', () => {
    const plan = planRelabel([row('1', 'Public Sector', 'Nonprofit')]);
    expect(plan.write).toEqual([]);
    expect(plan.alreadySet).toBe(1);
  });

  it('counts a blank source apart: it stays blank for the Untyped worklist', () => {
    const plan = planRelabel([row('1', '')]);
    expect(plan.write).toEqual([]);
    expect(plan.blank).toBe(1);
  });

  it('reports an unknown value and writes nothing for it', () => {
    const plan = planRelabel([row('1', 'Sponsor')]);
    expect(plan.write).toEqual([]);
    expect(plan.unmapped.map((r) => r.id)).toEqual(['1']);
  });

  it('tallies each source value with its label, largest first', () => {
    const plan = planRelabel([row('1', 'Media'), row('2', 'Press'), row('3', 'Press')]);
    expect(plan.bySource).toEqual([
      { source: 'Press', label: 'Press', count: 2 },
      { source: 'Media', label: 'Press', count: 1 },
    ]);
  });
});

describe('findPartnerTypeColumns', () => {
  const text = { id: 't', title: 'Partner Type', type: 'text' };
  const dropdown = { id: 'd', title: 'Partner Type (dropdown)', type: 'dropdown' };

  it('finds the text column before the dropdown exists', () => {
    expect(findPartnerTypeColumns([text])).toEqual({ source: text, target: undefined });
  });

  it('finds both mid-run', () => {
    expect(findPartnerTypeColumns([text, dropdown])).toEqual({ source: text, target: dropdown });
  });

  it('finds both after the swap, by type rather than title alone', () => {
    const retired = { id: 't', title: 'Partner Type (old text)', type: 'text' };
    const live = { id: 'd', title: 'Partner Type', type: 'dropdown' };
    expect(findPartnerTypeColumns([retired, live])).toEqual({ source: retired, target: live });
  });

  it('ignores an unrelated column whose title only starts the same', () => {
    expect(findPartnerTypeColumns([text, { id: 'x', title: 'Partner Type Notes', type: 'text' }]).source).toBe(text);
  });

  it('matches through a read-only marker', () => {
    const marked = { id: 't', title: '📜 Partner Type', type: 'text' };
    expect(findPartnerTypeColumns([marked]).source).toBe(marked);
  });
});
