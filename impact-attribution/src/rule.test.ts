import { describe, expect, it } from 'vitest';
import { pairKey, qualifyingPairs, selectCandidates, type Candidate, type MatchRow } from './rule';

const RULE = { windowDays: 365, minMatches: 2, currentWithinDays: 365 };
const TODAY = '2026-11-16';

let next = 0;
const match = (matchDate: string, personItemId = 'p1', orgItemId = 'o1', amountCents: number | null = 1000): MatchRow =>
  ({ donationItemId: String(++next), personItemId, orgItemId, matchDate, amountCents });

describe('qualifyingPairs', () => {
  it('two matches 365 days apart qualify; 366 do not', () => {
    // 2024 is a leap year: 2024-01-01 to 2024-12-31 is 365 days.
    expect(qualifyingPairs([match('2024-01-01'), match('2024-12-31')], RULE, TODAY)).toHaveLength(1);
    expect(qualifyingPairs([match('2023-01-01'), match('2024-01-02')], RULE, TODAY)).toHaveLength(0);
  });

  it('two matches on the same date qualify', () => {
    expect(qualifyingPairs([match('2020-05-01'), match('2020-05-01')], RULE, TODAY)).toHaveLength(1);
  });

  it('one match never qualifies', () => {
    expect(qualifyingPairs([match('2026-10-01')], RULE, TODAY)).toEqual([]);
  });

  it('qualifies on any adjacent pair, not just the latest', () => {
    const [c] = qualifyingPairs([match('2019-01-01'), match('2015-03-01'), match('2015-09-01')], RULE, TODAY);
    expect(c?.latestMatch).toBe('2019-01-01');
    expect(c?.matches.map((m) => m.matchDate)).toEqual(['2019-01-01', '2015-09-01', '2015-03-01']);
  });

  it('Current when the latest match is within 365 days of today, else Former', () => {
    expect(qualifyingPairs([match('2025-11-16'), match('2025-11-01')], RULE, TODAY)[0]?.proposedStatus).toBe('Current');
    expect(qualifyingPairs([match('2025-11-15'), match('2025-11-01')], RULE, TODAY)[0]?.proposedStatus).toBe('Former');
  });

  it('measures Current from the latest match overall, even when the qualifying pair is older', () => {
    const [c] = qualifyingPairs([match('2016-01-01'), match('2016-02-01'), match('2026-06-01')], RULE, TODAY);
    expect(c?.proposedStatus).toBe('Current');
  });

  it('keeps pairs apart by person and by organization', () => {
    const rows = [match('2026-01-01', 'p1', 'o1'), match('2026-02-01', 'p1', 'o2'), match('2026-03-01', 'p2', 'o1')];
    expect(qualifyingPairs(rows, RULE, TODAY)).toEqual([]);
  });
});

const cand = (personItemId: string, orgItemId: string, proposedStatus: 'Current' | 'Former', latestMatch: string): Candidate =>
  ({ personItemId, orgItemId, proposedStatus, latestMatch, matches: [] });

describe('selectCandidates', () => {
  const none = { excludedOrgIds: new Set<string>(), existingPairs: new Set<string>(), proposedPairs: new Set<string>() };

  it('orders Current first, then latest match newest first, and caps at max', () => {
    const all = [cand('a', 'o', 'Former', '2024-01-01'), cand('b', 'o', 'Current', '2026-01-01'), cand('c', 'o', 'Current', '2026-05-01'), cand('d', 'o', 'Former', '2025-01-01')];
    const { chosen, deferred } = selectCandidates(all, none, 3);
    expect(chosen.map((c) => c.personItemId)).toEqual(['c', 'b', 'd']);
    expect(deferred).toBe(1);
  });

  it('drops excluded payers, existing affiliations and earlier proposals, and counts each', () => {
    const all = [cand('a', 'foundation', 'Current', '2026-01-01'), cand('b', 'o', 'Current', '2026-01-01'), cand('c', 'o', 'Current', '2026-01-01'), cand('d', 'o', 'Current', '2026-01-01')];
    const { chosen, skipped, deferred } = selectCandidates(all, {
      excludedOrgIds: new Set(['foundation']), existingPairs: new Set([pairKey('b', 'o')]), proposedPairs: new Set([pairKey('c', 'o')]),
    }, 25);
    expect(chosen.map((c) => c.personItemId)).toEqual(['d']);
    expect(skipped).toEqual({ excluded: 1, existing: 1, proposed: 1 });
    expect(deferred).toBe(0);
  });
});
