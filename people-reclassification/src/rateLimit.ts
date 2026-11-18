import { secretsMatch } from './secret';

export interface RequestRateLimiter {
  limit(key: string): Promise<{ success: boolean }>;
}

export const PROMOTE_WEBHOOK_PATH = '/webhooks/monday/promote';

// Issue GL#110, mirroring donation-rollups' GL#27 fix: Monday delivers from a small pool of IPs, so
// bulk-setting Promote on more than 60 people got its own deliveries 429'd (and promoted a day late,
// by the morning sweep). A delivery that passes the webhook's URL check (POST, exact path, matching
// ?secret=) skips the limiter; anything else, a guessed secret or the right secret on another
// route, is limited as before. The route still checks the JWT after this. One SHA-256 pair, no I/O.
export async function isVerifiedMondayWebhook(request: Request, webhookSecret: string | undefined): Promise<boolean> {
  if (request.method !== 'POST') return false;
  const url = new URL(request.url);
  if (url.pathname !== PROMOTE_WEBHOOK_PATH) return false;
  return secretsMatch(url.searchParams.get('secret') ?? undefined, webhookSecret);
}

// A blanket per-IP guard checked before any routing, D1, or Monday work — the root README's
// "Reliability: traffic and cost limits". Covers the authenticated /reclassify/* routes and every
// promote-webhook call that fails isVerifiedMondayWebhook above; a flood costs at most
// REQUEST_RATE_LIMITER's configured rate. Keyed on CF-Connecting-IP (set by Cloudflare's edge); local dev and tests
// never see it and fall back to a fixed key.
export async function checkRequestRateLimit(request: Request, limiter: RequestRateLimiter): Promise<Response | null> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
  const { success } = await limiter.limit(ip);
  return success ? null : new Response('rate limit exceeded', { status: 429 });
}
