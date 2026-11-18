import { describe, it, expect } from 'vitest';
import { daysUntil, planRenewalDue, todayIn, type RenewalMember } from './plan';

const opts = { activeTag: 'active-member', dueTag: 'renewal-due', untilField: 'MEMBUNTIL', daysBefore: 28, today: '2026-11-17' };
const m = (email: string, until: string, tags: string[]): RenewalMember => ({ email_address: email, status: 'subscribed', merge_fields: { MEMBUNTIL: until }, tags: tags.map((name) => ({ name })) });

describe('daysUntil', () => {
  it('counts whole days, including across a DST change, and rejects anything but YYYY-MM-DD', () => {
    expect(daysUntil('2026-12-15', '2026-11-17')).toBe(28);
    expect(daysUntil('2026-11-01', '2026-10-31')).toBe(1);
    expect(daysUntil('2026-11-16', '2026-11-17')).toBe(-1);
    expect(Number.isNaN(daysUntil('', '2026-11-17'))).toBe(true);
    expect(Number.isNaN(daysUntil('12/15/2026', '2026-11-17'))).toBe(true);
  });
});

describe('todayIn', () => {
  it('uses the calendar date in the given time zone', () => {
    // 06:00 UTC on the 18th is still the 17th in California.
    expect(todayIn('America/Los_Angeles', new Date('2026-11-18T06:00:00Z'))).toBe('2026-11-17');
  });
});

describe('planRenewalDue', () => {
  it('tags active members due within the window, today and day 28 included', () => {
    const plan = planRenewalDue([
      m('today@x.org', '2026-11-17', ['active-member']),
      m('edge@x.org', '2026-12-15', ['active-member']),
      m('later@x.org', '2026-12-16', ['active-member']),
      m('multiyear@x.org', '2027-12-01', ['active-member']),
    ], opts);
    expect(plan).toEqual({ add: ['today@x.org', 'edge@x.org'], remove: [], due: 2 });
  });

  it('removes the tag from anyone no longer due: renewed, lapsed, past or without a date', () => {
    const plan = planRenewalDue([
      m('renewed@x.org', '2027-11-20', ['active-member', 'renewal-due']),
      m('lapsed@x.org', '2026-11-20', ['lapsed-member', 'renewal-due']),
      m('past@x.org', '2026-11-16', ['active-member', 'renewal-due']),
      m('nodate@x.org', '', ['active-member', 'renewal-due']),
      m('still@x.org', '2026-11-30', ['active-member', 'renewal-due']),
    ], opts);
    expect(plan).toEqual({ add: [], remove: ['renewed@x.org', 'lapsed@x.org', 'past@x.org', 'nodate@x.org'], due: 1 });
  });

  it('never tags a lifetime or lapsed member, whatever the date', () => {
    expect(planRenewalDue([m('life@x.org', '2026-11-20', ['lifetime-member']), m('l@x.org', '2026-11-20', ['lapsed-member'])], opts).add).toEqual([]);
  });
});
