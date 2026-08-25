import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { D1PendingStore } from './pending';

describe('D1PendingStore', () => {
  it('inserts a new row, then upserts on redelivery instead of erroring', async () => {
    const store = new D1PendingStore(env.DB);
    expect(await store.upsertPending({ donationItemId: 'd1', eventId: 'e1', receivedAt: '2026-01-01T00:00:00Z' }))
      .toBe('inserted');
    expect(await store.upsertPending({ donationItemId: 'd1', eventId: 'e2', receivedAt: '2026-01-02T00:00:00Z' }))
      .toBe('updated');

    const row = await store.getPending('d1');
    expect(row?.eventId).toBe('e2');
    expect(row?.status).toBe('received'); // reset on redelivery
  });

  it('updates status and patches owner fields, preserving unpatched fields via COALESCE', async () => {
    const store = new D1PendingStore(env.DB);
    await store.upsertPending({ donationItemId: 'd2', eventId: 'e1', receivedAt: '2026-01-01T00:00:00Z' });
    await store.updateStatus('d2', 'queued');
    await store.updateStatus('d2', 'written', { ownerItemId: 'owner-1', ownerBoard: 'donors', writtenAt: '2026-01-01T01:00:00Z' });

    const row = await store.getPending('d2');
    expect(row).toEqual({
      donationItemId: 'd2', eventId: 'e1', status: 'written',
      ownerItemId: 'owner-1', ownerBoard: 'donors', error: null,
      receivedAt: '2026-01-01T00:00:00Z', writtenAt: '2026-01-01T01:00:00Z',
    });
  });

  it('returns null for an unknown donation item', async () => {
    const store = new D1PendingStore(env.DB);
    expect(await store.getPending('nope')).toBeNull();
  });
});
