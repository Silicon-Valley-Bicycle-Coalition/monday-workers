// Reads a class's roster from the Event Registrations board (the Volunteers board for a volunteer event). Addresses are the real ones:
// the one-email-per-address rule in plan.ts must see them. sandboxRecipients swaps them in
// afterwards, once the recipients are planned.
import type { AttendeeStore } from '../db/attendees';
import { isActive, statusText, type MondayClient } from '../monday/client';
import type { EventbriteSyncConfig } from '../types';
import { toAttendance } from '../mapping/volunteer';
import { audienceSource, firstWord } from './audienceSource';
import type { AudienceRole, Recipient, RosterEntry } from './plan';

export interface RosterDeps {
  attendeeStore: AttendeeStore;
  mondayClient: MondayClient;
  config: EventbriteSyncConfig;
}

// Ledger order (received_at, then attendee_id) is the "first registration" order the planner
// uses for the one-email-per-address rule, so it is kept. A volunteer event's ledger item ids are
// Volunteers-board items; their Status is mapped to the attendance words plan.ts reads.
export async function loadRoster(eventId: string, deps: RosterDeps, audience: AudienceRole = 'Participant'): Promise<RosterEntry[]> {
  const { config } = deps;
  const source = audienceSource(config, audience);
  if (source.board === null) {
    throw new Error(`eventbrite-sync class emails: the ${source.boardName} board is not configured`);
  }
  const rc = config.attendeeSync.registrations;

  const itemIds = [...new Set((await deps.attendeeStore.listByEvent(eventId)).map((a) => a.mondayItemId).filter((id): id is string => id !== null))];
  if (itemIds.length === 0) return [];
  const columns = audience === 'Volunteer'
    ? [source.statusColumn, source.emailColumn]
    : [rc.attendanceColumn, rc.roleColumn, rc.attendeeEmailColumn, rc.firstNameColumn];
  const fetched = await deps.mondayClient.getItems(source.board, itemIds, columns);
  // items(ids:) also returns archived and deleted items, and omits purged ones: all are gone.
  const byId = new Map(fetched.filter(isActive).map((item) => [item.id, item]));
  return itemIds.flatMap((id) => {
    const item = byId.get(id);
    if (item === undefined) return [];
    const email = (item.columns[source.emailColumn] ?? '').trim();
    if (audience === 'Volunteer') {
      return [{
        registrationId: item.id, attendance: toAttendance(statusText(item, source.statusColumn)) ?? '', role: 'Volunteer', email,
        firstName: firstWord(item.name), name: item.name,
      }];
    }
    return [{
      registrationId: item.id,
      attendance: statusText(item, rc.attendanceColumn),
      role: statusText(item, rc.roleColumn),
      email,
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
