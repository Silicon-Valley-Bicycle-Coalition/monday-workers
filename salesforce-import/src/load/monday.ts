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

// Monday's daily call quota. Not in the set above: waiting it out takes hours, so the client
// throws on it at once instead of retrying (see send()).
const DAILY_LIMIT = 'DAILY_LIMIT_EXCEEDED';

/** Whether `e` is a complexity/rate-limit rejection worth retrying (the request did not run). */
export function isRejectedBeforeRunning(e: GqlError): boolean {
  if (e.extensions?.code === DAILY_LIMIT) return false;
  return REJECTED_BEFORE_RUNNING.has(e.extensions?.code ?? '') || /complexity/i.test(e.message);
}

// Cap on any single Retry-After / retry_in_seconds wait, so one bad value can't silently stall
// the run; if the limit persists, the attempt budget runs out and the request fails.
const MAX_RETRY_IN_MS = 120_000;

/** The longest `retry_in_seconds` Monday asked for across `errors`, in ms (capped), or 0. */
export function retryInMs(errors: GqlError[]): number {
  const secs = Math.max(0, ...errors.map((e) => Number(e.extensions?.retry_in_seconds ?? 0) || 0));
  return Math.min(secs * 1000, MAX_RETRY_IN_MS);
}

/**
 * Where a run's requests went (#50). `retries` is keyed by why the request was re-sent;
 * `backoffMs` is the total wait the client asked for between attempts, summed across callers, so
 * it can exceed wall-clock time when several workers wait at once. Counted in send() only — the
 * legacy `--sequential` client is deliberately left untouched.
 */
export interface ClientStats {
  requests: number;
  retries: Record<string, number>;
  backoffMs: number;
  latencyMsTotal: number;
  latencyMsMax: number;
  peakInFlight: number;
}

const emptyStats = (): ClientStats =>
  ({ requests: 0, retries: {}, backoffMs: 0, latencyMsTotal: 0, latencyMsMax: 0, peakInFlight: 0 });

export class MondayClient {
  private attempts: number;
  private counters: ClientStats = emptyStats();
  private inFlight = 0;
  constructor(private opts: {
    apiUrl: string; token: string; fetchFn?: typeof fetch;
    sleepFn?: (ms: number) => Promise<void>; maxAttempts?: number; requestTimeoutMs?: number;
    /** `load --sequential`: gql() runs the pre-#22 client unchanged (see gqlLegacy). */
    legacy?: boolean;
  }) { this.attempts = opts.maxAttempts ?? 6; }

  /** A snapshot of the request counters since construction or the last resetStats(). */
  stats(): ClientStats { return { ...this.counters, retries: { ...this.counters.retries } }; }

  resetStats(): void { this.counters = emptyStats(); this.inFlight = 0; }

  private noteRetry(reason: string): void {
    this.counters.retries[reason] = (this.counters.retries[reason] ?? 0) + 1;
  }

  /** sleep() that also totals the wait into stats. */
  private async backoff(ms: number): Promise<void> {
    this.counters.backoffMs += ms;
    await this.sleep(ms);
  }

  /** The injected sleep (tests pass a no-op) — shared with callers that pace themselves. */
  sleep(ms: number): Promise<void> {
    return (this.opts.sleepFn ?? ((n: number) => new Promise<void>((r) => setTimeout(r, n))))(ms);
  }

  // `apiVersion` overrides the pinned API-Version header for this one call (e.g. configure's view
  // mutations need 2026-10); every other call stays on the pin.
  // `idempotent: false` still retries responses that prove the request was rejected before it
  // ran (HTTP 429, complexity-budget errors, the no-data shape carrying status_code 429), but
  // throws AmbiguousWriteError on anything that might have committed.
  async gql<T>(query: string, variables: Record<string, unknown> = {},
    { idempotent = true, apiVersion }: { idempotent?: boolean; apiVersion?: string } = {}): Promise<T> {
    if (this.opts.legacy) return this.gqlLegacy<T>(query, variables, { idempotent });
    const r = await this.send<T>(query, variables, idempotent, false, apiVersion);
    return r.data as T;
  }

