// Rows the first production load marked Upcoming though they were already over: the transform took
// Eventbrite's `started` at face value (fixed in transform/boards.ts). Used once, by
// scripts/complete-past-upcoming-events.ts. Dates are the board's plain YYYY-MM-DD text.
export interface UpcomingEvent { id: string; name: string; status: string; date: string; end: string }

export function classifyUpcomingEvents(rows: UpcomingEvent[], todayISO: string): {
  complete: UpcomingEvent[]; keep: UpcomingEvent[]; undated: UpcomingEvent[];
} {
  const out = { complete: [] as UpcomingEvent[], keep: [] as UpcomingEvent[], undated: [] as UpcomingEvent[] };
  for (const row of rows) {
    if (row.status !== 'Upcoming') continue;
    const lastDay = row.end || row.date;
    if (!lastDay) out.undated.push(row);
    else if (lastDay < todayISO) out.complete.push(row);
    else out.keep.push(row);
  }
  return out;
}
