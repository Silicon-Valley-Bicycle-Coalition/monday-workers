import { describe, it, expect } from 'vitest';
import { attendanceFromEventbrite, mapAttendee, mergeAttendance } from './attendee';
import { testConfig } from '../test/testConfig';
import type { EventbriteAttendee } from '../eventbrite/client';

const config = testConfig();
const facts = { classDate: '2026-10-30', classDay: 'Friday', classLocation: 'online', program: 'Public' as string | null };

function attendee(overrides: Partial<EventbriteAttendee> = {}): EventbriteAttendee {
  return { id: 'a1', profile: { name: 'Jane Rider', first_name: 'Jane', email: 'jane@example.com' }, ...overrides };
}

describe('attendanceFromEventbrite', () => {
  it('maps checked_in to Attended', () => expect(attendanceFromEventbrite(attendee({ checked_in: true }))).toBe('Attended'));
  it('maps cancelled to Canceled', () => expect(attendanceFromEventbrite(attendee({ cancelled: true }))).toBe('Canceled'));
  it('maps refunded to Canceled', () => expect(attendanceFromEventbrite(attendee({ refunded: true }))).toBe('Canceled'));
  it('maps anything else to Registered', () => expect(attendanceFromEventbrite(attendee())).toBe('Registered'));
});

describe('mergeAttendance', () => {
  const table: Record<string, Record<string, string>> = {
    null: { Registered: 'Registered', Attended: 'Attended', Canceled: 'Canceled' },
    Registered: { Registered: 'Registered', Attended: 'Attended', Canceled: 'Canceled' },
    Attended: { Registered: 'Attended', Attended: 'Attended', Canceled: 'Attended' },
    'No Show': { Registered: 'No Show', Attended: 'Attended', Canceled: 'Canceled' },
    Canceled: { Registered: 'Canceled', Attended: 'Attended', Canceled: 'Canceled' },
  };
  for (const [current, row] of Object.entries(table)) {
    for (const [incoming, expected] of Object.entries(row)) {
      it(`${current} + ${incoming} = ${expected}`, () => {
        expect(mergeAttendance(current === 'null' ? null : current, incoming as 'Registered' | 'Attended' | 'Canceled')).toBe(expected);
      });
    }
  }
});

describe('mapAttendee', () => {
  it('maps the registration columns', () => {
    const m = mapAttendee(attendee(), facts, config, 'Registered');
    expect(m.itemName).toBe('Jane Rider');
    expect(m.columnValues).toEqual({
      att_col: 'a1',
      att_name_col: 'Jane Rider',
      att_email_col: { email: 'jane@example.com', text: 'jane@example.com' },
      att_first_col: 'Jane',
      att_attendance_col: 'Registered',
      att_source_col: 'Eventbrite',
      att_role_col: 'Participant',
      att_class_date_col: { date: '2026-10-30' },
      att_class_day_col: 'Friday',
      att_class_loc_col: 'online',
    });
  });

  it('sets Role = Volunteer for a volunteer program', () => {
    const m = mapAttendee(attendee(), { ...facts, program: 'Volunteering' }, config, 'Attended');
    expect(m.columnValues.att_role_col).toBe('Volunteer');
    expect(m.columnValues.att_attendance_col).toBe('Attended');
  });

  it('omits the email column and does not throw with no email', () => {
    const m = mapAttendee(attendee({ profile: { name: 'Jane Rider' } }), facts, config, 'Registered');
    expect(m.columnValues).not.toHaveProperty('att_email_col');
  });

  it('copes with no profile and no class facts', () => {
    const m = mapAttendee({ id: 'a2' }, { classDate: null, classDay: null, classLocation: '', program: null }, config, 'Registered');
    expect(m.itemName).toBe('Eventbrite attendee a2');
    expect(m.columnValues).not.toHaveProperty('att_class_date_col');
    expect(m.columnValues).not.toHaveProperty('att_first_col');
    expect(m.columnValues.att_role_col).toBe('Participant');
  });

  it('never writes the class type or follow-up email columns', () => {
    const m = mapAttendee(attendee(), facts, config, 'Registered');
    expect(m.columnValues).not.toHaveProperty('att_class_type_col');
    expect(m.columnValues).not.toHaveProperty('att_followup_col');
  });
});
