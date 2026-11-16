// Which volunteer records count as membership activity (spec 2026-10-09 "Qualifying
// activities"). Pure, like derive.ts: the consumer and the custodian both call these with
// what they read; nothing here does I/O.
import type { VolunteerBoardConfig, HistoricalVolunteerBoardConfig } from '../types';

// Monday's `text` for a numbers column: '' when blank. Anything that isn't a plain decimal
// reads as blank — a typo in Hours must never cost a checked-in volunteer their membership
// (blank = one hour by decision). A real 0 is a real 0 and does not qualify.
export function parseHours(text: string | null): number | null {
  if (text === null) return null;
  const t = text.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

export interface RegistrationFacts {
  attendeeItemId: string | null;
  attendanceLabel: string | null;
  roleLabel: string | null;
  hours: number | null;
}

export function registrationQualifies(reg: RegistrationFacts, eventStartISO: string | null, board: VolunteerBoardConfig): boolean {
  return reg.attendeeItemId !== null
    && eventStartISO !== null
    && reg.roleLabel !== null && board.volunteerRoleLabels.includes(reg.roleLabel)
    && reg.attendanceLabel !== null && board.countedAttendanceLabels.includes(reg.attendanceLabel)
    && (reg.hours === null || reg.hours >= 1);
}

export interface HistoricalShiftFacts {
  volunteerItemId: string | null;
  dateISO: string | null;
  hours: number | null;
  statusLabel: string | null;
  historical?: boolean;
}

// The 2014-2020 Volunteers board recorded real hours, so blank there is blank, not one. Rows
// added since (Eventbrite sign-ups, no hours) are not Historical: when the board config names
// the Historical checkbox, those count on a counted status, a Volunteer link and a date alone.
// Without that column every row needs Hours >= 1, as before.
export function historicalShiftQualifies(shift: HistoricalShiftFacts, board: HistoricalVolunteerBoardConfig): boolean {
  const hoursOk = (board.columns.historical !== undefined && shift.historical !== true)
    || (shift.hours !== null && shift.hours >= 1);
  return shift.volunteerItemId !== null
    && shift.dateISO !== null
    && shift.statusLabel !== null && board.countedStatusLabels.includes(shift.statusLabel)
    && hoursOk;
}
