import { describe, it, expect } from 'vitest';
import {
  addMonths, isEligibleGift, deriveMembership, mergeWithBoard, statusFor, tierFromLabel,
  membershipColumnValues, termColumnValues, EMPTY_STATE,
  type MembershipGift, type MembershipState,
} from './derive';
import type { MembershipConfig } from '../types';

const config: MembershipConfig = {
  fromISO: '2026-10-01', eligibleGiftTypes: ['Donation'], termMonths: 12, lifetimeThresholdCents: 100000,
  statusLabels: { active: 'Active', lapsed: 'Lapsed' },
  tierLabels: { member: 'Member', lifetime: 'Lifetime' },
  typeLabels: { new: 'New', renewal: 'Renewal', reacquire: 'Reacquire', lifetime: 'Lifetime' },
};
const RECEIVED = 'Received';
const gift = (over: Partial<MembershipGift>): MembershipGift => ({
  id: 'g1', dateISO: '2026-11-05', amountCents: 5000, status: RECEIVED, giftType: 'Donation', ...over,
});
const member = (since: string, until: string | null, tier: MembershipState['tier'] = 'member'): MembershipState =>
  ({ since, until, tier });

describe('addMonths', () => {
  it('adds a year to an ordinary date', () => expect(addMonths('2026-11-05', 12)).toBe('2027-11-05'));
  it('rolls Feb 29 to Mar 1 like the Salesforce flow', () => expect(addMonths('2028-02-29', 12)).toBe('2029-03-01'));
  it('keeps Feb 29 when the target year is a leap year', () => expect(addMonths('2024-02-29', 48)).toBe('2028-02-29'));
  it('clamps other month-end overflow to the 1st of the next month', () => expect(addMonths('2026-01-31', 1)).toBe('2026-03-01'));
});

describe('isEligibleGift', () => {
  it('accepts a Received Donation on/after fromISO', () => {
    expect(isEligibleGift(gift({ dateISO: '2026-10-01' }), config, RECEIVED)).toBe(true);
  });
  it.each([
    ['status', gift({ status: 'Received (Historical)' })],
    ['gift type', gift({ giftType: 'Matching Donation' })],
    ['null gift type', gift({ giftType: null })],
    ['date before cutover', gift({ dateISO: '2026-09-30' })],
    ['empty date', gift({ dateISO: '' })],
  ])('rejects on %s', (_label, g) => expect(isEligibleGift(g, config, RECEIVED)).toBe(false));
});

