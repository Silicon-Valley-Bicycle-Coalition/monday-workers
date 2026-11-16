import { describe, it, expect, vi } from 'vitest';
import { checkRequestRateLimit, isVerifiedMondayWebhook, MONDAY_WEBHOOK_PATH } from './rateLimit';
import type { RequestRateLimiter } from './rateLimit';

function fakeLimiter(success: boolean): RequestRateLimiter {
  return { limit: vi.fn().mockResolvedValue({ success }) };
}

describe('checkRequestRateLimit', () => {
  it('returns null (allowed) when the limiter succeeds', async () => {
    const result = await checkRequestRateLimit(new Request('https://x.example/webhooks/monday/donors'), fakeLimiter(true));

    expect(result).toBeNull();
  });

  it('returns a 429 when the limiter denies the request', async () => {
    const result = await checkRequestRateLimit(new Request('https://x.example/webhooks/monday/donors'), fakeLimiter(false));

    expect(result?.status).toBe(429);
  });

  it('keys the limiter on the CF-Connecting-IP header', async () => {
    const limiter = fakeLimiter(true);
    const request = new Request('https://x.example/', { headers: { 'CF-Connecting-IP': '203.0.113.5' } });

    await checkRequestRateLimit(request, limiter);

    expect(limiter.limit).toHaveBeenCalledWith('203.0.113.5');
  });

  it('falls back to a fixed key when CF-Connecting-IP is absent (local dev/tests)', async () => {
    const limiter = fakeLimiter(true);

    await checkRequestRateLimit(new Request('https://x.example/'), limiter);

    expect(limiter.limit).toHaveBeenCalledWith('local');
  });
});

describe('isVerifiedMondayWebhook', () => {
  const url = (path: string, secret?: string) => `https://x.example${path}${secret === undefined ? '' : `?secret=${secret}`}`;

  it('is true for a POST to the Monday webhook path with the matching secret', async () => {
    expect(await isVerifiedMondayWebhook(new Request(url(MONDAY_WEBHOOK_PATH, 's3cret'), { method: 'POST' }), 's3cret')).toBe(true);
  });

  it('is false for a wrong or missing secret, so those deliveries stay rate limited', async () => {
    expect(await isVerifiedMondayWebhook(new Request(url(MONDAY_WEBHOOK_PATH, 'guess'), { method: 'POST' }), 's3cret')).toBe(false);
    expect(await isVerifiedMondayWebhook(new Request(url(MONDAY_WEBHOOK_PATH), { method: 'POST' }), 's3cret')).toBe(false);
  });

  it('is false for the right secret on another route or method', async () => {
    expect(await isVerifiedMondayWebhook(new Request(url('/health', 's3cret'), { method: 'POST' }), 's3cret')).toBe(false);
    expect(await isVerifiedMondayWebhook(new Request(url(MONDAY_WEBHOOK_PATH, 's3cret')), 's3cret')).toBe(false);
  });

  it('fails closed when the secret binding is unset or empty', async () => {
    expect(await isVerifiedMondayWebhook(new Request(url(MONDAY_WEBHOOK_PATH, ''), { method: 'POST' }), '')).toBe(false);
    expect(await isVerifiedMondayWebhook(new Request(url(MONDAY_WEBHOOK_PATH), { method: 'POST' }), undefined)).toBe(false);
  });
});
