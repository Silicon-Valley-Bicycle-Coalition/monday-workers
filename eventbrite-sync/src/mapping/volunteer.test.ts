import { describe, it, expect } from 'vitest';
import { mergeAttendance } from './attendee';
import { mapVolunteer, toAttendance, toVolunteerStatus } from './volunteer';
import { testConfig } from '../test/testConfig';
import type { EventbriteAttendee } from '../eventbrite/client';

const config = testConfig();
const facts = { eventName: 'Trail Work Day', classDate: '2026-10-30', classDay: 'Friday', classLocation: 'online', program: 'Volunteering' as string | null };

function attendee(overrides: Partial<EventbriteAttendee> = {}): EventbriteAttendee {
  return { id: 'a1', profile: { name: 'Jane Rider', first_name: 'Jane', email: 'jane@example.com' }, ...overrides };
}

describe('toVolunteerStatus', () => {
  it.each([
    ['Registered', 'RSVP'],
    ['Attended', 'Completed'],
    ['Canceled', 'Canceled'],
    ['No Show', 'No-Show'],
  ])('maps %s to %s', (attendance, status) => expect(toVolunteerStatus(attendance)).toBe(status));

  it('treats an unknown attendance as RSVP', () => expect(toVolunteerStatus('Whatever')).toBe('RSVP'));
});

describe('toAttendance', () => {
  it.each([
    ['RSVP', 'Registered'],
    ['Completed', 'Attended'],
    ['Canceled', 'Canceled'],
    ['No-Show', 'No Show'],
  ])('maps %s to %s', (status, attendance) => expect(toAttendance(status)).toBe(attendance));

  it('returns null for Prospect, Confirmed and unknown labels', () => {
    expect(toAttendance('Prospect')).toBeNull();
    expect(toAttendance('Confirmed')).toBeNull();
    expect(toAttendance('Other')).toBeNull();
  });

  it('keeps a staff-set No-Show against a Registered signal', () => {
    expect(mergeAttendance(toAttendance('No-Show'), 'Registered')).toBe('No Show');
  });
});

describe('mapVolunteer', () => {
  it('writes the Volunteers columns', () => {
    const m = mapVolunteer(attendee(), facts, config, 'Attended');
    expect(m.itemName).toBe('Jane Rider');
    expect(m.columnValues).toEqual({
      vol_att_col: 'a1',
      vol_status_col: 'Completed',
      vol_job_col: 'Trail Work Day',
      vol_date_col: { date: '2026-10-30' },
      vol_hist_col: { checked: 'false' },
      vol_name_col: 'Jane Rider',
      vol_email_col: { email: 'jane@example.com', text: 'jane@example.com' },
    });
  });

  it('never sets the Event, Eventbrite Listing or Volunteer links', () => {
    const m = mapVolunteer(attendee(), facts, config, 'Registered');
    for (const key of ['vol_event_col', 'vol_listing_col', 'vol_person_col']) expect(m.columnValues).not.toHaveProperty(key);
  });

  it('omits the email and names the item by id for a placeholder attendee', () => {
    const m = mapVolunteer(attendee({ profile: { name: 'Info Requested', email: 'Info Requested' } }), facts, config, 'Registered');
    expect(m.itemName).toBe('Eventbrite attendee a1');
    expect(m.columnValues).not.toHaveProperty('vol_email_col');
    expect(m.columnValues).not.toHaveProperty('vol_name_col');
  });

  it('omits Date when the event has no class date', () => {
    const m = mapVolunteer(attendee(), { ...facts, classDate: null }, config, 'Registered');
    expect(m.columnValues).not.toHaveProperty('vol_date_col');
  });
});
