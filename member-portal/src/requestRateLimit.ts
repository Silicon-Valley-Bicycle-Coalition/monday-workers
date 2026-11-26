import { clientIpKey } from './clientIp';
// A blanket per-IP guard, separate from ratelimit.ts's login/change/verify-specific checks —
// see README "Reliability: traffic and cost limits". Those targeted checks stay as the
// abuse-prevention layer for their routes; this is a coarser net covering every route
// (including /webhooks/monday/letters, which had no rate limit at all before this), so a flood
// against any route costs at most REQUEST_RATE_LIMITER's configured rate instead of one full
// request per delivery.

export interface RequestRateLimiter {
  limit(key: string): Promise<{ success: boolean }>;
}

// Keyed on CF-Connecting-IP (an IPv6 client by its /64, see clientIp.ts), the header Cloudflare's edge sets to the real client IP on every
// Internet request; local dev and tests never see it, so they fall back to a fixed key (the
// binding's own local simulation doesn't share state with production either way).
export async function checkRequestRateLimit(request: Request, limiter: RequestRateLimiter): Promise<Response | null> {
  const ip = clientIpKey(request.headers.get('CF-Connecting-IP'), 'local');
  const { success } = await limiter.limit(ip);
  return success ? null : new Response('rate limit exceeded', { status: 429 });
}
