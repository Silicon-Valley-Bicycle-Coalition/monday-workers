export interface GqlError {
  message: string;
  // Present on per-field errors: the alias (or field) the error belongs to, e.g. ['i3'].
  path?: (string | number)[];
  extensions?: { code?: string; retry_in_seconds?: number };
}

/** A GraphQL response whose field-level errors are returned rather than thrown. */
export interface PartialResult<T> { data: T | null; errors: GqlError[] }

// Thrown instead of retrying when a NON-idempotent mutation (create_item) failed in a way that
// may have happened after Monday committed it — a 5xx, a dropped connection, a timeout, or the
// HTTP-200/no-data shape without a rate-limit status. Blindly retrying those creates duplicate
// items; the caller must first check whether the write landed (see load/index.ts).
export class AmbiguousWriteError extends Error {
  constructor(message: string) { super(message); this.name = 'AmbiguousWriteError'; }
}

// Error codes Monday uses for a request it refused before running any of it: the per-minute
// complexity budget, the per-minute request rate, and the concurrent-request cap. Retrying these
// can't duplicate a write.
const REJECTED_BEFORE_RUNNING = new Set(['ComplexityException', 'COMPLEXITY_BUDGET_EXHAUSTED',
  'RATE_LIMIT_EXCEEDED', 'maxConcurrencyExceeded']);

/** Whether `e` is a complexity/rate-limit rejection (the request did not run). */
export function isRejectedBeforeRunning(e: GqlError): boolean {
  return REJECTED_BEFORE_RUNNING.has(e.extensions?.code ?? '') || /complexity/i.test(e.message);
}

// A daily-limit reply can carry retry_in_seconds in the hours; waiting that long inside one
// request would silently stall the run, so cap the wait and let the attempt budget run out.
const MAX_RETRY_IN_MS = 120_000;

/** The longest `retry_in_seconds` Monday asked for across `errors`, in ms (capped), or 0. */
export function retryInMs(errors: GqlError[]): number {
  const secs = Math.max(0, ...errors.map((e) => Number(e.extensions?.retry_in_seconds ?? 0) || 0));
  return Math.min(secs * 1000, MAX_RETRY_IN_MS);
}

export class MondayClient {
  private attempts: number;
  constructor(private opts: {
    apiUrl: string; token: string; fetchFn?: typeof fetch;
    sleepFn?: (ms: number) => Promise<void>; maxAttempts?: number; requestTimeoutMs?: number;
  }) { this.attempts = opts.maxAttempts ?? 6; }

  /** The injected sleep (tests pass a no-op) — shared with callers that pace themselves. */
  sleep(ms: number): Promise<void> {
    return (this.opts.sleepFn ?? ((n: number) => new Promise<void>((r) => setTimeout(r, n))))(ms);
  }

  // `idempotent: false` still retries responses that prove the request was rejected before it
  // ran (HTTP 429, complexity-budget errors, the no-data shape carrying status_code 429), but
  // throws AmbiguousWriteError on anything that might have committed.
  async gql<T>(query: string, variables: Record<string, unknown> = {},
    { idempotent = true }: { idempotent?: boolean } = {}): Promise<T> {
    const r = await this.send<T>(query, variables, idempotent, false);
    return r.data as T;
  }

  /**
   * For aliased multi-mutation requests (several `create_item`s in one call): per-alias errors
   * come back in `errors` next to the aliases that succeeded, instead of throwing away the
   * successes. Always non-idempotent — anything that might have committed throws
   * {@link AmbiguousWriteError}. A whole-request complexity/rate-limit rejection (no `data` at
   * all) is retried here; once any `data` exists the request ran, so it is returned as is.
   * @throws AmbiguousWriteError on a 5xx, network error, timeout, or the no-data shape.
   * @throws Error on any other non-retryable whole-request failure.
   */
  async gqlPartial<T>(query: string, variables: Record<string, unknown> = {}): Promise<PartialResult<T>> {
    return this.send<T>(query, variables, false, true);
  }

  private async send<T>(query: string, variables: Record<string, unknown>, idempotent: boolean,
    partial: boolean): Promise<PartialResult<T>> {
    const fetchFn = this.opts.fetchFn ?? fetch;
    const ambiguous = (detail: string): string => {
      if (!idempotent) throw new AmbiguousWriteError(`monday: ${detail} (write may have committed)`);
      return detail;
    };
    let lastError = '';
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      if (attempt > 0) await this.sleep(2 ** attempt * 1000 + Math.random() * 500);
      let res: Response;
      try {
        // Without a timeout one hung socket stalls an hours-long load indefinitely.
        res = await fetchFn(this.opts.apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: this.opts.token,
            'API-Version': '2026-01' },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(this.opts.requestTimeoutMs ?? 60_000),
        });
      } catch (err) {
        // ECONNRESET, DNS failure, timeout — previously these escaped the retry loop entirely.
        lastError = ambiguous(`network error: ${String(err)}`);
        continue;
      }
      if (res.status === 429) {
        const after = Number(res.headers.get('Retry-After') ?? '0');
        lastError = 'HTTP 429';
        if (after > 0) await this.sleep(Math.min(after * 1000, MAX_RETRY_IN_MS));
        continue;
      }
      if (res.status >= 500) { lastError = ambiguous(`HTTP ${res.status}`); continue; }
      if (!res.ok) throw new Error(`monday: HTTP ${res.status}: ${await res.text()}`);
      const body = await res.json() as
        // error_message/status_code: Monday's rate-limit/auth shape — HTTP 200, NO data,
        // NO errors array (see funraise-sync/src/monday/client.ts for the same handling).
        { data?: T | null; errors?: GqlError[]; error_message?: string; status_code?: number };
      if (body.errors?.length) {
        const rejected = body.errors.some(isRejectedBeforeRunning);
        lastError = body.errors.map((e) => e.message).join('; ');
        if (partial) {
          // No data object at all means nothing ran; any data means the request executed and
          // the caller sorts out which aliases landed.
          const ran = body.data !== undefined && body.data !== null;
          if (ran || !rejected) return { data: body.data ?? null, errors: body.errors };
        }
        if (rejected) {
          const wait = retryInMs(body.errors);
          if (wait > 0) await this.sleep(wait);
          continue;
        }
        throw new Error(`monday: ${lastError}`);
      }
      if (body.data === undefined) {
        // Retry with the same backoff as 429 — this shape usually IS a rate limit — and let
        // the exhausted-attempts throw below carry the server's message. Returning body.data
        // here would hand the caller undefined and fail later with a bare TypeError.
        lastError = typeof body.error_message === 'string'
          ? `no data — ${body.error_message}` +
            (body.status_code === undefined ? '' : ` (status_code ${body.status_code})`)
          : `no data — ${JSON.stringify(body)}`;
        if (body.status_code !== 429) lastError = ambiguous(lastError);
        continue;
      }
      return { data: body.data, errors: [] };
    }
    throw new Error(`monday: exhausted ${this.attempts} attempts — last error: ${lastError}`);
  }
}
