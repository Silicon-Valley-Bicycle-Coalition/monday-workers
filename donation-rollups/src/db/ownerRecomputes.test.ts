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
    expect(await store.get('o1')).toEqual({ ownerItemId: 'o1', ownerBoardId: '2', fetchedAt: '2026-01-01T00:00:00Z', writtenAt: '2026-01-01T00:00:05Z' });

    await store.record({ ownerItemId: 'o1', ownerBoardId: '2', fetchedAt: '2026-01-02T00:00:00Z', writtenAt: '2026-01-02T00:00:03Z' });
    expect((await store.get('o1'))!.fetchedAt).toBe('2026-01-02T00:00:00Z');
  });
});
