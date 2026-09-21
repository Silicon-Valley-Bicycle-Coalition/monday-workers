export interface RequestRateLimiter {
  limit(key: string): Promise<{ success: boolean }>;
}

// A blanket per-IP guard checked before any routing, upstream fetch, or KV work — see README
// "Reliability: traffic and cost limits". This is a public widget/ICS Worker with no secret or
// auth to gate abuse, so this is the only guard against a bot crawl or a viral link driving a
// traffic spike. Keyed on CF-Connecting-IP, the header Cloudflare's edge sets to the real client
// IP on every Internet request; local dev and tests never see it, so they fall back to a fixed
// key (the binding's own local simulation doesn't share state with production either way).
export async function checkRequestRateLimit(request: Request, limiter: RequestRateLimiter): Promise<Response | null> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
  const { success } = await limiter.limit(ip);
  return success ? null : new Response('rate limit exceeded', { status: 429 });
}
