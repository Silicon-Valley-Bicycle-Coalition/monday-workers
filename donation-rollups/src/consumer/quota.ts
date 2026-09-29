// D1 Free-tier daily limits (enforced since 2026-09-01): once an account passes 100k rows
// written (or 5M read) in a UTC day, every D1 query fails with a fixed error text until midnight
// UTC. Retrying such a message in minutes only burns its retries into the DLQ (README
// "operational findings, 2026-09-17", fix 4) — the useful retry is the one after midnight.

// Cloudflare Queues caps a retry delay at 12 hours. When midnight is further away the message
// comes back once mid-way, fails cheaply (no Monday calls — see processBatch), and delays again.
export const MAX_QUEUE_DELAY_SECONDS = 43_200;
const MIN_DELAY_SECONDS = 60;

const QUOTA_TEXT = /exceeded D1's free tier daily row (read|write) limit/i;

export function isD1QuotaError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return QUOTA_TEXT.test(text);
}

// Monday rate-limit / complexity-budget errors (issue #27): an immediate retry lands in the same
// exhausted budget, so three of them DLQ the message within seconds. Back off from a minute,
// doubling per delivery attempt (Cloudflare's Message.attempts, 1 on first delivery), and never
// retry sooner than Monday's own retry_in_seconds hint says the budget resets.
export function rateLimitRetryDelaySeconds(retryInSeconds: number | undefined, attempts: number | undefined): number {
  const attempt = Number.isFinite(attempts) && attempts! >= 1 ? Math.floor(attempts!) : 1;
  const backoff = MIN_DELAY_SECONDS * 2 ** Math.min(attempt - 1, 16);
  const hint = retryInSeconds !== undefined && Number.isFinite(retryInSeconds) ? Math.ceil(retryInSeconds) : 0;
  return Math.min(MAX_QUEUE_DELAY_SECONDS, Math.max(backoff, hint));
}

// Any other transient failure (a Monday 5xx, a D1 blip): the same 60 s, 120 s, 240 s backoff
// without a server hint (#35). A bare retry() redelivers almost at once, so a short outage
// would burn every attempt and dead-letter the message in seconds.
export function transientRetryDelaySeconds(attempts: number | undefined): number {
  return rateLimitRetryDelaySeconds(undefined, attempts);
}

export function secondsUntilMidnightUTC(now: Date): number {
  const nextMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  const seconds = Math.ceil((nextMidnight - now.getTime()) / 1000);
  return Math.min(MAX_QUEUE_DELAY_SECONDS, Math.max(MIN_DELAY_SECONDS, seconds));
}
