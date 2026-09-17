import { describe, it, expect } from 'vitest';
import { fiscalYearEnding } from './fiscalYear';

describe('fiscalYearEnding (SVBC July–June fiscal year)', () => {
  it('returns the calendar year for a January gift', () => {
    expect(fiscalYearEnding('2026-01-15')).toBe('2026');
  });

  it('returns the calendar year for the last day of June', () => {
    expect(fiscalYearEnding('2026-06-30')).toBe('2026');
  });

  it('rolls over to the next year on the first day of July', () => {
    expect(fiscalYearEnding('2026-07-01')).toBe('2027');
  });

  it('returns the next calendar year for an August gift (the README example)', () => {
    expect(fiscalYearEnding('2026-08-15')).toBe('2027');
  });

  it('returns the next calendar year for a December gift', () => {
    expect(fiscalYearEnding('2026-12-31')).toBe('2027');
  });

  it('reads the date portion of a full ISO timestamp', () => {
    expect(fiscalYearEnding('2026-08-15T18:30:12.000Z')).toBe('2027');
    expect(fiscalYearEnding('2026-06-30T23:59:59Z')).toBe('2026');
  });

  it('returns null for anything that is not a YYYY-MM-DD-prefixed string', () => {
    expect(fiscalYearEnding(undefined)).toBeNull();
    expect(fiscalYearEnding(null)).toBeNull();
    expect(fiscalYearEnding('')).toBeNull();
    expect(fiscalYearEnding('not a date')).toBeNull();
    expect(fiscalYearEnding('08/15/2026')).toBeNull();
    expect(fiscalYearEnding(1755282612000)).toBeNull();
    expect(fiscalYearEnding({ date: '2026-08-15' })).toBeNull();
  });

  it('returns null for an impossible month', () => {
    expect(fiscalYearEnding('2026-13-01')).toBeNull();
    expect(fiscalYearEnding('2026-00-01')).toBeNull();
  });
});
