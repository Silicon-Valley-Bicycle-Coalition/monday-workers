import { SECRET_HEADER, secretsMatch } from './webhook/route';

export interface RequestRateLimiter {
  limit(key: string): Promise<{ success: boolean }>;
}

// The webhook routes' own paths (webhook/route.ts registers the same strings).
export const WEBHOOK_PATHS: ReadonlySet<string> = new Set(['/webhooks/funraise/transaction']);

// A burst of genuine deliveries (a giving-day rush, sent from Funraise's small pool of IPs) must not draw 429s from the per-IP limiter (GL#101; mailchimp-sync and
// donation-rollups learned this first, issue GL#27). A delivery that passes the route's own check
// (POST, exact webhook path, matching secret in X-Webhook-Secret or ?secret=) skips the limiter;
// anything else, a guessed secret or the right secret on another route, is limited as before, so
// the exemption can't be reached without the secret. Costs one SHA-256 pair per request, no I/O.
export async function isVerifiedWebhook(request: Request, webhookSecret: string | undefined): Promise<boolean> {
  if (request.method !== 'POST') return false;
  const url = new URL(request.url);
  if (!WEBHOOK_PATHS.has(url.pathname)) return false;
  return secretsMatch(request.headers.get(SECRET_HEADER) ?? url.searchParams.get('secret') ?? undefined, webhookSecret);
}

// A blanket per-IP guard checked before any routing, D1, or Monday work — see README
// "Reliability: traffic and cost limits". Covers every request except a webhook delivery that
// already passed verification (isVerifiedWebhook above); a flood of anything else costs at most
// REQUEST_RATE_LIMITER's configured rate instead of one full request per delivery.
// Keyed on CF-Connecting-IP, the header Cloudflare's edge sets to the real client IP on every
// Internet request; local dev and tests never see it, so they fall back to a fixed key (the
// binding's own local simulation doesn't share state with production either way).
export async function checkRequestRateLimit(request: Request, limiter: RequestRateLimiter): Promise<Response | null> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
  const { success } = await limiter.limit(ip);
  return success ? null : new Response('rate limit exceeded', { status: 429 });
}
