import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { D1PendingStore } from './pending';

describe('D1PendingStore', () => {
  it('inserts a new row, then upserts on redelivery instead of erroring', async () => {
    const store = new D1PendingStore(env.DB);
    await store.upsertPending({ donationItemId: 'd1', donationBoardId: 'b1', eventId: 'e1', receivedAt: '2026-01-01T00:00:00Z' });
    await store.upsertPending({ donationItemId: 'd1', donationBoardId: 'b1', eventId: 'e2', receivedAt: '2026-01-02T00:00:00Z' });

    const row = await store.getPending('d1');
    expect(row?.eventId).toBe('e2');
    expect(row?.status).toBe('received'); // reset on redelivery
  });

  // Issue GL#90: the webhook route discarded the inserted/updated answer, so the SELECT that
  // computed it was a wasted D1 read on every delivery.
  it('upserts in one statement', async () => {
    let prepared = 0;
    const db = new Proxy(env.DB, { get: (t, p) => (p === 'prepare' ? (sql: string) => { prepared++; return t.prepare(sql); } : Reflect.get(t, p)) });
    await new D1PendingStore(db).upsertPending({ donationItemId: 'd-one', donationBoardId: 'b1', eventId: 'e1', receivedAt: '2026-01-01T00:00:00Z' });
    expect(prepared).toBe(1);
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

// Issue GL#90: the nightly requeue prunes finished rows, and listStuck has an index to use.
describe('D1PendingStore.pruneFinished', () => {
  beforeEach(async () => { await env.DB.prepare('DELETE FROM pending_recomputes').run(); });

  it('deletes written and dropped rows received before the cutoff, keeping open, failed and recent rows', async () => {
    const store = new D1PendingStore(env.DB);
    const seed = async (id: string, receivedAt: string, status?: 'queued' | 'written' | 'failed' | 'dropped') => {
      await store.upsertPending({ donationItemId: id, donationBoardId: '1', eventId: 'e', receivedAt });
      if (status) await store.updateStatus(id, status, status === 'failed' ? { error: 'x' } : {});
    };
    await seed('old-written', '2026-01-01T00:00:00Z', 'written');
    await seed('old-dropped', '2026-01-01T00:00:00Z', 'dropped');
    await seed('old-failed', '2026-01-01T00:00:00Z', 'failed');
    await seed('old-queued', '2026-01-01T00:00:00Z', 'queued');
    await seed('old-received', '2026-01-01T00:00:00Z');
    await seed('new-written', '2026-03-01T00:00:00Z', 'written');

    expect(await store.pruneFinished('2026-02-01T00:00:00Z')).toBe(2);
    const left = await env.DB.prepare('SELECT donation_item_id FROM pending_recomputes ORDER BY donation_item_id').all<{ donation_item_id: string }>();
    expect(left.results.map((r) => r.donation_item_id)).toEqual(['new-written', 'old-failed', 'old-queued', 'old-received']);
  });

  it('listStuck reads through an index rather than scanning the table', async () => {
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN SELECT donation_item_id FROM pending_recomputes
      WHERE status IN ('received', 'queued') AND received_at < ?1 ORDER BY received_at LIMIT ?2`).bind('x', 1).all<{ detail: string }>();
    expect(plan.results.map((r) => r.detail).join('; ')).toMatch(/USING INDEX idx_pending_recomputes_stuck/);
  });
});
