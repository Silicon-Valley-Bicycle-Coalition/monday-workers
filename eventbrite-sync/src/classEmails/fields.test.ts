import { describe, it, expect } from 'vitest';
import { classFields } from './fields';

// 2026-03-28 is a Saturday. 17:00 UTC is 10:00 in Pacific daylight time.
const IN_PERSON = { startsAt: '2026-03-28T17:00:00.000Z', endsAt: '2026-03-28T20:30:00.000Z', locationKey: 'millbrae rec, 477 lincoln cir' };

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

  it('gives the end time and the arrival time, 5 minutes before the start', () => {
    const fields = classFields(IN_PERSON, '', '');
    expect(fields['End Time']).toBe('1:30 PM');
    expect(fields['Arrival Time']).toBe('9:55 AM');
  });

  it('gives the arrival time across the hour and across noon', () => {
    const fields = classFields({ ...IN_PERSON, startsAt: '2026-03-28T19:00:00.000Z' }, '', '');
    expect(fields['Start Time']).toBe('12:00 PM');
    expect(fields['Arrival Time']).toBe('11:55 AM');
  });

  it('gives the day, date and times in Spanish', () => {
    const fields = classFields(IN_PERSON, '', '');
    expect(fields['Spanish Day']).toBe('sábado');
    expect(fields['Spanish Date']).toBe('28 de marzo');
    expect(fields['Spanish Time']).toBe('10:00 a.m.');
    expect(fields['Spanish Arrival Time']).toBe('9:55 a.m.');
  });

  it('uses Pacific time for Spanish too, and says p.m. in the afternoon', () => {
    const fields = classFields({ ...IN_PERSON, startsAt: '2026-11-06T02:30:00.000Z' }, '', '');
    expect(fields['Spanish Day']).toBe('jueves');
    expect(fields['Spanish Date']).toBe('5 de noviembre');
    expect(fields['Spanish Time']).toBe('6:30 p.m.');
  });

  it('writes every time with plain spaces, so a plain text email reads the same', () => {
    const fields = classFields(IN_PERSON, '', '');
    for (const name of ['Start Time', 'End Time', 'Arrival Time', 'Spanish Time', 'Spanish Arrival Time'] as const) {
      expect(fields[name]).not.toMatch(/[^\x20-\x7e]/);
    }
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
    const fields = classFields({ startsAt: null, endsAt: null, locationKey: null }, '', '');
    expect(Object.values(fields).every((value) => value === null)).toBe(true);
    expect(Object.keys(fields)).toHaveLength(10);
    const broken = classFields({ startsAt: 'not a date', endsAt: 'not a date', locationKey: null }, '', '');
    expect(broken['Class Date']).toBeNull();
    expect(broken['Arrival Time']).toBeNull();
    expect(broken['End Time']).toBeNull();
  });

  it('keeps the start-based values when only the end time is missing', () => {
    const fields = classFields({ ...IN_PERSON, endsAt: null }, '', '');
    expect(fields['End Time']).toBeNull();
    expect(fields['Start Time']).toBe('10:00 AM');
  });
});
