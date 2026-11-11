import { PLACEHOLDER_COLUMN_ID, volunteerBoardMode } from '../config';
import { realEmail, realName } from '../eventbrite/placeholder';
import { attendanceFromEventbrite, mapAttendee, mergeAttendance } from '../mapping/attendee';
import { mapEvent } from '../mapping/event';
import { matchPerson } from '../matching/people';
import { isActive, statusText } from '../monday/client';
import { isItemGone } from '../monday/itemGone';
import { TERMINAL_PREFIX, type AttendeeQueueMessage, type ProcessBatchDeps } from './processBatch';
import { EVENT_NOT_FOUND_ERROR } from './processEvent';
import { stampOf } from './messages';
import { processPledge } from './processPledge';
import { processVolunteer } from './processVolunteer';
import { linkedItemId } from '../util/itemId';

// Fetch the attendee from Eventbrite (never trust the delivery) and upsert its Event Registrations
// item. Attendance is the one column staff also edit, so it is read back from Monday and merged:
// the Worker only moves Registered forward and never downgrades what staff or a class email's No Show set.
export async function processAttendee(message: AttendeeQueueMessage, deps: ProcessBatchDeps): Promise<void> {
  const { eventStore, attendeeStore, queue, eventbriteClient, mondayClient, config } = deps;
  const { eventId, attendeeId } = message;
  const row = await attendeeStore.getAttendee(attendeeId);
  if (row === null) {
    throw new Error(`eventbrite-sync consumer: no attendees row for "${attendeeId}"`);
  }

  // First, before the Events-item wait: a pledge has no Event link, so it doesn't need that item.
  const pledgeEvent = config.pledge?.events[eventId];
  if (pledgeEvent !== undefined) return processPledge(message, pledgeEvent, row, deps);

  // The registration links to its Events item, so that item must exist first. Ask for it and retry:
  // the event consumer writes it, and the retry finds it. recordDelivery first, because it is the
  // upsert that guarantees the ledger row processEvent requires.
  const eventRow = await eventStore.getEvent(eventId);
  const eventError = eventRow?.status === 'failed' && eventRow.mondayItemId === null ? (eventRow.error ?? '') : '';
  if (eventError.includes(EVENT_NOT_FOUND_ERROR) || eventError.startsWith(TERMINAL_PREFIX)) {
    // The event failed for good — Eventbrite 404d it, or a deterministic 4xx (#75). Asking again
    // would fail the same way, and this attendee would retry its way to the dead-letter queue,
    // re-sending the event each time. Stop here, for a human.
    const reason = eventError.includes(EVENT_NOT_FOUND_ERROR)
      ? `event ${eventId} not found in Eventbrite (HTTP 404); attendee not written`
      : `event ${eventId} failed without retry (${eventError}); attendee not written`;
    console.warn(`eventbrite-sync consumer: attendee "${attendeeId}": ${reason}; marking failed without retry`);
    await attendeeStore.updateStatus(attendeeId, 'failed', { error: reason });
    return;
  }
  if (eventRow === null || eventRow.mondayItemId === null) {
    await eventStore.recordDelivery({ eventId, action: 'attendee.updated', receivedAt: new Date().toISOString() });
    await queue.send({ kind: 'event', eventId, action: 'attendee.updated', ...stampOf(message) });
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
    await attendeeStore.updateStatus(attendeeId, 'failed', { error: EVENT_NOT_FOUND_ERROR });
    return;
  }

  // Once the Volunteers board is configured, a volunteer event's sign-ups live there: hand off before
  // any Event Registrations column is read, and never fall back to writing a registration row. Until
  // then (legacy) they stay Event Registrations rows with Role = Volunteer; a half-configured board throws.
  const program = mapEvent(event, config, new Date()).program;
  if (program !== null && config.attendeeSync.volunteerPrograms.includes(program) && volunteerBoardMode(config) === 'ready') {
    return processVolunteer(message, { row, attendee, event, eventRow }, deps);
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
  let linkAlreadySet = false;
  let registrantsLinkSet = false;
  if (mondayItemId !== null) {
    const [current] = await mondayClient.getItems(boardId, [mondayItemId], [cols.attendanceColumn, cols.attendeeLinkColumn, cols.registrantsLinkColumn]);
    if (!isActive(current)) {
      // Staff deleted or archived the item (purged items are omitted; items(ids:) still returns
      // archived and deleted ones, with their state). Recreating or writing it would resurrect a
      // registration removed on purpose.
      await markGone(mondayItemId);
      return;
    }
    // By stored value, not text: an empty status cell's text is label id 5's (statusText).
    currentAttendance = statusText(current, cols.attendanceColumn) || null;
    // A link already on the item may be a staff relink: never match over it or overwrite it.
    linkAlreadySet = (current.columns[cols.attendeeLinkColumn] ?? '').trim() !== '';
    registrantsLinkSet = (current.columns[cols.registrantsLinkColumn] ?? '').trim() !== '';
  }

  const attendance = mergeAttendance(currentAttendance, attendanceFromEventbrite(attendee));
  const mapping = mapAttendee(attendee, mapEvent(event, config, new Date()), config, attendance);
  const columnValues = { ...mapping.columnValues, [cols.eventLinkColumn]: { item_ids: [linkedItemId(eventRow.mondayItemId)] } };

  // People only once they have actually attended (spec decision D). Cached on the ledger so retries
  // and later updates don't match again; a match failure throws, as for donors.
  // On an existing item with a blank link the cache may be stale (staff cleared it), so match afresh.
  let personItemId: string | null = mondayItemId !== null ? null : row.matchedPersonItemId;
  const wantsLink = attendance === 'Attended' && !linkAlreadySet;
  if (wantsLink && personItemId === null) {
    const peopleBoardId = config.monday.boards['people-live'];
    if (peopleBoardId === null) {
      throw new Error('config: monday.boards["people-live"] is not configured');
    }
    const match = await matchPerson(mondayClient, peopleBoardId, config.attendeeSync.peopleEmailColumn, { email: realEmail(attendee.profile?.email), name: realName(attendee.profile?.name) });
    if (match.donorItemId === null) {
      console.warn(`eventbrite-sync consumer: attendee "${attendeeId}" has no People link: ${match.reason}`);
    } else {
      personItemId = match.donorItemId;
      await attendeeStore.updateStatus(attendeeId, 'queued', { matchedPersonItemId: personItemId });
    }
  }
  if (wantsLink && personItemId !== null) {
    columnValues[cols.attendeeLinkColumn] = { item_ids: [linkedItemId(personItemId)] };
  }

  const addRegistrantsLink = async (itemId: string) => {
    if (registrantsLinkSet || config.attendeeSync.registrantsLinkExcludedEventIds.includes(eventId)) return;
    await linkRegistrant(deps, boardId, itemId, eventRow.mondayItemId!, attendeeId);
  };

  const writtenAt = new Date().toISOString();
  const person = personItemId === null ? {} : { matchedPersonItemId: personItemId };
  if (mondayItemId !== null) {
    try {
      // `name` is the item name: keeps it in step with the attendee's name in Eventbrite — only a
      // real one, never the "Eventbrite attendee <id>" fallback over a name staff typed in.
      const rename = cols.attendeeNameColumn in mapping.columnValues ? { name: mapping.itemName } : {};
      await mondayClient.changeColumnValues(boardId, mondayItemId, { ...columnValues, ...rename });
    } catch (err) {
      if (!isItemGone(err)) throw err;
      await markGone(mondayItemId);
      return;
    }
    await attendeeStore.updateStatus(attendeeId, 'written', { ...person, mondayItemId, writtenAt });
    await addRegistrantsLink(mondayItemId);
    return;
  }

  const item = await mondayClient.createItem(boardId, mapping.itemName, columnValues);
  await attendeeStore.updateStatus(attendeeId, 'written', { ...person, mondayItemId: item.id, writtenAt });
  await addRegistrantsLink(item.id);
}

// The two-way link that lists a registration on its event's card. Its own write, after the
// registration is recorded, because Monday can refuse it (`cell_limit_exceeded` on a very large
// event) and that must never fail or retry the registration. A miss is picked up by the
// attendee's next update, or by scripts/backfill-registrants-link.mjs.
async function linkRegistrant(deps: ProcessBatchDeps, boardId: number, itemId: string, eventItemId: string, attendeeId: string): Promise<void> {
  const column = deps.config.attendeeSync.registrations.registrantsLinkColumn;
  try {
    await deps.mondayClient.changeColumnValues(boardId, itemId, { [column]: { item_ids: [linkedItemId(eventItemId)] } });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`eventbrite-sync consumer: attendee "${attendeeId}": registrants link not written: ${reason}`);
  }
}
