export interface RequestRateLimiter {
  limit(key: string): Promise<{ success: boolean }>;
}

// A blanket per-IP guard checked before any routing, D1, or Monday work — the root README's
// "Reliability: traffic and cost limits". This Worker's only HTTP surface is the authenticated
// /reclassify/* trigger, so every request is limited; a flood costs at most REQUEST_RATE_LIMITER's
// configured rate. Keyed on CF-Connecting-IP (set by Cloudflare's edge); local dev and tests
// never see it and fall back to a fixed key.
export async function checkRequestRateLimit(request: Request, limiter: RequestRateLimiter): Promise<Response | null> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
  const { success } = await limiter.limit(ip);
  return success ? null : new Response('rate limit exceeded', { status: 429 });
}
