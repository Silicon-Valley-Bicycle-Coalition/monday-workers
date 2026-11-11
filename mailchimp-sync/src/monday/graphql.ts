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

// The one API-Version pin for every Worker that carries this transport (#39). Workers take it from
// here and never override it for their ordinary calls; a one-off call that needs a newer field
// passes `apiVersion` (e.g. salesforce-import's configure step). Monday serves a request for a
// deprecated version as the *maintenance* version, so an unpinned or stale pin drifts silently.
// 2026-07 is Current until 2026-10-01 and Maintenance after that; versions stay in maintenance
// for a year or more (2025-04 still is as of 2026-09-30) and deprecation dates are announced
// ahead. None of its breaking changes (users pagination, connection_board_ids,
// columns.capabilities) touch any query in this repo. Bump at least every two quarters: check
// `{ version { value kind } }` and developer.monday.com/api-reference/docs/api-versioning, then
// re-run every Worker's tests.
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

// Monday's daily call limit resets at midnight UTC, so no in-process wait clears it: it fails fast
// with its code, and the caller schedules the retry (e.g. a queue delay to midnight).
const DAILY_LIMIT_CODE = /daily_limit/i;

interface GraphQLError {
  message: string;
  // Monday's machine-readable code (COMPLEXITY_BUDGET_EXHAUSTED, RATE_LIMIT_EXCEEDED,
  // DAILY_LIMIT_EXCEEDED, …) and, for rate limits, how long to wait.
  extensions?: { code?: unknown; error_code?: unknown; retry_in_seconds?: unknown };
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: GraphQLError[];
  // Monday's legacy rate-limit / auth-failure shape: no data and no errors array.
  error_message?: string;
  error_code?: string;
  status_code?: number;
}

export interface MondayErrorDetails {
  // The HTTP status, or the legacy no-data shape's status_code. Absent for a network error.
  httpStatus?: number;
  // Monday's error code, when it sent one.
  code?: string;
  // How long Monday asked the caller to wait, in seconds, when it said.
  retryAfterSeconds?: number;
}

// Every failure the transport reports. Carries what a queue consumer needs to pick a retry delay:
// a daily-limit code means "after midnight UTC", a retry hint means "not before this".
export class MondayApiError extends Error {
  readonly httpStatus: number | undefined;
  readonly code: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(message: string, details: MondayErrorDetails = {}) {
    super(message);
    this.name = 'MondayApiError';
    this.httpStatus = details.httpStatus;
    this.code = details.code;
    this.retryAfterSeconds = details.retryAfterSeconds;
  }
}

// Thrown instead of retrying when a non-idempotent mutation failed in a way that may have happened
// after Monday committed it (5xx, network error/timeout, or the no-data shape without a
// rate-limit status). Blindly retrying would create duplicates; the caller must check first.
export class AmbiguousWriteError extends MondayApiError {
  constructor(message: string, details: MondayErrorDetails = {}) {
    super(message, details);
    this.name = 'AmbiguousWriteError';
  }
}

function nonNegativeNumber(value: unknown): number | undefined {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
}

// Retry-After is either delta-seconds or an HTTP-date.
function retryAfterSeconds(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = nonNegativeNumber(header);
  if (seconds !== undefined) return seconds;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - Date.now()) / 1000)) : undefined;
}

function codeOf(error: GraphQLError): string | undefined {
  const code = error.extensions?.code ?? error.extensions?.error_code;
  return typeof code === 'string' ? code : undefined;
}

// Code and retry hint from whatever Monday sent: GraphQL error extensions, the legacy shape's
// error_code and "… reset in N seconds" prose, then the Retry-After header.
function errorDetails(
  httpStatus: number | undefined,
  json: GraphQLResponse<unknown> | undefined,
  retryAfterHeader: string | null,
  errors: GraphQLError[] = json?.errors ?? [],
): MondayErrorDetails {
  let code: string | undefined;
  let retryAfter: number | undefined;
  for (const e of errors) {
    code ??= codeOf(e);
    retryAfter ??= nonNegativeNumber(e.extensions?.retry_in_seconds);
  }
  if (code === undefined && typeof json?.error_code === 'string') code = json.error_code;
  const legacyReset = typeof json?.error_message === 'string' ? /reset in (\d+) seconds?/i.exec(json.error_message) : null;
  if (legacyReset) retryAfter ??= Number(legacyReset[1]);
  retryAfter ??= retryAfterSeconds(retryAfterHeader);
  return { httpStatus, code, retryAfterSeconds: retryAfter };
}

// Error responses are read defensively: the body may be empty or not JSON, and a Worker's unit
// tests may stand in a minimal object with no headers or text() for a Response.
function header(response: Response, name: string): string | null {
  return typeof response.headers?.get === 'function' ? response.headers.get(name) : null;
}

