import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { countingDb } from '../test/countingDb';
import { D1OrderStore } from './orders';

describe('D1OrderStore', () => {
  it('records a delivery with a single D1 statement, first sight or redelivery', async () => {
    const counted = countingDb(env.DB);
    const store = new D1OrderStore(counted.db);
    await store.recordDelivery({ orderId: 'c-1', action: 'order.placed', receivedAt: '2026-10-06T00:00:00.000Z' });
    await store.recordDelivery({ orderId: 'c-1', action: 'order.updated', receivedAt: '2026-10-07T00:00:00.000Z' });
    expect(counted.prepared()).toBe(2);
  });

  it('inserts an order on first delivery and reads it back', async () => {
    const store = new D1OrderStore(env.DB);
    await store.recordDelivery({ orderId: 'o-1', action: 'order.placed', receivedAt: '2026-10-06T00:00:00.000Z' });

    expect(await store.getOrder('o-1')).toEqual({
      orderId: 'o-1',
      eventId: null,
      lastAction: 'order.placed',
      status: 'received',
      eventbriteStatus: null,
      amount: null,
      currency: null,
      orderCreated: null,
      matchedDonorItemId: null,
      mondayItemId: null,
      error: null,
      deliveries: 1,
      receivedAt: '2026-10-06T00:00:00.000Z',
      writtenAt: null,
    });
  });

  it('bumps the delivery count and resets status on a redelivery, keeping what a write recorded', async () => {
    const store = new D1OrderStore(env.DB);
    await store.recordDelivery({ orderId: 'o-2', action: 'order.placed', receivedAt: '2026-10-06T00:00:00.000Z' });
    await store.updateStatus('o-2', 'written', {
      mondayItemId: 'item-2',
      matchedDonorItemId: 'person-2',
      eventbriteStatus: 'placed',
      amount: '45.32',
      currency: 'USD',
      eventId: 'ev-1',
      orderCreated: '2026-09-15T02:00:00Z',
      writtenAt: '2026-10-06T00:01:00.000Z',
    });

    await store.recordDelivery({ orderId: 'o-2', action: 'order.refunded', receivedAt: '2026-10-07T00:00:00.000Z' });

    const row = await store.getOrder('o-2');
    expect(row?.status).toBe('received');
    expect(row?.lastAction).toBe('order.refunded');
    expect(row?.deliveries).toBe(2);
    expect(row?.receivedAt).toBe('2026-10-07T00:00:00.000Z');
    // The item and donor ids must survive — they tell the consumer to update, not create.
    expect(row?.mondayItemId).toBe('item-2');
    expect(row?.matchedDonorItemId).toBe('person-2');
    expect(row?.eventbriteStatus).toBe('placed');
    expect(row?.amount).toBe('45.32');
    expect(row?.writtenAt).toBe('2026-10-06T00:01:00.000Z');
  });

  it('updates status and patch fields, clearing the error on the next update', async () => {
    const store = new D1OrderStore(env.DB);
    await store.recordDelivery({ orderId: 'o-3', action: 'order.placed', receivedAt: '2026-10-06T00:00:00.000Z' });

    await store.updateStatus('o-3', 'failed', { error: 'boom' });
    let row = await store.getOrder('o-3');
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('boom');

    await store.updateStatus('o-3', 'written', { mondayItemId: 'item-3', writtenAt: '2026-10-06T01:00:00.000Z' });
    row = await store.getOrder('o-3');
    expect(row?.status).toBe('written');
    expect(row?.mondayItemId).toBe('item-3');
    expect(row?.error).toBeNull();
  });

  it('keeps an existing fact when a patch omits it', async () => {
    const store = new D1OrderStore(env.DB);
    await store.recordDelivery({ orderId: 'o-4', action: 'order.placed', receivedAt: '2026-10-06T00:00:00.000Z' });
    await store.updateStatus('o-4', 'queued', { matchedDonorItemId: 'person-4' });
    await store.updateStatus('o-4', 'skipped', { error: 'free order' });
    const row = await store.getOrder('o-4');
    expect(row?.matchedDonorItemId).toBe('person-4');
    expect(row?.status).toBe('skipped');
  });

  it('returns null for an unknown order', async () => {
    expect(await new D1OrderStore(env.DB).getOrder('nope')).toBeNull();
  });

  it('reports which order ids the ledger has, across more than one 100-id chunk', async () => {
    const store = new D1OrderStore(env.DB);
    await store.recordDelivery({ orderId: 'k-1', action: 'order.placed', receivedAt: '2026-11-01T00:00:00.000Z' });
    await store.recordDelivery({ orderId: 'k-150', action: 'order.placed', receivedAt: '2026-11-01T00:00:00.000Z' });
    const ids = Array.from({ length: 160 }, (_, i) => `k-${i}`);
    expect(await store.knownOrderIds(ids)).toEqual(new Set(['k-1', 'k-150']));
    expect(await store.knownOrderIds([])).toEqual(new Set());
  });
});
