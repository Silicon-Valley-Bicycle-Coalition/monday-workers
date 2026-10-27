import type { EventbriteAttendee } from '../eventbrite/client';
import type { EventbriteSyncConfig } from '../types';

export type Incoming = 'Registered' | 'Attended' | 'Canceled';

export interface EventFacts {
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

export function mapAttendee(
  a: EventbriteAttendee,
  eventFacts: EventFacts,
  config: EventbriteSyncConfig,
  attendance: string
): { itemName: string; columnValues: Record<string, unknown> } {
  const cols = config.attendeeSync.registrations;
  const name = nonEmpty(a.profile?.name);
  const email = nonEmpty(a.profile?.email);
  const firstName = nonEmpty(a.profile?.first_name);
  const volunteer = eventFacts.program !== null && config.attendeeSync.volunteerPrograms.includes(eventFacts.program);

  const columnValues: Record<string, unknown> = {
    [cols.attendeeIdColumn]: a.id,
    [cols.attendanceColumn]: attendance,
    [cols.sourceColumn]: 'Eventbrite',
    [cols.roleColumn]: volunteer ? 'Volunteer' : 'Participant',
  };
  if (name !== null) columnValues[cols.attendeeNameColumn] = name;
  if (email !== null) columnValues[cols.attendeeEmailColumn] = { email, text: email };
  if (firstName !== null) columnValues[cols.firstNameColumn] = firstName;
  if (eventFacts.classDate !== null) columnValues[cols.classDateColumn] = { date: eventFacts.classDate };
  if (eventFacts.classDay !== null) columnValues[cols.classDayColumn] = eventFacts.classDay;
  if (eventFacts.classLocation !== '') columnValues[cols.classLocationColumn] = eventFacts.classLocation;

  return { itemName: name ?? `Eventbrite attendee ${a.id}`, columnValues };
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}
