import { describe, it, expect, vi } from 'vitest';
import { checkRequestRateLimit } from './rateLimit';
import type { RequestRateLimiter } from './rateLimit';

function fakeLimiter(success: boolean): RequestRateLimiter {
  return { limit: vi.fn().mockResolvedValue({ success }) };
}

describe('checkRequestRateLimit', () => {
  it('returns null (allowed) when the limiter succeeds', async () => {
    const result = await checkRequestRateLimit(new Request('https://x.example/webhook/bp-feedback'), fakeLimiter(true));

    expect(result).toBeNull();
  });

  it('returns a 429 when the limiter denies the request', async () => {
    const result = await checkRequestRateLimit(new Request('https://x.example/webhook/bp-feedback'), fakeLimiter(false));

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