describe('deriveMembership', () => {
  it('a never-member gets a New one-year term and a Member tier', () => {
    const d = deriveMembership(EMPTY_STATE, [gift({})], config, RECEIVED);
    expect(d.state).toEqual({ since: '2026-11-05', until: '2027-11-05', tier: 'member' });
    expect(d.terms.get('g1')).toEqual({ start: '2026-11-05', end: '2027-11-05', type: 'new' });
  });

  it('a migrated Active member renewing early gets Renewal and Until extends from the gift date', () => {
    const d = deriveMembership(member('2017-05-18', '2027-04-11'), [gift({})], config, RECEIVED);
    expect(d.state).toEqual({ since: '2017-05-18', until: '2027-11-05', tier: 'member' });
    expect(d.terms.get('g1')!.type).toBe('renewal');
  });

  it('a Lapsed member (Until before the gift) gets Reacquire', () => {
    const d = deriveMembership(member('2015-01-01', '2026-03-01'), [gift({})], config, RECEIVED);
    expect(d.terms.get('g1')!.type).toBe('reacquire');
    expect(d.state.until).toBe('2027-11-05');
  });

  it('Until on the gift date itself still counts as Renewal (not yet lapsed)', () => {
    const d = deriveMembership(member('2015-01-01', '2026-11-05'), [gift({})], config, RECEIVED);
    expect(d.terms.get('g1')!.type).toBe('renewal');
  });

  it('a gift at exactly the lifetime threshold makes a Lifetime term with blank end and blank Until', () => {
    const d = deriveMembership(member('2015-01-01', '2026-03-01'), [gift({ amountCents: 100000 })], config, RECEIVED);
    expect(d.terms.get('g1')).toEqual({ start: '2026-11-05', end: null, type: 'lifetime' });
    expect(d.state).toEqual({ since: '2015-01-01', until: null, tier: 'lifetime' });
  });

  it('a later gift from a Lifetime owner produces no term and changes nothing', () => {
    const d = deriveMembership(member('2015-01-01', null, 'lifetime'), [gift({})], config, RECEIVED);
    expect(d.terms.size).toBe(0);
    expect(d.state).toEqual({ since: '2015-01-01', until: null, tier: 'lifetime' });
  });

  it('folds in date order regardless of input order, tie-breaking by id', () => {
    const gifts = [
      gift({ id: 'later', dateISO: '2027-12-01' }),
      gift({ id: 'b', dateISO: '2026-11-05' }),
      gift({ id: 'a', dateISO: '2026-11-05' }),
    ];
    const d = deriveMembership(EMPTY_STATE, gifts, config, RECEIVED);
    expect(d.terms.get('a')!.type).toBe('new');
    expect(d.terms.get('b')!.type).toBe('renewal');
    expect(d.terms.get('later')!.type).toBe('renewal');
    expect(d.state.until).toBe('2028-12-01');
  });

  it('ignores ineligible gifts entirely', () => {
    const gifts = [gift({ id: 'failed', status: 'Failed' }), gift({ id: 'old', dateISO: '2020-01-01' }),
      gift({ id: 'match', giftType: 'Matching Donation' })];
    const d = deriveMembership(EMPTY_STATE, gifts, config, RECEIVED);
    expect(d.terms.size).toBe(0);
    expect(d.state).toEqual(EMPTY_STATE);
  });

  it('is idempotent: the same inputs yield the same output', () => {
    const gifts = [gift({ id: 'a', dateISO: '2026-11-05' }), gift({ id: 'b', dateISO: '2027-06-01' })];
    const once = deriveMembership(member('2015-01-01', '2026-03-01'), gifts, config, RECEIVED);
    const twice = deriveMembership(member('2015-01-01', '2026-03-01'), gifts, config, RECEIVED);
    expect(twice).toEqual(once);
  });
});

describe('mergeWithBoard (extend-only)', () => {
  it('takes the earlier Since and the later Until', () => {
    expect(mergeWithBoard(member('2020-01-01', '2027-11-05'), member('2015-01-01', '2028-01-01')))
      .toEqual({ since: '2015-01-01', until: '2028-01-01', tier: 'member' });
  });
  it('Lifetime on either side wins and blanks Until', () => {
    expect(mergeWithBoard(member('2020-01-01', '2027-11-05'), member('2015-01-01', null, 'lifetime')))
      .toEqual({ since: '2015-01-01', until: null, tier: 'lifetime' });
    expect(mergeWithBoard(member('2020-01-01', null, 'lifetime'), member('2015-01-01', '2028-01-01')))
      .toEqual({ since: '2015-01-01', until: null, tier: 'lifetime' });
  });
  it('an empty derived state leaves the board state unchanged', () => {
    expect(mergeWithBoard(EMPTY_STATE, member('2015-01-01', '2026-03-01'))).toEqual(member('2015-01-01', '2026-03-01'));
  });
  it('both empty stays empty', () => expect(mergeWithBoard(EMPTY_STATE, EMPTY_STATE)).toEqual(EMPTY_STATE));
});

describe('statusFor', () => {
  it('Lifetime is always active', () => expect(statusFor(member('2015-01-01', null, 'lifetime'), '2099-01-01')).toBe('active'));
  it('Until today or later is active; earlier is lapsed', () => {
    expect(statusFor(member('2015-01-01', '2026-11-05'), '2026-11-05')).toBe('active');
    expect(statusFor(member('2015-01-01', '2026-11-04'), '2026-11-05')).toBe('lapsed');
  });
  it('a member with no Until and no Lifetime is lapsed; a never-member is null', () => {
    expect(statusFor({ since: '2015-01-01', until: null, tier: 'member' }, '2026-11-05')).toBe('lapsed');
    expect(statusFor(EMPTY_STATE, '2026-11-05')).toBeNull();
  });
});