async function readErrorBody(response: Response): Promise<{ text: string; json?: GraphQLResponse<unknown> }> {
  let text = '';
  try {
    text = await response.text();
  } catch {
    return { text };
  }
  try {
    return { text, json: JSON.parse(text) as GraphQLResponse<unknown> };
  } catch {
    return { text };
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
  // Defaults to the global fetch, looked up per call: never pass a bare `fetch` reference to be
  // called as a method — the Workers runtime throws "Illegal invocation" when native fetch is
  // invoked with `this` set to anything but the global scope.
  fetchFn?: typeof fetch;
}

export interface RequestOptions {
  // false for mutations that create things: only failures that prove the request never ran are
  // retried; anything that might have committed throws AmbiguousWriteError.
  idempotent?: boolean;
}

// Yields the token to send. `rejected` is the token Monday just answered 401 to, so a broker can
// mint a fresh one instead of handing the same dead token back.
export type TokenProvider = (rejected?: string) => Promise<string>;

// The shape of a consumer Worker's MONDAY_AUTH service binding.
export interface MondayTokenSource {
  token(rejected?: string): Promise<string>;
}

// How long a provider reuses the binding's last answer instead of asking again. Each ask is a
// service-binding call plus a D1 read in monday-auth, and the transport asks before every request,
// so a paginated read would otherwise pay it per page. Far inside monday-auth's 10-minute refresh
// margin, so a reused token is never one about to expire.
const TOKEN_REUSE_MS = 60_000;

// The binding wins; the fixed MONDAY_API_TOKEN secret is the fallback during the OAuth cutover.
// An empty MONDAY_API_TOKEN counts as unset, so it fails here instead of sending an empty
// Authorization header.
export function tokenProviderFor(env: { MONDAY_AUTH?: MondayTokenSource; MONDAY_API_TOKEN?: string }): TokenProvider {
  const auth = env.MONDAY_AUTH;
  if (auth !== undefined) {
    // The resolved token, never the pending promise: a promise shared between requests would tie
    // one request's I/O to another's. A rejected token always goes back to the binding.
    let reused: { token: string; until: number } | undefined;
    return async (rejected) => {
      if (rejected === undefined && reused !== undefined && Date.now() < reused.until) return reused.token;
      const token = await auth.token(rejected);
      reused = { token, until: Date.now() + TOKEN_REUSE_MS };
      return token;
    };
  }
  const fixed = env.MONDAY_API_TOKEN;
  if (fixed !== undefined && fixed !== '') return async () => fixed;
  throw new Error('monday auth: neither the MONDAY_AUTH service binding nor MONDAY_API_TOKEN is set');
}

export class MondayGraphQL {
  // Plain fields, not constructor parameter properties: this file must stay loadable by Node's
  // strip-only TypeScript support, which a Worker's .mjs scripts rely on to import it directly.
  private readonly apiUrl: string;
  private readonly tokenFor: TokenProvider;
  // Only a provider can mint a different token after a 401; a fixed string would just fail again.
  private readonly refreshable: boolean;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly requestTimeoutMs: number;
  private readonly deadline: RetryBudget;
  private readonly apiVersion: string;
  private readonly fetchFn: typeof fetch;

  constructor(apiUrl: string, apiToken: string | TokenProvider, options: MondayGraphQLOptions = {}) {
    this.apiUrl = apiUrl;
    this.refreshable = typeof apiToken === 'function';
    this.tokenFor = typeof apiToken === 'function' ? apiToken : async () => apiToken;
    this.sleep = options.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxAttempts = options.maxAttempts ?? 5;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    this.deadline = options.deadline ?? UNBOUNDED;
    this.apiVersion = options.apiVersion ?? MONDAY_API_VERSION;
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
  }

  async request<T>(query: string, variables: Record<string, unknown>, { idempotent = true }: RequestOptions = {}): Promise<T> {
    let lastError = '';
    let lastDetails: MondayErrorDetails = {};
    const retryable = (detail: string, details: MondayErrorDetails): void => {
      lastError = detail;
      lastDetails = details;
    };
    // A failure that may have happened after Monday committed the request: fatal for a
    // non-idempotent write, otherwise retried like any other.
    const ambiguous = (detail: string, details: MondayErrorDetails): void => {
      if (!idempotent) throw new AmbiguousWriteError(`monday API: ${detail} (the write may have committed)`, details);
      retryable(detail, details);
    };

    // Set by a 401 on a refreshable token: the next pass re-runs the same attempt, with no wait and
    // no attempt spent, and the token Monday rejected is handed to the provider. Once per request.
    let rejectedToken: string | undefined;
    let reAsked = false;

    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      if (attempt > 0 && rejectedToken === undefined) {
        const backoffMs = 2 ** attempt * 1000 + Math.random() * 500;
        const advisedWaitMs = (lastDetails.retryAfterSeconds ?? 0) * 1000;
        const waitMs = Math.max(backoffMs, Math.min(advisedWaitMs, MAX_ADVISED_WAIT_MS));
        await this.deadline.sleepBeforeRetry(this.sleep, waitMs, `monday API (last error: ${lastError})`);
      }
      this.deadline.check(`monday API${lastError === '' ? '' : ` (last error: ${lastError})`}`);

      const token = rejectedToken === undefined ? await this.tokenFor() : await this.tokenFor(rejectedToken);
      rejectedToken = undefined;
      let response: Response;
      const timeoutMs = this.deadline.timeoutMs(this.requestTimeoutMs);
      try {
        response = await this.fetchFn(this.apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Monday expects the bare token, no "Bearer " prefix.
            Authorization: token,
            'API-Version': this.apiVersion,
          },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        // A timeout cut short by the deadline is the budget running out, not a network fault.
        this.deadline.check(`monday API (request cut off: ${String(err)})`);
        const timedOut = err instanceof Error && err.name === 'TimeoutError';
        ambiguous(timedOut ? `request timed out after ${timeoutMs}ms` : `network error: ${String(err)}`, {});
        continue;
      }

      if (!response.ok) {
        // Monday's 429s (and some 4xx/5xx) still carry a GraphQL error body with the code and
        // retry_in_seconds, so read it for the caller.
        const body = await readErrorBody(response);
        // `||`, not `??`: an empty errors array joins to '', which should still fall back. The raw
        // text only when the body wasn't JSON — a parsed body with no message (`{}`) adds nothing.
        const messages = body.json
          ? body.json.errors?.map((e) => e.message).join('; ') || body.json.error_message
          : body.text;
        const detail = `HTTP ${response.status}${messages ? `: ${messages}` : ''}`;
        const details = errorDetails(response.status, body.json, header(response, 'Retry-After'));
        if (response.status === 401 && this.refreshable && !reAsked) {
          reAsked = true;
          rejectedToken = token;
          attempt--;
          continue;
        }
        if (response.status === 429 && !DAILY_LIMIT_CODE.test(details.code ?? '')) {
          retryable(detail, details);
          continue;
        }
        if (response.status >= 500) {
          ambiguous(detail, details);
          continue;
        }
        throw new MondayApiError(`monday API: ${detail}`, details);
      }

      let json: GraphQLResponse<T>;
      try {
        json = (await response.json()) as GraphQLResponse<T>;
      } catch (err) {
        // A reset, timeout or truncation mid-body: Monday already ran the request, so for a write
        // this is exactly as ambiguous as a dropped connection (salesforce-import's client learned
        // this first — see its load/monday.ts send()).
        ambiguous(`unreadable response body: ${String(err)}`, { httpStatus: response.status });
        continue;
      }
      if (json.errors && json.errors.length > 0) {
        const detail = json.errors.map((e) => e.message).join('; ');
        // A single query over the per-query complexity cap fails identically every time; only
        // the per-minute budget (and rate/concurrency limits) recover with a wait. These are
        // rejected before execution, so they are safe to retry even for writes.
        const recoverable = json.errors.find((e) => {
          const code = codeOf(e) ?? '';
          return (
            !/exceeds max complexity/i.test(e.message) &&
            !DAILY_LIMIT_CODE.test(code) &&
            (RETRYABLE_CODE.test(code) || /complexity/i.test(e.message))
          );
        });
        if (recoverable === undefined) {
          throw new MondayApiError(`monday API: ${detail}`, errorDetails(response.status, json, null));
        }
        retryable(detail, errorDetails(response.status, json, null, [recoverable]));
        continue;
      }
      if (!json.data) {
        const detail =
          typeof json.error_message === 'string'
            ? `response contained no data — ${json.error_message}${json.status_code === undefined ? '' : ` (status_code ${json.status_code})`}`
            : `response contained no data — ${JSON.stringify(json)}`;
        const details = errorDetails(json.status_code ?? response.status, json, null);
        if (DAILY_LIMIT_CODE.test(details.code ?? '')) throw new MondayApiError(`monday API: ${detail}`, details);
        // Usually a rate limit, so retry; the exhausted-attempts error carries the detail.
        if (json.status_code === 429) retryable(detail, details);
        else ambiguous(detail, details);
        continue;
      }
      return json.data;
    }
    // With a single attempt (a caller that leaves retries to its queue) there was nothing to exhaust.
    const prefix = this.maxAttempts === 1 ? 'monday API: ' : `monday API: exhausted ${this.maxAttempts} attempts — last error: `;
    throw new MondayApiError(`${prefix}${lastError}`, lastDetails);
  }
}
