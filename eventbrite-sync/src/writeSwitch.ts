// eventbrite-sync's side of the write switch (src/flags.ts, spec 2026-10-26): the dry-run versions
// of the consumer's and the ended-event sweep's deps. The business logic runs unchanged against them, so a dry run fetches,
// maps and matches exactly as a live run would; only the last step — the Monday write or the D1
// bookkeeping that records it — is swapped out here. The Eventbrite client is GET-only and passes
// through untouched.
import { DEFAULT_PII_KEYS, readOnlyProxy, recordingProxy, type SkipContext } from './flags';
import type { OrderStore } from './db/orders';
import type { EventStore } from './db/events';
import type { AttendeeStore } from './db/attendees';
import type { MondayClient, MondayItem } from './monday/client';
import type { ConsumerQueue, ProcessBatchDeps, WriteQueueMessage } from './consumer/processBatch';
import type { EndedEventSweepDeps } from './endedEvents/sweep';
import type { EventbriteSyncConfig, EventRow, MondayBoards } from './types';
import { PLACEHOLDER_COLUMN_ID } from './config';
import { EVENT_NOT_FOUND_ERROR } from './consumer/processEvent';

// Debug skip lines key Monday values by column id, which DEFAULT_PII_KEYS can't recognize as names.
export function piiKeysFor(config: EventbriteSyncConfig): readonly string[] {
  const { donorFirstNameColumn, donorLastNameColumn } = config.eventbriteSync;
  const { homeZipColumn } = config.attendeeSync.registrations;
  const zip = homeZipColumn === PLACEHOLDER_COLUMN_ID ? [] : [homeZipColumn.toLowerCase()];
  return [...DEFAULT_PII_KEYS, donorFirstNameColumn.toLowerCase(), donorLastNameColumn.toLowerCase(), ...zip];
}

// Everything a skip line needs except the delivery, which is per message.
export type BatchSkipContext = Omit<SkipContext, 'deliveryId'>;

// Each Monday write is logged under the board it targets, so a skip line says which write in the
// People → Donations chain it was.
const SINK_NAMES: Record<keyof MondayBoards, string> = {
  'donations:live': 'Donations',
  'people-live': 'People',
  events: 'Events',
  'event-registrations': 'Event Registrations',
  volunteers: 'Volunteers',
  'pledge-to-ride': 'Pledge to Ride',
};

// The ledger writes a dry run must not make: a placeholder item id stored here (matched_donor_item_id
// or monday_item_id) would survive the flip back to `on`, a Donation "already written" or a donor
// "already matched" to an item that doesn't exist. `recordDelivery` is the webhook's, never reached
// through the consumer's deps; it is listed so the proxy is complete.
const ORDER_STORE_MUTATORS = ['recordDelivery', 'updateStatus'] as const;
// The same for the events and attendees ledgers (monday_item_id, matched_person_item_id, and the
// start/location baseline processEvent compares against).
const EVENT_STORE_MUTATORS = ['recordDelivery', 'updateStatus'] as const;
const ATTENDEE_STORE_MUTATORS = ['recordDelivery', 'updateStatus'] as const;

// The Events item id a dry-run attendee links to when its event has no item yet (or no ledger row
// at all). Under `on` the event consumer would have written that item first (processAttendee asks
// for it and retries); a dry run never records one, so without this every dry-run attendee of a new
// class would request its event and retry on the queue for days instead of logging its registration.
export const DRY_RUN_EVENT_ITEM_ID = 'dry-run-event';

/**
 * A MondayClient that forwards reads and records each create/update as a skip line under its
 * board's sink name. A create resolves to a placeholder `{ id: 'dry-run-N' }` (N counted per
 * board) so a chained write can still link to it; nothing persists that id (the store below).
 */
