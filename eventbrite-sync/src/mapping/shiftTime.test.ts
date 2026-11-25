import { describe, it, expect } from 'vitest';
import { plainSpaces, shiftTime } from './shiftTime';

describe('shiftTime', () => {
  it.each([
    ['2026-06-13T15:00:00Z', '2026-06-13T19:00:00Z', '8:00 AM–12:00 PM'],
    ['2026-10-11T03:30:00Z', '2026-10-11T07:30:00Z', '8:30 PM–12:30 AM'], // past midnight
    ['2026-10-11T03:00:00Z', '2026-10-11T07:00:00Z', '8:00 PM–12:00 AM'], // ends at midnight
    ['2026-06-13T15:00:00Z', '2026-06-14T15:00:00Z', '8:00 AM–8:00 AM'], // exactly 24 hours
    ['2026-10-03T15:00:00Z', '2026-10-04T19:00:00Z', 'Oct 3, 8:00 AM–Oct 4, 12:00 PM'],
    ['2026-11-01T08:30:00Z', '2026-11-01T11:00:00Z', '1:30 AM–3:00 AM'], // clocks go back at 2 AM
    ['2026-06-13T15:00:00Z', null, '8:00 AM'],
    ['2026-06-13T15:00:00Z', '2026-06-13T15:00:00Z', '8:00 AM'],
    ['2026-06-13T15:00:00Z', '2026-06-13T14:00:00Z', '8:00 AM'],
    ['2026-06-13T15:00:00Z', 'soon', '8:00 AM'],
  ])('%s to %s is %s', (start, end, text) => expect(shiftTime(start, end)).toBe(text));

  it.each([null, 'soon', ''])('no usable start (%j) is null', (start) => expect(shiftTime(start, '2026-06-13T19:00:00Z')).toBeNull());

  it('uses ordinary spaces, so staff can search for the text', () => {
    for (const end of ['2026-06-13T19:00:00Z', '2026-06-15T19:00:00Z']) expect(shiftTime('2026-06-13T15:00:00Z', end)).not.toMatch(/[\u202f\u00a0\u2009]/);
  });

  // This runtime already formats with ordinary spaces; others put U+202F before AM/PM.
  it('replaces the special spaces some runtimes format with', () => {
    expect(plainSpaces('8:00\u202fAM\u20091\u00a0x')).toBe('8:00 AM 1 x');
  });
});
