import { describe, it, expect } from 'vitest';
import { classFields } from './fields';

// 2026-03-28 is a Saturday. 17:00 UTC is 10:00 in Pacific daylight time.
const IN_PERSON = { startsAt: '2026-03-28T17:00:00.000Z', locationKey: 'millbrae rec, 477 lincoln cir' };

describe('classFields', () => {
  it('formats the day, date and start time in Pacific time', () => {
    const fields = classFields(IN_PERSON, 'Millbrae Rec', '477 Lincoln Cir, Millbrae, CA');
    expect(fields['Class Day']).toBe('Saturday');
    expect(fields['Class Date']).toBe('March 28');
    expect(fields['Start Time']).toBe('10:00 AM');
  });

  it('uses Pacific time when the UTC date is already the next day', () => {
    const fields = classFields({ ...IN_PERSON, startsAt: '2026-11-06T02:30:00.000Z' }, 'Library', '');
    expect(fields['Class Day']).toBe('Thursday');
    expect(fields['Class Date']).toBe('November 5');
    expect(fields['Start Time']).toBe('6:30 PM');
  });

  it('writes the start time with a plain space, so a plain text email reads the same', () => {
    expect(classFields(IN_PERSON, '', '')['Start Time']).not.toMatch(/[^\x20-\x7e]/);
  });

  it('joins the venue and address the way the registration column does', () => {
    expect(classFields(IN_PERSON, 'Millbrae Rec', '477 Lincoln Cir')['Class Location']).toBe('Millbrae Rec, 477 Lincoln Cir');
    expect(classFields(IN_PERSON, 'Millbrae Rec', '  ')['Class Location']).toBe('Millbrae Rec');
    expect(classFields(IN_PERSON, '', '477 Lincoln Cir')['Class Location']).toBe('477 Lincoln Cir');
  });

  it('says online for an online class, whatever the venue columns hold', () => {
    expect(classFields({ ...IN_PERSON, locationKey: 'online' }, '', '')['Class Location']).toBe('online');
    expect(classFields({ ...IN_PERSON, locationKey: 'online' }, 'Old Venue', 'Old Address')['Class Location']).toBe('online');
  });

  it('returns null for what it does not know, never an empty or broken value', () => {
    const fields = classFields({ startsAt: null, locationKey: null }, '', '');
    expect(fields).toEqual({ 'Class Day': null, 'Class Date': null, 'Start Time': null, 'Class Location': null });
    expect(classFields({ startsAt: 'not a date', locationKey: null }, '', '')['Class Date']).toBeNull();
  });
});
