// What the Education Tracker job reads and plans with. Dates are Pacific 'YYYY-MM-DD', or ''.

export interface Totals {
  registered: number;
  checkedIn: number;
  noShows: number;
}

// A row of the tracker board. A null cell is blank, which is not 0.
export interface TrackerRow {
  itemId: string;
  date: string;
  status: string;
  funder: string;
  eventItemIds: string[];
  cells: { [K in keyof Totals]: number | null };
}

// The Events item a row links to.
export interface TrackerEvent {
  itemId: string;
  active: boolean;
  eventbriteId: string;
  program: string;
  status: string;
  date: string;
  end: string;
  grant: string;
}

// `no` comes only from data that was read. `unknown` (the event wasn't in the read) changes nothing.
export type Verdict = { kind: 'ok'; event: TrackerEvent } | { kind: 'no'; reason: string } | { kind: 'unknown' };
