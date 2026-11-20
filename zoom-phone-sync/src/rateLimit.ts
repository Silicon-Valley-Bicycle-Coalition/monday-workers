import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignature } from './webhook/signature';
import { WEBHOOK_PATH } from './webhook/route';

export interface RequestRateLimiter {
  limit(key: string): Promise<{ success: boolean }>;
}

// A genuine delivery skips the per-IP limiter (GL#101): Zoom sends from a small pool of IPs, and a
// busy afternoon of calls must not draw 429s. Only a POST to the webhook path whose signature
// verifies qualifies, so the exemption can't be reached without the secret. Reads a clone of the
// body; costs one HMAC, no I/O.
export async function isVerifiedWebhook(request: Request, webhookSecret: string | undefined): Promise<boolean> {
  if (request.method !== 'POST' || new URL(request.url).pathname !== WEBHOOK_PATH) return false;
  const check = await verifySignature(
    webhookSecret,
    { signature: request.headers.get(SIGNATURE_HEADER), timestamp: request.headers.get(TIMESTAMP_HEADER) },
    await request.clone().text(),
  );
  return check === 'ok';
}

// Blanket per-IP guard before any routing or D1 work, keyed on CF-Connecting-IP (absent in local
// dev and tests, which share one key).
export async function checkRequestRateLimit(request: Request, limiter: RequestRateLimiter): Promise<Response | null> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
  const { success } = await limiter.limit(ip);
  return success ? null : new Response('rate limit exceeded', { status: 429 });
}
