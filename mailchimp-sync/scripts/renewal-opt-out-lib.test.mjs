import { describe, it, expect } from 'vitest';
import { memberId } from '../src/logSafe';
import { emailsFromCsv, optOutEmails, planMember, subscriberHash, summarize } from './renewal-opt-out-lib.mjs';

describe('subscriberHash', () => {
  it('is the Worker memberId: MD5 of the trimmed, lower-cased address', () => {
    expect(subscriberHash(' A@Example.org ')).toBe(memberId('a@example.org'));
  });
});

describe('optOutEmails', () => {
  it('collects every email field, de-duplicated, and counts contacts with none', () => {
    const r = optOutEmails([
      { Email: 'A@x.org', npe01__HomeEmail__c: 'a@x.org', npe01__WorkEmail__c: 'w@x.org' },
      { Email: null, Email_4__c: 'four@x.org' },
      { Email: '' },
      { Email: 'not-an-address' },
    ]);
    expect(r).toEqual({ emails: ['a@x.org', 'four@x.org', 'w@x.org'], contacts: 4, withoutEmail: 2 });
  });
});

describe('emailsFromCsv', () => {
  it('reads the Email column regardless of case and quotes', () => {
    expect(emailsFromCsv('"Id","Email"\r\n1,"B@x.org"\n2,\n').emails).toEqual(['b@x.org']);
  });
  it('refuses a file with no Email column', () => {
    expect(() => emailsFromCsv('Id,Name\n1,x')).toThrow(/no "Email" column/);
  });
});

describe('planMember', () => {
  it('never plans a write for an address outside the audience', () => {
    expect(planMember(null, { tag: 't', interestId: 'i' })).toEqual({ kind: 'not-in-audience' });
  });
  it('adds a missing tag and clears an interest that is on', () => {
    const m = { status: 'subscribed', tags: [{ name: 'other' }], interests: { i: true, j: true } };
    expect(planMember(m, { tag: 't', interestId: 'i' })).toEqual({ kind: 'member', status: 'subscribed', addTag: true, clearInterest: true });
  });
  it('is a no-op when already tagged and the interest is off', () => {
    const m = { status: 'unsubscribed', tags: [{ name: 't' }], interests: { i: false } };
    expect(planMember(m, { tag: 't', interestId: 'i' })).toEqual({ kind: 'member', status: 'unsubscribed', addTag: false, clearInterest: false });
  });
  it('leaves interests alone when no interest is given', () => {
    const m = { status: 'subscribed', tags: [], interests: { i: true } };
    expect(planMember(m, { tag: 't' }).clearInterest).toBe(false);
  });
});

describe('summarize', () => {
  it('counts outcomes', () => {
    expect(summarize([
      { kind: 'not-in-audience' },
      { kind: 'member', status: 'subscribed', addTag: true, clearInterest: true },
      { kind: 'member', status: 'subscribed', addTag: false, clearInterest: false },
    ])).toEqual({ total: 3, notInAudience: 1, byStatus: { subscribed: 2 }, addTag: 1, clearInterest: 1, nothingToDo: 1 });
  });
});
