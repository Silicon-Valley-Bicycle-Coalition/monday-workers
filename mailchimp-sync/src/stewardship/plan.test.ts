import { describe, it, expect } from 'vitest';
import { planStewardship, type StewardshipPerson, type StewardshipPlanOptions } from './plan';

const LABELS = {
  welcomeDayAfter: 'Welcome: day after',
  welcome3Weeks: 'Welcome: 3 weeks',
  renewal3Weeks: 'Renewal: 3 weeks before',
  renewal1Week: 'Renewal: 1 week before',
  renewalDayOf: 'Renewal: day of',
};
const opts: StewardshipPlanOptions = {
  today: '2026-12-01',
  labels: LABELS,
  activeStatusValue: 'Active',
  lifetimeTierValue: 'Lifetime',
  newMemberTypeValue: 'New',
  catchUpDays: 2,
};
const person = (over: Partial<StewardshipPerson> = {}): StewardshipPerson => ({
  itemId: '1',
  email: 'a@x.org',
  label: '',
  membershipStatus: 'Active',
  membershipTier: 'Member',
  memberType: 'Continuing',
  memberSince: '2025-12-22',
  memberUntil: '2026-12-22',
  hasActiveRecurringGift: false,
  doNotSolicit: false,
  ...over,
});
const plan = (people: StewardshipPerson[], o: Partial<StewardshipPlanOptions> = {}) => planStewardship(people, { ...opts, ...o });

describe('renewal stages', () => {
  it('sets each stage on its day: 21, 7 and 0 days before Member Until', () => {
    expect(plan([person({ memberUntil: '2026-12-22' })]).writes).toEqual([{ itemId: '1', email: 'a@x.org', label: LABELS.renewal3Weeks, kind: 'renewal' }]);
    expect(plan([person({ memberUntil: '2026-12-08', label: LABELS.renewal3Weeks })]).writes[0]?.label).toBe(LABELS.renewal1Week);
    expect(plan([person({ memberUntil: '2026-12-01', label: LABELS.renewal1Week })]).writes[0]?.label).toBe(LABELS.renewalDayOf);
  });

  it('catches up a missed day or two, but never sends a stage twice', () => {
    expect(plan([person({ memberUntil: '2026-12-20' })]).writes[0]?.label).toBe(LABELS.renewal3Weeks); // 19 days: 2 late
    expect(plan([person({ memberUntil: '2026-12-19' })]).writes).toEqual([]); // 18 days: too late for 3 weeks, early for 1 week
    expect(plan([person({ memberUntil: '2026-12-22', label: LABELS.renewal3Weeks })]).writes).toEqual([]);
  });

  it('never sends day-of after the date has passed', () => {
    expect(plan([person({ memberUntil: '2026-11-30', label: LABELS.renewal1Week })]).writes).toEqual([]);
  });

  it('does not go backwards to an earlier stage', () => {
    // 6 days out with day-of already set can only be stale data; leave it.
    expect(plan([person({ memberUntil: '2026-12-07', label: LABELS.renewalDayOf })]).writes).toEqual([]);
  });

  it('clears a renewal label once the person renews, so next year starts fresh', () => {
    const p = person({ memberUntil: '2027-12-01', label: LABELS.renewal3Weeks });
    expect(plan([p]).writes).toEqual([{ itemId: '1', email: 'a@x.org', label: '', kind: 'clear' }]);
  });

  it('leaves out lifetime, recurring, Do Not Solicit, inactive and address-less members', () => {
    const due = { memberUntil: '2026-12-22' };
    for (const p of [
      person({ ...due, membershipTier: 'Lifetime' }),
      person({ ...due, hasActiveRecurringGift: true }),
      person({ ...due, doNotSolicit: true }),
      person({ ...due, membershipStatus: 'Lapsed' }),
      person({ ...due, membershipStatus: '' }),
      person({ ...due, email: '' }),
    ]) expect(plan([p]).writes).toEqual([]);
  });
});

describe('welcome emails', () => {
  const fresh = { memberType: 'New', memberSince: '2026-11-30', memberUntil: '2027-11-30' };

  it('sends the first the day after Member Since and the second three weeks after', () => {
    expect(plan([person(fresh)]).writes[0]).toMatchObject({ label: LABELS.welcomeDayAfter, kind: 'welcome' });
    const later = person({ ...fresh, memberSince: '2026-11-10', label: LABELS.welcomeDayAfter });
    expect(plan([later]).writes[0]).toMatchObject({ label: LABELS.welcome3Weeks, kind: 'welcome' });
  });

  it('catches up a missed day, and never repeats', () => {
    expect(plan([person({ ...fresh, memberSince: '2026-11-28' })]).writes[0]?.label).toBe(LABELS.welcomeDayAfter);
    expect(plan([person({ ...fresh, memberSince: '2026-11-27' })]).writes).toEqual([]);
    expect(plan([person({ ...fresh, label: LABELS.welcomeDayAfter })]).writes).toEqual([]);
  });

  it('skips the second when the first never went (joined before launch)', () => {
    expect(plan([person({ ...fresh, memberSince: '2026-11-10' })]).writes).toEqual([]);
  });

  it('is for new members only, and respects Do Not Solicit', () => {
    expect(plan([person({ ...fresh, memberType: 'Continuing' })]).writes).toEqual([]);
    expect(plan([person({ ...fresh, memberType: 'Lapsed renewal' })]).writes).toEqual([]);
    expect(plan([person({ ...fresh, doNotSolicit: true })]).writes).toEqual([]);
  });

  it('welcomes a lifetime or recurring new member too', () => {
    expect(plan([person({ ...fresh, membershipTier: 'Lifetime', memberUntil: '' })]).writes[0]?.label).toBe(LABELS.welcomeDayAfter);
    expect(plan([person({ ...fresh, hasActiveRecurringGift: true })]).writes[0]?.label).toBe(LABELS.welcomeDayAfter);
  });
});
