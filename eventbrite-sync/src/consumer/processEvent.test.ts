import { describe, it, expect, vi } from 'vitest';
import { processEvent } from './processEvent';
import { consumeWriteBatch } from './processBatch';
import { fakeEventStore, fakeAttendeeStore } from '../test/fakeStores';
import { testConfig } from '../test/testConfig';
import { MondayApiError } from '../monday/graphql';
import type { ProcessBatchDeps, WriteQueueMessage } from './processBatch';
import type { EventbriteEvent } from '../eventbrite/client';
import type { MondayClient } from '../monday/client';
import type { AttendeeRow, EventRow } from '../types';

const config = testConfig();

function event(overrides: Partial<EventbriteEvent> = {}): EventbriteEvent {
  return {
    id: '9001',
    name: { text: 'Adult Learn to Ride' },
    start: { utc: '2026-10-31T02:00:00Z', timezone: 'America/Los_Angeles' },
    end: { utc: '2026-10-31T04:00:00Z' },
    status: 'live',
    url: 'https://www.eventbrite.com/e/9001',
    organizer_id: 'org-public',
    organizer: { name: 'Silicon Valley Bicycle Coalition' },
    online_event: false,
    venue: { name: 'Mitchell Park', address: { address_1: '600 E Meadow Dr', city: 'Palo Alto', localized_address_display: '600 E Meadow Dr, Palo Alto, CA 94306' } },
    ...overrides,
  };
}

function eventRow(overrides: Partial<EventRow> = {}): EventRow {
  return {
    eventId: '9001', mondayItemId: null, startsAt: null, endsAt: null, locationKey: null, eventbriteStatus: null,
    status: 'received', lastAction: 'event.created', error: null, deliveries: 1, receivedAt: '2026-10-20T00:00:00.000Z', writtenAt: null,
    ...overrides,
  };
}

function attendeeRow(attendeeId: string): AttendeeRow {
  return {
    attendeeId, eventId: '9001', mondayItemId: null, matchedPersonItemId: null, status: 'written', lastAction: 'attendee.updated',
    error: null, deliveries: 1, receivedAt: '2026-10-20T00:00:00.000Z', writtenAt: null,
  };
}

function fakeMonday(overrides: Partial<MondayClient> = {}): MondayClient {
  return {
    findItemByColumnValue: vi.fn().mockResolvedValue(null),
    createItem: vi.fn().mockResolvedValue({ id: 'item-1' }),
    changeColumnValues: vi.fn().mockResolvedValue(undefined),
    getItems: vi.fn(), postUpdate: vi.fn(),
    ...overrides,
  };
}

function setup(opts: { row?: EventRow | null; event?: EventbriteEvent | null; monday?: Partial<MondayClient>; attendees?: AttendeeRow[]; config?: typeof config } = {}) {
  const row = opts.row === undefined ? eventRow() : opts.row;
  const eventStore = fakeEventStore({ getEvent: vi.fn().mockResolvedValue(row) });
  const attendeeStore = fakeAttendeeStore({ listByEvent: vi.fn().mockResolvedValue(opts.attendees ?? []) });
  const queue = { send: vi.fn().mockResolvedValue(undefined), sendBatch: vi.fn().mockResolvedValue(undefined) };
  // Every message the fan-out sent, across however many sendBatch calls.
  const sent = (): WriteQueueMessage[] => queue.sendBatch.mock.calls.flatMap((c) => c[0] as WriteQueueMessage[]);
  const mondayClient = fakeMonday(opts.monday);
  const eventbriteClient = { getOrder: vi.fn(), getEvent: vi.fn().mockResolvedValue(opts.event === undefined ? event() : opts.event), getAttendee: vi.fn() };
  const deps = { eventStore, attendeeStore, queue, mondayClient, eventbriteClient, config: opts.config ?? config } as unknown as ProcessBatchDeps;
  return { deps, eventStore, attendeeStore, queue, sent, mondayClient, eventbriteClient };
}

const message = { kind: 'event' as const, eventId: '9001', action: 'event.updated' };

