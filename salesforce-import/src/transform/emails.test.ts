import { describe, it, expect } from 'vitest';
import { assignEmails, parseEmailKindOverrides, type AffiliationRef } from './emails.js';
import { DEFAULT_CONSUMER_DOMAINS } from './emailKind.js';

const consumer = new Set(DEFAULT_CONSUMER_DOMAINS);
const orgDomains = new Map([['org-acme', 'acme.example'], ['org-city', 'sanjoseca.gov']]);
const atAcme: AffiliationRef = { sfId: 'af-acme', orgSfId: 'org-acme', primary: false, status: 'Current' };
const atCity: AffiliationRef = { sfId: 'af-city', orgSfId: 'org-city', primary: true, status: 'Current' };
const none = new Map();

describe('assignEmails', () => {
  it('personal primary + work secondary → work lands on that affiliation, no household', () => {
    const a = assignEmails({ Email: 'ada@gmail.com', Secondary_Email__c: 'Ada@Acme.example' },
      [atAcme, atCity], orgDomains, consumer, none);
    expect(a.personal).toBe('ada@gmail.com');
    expect(a.household).toBeNull();
    expect(a.work.get('af-acme')).toBe('ada@acme.example');
    expect(a.swapped).toBe(false);
    expect(a.review).toEqual([]);
  });
  it('personal primary + consumer secondary → household', () => {
    const a = assignEmails({ Email: 'ada@gmail.com', Secondary_Email__c: 'lovelaces@comcast.net' },
      [atAcme], orgDomains, consumer, none);
    expect(a.household).toBe('lovelaces@comcast.net');
    expect(a.work.size).toBe(0);
    expect(a.review).toEqual([]);
  });
  it('unknown-domain secondary → household plus a review row', () => {
    const a = assignEmails({ Email: 'ada@gmail.com', Secondary_Email__c: 'ada@startup.io' },
      [atAcme], orgDomains, consumer, none);
    expect(a.household).toBe('ada@startup.io');
    expect(a.review).toEqual([{ email: 'ada@startup.io', domain: 'startup.io' }]);
  });
  it('work primary + consumer secondary → swap', () => {
    const a = assignEmails({ Email: 'ada@acme.example', Secondary_Email__c: 'ada@gmail.com' },
      [atAcme], orgDomains, consumer, none);
    expect(a.personal).toBe('ada@gmail.com');
    expect(a.work.get('af-acme')).toBe('ada@acme.example');
    expect(a.household).toBeNull();
    expect(a.swapped).toBe(true);
  });
  it('work primary with no consumer secondary stays personal (only address we have)', () => {
    const a = assignEmails({ Email: 'ada@acme.example' }, [atAcme], orgDomains, consumer, none);
    expect(a.personal).toBe('ada@acme.example');
    expect(a.work.size).toBe(0);
    expect(a.swapped).toBe(false);
  });
  it('a work match prefers the Primary-flagged affiliation', () => {
    const twice: AffiliationRef[] = [
      { sfId: 'af-city-old', orgSfId: 'org-city', primary: false, status: 'Current' },
      { sfId: 'af-city-new', orgSfId: 'org-city', primary: true, status: 'Current' },
    ];
    const a = assignEmails({ Email: 'ada@gmail.com', Secondary_Email__c: 'ada@sanjoseca.gov' },
      twice, orgDomains, consumer, none);
    expect([...a.work.keys()]).toEqual(['af-city-new']);
  });
  it('absent a Primary, a work match prefers a Current tenure over a Former one', () => {
    const twice: AffiliationRef[] = [
      { sfId: 'af-city-former', orgSfId: 'org-city', primary: false, status: 'Former' },
      { sfId: 'af-city-current', orgSfId: 'org-city', primary: false, status: 'Current' },
    ];
    const a = assignEmails({ Email: 'ada@gmail.com', Secondary_Email__c: 'ada@sanjoseca.gov' },
      twice, orgDomains, consumer, none);
    expect([...a.work.keys()]).toEqual(['af-city-current']);
  });
  it('an override wins over domain classification', () => {
    const overrides = parseEmailKindOverrides(
      'email,kind,affiliationSfId\nada@startup.io,work,af-acme\nada@gmail.com,household,\n');
    const a = assignEmails({ Email: 'ada@yahoo.com', Secondary_Email__c: 'ada@startup.io' },
      [atAcme], orgDomains, consumer, overrides);
    expect(a.work.get('af-acme')).toBe('ada@startup.io');
    expect(a.review).toEqual([]);
  });
  it('a household override on the secondary suppresses its review row', () => {
    const overrides = parseEmailKindOverrides('email,kind,affiliationSfId\nfamily@startup.io,household,\n');
    const a = assignEmails({ Email: 'ada@gmail.com', Secondary_Email__c: 'family@startup.io' },
      [atAcme], orgDomains, consumer, overrides);
    expect(a.household).toBe('family@startup.io');
    expect(a.review).toEqual([]);
  });
  it('no addresses at all → everything null, nothing to review', () => {
    const a = assignEmails({}, [atAcme], orgDomains, consumer, none);
    expect(a).toEqual({ personal: null, household: null, work: new Map(), swapped: false, review: [] });
  });
  it('secondary email identical to primary (case differs) → secondary ignored', () => {
    const a = assignEmails({ Email: 'ada@gmail.com', Secondary_Email__c: 'Ada@Gmail.com' },
      [atAcme], orgDomains, consumer, none);
    expect(a.personal).toBe('ada@gmail.com');
    expect(a.household).toBeNull();
    expect(a.work.size).toBe(0);
    expect(a.swapped).toBe(false);
    expect(a.review).toEqual([]);
  });
  it('secondary identical to primary work domain → secondary ignored, primary stays personal', () => {
    const a = assignEmails({ Email: 'ada@acme.example', Secondary_Email__c: 'ADA@acme.example' },
      [atAcme], orgDomains, consumer, none);
    expect(a.personal).toBe('ada@acme.example');
    expect(a.work.size).toBe(0);
    expect(a.household).toBeNull();
    expect(a.swapped).toBe(false);
    expect(a.review).toEqual([]);
  });
});

describe('parseEmailKindOverrides', () => {
  it('lowercases emails, tolerates a blank affiliation, skips bad kinds and blank lines', () => {
    const m = parseEmailKindOverrides(
      'email,kind,affiliationSfId\nA@B.C,work,af1\n\nx@y.z,household,\nbad@k.ind,nonsense,\n');
    expect(m.get('a@b.c')).toEqual({ email: 'a@b.c', kind: 'work', affiliationSfId: 'af1' });
    expect(m.get('x@y.z')).toEqual({ email: 'x@y.z', kind: 'household', affiliationSfId: null });
    expect(m.has('bad@k.ind')).toBe(false);
  });
});
