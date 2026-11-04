import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1EventStore } from './events';

const T0 = '2026-10-26T00:00:00.000Z';

describe('D1EventStore', () => {
  it('inserts an event on first delivery and reads it back', async () => {
    const store = new D1EventStore(env.DB);
    expect(await store.recordDelivery({ eventId: 'e-1', action: 'event.created', receivedAt: T0 })).toBe('inserted');
    expect(await store.getEvent('e-1')).toEqual({
      eventId: 'e-1',
      mondayItemId: null,
      startsAt: null,
      endsAt: null,
      locationKey: null,
      eventbriteStatus: null,
      status: 'received',
      lastAction: 'event.created',
      error: null,
      deliveries: 1,
      receivedAt: T0,
      writtenAt: null,
    });
  });

  it('bumps deliveries on a redelivery and keeps the Monday item id and facts', async () => {
    const store = new D1EventStore(env.DB);
    await store.recordDelivery({ eventId: 'e-2', action: 'event.created', receivedAt: T0 });
    await store.updateStatus('e-2', 'written', { mondayItemId: 'item-2', startsAt: '2026-10-24T17:00:00Z', writtenAt: T0 });
    expect(await store.recordDelivery({ eventId: 'e-2', action: 'event.updated', receivedAt: '2026-10-27T00:00:00.000Z' })).toBe('updated');
    const row = await store.getEvent('e-2');
    expect(row?.status).toBe('received');
    expect(row?.lastAction).toBe('event.updated');
    expect(row?.deliveries).toBe(2);
    expect(row?.mondayItemId).toBe('item-2');
    expect(row?.startsAt).toBe('2026-10-24T17:00:00Z');
    expect(row?.writtenAt).toBe(T0);
  });

  it('keeps old values when a patch omits them, and clears the error on the next update', async () => {
    const store = new D1EventStore(env.DB);
    await store.recordDelivery({ eventId: 'e-3', action: 'event.created', receivedAt: T0 });
    await store.updateStatus('e-3', 'failed', { mondayItemId: 'item-3', eventbriteStatus: 'live', error: 'boom' });
    await store.updateStatus('e-3', 'written', { endsAt: '2026-09-01T19:00:00Z' });
    const row = await store.getEvent('e-3');
    expect(row?.status).toBe('written');
    expect(row?.mondayItemId).toBe('item-3');
    expect(row?.eventbriteStatus).toBe('live');
    expect(row?.endsAt).toBe('2026-09-01T19:00:00Z');
    expect(row?.error).toBeNull();
  });

  it('returns null for an unknown event', async () => {
    expect(await new D1EventStore(env.DB).getEvent('nope')).toBeNull();
  });
});
