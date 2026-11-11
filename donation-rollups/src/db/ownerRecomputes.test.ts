import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { D1OwnerRecomputesStore } from './ownerRecomputes';

describe('D1OwnerRecomputesStore', () => {
  it('returns null for an owner never recomputed', async () => {
    const store = new D1OwnerRecomputesStore(env.DB);
    expect(await store.get('never')).toBeNull();
  });

  it('records a recompute and reads it back; a later recompute replaces it', async () => {
    const store = new D1OwnerRecomputesStore(env.DB);
    await store.record({ ownerItemId: 'o1', ownerBoardId: '2', fetchedAt: '2026-01-01T00:00:00Z', writtenAt: '2026-01-01T00:00:05Z' });
    expect(await store.get('o1')).toEqual({ ownerItemId: 'o1', ownerBoardId: '2', fetchedAt: '2026-01-01T00:00:00Z', writtenAt: '2026-01-01T00:00:05Z', valuesHash: null, descriptionHash: null });

    await store.record({ ownerItemId: 'o1', ownerBoardId: '2', fetchedAt: '2026-01-02T00:00:00Z', writtenAt: '2026-01-02T00:00:03Z', valuesHash: 'v1', descriptionHash: 'd1' });
    expect((await store.get('o1'))!.valuesHash).toBe('v1');
    expect((await store.get('o1'))!.fetchedAt).toBe('2026-01-02T00:00:00Z');
  });

  it('writtenSince returns the owners whose last successful recompute landed at/after the instant', async () => {
    const store = new D1OwnerRecomputesStore(env.DB);
    await store.record({ ownerItemId: 'ws-old', ownerBoardId: 'b', fetchedAt: '2026-10-17T00:00:00Z', writtenAt: '2026-10-17T00:01:00Z' });
    await store.record({ ownerItemId: 'ws-new', ownerBoardId: 'b', fetchedAt: '2026-10-18T00:00:00Z', writtenAt: '2026-10-18T00:01:00Z' });
    const since = await store.writtenSince('2026-10-18T00:00:00Z');
    expect(since.has('ws-new')).toBe(true);
    expect(since.has('ws-old')).toBe(false);
  });

  it('leases an owner to one recompute at a time; a released or expired lease can be taken again', async () => {
    const store = new D1OwnerRecomputesStore(env.DB);
    expect(await store.acquireLease('lease-o1', 'a', '2026-10-28T10:00:00.000Z', '2026-10-28T10:05:00.000Z')).toBe(true);
    expect(await store.acquireLease('lease-o1', 'b', '2026-10-28T10:00:01.000Z', '2026-10-28T10:05:01.000Z')).toBe(false);
    expect(await store.acquireLease('lease-o2', 'b', '2026-10-28T10:00:01.000Z', '2026-10-28T10:05:01.000Z')).toBe(true);

    await store.releaseLease('lease-o1', 'someone-else'); // only the holder releases
    expect(await store.acquireLease('lease-o1', 'b', '2026-10-28T10:00:02.000Z', '2026-10-28T10:05:02.000Z')).toBe(false);
    await store.releaseLease('lease-o1', 'a');
    expect(await store.acquireLease('lease-o1', 'b', '2026-10-28T10:00:03.000Z', '2026-10-28T10:05:03.000Z')).toBe(true);

    // b crashed without releasing: after expiry the lease is free again.
    expect(await store.acquireLease('lease-o1', 'c', '2026-10-28T10:05:04.000Z', '2026-10-28T10:10:04.000Z')).toBe(true);
  });
});
