import { describe, it, expect, vi } from 'vitest';
import { attendanceFromEventbrite, mapAttendee, mergeAttendance } from './attendee';
import { PLACEHOLDER_COLUMN_ID } from '../config';
import { testConfig } from '../test/testConfig';
import { dryRunMondayClient, piiKeysFor } from '../writeSwitch';
import productionConfig from '../../config/svbc.json';
import type { EventbriteAttendee } from '../eventbrite/client';
import type { MondayClient } from '../monday/client';

const config = testConfig();
const facts = { eventName: 'Bike Class', classDate: '2026-10-30', classDay: 'Friday', classLocation: 'online', program: 'Public' as string | null };

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

  it('maps a placeholder attendee with no name or email columns', () => {
    const m = mapAttendee(attendee({ id: 'a9', profile: { name: 'Info Requested Info Requested', first_name: 'Info Requested', email: 'Info Requested' } }), facts, config, 'Registered');
    expect(m.itemName).toBe('Eventbrite attendee a9');
    expect(m.columnValues).not.toHaveProperty('att_email_col');
    expect(m.columnValues).not.toHaveProperty('att_name_col');
    expect(m.columnValues).not.toHaveProperty('att_first_col');
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

  describe('Attendee Phone', () => {
    const answer = (question: string, value?: string) => ({ question_id: 'q1', question, type: 'text', answer: value });

    it('writes the order form cell phone, as entered', () => {
      const m = mapAttendee(attendee({ profile: { name: 'Jane Rider', cell_phone: ' (408) 555-0100 ' } }), facts, config, 'Registered');
      expect(m.columnValues.att_phone_col).toBe('(408) 555-0100');
    });

    it('falls back to a custom phone question', () => {
      const answers = [answer('Emergency contact name', 'Sam'), answer('Teléfono / Phone number', '408-555-0101 ext 2')];
      const m = mapAttendee(attendee({ answers }), facts, config, 'Registered');
      expect(m.columnValues.att_phone_col).toBe('408-555-0101 ext 2');
    });

    it('prefers the built-in field over a custom question', () => {
      const m = mapAttendee(attendee({ profile: { cell_phone: '4085550100' }, answers: [answer('Phone', '4085550101')] }), facts, config, 'Registered');
      expect(m.columnValues.att_phone_col).toBe('4085550100');
    });

    it('takes the first question with a number, past one that has none', () => {
      const answers = [answer('Do you have a cell phone?', 'Yes'), answer('Mobile number', '4085550102')];
      const m = mapAttendee(attendee({ answers }), facts, config, 'Registered');
      expect(m.columnValues.att_phone_col).toBe('4085550102');
    });

    it('ignores a number answering a question that is not about a phone', () => {
      const m = mapAttendee(attendee({ answers: [answer('Zip code', '95112'), answer('Membership number', '4085550103')] }), facts, config, 'Registered');
      expect(m.columnValues).not.toHaveProperty('att_phone_col');
    });

    it("never writes someone else's number as the attendee's", () => {
      for (const question of ['Emergency contact phone', 'Teléfono de contacto de emergencia', 'Parent or guardian phone number']) {
        const m = mapAttendee(attendee({ answers: [answer(question, '4085550105')] }), facts, config, 'Registered');
        expect(m.columnValues, question).not.toHaveProperty('att_phone_col');
      }
    });

    it("still finds the attendee's own number past an emergency contact's", () => {
      const answers = [answer('Emergency contact phone', '4085550105'), answer('Your phone number', '4085550106')];
      const m = mapAttendee(attendee({ answers }), facts, config, 'Registered');
      expect(m.columnValues.att_phone_col).toBe('4085550106');
    });

    it('falls back to the work phone', () => {
      const m = mapAttendee(attendee({ profile: { cell_phone: '', work_phone: '4085550104' } }), facts, config, 'Registered');
      expect(m.columnValues.att_phone_col).toBe('4085550104');
    });

    it('writes nothing until the column exists (a sandbox config still holding the placeholder)', () => {
      const unset = testConfig();
      unset.attendeeSync.registrations.attendeePhoneColumn = PLACEHOLDER_COLUMN_ID;
      const m = mapAttendee(attendee({ profile: { cell_phone: '4085550100' } }), facts, unset, 'Registered');
      expect(m.columnValues).not.toHaveProperty(PLACEHOLDER_COLUMN_ID);
    });

    it("keeps a phone out of debug skip lines, under the real column's id", async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const real = { createItem: vi.fn(), changeColumnValues: vi.fn() } as unknown as MondayClient;
      const ctx = { worker: 'eventbrite-sync', environment: 'sandbox', mode: 'off' as const, logLevel: 'debug' as const, deliveryId: 'd', piiKeys: piiKeysFor(config) };
      const client = dryRunMondayClient(real, config.monday.boards, ctx);
      await client.changeColumnValues(config.monday.boards['event-registrations']!, '1', { [productionConfig.attendeeSync.registrations.attendeePhoneColumn]: '4085550100' });
      const logged = log.mock.calls.flat().join(' ');
      expect(logged).toContain('changeColumnValues');
      expect(logged).not.toContain('4085550100');
      log.mockRestore();
    });

    it('never writes the Info Requested placeholder or a blank', () => {
      for (const cell_phone of ['Info Requested', '', null]) {
        const m = mapAttendee(attendee({ profile: { cell_phone } }), facts, config, 'Registered');
        expect(m.columnValues).not.toHaveProperty('att_phone_col');
      }
      const m = mapAttendee(attendee({ answers: [answer('Phone')] }), facts, config, 'Registered');
      expect(m.columnValues).not.toHaveProperty('att_phone_col');
    });
  });

  it('copes with no profile and no class facts', () => {
    const m = mapAttendee({ id: 'a2' }, { eventName: 'Bike Class', classDate: null, classDay: null, classLocation: '', program: null }, config, 'Registered');
    expect(m.itemName).toBe('Eventbrite attendee a2');
    expect(m.columnValues).not.toHaveProperty('att_class_date_col');
    expect(m.columnValues).not.toHaveProperty('att_first_col');
    expect(m.columnValues.att_role_col).toBe('Participant');
  });

  describe('Home Zip', () => {
    const answers = (answer: unknown) => [{ question: 'Home ZIP code', question_id: '9', type: 'text', answer: answer as string | null }];

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

    describe('Home County', () => {
      const county = (answer: string, change: (c: ReturnType<typeof testConfig>) => void = () => {}) => {
        const cfg = testConfig();
        cfg.attendeeSync.zipCounty = { lists: { 'Santa Clara': ['95112'] }, overrides: {} };
        change(cfg);
        return mapAttendee(attendee({ answers: answers(answer) }), facts, cfg, 'Registered').columnValues;
      };

      it('is written with the zip', () => {
        expect(county('95112')).toMatchObject({ att_zip_col: '95112', att_county_col: 'Santa Clara' });
      });

      it('is cleared when the zip is on no list, so the pair never disagrees', () => {
        expect(county('10001')).toMatchObject({ att_zip_col: '10001', att_county_col: '' });
      });

      it('is left alone when there is no zip', () => {
        expect(county('call me')).not.toHaveProperty('att_county_col');
      });

      it('is not written while its column is the placeholder', () => {
        expect(county('95112', (c) => { c.attendeeSync.registrations.homeCountyColumn = PLACEHOLDER_COLUMN_ID; })).not.toHaveProperty(PLACEHOLDER_COLUMN_ID);
      });
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