describe('processEvent', () => {
  it('creates an Events item for a new event and records the written facts', async () => {
    const { deps, mondayClient, eventStore, queue } = setup();
    await processEvent(message, deps);
    expect(mondayClient.findItemByColumnValue).toHaveBeenCalledWith(222, 'ev_id_col', '9001');
    expect(mondayClient.createItem).toHaveBeenCalledWith(222, 'Adult Learn to Ride', expect.objectContaining({ ev_id_col: '9001' }));
    expect(mondayClient.changeColumnValues).not.toHaveBeenCalled();
    expect(eventStore.updateStatus).toHaveBeenCalledWith('9001', 'written', expect.objectContaining({
      mondayItemId: 'item-1',
      startsAt: '2026-10-31T02:00:00.000Z',
      endsAt: '2026-10-31T04:00:00.000Z',
      locationKey: 'mitchell park, 600 e meadow dr, palo alto, ca 94306',
      eventbriteStatus: 'live',
      writtenAt: expect.any(String),
    }));
    expect(queue.send).not.toHaveBeenCalled();
  });

  it('writes Completed for a finished event Eventbrite still reports as started', async () => {
    const { deps, mondayClient } = setup({
      row: eventRow({ mondayItemId: 'item-9' }),
      event: event({ status: 'started', start: { utc: '2020-01-01T02:00:00Z' }, end: { utc: '2020-01-01T04:00:00Z' } }),
    });
    await processEvent(message, deps);
    expect(mondayClient.changeColumnValues).toHaveBeenCalledWith(222, 'item-9', expect.objectContaining({ ev_status_col: 'Completed' }));
  });

  // The class email routes and the ended-event sweep read this, so neither treats the class as open.
  it('records a canceled event Eventbrite still reports as live as canceled in the ledger', async () => {
    const { deps, eventStore, mondayClient } = setup({
      row: eventRow({ mondayItemId: 'item-9' }),
      event: event({ status: 'live', event_sales_status: { sales_status: 'sales_ended', message_code: 'event_cancelled' } }),
    });
    await processEvent(message, deps);
    expect(mondayClient.changeColumnValues).toHaveBeenCalledWith(222, 'item-9', expect.objectContaining({ ev_status_col: 'Canceled' }));
    expect(eventStore.updateStatus).toHaveBeenCalledWith('9001', 'written', expect.objectContaining({ eventbriteStatus: 'canceled' }));
  });

  // The ended-event sweep reads written_at before ends_at as "that write can't have been Completed".
  it('stamps written_at with the moment it chose the status, when the Monday write spans the end', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-31T03:59:59.000Z'));
      const { deps, eventStore, mondayClient } = setup({
        row: eventRow({ mondayItemId: 'item-9' }),
        monday: { changeColumnValues: vi.fn(async () => { vi.setSystemTime(new Date('2026-10-31T04:00:05.000Z')); }) },
      });
      await processEvent(message, deps);
      expect(mondayClient.changeColumnValues).toHaveBeenCalledWith(222, 'item-9', expect.objectContaining({ ev_status_col: 'Upcoming' }));
      expect(eventStore.updateStatus).toHaveBeenCalledWith('9001', 'written', expect.objectContaining({
        endsAt: '2026-10-31T04:00:00.000Z',
        writtenAt: '2026-10-31T03:59:59.000Z',
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('adopts an existing item found by the Eventbrite id column: changes values, never creates', async () => {
    const { deps, mondayClient, eventStore } = setup({ monday: { findItemByColumnValue: vi.fn().mockResolvedValue({ id: 'staff-7' }) } });
    await processEvent(message, deps);
    expect(mondayClient.createItem).not.toHaveBeenCalled();
    expect(mondayClient.changeColumnValues).toHaveBeenCalledWith(222, 'staff-7', expect.objectContaining({ ev_id_col: '9001' }));
    expect(eventStore.updateStatus).toHaveBeenCalledWith('9001', 'written', expect.objectContaining({ mondayItemId: 'staff-7' }));
  });

  it('uses the ledger item id without a board lookup', async () => {
    const { deps, mondayClient } = setup({ row: eventRow({ mondayItemId: 'item-9' }) });
    await processEvent(message, deps);
    expect(mondayClient.findItemByColumnValue).not.toHaveBeenCalled();
    expect(mondayClient.changeColumnValues).toHaveBeenCalledWith(222, 'item-9', expect.any(Object));
  });

  it('renames an existing Events item to the Eventbrite name; a create names it via item_name only', async () => {
    const existing = setup({ row: eventRow({ mondayItemId: 'item-9' }), event: event({ name: { text: 'Adult Learn to Ride (Spanish)' } }) });
    await processEvent(message, existing.deps);
    expect(existing.mondayClient.changeColumnValues).toHaveBeenCalledWith(222, 'item-9', expect.objectContaining({ name: 'Adult Learn to Ride (Spanish)' }));

    const created = setup();
    await processEvent(message, created.deps);
    expect(vi.mocked(created.mondayClient.createItem).mock.calls[0]![2]).not.toHaveProperty('name');
  });

  it('keeps the existing Events item name when Eventbrite has no event name', async () => {
    const { deps, mondayClient } = setup({ row: eventRow({ mondayItemId: 'item-9' }), event: event({ name: { text: ' ' } }) });
    await processEvent(message, deps);
    expect(vi.mocked(mondayClient.changeColumnValues).mock.calls[0]![2]).not.toHaveProperty('name');
  });

  it('marks a 404 from Eventbrite failed without throwing', async () => {
    const { deps, eventStore, mondayClient } = setup({ event: null });
    await processEvent(message, deps);
    expect(eventStore.updateStatus).toHaveBeenCalledWith('9001', 'failed', { error: 'event not found in Eventbrite (HTTP 404)' });
    expect(mondayClient.createItem).not.toHaveBeenCalled();
  });

  it('marks a deleted item failed and does not recreate it', async () => {
    const gone = new MondayApiError('Item not found', { code: 'ItemNotFound' });
    const { deps, eventStore, mondayClient } = setup({ row: eventRow({ mondayItemId: 'item-9' }), monday: { changeColumnValues: vi.fn().mockRejectedValue(gone) } });
    await processEvent(message, deps);
    expect(mondayClient.createItem).not.toHaveBeenCalled();
    expect(eventStore.updateStatus).toHaveBeenCalledWith('9001', 'failed', { error: expect.stringContaining('item-9') });
  });

  it('rethrows other Monday errors for retry', async () => {
    const { deps } = setup({ row: eventRow({ mondayItemId: 'item-9' }), monday: { changeColumnValues: vi.fn().mockRejectedValue(new Error('boom')) } });
    await expect(processEvent(message, deps)).rejects.toThrow('boom');
  });

  it('throws when there is no events row', async () => {
    const { deps } = setup({ row: null });
    await expect(processEvent(message, deps)).rejects.toThrow(/no events row/);
  });

  it('throws when the Events board is unconfigured', async () => {
    const { deps } = setup({ config: testConfig({}, { events: null }) });
    await expect(processEvent(message, deps)).rejects.toThrow(/boards\["events"\]/);
  });

  describe('fan-out on reschedule or move', () => {
    const written = { mondayItemId: 'item-9', startsAt: '2026-10-31T02:00:00.000Z', locationKey: 'mitchell park, 600 e meadow dr, palo alto, ca 94306', status: 'written' as const };

    it('enqueues one attendee message per registration, in one sendBatch, when the start changed', async () => {
      const { deps, queue, eventStore } = setup({
        row: eventRow({ ...written, startsAt: '2026-10-24T02:00:00.000Z' }),
        attendees: [attendeeRow('a1'), attendeeRow('a2')],
      });
      await processEvent(message, deps);
      expect(queue.send).not.toHaveBeenCalled();
      expect(queue.sendBatch).toHaveBeenCalledTimes(1);
      expect(queue.sendBatch).toHaveBeenCalledWith([
        { kind: 'attendee', eventId: '9001', attendeeId: 'a1', action: 'event.updated' },
        { kind: 'attendee', eventId: '9001', attendeeId: 'a2', action: 'event.updated' },
      ]);
      expect(eventStore.updateStatus).toHaveBeenCalledWith('9001', 'written', expect.any(Object));
    });

    it('splits a class larger than one sendBatch (100 messages) across calls (#75)', async () => {
      const ids = Array.from({ length: 150 }, (_, i) => `a${i}`);
      const { deps, queue, sent } = setup({ row: eventRow({ ...written, startsAt: '2026-10-24T02:00:00.000Z' }), attendees: ids.map((id) => attendeeRow(id)) });
      await processEvent(message, deps);
      expect(queue.sendBatch.mock.calls.map((c) => (c[0] as WriteQueueMessage[]).length)).toEqual([100, 50]);
      expect(sent().map((m) => (m.kind === 'attendee' ? m.attendeeId : null))).toEqual(ids);
    });

    it('enqueues when the location changed', async () => {
      const { deps, sent } = setup({ row: eventRow({ ...written, locationKey: 'somewhere else' }), attendees: [attendeeRow('a1')] });
      await processEvent(message, deps);
      expect(sent()).toHaveLength(1);
    });

    it('enqueues nothing when start and location are unchanged', async () => {
      const { deps, queue } = setup({ row: eventRow(written), attendees: [attendeeRow('a1')] });
      await processEvent(message, deps);
      expect(queue.sendBatch).not.toHaveBeenCalled();
    });

    it('enqueues nothing on the first write, when there is no previous start or location', async () => {
      const { deps, queue, attendeeStore } = setup({ attendees: [attendeeRow('a1')] });
      await processEvent(message, deps);
      expect(queue.sendBatch).not.toHaveBeenCalled();
      expect(attendeeStore.listByEvent).not.toHaveBeenCalled();
    });

    it('does not mark the row written when the fan-out fails, so the retry fans out again', async () => {
      const { deps, eventStore, queue } = setup({
        row: eventRow({ ...written, startsAt: '2026-10-24T02:00:00.000Z' }),
        attendees: [attendeeRow('a1')],
      });
      queue.sendBatch.mockRejectedValue(new Error('queue down'));
      await expect(processEvent(message, deps)).rejects.toThrow('queue down');
      expect(eventStore.updateStatus).not.toHaveBeenCalled();
    });
  });
});

// Write switch (spec 2026-10-26): event messages go through consumeWriteBatch like orders.
describe('event messages under the write switch', () => {
  // setup() builds only what this consumer reaches; the dry-run deps also wrap the orders ledger.
  const full = (deps: ProcessBatchDeps): ProcessBatchDeps => ({ ...deps, orderStore: { recordDelivery: vi.fn(), updateStatus: vi.fn(), getOrder: vi.fn() } });
  const gate = (mode: 'on' | 'off' | 'hold' | 'unknown') => ({ worker: 'eventbrite-sync', environment: 'production', mode, logLevel: 'normal' as const, piiKeys: ['name', 'email'] });
  const moved = { mondayItemId: 'item-9', startsAt: '2026-10-24T02:00:00.000Z', locationKey: 'mitchell park, 600 e meadow dr, palo alto, ca 94306', status: 'written' as const };
  const msg = (stamp: { writeStamp?: 'dropped' } = {}) => ({ body: { ...message, ...stamp }, attempts: 1, ack: vi.fn(), retry: vi.fn() });

  function skipLines(log: { mock: { calls: unknown[][] } }): Record<string, any>[] {
    return log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"writeSwitch":"skipped"')).map((l) => JSON.parse(l));
  }

  it('off: logs the Events write and each attendee fan-out; writes, sends and records nothing, then acks', async () => {
    const { deps, mondayClient, eventStore, queue } = setup({ row: eventRow(moved), attendees: [attendeeRow('a1'), attendeeRow('a2')] });
    const m = msg();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await consumeWriteBatch([m], full(deps), gate('off'));
      expect(mondayClient.changeColumnValues).not.toHaveBeenCalled();
      expect(mondayClient.createItem).not.toHaveBeenCalled();
      expect(queue.sendBatch).not.toHaveBeenCalled();
      expect(eventStore.updateStatus).not.toHaveBeenCalled();
      expect(m.ack).toHaveBeenCalled();
      expect(skipLines(log).map((l) => [l.sink, l.operation, l.deliveryId])).toEqual([
        ['Events', 'changeColumnValues', 'event:9001'],
        ['Write queue', 'sendBatch', 'event:9001'],
      ]);
    } finally {
      log.mockRestore();
    }
  });

  it('a dropped-stamped event message is a dry run even under on', async () => {
    const { deps, mondayClient } = setup();
    const m = msg({ writeStamp: 'dropped' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await consumeWriteBatch([m], full(deps), gate('on'));
      expect(mondayClient.createItem).not.toHaveBeenCalled();
      expect(skipLines(log).map((l) => [l.sink, l.operation])).toEqual([['Events', 'createItem']]);
    } finally {
      log.mockRestore();
    }
  });

  it.each(['hold', 'unknown'] as const)('%s: retries with the backoff, processing nothing', async (mode) => {
    const { deps, eventbriteClient, eventStore } = setup();
    const m = msg();
    await consumeWriteBatch([m], full(deps), gate(mode));
    expect(m.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(m.ack).not.toHaveBeenCalled();
    expect(eventStore.getEvent).not.toHaveBeenCalled();
    expect(eventbriteClient.getEvent).not.toHaveBeenCalled();
  });

  it('on: writes and fans out unstamped attendee messages, as before', async () => {
    const { deps, mondayClient, sent } = setup({ row: eventRow(moved), attendees: [attendeeRow('a1')] });
    const m = msg();
    await consumeWriteBatch([m], full(deps), gate('on'));
    expect(mondayClient.changeColumnValues).toHaveBeenCalledTimes(1);
    expect(sent()).toEqual([{ kind: 'attendee', eventId: '9001', attendeeId: 'a1', action: 'event.updated' }]);
    expect(m.ack).toHaveBeenCalled();
  });

  it('a fan-out sent on behalf of a dropped event carries its stamp', async () => {
    const { deps, sent } = setup({ row: eventRow(moved), attendees: [attendeeRow('a1')] });
    await processEvent({ ...message, writeStamp: 'dropped' }, deps);
    expect(sent()).toEqual([{ kind: 'attendee', eventId: '9001', attendeeId: 'a1', action: 'event.updated', writeStamp: 'dropped' }]);
  });
});
