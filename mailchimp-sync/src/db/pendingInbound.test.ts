import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { D1PendingInboundStore } from './pendingInbound';

describe('D1PendingInboundStore', () => {
  it('inserts a new pending row as received', async () => {
    const store = new D1PendingInboundStore(env.DB);
    await store.upsertPending('a@b.com', '2026-08-26T00:00:00.000Z');

    const row = await env.DB.prepare(`SELECT * FROM pending_inbound_syncs WHERE email = ?1`)
      .bind('a@b.com').first<{ status: string }>();
    expect(row?.status).toBe('received');
  });

  it('a redelivery resets status to received and clears the prior error', async () => {
    const store = new D1PendingInboundStore(env.DB);
    await store.upsertPending('c@d.com', '2026-08-26T00:00:00.000Z');
    await store.updateStatus('c@d.com', 'failed', 'boom');

    await store.upsertPending('c@d.com', '2026-08-26T01:00:00.000Z');

    const row = await env.DB.prepare(`SELECT * FROM pending_inbound_syncs WHERE email = ?1`)
      .bind('c@d.com').first<{ status: string; error: string | null }>();
    expect(row).toEqual(expect.objectContaining({ status: 'received', error: null }));
  });

  it('updateStatus records written_at when provided', async () => {
    const store = new D1PendingInboundStore(env.DB);
    await store.upsertPending('e@f.com', '2026-08-26T00:00:00.000Z');
    await store.updateStatus('e@f.com', 'written', undefined, '2026-08-26T02:00:00.000Z');

    const row = await env.DB.prepare(`SELECT * FROM pending_inbound_syncs WHERE email = ?1`)
      .bind('e@f.com').first<{ status: string; written_at: string | null }>();
    expect(row).toEqual(expect.objectContaining({ status: 'written', written_at: '2026-08-26T02:00:00.000Z' }));
  });
});
