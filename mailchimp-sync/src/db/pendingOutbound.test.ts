import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { D1PendingOutboundStore } from './pendingOutbound';

describe('D1PendingOutboundStore', () => {
  it('inserts a new pending row as received', async () => {
    const store = new D1PendingOutboundStore(env.DB);
    await store.upsertPending('item-1', '2026-08-26T00:00:00.000Z');

    const row = await env.DB.prepare(`SELECT * FROM pending_outbound_syncs WHERE donor_item_id = ?1`)
      .bind('item-1').first<{ status: string; received_at: string }>();
    expect(row?.status).toBe('received');
    expect(row?.received_at).toBe('2026-08-26T00:00:00.000Z');
  });

  it('a redelivery for the same item resets status to received and clears the prior error', async () => {
    const store = new D1PendingOutboundStore(env.DB);
    await store.upsertPending('item-2', '2026-08-26T00:00:00.000Z');
    await store.updateStatus('item-2', 'failed', 'boom');

    await store.upsertPending('item-2', '2026-08-26T01:00:00.000Z');

    const row = await env.DB.prepare(`SELECT * FROM pending_outbound_syncs WHERE donor_item_id = ?1`)
      .bind('item-2').first<{ status: string; error: string | null; received_at: string }>();
    expect(row?.status).toBe('received');
    expect(row?.error).toBeNull();
    expect(row?.received_at).toBe('2026-08-26T01:00:00.000Z');
  });

  it('updateStatus records an error and leaves written_at untouched when not provided', async () => {
    const store = new D1PendingOutboundStore(env.DB);
    await store.upsertPending('item-3', '2026-08-26T00:00:00.000Z');

    await store.updateStatus('item-3', 'failed', 'mailchimp down');

    const row = await env.DB.prepare(`SELECT * FROM pending_outbound_syncs WHERE donor_item_id = ?1`)
      .bind('item-3').first<{ status: string; error: string | null; written_at: string | null }>();
    expect(row).toEqual(expect.objectContaining({ status: 'failed', error: 'mailchimp down', written_at: null }));
  });

  it('updateStatus records written_at when provided', async () => {
    const store = new D1PendingOutboundStore(env.DB);
    await store.upsertPending('item-4', '2026-08-26T00:00:00.000Z');

    await store.updateStatus('item-4', 'written', undefined, '2026-08-26T02:00:00.000Z');

    const row = await env.DB.prepare(`SELECT * FROM pending_outbound_syncs WHERE donor_item_id = ?1`)
      .bind('item-4').first<{ status: string; written_at: string | null }>();
    expect(row).toEqual(expect.objectContaining({ status: 'written', written_at: '2026-08-26T02:00:00.000Z' }));
  });

  it('get returns the row for the dead-letter consumer, or null when there is none', async () => {
    const store = new D1PendingOutboundStore(env.DB);
    await store.upsertPending('item-5', '2026-08-26T00:00:00.000Z');
    await store.updateStatus('item-5', 'failed', 'boom');

    expect(await store.get('item-5')).toEqual({ status: 'failed', error: 'boom', receivedAt: '2026-08-26T00:00:00.000Z', writtenAt: null });
    expect(await store.get('no-such-item')).toBeNull();
  });
});
