import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { D1PendingStore } from './pending';

describe('D1PendingStore', () => {
  it('inserts a new row, then upserts on redelivery instead of erroring', async () => {
    const store = new D1PendingStore(env.DB);
    expect(await store.upsertPending({ donationItemId: 'd1', donationBoardId: 'b1', eventId: 'e1', receivedAt: '2026-01-01T00:00:00Z' }))
      .toBe('inserted');
    expect(await store.upsertPending({ donationItemId: 'd1', donationBoardId: 'b1', eventId: 'e2', receivedAt: '2026-01-02T00:00:00Z' }))
      .toBe('updated');

    const row = await store.getPending('d1');
    expect(row?.eventId).toBe('e2');
    expect(row?.status).toBe('received'); // reset on redelivery
  });

  it('updates status and patches owner fields, preserving unpatched fields via COALESCE', async () => {
    const store = new D1PendingStore(env.DB);
    await store.upsertPending({ donationItemId: 'd2', donationBoardId: 'b1', eventId: 'e1', receivedAt: '2026-01-01T00:00:00Z' });
    await store.updateStatus('d2', 'queued');
    await store.updateStatus('d2', 'written', { ownerItemId: 'owner-1', ownerBoard: '18427756096', writtenAt: '2026-01-01T01:00:00Z' });

    const row = await store.getPending('d2');
    expect(row).toEqual({
      donationItemId: 'd2', donationBoardId: 'b1', eventId: 'e1', status: 'written',
      ownerItemId: 'owner-1', ownerBoard: '18427756096', error: null,
      receivedAt: '2026-01-01T00:00:00Z', writtenAt: '2026-01-01T01:00:00Z', kind: 'donation',
    });
  });

  it('returns null for an unknown donation item', async () => {
    const store = new D1PendingStore(env.DB);
    expect(await store.getPending('nope')).toBeNull();
  });

  it('stores and reads back kind, defaulting to donation', async () => {
    const store = new D1PendingStore(env.DB);
    await store.upsertPending({ donationItemId: 'reg-1', donationBoardId: 'er', eventId: 'e', receivedAt: 'now', kind: 'registration' });
    await store.upsertPending({ donationItemId: 'dn-k', donationBoardId: '1', eventId: 'e', receivedAt: 'now' });
    expect((await store.getPending('reg-1'))?.kind).toBe('registration');
    expect((await store.getPending('dn-k'))?.kind).toBe('donation');
  });
});

// Fix 5: the custodian's nightly requeue duty re-enqueues rows the queue never finished.
describe('D1PendingStore.listStuck', () => {
  beforeEach(async () => { await env.DB.prepare('DELETE FROM pending_recomputes').run(); });

  it('returns queued/received rows older than the cutoff, oldest first, capped — not written, failed or fresh rows', async () => {
    const store = new D1PendingStore(env.DB);
    const seed = async (id: string, receivedAt: string, status?: 'queued' | 'written' | 'failed') => {
      await store.upsertPending({ donationItemId: id, donationBoardId: '1', eventId: 'e', receivedAt });
      if (status) await store.updateStatus(id, status, status === 'failed' ? { error: 'x' } : {});
    };
    await seed('old-queued-b', '2026-07-30T02:00:00Z', 'queued');
    await seed('old-queued-a', '2026-07-30T01:00:00Z', 'queued');
    await seed('old-received', '2026-07-29T00:00:00Z'); // still 'received' — enqueue never happened
    await seed('old-written', '2026-07-28T00:00:00Z', 'written');
    await seed('old-failed', '2026-07-28T00:00:00Z', 'failed');
    await seed('fresh-queued', '2026-07-31T23:00:00Z', 'queued');

    const stuck = await store.listStuck('2026-07-31T00:00:00Z', 10);
    expect(stuck.map((r) => r.donationItemId)).toEqual(['old-received', 'old-queued-a', 'old-queued-b']);
    expect(stuck[0]).toEqual({ donationItemId: 'old-received', donationBoardId: '1', receivedAt: '2026-07-29T00:00:00Z', kind: 'donation' });

    expect(await store.listStuck('2026-07-31T00:00:00Z', 2)).toHaveLength(2);
  });

  it('carries the row kind, so a stuck registration is re-sent as one', async () => {
    const store = new D1PendingStore(env.DB);
    await store.upsertPending({ donationItemId: 'reg-stuck', donationBoardId: 'er', eventId: 'e', receivedAt: '2026-07-29T00:00:00Z', kind: 'registration' });
    expect(await store.listStuck('2026-07-31T00:00:00Z', 10))
      .toEqual([{ donationItemId: 'reg-stuck', donationBoardId: 'er', receivedAt: '2026-07-29T00:00:00Z', kind: 'registration' }]);
  });
});
