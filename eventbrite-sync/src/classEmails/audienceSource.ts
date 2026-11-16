// Which Monday board and columns hold the people a class email goes to. Participants are Event
// Registrations items; Volunteers are Volunteers items once that board is configured, and Event
// Registrations items (Role = Volunteer) before then (the attendees ledger's item ids point at
// whichever board the event's attendees were written to).
import { volunteerBoardMode } from '../config';
import type { EventbriteSyncConfig } from '../types';
import type { AudienceRole } from './plan';

export interface AudienceSource {
  board: number | null;
  boardName: 'volunteers' | 'event-registrations';
  statusColumn: string;
  emailColumn: string;
  // The People link a thank-you fills in when blank.
  linkColumn: string;
  // The column a first name comes from, and how: a participant has a first-name column; a
  // volunteer's is the first word of the name column (blank stays blank, never the item name).
  firstNameColumn: string;
  firstNameOf: (text: string) => string;
  // A missed-you marks someone who was signed up but never checked in.
  signedUpStatus: string;
  noShowStatus: string;
}

export function audienceSource(config: EventbriteSyncConfig, audience: AudienceRole): AudienceSource {
  // Throws on a half-configured Volunteers board, so a volunteer event's emails fail loudly.
  if (audience === 'Volunteer' && volunteerBoardMode(config) === 'ready') {
    const v = config.attendeeSync.volunteers;
    return {
      board: config.monday.boards.volunteers, boardName: 'volunteers', statusColumn: v.statusColumn, emailColumn: v.attendeeEmailColumn,
      linkColumn: v.volunteerLinkColumn, firstNameColumn: v.attendeeNameColumn, firstNameOf: firstWord, signedUpStatus: 'RSVP', noShowStatus: 'No-Show',
    };
  }
  const r = config.attendeeSync.registrations;
  return {
    board: config.monday.boards['event-registrations'], boardName: 'event-registrations', statusColumn: r.attendanceColumn, emailColumn: r.attendeeEmailColumn,
    linkColumn: r.attendeeLinkColumn, firstNameColumn: r.firstNameColumn, firstNameOf: (text) => text.trim(), signedUpStatus: 'Registered', noShowStatus: 'No Show',
  };
}

export const firstWord = (name: string): string => name.trim().split(/\s+/)[0] ?? '';
