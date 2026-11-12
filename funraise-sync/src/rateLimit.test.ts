import { describe, it, expect, vi } from 'vitest';
import { checkRequestRateLimit, isVerifiedWebhook, WEBHOOK_PATHS } from './rateLimit';
import { SECRET_HEADER } from './webhook/route';
import type { RequestRateLimiter } from './rateLimit';

function fakeLimiter(success: boolean): RequestRateLimiter {
  return { limit: vi.fn().mockResolvedValue({ success }) };
}

describe('checkRequestRateLimit', () => {
  it('returns null (allowed) when the limiter succeeds', async () => {
    const result = await checkRequestRateLimit(new Request('https://x.example/webhooks/funraise/transaction'), fakeLimiter(true));

    expect(result).toBeNull();
  });

  it('returns a 429 when the limiter denies the request', async () => {
    const result = await checkRequestRateLimit(new Request('https://x.example/webhooks/funraise/transaction'), fakeLimiter(false));

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

// #101: a verified webhook delivery skips the per-IP limiter; nothing else does.
describe('isVerifiedWebhook', () => {
  const url = (path: string, secret?: string) => `https://x.example${path}${secret === undefined ? '' : `?secret=${secret}`}`;
  const PATH = '/webhooks/funraise/transaction';

  it('lists the route path', () => {
    expect(WEBHOOK_PATHS.has(PATH)).toBe(true);
  });

  it('is true for a POST to the webhook path with the matching ?secret=', async () => {
    expect(await isVerifiedWebhook(new Request(url(PATH, 's3cret'), { method: 'POST' }), 's3cret')).toBe(true);
  });

  it('is true for the matching secret in the header form', async () => {
    const request = new Request(url(PATH), { method: 'POST', headers: { [SECRET_HEADER]: 's3cret' } });
    expect(await isVerifiedWebhook(request, 's3cret')).toBe(true);
  });

  it('is false for a wrong or missing secret, so those deliveries stay rate limited', async () => {
    expect(await isVerifiedWebhook(new Request(url(PATH, 'guess'), { method: 'POST' }), 's3cret')).toBe(false);
    expect(await isVerifiedWebhook(new Request(url(PATH), { method: 'POST' }), 's3cret')).toBe(false);
  });

  it('is false for the right secret on another route or method', async () => {
    expect(await isVerifiedWebhook(new Request(url('/health', 's3cret'), { method: 'POST' }), 's3cret')).toBe(false);
    expect(await isVerifiedWebhook(new Request(url(PATH, 's3cret')), 's3cret')).toBe(false);
  });

  it('fails closed when the secret binding is unset or empty', async () => {
    expect(await isVerifiedWebhook(new Request(url(PATH, ''), { method: 'POST' }), '')).toBe(false);
    expect(await isVerifiedWebhook(new Request(url(PATH), { method: 'POST' }), undefined)).toBe(false);
  });
});
