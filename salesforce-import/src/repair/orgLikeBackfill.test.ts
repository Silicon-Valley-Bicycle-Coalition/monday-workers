import { describe, it, expect } from 'vitest';
import { planBackfill, mergeLinkedIds } from './orgLikeBackfill.js';
import type { ItemPayload } from '../transform/types.js';

const org = (sfId: string): ItemPayload => ({ board: 'organizations', sfId, name: sfId, columns: {} });
const aff = (sfId: string, person: string, orgId: string, status = 'Current'): ItemPayload => ({
  board: 'affiliations', sfId, name: `${person} @ ${orgId}`, columns: { 'Affiliation Role': 'Mayor', Status: { label: status } },
  links: [{ column: 'Person', targetSfIds: [person] }, { column: 'Organization', targetSfIds: [orgId] }],
});
const base = {
  orgSfIds: new Set(['o1', 'o2']),
  existingOrgs: new Map<string, string[]>(), existingAffiliations: new Map<string, string[]>(),
  people: new Map([['p1', { id: '100', board: 'people-live' as const }], ['p2', { id: '200', board: 'people-historical' as const }]]),
};

describe('planBackfill', () => {
  it('plans only configured orgs and the affiliations pointing at them', () => {
    const plan = planBackfill({ ...base, payloads: [org('o1'), org('other'), aff('a1', 'p1', 'o1'), aff('a2', 'p1', 'other')] });
    expect(plan.orgs.map((o) => o.payload.sfId)).toEqual(['o1']);
    expect(plan.affiliations.map((a) => a.payload.sfId)).toEqual(['a1']);
    expect(plan.affiliations[0]).toMatchObject({ orgSfId: 'o1', personSfId: 'p1', current: true });
    expect(plan.affiliations[0]!.person).toEqual({ id: '100', board: 'people-live' });
  });

  it('carries existing item ids so a re-run creates nothing and flags duplicates', () => {
    const plan = planBackfill({ ...base, payloads: [org('o1'), aff('a1', 'p1', 'o1'), aff('a2', 'p2', 'o1', 'Former')],
      existingOrgs: new Map([['o1', ['900']]]), existingAffiliations: new Map([['a1', ['700', '701']]]) });
    expect(plan.orgs[0]!.existingItemId).toBe('900');
    expect(plan.affiliations[0]!.existingItemId).toBe('700');
    expect(plan.affiliations[1]!.existingItemId).toBeUndefined();
    expect(plan.affiliations[1]!.current).toBe(false);
    expect(plan.duplicates).toEqual([{ board: 'affiliations', sfId: 'a1', itemIds: ['700', '701'] }]);
  });

  it('skips an affiliation whose Person is not loaded, and a configured org with no payload', () => {
    const plan = planBackfill({ ...base, payloads: [org('o1'), aff('a1', 'p-missing', 'o1')] });
    expect(plan.affiliations).toEqual([]);
    expect(plan.skipped.map((s) => s.sfId)).toEqual(['o2', 'a1']);
    expect(plan.skipped[1]!.reason).toContain('p-missing');
  });
});

describe('mergeLinkedIds', () => {
  it('keeps existing links and appends new ones', () => {
    expect(mergeLinkedIds(['1', '2'], ['3'])).toEqual(['1', '2', '3']);
  });
  it('returns null when nothing is new', () => {
    expect(mergeLinkedIds(['1', '2'], ['2'])).toBeNull();
    expect(mergeLinkedIds([], [])).toBeNull();
  });
  it('dedupes the additions', () => {
    expect(mergeLinkedIds([], ['5', '5'])).toEqual(['5']);
  });
});
