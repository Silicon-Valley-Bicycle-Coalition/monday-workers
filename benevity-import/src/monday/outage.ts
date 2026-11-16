// A per-batch circuit breaker for queue consumers (#101). Canonical copy:
// funraise-sync/src/monday/outage.ts. Every queue Worker in the `monday-outage-copies` CI job
// carries a byte-identical copy at src/monday/outage.ts; edit this one, then copy it over. It is
// bundled by Wrangler only (its imports are extensionless), never loaded by a Worker's .mjs script.
//
// Why: the transport spends its in-process attempts (and honours advised waits of up to 60 s
// each) on every call. When Monday is down or rate-limiting, each message in a batch of 10 would
// repeat that on its own, which can run past the consumer's 15-minute wall-time limit. Once one
// message fails on an outage-shaped error, the consumer stops calling Monday for the rest of the
// batch and retries every remaining message with the shared backoff, raised to Monday's hint.
// Per-message failures (a rejected value, a missing item) don't trip it.

import { MondayApiError } from './graphql';
import { retryDelaySeconds } from '../flags';

// Monday's codes for a spent budget or rate/concurrency limit: every other request in the batch
// would hit the same wall. (The per-query "exceeds max complexity" cap is a property of one
// query, carries a different code, and stays per-message.)
const RATE_LIMIT_CODE = /^(COMPLEXITY_BUDGET_EXHAUSTED|ComplexityException|RATE_LIMIT_EXCEEDED|IP_RATE_LIMIT_EXCEEDED|DAILY_LIMIT_EXCEEDED|maxConcurrencyExceeded)$/;
const DAILY_LIMIT_CODE = /daily_limit/i;

// How far down an error's `cause` chain to look, for a Worker that wraps the transport's error.
const MAX_CAUSE_DEPTH = 5;

function transportErrorOf(err: unknown): MondayApiError | null {
  let current: unknown = err;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current instanceof Error; depth++) {
    if (current instanceof MondayApiError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * True when a failure says Monday itself is unavailable, not that this one request was wrong: an
 * HTTP 429 or 5xx, a network error or timeout (the transport records no HTTP status for those),
 * or a budget/rate/concurrency/daily-limit code. Only the transport's MondayApiError counts, so
 * a Worker's own errors (D1, config, another upstream) never trip the breaker.
 */
export function isMondayOutage(err: unknown): boolean {
  const transportError = transportErrorOf(err);
  if (transportError === null) return false;
  const status = transportError.httpStatus;
  if (status === undefined || status === 429 || status >= 500) return true;
  return RATE_LIMIT_CODE.test(transportError.code ?? '');
}

function secondsUntilMidnightUTC(now: Date): number {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((midnight - now.getTime()) / 1000));
}

/**
 * Monday's own "not before" for an outage error, in seconds: its Retry-After/retry_in_seconds
 * hint, else midnight UTC for the daily call limit, else none (the shared backoff alone).
 */
export function outageHintSeconds(err: unknown, now: Date = new Date()): number | undefined {
  const transportError = transportErrorOf(err);
  if (transportError === null) return undefined;
  if (transportError.retryAfterSeconds) return Math.ceil(transportError.retryAfterSeconds);
  if (DAILY_LIMIT_CODE.test(transportError.code ?? '')) return secondsUntilMidnightUTC(now);
  return undefined;
}

interface RetryableMessage {
  attempts?: number;
  retry(options?: { delaySeconds?: number }): void;
}

/**
 * One per queue() batch. Call `trip(err)` from the consumer's catch: it returns true (and opens
 * the breaker) for an outage. While `open`, `defer(message)` retries a message without touching
 * Monday. Every delay is flags.ts's retryDelaySeconds for that message's own attempt count,
 * raised to the outage's hint, so a deferred sibling backs off on the same schedule it would
 * have had after failing for itself. Its retry() counts against its own max_retries, as always.
 */
export class OutageBreaker {
  private tripped = false;
  private hintSeconds: number | undefined;
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  get open(): boolean {
    return this.tripped;
  }

  trip(err: unknown): boolean {
    if (!isMondayOutage(err)) return false;
    const hint = outageHintSeconds(err, this.now());
    if (hint !== undefined && (this.hintSeconds === undefined || hint > this.hintSeconds)) this.hintSeconds = hint;
    this.tripped = true;
    return true;
  }

  delaySeconds(attempts: number | undefined): number {
    return retryDelaySeconds(attempts, this.hintSeconds);
  }

  defer(message: RetryableMessage): void {
    message.retry({ delaySeconds: this.delaySeconds(message.attempts) });
  }
}
