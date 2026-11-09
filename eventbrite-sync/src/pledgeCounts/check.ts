import type { EventbriteAttendeeCounter } from '../eventbrite/client';

// Nothing else notices a pledge the webhook never delivered, and the MTC report rests on this number.
// So once a day, on the missed-order check's hour, compare Eventbrite's attendee total with the
// ledger for each pledge campaign. Both totals include canceled attendees. An ended campaign stops
// changing, so it's left alone after this long.
const ENDED_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface PledgeCountDeps {
  counter: EventbriteAttendeeCounter;
  ledger: { countByEvent(eventId: string): Promise<number> };
  events: { getEvent(eventId: string): Promise<{ endsAt: string | null } | null> };
  eventIds: string[];
}

export interface PledgeCountResult {
  eventId: string;
  eventbrite: number;
  ledger: number;
}

export async function checkPledgeCounts(now: Date, deps: PledgeCountDeps): Promise<PledgeCountResult[]> {
  const results: PledgeCountResult[] = [];
  for (const eventId of deps.eventIds) {
    const endsAt = (await deps.events.getEvent(eventId))?.endsAt ?? null;
    if (endsAt !== null && now.getTime() - Date.parse(endsAt) > ENDED_WINDOW_MS) continue;
    results.push({ eventId, eventbrite: await deps.counter.countAttendees(eventId), ledger: await deps.ledger.countByEvent(eventId) });
  }
  return results;
}

// One line per campaign for Workers Logs; a difference is an error so Workers Issues raises it.
export function logPledgeCounts(results: PledgeCountResult[]): void {
  for (const { eventId, eventbrite, ledger } of results) {
    if (eventbrite === ledger) {
      console.log(`eventbrite-sync pledge counts: event "${eventId}" matches at ${ledger}`);
      continue;
    }
    console.error(
      `eventbrite-sync pledge counts: event "${eventId}" has ${eventbrite} attendees in Eventbrite and ${ledger} in the ledger. ` +
        'A small difference may still be in flight, so look again tomorrow. Otherwise check the webhook in Eventbrite, then re-drive with scripts/backfill-attendees.mjs'
    );
  }
}
