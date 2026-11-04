import { describe, it, expect } from 'vitest';
import { expectedGifts, fyOf, fyOrder, toCents, topDonors, totalsByFY, UNDATED } from './expected.js';
import type { ItemPayload } from '../transform/types.js';

describe('fyOf', () => {
  it('buckets by SVBC\'s July–June fiscal year', () => {
    expect(fyOf('2025-06-30')).toBe('2025');
    expect(fyOf('2025-07-01')).toBe('2026');
    expect(fyOf('2025-07-01T03:00:00.000+0000')).toBe('2026');
  });
  it('puts blank and malformed dates in the undated bucket', () => {
    expect(fyOf(null)).toBe(UNDATED);
    expect(fyOf('')).toBe(UNDATED);
    expect(fyOf('not a date')).toBe(UNDATED);
  });
});

describe('toCents', () => {
  it('rounds to whole cents and treats blank as zero', () => {
    expect(toCents('10.10')).toBe(1010);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(null)).toBe(0);
    expect(toCents('')).toBe(0);
    expect(toCents('abc')).toBe(0);
  });
});

describe('expectedGifts', () => {
  const opps = [
    { Id: 'o1', Amount: 25, CloseDate: '2024-07-01', StageName: 'Posted', CnP_PaaS__CnP_OrderNumber__c: 'tx1' },
    { Id: 'o2', Amount: null, CloseDate: '2024-06-30', StageName: 'Closed Lost' },
  ];
  const cnp = [
    { Id: 'tx1', CnP_PaaS__TotalCharged__c: 25, CnP_PaaS__TransactionDate__c: '2024-07-01T18:00:00.000+0000' },
    { Id: 'tx2', CnP_PaaS__TotalCharged__c: 52.25, CnP_PaaS__TransactionDate__c: '2021-03-04T18:11:10.000+0000' },
  ];

  it('files a C&P transaction in the fiscal year of its Pacific day, as transform does', () => {
    const r = expectedGifts([], [{ Id: 'tx3', CnP_PaaS__TotalCharged__c: 10,
      CnP_PaaS__TransactionDate__c: '2021-07-01T05:00:00.000+0000' }]);
    expect(r.gifts).toEqual([{ sfId: 'tx3', fy: '2021', cents: 1000 }]);
  });

  it('counts every Opportunity regardless of stage, plus only the C&P not already an Opportunity', () => {
    const r = expectedGifts(opps, cnp);
    expect(r.cnpUnique).toBe(1);
    expect(r.cnpOverlap).toBe(1);
    expect(r.gifts).toEqual([
      { sfId: 'o1', fy: '2025', cents: 2500 },
      { sfId: 'o2', fy: '2024', cents: 0 },
      { sfId: 'tx2', fy: '2021', cents: 5225 },
    ]);
  });

  it('totals by fiscal year', () => {
    const t = totalsByFY([...expectedGifts(opps, cnp).gifts, { fy: '2025', cents: 100 }]);
    expect(t.get('2025')).toEqual({ count: 2, cents: 2600 });
    expect(t.get('2021')).toEqual({ count: 1, cents: 5225 });
  });

  it('expects a fee-coverage split folded into its gift: one fewer gift, same cents', () => {
    const split = { Id: 'o3', Amount: 1.6, CloseDate: '2024-07-01', StageName: 'Posted',
      npsp__Primary_Contact__c: 'c1', CreatedDate: 't', Funraise_Fee_Match_Opportunity__c: true };
    const gift = { ...split, Id: 'o4', Amount: 20, Funraise_Fee_Match_Opportunity__c: false,
      Funraise_Fee_Match_Amount__c: 1.6 };
    expect(expectedGifts([gift, split], []).gifts).toEqual([{ sfId: 'o4', fy: '2025', cents: 2160 }]);
  });
});

describe('fyOrder', () => {
  it('sorts undated first, then years ascending', () => {
    expect(['2026', UNDATED, '2019', '2024'].sort(fyOrder)).toEqual([UNDATED, '2019', '2024', '2026']);
  });
});

describe('topDonors', () => {
  const p = (board: string, sfId: string, lifetime?: string, count?: string): ItemPayload =>
    ({ board, sfId, name: sfId, columns: lifetime === undefined ? {} : { 'Lifetime Giving': lifetime, 'Gift Count': count } });

  it('ranks owners by Lifetime Giving, skipping donations, non-donors and zero totals', () => {
    const top = topDonors([
      p('people-live', 'c1', '100', '2'), p('organizations', 'a1', '5000.5', '7'),
      p('people-historical', 'c2', '0', '0'), p('people-live', 'c3'),
      { board: 'donations', sfId: 'o1', name: 'x', columns: { 'Lifetime Giving': '999999' } },
      p('people-historical', 'c4', '250', '1'),
    ], 2);
    expect(top.map((d) => [d.sfId, d.lifetimeCents, d.giftCount])).toEqual([['a1', 500050, 7], ['c4', 25000, 1]]);
  });
});
