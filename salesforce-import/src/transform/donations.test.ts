import { describe, it, expect } from 'vitest';
import { opportunityToPayload, cnpToPayload, cnpOverlapCheck, softCreditsByGift, unknownStages,
  isEventbriteTicketOrder, eventbriteOrderIdsByOpportunity, foldFeeCoverage, FEE_COVERED } from './donations.js';

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

  it('drops a Donor that still resolves to a One-to-One Account instead of leaving it dangling', () => {
    const gift = { ...base, npsp__Primary_Contact__c: null, AccountId: 'a-ind' };
    const personAccountIds = new Set(['a-ind']);
    expect(opportunityToPayload(gift, { termCols: new Map(), personAccountIds }).links)
      .not.toContainEqual(expect.objectContaining({ column: 'Donor' }));
    // Unresolved, not anonymous — staff resolve it from the review file.
    expect(opportunityToPayload(gift, { termCols: new Map(), personAccountIds }).columns['Anonymous Donor']).toBeNull();
    // …but the sole-contact alias, when there is one, wins.
    expect(opportunityToPayload(gift, { termCols: new Map(), personAccountIds,
      donorAlias: new Map([['a-ind', 'c9']]) }).links).toContainEqual({ column: 'Donor', targetSfIds: ['c9'] });
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

  describe('Closed Won by origin (#43: eb4sf files paid Eventbrite ticket orders as Closed Won)', () => {
    const EB_USER = 'SVBC Integration';
    const deps = { termCols: new Map(), eventbriteIntegrationUserName: EB_USER };
    // Shaped like the real rows: eb4sf names every order "… Eventbrite" under the Donation record type.
    const ticket = { ...base, Id: 'o-eb', Name: 'Ada Lovelace - Bike Summit 2026 - Eventbrite', Amount: 45,
      CloseDate: '2025-09-20', StageName: 'Closed Won', RecordType: { Name: 'Donation' }, CreatedBy: { Name: EB_USER } };

    it('maps an integration-user Closed Won order to Received / Event Ticket, keeping its links', () => {
      const p = opportunityToPayload(ticket, deps);
      expect(p.columns['Status']).toEqual({ label: 'Received' });
      expect(p.columns['Gift Type']).toBe('Event Ticket');
      expect(p.columns['Fiscal Year Ending']).toBe('2026');
      expect(p.links).toContainEqual({ column: 'Donor', targetSfIds: ['c1'] });
    });

    it('keeps a Closed Won gift a staff member created as Received (Historical), even with an Eventbrite name', () => {
      const p = opportunityToPayload({ ...ticket, CreatedBy: { Name: 'Gavin Powell' } }, deps);
      expect(p.columns['Status']).toEqual({ label: 'Received (Historical)' });
      expect(p.columns['Gift Type']).toBe('Donation');
    });

    it('is Closed Won only: a Posted gift the integration user created is an ordinary Received gift', () => {
      const p = opportunityToPayload({ ...ticket, StageName: 'Posted' }, deps);
      expect(p.columns['Status']).toEqual({ label: 'Received' });
      expect(p.columns['Gift Type']).toBe('Donation');
    });

    it('stamps the linked Eventbrite order id so eventbrite-sync adopts the item, blank otherwise', () => {
      expect(opportunityToPayload(ticket, { ...deps, eventbriteOrderId: '15915360463' })
        .columns['Eventbrite Order ID']).toBe('15915360463');
      expect(opportunityToPayload(ticket, deps).columns['Eventbrite Order ID']).toBe('');
      expect(opportunityToPayload(base, { termCols: new Map() }).columns['Eventbrite Order ID']).toBe('');
    });

    it('does nothing without a configured integration user (a fork without eb4sf)', () => {
      for (const eventbriteIntegrationUserName of [undefined, null, '']) {
        const p = opportunityToPayload(ticket, { termCols: new Map(), eventbriteIntegrationUserName });
        expect(p.columns['Status'], String(eventbriteIntegrationUserName)).toEqual({ label: 'Received (Historical)' });
        expect(p.columns['Gift Type']).toBe('Donation');
      }
      expect(isEventbriteTicketOrder({ ...ticket, CreatedBy: null }, EB_USER)).toBe(false);
    });
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
  it('dates a gift by its Pacific day, the one Salesforce shows and CloseDate takes', () => {
    const p = cnpToPayload({ Id: 't8', CnP_PaaS__TransactionDate__c: '2022-01-01T07:28:38.000+0000' });
    expect(p.columns['Date']).toEqual({ date: '2021-12-31' });
  });

  it('files a gift in the fiscal year of its Pacific day', () => {
    const p = cnpToPayload({ Id: 't9', CnP_PaaS__TransactionDate__c: '2021-07-01T05:00:00.000+0000' });
    expect(p.columns['Fiscal Year Ending']).toBe('2021');
  });

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

describe('eventbriteOrderIdsByOpportunity', () => {
  it('maps each Opportunity to its order Name, skipping unlinked or unnamed orders', () => {
    const { byOpportunity, multiOrderOpportunities } = eventbriteOrderIdsByOpportunity([
      { Id: 'x1', Name: '15915360463', eb4sf__Opportunity__c: 'o1' },
      { Id: 'x2', Name: ' 15913876273 ', eb4sf__Opportunity__c: 'o2' },
      { Id: 'x3', Name: '15912820233', eb4sf__Opportunity__c: null },
      { Id: 'x4', Name: null, eb4sf__Opportunity__c: 'o3' },
    ]);
    expect([...byOpportunity]).toEqual([['o1', '15915360463'], ['o2', '15913876273']]);
    expect(multiOrderOpportunities).toBe(0);
  });

  it('keeps the lowest order id, whatever the row order, and counts the Opportunity', () => {
    const rows = [
      { Name: '200', eb4sf__Opportunity__c: 'o1' },
      { Name: '100', eb4sf__Opportunity__c: 'o1' },
      { Name: '100', eb4sf__Opportunity__c: 'o1' },
    ];
    for (const orders of [rows, [...rows].reverse()]) {
      const r = eventbriteOrderIdsByOpportunity(orders);
      expect(r.byOpportunity.get('o1')).toBe('100');
      expect(r.multiOrderOpportunities).toBe(1);
    }
  });
});

describe('audited Opportunity columns (docs/32)', () => {
  const base = { Id: 'o1', Name: 'Gift', Amount: 50, CloseDate: '2026-01-15', StageName: 'Posted',
    RecordType: { Name: 'Donation' }, npsp__Primary_Contact__c: 'c1' };

  it('carries finance coding, payment method, check number and in-kind value/category', () => {
    const p = opportunityToPayload({ ...base, Finance_Class__c: '4400 Programs:4420 BTWD',
      Finance_Revenue_Code__c: '45100 Special Event Sponsorships', Payment_Method__c: 'Cash/Check',
      Check_Reference_Number__c: ' 1042 ', Retail_Value__c: 10394.8, In_Kind_Category__c: 'Bike Accessories' },
    { termCols: new Map() });
    expect(p.columns).toMatchObject({
      'Finance Class': '4400 Programs:4420 BTWD', 'Revenue Code': '45100 Special Event Sponsorships',
      'Payment Method': 'Cash/Check', 'Check/Reference Number': '1042',
      'In-Kind Value': '10394.8', 'In-Kind Category': 'Bike Accessories', 'Fee Covered': '',
    });
  });

  it('carries Sponsorship Cycle, joining a multi-select with "; " (docs/35 §3.2)', () => {
    const p = opportunityToPayload({ ...base, Sponsorship_Cycle__c: '2023-2024 BTWD;2024 Summit ' },
      { termCols: new Map() });
    expect(p.columns['Sponsorship Cycle']).toBe('2023-2024 BTWD; 2024 Summit');
  });

  it('declares every audited column blank when Salesforce has nothing, so load still creates it', () => {
    const p = opportunityToPayload(base, { termCols: new Map() });
    for (const col of ['Fee Covered', 'Finance Class', 'Revenue Code', 'Payment Method', 'Check/Reference Number',
      'In-Kind Value', 'In-Kind Category', 'Sponsorship Cycle']) {
      expect(p.columns[col], col).toBe('');
    }
  });
});

describe('foldFeeCoverage', () => {
  // Shaped like the real pair: same donor, same CreatedDate second, the split's Amount equal to
  // the gift's Funraise_Fee_Match_Amount__c, no Funraise id on the split.
  const gift = { Id: 'g1', Amount: 20, StageName: 'Posted', npsp__Primary_Contact__c: 'c1',
    CreatedDate: '2026-10-25T07:30:01.000+0000', funraise__fr_ID__c: '14431664',
    Funraise_Fee_Match_Opportunity__c: false, Funraise_Fee_Match_Amount__c: 1.6 };
  const split = { ...gift, Id: 's1', Amount: 1.6, funraise__fr_ID__c: null, Funraise_Fee_Match_Opportunity__c: true };

  it('drops the split and adds its fee to the gift, recorded as Fee Covered', () => {
    const r = foldFeeCoverage([split, gift]);
    expect(r.gifts.map((o) => o['Id'])).toEqual(['g1']);
    expect(r.gifts[0]).toMatchObject({ Amount: 21.6, [FEE_COVERED]: 1.6 });
    expect(r).toMatchObject({ folded: 1, foldedCents: 160, unpaired: 0 });
    expect(opportunityToPayload(r.gifts[0]!, { termCols: new Map() }).columns).toMatchObject({
      'Amount': '21.6', 'Fee Covered': '1.6' });
  });

  it('pairs each split with its own gift when one donor gives twice the same day', () => {
    const gift2 = { ...gift, Id: 'g2', CreatedDate: '2026-10-25T15:33:24.000+0000' };
    const split2 = { ...split, Id: 's2', CreatedDate: gift2.CreatedDate };
    const r = foldFeeCoverage([gift, split, gift2, split2]);
    expect(r.gifts.map((o) => o['Id'])).toEqual(['g1', 'g2']);
    expect(r.folded).toBe(2);
  });

  it('keeps a split with no matching gift as a gift of its own, and counts it', () => {
    for (const orphan of [
      split,
      { ...split, CreatedDate: '2026-10-25T07:30:02.000+0000' },
      { ...split, Amount: 1.5 },
      { ...split, StageName: 'Closed Lost' },
    ]) {
      const r = foldFeeCoverage(orphan === split ? [split] : [gift, orphan]);
      expect(r.gifts).toContain(orphan);
      expect(r.unpaired).toBe(1);
    }
  });

  it('leaves gifts with no split untouched (same object), even when they record a fee amount', () => {
    const r = foldFeeCoverage([gift]);
    expect(r.gifts[0]).toBe(gift);
    expect(r).toMatchObject({ folded: 0, unpaired: 0 });
  });
});
