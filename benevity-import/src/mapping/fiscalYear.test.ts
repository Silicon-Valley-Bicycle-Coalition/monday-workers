import { describe, it, expect } from 'vitest';
import { fiscalYearEnding } from './fiscalYear';

describe('fiscalYearEnding', () => {
  it('a date in the first half of the calendar year ends that same June 30', () => {
    expect(fiscalYearEnding('2026-03-15')).toBe('2026-06-30');
  });

  it('June 30 itself ends that same June 30', () => {
    expect(fiscalYearEnding('2026-06-30')).toBe('2026-06-30');
  });

  it('July 1 rolls into the following fiscal year', () => {
    expect(fiscalYearEnding('2026-07-01')).toBe('2027-06-30');
  });

  it('a date in the back half of the calendar year ends the following June 30', () => {
    expect(fiscalYearEnding('2026-12-06')).toBe('2027-06-30');
  });

  it('throws on an invalid date string', () => {
    expect(() => fiscalYearEnding('not-a-date')).toThrow(/not a valid date/);
  });
});
