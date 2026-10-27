import type { AttendeeStore } from '../db/attendees';
import type { EventStore } from '../db/events';
import { matchPerson } from '../matching/people';
import { isActive, type MondayClient } from '../monday/client';
import { isItemGone } from '../monday/itemGone';
import type { EventbriteSyncConfig, EventRow } from '../types';
import { errorMessage } from '../util/errorMessage';
import { isDue, planFollowups, type Registration } from './plan';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface FollowupDeps {
  eventStore: EventStore;
  attendeeStore: AttendeeStore;
  mondayClient: MondayClient;
  config: EventbriteSyncConfig;
}

export interface FollowupResult {
  sent: string[];
  held: string[];
  skipped: string[];
  // Threw part-way; Follow-ups stays blank, so the next hourly run retries them.
  failed: string[];
}

interface Boards {
  events: number;
  registrations: number;
  people: number;
}

// The hourly follow-up sweep. Writing a Follow-up Email label triggers a Monday automation that
// enrolls the registration in a Sequence that emails a real attendee, so the event's Follow-ups
// column is the run-once guard: anything but blank is skipped, and it's set last.
export async function runFollowups(now: Date, deps: FollowupDeps): Promise<FollowupResult> {
  const { config } = deps;
  const { followups } = config.attendeeSync;
  const b = config.monday.boards;
  // Before the attendee feed is set up (production until its boards exist) there is nothing to
  // follow up: a quiet no-op rather than an error every hour.
  if (b.events === null || b['event-registrations'] === null) {
    console.warn('eventbrite-sync follow-ups: the events and event-registrations boards are not configured; nothing to do');
    return { sent: [], held: [], skipped: [], failed: [] };
  }
  if (b['people-live'] === null) {
    throw new Error('eventbrite-sync follow-ups: the people-live board must be configured alongside events and event-registrations');
  }
  const boards: Boards = { events: b.events, registrations: b['event-registrations'], people: b['people-live'] };

  const from = new Date(now.getTime() - followups.maxAgeDays * DAY_MS).toISOString();
  const rows = await deps.eventStore.listEndedBetween(from, now.toISOString());

  const result: FollowupResult = { sent: [], held: [], skipped: [], failed: [] };
  for (const row of rows) {
    if (!isDue(row, now, followups)) continue;
    try {
      const outcome = await runEvent(row, boards, deps);
      result[outcome].push(row.eventId);
    } catch (err) {
      // Follow-ups stays blank, so the next hourly run retries this event.
      console.error(`eventbrite-sync follow-ups: event "${row.eventId}" failed: ${errorMessage(err)}`);
      result.failed.push(row.eventId);
    }
  }
  return result;
}

