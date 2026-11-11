import type { EventbriteAttendee } from '../eventbrite/client';
import { realEmail, realName } from '../eventbrite/placeholder';
import type { EventbriteSyncConfig } from '../types';
import type { EventFacts } from './attendee';
import { toVolunteerStatus } from './volunteerStatus';

export { toAttendance, toVolunteerStatus, type VolunteerStatus } from './volunteerStatus';

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
