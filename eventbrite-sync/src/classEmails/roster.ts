// Reads a class's roster from the Event Registrations board. Addresses are the real ones:
// the one-email-per-address rule in plan.ts must see them. sandboxRecipients swaps them in
// afterwards, once the recipients are planned.
import type { AttendeeStore } from '../db/attendees';
import { isActive, statusText, type MondayClient } from '../monday/client';
import type { EventbriteSyncConfig } from '../types';
import type { Recipient, RosterEntry } from './plan';

export interface RosterDeps {
  attendeeStore: AttendeeStore;
  mondayClient: MondayClient;
  config: EventbriteSyncConfig;
}

// Ledger order (received_at, then attendee_id) is the "first registration" order the planner
// uses for the one-email-per-address rule, so it is kept.
export async function loadRoster(eventId: string, deps: RosterDeps): Promise<RosterEntry[]> {
  const { config } = deps;
  const boardId = config.monday.boards['event-registrations'];
  if (boardId === null) {
    throw new Error('eventbrite-sync class emails: the event-registrations board is not configured');
  }
  const rc = config.attendeeSync.registrations;

  const itemIds = [...new Set((await deps.attendeeStore.listByEvent(eventId)).map((a) => a.mondayItemId).filter((id): id is string => id !== null))];
  if (itemIds.length === 0) return [];
  const fetched = await deps.mondayClient.getItems(boardId, itemIds, [rc.attendanceColumn, rc.roleColumn, rc.attendeeEmailColumn, rc.firstNameColumn]);
  // items(ids:) also returns archived and deleted items, and omits purged ones: all are gone.
  const byId = new Map(fetched.filter(isActive).map((item) => [item.id, item]));
  return itemIds.flatMap((id) => {
    const item = byId.get(id);
    if (item === undefined) return [];
    return [{
      registrationId: item.id,
      attendance: statusText(item, rc.attendanceColumn),
      role: statusText(item, rc.roleColumn),
      email: (item.columns[rc.attendeeEmailColumn] ?? '').trim(),
      firstName: (item.columns[rc.firstNameColumn] ?? '').trim(),
      name: item.name,
    }];
  });
}

// Sandbox only: every email goes to one inbox. Applied after planning, never to the roster.
export function sandboxRecipients<T extends Recipient>(recipients: T[], config: EventbriteSyncConfig): T[] {
  const { sandboxRecipient } = config.attendeeSync.classEmails;
  if (sandboxRecipient === null) return recipients;
  return recipients.map((r) => ({ ...r, email: sandboxRecipient }));
}
