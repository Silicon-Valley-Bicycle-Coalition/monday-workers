import { describe, it, expect, vi } from 'vitest';
import { loadRoster, sandboxRecipients } from './roster';
import type { Recipient } from './plan';
import type { MondayClient, MondayItemColumns } from '../monday/client';
import type { AttendeeRow } from '../types';
import { fakeAttendeeStore } from '../test/fakeStores';
import { mondayItem } from '../test/mondayItem';
import { testConfig } from '../test/testConfig';

const config = testConfig();
const rc = config.attendeeSync.registrations;

function ledger(attendeeId: string, mondayItemId: string | null): AttendeeRow {
  return { attendeeId, eventId: 'e1', mondayItemId, matchedPersonItemId: null, status: 'written', lastAction: 'attendee.updated', error: null, deliveries: 1, receivedAt: '2026-11-01T00:00:00.000Z', writtenAt: null } as AttendeeRow;
}

function reg(id: string, name: string, over: Record<string, string> = {}, opts: Parameters<typeof mondayItem>[3] = {}): MondayItemColumns {
  return mondayItem(id, name, { [rc.attendanceColumn]: 'Registered', [rc.roleColumn]: 'Participant', [rc.attendeeEmailColumn]: `${id}@x.org`, [rc.firstNameColumn]: `F${id}`, ...over }, opts);
}

function deps(rows: AttendeeRow[], items: MondayItemColumns[], cfg = config) {
  const getItems = vi.fn().mockResolvedValue(items);
  const mondayClient = { getItems } as unknown as MondayClient;
  const attendeeStore = fakeAttendeeStore({ listByEvent: vi.fn().mockResolvedValue(rows) });
  return { getItems, attendeeStore, deps: { attendeeStore, mondayClient, config: cfg } };
}

describe('loadRoster', () => {
  it('reads registrations from the attendee ledger', async () => {
    const d = deps([ledger('a1', '10'), ledger('a2', '11'), ledger('a3', '10')], [reg('11', 'Bo Two'), reg('10', 'Al One')]);
    const roster = await loadRoster('e1', d.deps);
    expect(roster).toEqual([
      { registrationId: '10', attendance: 'Registered', role: 'Participant', email: '10@x.org', firstName: 'F10', name: 'Al One' },
      { registrationId: '11', attendance: 'Registered', role: 'Participant', email: '11@x.org', firstName: 'F11', name: 'Bo Two' },
    ]);
    expect(d.attendeeStore.listByEvent).toHaveBeenCalledWith('e1');
    expect(d.getItems).toHaveBeenCalledWith(333, ['10', '11'], [rc.attendanceColumn, rc.roleColumn, rc.attendeeEmailColumn, rc.firstNameColumn]);
  });

  it('drops archived, deleted and purged items', async () => {
    const d = deps(
      [ledger('a1', '10'), ledger('a2', '11'), ledger('a3', '12'), ledger('a4', '13')],
      [reg('10', 'A'), reg('11', 'B', {}, { state: 'archived' }), reg('12', 'C', {}, { state: 'deleted' })]
    );
    expect((await loadRoster('e1', d.deps)).map((r) => r.registrationId)).toEqual(['10']);
  });

  it('skips attendees with no Monday item', async () => {
    const d = deps([ledger('a1', null), ledger('a2', '10')], [reg('10', 'A')]);
    expect((await loadRoster('e1', d.deps)).map((r) => r.registrationId)).toEqual(['10']);
    const none = deps([ledger('a1', null)], []);
    expect(await loadRoster('e1', none.deps)).toEqual([]);
    expect(none.getItems).not.toHaveBeenCalled();
  });

  it('reads Attendance and Role through statusText', async () => {
    const blank = reg('10', 'A', { [rc.attendanceColumn]: 'Canceled', [rc.roleColumn]: 'Volunteer' }, { values: { [rc.attendanceColumn]: null } });
    const d = deps([ledger('a1', '10')], [blank]);
    const [entry] = await loadRoster('e1', d.deps);
    expect(entry!.attendance).toBe('');
    expect(entry!.role).toBe('Volunteer');
  });

  it('never replaces addresses, even when sandboxRecipient is set', async () => {
    const cfg = testConfig();
    cfg.attendeeSync.classEmails.sandboxRecipient = 'sandbox@bikesiliconvalley.org';
    const d = deps([ledger('a1', '10'), ledger('a2', '11')], [reg('10', 'A'), reg('11', 'B')], cfg);
    expect((await loadRoster('e1', d.deps)).map((r) => r.email)).toEqual(['10@x.org', '11@x.org']);
  });

  it('throws when the event-registrations board is not configured', async () => {
    const cfg = testConfig({}, { 'event-registrations': null });
    await expect(loadRoster('e1', deps([ledger('a1', '10')], [], cfg).deps)).rejects.toThrow('event-registrations');
  });
});

describe('sandboxRecipients', () => {
  const recipients: Recipient[] = [
    { registrationId: '1', email: 'a@x.org', firstName: 'A', name: 'A One' },
    { registrationId: '2', email: 'b@x.org', firstName: 'B', name: 'B Two' },
  ];

  it('replaces every email with sandboxRecipient when set', () => {
    const cfg = testConfig();
    cfg.attendeeSync.classEmails.sandboxRecipient = 'sandbox@bikesiliconvalley.org';
    expect(sandboxRecipients(recipients, cfg).map((r) => r.email)).toEqual(['sandbox@bikesiliconvalley.org', 'sandbox@bikesiliconvalley.org']);
  });

  it('keeps one entry per recipient', () => {
    const cfg = testConfig();
    cfg.attendeeSync.classEmails.sandboxRecipient = 'sandbox@bikesiliconvalley.org';
    const out = sandboxRecipients(recipients, cfg);
    expect(out).toHaveLength(2);
    expect(out.map((r) => [r.registrationId, r.firstName, r.name])).toEqual([['1', 'A', 'A One'], ['2', 'B', 'B Two']]);
  });

  it('is unchanged when sandboxRecipient is null', () => {
    expect(sandboxRecipients(recipients, testConfig())).toEqual(recipients);
  });
});
