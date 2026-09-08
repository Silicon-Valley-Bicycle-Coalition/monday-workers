import { describe, it, expect } from 'vitest';
import { salesforceDebug, setStaffMatcher, funraiseTransactionLink, funraiseSupporterLink, collapseEmail, consentColumns, localNewsUrl, localNewsName, dateCol, fiscalYear, ownerAttribution, consentLabel } from './fields.js';

describe('salesforceDebug', () => {
  it('folds SF ID and audit fields into one long-text column', () => {
    expect(salesforceDebug({
      Id: '0031234', CreatedDate: '2019-05-01T12:00:00.000+0000', CreatedBy: { Name: 'Ann' },
      LastModifiedDate: '2026-01-02T00:00:00.000+0000', LastModifiedBy: { Name: 'Bob' },
    })).toEqual({
      'Salesforce Debug': { text: 'SF ID: 0031234 | Created: 2019-05-01 by Ann | Modified: 2026-01-02 by Bob' },
    });
  });
  it('omits missing pieces instead of printing blanks', () => {
    expect(salesforceDebug({ Id: '0039999' }))
      .toEqual({ 'Salesforce Debug': { text: 'SF ID: 0039999' } });
  });
});

describe('collapseEmail', () => {
  it('follows the preferred-email pointer when populated', () => {
    expect(collapseEmail({ npe01__Preferred_Email__c: 'Work', npe01__WorkEmail__c: 'W@x.co',
      Primary_Email__c: 'p@x.co', Email: 'e@x.co' })).toBe('w@x.co');
  });
  it('falls back Primary_Email__c then Email', () => {
    expect(collapseEmail({ Primary_Email__c: 'p@x.co', Email: 'e@x.co' })).toBe('p@x.co');
    expect(collapseEmail({ Email: 'E@x.co' })).toBe('e@x.co');
    expect(collapseEmail({})).toBeNull();
  });
  it('ignores a preferred pointer at an empty field', () => {
    expect(collapseEmail({ npe01__Preferred_Email__c: 'Work', Email: 'e@x.co' })).toBe('e@x.co');
  });
});

describe('consentColumns', () => {
  const consent = new Map([['a@b.c', 'unsubscribed'], ['w@b.c', 'subscribed']]);
  it('labels each address from the Mailchimp map on its own — consent is per email, not per person', () => {
    expect(consentColumns('a@b.c', 'w@b.c', consent)).toEqual({
      'Email Consent': { label: 'Unsubscribed' }, 'Secondary Email Consent': { label: 'Subscribed' } });
    expect(consentColumns('missing@x.y', 'a@b.c', consent)).toEqual({
      'Email Consent': { label: 'Not in Mailchimp' }, 'Secondary Email Consent': { label: 'Unsubscribed' } });
  });
  it('keeps the primary column never blank, but leaves the secondary blank when there is no second address', () => {
    expect(consentColumns(null, null, consent)).toEqual({ 'Email Consent': { label: 'Not in Mailchimp' } });
    expect(consentColumns('a@b.c', null, consent)).toEqual({ 'Email Consent': { label: 'Unsubscribed' } });
  });
});

describe('localNewsUrl', () => {
  const cfg = { rules: [
    { cities: ['san jose'], url: 'https://sanjosespotlight.com/', name: 'San Jose Spotlight' },
    { cities: ['santa clara', 'cupertino', 'campbell', 'saratoga'], url: 'https://civicdigest.org', name: 'Civic Digest' },
  ], defaultUrl: 'https://localnewsmatters.org/', defaultName: 'Local News Matters' };
  it('matches case-insensitively and defaults', () => {
    expect(localNewsUrl('San Jose', cfg)).toBe('https://sanjosespotlight.com/');
    expect(localNewsUrl('CUPERTINO', cfg)).toBe('https://civicdigest.org');
    expect(localNewsUrl('Oakland', cfg)).toBe('https://localnewsmatters.org/');
    expect(localNewsUrl(null, cfg)).toBe('https://localnewsmatters.org/');
  });
});

describe('localNewsName', () => {
  const cfg = { rules: [
    { cities: ['san jose'], url: 'https://sanjosespotlight.com/', name: 'San Jose Spotlight' },
    { cities: ['santa clara', 'cupertino', 'campbell', 'saratoga'], url: 'https://civicdigest.org', name: 'Civic Digest' },
  ], defaultUrl: 'https://localnewsmatters.org/', defaultName: 'Local News Matters' };
  it('matches case-insensitively and defaults, sourced entirely from config', () => {
    expect(localNewsName('San Jose', cfg)).toBe('San Jose Spotlight');
    expect(localNewsName('CUPERTINO', cfg)).toBe('Civic Digest');
    expect(localNewsName('Oakland', cfg)).toBe('Local News Matters');
    expect(localNewsName(null, cfg)).toBe('Local News Matters');
  });
});

