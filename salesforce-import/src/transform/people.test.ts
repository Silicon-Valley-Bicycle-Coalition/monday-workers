import { describe, it, expect } from 'vitest';
import { classifyContact, contactToPayload, accountToPayload, type InclusionInput } from './people.js';
import type { MemberSummary } from './membership.js';
import { setStaffMatcher } from './fields.js';

const emptyInc = (): InclusionInput => ({
  donorIds: new Set(), recentDonorIds: new Set(), memberSummaries: new Map(),
  registrantIds: new Set(), volunteerIds: new Set(), affiliatedIds: new Set(), recentActivityIds: new Set(),
});
const news = { rules: [{ cities: ['san jose'], url: 'https://sanjosespotlight.com/', name: 'San Jose Spotlight' }],
  defaultUrl: 'https://localnewsmatters.org/', defaultName: 'Local News Matters' };

describe('classifyContact', () => {
  const SINCE = '2019-01-01';
  it('excludes email-list-only contacts', () => {
    expect(classifyContact({ Id: 'c1' }, emptyInc(), SINCE)).toBeNull();
  });
  it('includes funraise supporters as live', () => {
    expect(classifyContact({ Id: 'c1', funraise__fr_ID__c: 'f1' }, emptyInc(), SINCE)).toBe('people-live');
  });
  it('recent donors are live, old donors historical', () => {
    const inc = emptyInc(); inc.donorIds.add('c1'); inc.donorIds.add('c2'); inc.recentDonorIds.add('c2');
    expect(classifyContact({ Id: 'c1' }, inc, SINCE)).toBe('people-historical');
    expect(classifyContact({ Id: 'c2' }, inc, SINCE)).toBe('people-live');
  });
  it('active members are live; long-lapsed members historical', () => {
    const inc = emptyInc();
    inc.memberSummaries.set('c1', { status: 'Active', tier: 'Member', sinceISO: '2024-01-01', untilISO: '2026-12-01' });
    inc.memberSummaries.set('c2', { status: 'Lapsed', tier: 'Member', sinceISO: '2001-01-01', untilISO: '2002-01-01' });
    expect(classifyContact({ Id: 'c1' }, inc, SINCE)).toBe('people-live');
    expect(classifyContact({ Id: 'c2' }, inc, SINCE)).toBe('people-historical');
  });
});

