import { secretsMatch } from './secret';

export interface RequestRateLimiter {
  limit(key: string): Promise<{ success: boolean }>;
}

export const MONDAY_WEBHOOK_PATH = '/webhooks/monday';

// Monday delivers every webhook from a small pool of IPs, so a bulk edit of more than a minute's
// limit of rows spent the per-IP budget and Monday's own deliveries got 429s (donation-rollups
// hit this first, issue GL#27). A delivery that passes the webhook's own check (right method, exact
// path, matching ?secret=) skips the limiter; anything else — a guessed secret, the right secret
// on another route — is limited as before, so the exemption can't be reached without the secret.
// Costs one SHA-256 pair per request, no I/O.
export async function isVerifiedMondayWebhook(request: Request, webhookSecret: string | undefined): Promise<boolean> {
  if (request.method !== 'POST') return false;
  const url = new URL(request.url);
  if (url.pathname !== MONDAY_WEBHOOK_PATH) return false;
  return secretsMatch(url.searchParams.get('secret') ?? undefined, webhookSecret);
}

// A blanket per-IP guard checked before any routing, D1, or Monday/QuickBooks work — see README
// "Reliability: traffic and cost limits". Covers every request except a Monday webhook delivery
// that already passed verification (isVerifiedMondayWebhook above); a flood of anything else
// costs at most REQUEST_RATE_LIMITER's configured rate instead of one full request per delivery.
// Keyed on CF-Connecting-IP, the header Cloudflare's edge sets to the real client IP on every
// Internet request; local dev and tests never see it, so they fall back to a fixed key (the
// binding's own local simulation doesn't share state with production either way).
export async function checkRequestRateLimit(request: Request, limiter: RequestRateLimiter): Promise<Response | null> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
  const { success } = await limiter.limit(ip);
  return success ? null : new Response('rate limit exceeded', { status: 429 });
}
