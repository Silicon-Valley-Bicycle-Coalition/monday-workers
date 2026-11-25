import type { Totals, TrackerRow } from './types';

// What the Worker last wrote to a tracker row (D1 tracker_counts).
export interface TrackerRecord {
  trackerItemId: string;
  eventItemId: string;
  // The row's Date when they were written: what it freezes by, whatever the Date says later.
  date: string;
  totals: Totals;
}

// What a row should show. `hold`: the event's registrations aren't all written yet. `unknown`: its
// event couldn't be read.
export type Desired =
  | { kind: 'totals'; eventItemId: string; totals: Totals }
  | { kind: 'none' }
  | { kind: 'hold'; eventItemId: string }
  | { kind: 'unknown' };

// `clear` also drops the record. `remember` and `forget` change only the record.
export type RowAction =
  | { kind: 'nothing' }
  | { kind: 'write'; eventItemId: string; totals: Totals }
  | { kind: 'remember'; eventItemId: string; totals: Totals }
  | { kind: 'clear' }
  | { kind: 'forget' };

const KEYS = ['registered', 'checkedIn', 'noShows'] as const;

export function hasNumbers(cells: TrackerRow['cells']): boolean {
  return KEYS.some((key) => cells[key] !== null);
}

export function sameNumbers(a: TrackerRow['cells'], b: TrackerRow['cells']): boolean {
  return KEYS.every((key) => a[key] === b[key]);
}

/**
 * An event's totals from its registrations' Attendance, or null when nobody attended: attendance
 * probably wasn't taken, and Registered alone would make the tracker's formula show everyone as
 * canceled. A cancellation counts only in Registered, so that formula comes out right.
 */
export function computeTotals(attendance: string[]): Totals | null {
  const checkedIn = attendance.filter((a) => a === 'Attended').length;
  if (checkedIn === 0) return null;
  const canceled = attendance.filter((a) => a === 'Canceled').length;
  return { registered: attendance.length, checkedIn, noShows: attendance.length - checkedIn - canceled };
}

/**
 * The one change to make to a row. A row with any number the Worker didn't write is a person's, and
 * all three cells are left alone, because the tracker's formula mixes them.
 */
export function planRow(cells: TrackerRow['cells'], record: TrackerRecord | null, desired: Desired, frozen: boolean): RowAction {
  if (frozen || desired.kind === 'unknown') return { kind: 'nothing' };
  if (KEYS.some((key) => cells[key] !== null && cells[key] !== record?.totals[key])) return { kind: 'nothing' };

  if (desired.kind === 'totals') {
    const { eventItemId, totals } = desired;
    if (!sameNumbers(cells, totals)) return { kind: 'write', eventItemId, totals };
    return record?.eventItemId === eventItemId ? { kind: 'nothing' } : { kind: 'remember', eventItemId, totals };
  }
  if (record === null) return { kind: 'nothing' };
  // Another class's numbers never wait for this one's feed.
  if (desired.kind === 'hold' && record.eventItemId === desired.eventItemId) return { kind: 'nothing' };
  return hasNumbers(cells) ? { kind: 'clear' } : { kind: 'forget' };
}
