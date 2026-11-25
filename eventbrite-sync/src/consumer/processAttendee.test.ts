import { describe, it, expect, vi, afterEach, type Mock } from 'vitest';
import { processAttendee } from './processAttendee';
import { consumeWriteBatch } from './processBatch';
import { piiKeysFor } from '../writeSwitch';
import { fakeEventStore, fakeAttendeeStore } from '../test/fakeStores';
import { testConfig } from '../test/testConfig';
import { MondayApiError } from '../monday/graphql';
import { EMPLOYER_ANSWER, EMPLOYER_ANSWERS, PERSON_ITEM_ID, expectNotWritten, expectRecordedBetween, fakeEmployerSink, peopleLookup, withSink } from '../test/employerAnswers';
import type { ProcessBatchDeps } from './processBatch';
import type { EventbriteAttendee, EventbriteEvent } from '../eventbrite/client';
import type { MondayClient } from '../monday/client';
import { mondayItem } from '../test/mondayItem';
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
   
    postUpdate: vi.fn(), createTimelineItem: vi.fn(),
    ...overrides,
  };
}

function setup(opts: { att?: EventbriteAttendee | null; evRow?: EventRow | null; row?: AttendeeRow | null; monday?: Partial<MondayClient>; current?: string } = {}) {
  const evRow = opts.evRow === undefined ? eventRow() : opts.evRow;
  const calls: string[] = [];
  const eventStore = fakeEventStore({
    getEvent: vi.fn().mockResolvedValue(evRow),
    recordDelivery: vi.fn().mockImplementation(async () => { calls.push('recordDelivery'); }),
  });
  const attendeeStore = fakeAttendeeStore({ getAttendee: vi.fn().mockResolvedValue(opts.row === undefined ? attendeeRow() : opts.row) });
  const queue = { send: vi.fn().mockImplementation(async () => { calls.push('send'); }) };
  const monday = opts.monday ?? {};
  if (opts.current !== undefined && monday.getItems === undefined) {
    monday.getItems = vi.fn().mockResolvedValue([mondayItem('reg-9', 'Pat', { att_attendance_col: opts.current })]);
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

  it('never creates a person from a checked-in placeholder attendee', async () => {
    const { deps, mondayClient } = setup({
      att: attendee({ checked_in: true, profile: { name: 'Info Requested Info Requested', first_name: 'Info Requested', email: 'Info Requested' } }),
    });
    await processAttendee(message, deps);
    expect(mondayClient.createItem).toHaveBeenCalledTimes(1);
    expect((mondayClient.createItem as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe(333);
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

  it('writes First and Last Name on the person it creates', async () => {
    const { deps, mondayClient } = setup({
      att: attendee({ checked_in: true, profile: { name: 'Pat Ann Rider', first_name: 'Pat Ann', last_name: 'Rider', email: 'pat@example.com' } }),
      monday: { createItem: vi.fn().mockImplementation(async (b: number) => ({ id: b === 42 ? '778' : '901' })) },
    });
    await processAttendee(message, deps);
    expect(mondayClient.createItem).toHaveBeenCalledWith(42, 'Pat Ann Rider', { people_email_col: { email: 'pat@example.com', text: 'pat@example.com' } });
    expect(mondayClient.changeColumnValues).toHaveBeenCalledWith(42, '778', { first_col: 'Pat Ann', last_col: 'Rider' });
  });

  it('writes no placeholder First or Last Name on a person created from a real email', async () => {
    const { deps, mondayClient } = setup({
      att: attendee({ checked_in: true, profile: { name: 'Info Requested Info Requested', first_name: 'Info Requested', last_name: 'Info Requested', email: 'pat@example.com' } }),
      monday: { createItem: vi.fn().mockImplementation(async (b: number) => ({ id: b === 42 ? '778' : '901' })) },
    });
    await processAttendee(message, deps);
    expect(mondayClient.createItem).toHaveBeenCalledWith(42, 'Unknown', expect.anything());
    expect(mondayClient.changeColumnValues).not.toHaveBeenCalledWith(42, expect.anything(), expect.anything());
  });

  it('current No Show + incoming checked in becomes Attended and linked', async () => {
    const { deps, mondayClient } = setup({
      ...existing, att: attendee({ checked_in: true }), current: 'No Show',
      monday: { getItems: vi.fn().mockResolvedValue([mondayItem('reg-9', 'Pat', { att_attendance_col: 'No Show' })]), findItemByColumnValue: vi.fn().mockResolvedValue({ id: '777' }) },
    });
    await processAttendee(message, deps);
    expect(mondayClient.getItems).toHaveBeenCalledWith(333, ['reg-9'], ['att_attendance_col', 'att_person_col', 'att_registrants_col']);
    const [board, id, values] = (mondayClient.changeColumnValues as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect([board, id]).toEqual([333, 'reg-9']);
    expect(values.att_attendance_col).toBe('Attended');
    expect(values.att_person_col).toEqual({ item_ids: [777] });
    expect(mondayClient.createItem).not.toHaveBeenCalled();
  });

  // Monday returns label id 5's text for an EMPTY status cell; only the null value says it's blank.
  it('treats Attendance text with no stored value as no current Attendance', async () => {
    const { deps, mondayClient } = setup({
      ...existing,
      monday: { getItems: vi.fn().mockResolvedValue([mondayItem('reg-9', 'Pat', { att_attendance_col: 'Attended' }, { values: { att_attendance_col: null } })]) },
    });
    await processAttendee(message, deps);
    const values = (mondayClient.changeColumnValues as ReturnType<typeof vi.fn>).mock.calls[0]![2];
    expect(values.att_attendance_col).toBe('Registered');
    expect(mondayClient.findItemByColumnValue).not.toHaveBeenCalled();
  });

  it('current Attended + incoming not checked in stays Attended (and linked)', async () => {
    const { deps, mondayClient } = setup({
      ...existing, current: 'Attended',
      monday: { getItems: vi.fn().mockResolvedValue([mondayItem('reg-9', 'Pat', { att_attendance_col: 'Attended' })]), findItemByColumnValue: vi.fn().mockResolvedValue({ id: '777' }) },
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

  it('reuses a cached People match on the create path without searching', async () => {
    const { deps, mondayClient } = setup({ row: attendeeRow({ matchedPersonItemId: '888' }), att: attendee({ checked_in: true }) });
    await processAttendee(message, deps);
    expect(mondayClient.findItemByColumnValue).toHaveBeenCalledTimes(1); // adopt lookup only
    expect((mondayClient.createItem as ReturnType<typeof vi.fn>).mock.calls[0]![2].att_person_col).toEqual({ item_ids: [888] });
  });

  it('existing item with a link already set + check-in: link not written, matchPerson not called', async () => {
    const { deps, mondayClient } = setup({
      row: attendeeRow({ mondayItemId: 'reg-9', matchedPersonItemId: '888' }), att: attendee({ checked_in: true }),
      monday: { getItems: vi.fn().mockResolvedValue([mondayItem('reg-9', 'Pat', { att_attendance_col: 'Registered', att_person_col: '5550001' })]) },
    });
    await processAttendee(message, deps);
    expect(mondayClient.findItemByColumnValue).not.toHaveBeenCalled();
    const values = (mondayClient.changeColumnValues as ReturnType<typeof vi.fn>).mock.calls[0]![2];
    expect(values.att_attendance_col).toBe('Attended');
    expect(values.att_person_col).toBeUndefined();
  });

  it('existing item with a blank link + check-in: matches afresh over a stale cache and writes the link', async () => {
    const { deps, mondayClient } = setup({
      row: attendeeRow({ mondayItemId: 'reg-9', matchedPersonItemId: '888' }), att: attendee({ checked_in: true }),
      monday: {
        getItems: vi.fn().mockResolvedValue([mondayItem('reg-9', 'Pat', { att_attendance_col: 'Registered', att_person_col: '' })]),
        findItemByColumnValue: vi.fn().mockResolvedValue({ id: '777' }),
      },
    });
    await processAttendee(message, deps);
    expect(mondayClient.findItemByColumnValue).toHaveBeenCalledWith(42, 'people_email_col', 'pat@example.com');
    expect((mondayClient.changeColumnValues as ReturnType<typeof vi.fn>).mock.calls[0]![2].att_person_col).toEqual({ item_ids: [777] });
  });

  it('writes Canceled for a cancelled attendee currently Registered, with no People lookup', async () => {
    const { deps, mondayClient } = setup({ ...existing, att: attendee({ cancelled: true }), current: 'Registered' });
    await processAttendee(message, deps);
    const values = (mondayClient.changeColumnValues as ReturnType<typeof vi.fn>).mock.calls[0]![2];
    expect(values.att_attendance_col).toBe('Canceled');
    expect(values.att_person_col).toBeUndefined();
    expect(mondayClient.findItemByColumnValue).not.toHaveBeenCalled();
  });

  it('marks an event 404 from Eventbrite failed without throwing', async () => {
    const { deps, attendeeStore, eventbriteClient, mondayClient } = setup();
    (eventbriteClient.getEvent as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await processAttendee(message, deps);
    expect(attendeeStore.updateStatus).toHaveBeenCalledWith('a1', 'failed', { error: 'event not found in Eventbrite (HTTP 404)' });
    expect(mondayClient.createItem).not.toHaveBeenCalled();
  });

  it('adopts an existing item by the attendee id column and reads its Attendance', async () => {
    const { deps, mondayClient } = setup({
      monday: {
        findItemByColumnValue: vi.fn().mockResolvedValue({ id: 'staff-3' }),
        getItems: vi.fn().mockResolvedValue([mondayItem('staff-3', 'Pat', { att_attendance_col: 'No Show' })]),
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

  it('marks the attendee failed without retry, and requests nothing, when the event 404d in Eventbrite', async () => {
    const { deps, eventStore, attendeeStore, queue, mondayClient, eventbriteClient } = setup({
      evRow: eventRow({ mondayItemId: null, status: 'failed', error: 'event not found in Eventbrite (HTTP 404)' }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await processAttendee(message, deps);
    expect(queue.send).not.toHaveBeenCalled();
    expect(eventStore.recordDelivery).not.toHaveBeenCalled();
    expect(eventbriteClient.getAttendee).not.toHaveBeenCalled();
    expect(mondayClient.createItem).not.toHaveBeenCalled();
    expect(attendeeStore.updateStatus).toHaveBeenCalledWith('a1', 'failed', { error: expect.stringMatching(/event 9001 not found in Eventbrite \(HTTP 404\)/) });
    warn.mockRestore();
  });

  it('marks the attendee failed without retry, and requests nothing, when the event failed terminally (#75)', async () => {
    const { deps, eventStore, attendeeStore, queue, mondayClient, eventbriteClient } = setup({
      evRow: eventRow({ mondayItemId: null, status: 'failed', error: 'not retried: monday API: ColumnValueException' }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await processAttendee(message, deps);
    expect(queue.send).not.toHaveBeenCalled();
    expect(eventStore.recordDelivery).not.toHaveBeenCalled();
    expect(eventbriteClient.getAttendee).not.toHaveBeenCalled();
    expect(mondayClient.createItem).not.toHaveBeenCalled();
    expect(attendeeStore.updateStatus).toHaveBeenCalledWith('a1', 'failed', { error: expect.stringMatching(/event 9001 failed without retry \(not retried: monday API: ColumnValueException\)/) });
    warn.mockRestore();
  });

  it('still requests the event when its row failed for another reason', async () => {
    const { deps, queue } = setup({ evRow: eventRow({ mondayItemId: null, status: 'failed', error: 'monday API: 500' }) });
    await expect(processAttendee(message, deps)).rejects.toThrow(/9001/);
    expect(queue.send).toHaveBeenCalledWith({ kind: 'event', eventId: '9001', action: 'attendee.updated' });
  });

  it('renames an existing registration item to the Eventbrite name', async () => {
    const { deps, mondayClient } = setup({ ...existing, current: 'Registered', att: attendee({ profile: { name: 'Patricia Rider', first_name: 'Patricia', email: 'pat@example.com' } }) });
    await processAttendee(message, deps);
    const values = (mondayClient.changeColumnValues as ReturnType<typeof vi.fn>).mock.calls[0]![2];
    expect(values.name).toBe('Patricia Rider');
  });

  it('keeps the existing item name when Eventbrite has no attendee name', async () => {
    const { deps, mondayClient } = setup({ ...existing, current: 'Registered', att: attendee({ profile: { email: 'pat@example.com' } }) });
    await processAttendee(message, deps);
    expect((mondayClient.changeColumnValues as ReturnType<typeof vi.fn>).mock.calls[0]![2]).not.toHaveProperty('name');
  });

  it('does not put the item name in a create\'s column values', async () => {
    const { deps, mondayClient } = setup();
    await processAttendee(message, deps);
    expect((mondayClient.createItem as ReturnType<typeof vi.fn>).mock.calls[0]![2].name).toBeUndefined();
  });

  describe('requesting an event that has no item yet', () => {
    afterEach(() => vi.useRealTimers());
    const at = (ms: number) => new Date(ms).toISOString();
    const NOW = Date.parse('2026-11-11T12:00:00.000Z');

    it.each(['received', 'queued'] as const)('does not request it again while its %s row is recent, but still retries the attendee', async (status) => {
      vi.useFakeTimers({ now: NOW });
      const { deps, eventStore, queue } = setup({ evRow: eventRow({ mondayItemId: null, status, receivedAt: at(NOW - 60_000) }) });
      await expect(processAttendee(message, deps)).rejects.toThrow(/has no Events item yet/);
      expect(eventStore.recordDelivery).not.toHaveBeenCalled();
      expect(queue.send).not.toHaveBeenCalled();
    });

    it('requests it again once the row is stale, so a stranded row cannot block it', async () => {
      vi.useFakeTimers({ now: NOW });
      const { deps, queue } = setup({ evRow: eventRow({ mondayItemId: null, status: 'received', receivedAt: at(NOW - 11 * 60_000) }) });
      await expect(processAttendee(message, deps)).rejects.toThrow(/9001/);
      expect(queue.send).toHaveBeenCalledTimes(1);
    });
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
      monday: { getItems: vi.fn().mockResolvedValue([mondayItem('reg-9', 'Pat', { att_attendance_col: 'Registered' })]), changeColumnValues: vi.fn().mockRejectedValue(gone) },
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

  it.each(['archived', 'deleted'])('treats a cached item Monday returns as %s like a deleted one: failed, no write, no recreate', async (state) => {
    const { deps, attendeeStore, mondayClient } = setup({
      ...existing,
      monday: { getItems: vi.fn().mockResolvedValue([mondayItem('reg-9', 'Pat', { att_attendance_col: 'Registered' }, { state })]) },
    });
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

// Write switch (spec 2026-10-26): attendee messages go through consumeWriteBatch like orders.
describe('registrants link', () => {
  const registrantsWrite = (monday: MondayClient) =>
    (monday.changeColumnValues as ReturnType<typeof vi.fn>).mock.calls.filter(([, , v]) => 'att_registrants_col' in v);

  it('links a new registration in its own write, after recording it', async () => {
    const { deps, mondayClient, attendeeStore } = setup();
    await processAttendee(message, deps);
    const [, , created] = (mondayClient.createItem as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(created.att_registrants_col).toBeUndefined();
    expect(registrantsWrite(mondayClient)).toEqual([[333, 'reg-1', { att_registrants_col: { item_ids: [5551] } }]]);
    const written = (attendeeStore.updateStatus as ReturnType<typeof vi.fn>).mock.invocationCallOrder.at(-1)!;
    expect(written).toBeLessThan((mondayClient.changeColumnValues as ReturnType<typeof vi.fn>).mock.invocationCallOrder.at(-1)!);
  });

  it('adds the link to an existing registration that lacks it', async () => {
    const { deps, mondayClient } = setup({ ...existing, current: 'Registered' });
    await processAttendee(message, deps);
    expect(registrantsWrite(mondayClient)).toEqual([[333, 'reg-9', { att_registrants_col: { item_ids: [5551] } }]]);
  });

  it('does not write the link again when it is already set', async () => {
    const getItems = vi.fn().mockResolvedValue([mondayItem('reg-9', 'Pat', { att_attendance_col: 'Registered', att_registrants_col: 'Adult Learn to Ride' })]);
    const { deps, mondayClient } = setup({ ...existing, monday: { getItems } });
    await processAttendee(message, deps);
    expect(registrantsWrite(mondayClient)).toEqual([]);
  });

  it('leaves out an excluded event', async () => {
    const { deps, mondayClient, attendeeStore } = setup();
    await processAttendee({ ...message, eventId: '8888' }, deps);
    expect(registrantsWrite(mondayClient)).toEqual([]);
    expect(attendeeStore.updateStatus).toHaveBeenLastCalledWith('a1', 'written', expect.anything());
  });

  it('keeps the registration when Monday refuses the link: no throw, recorded as written', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const changeColumnValues = vi.fn().mockRejectedValue(new MondayApiError('cell_limit_exceeded'));
    const { deps, attendeeStore } = setup({ monday: { changeColumnValues } });
    await expect(processAttendee(message, deps)).resolves.toBeUndefined();
    expect(attendeeStore.updateStatus).toHaveBeenLastCalledWith('a1', 'written', expect.objectContaining({ mondayItemId: 'reg-1' }));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('registrants link not written'));
    warn.mockRestore();
  });
});

describe('a batch of attendees of one event', () => {
  const gate = { worker: 'eventbrite-sync', environment: 'production', mode: 'on' as const, logLevel: 'normal' as const, piiKeys: ['name', 'email'] };
  const full = (deps: ProcessBatchDeps): ProcessBatchDeps => ({ ...deps, orderStore: { recordDelivery: vi.fn(), updateStatus: vi.fn(), getOrder: vi.fn() } });
  const msg = (attendeeId: string) => ({ body: { ...message, attendeeId }, attempts: 1, ack: vi.fn(), retry: vi.fn() });

  it('reads the event from Eventbrite once, and each attendee once', async () => {
    const { deps, eventbriteClient } = setup();
    const batch = [msg('a1'), msg('a2'), msg('a3')];
    await consumeWriteBatch(batch, full(deps), gate);
    expect(eventbriteClient.getEvent).toHaveBeenCalledTimes(1);
    expect(eventbriteClient.getAttendee).toHaveBeenCalledTimes(3);
    for (const m of batch) expect(m.ack).toHaveBeenCalled();
  });

  it('asks again after a failed read, rather than keeping the failure', async () => {
    const { deps, eventbriteClient } = setup();
    eventbriteClient.getEvent.mockRejectedValueOnce(new Error('503'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const batch = [msg('a1'), msg('a2')];
    await consumeWriteBatch(batch, full(deps), gate);
    error.mockRestore();
    expect(batch[0]!.retry).toHaveBeenCalled();
    expect(batch[1]!.ack).toHaveBeenCalled();
    expect(eventbriteClient.getEvent).toHaveBeenCalledTimes(2);
  });

  it('sends one event request for the whole batch when the event has no item yet', async () => {
    const { deps, queue, eventStore } = setup({ evRow: null });
    // The first attendee records the delivery, which makes the row `received` for the next.
    (eventStore.recordDelivery as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      (eventStore.getEvent as ReturnType<typeof vi.fn>).mockResolvedValue(eventRow({ mondayItemId: null, status: 'received', receivedAt: new Date().toISOString() }));
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const batch = [msg('a1'), msg('a2'), msg('a3')];
    await consumeWriteBatch(batch, full(deps), gate);
    error.mockRestore();
    expect(queue.send).toHaveBeenCalledTimes(1);
    for (const m of batch) expect(m.retry).toHaveBeenCalled();
  });
});

describe('attendee messages under the write switch', () => {
  // setup() builds only what this consumer reaches; the dry-run deps also wrap the orders ledger.
  const full = (deps: ProcessBatchDeps): ProcessBatchDeps => ({ ...deps, orderStore: { recordDelivery: vi.fn(), updateStatus: vi.fn(), getOrder: vi.fn() } });
  const gate = (mode: 'on' | 'off' | 'hold' | 'unknown') => ({ worker: 'eventbrite-sync', environment: 'production', mode, logLevel: 'normal' as const, piiKeys: ['name', 'email'] });
  const msg = (stamp: { writeStamp?: 'dropped' } = {}) => ({ body: { ...message, ...stamp }, attempts: 1, ack: vi.fn(), retry: vi.fn() });

  function skipLines(log: { mock: { calls: unknown[][] } }): Record<string, any>[] {
    return log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"writeSwitch":"skipped"')).map((l) => JSON.parse(l));
  }

  it('off: logs the registration create; writes and records nothing, then acks', async () => {
    const { deps, mondayClient, attendeeStore, eventStore, queue } = setup();
    const m = msg();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await consumeWriteBatch([m], full(deps), gate('off'));
      expect(mondayClient.createItem).not.toHaveBeenCalled();
      expect(attendeeStore.updateStatus).not.toHaveBeenCalled();
      expect(eventStore.recordDelivery).not.toHaveBeenCalled();
      expect(queue.send).not.toHaveBeenCalled();
      expect(m.ack).toHaveBeenCalled();
      expect(skipLines(log).map((l) => [l.sink, l.operation, l.deliveryId])).toEqual([
        ['Event Registrations', 'createItem', 'attendee:a1'],
        ['Event Registrations', 'changeColumnValues', 'attendee:a1'],
      ]);
    } finally {
      log.mockRestore();
    }
  });

  it('off, event not written yet (a dry run never records one): links the placeholder Events item instead of retrying for days', async () => {
    const { deps, mondayClient, queue, eventStore } = setup({ evRow: eventRow({ mondayItemId: null, status: 'queued' }) });
    const m = msg({ writeStamp: 'dropped' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await consumeWriteBatch([m], full(deps), gate('on'));
      expect(m.retry).not.toHaveBeenCalled();
      expect(m.ack).toHaveBeenCalled();
      expect(queue.send).not.toHaveBeenCalled();
      expect(eventStore.recordDelivery).not.toHaveBeenCalled();
      expect(mondayClient.createItem).not.toHaveBeenCalled();
      const [line] = skipLines(log);
      expect([line!.sink, line!.operation]).toEqual(['Event Registrations', 'createItem']);
    } finally {
      log.mockRestore();
    }
  });

  it('off, event has no ledger row at all: links the placeholder Events item instead of retrying for days', async () => {
    const { deps, mondayClient, queue, eventStore } = setup({ evRow: null });
    const m = msg({ writeStamp: 'dropped' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await consumeWriteBatch([m], full(deps), gate('on'));
      expect(m.retry).not.toHaveBeenCalled();
      expect(m.ack).toHaveBeenCalled();
      expect(queue.send).not.toHaveBeenCalled();
      expect(eventStore.recordDelivery).not.toHaveBeenCalled();
      expect(mondayClient.createItem).not.toHaveBeenCalled();
      const [line] = skipLines(log);
      expect([line!.sink, line!.operation]).toEqual(['Event Registrations', 'createItem']);
    } finally {
      log.mockRestore();
    }
  });

  it('off, Attended with no People match: logs the People create and links its placeholder', async () => {
    const { deps, mondayClient, attendeeStore } = setup({ att: attendee({ checked_in: true }) });
    const m = msg();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await consumeWriteBatch([m], full(deps), { ...gate('off'), logLevel: 'debug', piiKeys: piiKeysFor(config) });
      expect(mondayClient.createItem).not.toHaveBeenCalled();
      // No placeholder person id reaches the ledger.
      expect(attendeeStore.updateStatus).not.toHaveBeenCalled();
      const lines = skipLines(log);
      // The create, then its First and Last Name, whose values are redacted.
      expect(lines.map((l) => l.sink)).toEqual(['People', 'People', 'Event Registrations', 'Event Registrations']);
      expect(JSON.stringify(lines[1]!.payload)).toContain('first_col');
      expect(JSON.stringify(lines[1]!.payload)).not.toContain('Pat');
      expect(JSON.stringify(lines[2]!.payload)).toContain('"item_ids":["dry-run-1"]');
      expect(JSON.stringify(lines)).not.toContain('pat@example.com');
    } finally {
      log.mockRestore();
    }
  });

  it.each(['hold', 'unknown'] as const)('%s: retries with the backoff, processing nothing', async (mode) => {
    const { deps, attendeeStore } = setup();
    const m = msg();
    await consumeWriteBatch([m], full(deps), gate(mode));
    expect(m.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(attendeeStore.getAttendee).not.toHaveBeenCalled();
  });

  it('on: an event with no item yet is requested live and the attendee retried, as before', async () => {
    const { deps, queue, eventStore } = setup({ evRow: eventRow({ mondayItemId: null, status: 'failed', error: 'monday API: 500' }) });
    const m = msg();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await consumeWriteBatch([m], full(deps), gate('on'));
      expect(eventStore.recordDelivery).toHaveBeenCalled();
      expect(queue.send).toHaveBeenCalledWith({ kind: 'event', eventId: '9001', action: 'attendee.updated' });
      expect(m.retry).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it("the event request sent on behalf of a dropped attendee carries its stamp", async () => {
    const { deps, queue } = setup({ evRow: null });
    await expect(processAttendee({ ...message, writeStamp: 'dropped' }, deps)).rejects.toThrow('no Events item yet');
    expect(queue.send).toHaveBeenCalledWith({ kind: 'event', eventId: '9001', action: 'attendee.updated', writeStamp: 'dropped' });
  });
});

// Spec 2026-11-04: of everything a form asks, only a valid zip goes anywhere.
describe('Home Zip through the consumer', () => {
  const SENSITIVE = ['Jordan Contact', '408-555-0188', 'asthma, carries inhaler', '12 Hidden Street', 'please call me first'];
  const answers = (zip: string) => [
    { question: 'Emergency contact name', question_id: '1', type: 'text', answer: SENSITIVE[0] },
    { question: 'Emergency Contact Phone Number', question_id: '2', type: 'text', answer: SENSITIVE[1] },
    { question: 'Are there any conditions?', question_id: '3', type: 'text', answer: SENSITIVE[2] },
    { question: 'Mailing Street', question_id: '4', type: 'text', answer: SENSITIVE[3] },
    { question: 'What is your home zip code?', question_id: '5', type: 'text', answer: zip },
  ];
  const full = (deps: ProcessBatchDeps): ProcessBatchDeps => ({ ...deps, orderStore: { recordDelivery: vi.fn(), updateStatus: vi.fn(), getOrder: vi.fn() } });
  const gate = (mode: 'on' | 'off') => ({ worker: 'eventbrite-sync', environment: 'production', mode, logLevel: 'debug' as const, piiKeys: piiKeysFor(config) });
  const msg = () => ({ body: message, attempts: 1, ack: vi.fn(), retry: vi.fn() });

  // Everything the consumer printed, and everything it asked the ledger to store.
  async function captured(run: () => Promise<void>, stores: { updateStatus: unknown }): Promise<string> {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    try {
      await run();
      return JSON.stringify([spies.map((spy) => spy.mock.calls), (stores.updateStatus as ReturnType<typeof vi.fn>).mock.calls]);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  }

  it('writes the zip and nothing else from the form on a create', async () => {
    const { deps, mondayClient } = setup({ att: attendee({ answers: answers('95112') }) });
    await processAttendee(message, deps);
    const [, , values] = (mondayClient.createItem as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(values.att_zip_col).toBe('95112');
    for (const text of SENSITIVE) expect(JSON.stringify(values)).not.toContain(text);
  });

  it('writes the zip and nothing else from the form on an update', async () => {
    const { deps, mondayClient } = setup({ ...existing, current: 'Registered', att: attendee({ answers: answers('95112-1234') }) });
    await processAttendee(message, deps);
    const [, item, values] = (mondayClient.changeColumnValues as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(item).toBe('reg-9');
    expect(values.att_zip_col).toBe('95112');
    for (const text of SENSITIVE) expect(JSON.stringify(values)).not.toContain(text);
  });

  it('leaves the column out of an update when the zip answer is not a zip, so a good value stays', async () => {
    const { deps, mondayClient } = setup({ ...existing, current: 'Registered', att: attendee({ answers: answers(SENSITIVE[4]!) }) });
    await processAttendee(message, deps);
    const [, , values] = (mondayClient.changeColumnValues as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(values).not.toHaveProperty('att_zip_col');
    expect(JSON.stringify(values)).not.toContain(SENSITIVE[4]);
  });

  it('prints and stores no answer in a debug dry run', async () => {
    const { deps, attendeeStore } = setup({ att: attendee({ answers: answers('95112') }) });
    const m = msg();
    const output = await captured(() => consumeWriteBatch([m], full(deps), gate('off')), attendeeStore);
    expect(m.ack).toHaveBeenCalled();
    expect(output).toContain('createItem');
    for (const text of [...SENSITIVE, '95112']) expect(output).not.toContain(text);
  });

  it('prints and stores no answer when the Monday write fails', async () => {
    const { deps, attendeeStore } = setup({
      att: attendee({ answers: answers('95112') }),
      monday: { createItem: vi.fn().mockRejectedValue(new Error('monday down')) },
    });
    const m = msg();
    const output = await captured(() => consumeWriteBatch([m], full(deps), gate('on')), attendeeStore);
    expect(m.retry).toHaveBeenCalled();
    expect(output).toContain('monday down');
    for (const text of [...SENSITIVE, '95112']) expect(output).not.toContain(text);
  });
});

describe('registration employer answers', () => {
  const answered = () => attendee({ created: '2026-10-01T18:00:00Z', answers: EMPLOYER_ANSWERS });

  it('on create, records the answer with the event name after the board write and before the ledger says written', async () => {
    const sink = fakeEmployerSink();
    const s = setup({ att: answered(), monday: { findItemByColumnValue: peopleLookup() } });
    await processAttendee(message, withSink(s.deps, sink));
    expect(sink.recordEmployerAnswer).toHaveBeenCalledWith({
      source: 'eventbrite', sourceId: 'a1', personItemId: PERSON_ITEM_ID, answer: EMPLOYER_ANSWER, answeredAt: '2026-10-01', context: 'Adult Learn to Ride',
    });
    expectRecordedBetween(s.mondayClient.createItem as Mock, sink, s.attendeeStore);
    // Registered, so no People link is written: the lookup is only for the hand-over.
    expect((s.mondayClient.createItem as Mock).mock.calls[0]![2].att_person_col).toBeUndefined();
  });

  it('on update, records the answer after the board write and before the ledger says written', async () => {
    const sink = fakeEmployerSink();
    const s = setup({ ...existing, att: answered(), current: 'Registered', monday: { findItemByColumnValue: peopleLookup() } });
    await processAttendee(message, withSink(s.deps, sink));
    expectRecordedBetween(s.mondayClient.changeColumnValues as Mock, sink, s.attendeeStore);
  });

  it('a thrown hand-over leaves the row unwritten and propagates; the retry adopts the item it created', async () => {
    const sink = fakeEmployerSink();
    sink.recordEmployerAnswer.mockRejectedValueOnce(new Error('impact-attribution unreachable'));
    let created: string | null = null;
    const s = setup({
      att: answered(),
      monday: {
        findItemByColumnValue: peopleLookup((board) => (board === 333 && created !== null ? { id: created } : null)),
        createItem: vi.fn().mockImplementation(async () => { created = 'reg-1'; return { id: 'reg-1' }; }),
        getItems: vi.fn().mockResolvedValue([mondayItem('reg-1', 'Pat', { att_attendance_col: 'Registered' })]),
      },
    });
    const deps = withSink(s.deps, sink);
    await expect(processAttendee(message, deps)).rejects.toThrow('impact-attribution unreachable');
    expectNotWritten(s.attendeeStore);
    await processAttendee(message, deps);
    expect(s.mondayClient.createItem).toHaveBeenCalledTimes(1);
    expect(s.attendeeStore.updateStatus).toHaveBeenLastCalledWith('a1', 'written', expect.objectContaining({ mondayItemId: 'reg-1' }));
  });

  it('a gone item records nothing', async () => {
    const sink = fakeEmployerSink();
    const s = setup({ ...existing, att: answered(), monday: { findItemByColumnValue: peopleLookup(), getItems: vi.fn().mockResolvedValue([]) } });
    await processAttendee(message, withSink(s.deps, sink));
    expect(sink.recordEmployerAnswer).not.toHaveBeenCalled();
  });

  it('under off, sends nothing', async () => {
    const sink = fakeEmployerSink();
    const s = setup({ att: answered(), monday: { findItemByColumnValue: peopleLookup() } });
    const full = { ...withSink(s.deps, sink), orderStore: { recordDelivery: vi.fn(), updateStatus: vi.fn(), getOrder: vi.fn() } } as ProcessBatchDeps;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await consumeWriteBatch([{ body: message, attempts: 1, ack: vi.fn(), retry: vi.fn() }], full, { worker: 'eventbrite-sync', environment: 'production', mode: 'off', logLevel: 'debug', piiKeys: ['name', 'email'] });
      expect(sink.recordEmployerAnswer).not.toHaveBeenCalled();
      const text = log.mock.calls.flat().map(String).join('\n');
      expect(text).toContain('"sink":"Employer answers"');
      expect(text).not.toContain(EMPLOYER_ANSWER);
    } finally {
      log.mockRestore();
    }
  });
});
