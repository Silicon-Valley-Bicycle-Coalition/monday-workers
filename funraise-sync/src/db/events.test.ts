import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1EventStore } from './events';

function newEvent(overrides: Partial<Parameters<D1EventStore['upsertEvent']>[0]> = {}) {
  return {
    eventId: 'evt-1',
    entityType: 'transaction' as const,
    entityId: 'txn-1',
    rawPayload: '{"amount":100}',
    receivedAt: '2026-08-22T00:00:00.000Z',
    ...overrides,
  };
}

describe('D1EventStore', () => {
  it('inserts a new event and reads it back by entity', async () => {
    const store = new D1EventStore(env.DB);
    const result = await store.upsertEvent(newEvent());
    expect(result).toBe('inserted');

    const row = await store.getEventByEntity('transaction', 'txn-1');
    expect(row).toEqual({
      eventId: 'evt-1',
      entityType: 'transaction',
      entityId: 'txn-1',
      rawPayload: '{"amount":100}',
      matchedDonorItemId: null,
      mondayItemId: null,
      status: 'received',
      error: null,
      receivedAt: '2026-08-22T00:00:00.000Z',
      writtenAt: null,
    });
  });

  it('reports duplicate when the same delivery (event id) arrives twice', async () => {
    const store = new D1EventStore(env.DB);
    await store.upsertEvent(newEvent({ eventId: 'evt-2', entityId: 'txn-2' }));
    const second = await store.upsertEvent(newEvent({ eventId: 'evt-2', entityId: 'txn-2' }));
    expect(second).toBe('duplicate');
  });

  it('reports updated and replaces the payload when a new delivery arrives for a known entity', async () => {
    const store = new D1EventStore(env.DB);
    await store.upsertEvent(newEvent({ eventId: 'evt-3a', entityId: 'txn-3', rawPayload: '{"amount":100}' }));
    await store.updateStatusByEntity('transaction', 'txn-3', 'written', {
      mondayItemId: 'item-1',
      writtenAt: '2026-08-22T01:00:00.000Z',
    });

    const result = await store.upsertEvent(
      newEvent({ eventId: 'evt-3b', entityId: 'txn-3', rawPayload: '{"amount":50}', receivedAt: '2026-08-22T02:00:00.000Z' })
    );
    expect(result).toBe('updated');

    const row = await store.getEventByEntity('transaction', 'txn-3');
    expect(row?.eventId).toBe('evt-3b');
    expect(row?.rawPayload).toBe('{"amount":50}');
    expect(row?.status).toBe('received');
    expect(row?.receivedAt).toBe('2026-08-22T02:00:00.000Z');
    // The Monday item id must survive the update — it's what tells the consumer to update, not create.
    expect(row?.mondayItemId).toBe('item-1');
  });

  it('same entity id under a different entity type is a separate entity', async () => {
    const store = new D1EventStore(env.DB);
    await store.upsertEvent(newEvent({ eventId: 'evt-4a', entityType: 'transaction', entityId: 'shared-4' }));
    const result = await store.upsertEvent(
      newEvent({ eventId: 'evt-4b', entityType: 'subscription', entityId: 'shared-4' })
    );
    expect(result).toBe('inserted');
  });

  it('updates status and patch fields by entity, then clears error on the next update', async () => {
    const store = new D1EventStore(env.DB);
    await store.upsertEvent(newEvent({ eventId: 'evt-5', entityId: 'txn-5' }));

    await store.updateStatusByEntity('transaction', 'txn-5', 'failed', { error: 'boom' });
    let row = await store.getEventByEntity('transaction', 'txn-5');
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('boom');

    await store.updateStatusByEntity('transaction', 'txn-5', 'written', {
      mondayItemId: 'item-9',
      writtenAt: '2026-08-22T01:00:00.000Z',
    });
    row = await store.getEventByEntity('transaction', 'txn-5');
    expect(row?.status).toBe('written');
    expect(row?.mondayItemId).toBe('item-9');
    expect(row?.error).toBeNull();
  });

  it('returns null for an unknown entity', async () => {
    const store = new D1EventStore(env.DB);
    expect(await store.getEventByEntity('transaction', 'does-not-exist')).toBeNull();
  });

  describe('purgeWrittenPayloads', () => {
    it('empties raw_payload only for written events older than the cutoff', async () => {
      const store = new D1EventStore(env.DB);
      await store.upsertEvent(newEvent({ eventId: 'evt-6', entityId: 'txn-old', rawPayload: '{"pii":"old"}' }));
      await store.updateStatusByEntity('transaction', 'txn-old', 'written', {
        mondayItemId: 'item-6',
        writtenAt: '2026-01-01T00:00:00.000Z',
      });
      await store.upsertEvent(newEvent({ eventId: 'evt-7', entityId: 'txn-recent', rawPayload: '{"pii":"recent"}' }));
      await store.updateStatusByEntity('transaction', 'txn-recent', 'written', {
        mondayItemId: 'item-7',
        writtenAt: '2026-08-20T00:00:00.000Z',
      });
      await store.upsertEvent(newEvent({ eventId: 'evt-8', entityId: 'txn-failed', rawPayload: '{"pii":"failed"}' }));
      await store.updateStatusByEntity('transaction', 'txn-failed', 'failed', { error: 'boom' });

      const purged = await store.purgeWrittenPayloads('2026-06-01T00:00:00.000Z');
      expect(purged).toBe(1);

      expect((await store.getEventByEntity('transaction', 'txn-old'))?.rawPayload).toBe('{}');
      // Recent writes keep their payload for replay/debugging within the retention window.
      expect((await store.getEventByEntity('transaction', 'txn-recent'))?.rawPayload).toBe('{"pii":"recent"}');
      // Failed events keep their payload until resolved, regardless of age.
      expect((await store.getEventByEntity('transaction', 'txn-failed'))?.rawPayload).toBe('{"pii":"failed"}');
    });
  });
});
