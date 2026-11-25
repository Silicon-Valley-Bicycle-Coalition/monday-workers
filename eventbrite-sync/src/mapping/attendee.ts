import { PLACEHOLDER_COLUMN_ID } from '../config';
import type { EventbriteAttendee } from '../eventbrite/client';
import { realEmail, realName } from '../eventbrite/placeholder';
import type { EventbriteSyncConfig } from '../types';
import { homeCounty } from './homeCounty';
import { homeZipFromAnswers } from './homeZip';

export type Incoming = 'Registered' | 'Attended' | 'Canceled';

export interface EventFacts {
  eventName: string;
  classDate: string | null;
  classDay: string | null;
  classLocation: string;
  program: string | null;
}

export function attendanceFromEventbrite(a: EventbriteAttendee): Incoming {
  if (a.checked_in) return 'Attended';
  if (a.cancelled || a.refunded) return 'Canceled';
  return 'Registered';
}

// Attendance is staff-editable on the board (No Show), so Eventbrite only moves it where it knows
// better: a check-in always wins (even over Canceled), a Registered signal never overwrites a
// staff-set No Show or Canceled, and a cancellation never un-attends someone already checked in.
export function mergeAttendance(current: string | null, incoming: Incoming): string {
  if (incoming === 'Attended') return 'Attended';
  if (current === null || current === 'Registered') return incoming;
  if (current === 'Attended') return 'Attended';
  if (incoming === 'Canceled') return 'Canceled';
  return current;
}

const PHONE_QUESTION = /phone|\bcell\b|celular|mobile|\bm[oó]vil\b|tel[eé]fono/i;
// A phone question about someone else: never the attendee's own number. Class forms ask for an
// emergency contact's, so a match here would show that person's number as the attendee's.
const OTHER_PERSON_QUESTION = /emergenc|guardian|parent|padre|madre|tutor/i;
// Enough digits to be a number: rules out "Info Requested" and "Yes" to "Do you have a cell phone?".
const MIN_PHONE_DIGITS = 7;

function realPhone(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.replace(/\D/g, '').length >= MIN_PHONE_DIGITS ? trimmed : null;
}

// An order form collects a phone as a built-in field (on the profile) or as a custom question (in
// answers), and each event's form is its own, so read both. Kept as entered, for a text column:
// Monday's phone column refuses what it can't parse, which would fail the whole registration write.
export function attendeePhone(a: EventbriteAttendee): string | null {
  const answers = (a.answers ?? [])
    .filter((answer) => PHONE_QUESTION.test(answer.question ?? '') && !OTHER_PERSON_QUESTION.test(answer.question ?? ''))
    .map((answer) => answer.answer);
  for (const value of [a.profile?.cell_phone, a.profile?.work_phone, ...answers]) {
    const phone = realPhone(value);
    if (phone !== null) return phone;
  }
  return null;
}

export function mapAttendee(
  a: EventbriteAttendee,
  eventFacts: EventFacts,
  config: EventbriteSyncConfig,
  attendance: string
): { itemName: string; columnValues: Record<string, unknown> } {
  const cols = config.attendeeSync.registrations;
  const name = realName(a.profile?.name);
  const email = realEmail(a.profile?.email);
  const firstName = realName(a.profile?.first_name);
  const volunteer = eventFacts.program !== null && config.attendeeSync.volunteerPrograms.includes(eventFacts.program);

  const columnValues: Record<string, unknown> = {
    [cols.attendeeIdColumn]: a.id,
    [cols.attendanceColumn]: attendance,
    [cols.sourceColumn]: 'Eventbrite',
    [cols.roleColumn]: volunteer ? 'Volunteer' : 'Participant',
  };
  if (name !== null) columnValues[cols.attendeeNameColumn] = name;
  if (email !== null) columnValues[cols.attendeeEmailColumn] = { email, text: email };
  const phone = attendeePhone(a);
  if (phone !== null && cols.attendeePhoneColumn !== PLACEHOLDER_COLUMN_ID) columnValues[cols.attendeePhoneColumn] = phone;
  if (firstName !== null) columnValues[cols.firstNameColumn] = firstName;
  if (eventFacts.classDate !== null) columnValues[cols.classDateColumn] = { date: eventFacts.classDate };
  if (eventFacts.classDay !== null) columnValues[cols.classDayColumn] = eventFacts.classDay;
  if (eventFacts.classLocation !== '') columnValues[cols.classLocationColumn] = eventFacts.classLocation;
  // Only a validated ZIP is written; an invalid answer leaves the key out, so a good value stays.
  if (eventFacts.program !== null && config.attendeeSync.zipPrograms.includes(eventFacts.program) && cols.homeZipColumn !== PLACEHOLDER_COLUMN_ID) {
    const zip = homeZipFromAnswers(a.answers);
    if (zip !== null) {
      columnValues[cols.homeZipColumn] = zip;
      // Blanked for a ZIP on no list, so it never shows an earlier ZIP's county.
      if (cols.homeCountyColumn !== PLACEHOLDER_COLUMN_ID) columnValues[cols.homeCountyColumn] = homeCounty(zip, config) ?? '';
    }
  }

  return { itemName: name ?? `Eventbrite attendee ${a.id}`, columnValues };
}