async function runEvent(row: EventRow, boards: Boards, deps: FollowupDeps): Promise<'sent' | 'held' | 'skipped'> {
  const { mondayClient, config } = deps;
  const ev = config.attendeeSync.events;
  const rc = config.attendeeSync.registrations;
  const eventItemId = row.mondayItemId as string; // listEndedBetween only returns rows with an item

  const [eventItem] = await mondayClient.getItems(boards.events, [eventItemId], [ev.classTypeColumn, ev.followupsColumn]);
  if (!isActive(eventItem)) {
    console.warn(`eventbrite-sync follow-ups: event "${row.eventId}" has no active Events item ${eventItemId} on Monday (deleted or archived); skipped`);
    return 'skipped';
  }
  const classType = (eventItem.columns[ev.classTypeColumn] ?? '').trim();
  const followupsState = (eventItem.columns[ev.followupsColumn] ?? '').trim();
  if (classType === '' || followupsState !== '') return 'skipped';

  // Attendance comes from Monday, not Eventbrite, so staff corrections count. Ledger order
  // (received_at, then attendee_id — listByEvent) is the "first registration" order for the
  // one-email-per-address rule. received_at is the latest delivery, so a redelivered attendee
  // moves later; that only changes which of two same-address registrations is picked.
  const itemIds = [...new Set((await deps.attendeeStore.listByEvent(row.eventId)).map((a) => a.mondayItemId).filter((id): id is string => id !== null))];
  const fetched = itemIds.length === 0
    ? []
    : await mondayClient.getItems(boards.registrations, itemIds, [rc.attendanceColumn, rc.attendeeEmailColumn, rc.attendeeLinkColumn, rc.followupEmailColumn]);
  // items(ids:) also returns archived and deleted items: those are gone too — no label, and they
  // don't count towards (or against) Held.
  const byId = new Map(fetched.filter(isActive).map((item) => [item.id, item]));
  const items = itemIds.map((id) => byId.get(id)).filter((item) => item !== undefined);

  // No registrations to judge (none in the ledger, or all gone from Monday — purged, archived or
  // deleted): nothing to send and nothing to hold — Held would page staff about a class nobody
  // signed up for.
  if (items.length === 0) return 'skipped';

  const regs: Registration[] = items.map((item) => ({
    itemId: item.id,
    attendance: (item.columns[rc.attendanceColumn] ?? '').trim(),
    email: (item.columns[rc.attendeeEmailColumn] ?? '').trim(),
    followupEmail: item.columns[rc.followupEmailColumn] ?? '',
  }));
  const plan = planFollowups(regs, classType);

  if (plan.outcome === 'held') {
    await mondayClient.changeColumnValues(boards.events, eventItemId, { [ev.followupsColumn]: 'Held' });
    const userId = config.attendeeSync.followups.notifyUserId;
    if (userId !== null) {
      // After Held is written, so a notify failure can't make the next run re-ring the bell.
      try {
        await mondayClient.notify(
          userId,
          eventItemId,
          `Follow-ups held for ${eventItem.name}: nobody was checked in. Fix Attendance and clear Follow-ups to send them.`
        );
      } catch (err) {
        console.error(`eventbrite-sync follow-ups: event "${row.eventId}" held but the notification failed: ${errorMessage(err)}`);
      }
    }
    return 'held';
  }

  // Build every write before sending any, so a People match failure fails the event with nothing
  // written rather than sending a thank-you without its People link.
  const columnValuesById = new Map<string, Record<string, unknown>>();
  for (const write of plan.writes) {
    const item = byId.get(write.itemId)!;
    const values: Record<string, unknown> = { [rc.followupEmailColumn]: write.label, [rc.classTypeColumn]: classType };
    if (write.noShow) {
      values[rc.attendanceColumn] = 'No Show';
    } else if ((item.columns[rc.attendeeLinkColumn] ?? '').trim() === '') {
      // A Monday edit to Attended links the attendee to People here (spec: Event Registrations items).
      const match = await matchPerson(mondayClient, boards.people, config.attendeeSync.peopleEmailColumn, {
        email: (item.columns[rc.attendeeEmailColumn] ?? '').trim(), // the address the planner deduped on
        name: item.name,
      });
      if (match.donorItemId !== null) values[rc.attendeeLinkColumn] = { item_ids: [Number(match.donorItemId)] };
    }
    columnValuesById.set(write.itemId, values);
  }

  // Staff may check someone in while this run is planning (a late check-in the morning after).
  // Re-read Attendance for the missed-you writes, in one batched call, just before writing them,
  // so only one still Registered is marked No Show and sent a missed-you (the planner's own rule).
  const noShowIds = plan.writes.filter((w) => w.noShow).map((w) => w.itemId);
  if (noShowIds.length > 0) {
    const reread = new Map(
      (await mondayClient.getItems(boards.registrations, noShowIds, [rc.attendanceColumn])).filter(isActive).map((item) => [item.id, item])
    );
    for (const itemId of noShowIds) {
      const item = reread.get(itemId);
      if (item === undefined) {
        console.warn(`eventbrite-sync follow-ups: event "${row.eventId}": Event Registrations item ${itemId} is gone; skipped its missed-you`);
        columnValuesById.delete(itemId);
      } else if ((item.columns[rc.attendanceColumn] ?? '').trim() !== 'Registered') {
        console.log(`eventbrite-sync follow-ups: event "${row.eventId}": Event Registrations item ${itemId} is no longer Registered; skipped its missed-you`);
        columnValuesById.delete(itemId);
      }
    }
  }

  // Registrations first, Follow-ups Sent last: a crash part-way leaves Follow-ups blank and the
  // next run retries the event. The planner skips any address that already has a Follow-up Email
  // label, so the retry writes only what's left. Even a re-write of an unchanged label would be
  // harmless — Monday's "status changes to" automation doesn't fire when the value doesn't change.
  for (const [itemId, values] of columnValuesById) {
    try {
      await mondayClient.changeColumnValues(boards.registrations, itemId, values);
    } catch (err) {
      // Deleted or archived since the read: nothing to send it to, and it mustn't hold up the rest
      // of the class. Anything else fails the event, which the next hourly run retries.
      if (!isItemGone(err)) throw err;
      console.warn(`eventbrite-sync follow-ups: event "${row.eventId}": Event Registrations item ${itemId} is gone (${errorMessage(err)}); skipped it`);
    }
  }
  await mondayClient.changeColumnValues(boards.events, eventItemId, { [ev.followupsColumn]: 'Sent' });
  return 'sent';
}
