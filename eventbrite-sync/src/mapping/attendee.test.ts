import { describe, it, expect } from 'vitest';
import { attendanceFromEventbrite, mapAttendee, mergeAttendance } from './attendee';
import { testConfig } from '../test/testConfig';
import { PLACEHOLDER_COLUMN_ID } from '../config';
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

  describe('Home Zip', () => {
    const answers = (answer: unknown) => [{ question: 'Home ZIP code', question_id: '9', type: 'text', answer }];

    it('writes Home Zip for a program in zipPrograms', () => {
      const m = mapAttendee(attendee({ answers: answers(' 95112-1234 ') }), facts, config, 'Registered');
      expect(m.columnValues.att_zip_col).toBe('95112');
      const grp = mapAttendee(attendee({ answers: answers('95112') }), { ...facts, program: 'Group Rides' }, config, 'Registered');
      expect(grp.columnValues.att_zip_col).toBe('95112');
    });

    it('leaves Home Zip out for an invalid answer, so a good value stays, and the text reaches nothing', () => {
      const m = mapAttendee(attendee({ answers: answers('95112 please call me') }), facts, config, 'Registered');
      expect(m.columnValues).not.toHaveProperty('att_zip_col');
      expect(JSON.stringify(m)).not.toContain('please call me');
      expect(JSON.stringify(m)).not.toContain('95112');
    });

    it('leaves Home Zip out outside zipPrograms and when program is null', () => {
      const a = attendee({ answers: answers('95112') });
      expect(mapAttendee(a, { ...facts, program: 'Volunteering' }, config, 'Registered').columnValues).not.toHaveProperty('att_zip_col');
      expect(mapAttendee(a, { ...facts, program: null }, config, 'Registered').columnValues).not.toHaveProperty('att_zip_col');
    });

    it('leaves Home Zip out while the column is the placeholder', () => {
      const cfg = testConfig();
      cfg.attendeeSync.registrations.homeZipColumn = PLACEHOLDER_COLUMN_ID;
      const m = mapAttendee(attendee({ answers: answers('95112') }), facts, cfg, 'Registered');
      expect(JSON.stringify(m.columnValues)).not.toContain('95112');
      expect(m.columnValues).not.toHaveProperty(PLACEHOLDER_COLUMN_ID);
    });

    it('still writes the registration for an attendee with no answers key', () => {
      const m = mapAttendee(attendee(), facts, config, 'Registered');
      expect(m.columnValues.att_col).toBe('a1');
      expect(m.columnValues).not.toHaveProperty('att_zip_col');
    });

    it('does not read a question that only contains zip inside a word', () => {
      const a = attendee({ answers: [{ question: 'Do you use Zipcar?', type: 'text', answer: '95112' }] });
      expect(JSON.stringify(mapAttendee(a, facts, config, 'Registered'))).not.toContain('95112');
    });

    it('carries no other answer into the write', () => {
      const a = attendee({
        answers: [
          { question: 'Emergency contact name and phone', type: 'text', answer: 'Sam Rider 555-0142' },
          { question: 'Do you have any medical conditions?', type: 'text', answer: 'asthma-fixture' },
          { question: 'Anything else we should know?', type: 'text', answer: 'free-text-fixture' },
          ...answers('95112'),
        ],
      });
      const written = JSON.stringify(mapAttendee(a, facts, config, 'Registered'));
      for (const leaked of ['Sam Rider', '555-0142', 'asthma-fixture', 'free-text-fixture', 'Emergency', 'medical']) {
        expect(written).not.toContain(leaked);
      }
    });
  });
});
