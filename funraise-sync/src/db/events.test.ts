import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1EventStore } from './events';

describe('D1EventStore', () => {
  it('inserts a new event and reads it back', async () => {
    const store = new D1EventStore(env.DB);
    const result = await store.insertEvent({
      eventId: 'evt-1',
      entityType: 'transaction',
      rawPayload: '{"amount":100}',
      receivedAt: '2026-08-22T00:00:00.000Z',
    });
    expect(result).toBe('inserted');

    const row = await store.getEvent('evt-1');
    expect(row).toEqual({
      eventId: 'evt-1',
      entityType: 'transaction',
      rawPayload: '{"amount":100}',
      matchedDonorItemId: null,
      mondayItemId: null,
      status: 'received',
      error: null,
      receivedAt: '2026-08-22T00:00:00.000Z',
      writtenAt: null,
    });
  });

  it('reports duplicate on a second insert with the same event id', async () => {
    const store = new D1EventStore(env.DB);
    await store.insertEvent({
      eventId: 'evt-2',
      entityType: 'transaction',
      rawPayload: '{}',
      receivedAt: '2026-08-22T00:00:00.000Z',
    });
    const second = await store.insertEvent({
      eventId: 'evt-2',
      entityType: 'transaction',
      rawPayload: '{}',
      receivedAt: '2026-08-22T00:00:01.000Z',
    });
    expect(second).toBe('duplicate');
  });

  it('updates status and patch fields, then clears error on the next update', async () => {
    const store = new D1EventStore(env.DB);
    await store.insertEvent({
      eventId: 'evt-3',
      entityType: 'transaction',
      rawPayload: '{}',
      receivedAt: '2026-08-22T00:00:00.000Z',
    });

    await store.updateStatus('evt-3', 'failed', { error: 'boom' });
    let row = await store.getEvent('evt-3');
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('boom');

    await store.updateStatus('evt-3', 'written', { mondayItemId: 'item-9', writtenAt: '2026-08-22T01:00:00.000Z' });
    row = await store.getEvent('evt-3');
    expect(row?.status).toBe('written');
    expect(row?.mondayItemId).toBe('item-9');
    expect(row?.writtenAt).toBe('2026-08-22T01:00:00.000Z');
    expect(row?.error).toBeNull();
  });

  it('returns null for an unknown event id', async () => {
    const store = new D1EventStore(env.DB);
    expect(await store.getEvent('does-not-exist')).toBeNull();
  });
});
