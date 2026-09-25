import { MailchimpRateLimitError } from '../mailchimp/client';
import { MondayApiError } from '../monday/client';

// Retry backoff (#35): a bare message.retry() redelivers almost immediately, so a Monday or
// Mailchimp rate-limit burst burns all of wrangler.jsonc's max_retries (3) within seconds and
// dead-letters the message. 60 s × 4^(attempt−1) gives 1, 4 and 16 minutes — about 21 minutes of
// cover — capped at Queues' 12-hour maximum delay. Same curve as the rest of the fleet; copied
// rather than shared until #35's shared package lands.
const RETRY_BASE_SECONDS = 60;
const RETRY_FACTOR = 4;
export const MAX_RETRY_DELAY_SECONDS = 12 * 60 * 60;

// One greppable line when Mailchimp rejects the API key, naming the secret but never its value.
export function credentialsRejectedLog(consumer: 'inbound' | 'outbound'): string {
  return `mailchimp-sync ${consumer} consumer: MAILCHIMP CREDENTIALS REJECTED (HTTP 401/403) — the MAILCHIMP_API_KEY secret is invalid, revoked, or lacks access. Retrying with backoff so messages dead-letter rather than drop; fix the secret, then replay the DLQ.`;
}

export function backoffSeconds(attempts: number | undefined): number {
  const attempt = typeof attempts === 'number' && Number.isFinite(attempts) && attempts >= 1 ? Math.floor(attempts) : 1;
  return Math.min(RETRY_BASE_SECONDS * RETRY_FACTOR ** (attempt - 1), MAX_RETRY_DELAY_SECONDS);
}

export function secondsUntilNextMidnightUtc(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.ceil((next - now.getTime()) / 1000);
}

// How long the upstream API asked us to wait, if it said. Mailchimp's 429 may carry Retry-After;
// Monday's rate-limit/complexity errors carry retry_in_seconds (or Retry-After). Monday's daily
// call limit resets at midnight UTC, so with no explicit hint that's the earliest useful retry.
export function rateLimitHintSeconds(err: unknown, now: Date): number | undefined {
  if (err instanceof MailchimpRateLimitError) return err.retryAfterSeconds;
  if (err instanceof MondayApiError) {
    if (err.retryAfterSeconds !== undefined) return err.retryAfterSeconds;
    if (err.code === 'DAILY_LIMIT_EXCEEDED') return secondsUntilNextMidnightUtc(now);
  }
  return undefined;
}

// The delay for message.retry(): the exponential backoff for this attempt, stretched to at least
// any rate-limit hint, never beyond Queues' 12-hour cap.
export function retryDelaySeconds(attempts: number | undefined, err?: unknown, now: Date = new Date()): number {
  const backoff = backoffSeconds(attempts);
  const hint = rateLimitHintSeconds(err, now);
  const delay = hint === undefined ? backoff : Math.max(backoff, Math.ceil(hint));
  return Math.min(delay, MAX_RETRY_DELAY_SECONDS);
}
