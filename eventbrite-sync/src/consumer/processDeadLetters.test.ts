import { describe, it, expect, vi } from 'vitest';
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
      await processDeadLetters([m], { orderStore });
      expect(orderStore.updateStatus).toHaveBeenCalledWith('o-1', 'failed', { error: `${DEAD_LETTER_PREFIX}monday API: status label "Refunded" not found` });
      expect(m.ack).toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('1 order dead-lettered'));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('o-1'));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('does not double the prefix on a second pass', async () => {
    const orderStore = store(row({ error: `${DEAD_LETTER_PREFIX}boom` }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await processDeadLetters([message()], { orderStore });
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
      await processDeadLetters([m], { orderStore });
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
      await processDeadLetters([m], { orderStore });
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
      await processDeadLetters([m], { orderStore: store(null) });
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
      await processDeadLetters([m], { orderStore });
      expect(m.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
      expect(m.ack).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
