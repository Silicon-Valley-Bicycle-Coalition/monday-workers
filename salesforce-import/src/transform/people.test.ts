import { describe, it, expect } from 'vitest';
import { classifyContact, contactToPayload, accountToPayload, personNamedAccountIds,
  type InclusionInput } from './people.js';
import type { MemberSummary } from './membership.js';
import { setStaffMatcher } from './fields.js';
import { BOARD_SPECS } from '../configure/spec.js';

const emptyInc = (): InclusionInput => ({
  donorIds: new Set(), recentDonorIds: new Set(), memberSummaries: new Map(),
  registrantIds: new Set(), recentRegistrantIds: new Set(), volunteerIds: new Set(), affiliatedIds: new Set(),
  recentActivityIds: new Set(),
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
  it('registrants for recent events are live, older registrants historical', () => {
    const inc = emptyInc(); inc.registrantIds.add('c1'); inc.registrantIds.add('c2'); inc.recentRegistrantIds.add('c2');
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
  // 1,492 People in the 2026-09-08 extract had a Mailing City but no geocode result, so City and
  // Zip loaded blank even though Address showed them (#13 sample review, 2026-10-23).
  it('falls back to Mailing City/Zip when there is no geocode result', () => {
    const p = contactToPayload({ Id: 'c9', FirstName: 'No', LastName: 'Street',
      MailingCity: 'San Jose', MailingState: 'CA', MailingPostalCode: '95110-1442' },
    'people-live', { consent: new Map() });
    expect(p.columns['Address']).toBe('San Jose, CA, 95110-1442');
    expect(p.columns['City']).toBe('San Jose');
    expect(p.columns['Zip']).toBe('95110');
    expect(p.columns['Lat']).toBe('');
  });
  it('prefers the geocoded City/Zip over the Salesforce values', () => {
    const p = contactToPayload({ Id: 'c10', MailingStreet: '1 Elm', MailingCity: 'SJ',
      MailingPostalCode: '95112' },
    'people-live', { consent: new Map(),
      geo: { lat: 37.3, lng: -121.9, city: 'San Jose', zip: '95113', source: 'census' } });
    expect(p.columns['City']).toBe('San Jose');
    expect(p.columns['Zip']).toBe('95113');
  });
  it('keeps a non-US postal code as written', () => {
    const p = contactToPayload({ Id: 'c11', MailingCity: 'Toronto', MailingPostalCode: ' M5V 2T6 ' },
      'people-live', { consent: new Map() });
    expect(p.columns['Zip']).toBe('M5V 2T6');
  });
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

  it('carries Do Not Mail and its reason, and leaves both blank when unset', () => {
    const p = contactToPayload({ Id: 'c12', FirstName: 'A', LastName: 'B', Do_Not_Mail__c: true,
      Do_Not_Mail_Reason__c: 'Undeliverable' }, 'people-live', { consent: new Map() });
    expect(p.columns['Do Not Mail']).toEqual({ checked: 'true' });
    expect(p.columns['Do Not Mail Reason']).toBe('Undeliverable');
    const q = contactToPayload({ Id: 'c13', FirstName: 'A', LastName: 'B' }, 'people-live', { consent: new Map() });
    expect(q.columns['Do Not Mail']).toBeNull();
    expect(q.columns['Do Not Mail Reason']).toBe('');
  });

  it('marks a deceased contact Do Not Solicit with reason Deceased, keeping any existing reason', () => {
    const dead = contactToPayload({ Id: 'c14', FirstName: 'A', LastName: 'B', Deceased__c: true },
      'people-historical', { consent: new Map() });
    expect(dead.columns['Do Not Solicit']).toEqual({ checked: 'true' });
    expect(dead.columns['Do Not Solicit Reason']).toBe('Deceased');
    const npsp = contactToPayload({ Id: 'c15', FirstName: 'A', LastName: 'B', npsp__Deceased__c: true,
      Account: { Do_Not_Solicit__c: true, Do_Not_Solicit_What__c: 'Mail' } }, 'people-live', { consent: new Map() });
    expect(npsp.columns['Do Not Solicit Reason']).toBe('Deceased; Mail');
  });

  it('prefers Employer__c over the empty 360MatchPro dtd__company__c for Employer Name', () => {
    const p = contactToPayload({ Id: 'c1', FirstName: 'A', LastName: 'B', Employer__c: 'Google',
      dtd__company__c: null, CreatedDate: '2020-01-01T00:00:00Z', CreatedBy: { Name: 'X' },
      LastModifiedDate: '2020-01-01T00:00:00Z', LastModifiedBy: { Name: 'X' } }, 'people-live',
      { consent: new Map() });
    expect(p.columns['Employer Name']).toBe('Google');
  });

  it('seeds Stakeholder Type = Elected Official from Elected__c and leaves everyone else blank (#46)', () => {
    const base = { FirstName: 'A', LastName: 'B', CreatedDate: '2020-01-01T00:00:00Z', CreatedBy: { Name: 'X' },
      LastModifiedDate: '2020-01-01T00:00:00Z', LastModifiedBy: { Name: 'X' } };
    const elected = contactToPayload({ Id: 'c5', ...base, Elected__c: true }, 'people-live', { consent: new Map() });
    expect(elected.columns['Stakeholder Type']).toEqual({ label: 'Elected Official' });
    // The classification is a fact about the person, not the board: an elected official with
    // no recent activity keeps it on People (Historical).
    const historical = contactToPayload({ Id: 'c8', ...base, Elected__c: true }, 'people-historical', { consent: new Map() });
    expect(historical.columns['Stakeholder Type']).toEqual({ label: 'Elected Official' });
    // Absent, not null — the column must not be forced onto a board with no elected contact.
    for (const row of [{ Id: 'c6', ...base, Elected__c: false }, { Id: 'c7', ...base }]) {
      const p = contactToPayload(row, 'people-live', { consent: new Map() });
      expect('Stakeholder Type' in p.columns, row.Id).toBe(false);
    }
    // The label is the one configure's spec declares, or the seeded column would carry a stray value.
    const spec = BOARD_SPECS['people-live']!.columns!.find((col) => col.title === 'Stakeholder Type')!;
    expect(spec.labels).toContain('Elected Official');
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
  // No street (or a street the geocoder couldn't match) means no geocode result, but Salesforce
  // still has the city and zip: 94 Organizations in the 2026-09-08 extract (#13 sample review).
  it('falls back to Billing City/Zip when there is no geocode result', () => {
    const p = accountToPayload({ Id: 'a5', Name: 'Acme', npe01__SYSTEM_AccountType__c: null,
      BillingCity: ' Milpitas ', BillingState: 'CA', BillingPostalCode: '95035-1234' })!;
    expect(p.columns['City']).toBe('Milpitas');
    expect(p.columns['Zip']).toBe('95035');
    expect(p.columns['Lat']).toBe('');
  });
});

describe('personNamedAccountIds', () => {
  // Blank-type Accounts whose only Contact(s) carry the Account's own name are people that
  // NPSP never stamped — imported Account-first (2013 bulk load) or written by Click & Pledge.
  // Live org 2026-09-08: 204 of the 2,090 blank-type Accounts; 172 carry the C&P Online record type.
  const org = (Id: string, Name: string, type: string | null = null) =>
    ({ Id, Name, npe01__SYSTEM_AccountType__c: type });
  const contact = (Id: string, FirstName: string, LastName: string, AccountId: string) =>
    ({ Id, FirstName, LastName, AccountId });

  it('maps a blank-type Account named after its sole Contact to that Contact', () => {
    const m = personNamedAccountIds([org('a1', 'Mike Klein')], [contact('c1', 'Mike', 'Klein', 'a1')]);
    expect(m).toEqual(new Map([['a1', 'c1']]));
  });

  it('ignores case, punctuation, and spacing when comparing names', () => {
    const m = personNamedAccountIds([org('a1', "cammie d'entremont partelow")],
      [contact('c1', 'Cammie', "D'Entremont-Partelow", 'a1')]);
    expect(m.get('a1')).toBe('c1');
  });

  it('still folds when every Contact on the Account is a same-named duplicate (first wins)', () => {
    const m = personNamedAccountIds([org('a1', 'Anita Torres')],
      [contact('c1', 'Anita', 'Torres', 'a1'), contact('c2', 'anita', 'torres', 'a1')]);
    expect(m.get('a1')).toBe('c1');
  });

  it('leaves an Account alone when any attached Contact has a different name', () => {
    const m = personNamedAccountIds([org('a1', 'Jason Lin')],
      [contact('c1', 'Jason', 'Lin', 'a1'), contact('c2', 'Wei', 'Lin', 'a1')]);
    expect(m.size).toBe(0);
  });

  it('leaves real organizations and contact-less Accounts alone', () => {
    const m = personNamedAccountIds([org('a1', 'Acme'), org('a2', 'Nobody Here')],
      [contact('c1', 'Ada', 'L', 'a1')]);
    expect(m.size).toBe(0);
  });

  it('does not touch one-to-one Accounts — those already fold via the existing rule', () => {
    const m = personNamedAccountIds([org('a1', 'Ada L', 'One-to-One Individual')],
      [contact('c1', 'Ada', 'L', 'a1')]);
    expect(m.size).toBe(0);
  });

  it('never matches on empty names', () => {
    const m = personNamedAccountIds([org('a1', '')], [contact('c1', '', '', 'a1')]);
    expect(m.size).toBe(0);
  });
});
