// Which Monday board and columns hold the people a class email goes to. Participants are Event
// Registrations items; Volunteers are Volunteers items (the attendees ledger's item ids point at
// whichever board the event's attendees were written to).
import type { EventbriteSyncConfig } from '../types';
import type { AudienceRole } from './plan';

export interface AudienceSource {
  board: number | null;
  boardName: string;
  statusColumn: string;
  emailColumn: string;
  // The People link a thank-you fills in when blank.
  linkColumn: string;
  // Null: the first word of the item's name (a volunteer has no first-name column).
  firstNameColumn: string | null;
  // A missed-you marks someone who was signed up but never checked in.
  signedUpStatus: string;
  noShowStatus: string;
}

export function audienceSource(config: EventbriteSyncConfig, audience: AudienceRole): AudienceSource {
  if (audience === 'Volunteer') {
    const v = config.attendeeSync.volunteers;
    return {
      board: config.monday.boards.volunteers, boardName: 'volunteers', statusColumn: v.statusColumn, emailColumn: v.attendeeEmailColumn,
      linkColumn: v.volunteerLinkColumn, firstNameColumn: null, signedUpStatus: 'RSVP', noShowStatus: 'No-Show',
    };
  }
  const r = config.attendeeSync.registrations;
  return {
    board: config.monday.boards['event-registrations'], boardName: 'event-registrations', statusColumn: r.attendanceColumn, emailColumn: r.attendeeEmailColumn,
    linkColumn: r.attendeeLinkColumn, firstNameColumn: r.firstNameColumn, signedUpStatus: 'Registered', noShowStatus: 'No Show',
  };
}

export const firstWord = (name: string): string => name.trim().split(/\s+/)[0] ?? '';
