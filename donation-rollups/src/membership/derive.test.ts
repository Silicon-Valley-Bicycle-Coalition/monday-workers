import { describe, it, expect } from 'vitest';
import {
  addMonths, isQualifyingGift, activitiesFor, buildRuns, memberTypeFor, deriveMembership, mergeWithBoard,
  statusFor, membershipColumnValues, termColumnValues,
  type MembershipGift, type OwnerMembershipState, type BoardMembership,
} from './derive';
import type { MembershipConfig } from '../types';
import type { VolunteerActivityRow } from '../db/volunteerActivity';

const config: MembershipConfig = {
  fromISO: '2026-10-16', eligibleGiftTypes: ['Donation'], minAmountCents: 100, termMonths: 13, lifetimeThresholdCents: 100000,
  statusLabels: { active: 'Active', lapsed: 'Lapsed' },
  tierLabels: { member: 'Member', lifetime: 'Lifetime' },
  typeLabels: { new: 'New', continuing: 'Continuing', lapsedRenewal: 'Lapsed renewal', lifetime: 'Lifetime' },
};
const RECEIVED = 'Received';
const gift = (over: Partial<MembershipGift>): MembershipGift => ({
  id: 'g1', dateISO: '2026-11-03', amountCents: 2500, status: RECEIVED, giftType: 'Donation', termStart: null, ...over,
});
const checkin = (over: Partial<VolunteerActivityRow>): VolunteerActivityRow => ({
  registrationItemId: 'r1', boardId: 'er', ownerItemId: 'p1', ownerBoardId: 'people',
  activityDateISO: '2027-03-14', hours: null, qualifies: true, source: 'webhook', ...over,
});
const COLS = { status: 'ms', tier: 'mt', since: 'msince', until: 'muntil', currentTermStart: 'mcts', memberType: 'mtype', lapseCount: 'mlc', lastLapsed: 'mll' };
const blankBoard: BoardMembership = { statusLabel: null, tierLabel: null, since: null, until: null, currentTermStart: null, memberTypeLabel: null, lapseCount: null, lastLapsed: null };

describe('addMonths', () => {
  it('adds 13 months', () => expect(addMonths('2026-11-03', 13)).toBe('2027-12-03'));
  it('rolls Feb 29 forward', () => expect(addMonths('2028-02-29', 12)).toBe('2029-03-01'));
  it('clamps month-end overflow to the 1st of the next month', () => expect(addMonths('2026-01-31', 1)).toBe('2026-03-01'));
});

describe('isQualifyingGift', () => {
  it('accepts a Received Donation of $1.00 or more on any date', () => {
    expect(isQualifyingGift(gift({ amountCents: 100 }), config, RECEIVED)).toBe(true);
    expect(isQualifyingGift(gift({ dateISO: '2015-01-01' }), config, RECEIVED)).toBe(true);
  });
  it.each([
    ['$0.99', gift({ amountCents: 99 })], ['Matching Donation', gift({ giftType: 'Matching Donation' })],
    ['null type', gift({ giftType: null })], ['Pending', gift({ status: 'Pending' })],
    ['Received (Historical)', gift({ status: 'Received (Historical)' })], ['no date', gift({ dateISO: '' })],
  ])('rejects %s', (_l, g) => expect(isQualifyingGift(g, config, RECEIVED)).toBe(false));
});