export function dryRunMondayClient(client: MondayClient, boards: MondayBoards, ctx: SkipContext): MondayClient {
  const proxies = new Map<string, MondayClient>();
  // A pledge's values are free text and home zips under ids the key-based redaction can't recognize,
  // so even a debug skip line leaves them out.
  const isPledgeBoard = (boardId: number) => boards['pledge-to-ride'] === boardId;
  const sinkFor = (boardId: number): MondayClient => {
    const key = (Object.keys(SINK_NAMES) as (keyof MondayBoards)[]).find((k) => boards[k] === boardId);
    const sink = key ? SINK_NAMES[key] : `Monday board ${boardId}`;
    let proxy = proxies.get(sink);
    if (!proxy) {
      proxy = recordingProxy(client, sink, {
        createItem: function (): MondayItem {
          return { id: `dry-run-${this.n}` };
        },
        changeColumnValues: undefined,
      }, ctx);
      proxies.set(sink, proxy);
    }
    return proxy;
  };
  const updates = recordingProxy(client, 'Monday update', { postUpdate: undefined }, ctx);
  const timeline = recordingProxy(client, 'Monday timeline', {
    createTimelineItem: function (): string {
      return `dry-run-${this.n}`;
    },
  }, ctx);
  return {
    findItemByColumnValue: (boardId, columnId, value) => client.findItemByColumnValue(boardId, columnId, value),
    getItems: (boardId, itemIds, columnIds) => client.getItems(boardId, itemIds, columnIds),
    postUpdate: (itemId, body) => updates.postUpdate(itemId, body),
    createTimelineItem: (input) => timeline.createTimelineItem(input),
    createItem: (boardId, itemName, columnValues, options) =>
      isPledgeBoard(boardId) ? sinkFor(boardId).createItem(boardId, '', {}) : sinkFor(boardId).createItem(boardId, itemName, columnValues, options),
    changeColumnValues: (boardId, itemId, columnValues, options) =>
      isPledgeBoard(boardId) ? sinkFor(boardId).changeColumnValues(boardId, itemId, {}) : sinkFor(boardId).changeColumnValues(boardId, itemId, columnValues, options),
  };
}

export function dryRunOrderStore(store: OrderStore): OrderStore {
  return readOnlyProxy(store, ORDER_STORE_MUTATORS);
}

/**
 * The events ledger with every write dropped. With `placeholderItem` (an attendee message's dry
 * run), an event with no Events item yet — no ledger row, or a row that wasn't 404'd — reads as
 * linked to DRY_RUN_EVENT_ITEM_ID, so the registration write reaches the recording proxy and logs a
 * skip line.
 */
export function dryRunEventStore(store: EventStore, { placeholderItem }: { placeholderItem: boolean } = { placeholderItem: false }): EventStore {
  const readOnly = readOnlyProxy(store, EVENT_STORE_MUTATORS);
  if (!placeholderItem) return readOnly;
  return new Proxy(readOnly, {
    get: (target, prop, receiver) => {
      if (prop !== 'getEvent') return Reflect.get(target, prop, receiver);
      return async (eventId: string) => {
        const row = await target.getEvent(eventId);
        // No ledger row: the event's own delivery was dropped too (or never came). Live, processAttendee
        // would record one and request the event; here it reads as a placeholder-linked row instead.
        if (row === null) {
          return {
            eventId, mondayItemId: DRY_RUN_EVENT_ITEM_ID, startsAt: null, endsAt: null, locationKey: null, eventbriteStatus: null,
            status: 'queued', lastAction: 'attendee.updated', error: null, deliveries: 0, receivedAt: new Date().toISOString(), writtenAt: null,
          } satisfies EventRow;
        }
        // A 404'd event stays as it is: processAttendee stops on it, live or not.
        if (row.mondayItemId !== null || (row.status === 'failed' && (row.error ?? '').includes(EVENT_NOT_FOUND_ERROR))) return row;
        return { ...row, mondayItemId: DRY_RUN_EVENT_ITEM_ID };
      };
    },
  });
}

export function dryRunAttendeeStore(store: AttendeeStore): AttendeeStore {
  return readOnlyProxy(store, ATTENDEE_STORE_MUTATORS);
}

// The consumer's own sends (an event fanning out to its attendees, an attendee asking for its
// event) are recorded, not sent: under a dry run nothing downstream would be written either.
export function dryRunQueue(queue: ConsumerQueue, ctx: SkipContext): ConsumerQueue {
  return recordingProxy(queue, 'Write queue', { send: undefined, sendBatch: undefined }, ctx);
}

export function dryRunConsumerDeps(deps: ProcessBatchDeps, ctx: SkipContext, kind: NonNullable<WriteQueueMessage['kind']> = 'order'): ProcessBatchDeps {
  return {
    ...deps,
    orderStore: dryRunOrderStore(deps.orderStore),
    eventStore: dryRunEventStore(deps.eventStore, { placeholderItem: kind === 'attendee' }),
    attendeeStore: dryRunAttendeeStore(deps.attendeeStore),
    queue: dryRunQueue(deps.queue, ctx),
    mondayClient: dryRunMondayClient(deps.mondayClient, deps.config.monday.boards, ctx),
  };
}

// The ended-event sweep's deps under `off`: each event it would re-drive is a `Write queue` skip
// line and the ledger stays as it is. It has no cursor, so an ended event is logged again every
// hour until it ages out of the sweep's window.
export function dryRunEndedEventDeps(deps: EndedEventSweepDeps, ctx: SkipContext): EndedEventSweepDeps {
  return {
    eventStore: dryRunEventStore(deps.eventStore),
    queue: recordingProxy(deps.queue, 'Write queue', { send: undefined }, ctx),
  };
}
