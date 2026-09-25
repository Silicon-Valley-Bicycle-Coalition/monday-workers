// Shared by both queue consumers (change requests, letter emails).

// The subset of Cloudflare's Message<T> the consumers use — narrow so tests can hand-build one.
// `attempts` starts at 1 on first delivery.
export interface QueueMessageLike<T> {
  body: T;
  attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

// Cloudflare Queues rejects a larger per-message delay.
export const MAX_RETRY_DELAY_SECONDS = 43_200;

// Exponential backoff for message.retry(): 2, 4, 8 … minutes, capped at 12h. A bare retry()
// redelivers almost immediately, so during a Monday rate-limit window (60s) a January backlog
// burned all of max_retries inside the same window and landed in the DLQ (issue #31). An
// out-of-range attempts count (hand-built or replayed message) is treated as the first attempt.
export function retryDelaySeconds(attempts: number): number {
  const n = Number.isFinite(attempts) && attempts >= 1 ? attempts : 1;
  return Math.min(60 * 2 ** n, MAX_RETRY_DELAY_SECONDS);
}