describe('activitiesFor', () => {
  it('a qualifying gift is a gift activity; a pre-cutover $0 gift with a Term Start is a migrated term; a blank Term Start is nothing', () => {
    const acts = activitiesFor([
      gift({ id: 'a', dateISO: '2026-11-03' }),
      gift({ id: 'b', dateISO: '2019-05-01', amountCents: 0, termStart: '2019-05-01' }),
      gift({ id: 'c', dateISO: '2019-06-01', amountCents: 0, termStart: '' }),
      gift({ id: 'd', dateISO: '2026-11-20', amountCents: 0, termStart: '2026-11-20' }),   // post-cutover: amount rule only
    ], [], config, RECEIVED);
    expect(acts).toEqual([
      { id: 'b', kind: 'migrated-term', dateISO: '2019-05-01', lifetime: false },
      { id: 'a', kind: 'gift', dateISO: '2026-11-03', lifetime: false },
    ]);
  });
  it('a qualifying check-in is a volunteer activity on the event date; non-qualifying or undated rows are skipped', () => {
    expect(activitiesFor([], [checkin({}), checkin({ registrationItemId: 'r2', qualifies: false }), checkin({ registrationItemId: 'r3', activityDateISO: null })], config, RECEIVED))
      .toEqual([{ id: 'r1', kind: 'volunteer', dateISO: '2027-03-14', lifetime: false }]);
  });
  it('a $1,000 gift is a lifetime activity', () => {
    expect(activitiesFor([gift({ amountCents: 100000 })], [], config, RECEIVED)[0]!.lifetime).toBe(true);
  });
  it('same-day gift and check-in sort stably: by date, then kind, then id (Review Focus 4)', () => {
    const a = activitiesFor([gift({ id: 'g9', dateISO: '2027-03-14' })], [checkin({ registrationItemId: 'r1' })], config, RECEIVED);
    const b = activitiesFor([gift({ id: 'g9', dateISO: '2027-03-14' })], [checkin({ registrationItemId: 'r1' })], config, RECEIVED);
    expect(a.map((x) => x.id)).toEqual(['g9', 'r1']);
    expect(b).toEqual(a);
  });
});

describe('buildRuns', () => {
  const act = (id: string, dateISO: string) => ({ id, kind: 'gift' as const, dateISO, lifetime: false });
  it('one activity is one run ending 13 months later', () => {
    expect(buildRuns([act('a', '2026-11-03')], 13)).toEqual([{ start: '2026-11-03', end: '2027-12-03', activities: 1 }]);
  });
  it('an activity on the previous run end extends it; one the day after starts a new run', () => {
    expect(buildRuns([act('a', '2026-11-03'), act('b', '2027-12-03')], 13))
      .toEqual([{ start: '2026-11-03', end: '2029-01-03', activities: 2 }]);
    expect(buildRuns([act('a', '2026-11-03'), act('b', '2027-12-04')], 13))
      .toEqual([{ start: '2026-11-03', end: '2027-12-03', activities: 1 }, { start: '2027-12-04', end: '2029-01-04', activities: 1 }]);
  });
});

describe('memberTypeFor', () => {
  const run = { start: '2026-11-03', end: '2027-12-03', activities: 1 };
  it('New before the anniversary with no earlier run; Lapsed renewal with one', () => {
    expect(memberTypeFor(run, 0, '2027-06-01', 13)).toBe('new');
    expect(memberTypeFor(run, 1, '2027-06-01', 13)).toBe('lapsedRenewal');
  });
  it('a one-activity run on its anniversary day is still New, not Continuing (Review Focus 5)', () => {
    expect(memberTypeFor(run, 0, '2027-12-03', 13)).toBe('new');
  });
  it('Continuing once past the anniversary with a later re-qualification', () => {
    expect(memberTypeFor({ ...run, end: '2028-07-10', activities: 2 }, 0, '2027-12-03', 13)).toBe('continuing');
    expect(memberTypeFor({ ...run, end: '2028-07-10', activities: 2 }, 0, '2027-12-02', 13)).toBe('new');
  });
});

