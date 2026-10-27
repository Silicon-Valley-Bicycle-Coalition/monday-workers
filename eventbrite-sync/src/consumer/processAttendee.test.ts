import { describe, it, expect, vi } from 'vitest';
import { processAttendee } from './processAttendee';
import { fakeEventStore, fakeAttendeeStore } from '../test/fakeStores';
import { testConfig } from '../test/testConfig';
import { MondayApiError } from '../monday/graphql';
import type { ProcessBatchDeps } from './processBatch';
import type { EventbriteAttendee, EventbriteEvent } from '../eventbrite/client';
import type { MondayClient } from '../monday/client';
import type { AttendeeRow, EventRow } from '../types';

const config = testConfig();

function event(): EventbriteEvent {
  return {
    id: '9001', name: { text: 'Adult Learn to Ride' }, start: { utc: '2026-10-31T17:00:00Z' }, end: { utc: '2026-10-31T19:00:00Z' },
    status: 'live', organizer_id: 'org-public', organizer: { name: 'Silicon Valley Bicycle Coalition' }, online_event: false,
    venue: { name: 'Mitchell Park', address: { localized_address_display: '600 E Meadow Dr, Palo Alto, CA' } },
  };
}

function attendee(overrides: Partial<EventbriteAttendee> = {}): EventbriteAttendee {
  return { id: 'a1', event_id: '9001', checked_in: false, cancelled: false, refunded: false, profile: { name: 'Pat Rider', first_name: 'Pat', email: 'pat@example.com' }, ...overrides };
}

function eventRow(overrides: Partial<EventRow> = {}): EventRow {
  return {
    eventId: '9001', mondayItemId: '5551', startsAt: null, endsAt: null, locationKey: null, eventbriteStatus: null, status: 'written',
    lastAction: 'event.updated', error: null, deliveries: 1, receivedAt: '2026-10-20T00:00:00.000Z', writtenAt: null, ...overrides,
  };
}

function attendeeRow(overrides: Partial<AttendeeRow> = {}): AttendeeRow {
  return {
    attendeeId: 'a1', eventId: '9001', mondayItemId: null, matchedPersonItemId: null, status: 'received', lastAction: 'attendee.updated',
    error: null, deliveries: 1, receivedAt: '2026-10-20T00:00:00.000Z', writtenAt: null, ...overrides,
  };
}

function fakeMonday(overrides: Partial<MondayClient> = {}): MondayClient {
  return {
    findItemByColumnValue: vi.fn().mockResolvedValue(null),
    createItem: vi.fn().mockResolvedValue({ id: 'reg-1' }),
    changeColumnValues: vi.fn().mockResolvedValue(undefined),
    getItems: vi.fn().mockResolvedValue([]),
    notify: vi.fn(),
    ...overrides,
  };
}

function setup(opts: { att?: EventbriteAttendee | null; evRow?: EventRow | null; row?: AttendeeRow | null; monday?: Partial<MondayClient>; current?: string } = {}) {
  const evRow = opts.evRow === undefined ? eventRow() : opts.evRow;
  const calls: string[] = [];
  const eventStore = fakeEventStore({
    getEvent: vi.fn().mockResolvedValue(evRow),
    recordDelivery: vi.fn().mockImplementation(async () => { calls.push('recordDelivery'); return 'inserted'; }),
  });
  const attendeeStore = fakeAttendeeStore({ getAttendee: vi.fn().mockResolvedValue(opts.row === undefined ? attendeeRow() : opts.row) });
  const queue = { send: vi.fn().mockImplementation(async () => { calls.push('send'); }) };
  const monday = opts.monday ?? {};
  if (opts.current !== undefined && monday.getItems === undefined) {
    monday.getItems = vi.fn().mockResolvedValue([{ id: 'reg-9', name: 'Pat', columns: { att_attendance_col: opts.current } }]);
  }
  const mondayClient = fakeMonday(monday);
  const eventbriteClient = {
    getOrder: vi.fn(), getEvent: vi.fn().mockResolvedValue(event()),
    getAttendee: vi.fn().mockResolvedValue(opts.att === undefined ? attendee() : opts.att),
  };
  const deps = { eventStore, attendeeStore, queue, mondayClient, eventbriteClient, config } as unknown as ProcessBatchDeps;
  return { deps, eventStore, attendeeStore, queue, mondayClient, eventbriteClient, calls };
}

const message = { kind: 'attendee' as const, eventId: '9001', attendeeId: 'a1', action: 'attendee.updated' };
const existing = { row: attendeeRow({ mondayItemId: 'reg-9' }) };

