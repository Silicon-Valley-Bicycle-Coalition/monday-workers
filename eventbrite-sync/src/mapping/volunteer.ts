import type { EventbriteAttendee } from '../eventbrite/client';
import { realEmail, realName } from '../eventbrite/placeholder';
import type { EventbriteSyncConfig } from '../types';
import type { EventFacts } from './attendee';

export type VolunteerStatus = 'RSVP' | 'Completed' | 'Canceled' | 'No-Show';

// The Volunteers board's Status vocabulary against the sync's attendance words (Registered, Attended,
// Canceled, No Show). Prospect and Confirmed are staff-only labels with no attendance equivalent.
const STATUS_BY_ATTENDANCE: Record<string, VolunteerStatus> = {
  Registered: 'RSVP', Attended: 'Completed', Canceled: 'Canceled', 'No Show': 'No-Show',
};
const ATTENDANCE_BY_STATUS: Record<string, string> = {
  RSVP: 'Registered', Completed: 'Attended', Canceled: 'Canceled', 'No-Show': 'No Show',
};

export function toVolunteerStatus(attendance: string): VolunteerStatus {
  return STATUS_BY_ATTENDANCE[attendance] ?? 'RSVP';
}

export function toAttendance(status: string): string | null {
  return ATTENDANCE_BY_STATUS[status] ?? null;
}

// Event, Eventbrite Listing and Volunteer are links the consumer sets, so they are never written here.
export function mapVolunteer(
  a: EventbriteAttendee,
  facts: EventFacts,
  config: EventbriteSyncConfig,
  attendance: string
): { itemName: string; columnValues: Record<string, unknown> } {
  const cols = config.attendeeSync.volunteers;
  const name = realName(a.profile?.name);
  const email = realEmail(a.profile?.email);

  const columnValues: Record<string, unknown> = {
    [cols.attendeeIdColumn]: a.id,
    [cols.statusColumn]: toVolunteerStatus(attendance),
    [cols.jobColumn]: facts.eventName,
    [cols.historicalColumn]: { checked: 'false' },
  };
  if (facts.classDate !== null) columnValues[cols.dateColumn] = { date: facts.classDate };
  if (name !== null) columnValues[cols.attendeeNameColumn] = name;
  if (email !== null) columnValues[cols.attendeeEmailColumn] = { email, text: email };

  return { itemName: name ?? `Eventbrite attendee ${a.id}`, columnValues };
}