describe('deriveMembership — the docs/28 worked examples', () => {
  it('first-ever gift, nothing after', () => {
    const d = deriveMembership([gift({})], [], config, RECEIVED, '2026-11-06');
    expect(d.state).toEqual({ since: '2026-11-03', currentTermStart: '2026-11-03', until: '2027-12-03', tier: 'member', lapseCount: 0, lastLapsed: null, memberType: 'new' });
    expect(d.terms.get('g1')).toEqual({ start: '2026-11-03', end: '2027-12-03', type: 'new' });
  });
  it('a second gift inside the run: Since unchanged, Until extends, New until the anniversary, then Continuing; the gift stamps Continuing', () => {
    const gifts = [gift({}), gift({ id: 'g2', dateISO: '2027-06-10' })];
    expect(deriveMembership(gifts, [], config, RECEIVED, '2027-06-11').state).toMatchObject({ since: '2026-11-03', until: '2028-07-10', memberType: 'new' });
    expect(deriveMembership(gifts, [], config, RECEIVED, '2027-12-03').state).toMatchObject({ memberType: 'continuing' });
    expect(deriveMembership(gifts, [], config, RECEIVED, '2027-06-11').terms.get('g2')!.type).toBe('continuing');
  });
  it('lapsed since 2024, back in 2026: Member Since stays 2019, Current Term Start is the return, one lapse, Lapsed renewal', () => {
    const gifts = [gift({ id: 'old1', dateISO: '2019-03-05' }), gift({ id: 'old2', dateISO: '2023-01-15' }), gift({ id: 'back', dateISO: '2026-12-01', amountCents: 5000 })];
    const d = deriveMembership(gifts, [], config, RECEIVED, '2026-12-02');
    expect(d.state).toEqual({ since: '2019-03-05', currentTermStart: '2026-12-01', until: '2028-01-01', tier: 'member', lapseCount: 2, lastLapsed: '2024-02-15', memberType: 'lapsedRenewal' });
    expect(d.terms.get('back')).toEqual({ start: '2026-12-01', end: '2028-01-01', type: 'lapsedRenewal' });
    expect(d.terms.has('old1')).toBe(false);   // pre-cutover gifts are never stamped
  });
  it('never gave; a check-in with blank Hours makes a New member', () => {
    const d = deriveMembership([], [checkin({ activityDateISO: '2027-05-02' })], config, RECEIVED, '2027-05-03');
    expect(d.state).toMatchObject({ since: '2027-05-02', currentTermStart: '2027-05-02', until: '2028-06-02', memberType: 'new', lapseCount: 0 });
    expect(d.terms.size).toBe(0);
  });
  it('a $1,000 gift: Lifetime tier, blank Until, Type by the same rule; a later gift gets no stamp', () => {
    const d = deriveMembership([gift({ amountCents: 100000 }), gift({ id: 'g2', dateISO: '2027-01-01' })], [], config, RECEIVED, '2027-01-02');
    expect(d.state).toMatchObject({ tier: 'lifetime', until: null, memberType: 'new' });
    expect(d.terms.get('g1')).toEqual({ start: '2026-11-03', end: null, type: 'lifetime' });
    expect(d.terms.has('g2')).toBe(false);
  });
  it('a pre-cutover $1,500 gift is ordinary activity, not Lifetime; the same gift after fromISO is Lifetime', () => {
    const before = deriveMembership([gift({ amountCents: 150000, dateISO: '2012-06-01' })], [], config, RECEIVED, '2026-11-06');
    expect(before.state).toMatchObject({ tier: 'member', until: '2013-07-01' });
    expect(before.terms.size).toBe(0);
    const after = deriveMembership([gift({ amountCents: 150000, dateISO: '2026-11-01' })], [], config, RECEIVED, '2026-11-06');
    expect(after.state).toMatchObject({ tier: 'lifetime', until: null });
    expect(after.terms.get('g1')).toEqual({ start: '2026-11-01', end: null, type: 'lifetime' });
  });
  it('a currently lapsed member: their own lapse is not counted until they return', () => {
    const d = deriveMembership([gift({ dateISO: '2024-01-01' })], [], config, RECEIVED, '2026-11-06');
    expect(d.state).toMatchObject({ until: '2025-02-01', lapseCount: 0, lastLapsed: null, memberType: 'new' });
  });
  it('a gift dated exactly on fromISO is stamped; the day before is activity without a stamp', () => {
    const d = deriveMembership([gift({ id: 'on', dateISO: '2026-10-16' }), gift({ id: 'before', dateISO: '2026-10-15' })], [], config, RECEIVED, '2026-11-06');
    expect(d.terms.has('on')).toBe(true);
    expect(d.terms.has('before')).toBe(false);
    expect(d.state!.since).toBe('2026-10-15');
  });
  it('no activity at all: state is null and no terms', () => {
    expect(deriveMembership([gift({ amountCents: 50 })], [checkin({ qualifies: false })], config, RECEIVED, '2026-11-06')).toEqual({ state: null, terms: new Map() });
  });
  it('is identical on re-run with the same inputs', () => {
    const inputs = [gift({ id: 'b', dateISO: '2026-11-03' }), gift({ id: 'a', dateISO: '2026-11-03' })];
    expect(deriveMembership(inputs, [], config, RECEIVED, '2026-11-06')).toEqual(deriveMembership([...inputs].reverse(), [], config, RECEIVED, '2026-11-06'));
  });
});

