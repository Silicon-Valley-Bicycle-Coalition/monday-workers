import { describe, it, expect } from 'vitest';
import { opportunityToPayload, cnpToPayload, cnpOverlapCheck } from './donations.js';
import type { Era } from './eras.js';

const eras: Era[] = [
  { key: 'donations:live', label: 'Donations', startYear: 2024, endYear: null },
  { key: 'donations:pre-2024', label: 'Donations pre-2024', startYear: null, endYear: 2023 },
];

describe('opportunityToPayload', () => {
  const base = { Id: 'o1', Name: 'Gift', Amount: 50, CloseDate: '2026-01-15', StageName: 'Posted',
    RecordType: { Name: 'Donation' }, npsp__Primary_Contact__c: 'c1',
    CreatedDate: '2026-01-15T00:00:00Z', CreatedBy: { Name: 'X' },
    LastModifiedDate: '2026-01-15T00:00:00Z', LastModifiedBy: { Name: 'X' } };

  it('maps status Posted→Received and assigns the era board', () => {
    const p = opportunityToPayload(base, { eras, termCols: new Map() });
    expect(p.board).toBe('donations:live');
    expect(p.columns['Status']).toEqual({ label: 'Received' });
    expect(p.columns['Gift Type']).toBe('Donation');
    expect(p.links).toContainEqual({ column: 'Donor', targetSfIds: ['c1'] });
  });

  it('computes Fiscal Year from CloseDate independent of the era split', () => {
    const p = opportunityToPayload({ ...base, CloseDate: '2025-12-31' }, { eras, termCols: new Map() });
    expect(p.columns['Fiscal Year']).toBe('2026');
  });

  it('sets Salesforce Owner from Opportunity.Owner, bare when unmatched', () => {
    const p = opportunityToPayload({ ...base, Owner: { Name: 'Gavin Powell' } }, { eras, termCols: new Map() });
    expect(p.columns['Salesforce Owner']).toBe('Gavin Powell');
  });

  it('routes old gifts to the historical era and maps Closed Lost→Failed', () => {
    const p = opportunityToPayload({ ...base, CloseDate: '2015-03-01', StageName: 'Closed Lost' },
      { eras, termCols: new Map() });
    expect(p.board).toBe('donations:pre-2024');
    expect(p.columns['Status']).toEqual({ label: 'Failed' });
    expect(p.columns['Fiscal Year']).toBe('2015');
  });

  it('merges membership term columns and marks donor-less gifts anonymous', () => {
    const termCols = new Map([['o1', { 'Term Start': { date: '2026-01-01' } }]]);
    const p = opportunityToPayload({ ...base, npsp__Primary_Contact__c: null, funraise__fr_Donor__c: null,
      AccountId: null }, { eras, termCols });
    expect(p.columns['Term Start']).toEqual({ date: '2026-01-01' });
    expect(p.columns['Anonymous Donor']).toEqual({ checked: 'true' });
    expect(p.links).toEqual([]);
  });
});

describe('click & pledge', () => {
  it('drops transactions whose ID matches an Opportunity CnP_PaaS__CnP_OrderNumber__c', () => {
    const { duplicateTransactionIds, unique } = cnpOverlapCheck(
      [{ Id: 't1', CnP_PaaS__TotalCharged__c: 25 }, { Id: 't2', CnP_PaaS__TotalCharged__c: 35 }],
      [{ Id: 'o1', CnP_PaaS__CnP_OrderNumber__c: 't1' }]);
    expect(duplicateTransactionIds).toEqual(['t1']);
    expect(unique.map((t) => t['Id'])).toEqual(['t2']);
  });

  it('builds historical payloads with CnP_PaaS__TotalCharged__c amount', () => {
    const p = cnpToPayload({ Id: 't2', Name: 'CP Gift', CnP_PaaS__TotalCharged__c: 25,
      CnP_PaaS__TransactionDate__c: '2016-05-01T00:00:00Z', CnP_PaaS__Contact__c: 'c9',
      CreatedDate: '2016-05-01T00:00:00Z', CreatedBy: { Name: 'X' },
      LastModifiedDate: '2016-05-01T00:00:00Z', LastModifiedBy: { Name: 'X' } }, { eras });
    expect(p.board).toBe('donations:pre-2024');
    expect(p.columns['Gift Type']).toBe('Click & Pledge (historical)');
    expect(p.columns['Status']).toEqual({ label: 'Received' });
    expect(p.columns['Fiscal Year']).toBe('2016');
    expect(p.links).toContainEqual({ column: 'Donor', targetSfIds: ['c9'] });
  });
});
