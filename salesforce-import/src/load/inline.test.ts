import { describe, it, expect } from 'vitest';
import { planInlineLinks, type InlineContext } from './inline.js';
import type { ItemPayload } from '../transform/types.js';

const ctx = (over: Partial<InlineContext> = {}): InlineContext => ({
  itemIdOf: (sfId) => ({ c1: '11', c2: '12', camp: '20', arch: '30' } as Record<string, string>)[sfId],
  isExpected: (sfId) => ['c1', 'c2', 'camp', 'arch', 'c-later'].includes(sfId),
  isArchived: (sfId) => sfId === 'arch',
  columnId: (title) => ({ Donor: 'rel_donor', Campaign: 'rel_camp', 'Soft Credit': 'rel_soft' } as Record<string, string>)[title],
  ...over,
});
const gift = (links: ItemPayload['links']): ItemPayload => ({ board: 'donations', sfId: 'o1', name: 'Gift', columns: {}, links });

describe('planInlineLinks', () => {
  it('inlines every link whose targets are all already on Monday', () => {
    expect(planInlineLinks(gift([
      { column: 'Donor', targetSfIds: ['c1'] },
      { column: 'Campaign', targetSfIds: ['camp'] },
    ]), ctx())).toEqual([
      { column: 'Donor', colId: 'rel_donor', targetSfIds: ['c1'], targetItemIds: [11] },
      { column: 'Campaign', colId: 'rel_camp', targetSfIds: ['camp'], targetItemIds: [20] },
    ]);
  });

  it('leaves a link with a target this run still has to create to the link pass (#21 pending rule)', () => {
    expect(planInlineLinks(gift([{ column: 'Soft Credit', targetSfIds: ['c1', 'c-later'] }]), ctx())).toEqual([]);
  });

  it('inlines the resolvable subset when the rest were never migrated — what the link pass would write', () => {
    expect(planInlineLinks(gift([{ column: 'Soft Credit', targetSfIds: ['c1', 'c-never', 'c2'] }]), ctx()))
      .toEqual([{ column: 'Soft Credit', colId: 'rel_soft', targetSfIds: ['c1', 'c2'], targetItemIds: [11, 12] }]);
  });

  it('skips a link with no resolvable target at all (nothing to write)', () => {
    expect(planInlineLinks(gift([{ column: 'Donor', targetSfIds: ['c-never'] }]), ctx())).toEqual([]);
  });

  it('never inlines a relation to an archived target — the link pass owns that case', () => {
    expect(planInlineLinks(gift([{ column: 'Donor', targetSfIds: ['arch'] }]), ctx())).toEqual([]);
  });

  it('leaves a link whose connect column is unknown to the link pass, which reports it', () => {
    expect(planInlineLinks(gift([{ column: 'Matched By', targetSfIds: ['c1'] }]), ctx())).toEqual([]);
  });

  it('handles payloads without links', () => {
    expect(planInlineLinks(gift(undefined), ctx())).toEqual([]);
  });
});