describe('contactToPayload', () => {
  it('builds the full column set with Account-nested Do_Not_Solicit fields and Employer Name', () => {
    const member: MemberSummary = { status: 'Active', tier: 'Lifetime', sinceISO: '2010-01-01', untilISO: null };
    const p = contactToPayload(
      { Id: 'c1', FirstName: 'Ada', LastName: 'Lovelace', Email: 'Ada@x.co', Phone: '555',
        MailingStreet: '1 Elm', MailingCity: 'San Jose', MailingState: 'CA', MailingPostalCode: '95112',
        Secondary_Email__c: 'work@x.co',
        Account: { Do_Not_Solicit__c: true, Do_Not_Solicit_What__c: 'mail' },
        dtd__company__c: 'Acme Corp',
        CreatedDate: '2012-01-01T00:00:00Z', CreatedBy: { Name: 'Ann' },
        LastModifiedDate: '2026-01-01T00:00:00Z', LastModifiedBy: { Name: 'Bob' } },
      'people-live',
      { consent: new Map([['ada@x.co', 'subscribed'], ['work@x.co', 'unsubscribed']]), member,
        geo: { lat: 37.3, lng: -121.9, city: 'San Jose', zip: '95112', source: 'census' } });
    expect(p.board).toBe('people-live');
    expect(p.name).toBe('Ada Lovelace');
    expect(p.columns['Personal Email']).toEqual({ email: 'ada@x.co', text: 'ada@x.co' });
    expect(p.columns['Household Email']).toEqual({ email: 'work@x.co', text: 'work@x.co' });
    expect(p.columns['Membership Status']).toEqual({ label: 'Active' });
    expect(p.columns['Membership Tier']).toEqual({ label: 'Lifetime' });
    expect(p.columns['Member Until']).toBeNull();          // Lifetime: blank, never fires lapse automation
    expect(p.columns['Local News']).toBeUndefined(); // removed 2026-08-23 — not useful yet
    expect(p.columns['Do Not Solicit']).toEqual({ checked: 'true' });
    expect(p.columns['Do Not Solicit Reason']).toBe('mail');
    expect(p.columns['Employer Name']).toBe('Acme Corp');
    expect(p.columns['Personal Email Consent']).toEqual({ label: 'Subscribed' });
    expect(p.columns['Household Email Consent']).toEqual({ label: 'Unsubscribed' });
    expect('Household Primary' in p.columns).toBe(false);
    expect(p.columns['Salesforce Debug']).toEqual({ text: expect.stringContaining('SF ID: c1') });
  });

  it('takes an explicit email assignment, Household Primary, and the Affiliations link', () => {
    const p = contactToPayload(
      { Id: 'c9', FirstName: 'Ada', LastName: 'L', Email: 'ada@acme.example', Secondary_Email__c: 'ada@gmail.com' },
      'people-live',
      { consent: new Map([['ada@gmail.com', 'subscribed']]),
        emails: { personal: 'ada@gmail.com', household: null },
        householdPrimary: true, affiliationSfIds: ['af1', 'af2'] });
    expect(p.columns['Personal Email']).toEqual({ email: 'ada@gmail.com', text: 'ada@gmail.com' });
    expect(p.columns['Household Email']).toBeNull();
    expect(p.columns['Personal Email Consent']).toEqual({ label: 'Subscribed' });
    expect('Household Email Consent' in p.columns).toBe(false);
    expect(p.columns['Household Primary']).toEqual({ checked: 'true' });
    expect(p.links).toContainEqual({ column: 'Affiliations', targetSfIds: ['af1', 'af2'] });
  });

  it('takes Salesforce Owner from the one-to-one Account, not a Contact-level field', () => {
    setStaffMatcher((name) => (name === 'Felicia Ward' ? 'felicia@bikesiliconvalley.org' : null));
    try {
      const matched = contactToPayload(
        { Id: 'c2', FirstName: 'A', LastName: 'B', Account: { Owner: { Name: 'Felicia Ward' } } },
        'people-live', { consent: new Map() });
      expect(matched.columns['Salesforce Owner']).toBe('Felicia Ward (felicia@bikesiliconvalley.org)');

      const unmatched = contactToPayload(
        { Id: 'c3', FirstName: 'A', LastName: 'B', Account: { Owner: { Name: 'SVBC Integration' } } },
        'people-live', { consent: new Map() });
      expect(unmatched.columns['Salesforce Owner']).toBe('SVBC Integration');

      const missing = contactToPayload(
        { Id: 'c4', FirstName: 'A', LastName: 'B' }, 'people-live', { consent: new Map() });
      expect(missing.columns['Salesforce Owner']).toBe('');
    } finally {
      setStaffMatcher(null);
    }
  });
});

describe('accountToPayload', () => {
  it('skips one-to-one individual accounts', () => {
    expect(accountToPayload({ Id: 'a1', npe01__SYSTEM_AccountType__c: 'One-to-One Individual' })).toBeNull();
  });
  it('maps organizations with the partner-type coalesce chain and Do Not Solicit fields', () => {
    const p = accountToPayload({ Id: 'a2', Name: 'Acme', npe01__SYSTEM_AccountType__c: null,
      Type: null, Type_2__c: 'Sponsor', Industry: 'Tech',
      Do_Not_Solicit__c: true, Do_Not_Solicit_What__c: 'phone' })!;
    expect(p.board).toBe('organizations');
    expect(p.columns['Partner Type']).toBe('Sponsor');
    expect(p.columns['Do Not Solicit']).toEqual({ checked: 'true' });
    expect(p.columns['Do Not Solicit Reason']).toBe('phone');
  });
  it('takes Salesforce Owner directly from the Account (true organizations, not one-to-one)', () => {
    const p = accountToPayload({ Id: 'a9', Name: 'Acme', npe01__SYSTEM_AccountType__c: null,
      Owner: { Name: 'Zachary Kearsley' } })!;
    expect(p.columns['Salesforce Owner']).toBe('Zachary Kearsley');
  });
  it('attaches geocoded City/Zip/Lat/Lng when geo is provided', () => {
    const p = accountToPayload({ Id: 'a3', Name: 'Acme', npe01__SYSTEM_AccountType__c: null,
      BillingStreet: '1 Main St', BillingCity: 'San Jose', BillingState: 'CA', BillingPostalCode: '95112' },
      { lat: 37.3, lng: -121.9, city: 'San Jose', zip: '95112', source: 'census' })!;
    expect(p.columns['City']).toBe('San Jose');
    expect(p.columns['Zip']).toBe('95112');
    expect(p.columns['Lat']).toBe('37.3');
    expect(p.columns['Lng']).toBe('-121.9');
  });
  it('leaves geo columns empty when no geocode result exists', () => {
    const p = accountToPayload({ Id: 'a4', Name: 'NoAddr', npe01__SYSTEM_AccountType__c: null })!;
    expect(p.columns['Lat']).toBe('');
    expect(p.columns['City']).toBe('');
  });
});
