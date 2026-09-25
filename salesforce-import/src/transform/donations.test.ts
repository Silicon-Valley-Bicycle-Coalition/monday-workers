import { describe, it, expect } from 'vitest';
import { opportunityToPayload, cnpToPayload, cnpOverlapCheck, softCreditsByGift, unknownStages } from './donations.js';

describe('opportunityToPayload', () => {
  const base = { Id: 'o1', Name: 'Gift', Amount: 50, CloseDate: '2026-01-15', StageName: 'Posted',
    RecordType: { Name: 'Donation' }, npsp__Primary_Contact__c: 'c1',
    CreatedDate: '2026-01-15T00:00:00Z', CreatedBy: { Name: 'X' },
    LastModifiedDate: '2026-01-15T00:00:00Z', LastModifiedBy: { Name: 'X' } };

  it('maps status Posted→Received onto the single donations board', () => {
    const p = opportunityToPayload(base, { termCols: new Map() });
    expect(p.board).toBe('donations');
    expect(p.columns['Status']).toEqual({ label: 'Received' });
    expect(p.columns['Gift Type']).toBe('Donation');
    expect(p.links).toContainEqual({ column: 'Donor', targetSfIds: ['c1'] });
  });

  it('computes Fiscal Year Ending (July–June) from CloseDate', () => {
    const p = opportunityToPayload({ ...base, CloseDate: '2025-12-31' }, { termCols: new Map() });
    expect(p.columns['Fiscal Year Ending']).toBe('2026');
  });

  it('sets Salesforce Owner from Opportunity.Owner, bare when unmatched', () => {
    const p = opportunityToPayload({ ...base, Owner: { Name: 'Gavin Powell' } }, { termCols: new Map() });
    expect(p.columns['Salesforce Owner']).toBe('Gavin Powell');
  });

  it('maps Closed Won to a distinct label, not plain Received', () => {
    const p = opportunityToPayload({ ...base, StageName: 'Closed Won' }, { termCols: new Map() });
    expect(p.columns['Status']).toEqual({ label: 'Received (Historical)' });
  });

  it('maps Withdrawn→Failed and the not-yet stages to Pending', () => {
    const status = (StageName: string | null) =>
      opportunityToPayload({ ...base, StageName }, { termCols: new Map() }).columns['Status'];
    expect(status('Withdrawn')).toEqual({ label: 'Failed' });
    for (const s of ['Prospecting', 'Pledged', 'Invoiced', 'Not Posted', 'Engaged with Organization']) {
      expect(status(s), s).toEqual({ label: 'Pending' });
    }
    expect(status('constructor')).toEqual({ label: 'Pending' });
  });

  it('links soft credits to their own column, leaving Donor alone', () => {
    const p = opportunityToPayload(base, { termCols: new Map(), softCredits: ['c7', 'c8'] });
    expect(p.links).toContainEqual({ column: 'Donor', targetSfIds: ['c1'] });
    expect(p.links).toContainEqual({ column: 'Soft Credit', targetSfIds: ['c7', 'c8'] });
    expect(opportunityToPayload(base, { termCols: new Map() }).links!.some((l) => l.column === 'Soft Credit')).toBe(false);
  });

  it('keeps old gifts on the same board and maps Closed Lost→Failed', () => {
    const p = opportunityToPayload({ ...base, CloseDate: '2015-03-01', StageName: 'Closed Lost' },
      { termCols: new Map() });
    expect(p.board).toBe('donations');
    expect(p.columns['Status']).toEqual({ label: 'Failed' });
    expect(p.columns['Fiscal Year Ending']).toBe('2015');
  });

  it('merges membership term columns and marks donor-less gifts anonymous', () => {
    const termCols = new Map([['o1', { 'Term Start': { date: '2026-01-01' } }]]);
    const p = opportunityToPayload({ ...base, npsp__Primary_Contact__c: null, funraise__fr_Donor__c: null,
      AccountId: null }, { termCols });
    expect(p.columns['Term Start']).toEqual({ date: '2026-01-01' });
    expect(p.columns['Anonymous Donor']).toEqual({ checked: 'true' });
    expect(p.links).toEqual([]);
  });

  it('points Donor at the organization when the gift is attributed to an affiliation there', () => {
    const base = { Id: 'o9', Name: 'Sponsorship', Amount: 5000, CloseDate: '2024-01-01', StageName: 'Posted',
      RecordType: { Name: 'Sponsorship' }, AccountId: 'org-acme', npsp__Primary_Contact__c: 'c1' };
    const orgs = new Set(['org-acme']);
    const with_ = opportunityToPayload(base, { termCols: new Map(), orgAccountIds: orgs, actingFor: 'af-new' });
    expect(with_.columns['Attribution']).toEqual({ label: 'Auto' });
    expect(with_.links).toContainEqual({ column: 'Acting for', targetSfIds: ['af-new'] });
    expect(with_.links).toContainEqual({ column: 'Donor', targetSfIds: ['org-acme'] });   // the org gave it
    expect(with_.links!.some((l) => l.column === 'Donor' && l.targetSfIds.includes('c1'))).toBe(false);
    expect(with_.columns['Anonymous Donor']).toBeNull();
  });

  it('keeps Donor on the person when an org gift is not attributed (nothing is lost before review)', () => {
    const base = { Id: 'o9', Name: 'Sponsorship', Amount: 5000, CloseDate: '2024-01-01', StageName: 'Posted',
      RecordType: { Name: 'Sponsorship' }, AccountId: 'org-acme', npsp__Primary_Contact__c: 'c1' };
    const without = opportunityToPayload(base, { termCols: new Map(), orgAccountIds: new Set(['org-acme']) });
    expect(without.columns['Attribution']).toEqual({ label: 'None' });
    expect(without.links).toContainEqual({ column: 'Donor', targetSfIds: ['c1'] });
    expect(without.links!.some((l) => l.column === 'Acting for')).toBe(false);
  });

  it('never re-points a matching gift: Donor stays the employee even if actingFor is supplied', () => {
    const match = { Id: 'o9', Name: 'Google, LLC - Employer Matching Ada L', Amount: 100, CloseDate: '2026-07-04',
      StageName: 'Posted', RecordType: { Name: 'Matching Donation' }, AccountId: 'a-google', npsp__Primary_Contact__c: 'c1' };
    const p = opportunityToPayload(match, { termCols: new Map(), orgAccountIds: new Set(['a-google']), actingFor: 'af-x' });
    expect(p.links).toContainEqual({ column: 'Donor', targetSfIds: ['c1'] });
    expect(p.links).toContainEqual({ column: 'Matched By', targetSfIds: ['a-google'] });
  });

  it('re-points an Account-only Donor link at the person the Account was folded into', () => {
    const p = opportunityToPayload({ ...base, npsp__Primary_Contact__c: null, funraise__fr_Donor__c: null,
      AccountId: 'a-pn' }, { termCols: new Map(), donorAlias: new Map([['a-pn', 'c7']]) });
    expect(p.links).toContainEqual({ column: 'Donor', targetSfIds: ['c7'] });
    expect(p.columns['Anonymous Donor']).toBeNull();
  });
});