const state = (over: Partial<OwnerMembershipState> = {}): OwnerMembershipState => ({
  since: '2026-11-03', currentTermStart: '2026-11-03', until: '2027-12-03', tier: 'member', lapseCount: 0, lastLapsed: null, memberType: 'new', ...over,
});

describe('mergeWithBoard (extend-only on Since/Until/Tier; outright on the rest)', () => {
  it('keeps the earlier Since and the later Until from the board; takes derived lapse columns verbatim', () => {
    const m = mergeWithBoard(state({ lapseCount: 1, lastLapsed: '2024-02-15' }), { since: '2015-01-01', until: '2029-01-01', tier: 'member' });
    expect(m).toMatchObject({ since: '2015-01-01', until: '2029-01-01', lapseCount: 1, lastLapsed: '2024-02-15', currentTermStart: '2026-11-03' });
  });
  it('never downgrades a board Lifetime, and blanks Until for it', () => {
    expect(mergeWithBoard(state(), { since: null, until: '2027-01-01', tier: 'lifetime' })).toMatchObject({ tier: 'lifetime', until: null });
  });
});

describe('statusFor', () => {
  it('Active through the Until day, Lapsed after; Lifetime always Active', () => {
    expect(statusFor(state(), '2027-12-03')).toBe('active');
    expect(statusFor(state(), '2027-12-04')).toBe('lapsed');
    expect(statusFor(state({ tier: 'lifetime', until: null }), '2099-01-01')).toBe('active');
  });
});

describe('membershipColumnValues — changed values only, all eight columns', () => {
  it('writes everything for a blank board', () => {
    expect(membershipColumnValues(state(), 'active', blankBoard, COLS, config)).toEqual({
      ms: { label: 'Active' }, mt: { label: 'Member' }, msince: { date: '2026-11-03' }, muntil: { date: '2027-12-03' },
      mcts: { date: '2026-11-03' }, mtype: { label: 'New' }, mlc: '0',
    });
  });
  it('writes nothing when the board already matches', () => {
    const board: BoardMembership = { statusLabel: 'Active', tierLabel: 'Member', since: '2026-11-03', until: '2027-12-03',
      currentTermStart: '2026-11-03', memberTypeLabel: 'New', lapseCount: 0, lastLapsed: null };
    expect(membershipColumnValues(state(), 'active', board, COLS, config)).toEqual({});
  });
  it('overwrites a staff-edited Lapse Count and a stale Member Type', () => {
    const board: BoardMembership = { statusLabel: 'Active', tierLabel: 'Member', since: '2026-11-03', until: '2027-12-03',
      currentTermStart: '2026-11-03', memberTypeLabel: 'New', lapseCount: 5, lastLapsed: null };
    expect(membershipColumnValues(state({ memberType: 'continuing' }), 'active', board, COLS, config)).toEqual({ mtype: { label: 'Continuing' }, mlc: '0' });
  });
  it('clears Until for Lifetime with a null date value', () => {
    const board: BoardMembership = { ...blankBoard, until: '2027-01-01' };
    expect(membershipColumnValues(state({ tier: 'lifetime', until: null }), 'active', board, COLS, config)).toMatchObject({ muntil: null, mt: { label: 'Lifetime' } });
  });
});

describe('termColumnValues', () => {
  const cols = { termStart: 'ts', termEnd: 'te', membershipType: 'mty' };
  it('writes the three stamps with the new labels, only where they differ', () => {
    expect(termColumnValues({ start: '2026-11-03', end: '2027-12-03', type: 'lapsedRenewal' }, { termStart: '2026-11-03', termEnd: null, membershipType: null }, cols, config))
      .toEqual({ te: { date: '2027-12-03' }, mty: 'Lapsed renewal' });
    expect(termColumnValues(undefined, { termStart: null, termEnd: null, membershipType: null }, cols, config)).toEqual({});
  });
});