  // The pre-#22 gql(), verbatim (origin/main as of 2026-09-28), so `load --sequential` — the
  // cutover-weekend fallback — behaves exactly as every earlier rehearsal did: only
  // ComplexityException is retried (no retry_in_seconds waits, no newer rate-limit codes, no
  // Retry-After cap), and an unreadable body throws a plain error (ledgered failed, not retried).
  // Do not "fix" this method; improvements belong in send().
  private async gqlLegacy<T>(query: string, variables: Record<string, unknown> = {},
    { idempotent = true }: { idempotent?: boolean } = {}): Promise<T> {
    const fetchFn = this.opts.fetchFn ?? fetch;
    const sleep = this.opts.sleepFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const ambiguous = (detail: string): string => {
      if (!idempotent) throw new AmbiguousWriteError(`monday: ${detail} (write may have committed)`);
      return detail;
    };
    let lastError = '';
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      if (attempt > 0) await sleep(2 ** attempt * 1000 + Math.random() * 500);
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
        if (after > 0) await sleep(after * 1000);
        continue;
      }
      if (res.status >= 500) { lastError = ambiguous(`HTTP ${res.status}`); continue; }
      if (!res.ok) throw new Error(`monday: HTTP ${res.status}: ${await res.text()}`);
      const body = await res.json() as
        // error_message/status_code: Monday's rate-limit/auth shape — HTTP 200, NO data,
        // NO errors array (see funraise-sync/src/monday/client.ts for the same handling).
        { data?: T; errors?: GqlError[]; error_message?: string; status_code?: number };
      if (body.errors?.length) {
        const complexity = body.errors.some((e) =>
          e.extensions?.code === 'ComplexityException' || /complexity/i.test(e.message));
        lastError = body.errors.map((e) => e.message).join('; ');
        if (complexity) continue;
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
      return body.data;
    }
    throw new Error(`monday: exhausted ${this.attempts} attempts — last error: ${lastError}`);
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
    partial: boolean, apiVersion = '2026-01'): Promise<PartialResult<T>> {
    const fetchFn = this.opts.fetchFn ?? fetch;
    const ambiguous = (detail: string): string => {
      if (!idempotent) throw new AmbiguousWriteError(`monday: ${detail} (write may have committed)`);
      return detail;
    };
    let lastError = '';
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      if (attempt > 0) await this.backoff(2 ** attempt * 1000 + Math.random() * 500);
      let res: Response;
      const startedAt = Date.now();
      this.counters.requests++;
      this.inFlight++;
      this.counters.peakInFlight = Math.max(this.counters.peakInFlight, this.inFlight);
      try {
        // Without a timeout one hung socket stalls an hours-long load indefinitely.
        res = await fetchFn(this.opts.apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: this.opts.token,
            'API-Version': apiVersion },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(this.opts.requestTimeoutMs ?? 60_000),
        });
      } catch (err) {
        // ECONNRESET, DNS failure, timeout — previously these escaped the retry loop entirely.
        this.inFlight--;
        this.noteRetry('network');
        lastError = ambiguous(`network error: ${String(err)}`);
        continue;
      }
      this.inFlight--;
      const elapsed = Date.now() - startedAt;
      this.counters.latencyMsTotal += elapsed;
      this.counters.latencyMsMax = Math.max(this.counters.latencyMsMax, elapsed);
      if (res.status === 429) {
        const after = Number(res.headers.get('Retry-After') ?? '0');
        lastError = 'HTTP 429';
        this.noteRetry('HTTP 429');
        if (after > 0) await this.backoff(Math.min(after * 1000, MAX_RETRY_IN_MS));
        continue;
      }
      if (res.status >= 500) { this.noteRetry(`HTTP ${res.status}`); lastError = ambiguous(`HTTP ${res.status}`); continue; }
      if (!res.ok) throw new Error(`monday: HTTP ${res.status}: ${await res.text()}`);
      // error_message/status_code: Monday's rate-limit/auth shape — HTTP 200, NO data,
      // NO errors array (see funraise-sync/src/monday/client.ts for the same handling).
      type Body = { data?: T | null; errors?: GqlError[]; error_message?: string; status_code?: number };
      let body: Body;
      try {
        body = await res.json() as Body;
      } catch (err) {
        // A reset or timeout mid-body (or a truncated body): the server already ran the
        // request, so for a write this is exactly as ambiguous as a dropped connection.
        this.noteRetry('unreadable body');
        lastError = ambiguous(`unreadable response body: ${String(err)}`);
        continue;
      }
      if (body.errors?.length) {
        lastError = body.errors.map((e) => e.message).join('; ');
        // Nothing will succeed until tomorrow: fail at once, never retry (so a create can't be
        // re-sent on account of it), and let the caller ledger failures for a later re-run.
        if (body.errors.some((e) => e.extensions?.code === DAILY_LIMIT)) {
          throw new Error(`monday: daily API limit reached — ${lastError}`);
        }
        const rejected = body.errors.some(isRejectedBeforeRunning);
        if (partial) {
          // No data object at all means nothing ran; any data means the request executed and
          // the caller sorts out which aliases landed.
          const ran = body.data !== undefined && body.data !== null;
          if (ran || !rejected) return { data: body.data ?? null, errors: body.errors };
        }
        if (rejected) {
          this.noteRetry(body.errors.find(isRejectedBeforeRunning)?.extensions?.code ?? 'rejected');
          const wait = retryInMs(body.errors);
          if (wait > 0) await this.backoff(wait);
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
        this.noteRetry('no data');
        if (body.status_code !== 429) lastError = ambiguous(lastError);
        continue;
      }
      return { data: body.data, errors: [] };
    }
    throw new Error(`monday: exhausted ${this.attempts} attempts — last error: ${lastError}`);
  }
}
