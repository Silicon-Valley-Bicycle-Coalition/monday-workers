// Shared by both queue consumers (change requests, letter emails).

// The subset of Cloudflare's Message<T> the consumers use — narrow so tests can hand-build one.
// `attempts` starts at 1 on first delivery.
export interface QueueMessageLike<T> {
  body: T;
  attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

// Backoff for message.retry(): the write switch's shared min(60 × 2^(attempts−1), 3600) seconds,
// which with wrangler.jsonc's max_retries of 100 covers about four days of Monday or email outage
// (or a `hold`). A bare retry() redelivers almost immediately, so during a Monday rate-limit
// window a January backlog burned every attempt inside the same window and landed in the DLQ
// (issue #31). An out-of-range attempts count is treated as the first attempt.
export { retryDelaySeconds } from './flags';
