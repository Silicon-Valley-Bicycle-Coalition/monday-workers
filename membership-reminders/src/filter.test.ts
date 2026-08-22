import { describe, it, expect } from 'vitest';
import { isEligible, stampValue, hasStamp, appendStamp } from './filter';
import type { Member, StageConfig } from './types';

const stage6w: StageConfig = { tag: '6w', offsetDays: 42 };

function member(overrides: Partial<Member> = {}): Member {
  return {
    id: '1',
    name: 'Jamie',
    email: 'jamie@example.org',
    membershipTier: 'Individual',
    memberUntil: '2026-10-01',
    remindersSent: '',
    ...overrides,
  };
}

describe('isEligible', () => {
  it('is true for an active, non-Lifetime member with a Member Until date', () => {
    expect(isEligible(member(), 'Lifetime')).toBe(true);
  });

  it('is false for a Lifetime member', () => {
    expect(isEligible(member({ membershipTier: 'Lifetime' }), 'Lifetime')).toBe(false);
  });

  it('is false when Member Until is blank', () => {
    expect(isEligible(member({ memberUntil: '' }), 'Lifetime')).toBe(false);
  });
});

describe('stampValue', () => {
  it('combines the stage tag and member-until date', () => {
    expect(stampValue(stage6w, '2026-10-01')).toBe('6w:2026-10-01');
  });
});

describe('hasStamp', () => {
  it('is false on an empty reminders-sent value', () => {
    expect(hasStamp('', stage6w, '2026-10-01')).toBe(false);
  });

  it('is true when the exact stamp is present among others', () => {
    expect(hasStamp('4w:2026-04-01, 6w:2026-10-01', stage6w, '2026-10-01')).toBe(true);
  });

  it('is false when the tag matches but the term date differs (renewed)', () => {
    expect(hasStamp('6w:2026-01-01', stage6w, '2026-10-01')).toBe(false);
  });
});

describe('appendStamp', () => {
  it('returns the bare stamp when reminders-sent is empty', () => {
    expect(appendStamp('', stage6w, '2026-10-01')).toBe('6w:2026-10-01');
  });

  it('appends to an existing value', () => {
    expect(appendStamp('4w:2026-04-01', stage6w, '2026-10-01')).toBe('4w:2026-04-01, 6w:2026-10-01');
  });
});
