import { describe, it, expect } from 'vitest';
import { deriveMembers, termColumnsByOpportunity, type MembershipRow } from './membership.js';

const t = (over: Partial<MembershipRow>): MembershipRow => ({
  Id: 'm1', Contact__c: 'c1', Opportunity__c: 'o1', Type__c: 'New',
  Start_Date__c: '2024-01-01', WEC_End_Date_Manual__c: '2025-01-01', ...over,
});

describe('deriveMembers', () => {
  const CUTOVER = '2026-10-01';

  it('marks active when the latest term ends on/after cutover', () => {
    const m = deriveMembers([t({ WEC_End_Date_Manual__c: '2026-12-31' })], CUTOVER).get('c1')!;
    expect(m).toEqual({ status: 'Active', tier: 'Member', sinceISO: '2024-01-01', untilISO: '2026-12-31' });
  });

  it('marks lapsed when all terms ended before cutover', () => {
    expect(deriveMembers([t({})], CUTOVER).get('c1')!.status).toBe('Lapsed');
  });

  it('Lifetime overrides dates — active with null until, even with a PAST end date', () => {
    const m = deriveMembers([t({ Type__c: 'Lifetime', WEC_End_Date_Manual__c: '2015-01-01' })], CUTOVER).get('c1')!;
    expect(m).toEqual({ status: 'Active', tier: 'Lifetime', sinceISO: '2024-01-01', untilISO: null });
  });

  it('since is the min start across terms; until the latest end', () => {
    const m = deriveMembers([
      t({ Id: 'm1', Start_Date__c: '2019-03-01', WEC_End_Date_Manual__c: '2020-03-01' }),
      t({ Id: 'm2', Start_Date__c: '2024-01-01', WEC_End_Date_Manual__c: '2026-12-01' }),
    ], CUTOVER).get('c1')!;
    expect(m.sinceISO).toBe('2019-03-01');
    expect(m.untilISO).toBe('2026-12-01');
  });
});

describe('termColumnsByOpportunity', () => {
  it('emits term columns keyed by opportunity', () => {
    const { columns, ambiguous } = termColumnsByOpportunity([t({})]);
    expect(ambiguous).toEqual([]);
    expect(columns.get('o1')).toEqual({
      'Term Start': { date: '2024-01-01' }, 'Term End': { date: '2025-01-01' }, 'Membership Type': 'New',
    });
  });
  it('writes term columns for agreeing multi-term links (joint memberships)', () => {
    const { columns, ambiguous } = termColumnsByOpportunity([
      t({ Id: 'm1', Contact__c: 'c1' }), t({ Id: 'm2', Contact__c: 'c2' })]);
    expect(ambiguous).toEqual([]);
    expect(columns.get('o1')).toEqual({
      'Term Start': { date: '2024-01-01' }, 'Term End': { date: '2025-01-01' }, 'Membership Type': 'New',
    });
  });
  it('skips and reports disagreeing multi-term links instead of picking sides', () => {
    const { columns, ambiguous } = termColumnsByOpportunity([
      t({ Id: 'm1' }), t({ Id: 'm2', Start_Date__c: '2020-01-01', Type__c: 'Historical' })]);
    expect(columns.has('o1')).toBe(false);
    expect(ambiguous).toEqual(['Opportunity o1 has 2 disagreeing membership terms']);
  });
});
