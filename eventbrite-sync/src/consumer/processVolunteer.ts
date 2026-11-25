import { PLACEHOLDER_COLUMN_ID } from '../config';
import type { EventbriteAttendee, EventbriteEvent } from '../eventbrite/client';
import { realEmail, realName } from '../eventbrite/placeholder';
import { attendanceFromEventbrite, mergeAttendance } from '../mapping/attendee';
import { mapEvent } from '../mapping/event';
import { mapVolunteer, toAttendance } from '../mapping/volunteer';
import { nameParts } from '../matching/names';
import { matchPerson, peopleNameColumns } from '../matching/people';
import { isActive, statusText } from '../monday/client';
import { isItemGone } from '../monday/itemGone';
import type { AttendeeRow, EventRow } from '../types';
import { linkedItemId } from '../util/itemId';
import type { AttendeeQueueMessage, ProcessBatchDeps } from './processBatch';
import { recordEmployerAnswer } from './employerAnswer';

export interface VolunteerContext {
  row: AttendeeRow;
  attendee: EventbriteAttendee;
  event: EventbriteEvent;
  eventRow: EventRow;
}

// A sign-up on a volunteer event becomes a Volunteers board item (never an Event Registrations row).
// Same shape as processAttendee: adopt before create, only an active item is written, and the status
// is merged with what staff set. On create the item's Event and Eventbrite Listing both point at the
// listing's Events item; later updates leave Event alone (staff re-point it by hand) and never rewrite
// Historical (staff and the 📜 load own it).
export async function processVolunteer(message: AttendeeQueueMessage, ctx: VolunteerContext, deps: ProcessBatchDeps): Promise<void> {
  const { attendeeStore, mondayClient, config } = deps;
  const { attendeeId, eventId } = message;
  const { row, attendee, event, eventRow } = ctx;

  const boardId = config.monday.boards.volunteers;
  if (boardId === null) {
    throw new Error('config: monday.boards.volunteers is not configured; a volunteer sign-up is never written to Event Registrations');
  }
  const cols = config.attendeeSync.volunteers;
  if (cols.attendeeIdColumn === PLACEHOLDER_COLUMN_ID) {
    throw new Error('config: attendeeSync.volunteers.attendeeIdColumn is the placeholder — set the real "Eventbrite Attendee ID" column id on the Volunteers board before any volunteer can be written');
  }

  let mondayItemId = row.mondayItemId;
  if (mondayItemId === null) {
    const existing = await mondayClient.findItemByColumnValue(boardId, cols.attendeeIdColumn, attendeeId);
    if (existing) mondayItemId = existing.id;
  }

  const incoming = attendanceFromEventbrite(attendee);
  if (mondayItemId === null && incoming === 'Canceled') {
    // Nothing to cancel: creating an item just to mark it Canceled would add noise. Not a failure,
    // and not retried.
    await attendeeStore.updateStatus(attendeeId, 'skipped', { error: 'sign-up canceled before any Volunteers item existed; nothing written' });
    return;
  }

  const markGone = async (id: string) => {
    const reason = `Volunteers item ${id} was deleted or archived; nothing written`;
    console.warn(`eventbrite-sync consumer: attendee "${attendeeId}": ${reason}`);
    await attendeeStore.updateStatus(attendeeId, 'failed', { error: reason });
  };

  let currentAttendance: string | null = null;
  let staffOwnedStatus = false;
  let linkAlreadySet = false;
  if (mondayItemId !== null) {
    const [current] = await mondayClient.getItems(boardId, [mondayItemId], [cols.statusColumn, cols.volunteerLinkColumn]);
    if (!isActive(current)) {
      await markGone(mondayItemId);
      return;
    }
    // By stored value, not text: an empty status cell's text is label id 5's (statusText).
    const currentStatus = statusText(current, cols.statusColumn);
    currentAttendance = toAttendance(currentStatus);
    // Prospect/Confirmed are staff-only labels the sync doesn't map: never overwrite them with RSVP.
    staffOwnedStatus = currentStatus !== '' && currentAttendance === null;
    // A link already on the item may be a staff relink: never match over it or overwrite it.
    linkAlreadySet = (current.columns[cols.volunteerLinkColumn] ?? '').trim() !== '';
  }

  const attendance = mergeAttendance(currentAttendance, incoming);
  const mapping = mapVolunteer(attendee, mapEvent(event, config, new Date()), config, attendance);
  const columnValues: Record<string, unknown> = { ...mapping.columnValues };
  const listing = { item_ids: [linkedItemId(eventRow.mondayItemId!)] };

  // The Volunteer (People) link, only once they have attended, as for registrations.
  let personItemId: string | null = mondayItemId !== null ? null : row.matchedPersonItemId;
  const wantsLink = attendance === 'Attended' && !linkAlreadySet;
  if (wantsLink && personItemId === null) {
    const peopleBoardId = config.monday.boards['people-live'];
    if (peopleBoardId === null) {
      throw new Error('config: monday.boards["people-live"] is not configured');
    }
    const { name, first_name: firstName, last_name: lastName, email } = attendee.profile ?? {};
    const who = { email: realEmail(email), name: realName(name), ...nameParts({ firstName, lastName, name }) };
    const match = await matchPerson(mondayClient, peopleBoardId, config.attendeeSync.peopleEmailColumn, who, peopleNameColumns(config));
    if (match.donorItemId === null) {
      console.warn(`eventbrite-sync consumer: attendee "${attendeeId}" has no People link: ${match.reason}`);
    } else {
      personItemId = match.donorItemId;
      await attendeeStore.updateStatus(attendeeId, 'queued', { matchedPersonItemId: personItemId });
    }
  }
  if (wantsLink && personItemId !== null) {
    columnValues[cols.volunteerLinkColumn] = { item_ids: [linkedItemId(personItemId)] };
  }

  const writtenAt = new Date().toISOString();
  const person = personItemId === null ? {} : { matchedPersonItemId: personItemId };
  if (mondayItemId !== null) {
    // No Event (staff re-point it) and no Historical (mapVolunteer's unchecked default is for new items).
    delete columnValues[cols.historicalColumn];
    if (staffOwnedStatus && attendance === 'Registered') delete columnValues[cols.statusColumn];
    const rename = cols.attendeeNameColumn in mapping.columnValues ? { name: mapping.itemName } : {};
    try {
      await mondayClient.changeColumnValues(boardId, mondayItemId, { ...columnValues, [cols.listingColumn]: listing, ...rename });
    } catch (err) {
      if (!isItemGone(err)) throw err;
      await markGone(mondayItemId);
      return;
    }
    await recordEmployerAnswer(attendee, null, event.name?.text ?? '', deps);
    await attendeeStore.updateStatus(attendeeId, 'written', { ...person, mondayItemId, writtenAt });
    return;
  }

  const item = await mondayClient.createItem(boardId, mapping.itemName, { ...columnValues, [cols.eventColumn]: listing, [cols.listingColumn]: listing });
  await recordEmployerAnswer(attendee, null, event.name?.text ?? '', deps);
  await attendeeStore.updateStatus(attendeeId, 'written', { ...person, mondayItemId: item.id, writtenAt });
}
