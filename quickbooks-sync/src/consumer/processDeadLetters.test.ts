import { describe, it, expect, vi } from 'vitest';
import { DEAD_LETTER_PREFIX, processDeadLetters } from './processDeadLetters';
import type { QueueMessageLike } from './processBatch';
import type { QbEventStore } from '../db/qbEvents';
import type { MondayEventStore } from '../db/mondayEvents';
import type { MondayEventRow, QbEventRow, QueueMessage } from '../types';

function qbRow(overrides: Partial<QbEventRow> = {}): QbEventRow {
  return {
    eventId: 'evt-1',
    entityType: 'customer',
    qbId: '60',
    fetchedPayload: null,
    pendingMondayItemId: null,
    status: 'failed',
    error: 'monday API: HTTP 500',
    receivedAt: '2026-09-25T00:00:00.000Z',
    writtenAt: null,
    ...overrides,
  };
}

function mondayRow(overrides: Partial<MondayEventRow> = {}): MondayEventRow {
  return {
    eventId: '42',
    mondayItemId: '42',
    rawPayload: '{}',
    status: 'failed',
    qbId: null,
    error: 'quickbooks API: HTTP 400 creating customer',
    receivedAt: '2026-09-25T00:00:00.000Z',
    writtenAt: null,
    ...overrides,
  };
}

function stores(qb: QbEventRow | null, monday: MondayEventRow | null) {
  const qbEventStore: QbEventStore = {
    insertEvent: vi.fn(),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    getEvent: vi.fn().mockResolvedValue(qb),
    markMondayCreateStarted: vi.fn(),
    findByPendingMondayItemId: vi.fn(),
    hasMondayCreateInFlight: vi.fn(),
  };
  const mondayEventStore: MondayEventStore = {
    insertEvent: vi.fn(),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    getEvent: vi.fn().mockResolvedValue(monday),
  };
  return { qbEventStore, mondayEventStore };
}

function message(body: QueueMessage, timestamp?: Date): QueueMessageLike<QueueMessage> & { ack: any; retry: any } {
  return { body, timestamp, ack: vi.fn(), retry: vi.fn() };
}

describe('processDeadLetters', () => {
  it('stamps a dead qb-to-monday row failed with the dead-letter prefix, keeping its last error', async () => {
    const deps = stores(qbRow(), null);
    const msg = message({ direction: 'qb-to-monday', eventId: 'evt-1' }, new Date('2026-09-25T01:00:00.000Z'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await processDeadLetters([msg], deps);

    expect(deps.qbEventStore.updateStatus).toHaveBeenCalledWith('evt-1', 'failed', {
      error: `${DEAD_LETTER_PREFIX}monday API: HTTP 500`,
    });
    expect(msg.ack).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('stamps a dead monday-to-qb row the same way', async () => {
    const deps = stores(null, mondayRow());
    const msg = message({ direction: 'monday-to-qb', eventId: '42' });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await processDeadLetters([msg], deps);

    expect(deps.mondayEventStore.updateStatus).toHaveBeenCalledWith('42', 'failed', {
      error: `${DEAD_LETTER_PREFIX}quickbooks API: HTTP 400 creating customer`,
    });
    expect(msg.ack).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('does not double the prefix on a row already stamped', async () => {
    const deps = stores(qbRow({ error: `${DEAD_LETTER_PREFIX}boom` }), null);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await processDeadLetters([message({ direction: 'qb-to-monday', eventId: 'evt-1' })], deps);

    expect(deps.qbEventStore.updateStatus).toHaveBeenCalledWith('evt-1', 'failed', { error: `${DEAD_LETTER_PREFIX}boom` });
    vi.restoreAllMocks();
  });

  it('leaves a row written at or after the message was sent alone (stale dead letter)', async () => {
    const deps = stores(qbRow({ status: 'written', writtenAt: '2026-09-25T02:00:00.000Z' }), null);
    const msg = message({ direction: 'qb-to-monday', eventId: 'evt-1' }, new Date('2026-09-25T01:00:00.000Z'));
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await processDeadLetters([msg], deps);

    expect(deps.qbEventStore.updateStatus).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('never downgrades a written row when the message carries no timestamp', async () => {
    const deps = stores(null, mondayRow({ status: 'written', writtenAt: '2026-09-25T02:00:00.000Z' }));
    const msg = message({ direction: 'monday-to-qb', eventId: '42' });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await processDeadLetters([msg], deps);

    expect(deps.mondayEventStore.updateStatus).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('retries the dead letter when D1 fails, so the stamp is not lost', async () => {
    const deps = stores(qbRow(), null);
    (deps.qbEventStore.updateStatus as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('D1_ERROR: overloaded'));
    const msg = message({ direction: 'qb-to-monday', eventId: 'evt-1' });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await processDeadLetters([msg], deps);

    expect(msg.retry).toHaveBeenCalled();
    expect(msg.ack).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