describe('opportunityToPayload — Benevity matching gifts (plan: Benevity in Integrations)', () => {
  const base = { Id: 'o9', Name: 'Google, LLC - Employer Matching Ada L 7/4/2026', Amount: 100,
    CloseDate: '2026-07-04', StageName: 'Posted', RecordType: { Name: 'Matching Donation' },
    npsp__Primary_Contact__c: 'c1', AccountId: 'a-google',
    CreatedDate: '2026-07-04T00:00:00Z', CreatedBy: { Name: 'X' },
    LastModifiedDate: '2026-07-04T00:00:00Z', LastModifiedBy: { Name: 'X' } };
  const deps = { termCols: new Map(), orgAccountIds: new Set(['a-google']),
    placeholderDonorSfIds: new Set(['c-anon', 'a-anon']) };

  it('links the paying company as Matched By and keeps the employee as Donor', () => {
    const p = opportunityToPayload(base, deps);
    expect(p.links).toContainEqual({ column: 'Donor', targetSfIds: ['c1'] });
    expect(p.links).toContainEqual({ column: 'Matched By', targetSfIds: ['a-google'] });
    expect(p.columns['Anonymous Donor']).toBeNull();
  });

  it('still fills Matched By when no employee is known (Donor falls back to the company)', () => {
    const p = opportunityToPayload({ ...base, npsp__Primary_Contact__c: null }, deps);
    expect(p.links).toContainEqual({ column: 'Donor', targetSfIds: ['a-google'] });
    expect(p.links).toContainEqual({ column: 'Matched By', targetSfIds: ['a-google'] });
  });

  it('does not set Matched By on a non-matching gift or when the Account is not an organization', () => {
    const plain = opportunityToPayload({ ...base, RecordType: { Name: 'Donation' } }, deps);
    expect(plain.links!.some((l) => l.column === 'Matched By')).toBe(false);
    const household = opportunityToPayload({ ...base, AccountId: 'a-household' }, deps);
    expect(household.links!.some((l) => l.column === 'Matched By')).toBe(false);
  });

  it('treats the "Anonymous Person" placeholder as no donor: checkbox on, no Donor link, company kept', () => {
    const p = opportunityToPayload({ ...base, npsp__Primary_Contact__c: 'c-anon' }, deps);
    expect(p.columns['Anonymous Donor']).toEqual({ checked: 'true' });
    expect(p.links!.some((l) => l.column === 'Donor')).toBe(false);
    expect(p.links).toContainEqual({ column: 'Matched By', targetSfIds: ['a-google'] });
    // A plain gift on the placeholder's own household account: anonymous, no fallback to that account.
    const plain = opportunityToPayload({ ...base, RecordType: { Name: 'Donation' },
      npsp__Primary_Contact__c: 'c-anon', AccountId: 'a-anon' }, deps);
    expect(plain.columns['Anonymous Donor']).toEqual({ checked: 'true' });
    expect(plain.links).toEqual([]);
  });

  it('declares the Benevity Transaction ID column (blank on migrated history) so load creates it', () => {
    const p = opportunityToPayload(base, deps);
    expect(p.columns).toHaveProperty('Benevity Transaction ID', '');
  });
});

