import { describe, it, expect, vi } from 'vitest';
import { processDeadLetters, DEAD_LETTER_PREFIX } from './processDeadLetters';
import type { EventStore } from '../db/events';
import type { EventRow } from '../types';

// #25: nothing consumed funraise-sync-writes-dlq, so a gift that exhausted its retries expired
// there unseen. Dead messages must leave a distinct mark on the events row and one log line.
function row(overrides: Partial<EventRow> = {}): EventRow {
  return {
    eventId: 'txn-1:1',
    entityType: 'transaction',
    entityId: 'txn-1',
    rawPayload: '{}',
    matchedDonorItemId: null,
    mondayItemId: null,
    status: 'failed',
    error: 'monday API: status label "Refunded" not found',
    receivedAt: '2026-09-20T10:00:00.000Z',
    writtenAt: null,
    ...overrides,
  };
}

function store(found: EventRow | null): EventStore {
  return {
    upsertEvent: vi.fn(),
    updateStatusByEntity: vi.fn().mockResolvedValue(undefined),
    getEventByEntity: vi.fn().mockResolvedValue(found),
    purgeWrittenPayloads: vi.fn(),
    purgeUnresolvedPayloads: vi.fn(),
  };
}

const message = (entityId = 'txn-1', timestamp: Date | undefined = new Date('2026-09-20T10:00:05.000Z')) => ({
  body: { entityType: 'transaction' as const, entityId },
  timestamp,
  ack: vi.fn(),
  retry: vi.fn(),
});

describe('processDeadLetters', () => {
  it('stamps the row failed with the dead-letter prefix, keeping the last recorded error, and acks', async () => {
    const eventStore = store(row());
    const m = message();
    await processDeadLetters([m], { eventStore });
    expect(eventStore.updateStatusByEntity).toHaveBeenCalledWith('transaction', 'txn-1', 'failed', {
      error: `${DEAD_LETTER_PREFIX}monday API: status label "Refunded" not found`,
    });
    expect(m.ack).toHaveBeenCalled();
  });

  it('does not double the prefix on a message dead-lettered twice', async () => {
    const eventStore = store(row({ error: `${DEAD_LETTER_PREFIX}boom` }));
    await processDeadLetters([message()], { eventStore });
    expect(eventStore.updateStatusByEntity).toHaveBeenCalledWith('transaction', 'txn-1', 'failed', {
      error: `${DEAD_LETTER_PREFIX}boom`,
    });
  });

  it('says so when no error was recorded', async () => {
    const eventStore = store(row({ error: null, status: 'queued' }));
    await processDeadLetters([message()], { eventStore });
    expect(eventStore.updateStatusByEntity).toHaveBeenCalledWith('transaction', 'txn-1', 'failed', {
      error: `${DEAD_LETTER_PREFIX}(no recorded error)`,
    });
  });

  it('logs ONE error per batch naming every dead transaction', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await processDeadLetters([message('txn-1'), message('txn-2')], { eventStore: store(row()) });
    const lines = spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('dead-lettered'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('txn-1');
    expect(lines[0]).toContain('txn-2');
    expect(lines[0]).toContain('redrive-failed.mjs');
    spy.mockRestore();
  });

  it('leaves a row written at or after the message was sent alone (stale dead letter)', async () => {
    const eventStore = store(row({ status: 'written', writtenAt: '2026-09-21T00:00:00.000Z', error: null }));
    const m = message();
    await processDeadLetters([m], { eventStore });
    expect(eventStore.updateStatusByEntity).not.toHaveBeenCalled();
    expect(m.ack).toHaveBeenCalled();
  });

  it('never downgrades a written row when the message has no timestamp', async () => {
    const eventStore = store(row({ status: 'written', writtenAt: '2026-09-01T00:00:00.000Z', error: null }));
    const m = { ...message(), timestamp: undefined };
    await processDeadLetters([m], { eventStore });
    expect(eventStore.updateStatusByEntity).not.toHaveBeenCalled();
  });

  it('leaves a row replaced by a newer Funraise delivery alone — that delivery has its own message', async () => {
    const eventStore = store(row({ status: 'queued', receivedAt: '2026-09-22T00:00:00.000Z', error: null }));
    const m = message();
    await processDeadLetters([m], { eventStore });
    expect(eventStore.updateStatusByEntity).not.toHaveBeenCalled();
    expect(m.ack).toHaveBeenCalled();
  });

  it('acks a message whose row is gone', async () => {
    const m = message();
    const eventStore = store(null);
    await processDeadLetters([m], { eventStore });
    expect(eventStore.updateStatusByEntity).not.toHaveBeenCalled();
    expect(m.ack).toHaveBeenCalled();
  });

  it('retries with a delay when D1 fails', async () => {
    const eventStore = store(row());
    (eventStore.getEventByEntity as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('D1_ERROR'));
    const m = message();
    await processDeadLetters([m], { eventStore });
    expect(m.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(m.ack).not.toHaveBeenCalled();
  });
});
