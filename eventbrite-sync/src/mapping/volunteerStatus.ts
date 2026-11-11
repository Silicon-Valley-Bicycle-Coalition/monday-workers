// The Volunteers board's Status vocabulary against the sync's attendance words (Registered, Attended,
// Canceled, No Show). Prospect and Confirmed are staff-only labels with no attendance equivalent.
// Import-free and strip-only TypeScript, so scripts/backfill-volunteers-lib.mjs can load it under
// Node's type stripping and map statuses exactly as the consumer does.
export type VolunteerStatus = 'RSVP' | 'Completed' | 'Canceled' | 'No-Show';

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
