import { describe, it, expect } from 'vitest';
import { donorRollups, applyRollups } from './rollups.js';

describe('donorRollups', () => {
  it('sums received gifts per donor across opportunities and C&P, cents-safe', () => {
    const r = donorRollups(
      [{ Id: 'o1', npsp__Primary_Contact__c: 'c1', Amount: 10.1, CloseDate: '2020-01-01', StageName: 'Posted' },
       { Id: 'o2', npsp__Primary_Contact__c: 'c1', Amount: 20.2, CloseDate: '2024-01-01', StageName: 'Posted' },
       { Id: 'o3', npsp__Primary_Contact__c: 'c1', Amount: 999, CloseDate: '2024-02-01', StageName: 'Closed Lost' }],
      [{ Id: 't1', CnP_PaaS__Contact__c: 'c1', CnP_PaaS__TotalCharged__c: 5,
         CnP_PaaS__TransactionDate__c: '2015-01-01T00:00:00Z' }]);
    expect(r.get('c1')).toEqual({ lifetimeGiving: 35.3, firstGiftISO: '2015-01-01', giftCount: 3 });
  });

  it('excludes Closed Won — not IsWon in Salesforce, unlike Posted (monday-migration docs/07 gotcha #10)', () => {
    const r = donorRollups(
      [{ Id: 'o1', npsp__Primary_Contact__c: 'c1', Amount: 10, CloseDate: '2020-01-01', StageName: 'Posted' },
       { Id: 'o2', npsp__Primary_Contact__c: 'c1', Amount: 500, CloseDate: '2020-01-01', StageName: 'Closed Won' }],
      []);
    expect(r.get('c1')).toEqual({ lifetimeGiving: 10, firstGiftISO: '2020-01-01', giftCount: 1 });
  });
});

describe('applyRollups', () => {
  it('adds the three columns', () => {
    const p = applyRollups({ board: 'people-live', sfId: 'c1', name: 'A', columns: {} },
      { lifetimeGiving: 35.3, firstGiftISO: '2015-01-01', giftCount: 3 });
    expect(p.columns['Lifetime Giving']).toBe('35.3');
    expect(p.columns['First Gift']).toEqual({ date: '2015-01-01' });
    expect(p.columns['Gift Count']).toBe('3');
  });
});

describe('donorRollups with account aliases', () => {
  it('credits gifts booked against a person-named Account to that person', () => {
    const r = donorRollups(
      [{ Id: 'o1', npsp__Primary_Contact__c: null, AccountId: 'a-pn', Amount: 10, CloseDate: '2013-05-01', StageName: 'Posted' },
       { Id: 'o2', npsp__Primary_Contact__c: 'c1', Amount: 5, CloseDate: '2020-01-01', StageName: 'Posted' }],
      [{ Id: 't1', CnP_PaaS__Contact__c: null, CnP_PaaS__Account__c: 'a-pn', CnP_PaaS__TotalCharged__c: 7,
         CnP_PaaS__TransactionDate__c: '2016-01-01T00:00:00Z' }],
      new Map([['a-pn', 'c1']]));
    expect(r.get('c1')).toEqual({ lifetimeGiving: 22, firstGiftISO: '2013-05-01', giftCount: 3 });
    expect(r.has('a-pn')).toBe(false);
  });
});