describe('dateCol', () => {
  it('truncates datetimes and passes nulls', () => {
    expect(dateCol('2122-01-01')).toEqual({ date: '2122-01-01' });
    expect(dateCol('2019-05-01T12:00:00.000+0000')).toEqual({ date: '2019-05-01' });
    expect(dateCol(null)).toBeNull();
  });
});

describe('fiscalYear', () => {
  // SVBC's FY runs July→June (Organization.FiscalYearStartMonth = 7). FY2026 = Jul 2025–Jun 2026.
  it('rolls a gift closed in the second half of the calendar year into next year\'s FY', () => {
    expect(fiscalYear('2025-12-31')).toBe('2026');
    expect(fiscalYear('2025-07-01')).toBe('2026');
  });
  it('keeps a gift closed in the first half of the calendar year in that year\'s FY', () => {
    expect(fiscalYear('2026-06-30')).toBe('2026');
    expect(fiscalYear('2026-01-01')).toBe('2026');
  });
  it('truncates a full datetime the same way dateCol does', () => {
    expect(fiscalYear('2025-12-31T23:59:59.000+0000')).toBe('2026');
  });
  it('returns empty string for missing or malformed dates, not a crash', () => {
    expect(fiscalYear(null)).toBe('');
    expect(fiscalYear(undefined)).toBe('');
    expect(fiscalYear('')).toBe('');
  });
});

describe('ownerAttribution', () => {
  it('appends the Monday email for a current staff match, leaves former staff and non-human accounts bare', () => {
    setStaffMatcher((name) => (name === 'Deanna Chevas' ? 'deanna@bikesiliconvalley.org' : null));
    try {
      expect(ownerAttribution({ Name: 'Deanna Chevas' })).toBe('Deanna Chevas (deanna@bikesiliconvalley.org)');
      expect(ownerAttribution({ Name: 'Tim Oey' })).toBe('Tim Oey'); // former staff, no match
      expect(ownerAttribution({ Name: 'SVBC Integration' })).toBe('SVBC Integration'); // non-human account
    } finally {
      setStaffMatcher(null);
    }
  });
  it('returns empty string for a null/missing owner', () => {
    expect(ownerAttribution(null)).toBe('');
    expect(ownerAttribution({})).toBe('');
  });
});

describe('salesforceDebug staff annotation', () => {
  it('appends the Monday email for names matching current staff, leaves others bare', () => {
    setStaffMatcher((name) => (name === 'Deanna Chevas' ? 'deanna@bikesiliconvalley.org' : null));
    try {
      expect(salesforceDebug({
        Id: '0031', CreatedDate: '2015-01-01T00:00:00Z', CreatedBy: { Name: 'Seth Goddard' },
        LastModifiedDate: '2020-01-02T00:00:00Z', LastModifiedBy: { Name: 'Deanna Chevas' },
      })).toEqual({
        'Salesforce Debug': { text:
          'SF ID: 0031 | Created: 2015-01-01 by Seth Goddard | Modified: 2020-01-02 by Deanna Chevas (deanna@bikesiliconvalley.org)' },
      });
    } finally {
      setStaffMatcher(null);
    }
  });
});

describe('funraise links', () => {
  it('builds a transaction link column value from a Funraise id', () => {
    expect(funraiseTransactionLink('12345')).toEqual({
      url: 'https://platform.funraise.io/transaction/12345', text: '12345',
    });
  });
  it('builds a supporter profile link', () => {
    expect(funraiseSupporterLink('777')).toEqual({
      url: 'https://platform.funraise.io/supporter/777', text: '777',
    });
  });
  it('returns null for a blank id', () => {
    expect(funraiseTransactionLink('')).toBeNull();
    expect(funraiseSupporterLink(undefined)).toBeNull();
  });
});

describe('consentLabel', () => {
  const consent = new Map([['a@b.c', 'cleaned']]);
  it('capitalizes the Mailchimp status and defaults to Not in Mailchimp', () => {
    expect(consentLabel('a@b.c', consent)).toBe('Cleaned');
    expect(consentLabel('x@y.z', consent)).toBe('Not in Mailchimp');
    expect(consentLabel(null, consent)).toBe('Not in Mailchimp');
  });
});
