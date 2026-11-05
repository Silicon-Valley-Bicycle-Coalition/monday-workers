import { PLACEHOLDER_COLUMN_ID } from '../config';
import { isPlaceholderAttendee } from '../eventbrite/placeholder';
import { mapPledge } from '../mapping/pledge';
import { isActive } from '../monday/client';
import { MondayApiError } from '../monday/graphql';
import { isItemGone } from '../monday/itemGone';
import type { AttendeeRow, PledgeEventConfig } from '../types';
import type { AttendeeQueueMessage, ProcessBatchDeps } from './processBatch';

// New labels (a year's new choices, a new Year) appear on their own rather than failing the write.
const LABELS = { createLabelsIfMissing: true };

// An attendee of a pledge event: upsert its Pledge to Ride item from Eventbrite's current data. No
// Event link and no People link, so unlike processAttendee nothing else has to exist first.
export async function processPledge(message: AttendeeQueueMessage, event: PledgeEventConfig, row: AttendeeRow, deps: ProcessBatchDeps): Promise<void> {
  const { attendeeStore, eventbriteClient, mondayClient, config } = deps;
  const { eventId, attendeeId } = message;
  const pledge = config.pledge;
  const boardId = config.monday.boards['pledge-to-ride'];
  if (pledge === undefined || boardId === null || boardId === undefined) {
    throw new Error('config: monday.boards["pledge-to-ride"] is not configured');
  }
  // The idempotency key: without it nothing may be created, as for orders and events.
  if (pledge.columns.attendeeIdColumn === PLACEHOLDER_COLUMN_ID) {
    throw new Error('config: pledge.columns.attendeeIdColumn is the placeholder — run scripts/setup-pledge-board.mjs and set the real column ids before any pledge can be written');
  }

  const attendee = await eventbriteClient.getAttendee(eventId, attendeeId);
  if (attendee === null) {
    console.warn(`eventbrite-sync consumer: attendee "${attendeeId}" not found in Eventbrite (HTTP 404); marking failed without retry`);
    await attendeeStore.updateStatus(attendeeId, 'failed', { error: 'attendee not found in Eventbrite (HTTP 404)' });
    return;
  }

  // A placeholder has only its order's buyer to go on. No buyer still writes: it's a pledge.
  const buyer = isPlaceholderAttendee(attendee.profile) && typeof attendee.order_id === 'string' ? await eventbriteClient.getOrder(attendee.order_id) : null;
  const mapping = mapPledge(attendee, buyer, event, pledge);

  let mondayItemId = row.mondayItemId;
  if (mondayItemId === null) {
    const existing = await mondayClient.findItemByColumnValue(boardId, pledge.columns.attendeeIdColumn, attendeeId);
    if (existing) mondayItemId = existing.id;
  }

  const markGone = async (id: string) => {
    const reason = `Pledge to Ride item ${id} was deleted or archived; nothing written`;
    console.warn(`eventbrite-sync consumer: attendee "${attendeeId}": ${reason}`);
    await attendeeStore.updateStatus(attendeeId, 'failed', { error: reason });
  };

  const writtenAt = new Date().toISOString();
  if (mondayItemId === null) {
    const item = await mondayClient.createItem(boardId, mapping.itemName, mapping.columnValues, LABELS).catch((err: unknown) => {
      throw scrubbed(err);
    });
    await attendeeStore.updateStatus(attendeeId, 'written', { mondayItemId: item.id, writtenAt });
    return;
  }

  const [current] = await mondayClient.getItems(boardId, [mondayItemId], [pledge.columns.attendeeIdColumn]);
  if (!isActive(current)) {
    await markGone(mondayItemId);
    return;
  }
  try {
    await mondayClient.changeColumnValues(boardId, mondayItemId, { ...mapping.columnValues, name: mapping.itemName }, LABELS);
  } catch (err) {
    if (!isItemGone(err)) throw scrubbed(err);
    await markGone(mondayItemId);
    return;
  }
  await attendeeStore.updateStatus(attendeeId, 'written', { mondayItemId, writtenAt });
}

// Monday's message can echo the value it refused, here a person's answer, and it goes on to the logs
// and the ledger's error column. Same error otherwise, so it's classified as terminal or not as usual.
function scrubbed(err: unknown): unknown {
  if (err instanceof MondayApiError) {
    err.message = `Monday refused a pledge write (code ${err.code ?? 'none'}, HTTP ${err.httpStatus ?? 'none'})`;
  }
  return err;
}
