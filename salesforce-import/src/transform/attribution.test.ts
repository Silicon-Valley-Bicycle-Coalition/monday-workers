import { describe, it, expect } from 'vitest';
import { AffiliationIndex, attributeOpportunity, attributeRegistration, attributionColumns,
  attributionRollups, type AffiliationEntry } from './attribution.js';

const entries: AffiliationEntry[] = [
  { sfId: 'af-old', contactSfId: 'c1', orgSfId: 'org-acme', startISO: '2015-01-01', endISO: '2018-12-31', primary: false, workEmail: null },
  { sfId: 'af-new', contactSfId: 'c1', orgSfId: 'org-acme', startISO: '2019-01-01', endISO: null, primary: true, workEmail: 'ada@acme.example' },
  { sfId: 'af-city', contactSfId: 'c2', orgSfId: 'org-city', startISO: null, endISO: null, primary: true, workEmail: 'bo@sanjoseca.gov' },
];
const index = new AffiliationIndex(entries);
const orgs = new Set(['org-acme', 'org-city']);

describe('attributeOpportunity', () => {
  it('attributes an org gift with a primary contact to the tenure bracketing its close date', () => {
    expect(attributeOpportunity({ AccountId: 'org-acme', npsp__Primary_Contact__c: 'c1', CloseDate: '2017-05-05' }, index, orgs))
      .toEqual({ affiliationSfId: 'af-old' });
    expect(attributeOpportunity({ AccountId: 'org-acme', npsp__Primary_Contact__c: 'c1', CloseDate: '2024-05-05' }, index, orgs))
      .toEqual({ affiliationSfId: 'af-new' });
  });
  it('reports an org gift whose contact has no affiliation there', () => {
    expect(attributeOpportunity({ AccountId: 'org-city', npsp__Primary_Contact__c: 'c1', CloseDate: '2024-01-01' }, index, orgs))
      .toEqual({ unaffiliated: { contactSfId: 'c1', orgSfId: 'org-city' } });
  });
  it('is null for individual gifts, org gifts with no contact, and Funraise-only donors', () => {
    expect(attributeOpportunity({ AccountId: 'a-household', npsp__Primary_Contact__c: 'c1' }, index, orgs)).toBeNull();
    expect(attributeOpportunity({ AccountId: 'org-acme' }, index, orgs)).toBeNull();
    expect(attributeOpportunity({ AccountId: 'org-acme', funraise__fr_Donor__c: 'c1' }, index, orgs)).toBeNull();
  });
});

describe('attributeRegistration', () => {
  it('matches the registration email against work addresses, case-insensitively, Auto when the registrant matches', () => {
    expect(attributeRegistration({ funraise__Email__c: 'Bo@SanJoseCA.gov', funraise__Registrant__c: 'c2' }, index))
      .toEqual({ affiliationSfId: 'af-city', attribution: 'Auto' });
  });
  it('defaults to Auto when no registrant is set', () => {
    expect(attributeRegistration({ funraise__Email__c: 'Bo@SanJoseCA.gov' }, index))
      .toEqual({ affiliationSfId: 'af-city', attribution: 'Auto' });
  });
  it('is Needs review when the registrant differs from the matched affiliation\'s contact', () => {
    expect(attributeRegistration({ funraise__Email__c: 'Bo@SanJoseCA.gov', funraise__Registrant__c: 'c-other' }, index))
      .toEqual({ affiliationSfId: 'af-city', attribution: 'Needs review' });
  });
  it('is null for a personal or unknown address', () => {
    expect(attributeRegistration({ funraise__Email__c: 'bo@gmail.com' }, index)).toBeNull();
    expect(attributeRegistration({}, index)).toBeNull();
  });
  it('normalizes work email on insertion to match lookup normalization', () => {
    const mixed = new AffiliationIndex([
      { sfId: 'af-mixed', contactSfId: 'c3', orgSfId: 'org-test', startISO: null, endISO: null, primary: true, workEmail: ' Bo@SanJoseCA.gov ' }
    ]);
    expect(mixed.byWorkEmail('bo@sanjoseca.gov')?.sfId).toBe('af-mixed');
    expect(attributeRegistration({ funraise__Email__c: 'BO@sanjoseca.gov' }, mixed))
      .toEqual({ affiliationSfId: 'af-mixed', attribution: 'Auto' });
  });
});

describe('attributionColumns', () => {
  it('writes Auto plus the Acting for link when attributed, None otherwise', () => {
    expect(attributionColumns('af-new')).toEqual({
      columns: { 'Attribution': { label: 'Auto' } },
      links: [{ column: 'Acting for', targetSfIds: ['af-new'] }] });
    expect(attributionColumns(null)).toEqual({ columns: { 'Attribution': { label: 'None' } }, links: [] });
  });
  it('writes the given label when passed one explicitly', () => {
    expect(attributionColumns('af-new', 'Needs review')).toEqual({
      columns: { 'Attribution': { label: 'Needs review' } },
      links: [{ column: 'Acting for', targetSfIds: ['af-new'] }] });
  });
});

describe('attributionRollups', () => {
  const opps = [
    { Id: 'o1', StageName: 'Posted', Amount: 100, CloseDate: '2017-01-01' },
    { Id: 'o2', StageName: 'Posted', Amount: 250.5, CloseDate: '2024-03-03' },
    { Id: 'o3', StageName: 'Closed Won', Amount: 999, CloseDate: '2024-04-04' },   // not Posted → ignored
    { Id: 'o4', StageName: 'Posted', Amount: 40, CloseDate: '2023-01-01' },
  ];
  const attributed = new Map([['o1', 'af-old'], ['o2', 'af-new'], ['o3', 'af-new'], ['o4', 'af-city']]);
  it('sums Posted gifts per affiliation and per contact across their affiliations', () => {
    const r = attributionRollups(opps, attributed, index);
    expect(r.byAffiliation.get('af-old')).toEqual({ giving: 100, giftCount: 1, lastGiftISO: '2017-01-01' });
    expect(r.byAffiliation.get('af-new')).toEqual({ giving: 250.5, giftCount: 1, lastGiftISO: '2024-03-03' });
    expect(r.byAffiliation.get('af-city')).toEqual({ giving: 40, giftCount: 1, lastGiftISO: '2023-01-01' });
    expect(r.organizationalGivingByContact.get('c1')).toBe(350.5);
    expect(r.organizationalGivingByContact.get('c2')).toBe(40);
  });
});
