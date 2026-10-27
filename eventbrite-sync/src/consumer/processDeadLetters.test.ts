import { describe, it, expect, vi } from 'vitest';
import { fakeEventStore, fakeAttendeeStore } from '../test/fakeStores';
import { processDeadLetters, DEAD_LETTER_PREFIX } from './processDeadLetters';
import type { OrderStore } from '../db/orders';
import type { OrderRow } from '../types';

function row(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    orderId: 'o-1',
    eventId: null,
    lastAction: 'order.placed',
    status: 'failed',
    eventbriteStatus: null,
    amount: null,
    currency: null,
    orderCreated: null,
    matchedDonorItemId: null,
    mondayItemId: null,
    error: 'monday API: status label "Refunded" not found',
    deliveries: 1,
    receivedAt: '2026-10-06T10:00:00.000Z',
    writtenAt: null,
    ...overrides,
  };
}

function store(found: OrderRow | null): OrderStore {
  return {
    recordDelivery: vi.fn(),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    getOrder: vi.fn().mockResolvedValue(found),
  };
}

const message = (orderId = 'o-1', timestamp: Date | undefined = new Date('2026-10-06T10:00:05.000Z')) => ({
  body: { orderId, action: 'order.placed' },
  timestamp,
  ack: vi.fn(),
  retry: vi.fn(),
});

describe('processDeadLetters', () => {
  it('stamps the row failed with the dead-letter prefix, keeping the last recorded error, and acks', async () => {
    const orderStore = store(row());
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = message();
    try {
      await processDeadLetters([m], { orderStore, eventStore: fakeEventStore(), attendeeStore: fakeAttendeeStore() });
      expect(orderStore.updateStatus).toHaveBeenCalledWith('o-1', 'failed', { error: `${DEAD_LETTER_PREFIX}monday API: status label "Refunded" not found` });
      expect(m.ack).toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('1 message dead-lettered'));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('o-1'));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('does not double the prefix on a second pass', async () => {
    const orderStore = store(row({ error: `${DEAD_LETTER_PREFIX}boom` }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await processDeadLetters([message()], { orderStore, eventStore: fakeEventStore(), attendeeStore: fakeAttendeeStore() });
      expect(orderStore.updateStatus).toHaveBeenCalledWith('o-1', 'failed', { error: `${DEAD_LETTER_PREFIX}boom` });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('leaves a row that was written after the message was sent, and logs nothing as dead', async () => {
    const orderStore = store(row({ status: 'written', writtenAt: '2026-10-06T10:01:00.000Z', error: null }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const m = message();
    try {
      await processDeadLetters([m], { orderStore, eventStore: fakeEventStore(), attendeeStore: fakeAttendeeStore() });
      expect(orderStore.updateStatus).not.toHaveBeenCalled();
      expect(m.ack).toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      log.mockRestore();
    }
  });

  it('leaves a row replaced by a newer delivery since the message was sent', async () => {
    const orderStore = store(row({ status: 'queued', receivedAt: '2026-10-06T11:00:00.000Z' }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const m = message();
    try {
      await processDeadLetters([m], { orderStore, eventStore: fakeEventStore(), attendeeStore: fakeAttendeeStore() });
      expect(orderStore.updateStatus).not.toHaveBeenCalled();
      expect(m.ack).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('acks a message whose row is gone, with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = message('gone');
    try {
      await processDeadLetters([m], { orderStore: store(null), eventStore: fakeEventStore(), attendeeStore: fakeAttendeeStore() });
      expect(m.ack).toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('gone'));
    } finally {
      warn.mockRestore();
    }
  });

  it('retries a message it could not mark', async () => {
    const orderStore = store(row());
    (orderStore.updateStatus as any).mockRejectedValue(new Error('D1 down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = message();
    try {
      await processDeadLetters([m], { orderStore, eventStore: fakeEventStore(), attendeeStore: fakeAttendeeStore() });
      expect(m.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
      expect(m.ack).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('marks the events ledger for an event message', async () => {
    const orderStore = store(null);
    const eventStore = fakeEventStore({ getEvent: vi.fn().mockResolvedValue({ eventId: 'e-1', status: 'failed', error: 'boom', receivedAt: '2026-10-06T10:00:00.000Z', writtenAt: null }) });
    const attendeeStore = fakeAttendeeStore();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = { ...message(), body: { kind: 'event' as const, eventId: 'e-1', action: 'event.updated' } };
    try {
      await processDeadLetters([m], { orderStore, eventStore, attendeeStore });
      expect(eventStore.updateStatus).toHaveBeenCalledWith('e-1', 'failed', { error: `${DEAD_LETTER_PREFIX}boom` });
      expect(attendeeStore.updateStatus).not.toHaveBeenCalled();
      expect(orderStore.updateStatus).not.toHaveBeenCalled();
      expect(m.ack).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('marks the attendees ledger for an attendee message', async () => {
    const orderStore = store(null);
    const eventStore = fakeEventStore();
    const attendeeStore = fakeAttendeeStore({ getAttendee: vi.fn().mockResolvedValue({ attendeeId: 'a-1', status: 'failed', error: null, receivedAt: '2026-10-06T10:00:00.000Z', writtenAt: null }) });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = { ...message(), body: { kind: 'attendee' as const, eventId: 'e-1', attendeeId: 'a-1', action: 'attendee.updated' } };
    try {
      await processDeadLetters([m], { orderStore, eventStore, attendeeStore });
      expect(attendeeStore.updateStatus).toHaveBeenCalledWith('a-1', 'failed', { error: `${DEAD_LETTER_PREFIX}(no recorded error)` });
      expect(eventStore.updateStatus).not.toHaveBeenCalled();
      expect(orderStore.updateStatus).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('warns and acks an event message with no events row, without marking anything', async () => {
    const eventStore = fakeEventStore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = { ...message(), body: { kind: 'event' as const, eventId: 'e-9', action: 'event.updated' } };
    try {
      await processDeadLetters([m], { orderStore: store(null), eventStore, attendeeStore: fakeAttendeeStore() });
      expect(warn).toHaveBeenCalledWith('eventbrite-sync dlq: no events row for "e-9"; nothing to mark');
      expect(eventStore.updateStatus).not.toHaveBeenCalled();
      expect(m.ack).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
