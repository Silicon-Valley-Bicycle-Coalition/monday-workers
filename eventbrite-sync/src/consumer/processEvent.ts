import { PLACEHOLDER_COLUMN_ID } from '../config';
import { mapEvent } from '../mapping/event';
import { isItemGone } from '../monday/itemGone';
import type { AttendeeQueueMessage, EventQueueMessage, ProcessBatchDeps } from './processBatch';
import { stampOf } from './messages';
import { sendInBatches } from '../util/sendBatch';

// The events row's error when Eventbrite 404s the event. processAttendee reads it to stop asking
// for an event that will never come.
export const EVENT_NOT_FOUND_ERROR = 'event not found in Eventbrite (HTTP 404)';

// Fetch the event from Eventbrite (never trust the delivery), upsert its Events board item, and,
// when the class moved, fan out one attendee message per registration so their copied class
// date, day and location are corrected.
export async function processEvent(message: EventQueueMessage, deps: ProcessBatchDeps): Promise<void> {
  const { eventStore, attendeeStore, queue, eventbriteClient, mondayClient, config } = deps;
  const eventId = message.eventId;
  const row = await eventStore.getEvent(eventId);
  if (row === null) {
    throw new Error(`eventbrite-sync consumer: no events row for "${eventId}"`);
  }

  const boardId = config.monday.boards.events;
  if (boardId === null) {
    throw new Error('config: monday.boards["events"] is not configured');
  }
  const { eventbriteIdColumn } = config.attendeeSync.events;
  // The idempotency key: without it nothing may be created, as for orders.
  if (eventbriteIdColumn === PLACEHOLDER_COLUMN_ID) {
    throw new Error('config: attendeeSync.events.eventbriteIdColumn is the placeholder — set the real "Eventbrite ID" column id on the Events board before any event can be written');
  }

  const event = await eventbriteClient.getEvent(eventId);
  if (event === null) {
    console.warn(`eventbrite-sync consumer: event "${eventId}" not found in Eventbrite (HTTP 404); marking failed without retry`);
    await eventStore.updateStatus(eventId, 'failed', { error: EVENT_NOT_FOUND_ERROR });
    return;
  }

  let mondayItemId = row.mondayItemId;
  if (mondayItemId === null) {
    const existing = await mondayClient.findItemByColumnValue(boardId, eventbriteIdColumn, eventId);
    if (existing) {
      mondayItemId = existing.id;
    }
  }

  const mapping = mapEvent(event, config);
  const facts = {
    ...(mapping.startsAt !== null && { startsAt: mapping.startsAt }),
    ...(mapping.endsAt !== null && { endsAt: mapping.endsAt }),
    locationKey: mapping.locationKey,
    ...(event.status != null && { eventbriteStatus: event.status }),
  };

  if (mondayItemId !== null) {
    try {
      // `name` is the item name: keeps it in step when the class is renamed in Eventbrite (only a
      // real name, never the "Eventbrite event <id>" fallback). A create names it via item_name.
      const rename = (event.name?.text ?? '').trim() !== '' ? { name: mapping.itemName } : {};
      await mondayClient.changeColumnValues(boardId, mondayItemId, { ...mapping.columnValues, ...rename });
    } catch (err) {
      if (!isItemGone(err)) throw err;
      // Staff deleted (or archived) the Events item. Recreating it would resurrect an event
      // someone removed on purpose, so record it and stop, for a human. Only the error is
      // written: the last written start/location stay as the baseline for a later replay.
      const reason = `Events item ${mondayItemId} was deleted or archived; nothing written`;
      console.warn(`eventbrite-sync consumer: event "${eventId}": ${reason}`);
      await eventStore.updateStatus(eventId, 'failed', { error: reason });
      return;
    }
  } else {
    const item = await mondayClient.createItem(boardId, mapping.itemName, mapping.columnValues);
    mondayItemId = item.id;
  }

  // Compared against what the last write recorded; a first write has nothing to compare, and
  // registrations only exist once there is an item to link to.
  const moved =
    (row.startsAt !== null && mapping.startsAt !== null && row.startsAt !== mapping.startsAt) ||
    (row.locationKey !== null && row.locationKey !== mapping.locationKey);
  if (moved) {
    // Before the ledger records the new values: if a send fails, the retry still sees the
    // change and fans out again (at-least-once; the attendee consumer is idempotent). In batches
    // of up to 100 (#75), not one send per registration: a big class stays a few calls.
    const fanOut = (await attendeeStore.listByEvent(eventId)).map(
      (attendee): AttendeeQueueMessage => ({ kind: 'attendee', eventId, attendeeId: attendee.attendeeId, action: 'event.updated', ...stampOf(message) })
    );
    await sendInBatches(queue, fanOut);
  }

  await eventStore.updateStatus(eventId, 'written', { ...facts, mondayItemId, writtenAt: new Date().toISOString() });
}
