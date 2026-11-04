import type { EventStore } from '../db/events';
import type { EventQueueMessage } from '../consumer/processBatch';
import type { EventRow } from '../types';
import { errorMessage } from '../util/errorMessage';

const DAY_MS = 24 * 60 * 60 * 1000;

// How far back an ended event is still corrected. Longer than any `hold` we expect, so the first
// `on` run catches what a hold skipped; beyond it, re-drive with scripts/backfill-attendees.mjs.
const WINDOW_DAYS = 30;

// The statuses mapEvent turns into Upcoming: the rows that can still read Upcoming on Monday.
const OPEN_STATUSES = new Set(['live', 'started']);

// Marks the ledger row and the queue message; the consumer re-fetches, so nothing depends on it.
const ACTION = 'event.ended';

export interface EndedEventSweepDeps {
  eventStore: EventStore;
  queue: { send(message: EventQueueMessage): Promise<void> };
}

export interface EndedEventSweepResult {
  queued: string[];
  // The row went back to `written` (or the failure is logged), so the next hourly run retries.
  failed: string[];
}

// Nothing we can find in Eventbrite's docs promises a delivery when an event ends, so nothing is sure
// to revisit an event's Upcoming once its end passes. written_at before ends_at is the run-once guard: the last write predates the end,
// so it can't have been Completed, and the consumer's own write clears it — as does any real
// delivery, which leaves this sweep nothing to do. `written` only: `received`/`queued` is already on
// its way, `failed` is waiting for a human, and a row an `off` delivery left `queued` stays dropped.
function needsRedrive(row: EventRow): boolean {
  return row.status === 'written'
    && OPEN_STATUSES.has(row.eventbriteStatus ?? '')
    && row.endsAt !== null
    && row.writtenAt !== null
    && row.writtenAt < row.endsAt; // Both are toISOString, as listEndedBetween relies on for ends_at.
}

// Re-drives each such event through the queue like a webhook delivery, rather than writing Completed
// here: the consumer fetches Eventbrite first, so a class canceled or moved since is written as
// that, and a failed write gets the queue's retries and dead-letter queue.
export async function sweepEndedEvents(now: Date, deps: EndedEventSweepDeps): Promise<EndedEventSweepResult> {
  const from = new Date(now.getTime() - WINDOW_DAYS * DAY_MS).toISOString();
  const rows = await deps.eventStore.listEndedBetween(from, now.toISOString());

  const result: EndedEventSweepResult = { queued: [], failed: [] };
  for (const row of rows) {
    if (!needsRedrive(row)) continue;
    try {
      await redrive(row.eventId, now, deps);
      result.queued.push(row.eventId);
    } catch (err) {
      console.error(`eventbrite-sync ended events: event "${row.eventId}" failed: ${errorMessage(err)}`);
      result.failed.push(row.eventId);
    }
  }
  return result;
}

async function redrive(eventId: string, now: Date, deps: EndedEventSweepDeps): Promise<void> {
  await deps.eventStore.recordDelivery({ eventId, action: ACTION, receivedAt: now.toISOString() });
  try {
    await deps.queue.send({ kind: 'event', eventId, action: ACTION });
  } catch (err) {
    // Unlike a webhook delivery, nobody redelivers this one: back to `written` so the next run does.
    await deps.eventStore.updateStatus(eventId, 'written');
    throw err;
  }
  await deps.eventStore.updateStatus(eventId, 'queued');
}
