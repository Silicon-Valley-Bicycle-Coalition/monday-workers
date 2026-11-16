import { describe, it, expect } from 'vitest';
import { parseHours, registrationQualifies, historicalShiftQualifies } from './volunteer';
import type { VolunteerBoardConfig, HistoricalVolunteerBoardConfig } from '../types';

const board: VolunteerBoardConfig = {
  boardId: 7, columns: { attendee: 'att', event: 'ev', attendance: 'atd', role: 'role', hours: 'hrs' },
  eventBoard: { boardId: 8, columns: { start: 'start' } },
  volunteerRoleLabels: ['Volunteer'], countedAttendanceLabels: ['Attended'],
};
const historical: HistoricalVolunteerBoardConfig = {
  boardId: 9, columns: { volunteer: 'vol', date: 'dt', hours: 'hrs', status: 'st' }, countedStatusLabels: ['Completed'],
};
const reg = (over = {}) => ({ attendeeItemId: 'p1', attendanceLabel: 'Attended', roleLabel: 'Volunteer', hours: null, ...over });

describe('parseHours', () => {
  it.each([[null, null], ['', null], ['  ', null], ['two', null], ['3', 3], ['2.5', 2.5], ['0', 0], ['1,5', null]])
    ('%j → %j', (text, want) => expect(parseHours(text)).toBe(want));
});

describe('registrationQualifies (decided 2026-10-09: a checked-in volunteer counts as one hour)', () => {
  it('qualifies with Role = Volunteer, Attended, blank Hours and a dated Event', () => {
    expect(registrationQualifies(reg(), '2027-05-02', board)).toBe(true);
  });
  it.each([
    ['Hours 0', reg({ hours: 0 })], ['Hours 0.5', reg({ hours: 0.5 })],
    ['Participant role', reg({ roleLabel: 'Participant' })], ['no role', reg({ roleLabel: null })],
    ['Registered only', reg({ attendanceLabel: 'Registered' })], ['No Show', reg({ attendanceLabel: 'No Show' })],
    ['no attendee', reg({ attendeeItemId: null })],
  ])('does not qualify: %s', (_label, r) => expect(registrationQualifies(r, '2027-05-02', board)).toBe(false));
  it('does not qualify without an Event Start date (Review Focus 1)', () => {
    expect(registrationQualifies(reg(), null, board)).toBe(false);
  });
  it('Hours 1 and Hours 3 qualify', () => {
    expect(registrationQualifies(reg({ hours: 1 }), '2027-05-02', board)).toBe(true);
    expect(registrationQualifies(reg({ hours: 3 }), '2027-05-02', board)).toBe(true);
  });
});

describe('historicalShiftQualifies', () => {
  const shift = (over = {}) => ({ volunteerItemId: 'p1', dateISO: '2019-06-01', hours: 2, statusLabel: 'Completed', historical: false, ...over });
  it('a Completed shift with hours ≥ 1 and a date qualifies', () => expect(historicalShiftQualifies(shift(), historical)).toBe(true));
  it.each([
    ['Canceled', shift({ statusLabel: 'Canceled' })], ['blank hours (no `historical` column configured: every row needs hours)', shift({ hours: null })], ['0.5 hours', shift({ hours: 0.5 })],
    ['no date', shift({ dateISO: null })], ['no volunteer', shift({ volunteerItemId: null })],
  ])('does not qualify: %s', (_label, s) => expect(historicalShiftQualifies(s, historical)).toBe(false));
});

describe('historicalShiftQualifies with the Historical checkbox configured (new Eventbrite rows have no hours)', () => {
  const withCol: HistoricalVolunteerBoardConfig = { ...historical, columns: { ...historical.columns, historical: 'hist' } };
  const shift = (over = {}) => ({ volunteerItemId: 'p1', dateISO: '2026-09-01', hours: null, statusLabel: 'Completed', historical: false, ...over });
  it('a non-Historical Completed shift qualifies with blank hours, or any hours', () => {
    expect(historicalShiftQualifies(shift(), withCol)).toBe(true);
    expect(historicalShiftQualifies(shift({ hours: 0 }), withCol)).toBe(true);
  });
  it.each([['blank', null], ['0', 0], ['0.5', 0.5]])('a Historical Completed shift with %s hours does not qualify', (_l, hours) =>
    expect(historicalShiftQualifies(shift({ historical: true, hours }), withCol)).toBe(false));
  it('a Historical Completed shift with hours ≥ 1 qualifies (unchanged)', () =>
    expect(historicalShiftQualifies(shift({ historical: true, hours: 2 }), withCol)).toBe(true));
  it.each([
    ['Canceled', shift({ statusLabel: 'Canceled' })], ['RSVP', shift({ statusLabel: 'RSVP' })], ['No-Show', shift({ statusLabel: 'No-Show' })],
    ['no status', shift({ statusLabel: null })], ['no Volunteer link', shift({ volunteerItemId: null })], ['no date', shift({ dateISO: null })],
  ])('a non-Historical row does not qualify: %s', (_l, s) => expect(historicalShiftQualifies(s, withCol)).toBe(false));
});
