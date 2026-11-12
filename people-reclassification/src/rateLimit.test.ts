import { describe, it, expect, vi } from 'vitest';
import { checkRequestRateLimit, isVerifiedMondayWebhook, PROMOTE_WEBHOOK_PATH } from './rateLimit';

const SECRET = 'hook';
const promote = (query: string, method = 'POST') =>
  new Request(`https://x.example${PROMOTE_WEBHOOK_PATH}${query}`, { method, ...(method === 'POST' ? { body: '{}' } : {}) });

describe('isVerifiedMondayWebhook (issue #110: Monday bulk edits must not hit the per-IP limit)', () => {
  it('exempts a POST to the promote webhook carrying the right secret', async () => {
    expect(await isVerifiedMondayWebhook(promote(`?secret=${SECRET}`), SECRET)).toBe(true);
  });

  it('does not exempt a missing or wrong secret', async () => {
    expect(await isVerifiedMondayWebhook(promote(''), SECRET)).toBe(false);
    expect(await isVerifiedMondayWebhook(promote('?secret=nope'), SECRET)).toBe(false);
  });

  it('does not exempt the right secret on another route or method', async () => {
    expect(await isVerifiedMondayWebhook(promote(`?secret=${SECRET}`, 'GET'), SECRET)).toBe(false);
    expect(await isVerifiedMondayWebhook(new Request(`https://x.example/reclassify/run?secret=${SECRET}`, { method: 'POST' }), SECRET)).toBe(false);
    expect(await isVerifiedMondayWebhook(new Request(`https://x.example${PROMOTE_WEBHOOK_PATH}/x?secret=${SECRET}`, { method: 'POST' }), SECRET)).toBe(false);
  });

  it('exempts nothing while the secret is unset', async () => {
    expect(await isVerifiedMondayWebhook(promote('?secret='), undefined)).toBe(false);
    expect(await isVerifiedMondayWebhook(promote('?secret=x'), undefined)).toBe(false);
  });
});

describe('checkRequestRateLimit', () => {
  it('keys on CF-Connecting-IP and answers 429 when denied', async () => {
    const limit = vi.fn().mockResolvedValue({ success: false });
    const res = await checkRequestRateLimit(new Request('https://x.example/', { headers: { 'CF-Connecting-IP': '203.0.113.5' } }), { limit });
    expect(limit).toHaveBeenCalledWith('203.0.113.5');
    expect(res?.status).toBe(429);
  });
});