describe('processAttendee', () => {
  it('creates a Registered item with the event link and class facts, and no People lookup', async () => {
    const { deps, mondayClient, attendeeStore } = setup();
    await processAttendee(message, deps);
    expect(mondayClient.findItemByColumnValue).toHaveBeenCalledTimes(1);
    expect(mondayClient.findItemByColumnValue).toHaveBeenCalledWith(333, 'att_col', 'a1');
    const [board, name, values] = (mondayClient.createItem as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(board).toBe(333);
    expect(name).toBe('Pat Rider');
    expect(values).toMatchObject({
      att_col: 'a1', att_attendance_col: 'Registered', att_source_col: 'Eventbrite', att_role_col: 'Participant',
      att_email_col: { email: 'pat@example.com', text: 'pat@example.com' }, att_first_col: 'Pat',
      att_event_col: { item_ids: [5551] },
    });
    expect(values.att_person_col).toBeUndefined();
    expect(values.att_class_day_col).toBe('Saturday');
    expect(attendeeStore.updateStatus).toHaveBeenLastCalledWith('a1', 'written', expect.objectContaining({ mondayItemId: 'reg-1', writtenAt: expect.any(String) }));
  });

  it('links the event by its numeric item id', async () => {
    const { deps, mondayClient } = setup({ evRow: eventRow({ mondayItemId: '5551' }) });
    await processAttendee(message, deps);
    expect((mondayClient.createItem as ReturnType<typeof vi.fn>).mock.calls[0]![2].att_event_col).toEqual({ item_ids: [5551] });
  });

  it('matches People and writes the Attendee link when checked in', async () => {
    const { deps, mondayClient, attendeeStore } = setup({
      att: attendee({ checked_in: true }),
      monday: { findItemByColumnValue: vi.fn().mockImplementation(async (b: number) => (b === 42 ? { id: '777' } : null)) },
    });
    await processAttendee(message, deps);
    expect(mondayClient.findItemByColumnValue).toHaveBeenCalledWith(42, 'people_email_col', 'pat@example.com');
    const values = (mondayClient.createItem as ReturnType<typeof vi.fn>).mock.calls[0]![2];
    expect(values.att_attendance_col).toBe('Attended');
    expect(values.att_person_col).toEqual({ item_ids: [777] });
    expect(attendeeStore.updateStatus).toHaveBeenCalledWith('a1', 'queued', { matchedPersonItemId: '777' });
    expect(attendeeStore.updateStatus).toHaveBeenLastCalledWith('a1', 'written', expect.objectContaining({ matchedPersonItemId: '777' }));
  });

  it('current No Show + incoming checked in becomes Attended and linked', async () => {
    const { deps, mondayClient } = setup({
      ...existing, att: attendee({ checked_in: true }), current: 'No Show',
      monday: { getItems: vi.fn().mockResolvedValue([{ id: 'reg-9', name: 'Pat', columns: { att_attendance_col: 'No Show' } }]), findItemByColumnValue: vi.fn().mockResolvedValue({ id: '777' }) },
    });
    await processAttendee(message, deps);
    expect(mondayClient.getItems).toHaveBeenCalledWith(333, ['reg-9'], ['att_attendance_col']);
    const [board, id, values] = (mondayClient.changeColumnValues as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect([board, id]).toEqual([333, 'reg-9']);
    expect(values.att_attendance_col).toBe('Attended');
    expect(values.att_person_col).toEqual({ item_ids: [777] });
    expect(mondayClient.createItem).not.toHaveBeenCalled();
  });

  it('current Attended + incoming not checked in stays Attended (and linked)', async () => {
    const { deps, mondayClient } = setup({
      ...existing, current: 'Attended',
      monday: { getItems: vi.fn().mockResolvedValue([{ id: 'reg-9', name: 'Pat', columns: { att_attendance_col: 'Attended' } }]), findItemByColumnValue: vi.fn().mockResolvedValue({ id: '777' }) },
    });
    await processAttendee(message, deps);
    const values = (mondayClient.changeColumnValues as ReturnType<typeof vi.fn>).mock.calls[0]![2];
    expect(values.att_attendance_col).toBe('Attended');
    expect(values.att_person_col).toEqual({ item_ids: [777] });
  });

  it('current No Show + incoming Registered keeps No Show and does not link', async () => {
    const { deps, mondayClient } = setup({ ...existing, current: 'No Show' });
    await processAttendee(message, deps);
    const values = (mondayClient.changeColumnValues as ReturnType<typeof vi.fn>).mock.calls[0]![2];
    expect(values.att_attendance_col).toBe('No Show');
    expect(values.att_person_col).toBeUndefined();
    expect(mondayClient.findItemByColumnValue).not.toHaveBeenCalled();
  });

  it('reuses a cached People match without searching', async () => {
    const { deps, mondayClient } = setup({ ...existing, att: attendee({ checked_in: true }), current: 'Registered' });
    (deps.attendeeStore.getAttendee as ReturnType<typeof vi.fn>).mockResolvedValue(attendeeRow({ mondayItemId: 'reg-9', matchedPersonItemId: '888' }));
    await processAttendee(message, deps);
    expect(mondayClient.findItemByColumnValue).not.toHaveBeenCalled();
    expect((mondayClient.changeColumnValues as ReturnType<typeof vi.fn>).mock.calls[0]![2].att_person_col).toEqual({ item_ids: [888] });
  });

  it('adopts an existing item by the attendee id column and reads its Attendance', async () => {
    const { deps, mondayClient } = setup({
      monday: {
        findItemByColumnValue: vi.fn().mockResolvedValue({ id: 'staff-3' }),
        getItems: vi.fn().mockResolvedValue([{ id: 'staff-3', name: 'Pat', columns: { att_attendance_col: 'No Show' } }]),
      },
    });
    await processAttendee(message, deps);
    expect(mondayClient.createItem).not.toHaveBeenCalled();
    const [, id, values] = (mondayClient.changeColumnValues as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(id).toBe('staff-3');
    expect(values.att_attendance_col).toBe('No Show');
    expect(deps.attendeeStore.updateStatus).toHaveBeenLastCalledWith('a1', 'written', expect.objectContaining({ mondayItemId: 'staff-3' }));
  });

  it('writes an attendee with no email without it, with no People link, and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { deps, mondayClient } = setup({ att: attendee({ checked_in: true, profile: { name: 'Pat Rider', first_name: 'Pat', email: '' } }) });
    await processAttendee(message, deps);
    const values = (mondayClient.createItem as ReturnType<typeof vi.fn>).mock.calls[0]![2];
    expect(values.att_email_col).toBeUndefined();
    expect(values.att_person_col).toBeUndefined();
    expect(values.att_attendance_col).toBe('Attended');
    expect(mondayClient.findItemByColumnValue).toHaveBeenCalledTimes(1); // only the adopt lookup
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('a1'));
    warn.mockRestore();
  });

  it('records the delivery, enqueues the event, then throws when the event has no Monday item', async () => {
    const { deps, eventStore, queue, mondayClient, calls } = setup({ evRow: eventRow({ mondayItemId: null }) });
    await expect(processAttendee(message, deps)).rejects.toThrow(/9001/);
    expect(eventStore.recordDelivery).toHaveBeenCalledWith({ eventId: '9001', action: 'attendee.updated', receivedAt: expect.any(String) });
    expect(queue.send).toHaveBeenCalledWith({ kind: 'event', eventId: '9001', action: 'attendee.updated' });
    expect(calls).toEqual(['recordDelivery', 'send']);
    expect(mondayClient.createItem).not.toHaveBeenCalled();
  });

  it('does the same when there is no events row at all', async () => {
    const { deps, eventStore, queue } = setup({ evRow: null });
    await expect(processAttendee(message, deps)).rejects.toThrow(/9001/);
    expect(eventStore.recordDelivery).toHaveBeenCalled();
    expect(queue.send).toHaveBeenCalled();
  });

  it('marks a 404 from Eventbrite failed without throwing', async () => {
    const { deps, attendeeStore, mondayClient } = setup({ att: null });
    await processAttendee(message, deps);
    expect(attendeeStore.updateStatus).toHaveBeenCalledWith('a1', 'failed', { error: 'attendee not found in Eventbrite (HTTP 404)' });
    expect(mondayClient.createItem).not.toHaveBeenCalled();
  });

  it('marks a deleted registration item failed and does not recreate it', async () => {
    const gone = new MondayApiError('Item not found', { code: 'ItemNotFound' });
    const { deps, attendeeStore, mondayClient } = setup({
      ...existing,
      monday: { getItems: vi.fn().mockResolvedValue([{ id: 'reg-9', name: 'Pat', columns: { att_attendance_col: 'Registered' } }]), changeColumnValues: vi.fn().mockRejectedValue(gone) },
    });
    await processAttendee(message, deps);
    expect(mondayClient.createItem).not.toHaveBeenCalled();
    expect(attendeeStore.updateStatus).toHaveBeenCalledWith('a1', 'failed', { error: expect.stringContaining('reg-9') });
  });

  it('treats a cached item that getItems no longer returns as deleted', async () => {
    const { deps, attendeeStore, mondayClient } = setup({ ...existing, monday: { getItems: vi.fn().mockResolvedValue([]) } });
    await processAttendee(message, deps);
    expect(mondayClient.createItem).not.toHaveBeenCalled();
    expect(mondayClient.changeColumnValues).not.toHaveBeenCalled();
    expect(attendeeStore.updateStatus).toHaveBeenCalledWith('a1', 'failed', { error: expect.stringContaining('reg-9') });
  });

  it('is idempotent: a second run uses the item id the first recorded', async () => {
    const first = setup();
    await processAttendee(message, first.deps);
    const second = setup({ row: attendeeRow({ mondayItemId: 'reg-1' }), current: 'Registered' });
    await processAttendee(message, second.deps);
    expect(second.mondayClient.createItem).not.toHaveBeenCalled();
    expect(second.mondayClient.changeColumnValues).toHaveBeenCalledWith(333, 'reg-1', expect.any(Object));
  });

  it('rethrows other Monday errors for retry', async () => {
    const { deps } = setup({ monday: { createItem: vi.fn().mockRejectedValue(new Error('boom')) } });
    await expect(processAttendee(message, deps)).rejects.toThrow('boom');
  });
});
