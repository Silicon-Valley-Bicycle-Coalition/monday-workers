// Monday GraphQL transport with retry/backoff: HTTP 429 and Retry-After, the per-minute
// complexity budget and rate/concurrency limits, 5xx and network errors, per-attempt timeouts,
// and write-safety (a create that may have committed is never blindly retried).
//
// CANONICAL COPY (#35). This file is byte-identical in every Worker that uses it, so each Worker
// stays self-contained and forkable on its own — no shared package. The CI job
// `monday-graphql-copies` in .gitlab-ci.yml fails if any copy differs from
// monday-backup/src/monday/graphql.ts. To change it, edit that file and copy it over every
// path the job lists. Keep Worker-specific behaviour in each Worker's own client, via the options.
//
// Modelled on salesforce-import/src/load/monday.ts; keep the two in step when either learns a
// new failure mode.

// Default pin. Monday serves a request for a deprecated version as the *maintenance* version, so
// an unpinned or stale pin drifts silently. 2026-07 is current as of 2026-09; none of its breaking
// changes (users pagination, connection_board_ids, columns.capabilities) touch monday-backup's
// queries. A Worker whose queries were written against another version passes `apiVersion`.
// Re-check developer.monday.com/api-reference/docs/api-versioning when bumping.
export const MONDAY_API_VERSION = '2026-07';

// A wall-clock budget the transport respects: attempt timeouts and retry waits are capped to it,
// and a retry that would cross it throws. monday-backup's Deadline (src/deadline.ts) is one;
// without one, retries are bounded only by maxAttempts.
export interface RetryBudget {
  // Throws if the budget is spent; `what` names the call for the error message.
  check(what: string): void;
  // A per-attempt timeout that never runs past the budget.
  timeoutMs(maxMs: number): number;
  // Sleeps `ms` before a retry, or throws if that retry would start past the budget.
  sleepBeforeRetry(sleep: (ms: number) => Promise<void>, ms: number, what: string): Promise<void>;
}

const UNBOUNDED: RetryBudget = {
  check: () => {},
  timeoutMs: (maxMs) => maxMs,
  sleepBeforeRetry: (sleep, ms) => sleep(ms),
};

// Server-advised waits are honoured but capped, so one odd header can't eat the cron's
// 15-minute wall-time budget.
const MAX_ADVISED_WAIT_MS = 60_000;

// Retryable GraphQL error codes: the per-minute complexity budget and the rate/concurrency
// limits. Monday reports these in `errors[].extensions.code`, sometimes with `retry_in_seconds`.
const RETRYABLE_CODE = /complexity|rate_limit|concurrency/i;

interface GraphQLError {
  message: string;
  extensions?: { code?: string; retry_in_seconds?: number };
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: GraphQLError[];
  // Monday's rate-limit / auth-failure shape: HTTP 200 with no data and no errors array.
  error_message?: string;
  status_code?: number;
}

// Thrown instead of retrying when a non-idempotent mutation failed in a way that may have happened
// after Monday committed it (5xx, network error/timeout, or the no-data shape without a
// rate-limit status). Blindly retrying would create duplicates; the caller must check first.
export class AmbiguousWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmbiguousWriteError';
  }
}

export interface MondayGraphQLOptions {
  sleepFn?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  requestTimeoutMs?: number;
  // The run's wall-clock budget (see RetryBudget). Unbounded when absent.
  deadline?: RetryBudget;
  // The `API-Version` header; MONDAY_API_VERSION when absent.
  apiVersion?: string;
}

export interface RequestOptions {
  // false for mutations that create things: only failures that prove the request never ran are
  // retried; anything that might have committed throws AmbiguousWriteError.
  idempotent?: boolean;
}

export class MondayGraphQL {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly requestTimeoutMs: number;
  private readonly deadline: RetryBudget;
  private readonly apiVersion: string;

  constructor(
    private apiUrl: string,
    private apiToken: string,
    options: MondayGraphQLOptions = {},
  ) {
    this.sleep = options.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxAttempts = options.maxAttempts ?? 5;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    this.deadline = options.deadline ?? UNBOUNDED;
    this.apiVersion = options.apiVersion ?? MONDAY_API_VERSION;
  }

  async request<T>(query: string, variables: Record<string, unknown>, { idempotent = true }: RequestOptions = {}): Promise<T> {
    const ambiguous = (detail: string): string => {
      if (!idempotent) throw new AmbiguousWriteError(`monday API: ${detail} (the write may have committed)`);
      return detail;
    };
    let lastError = '';
    let advisedWaitMs = 0;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      if (attempt > 0) {
        const backoffMs = 2 ** attempt * 1000 + Math.random() * 500;
        const waitMs = Math.max(backoffMs, Math.min(advisedWaitMs, MAX_ADVISED_WAIT_MS));
        await this.deadline.sleepBeforeRetry(this.sleep, waitMs, `monday API (last error: ${lastError})`);
        advisedWaitMs = 0;
      }
      this.deadline.check(`monday API${lastError === '' ? '' : ` (last error: ${lastError})`}`);

      let response: Response;
      try {
        response = await fetch(this.apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Monday expects the bare token, no "Bearer " prefix.
            Authorization: this.apiToken,
            'API-Version': this.apiVersion,
          },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(this.deadline.timeoutMs(this.requestTimeoutMs)),
        });
      } catch (err) {
        // A timeout cut short by the deadline is the budget running out, not a network fault.
        this.deadline.check(`monday API (request cut off: ${String(err)})`);
        lastError = ambiguous(`network error: ${String(err)}`);
        continue;
      }

      if (response.status === 429) {
        advisedWaitMs = Number(response.headers.get('Retry-After') ?? '0') * 1000;
        lastError = 'HTTP 429';
        continue;
      }
      if (response.status >= 500) {
        lastError = ambiguous(`HTTP ${response.status}`);
        continue;
      }
      if (!response.ok) {
        throw new Error(`monday API: HTTP ${response.status}: ${await response.text()}`);
      }

      const json = (await response.json()) as GraphQLResponse<T>;
      if (json.errors && json.errors.length > 0) {
        lastError = json.errors.map((e) => e.message).join('; ');
        // A single query over the per-query complexity cap fails identically every time; only
        // the per-minute budget (and rate/concurrency limits) recover with a wait. These are
        // rejected before execution, so they are safe to retry even for writes.
        const retryable = json.errors.find(
          (e) =>
            !/exceeds max complexity/i.test(e.message) &&
            (RETRYABLE_CODE.test(e.extensions?.code ?? '') || /complexity/i.test(e.message)),
        );
        if (retryable === undefined) throw new Error(`monday API: ${lastError}`);
        advisedWaitMs = (retryable.extensions?.retry_in_seconds ?? 0) * 1000;
        continue;
      }
      if (!json.data) {
        // Usually a rate limit, so retry; the exhausted-attempts error carries the detail.
        lastError =
          typeof json.error_message === 'string'
            ? `response contained no data — ${json.error_message}${json.status_code === undefined ? '' : ` (status_code ${json.status_code})`}`
            : `response contained no data — ${JSON.stringify(json)}`;
        if (json.status_code !== 429) lastError = ambiguous(lastError);
        continue;
      }
      return json.data;
    }
    throw new Error(`monday API: exhausted ${this.maxAttempts} attempts — last error: ${lastError}`);
  }
}
