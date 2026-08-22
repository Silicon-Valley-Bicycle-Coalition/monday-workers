import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { todayISOInTimeZone, addDaysISO, targetDateForStage } from './dates';

describe('todayISOInTimeZone', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T06:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('returns the UTC date when timeZone is UTC', () => {
    expect(todayISOInTimeZone('UTC')).toBe('2026-01-15');
  });

  it('returns the previous day in a timezone behind UTC', () => {
    expect(todayISOInTimeZone('America/Los_Angeles')).toBe('2026-01-14');
  });
});

describe('addDaysISO', () => {
  it('adds days within the same month', () => {
    expect(addDaysISO('2026-01-01', 10)).toBe('2026-01-11');
  });

  it('crosses a month boundary', () => {
    expect(addDaysISO('2026-01-15', 42)).toBe('2026-02-26');
  });

  it('crosses a year boundary', () => {
    expect(addDaysISO('2026-12-20', 14)).toBe('2027-01-03');
  });
});

describe('targetDateForStage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T06:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('combines today-in-timezone with the offset', () => {
    expect(targetDateForStage(42, 'America/Los_Angeles')).toBe('2026-02-25');
  });
});