describe('tierFromLabel', () => {
  it('maps the configured labels and treats any other non-empty label as member', () => {
    expect(tierFromLabel('Lifetime', config)).toBe('lifetime');
    expect(tierFromLabel('Member', config)).toBe('member');
    expect(tierFromLabel('Family', config)).toBe('member');
    expect(tierFromLabel('', config)).toBeNull();
    expect(tierFromLabel(null, config)).toBeNull();
  });
});

describe('membershipColumnValues (changed keys only)', () => {
  const columns = { status: 'ms', tier: 'mt', since: 'msince', until: 'muntil' };
  it('writes every column for a never-member becoming New', () => {
    const board = { since: null, until: null, tier: null, statusLabel: null };
    expect(membershipColumnValues(member('2026-11-05', '2027-11-05'), 'active', board, columns, config)).toEqual({
      ms: { label: 'Active' }, mt: { label: 'Member' }, msince: { date: '2026-11-05' }, muntil: { date: '2027-11-05' },
    });
  });
  it('writes only Until and Status for a lapsed member renewing', () => {
    const board = { since: '2015-01-01', until: '2026-03-01', tier: 'member' as const, statusLabel: 'Lapsed' };
    expect(membershipColumnValues(member('2015-01-01', '2027-11-05'), 'active', board, columns, config)).toEqual({
      ms: { label: 'Active' }, muntil: { date: '2027-11-05' },
    });
  });
  it('writes nothing when the board already matches', () => {
    const board = { since: '2015-01-01', until: '2027-11-05', tier: 'member' as const, statusLabel: 'Active' };
    expect(membershipColumnValues(member('2015-01-01', '2027-11-05'), 'active', board, columns, config)).toEqual({});
  });
  it('clears Until (null) when the owner becomes Lifetime', () => {
    const board = { since: '2015-01-01', until: '2027-11-05', tier: 'member' as const, statusLabel: 'Active' };
    expect(membershipColumnValues(member('2015-01-01', null, 'lifetime'), 'active', board, columns, config)).toEqual({
      mt: { label: 'Lifetime' }, muntil: null,
    });
  });
  it('writes nothing at all for a never-member with no gifts (status null)', () => {
    const board = { since: null, until: null, tier: null, statusLabel: null };
    expect(membershipColumnValues(EMPTY_STATE, null, board, columns, config)).toEqual({});
  });
});

describe('termColumnValues (changed keys only)', () => {
  const columns = { termStart: 'ts', termEnd: 'te', membershipType: 'mty' };
  const blank = { termStart: null, termEnd: null, membershipType: null };
  it('writes all three on a fresh gift', () => {
    expect(termColumnValues({ start: '2026-11-05', end: '2027-11-05', type: 'renewal' }, blank, columns, config))
      .toEqual({ ts: { date: '2026-11-05' }, te: { date: '2027-11-05' }, mty: 'Renewal' });
  });
  it('writes nothing when the item already matches', () => {
    const current = { termStart: '2026-11-05', termEnd: '2027-11-05', membershipType: 'Renewal' };
    expect(termColumnValues({ start: '2026-11-05', end: '2027-11-05', type: 'renewal' }, current, columns, config)).toEqual({});
  });
  it('a Lifetime term writes a blank end', () => {
    expect(termColumnValues({ start: '2026-11-05', end: null, type: 'lifetime' }, blank, columns, config))
      .toEqual({ ts: { date: '2026-11-05' }, mty: 'Lifetime' });
  });
  it('an ineligible gift (no term) is never touched, even if it carries stale values', () => {
    const current = { termStart: '2020-01-01', termEnd: '2021-01-01', membershipType: 'Renewal' };
    expect(termColumnValues(undefined, current, columns, config)).toEqual({});
  });
});
