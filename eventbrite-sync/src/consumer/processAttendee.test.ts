import { describe, it, expect, vi } from 'vitest';
import { processAttendee } from './processAttendee';
import { consumeWriteBatch } from './processBatch';
import { fakeEventStore, fakeAttendeeStore } from '../test/fakeStores';
import { testConfig } from '../test/testConfig';
import { MondayApiError } from '../monday/graphql';
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
      monday: { getItems: vi.fn().mockResolvedValue([mondayItem('reg-9', 'Pat', { att_attendance_col: 'No Show' })]), findItemByColumnValue: vi.fn().mockResolvedValue({ id: '777' }) },
    });
    await processAttendee(message, deps);
    expect(mondayClient.getItems).toHaveBeenCalledWith(333, ['reg-9'], ['att_attendance_col', 'att_person_col']);
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
      monday: { getItems: vi.fn().mockResolvedValue([mondayItem('reg-9', 'Pat', { att_attendance_col: 'Registered', att_person_col: 'Staff Chosen' })]) },
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
      expect(skipLines(log).map((l) => [l.sink, l.operation, l.deliveryId])).toEqual([['Event Registrations', 'createItem', 'attendee:a1']]);
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
      await consumeWriteBatch([m], full(deps), { ...gate('off'), logLevel: 'debug' });
      expect(mondayClient.createItem).not.toHaveBeenCalled();
      // No placeholder person id reaches the ledger.
      expect(attendeeStore.updateStatus).not.toHaveBeenCalled();
      const lines = skipLines(log);
      expect(lines.map((l) => l.sink)).toEqual(['People', 'Event Registrations']);
      expect(JSON.stringify(lines[1]!.payload)).toContain('"item_ids":["dry-run-1"]');
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
    const { deps, queue, eventStore } = setup({ evRow: eventRow({ mondayItemId: null, status: 'queued' }) });
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
