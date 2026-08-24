import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1MondayEventStore } from './mondayEvents';

describe('D1MondayEventStore', () => {
  it('inserts a new event and reads it back', async () => {
    const store = new D1MondayEventStore(env.DB);
    const result = await store.insertEvent({
      eventId: 'item-1',
      mondayItemId: 'item-1',
      rawPayload: '{"text_col":"Acme"}',
      receivedAt: '2026-08-22T00:00:00.000Z',
    });
    expect(result).toBe('inserted');

    const row = await store.getEvent('item-1');
    expect(row).toEqual({
      eventId: 'item-1',
      mondayItemId: 'item-1',
      rawPayload: '{"text_col":"Acme"}',
      status: 'received',
      qbId: null,
      error: null,
      receivedAt: '2026-08-22T00:00:00.000Z',
      writtenAt: null,
    });
  });

  it('reports duplicate on a second insert with the same event id', async () => {
    const store = new D1MondayEventStore(env.DB);
    await store.insertEvent({
      eventId: 'item-2',
      mondayItemId: 'item-2',
      rawPayload: '{}',
      receivedAt: '2026-08-22T00:00:00.000Z',
    });
    const second = await store.insertEvent({
      eventId: 'item-2',
      mondayItemId: 'item-2',
      rawPayload: '{}',
      receivedAt: '2026-08-22T00:00:01.000Z',
    });
    expect(second).toBe('duplicate');
  });

  it('updates status and records the new QuickBooks id once created', async () => {
    const store = new D1MondayEventStore(env.DB);
    await store.insertEvent({
      eventId: 'item-3',
      mondayItemId: 'item-3',
      rawPayload: '{}',
      receivedAt: '2026-08-22T00:00:00.000Z',
    });

    await store.updateStatus('item-3', 'failed', { error: 'boom' });
    let row = await store.getEvent('item-3');
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('boom');

    await store.updateStatus('item-3', 'written', { qbId: 'qb-99', writtenAt: '2026-08-22T01:00:00.000Z' });
    row = await store.getEvent('item-3');
    expect(row?.status).toBe('written');
    expect(row?.qbId).toBe('qb-99');
    expect(row?.writtenAt).toBe('2026-08-22T01:00:00.000Z');
    expect(row?.error).toBeNull();
  });

  it('returns null for an unknown event id', async () => {
    const store = new D1MondayEventStore(env.DB);
    expect(await store.getEvent('does-not-exist')).toBeNull();
  });
});
