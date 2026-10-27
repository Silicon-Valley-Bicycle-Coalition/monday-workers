import type { AttendeeStore } from '../db/attendees';
import type { EventStore } from '../db/events';
import { matchPerson } from '../matching/people';
import type { MondayClient } from '../monday/client';
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
  if (b.events === null || b['event-registrations'] === null || b['people-live'] === null) {
    throw new Error('eventbrite-sync follow-ups: the events, event-registrations and people-live boards must all be configured');
  }
  const boards: Boards = { events: b.events, registrations: b['event-registrations'], people: b['people-live'] };

  const from = new Date(now.getTime() - followups.maxAgeDays * DAY_MS).toISOString();
  const rows = await deps.eventStore.listEndedBetween(from, now.toISOString());

  const result: FollowupResult = { sent: [], held: [], skipped: [] };
  for (const row of rows) {
    if (!isDue(row, now, followups)) continue;
    try {
      const outcome = await runEvent(row, boards, deps);
      result[outcome].push(row.eventId);
    } catch (err) {
      // Follow-ups stays blank, so the next hourly run retries this event.
      console.error(`eventbrite-sync follow-ups: event "${row.eventId}" failed: ${errorMessage(err)}`);
    }
  }
  return result;
}

async function runEvent(row: EventRow, boards: Boards, deps: FollowupDeps): Promise<keyof FollowupResult> {
  const { mondayClient, config } = deps;
  const ev = config.attendeeSync.events;
  const rc = config.attendeeSync.registrations;
  const eventItemId = row.mondayItemId as string; // listEndedBetween only returns rows with an item

  const [eventItem] = await mondayClient.getItems(boards.events, [eventItemId], [ev.classTypeColumn, ev.followupsColumn]);
  if (eventItem === undefined) {
    console.warn(`eventbrite-sync follow-ups: event "${row.eventId}" has no Events item ${eventItemId} on Monday; skipped`);
    return 'skipped';
  }
  const classType = (eventItem.columns[ev.classTypeColumn] ?? '').trim();
  const followupsState = (eventItem.columns[ev.followupsColumn] ?? '').trim();
  if (classType === '' || followupsState !== '') return 'skipped';

  // Attendance comes from Monday, not Eventbrite, so staff corrections count. Ledger order is the
  // "first seen" order for the one-email-per-address rule.
  const itemIds = [...new Set((await deps.attendeeStore.listByEvent(row.eventId)).map((a) => a.mondayItemId).filter((id): id is string => id !== null))];
  const fetched = itemIds.length === 0
    ? []
    : await mondayClient.getItems(boards.registrations, itemIds, [rc.attendanceColumn, rc.attendeeEmailColumn, rc.attendeeLinkColumn, rc.followupEmailColumn]);
  const byId = new Map(fetched.map((item) => [item.id, item]));
  const items = itemIds.map((id) => byId.get(id)).filter((item) => item !== undefined);

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
        email: item.columns[rc.attendeeEmailColumn],
        name: item.name,
      });
      if (match.donorItemId !== null) values[rc.attendeeLinkColumn] = { item_ids: [Number(match.donorItemId)] };
    }
    columnValuesById.set(write.itemId, values);
  }

  // Registrations first, Follow-ups Sent last: a crash part-way leaves Follow-ups blank and the
  // next run retries the event. The planner skips any address that already has a Follow-up Email
  // label, so the retry writes only what's left. Even a re-write of an unchanged label would be
  // harmless — Monday's "status changes to" automation doesn't fire when the value doesn't change.
  for (const [itemId, values] of columnValuesById) {
    await mondayClient.changeColumnValues(boards.registrations, itemId, values);
  }
  await mondayClient.changeColumnValues(boards.events, eventItemId, { [ev.followupsColumn]: 'Sent' });
  return 'sent';
}