describe('click & pledge', () => {
  it('re-points an Account-only Donor link at the person the Account was folded into', () => {
    const p = cnpToPayload({ Id: 't3', Name: 'CP Gift', CnP_PaaS__TotalCharged__c: 25,
      CnP_PaaS__TransactionDate__c: '2016-05-01T00:00:00Z', CnP_PaaS__Contact__c: null, CnP_PaaS__Account__c: 'a-pn',
      CreatedDate: '2016-05-01T00:00:00Z', CreatedBy: { Name: 'X' },
      LastModifiedDate: '2016-05-01T00:00:00Z', LastModifiedBy: { Name: 'X' } },
      new Map([['a-pn', 'c7']]));
    expect(p.links).toEqual([{ column: 'Donor', targetSfIds: ['c7'] }]);
  });

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
      LastModifiedDate: '2016-05-01T00:00:00Z', LastModifiedBy: { Name: 'X' } });
    expect(p.board).toBe('donations');
    expect(p.columns['Gift Type']).toBe('Click & Pledge (historical)');
    expect(p.columns['Status']).toEqual({ label: 'Received' });
    expect(p.columns['Fiscal Year Ending']).toBe('2016');
    expect(p.links).toContainEqual({ column: 'Donor', targetSfIds: ['c9'] });
  });
});

describe('unknownStages', () => {
  it('counts only stages the Status mapping does not recognise', () => {
    const opps = ['Posted', 'Closed Won', 'Closed Lost', 'Withdrawn', 'Pledged', 'Prospecting', 'Invoiced',
      'Not Posted', 'Engaged with Organization', 'Qualification', 'Qualification', null]
      .map((StageName, i) => ({ Id: `o${i}`, StageName }));
    expect([...unknownStages(opps)]).toEqual([['Qualification', 2], ['(blank)', 1]]);
  });
});

describe('softCreditsByGift', () => {
  const opps = [
    { Id: 'o1', npsp__Primary_Contact__c: 'c1' },
    { Id: 'o2', npsp__Primary_Contact__c: null, funraise__fr_Donor__c: 'c2' },
  ];
  const role = (OpportunityId: string, ContactId: string | null, Role: string | null, IsPrimary = false) =>
    ({ OpportunityId, ContactId, Role, IsPrimary });

  it('keeps roles naming someone other than the Primary Contact, household members aside', () => {
    const credits = softCreditsByGift([
      role('o1', 'c1', 'Donor', true),          // the Primary Contact itself → already Donor
      role('o1', 'c1', 'Soft Credit', true),    // NPSP's other stamp on the Primary Contact
      role('o1', 'c9', 'Fundraiser'),
      role('o1', 'c5', 'Household Member'),     // derivable from the household → skipped
      role('o1', 'c4', null),                   // blank role still names a real person
      role('o1', 'c9', 'Team Captain'),         // same person twice → one link
      role('o2', 'c2', 'Donor'),                // Funraise donor stands in for the Primary Contact
      role('o2', 'c6', 'Soft Credit', true),    // primary role on someone else → a real credit
      role('o3', 'c7', 'Influencer'),           // gift not extracted → no payload to carry it
      role('o1', null, 'Influencer'),
    ], opps);
    expect([...credits]).toEqual([['o1', ['c4', 'c9']], ['o2', ['c6']]]);
  });

  it('never credits the placeholder Anonymous Person', () => {
    expect(softCreditsByGift([role('o1', 'anon', 'Influencer')], opps, new Set(['anon'])).size).toBe(0);
  });
});
