import { describe, it, expect } from 'vitest';
import { salesforceDebug, collapseEmail, consentColumns, localNewsUrl, localNewsName, dateCol } from './fields.js';

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
  const consent = new Map([['a@b.c', 'unsubscribed']]);
  it('labels from the Mailchimp map only', () => {
    expect(consentColumns('a@b.c', consent)).toEqual({ 'Email Consent': { label: 'Unsubscribed' } });
    expect(consentColumns('missing@x.y', consent)).toEqual({ 'Email Consent': { label: 'Not in Mailchimp' } });
    expect(consentColumns(null, consent)).toEqual({ 'Email Consent': { label: 'Not in Mailchimp' } });
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
