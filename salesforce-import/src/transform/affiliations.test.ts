import { describe, it, expect } from 'vitest';
import { affiliationToPayload, affiliationStatus, pickAffiliation } from './affiliations.js';

const prov = { CreatedDate: '2020-01-01T00:00:00Z', CreatedBy: { Name: 'X' },
  LastModifiedDate: '2021-01-01T00:00:00Z', LastModifiedBy: { Name: 'Y' } };

describe('affiliationStatus', () => {
  it('is Former only when Salesforce says so; blank means Current (NPSP default)', () => {
    expect(affiliationStatus('Former')).toBe('Former');
    expect(affiliationStatus('Current')).toBe('Current');
    expect(affiliationStatus(null)).toBe('Current');
    expect(affiliationStatus(undefined)).toBe('Current');
  });
});

describe('affiliationToPayload', () => {
  const a = { Id: 'af1', npe5__Contact__c: 'c1', npe5__Organization__c: 'org-acme', npe5__Role__c: 'Sustainability Lead',
    npe5__Status__c: 'Current', npe5__StartDate__c: '2019-03-01', npe5__EndDate__c: null, npe5__Primary__c: true, ...prov };
  it('builds the full column set with both links and the work address consent', () => {
    const p = affiliationToPayload(a, { personName: 'Ada Lovelace', orgName: 'Acme',
      workEmail: 'ada@acme.example', consent: new Map([['ada@acme.example', 'subscribed']]) });
    expect(p.board).toBe('affiliations');
    expect(p.sfId).toBe('af1');
    expect(p.name).toBe('Ada Lovelace @ Acme');
    expect(p.columns['Role']).toBe('Sustainability Lead');
    expect(p.columns['Status']).toEqual({ label: 'Current' });
    expect(p.columns['Start']).toEqual({ date: '2019-03-01' });
    expect(p.columns['End']).toBeNull();
    expect(p.columns['Primary']).toEqual({ checked: 'true' });
    expect(p.columns['Work Email']).toEqual({ email: 'ada@acme.example', text: 'ada@acme.example' });
    expect(p.columns['Work Email Consent']).toEqual({ label: 'Subscribed' });
    expect(p.columns['Salesforce Debug']).toEqual({ text: expect.stringContaining('SF ID: af1') });
    expect(p.links).toEqual([
      { column: 'Person', targetSfIds: ['c1'] },
      { column: 'Organization', targetSfIds: ['org-acme'] },
    ]);
  });
  it('omits Work Email and its consent when the tenure has no work address', () => {
    const p = affiliationToPayload({ ...a, npe5__Primary__c: false }, { personName: 'Ada', orgName: 'Acme', workEmail: null, consent: new Map() });
    expect(p.columns['Work Email']).toBeNull();
    expect('Work Email Consent' in p.columns).toBe(false);
    expect(p.columns['Primary']).toBeNull();
  });
});

describe('pickAffiliation', () => {
  const old = { sfId: 'old', startISO: '2015-01-01', endISO: '2018-12-31', primary: false };
  const now = { sfId: 'now', startISO: '2019-01-01', endISO: null, primary: true };
  const undated = { sfId: 'undated', startISO: null, endISO: null, primary: false };
  it('prefers the tenure whose dates bracket the event', () => {
    expect(pickAffiliation([now, old], '2016-06-01')?.sfId).toBe('old');
    expect(pickAffiliation([old, now], '2022-06-01')?.sfId).toBe('now');
  });
  it('falls back to Primary, then first, when no tenure brackets the date or the date is unknown', () => {
    expect(pickAffiliation([old, now], '2000-01-01')?.sfId).toBe('now');
    expect(pickAffiliation([old, undated], null)?.sfId).toBe('old');
    expect(pickAffiliation([undated], '2022-06-01')?.sfId).toBe('undated');   // open-ended tenure brackets everything
  });
  it('is null for no candidates', () => {
    expect(pickAffiliation([], '2022-01-01')).toBeNull();
  });
});
