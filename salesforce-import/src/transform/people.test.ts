import { describe, it, expect } from 'vitest';
import { classifyContact, contactToPayload, accountToPayload, type InclusionInput } from './people.js';
import type { MemberSummary } from './membership.js';

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
      { consent: new Map([['ada@x.co', 'subscribed']]), member,
        geo: { lat: 37.3, lng: -121.9, city: 'San Jose', zip: '95112', source: 'census' }, news });
    expect(p.board).toBe('people-live');
    expect(p.name).toBe('Ada Lovelace');
    expect(p.columns['Email']).toEqual({ email: 'ada@x.co', text: 'ada@x.co' });
    expect(p.columns['Secondary Email']).toEqual({ email: 'work@x.co', text: 'work@x.co' });
    expect(p.columns['Membership Status']).toEqual({ label: 'Active' });
    expect(p.columns['Membership Tier']).toEqual({ label: 'Lifetime' });
    expect(p.columns['Member Until']).toBeNull();          // Lifetime: blank, never fires lapse automation
    expect(p.columns['Local News']).toEqual({ url: 'https://sanjosespotlight.com/', text: 'San Jose Spotlight' });
    expect(p.columns['Do Not Solicit']).toEqual({ checked: 'true' });
    expect(p.columns['Do Not Solicit Reason']).toBe('mail');
    expect(p.columns['Employer Name']).toBe('Acme Corp');
    expect(p.columns['Email Consent']).toEqual({ label: 'Subscribed' });
    expect(p.columns['SF ID']).toBe('c1');
    expect(p.columns['Salesforce Created Date']).toEqual({ date: '2012-01-01' });
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
});
