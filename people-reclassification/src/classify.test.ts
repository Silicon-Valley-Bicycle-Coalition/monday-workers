import { describe, it, expect } from 'vitest';
import { classify, cutoffFor, latestActivity, todayInZone, type PersonFacts } from './classify';

const TODAY = '2026-10-09';
const CUTOFF = '2019-10-09';
const rule = { todayISO: TODAY, cutoffISO: CUTOFF, lifetimeTierLabel: 'Lifetime', funraiseLinked: true };

function person(over: Partial<PersonFacts> = {}): PersonFacts {
  return {
    itemId: '1', board: 'live', lastGiftISO: null, memberUntilISO: null, membershipTier: null,
    funraiseLinked: false, latestRegistrationISO: null, latestVolunteerISO: null, latestLoggedISO: null, promotedOnISO: null, ...over,
  };
}

describe('logged contact and promotions', () => {
  it('a logged contact inside the window is live', () => {
    expect(classify(person({ lastGiftISO: '2010-01-01', latestLoggedISO: '2026-10-01' }), rule))
      .toEqual({ kind: 'live', reason: 'recent-activity', latestActivity: '2026-10-01' });
  });

  it('a promotion inside the window is live, with no other evidence', () => {
    expect(classify(person({ promotedOnISO: '2026-10-01' }), rule))
      .toEqual({ kind: 'live', reason: 'recent-activity', latestActivity: '2026-10-01' });
  });

  it('ages out once a promotion is older than the window', () => {
    expect(classify(person({ promotedOnISO: '2019-10-08' }), rule).kind).toBe('historical');
  });

  it('ignores a logged date after today', () => {
    expect(classify(person({ latestLoggedISO: '2027-01-01' }), rule).kind).toBe('unknown');
  });
});

describe('latestActivity', () => {
  it('is the max of gift, registration, volunteer and term-end dates', () => {
    expect(latestActivity(person({ lastGiftISO: '2020-01-01', latestRegistrationISO: '2022-05-05', latestVolunteerISO: '2021-01-01', memberUntilISO: '2018-01-01' }), TODAY)).toBe('2022-05-05');
  });

  it('ignores a future gift or registration date (a data-entry defect), but clamps a future term end to today', () => {
    expect(latestActivity(person({ lastGiftISO: '2030-01-01', latestRegistrationISO: '2015-01-01' }), TODAY)).toBe('2015-01-01');
    expect(latestActivity(person({ memberUntilISO: '2027-06-30' }), TODAY)).toBe(TODAY);
  });

  it('accepts Monday date text with a time component and rejects anything else', () => {
    expect(latestActivity(person({ lastGiftISO: '2024-03-04 00:00' }), TODAY)).toBe('2024-03-04');
    expect(latestActivity(person({ lastGiftISO: 'yesterday' }), TODAY)).toBeNull();
  });

  it('is null with no evidence', () => {
    expect(latestActivity(person(), TODAY)).toBeNull();
  });
});

describe('classify', () => {
  it('a linked Funraise profile never ages out, when the rule is on', () => {
    expect(classify(person({ funraiseLinked: true, lastGiftISO: '2001-01-01' }), rule)).toEqual({ kind: 'live', reason: 'funraise-linked', latestActivity: null });
    expect(classify(person({ funraiseLinked: true, lastGiftISO: '2001-01-01' }), { ...rule, funraiseLinked: false }).kind).toBe('historical');
  });

  it('a Lifetime member never ages out', () => {
    expect(classify(person({ membershipTier: 'Lifetime' }), rule)).toEqual({ kind: 'live', reason: 'lifetime-member', latestActivity: null });
    expect(classify(person({ membershipTier: 'Member' }), rule).kind).toBe('unknown');
  });

  it('a term ending after today is a current member, including a placeholder decades out', () => {
    expect(classify(person({ memberUntilISO: '2027-01-01' }), rule)).toEqual({ kind: 'live', reason: 'current-member', latestActivity: TODAY });
    expect(classify(person({ memberUntilISO: '2122-01-01' }), rule).reason).toBe('current-member');
  });

  it('activity on or after the cutoff is live; before it, historical', () => {
    expect(classify(person({ lastGiftISO: CUTOFF }), rule)).toEqual({ kind: 'live', reason: 'recent-activity', latestActivity: CUTOFF });
    expect(classify(person({ lastGiftISO: '2019-10-08' }), rule)).toEqual({ kind: 'historical', reason: 'aged-out', latestActivity: '2019-10-08' });
    expect(classify(person({ memberUntilISO: '2019-10-08' }), rule).kind).toBe('historical');
  });

  it('no evidence at all is unknown, never a move', () => {
    expect(classify(person(), rule)).toEqual({ kind: 'unknown', reason: 'no-evidence', latestActivity: null });
  });
});

describe('cutoffFor', () => {
  it('is the same month and day N years earlier', () => {
    expect(cutoffFor('2026-10-09', 7)).toBe('2019-10-09');
    expect(cutoffFor('2026-01-01', 1)).toBe('2025-01-01');
  });

  it('clamps Feb 29 to Feb 28 in a non-leap year', () => {
    expect(cutoffFor('2028-02-29', 1)).toBe('2027-02-28');
    expect(cutoffFor('2028-02-29', 4)).toBe('2024-02-29');
  });
});

describe('todayInZone', () => {
  it('reads the date in the configured zone, not UTC', () => {
    // 2026-07-01T03:00Z is still June 30 in Los Angeles.
    expect(todayInZone(new Date('2026-07-01T03:00:00Z'), 'America/Los_Angeles')).toBe('2026-06-30');
    expect(todayInZone(new Date('2026-07-01T03:00:00Z'), 'UTC')).toBe('2026-07-01');
  });
});
