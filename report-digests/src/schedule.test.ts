import { describe, it, expect } from 'vitest';
import { addDays, fiscalYear, isDue, localTime, thisAndNextMonth } from './schedule';

const PT = 'America/Los_Angeles';

describe('localTime', () => {
  it('reads the Pacific wall clock in daylight time (UTC-7)', () => {
    expect(localTime(new Date('2026-10-26T15:00:00Z'), PT)).toEqual({ date: '2026-10-26', year: 2026, month: 10, day: 26, weekday: 1, hour: 8 });
  });

  it('reads the Pacific wall clock in standard time (UTC-8)', () => {
    expect(localTime(new Date('2026-11-02T16:00:00Z'), PT)).toMatchObject({ date: '2026-11-02', weekday: 1, hour: 8 });
  });

  it('crosses midnight into the previous Pacific day', () => {
    expect(localTime(new Date('2026-11-01T03:00:00Z'), PT)).toMatchObject({ date: '2026-10-31', hour: 20 });
  });
});

describe('isDue', () => {
  const monday8 = localTime(new Date('2026-10-26T15:00:00Z'), PT);
  it('matches weekday and hour', () => {
    expect(isDue({ weekdays: [1], hour: 8 }, monday8)).toBe(true);
    expect(isDue({ weekdays: [1], hour: 13 }, monday8)).toBe(false);
    expect(isDue({ weekdays: [2], hour: 8 }, monday8)).toBe(false);
  });

  it('matches days of the month', () => {
    const first9 = localTime(new Date('2026-12-01T17:00:00Z'), PT);
    expect(isDue({ monthDays: [1, 15], hour: 9 }, first9)).toBe(true);
    expect(isDue({ monthDays: [15], hour: 9 }, first9)).toBe(false);
  });
});

describe('date windows', () => {
  it('adds days across a month end', () => {
    expect(addDays('2026-10-26', -60)).toBe('2026-08-27');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('spans this month and next, across a year end', () => {
    expect(thisAndNextMonth(localTime(new Date('2026-10-15T17:00:00Z'), PT))).toEqual({ from: '2026-10-01', to: '2026-11-30' });
    expect(thisAndNextMonth(localTime(new Date('2026-12-01T17:00:00Z'), PT))).toEqual({ from: '2026-12-01', to: '2027-01-31' });
  });

  it('names the July–June fiscal year by its end year', () => {
    expect(fiscalYear(localTime(new Date('2026-10-26T15:00:00Z'), PT))).toEqual({ label: 'FY2027', start: '2026-07-01' });
    expect(fiscalYear(localTime(new Date('2027-06-30T15:00:00Z'), PT))).toEqual({ label: 'FY2027', start: '2026-07-01' });
    expect(fiscalYear(localTime(new Date('2027-07-01T15:00:00Z'), PT))).toEqual({ label: 'FY2028', start: '2027-07-01' });
  });
});
