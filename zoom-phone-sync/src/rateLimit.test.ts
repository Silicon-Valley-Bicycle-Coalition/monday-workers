import { describe, it, expect } from 'vitest';
import { checkRequestRateLimit, isVerifiedWebhook } from './rateLimit';
import { hmacHex } from './webhook/signature';

const SECRET = 'test-secret';

async function signedRequest(path = '/webhooks/zoom', secret = SECRET) {
  const body = '{"event":"phone.sms_sent"}';
  const ts = String(Math.floor(Date.now() / 1000));
  return new Request(`https://example.workers.dev${path}`, {
    method: 'POST',
    headers: { 'x-zm-signature': `v0=${await hmacHex(secret, `v0:${ts}:${body}`)}`, 'x-zm-request-timestamp': ts },
    body,
  });
}

describe('isVerifiedWebhook', () => {
  it('is true only for a correctly signed POST to the webhook path, and leaves the body readable', async () => {
    const request = await signedRequest();
    expect(await isVerifiedWebhook(request, SECRET)).toBe(true);
    expect(await request.text()).toContain('phone.sms_sent');
    expect(await isVerifiedWebhook(await signedRequest('/health'), SECRET)).toBe(false);
    expect(await isVerifiedWebhook(await signedRequest('/webhooks/zoom', 'guess'), SECRET)).toBe(false);
    expect(await isVerifiedWebhook(await signedRequest(), undefined)).toBe(false);
  });
});

describe('checkRequestRateLimit', () => {
  it('429s when the limiter refuses, keyed on CF-Connecting-IP', async () => {
    const keys: string[] = [];
    const request = new Request('https://example.workers.dev/', { headers: { 'CF-Connecting-IP': '203.0.113.9' } });
    const res = await checkRequestRateLimit(request, { limit: async (key) => (keys.push(key), { success: false }) });
    expect(res?.status).toBe(429);
    expect(keys).toEqual(['203.0.113.9']);
    expect(await checkRequestRateLimit(request, { limit: async () => ({ success: true }) })).toBeNull();
  });
});
