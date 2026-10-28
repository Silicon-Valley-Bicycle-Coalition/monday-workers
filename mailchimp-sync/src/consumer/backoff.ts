import { MailchimpRateLimitError } from '../mailchimp/client';
import { MondayApiError } from '../monday/client';
import { retryDelaySeconds as sharedRetryDelaySeconds } from '../flags';

// Retry backoff (#35, then the write switch): a bare message.retry() redelivers almost
// immediately, so a rate-limit burst would burn the retries within seconds. The base delay is the
// fleet-wide curve in flags.ts (60 s doubling to an hour, across wrangler.jsonc's max_retries of
// 100 — about four days of cover); this file only supplies the upstream hint.

// One greppable line when Mailchimp rejects the API key, naming the secret but never its value.
export function credentialsRejectedLog(consumer: 'inbound' | 'outbound'): string {
  return `mailchimp-sync ${consumer} consumer: MAILCHIMP CREDENTIALS REJECTED (HTTP 401/403) — the MAILCHIMP_API_KEY secret is invalid, revoked, or lacks access. Retrying with backoff so messages dead-letter rather than drop; fix the secret, then replay the DLQ.`;
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

// The delay for message.retry(): the shared backoff for this attempt, stretched to at least any
// rate-limit hint, never beyond Queues' 12-hour cap (flags.ts retryDelaySeconds).
export function retryDelaySeconds(attempts: number | undefined, err?: unknown, now: Date = new Date()): number {
  const hint = rateLimitHintSeconds(err, now);
  return sharedRetryDelaySeconds(attempts, hint === undefined ? undefined : Math.ceil(hint));
}
