import { describe, it, expect } from 'vitest';
import { formatShortDate } from './dates';

describe('formatShortDate', () => {
  it('formats an ISO date as "Mon D, YYYY"', () => {
    expect(formatShortDate('2024-03-03')).toBe('Mar 3, 2024');
  });

  it('does not zero-pad the day', () => {
    expect(formatShortDate('2024-03-14')).toBe('Mar 14, 2024');
  });

  it('does not shift by a day near a UTC midnight boundary', () => {
    expect(formatShortDate('2025-01-01')).toBe('Jan 1, 2025');
  });

  it('returns the raw text unchanged if it does not parse as a date', () => {
    expect(formatShortDate('not-a-date')).toBe('not-a-date');
  });
});
