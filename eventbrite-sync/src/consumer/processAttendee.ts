import { PLACEHOLDER_COLUMN_ID } from '../config';
import { attendanceFromEventbrite, mapAttendee, mergeAttendance } from '../mapping/attendee';
import { mapEvent } from '../mapping/event';
import { matchPerson } from '../matching/people';
import { isItemGone } from '../monday/itemGone';
import type { AttendeeQueueMessage, ProcessBatchDeps } from './processBatch';

// Fetch the attendee from Eventbrite (never trust the delivery) and upsert its Event Registrations
// item. Attendance is the one column staff also edit, so it is read back from Monday and merged:
// the Worker only moves Registered forward and never downgrades what staff or the follow-up job set.
export async function processAttendee(message: AttendeeQueueMessage, deps: ProcessBatchDeps): Promise<void> {
  const { eventStore, attendeeStore, queue, eventbriteClient, mondayClient, config } = deps;
  const { eventId, attendeeId } = message;
  const row = await attendeeStore.getAttendee(attendeeId);
  if (row === null) {
    throw new Error(`eventbrite-sync consumer: no attendees row for "${attendeeId}"`);
  }

  const boardId = config.monday.boards['event-registrations'];
  if (boardId === null) {
    throw new Error('config: monday.boards["event-registrations"] is not configured');
  }
  const cols = config.attendeeSync.registrations;
  // The idempotency key: without it nothing may be created, as for orders and events.
  if (cols.attendeeIdColumn === PLACEHOLDER_COLUMN_ID) {
    throw new Error('config: attendeeSync.registrations.attendeeIdColumn is the placeholder — set the real "Eventbrite Attendee ID" column id on the Event Registrations board before any attendee can be written');
  }

  // The registration links to its Events item, so that item must exist first. Ask for it and retry:
  // the event consumer writes it, and the retry finds it. recordDelivery first, because it is the
  // upsert that guarantees the ledger row processEvent requires.
  const eventRow = await eventStore.getEvent(eventId);
  if (eventRow === null || eventRow.mondayItemId === null) {
    await eventStore.recordDelivery({ eventId, action: 'attendee.updated', receivedAt: new Date().toISOString() });
    await queue.send({ kind: 'event', eventId, action: 'attendee.updated' });
    throw new Error(`eventbrite-sync consumer: event "${eventId}" has no Events item yet; requested it, will retry attendee "${attendeeId}"`);
  }

  const attendee = await eventbriteClient.getAttendee(eventId, attendeeId);
  if (attendee === null) {
    console.warn(`eventbrite-sync consumer: attendee "${attendeeId}" not found in Eventbrite (HTTP 404); marking failed without retry`);
    await attendeeStore.updateStatus(attendeeId, 'failed', { error: 'attendee not found in Eventbrite (HTTP 404)' });
    return;
  }
  const event = await eventbriteClient.getEvent(eventId);
  if (event === null) {
    console.warn(`eventbrite-sync consumer: event "${eventId}" not found in Eventbrite (HTTP 404); marking attendee "${attendeeId}" failed without retry`);
    await attendeeStore.updateStatus(attendeeId, 'failed', { error: 'event not found in Eventbrite (HTTP 404)' });
    return;
  }

  // Adopt before create: the ledger's item id short-circuits the lookup; a miss on both means create.
  let mondayItemId = row.mondayItemId;
  if (mondayItemId === null) {
    const existing = await mondayClient.findItemByColumnValue(boardId, cols.attendeeIdColumn, attendeeId);
    if (existing) mondayItemId = existing.id;
  }

  const goneReason = (id: string) => `Event Registrations item ${id} was deleted or archived; nothing written`;
  const markGone = async (id: string) => {
    const reason = goneReason(id);
    console.warn(`eventbrite-sync consumer: attendee "${attendeeId}": ${reason}`);
    await attendeeStore.updateStatus(attendeeId, 'failed', { error: reason });
  };

  let currentAttendance: string | null = null;
  if (mondayItemId !== null) {
    const [current] = await mondayClient.getItems(boardId, [mondayItemId], [cols.attendanceColumn]);
    if (current === undefined) {
      // Staff deleted the item: recreating it would resurrect a registration removed on purpose.
      await markGone(mondayItemId);
      return;
    }
    currentAttendance = current.columns[cols.attendanceColumn]?.trim() || null;
  }

  const attendance = mergeAttendance(currentAttendance, attendanceFromEventbrite(attendee));
  const mapping = mapAttendee(attendee, mapEvent(event, config), config, attendance);
  const columnValues = { ...mapping.columnValues, [cols.eventLinkColumn]: { item_ids: [Number(eventRow.mondayItemId)] } };

  // People only once they have actually attended (spec decision D). Cached on the ledger so retries
  // and later updates don't match again; a match failure throws, as for donors.
  let personItemId = row.matchedPersonItemId;
  if (attendance === 'Attended' && personItemId === null) {
    const peopleBoardId = config.monday.boards['people-live'];
    if (peopleBoardId === null) {
      throw new Error('config: monday.boards["people-live"] is not configured');
    }
    const match = await matchPerson(mondayClient, peopleBoardId, config.attendeeSync.peopleEmailColumn, { email: attendee.profile?.email, name: attendee.profile?.name });
    if (match.donorItemId === null) {
      console.warn(`eventbrite-sync consumer: attendee "${attendeeId}" has no People link: ${match.reason}`);
    } else {
      personItemId = match.donorItemId;
      await attendeeStore.updateStatus(attendeeId, 'queued', { matchedPersonItemId: personItemId });
    }
  }
  if (attendance === 'Attended' && personItemId !== null) {
    columnValues[cols.attendeeLinkColumn] = { item_ids: [Number(personItemId)] };
  }

  const writtenAt = new Date().toISOString();
  const person = personItemId === null ? {} : { matchedPersonItemId: personItemId };
  if (mondayItemId !== null) {
    try {
      await mondayClient.changeColumnValues(boardId, mondayItemId, columnValues);
    } catch (err) {
      if (!isItemGone(err)) throw err;
      await markGone(mondayItemId);
      return;
    }
    await attendeeStore.updateStatus(attendeeId, 'written', { ...person, mondayItemId, writtenAt });
    return;
  }

  const item = await mondayClient.createItem(boardId, mapping.itemName, columnValues);
  await attendeeStore.updateStatus(attendeeId, 'written', { ...person, mondayItemId: item.id, writtenAt });
}
