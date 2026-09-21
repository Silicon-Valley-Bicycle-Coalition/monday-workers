export interface RequestRateLimiter {
  limit(key: string): Promise<{ success: boolean }>;
}

// A blanket per-IP guard checked before any routing, D1, or Monday work — see README
// "Reliability: traffic and cost limits". This is deliberately coarser than the webhookSecret
// check in webhook/route.ts: that check still has to run (a valid secret doesn't bypass the
// rate limit, and vice versa), but a flood of requests — valid secret or not — now costs at
// most REQUEST_RATE_LIMITER's configured rate instead of one full request per delivery.
// Keyed on CF-Connecting-IP, the header Cloudflare's edge sets to the real client IP on every
// Internet request; local dev and tests never see it, so they fall back to a fixed key (the
// binding's own local simulation doesn't share state with production either way).
export async function checkRequestRateLimit(request: Request, limiter: RequestRateLimiter): Promise<Response | null> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
  const { success } = await limiter.limit(ip);
  return success ? null : new Response('rate limit exceeded', { status: 429 });
}
