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

export function secondsUntilMidnightUTC(now: Date): number {
  const nextMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  const seconds = Math.ceil((nextMidnight - now.getTime()) / 1000);
  return Math.min(MAX_QUEUE_DELAY_SECONDS, Math.max(MIN_DELAY_SECONDS, seconds));
}
