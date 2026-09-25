import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { D1DnsUnsubscribeLog } from './dnsUnsubscribes';

describe('D1DnsUnsubscribeLog', () => {
  it('has() is false until an address is recorded, then true', async () => {
    const log = new D1DnsUnsubscribeLog(env.DB);
    expect(await log.has('a@b.com')).toBe(false);

    await log.record('a@b.com', 'item-1', 'unsubscribed', '2026-09-25T00:00:00.000Z');

    expect(await log.has('a@b.com')).toBe(true);
    const row = await env.DB.prepare(`SELECT * FROM dns_unsubscribes WHERE email = ?1`)
      .bind('a@b.com').first<{ donor_item_id: string; result: string; unsubscribed_at: string }>();
    expect(row).toEqual(expect.objectContaining({
      donor_item_id: 'item-1', result: 'unsubscribed', unsubscribed_at: '2026-09-25T00:00:00.000Z',
    }));
  });

  it('keys on the normalized address, so case and whitespace variants are the same contact', async () => {
    const log = new D1DnsUnsubscribeLog(env.DB);
    await log.record(' Mixed@Case.com ', 'item-2', 'already-unsubscribed', '2026-09-25T00:00:00.000Z');

    expect(await log.has('mixed@case.com')).toBe(true);
  });

  it('keeps the first record when the same address is recorded again', async () => {
    const log = new D1DnsUnsubscribeLog(env.DB);
    await log.record('c@d.com', 'item-3', 'unsubscribed', '2026-09-25T00:00:00.000Z');
    await log.record('c@d.com', 'item-4', 'already-unsubscribed', '2026-09-26T00:00:00.000Z');

    const row = await env.DB.prepare(`SELECT * FROM dns_unsubscribes WHERE email = ?1`)
      .bind('c@d.com').first<{ donor_item_id: string; unsubscribed_at: string }>();
    expect(row?.donor_item_id).toBe('item-3');
    expect(row?.unsubscribed_at).toBe('2026-09-25T00:00:00.000Z');
  });
});
