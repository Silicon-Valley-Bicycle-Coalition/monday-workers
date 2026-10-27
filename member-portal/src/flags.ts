// CANONICAL COPY of the write-switch module. Every in-scope Worker carries a byte-identical
// src/flags.ts; edit it here (member-portal/src/flags.ts), then copy it over the others. The CI job
// `worker-flags-copies` (scripts/check-worker-flags.mjs) fails on drift.
//
// A Worker's write mode lives in the shared FLAGS KV namespace under `<worker>:writes`:
//   on   - write normally
//   hold - write nothing, and keep work queued (queue messages retry, crons skip)
//   off  - write nothing, log what would have been written (dry run)
// A missing or unrecognized value means `off`; a KV read error is `unknown`, which behaves like
// `hold`. `<worker>:log` set to `debug` adds redacted payloads to the skip lines.
//
// Must stay strip-only TypeScript (no enums, namespaces or constructor parameter properties): the
// CI job loads it through Node's built-in type stripping.

export type WriteMode = 'on' | 'hold' | 'off' | 'unknown';
export type LogLevel = 'debug' | 'normal';

export interface FlagsBindings {
  FLAGS?: KVNamespace;
}

// Edge-cached reads: a flip takes up to this long to reach a warm location.
const KV_OPTIONS = { cacheTtl: 30 };

export async function readWriteMode(env: FlagsBindings, worker: string): Promise<WriteMode> {
  if (!env.FLAGS) return 'unknown';
  try {
    const value = await env.FLAGS.get(`${worker}:writes`, KV_OPTIONS);
    if (value === 'on' || value === 'hold' || value === 'off') return value;
    return 'off';
  } catch {
    return 'unknown';
  }
}

export async function readLogLevel(env: FlagsBindings, worker: string): Promise<LogLevel> {
  if (!env.FLAGS) return 'normal';
  try {
    return (await env.FLAGS.get(`${worker}:log`, KV_OPTIONS)) === 'debug' ? 'debug' : 'normal';
  } catch {
    return 'normal';
  }
}

// A message enqueued while the mode was `off` carries this stamp, so it stays a dry run even if
// the mode is flipped to `on` before it is consumed. A message with no stamp (enqueued before the
// switch existed, or under `on`) is live.
export interface WriteStamp {
  writeStamp?: 'dropped';
}

export function stampFor(mode: WriteMode): WriteStamp {
  return mode === 'off' ? { writeStamp: 'dropped' } : {};
}

export type MessageDisposition = 'write' | 'dry-run' | 'retry';

export function messageDisposition(mode: WriteMode, body: WriteStamp): MessageDisposition {
  if (body.writeStamp === 'dropped') return 'dry-run';
  if (mode === 'on') return 'write';
  if (mode === 'off') return 'dry-run';
  return 'retry';
}

export type RunDisposition = 'run' | 'dry-run' | 'skip';

export function runDisposition(mode: WriteMode): RunDisposition {
  if (mode === 'on') return 'run';
  if (mode === 'off') return 'dry-run';
  return 'skip';
}

const MIN_RETRY_SECONDS = 60;
const MAX_BACKOFF_SECONDS = 3600;
// Cloudflare Queues rejects delaySeconds above 12 hours.
const MAX_HINTED_SECONDS = 43_200;

// min(60 * 2^(attempts-1), 3600), raised to a longer hint (Retry-After, midnight for a daily
// limit) but never past what Queues accepts.
export function retryDelaySeconds(attempts: number | undefined, hintSeconds?: number): number {
  const n = attempts !== undefined && Number.isFinite(attempts) && attempts >= 1 ? Math.floor(attempts) : 1;
  const backoff = Math.min(MIN_RETRY_SECONDS * 2 ** Math.min(n - 1, 20), MAX_BACKOFF_SECONDS);
  if (hintSeconds === undefined || !Number.isFinite(hintSeconds)) return backoff;
  return Math.min(Math.max(backoff, hintSeconds), MAX_HINTED_SECONDS);
}

// Key names (matched case-insensitively as substrings) whose values are masked in debug output.
export const DEFAULT_PII_KEYS: readonly string[] = ['name', 'email', 'phone', 'address', 'street', 'city', 'zip', 'postal'];
// Free-text fields: only their length is logged.
export const FREE_TEXT_KEYS: readonly string[] = ['body', 'text', 'html', 'message', 'description', 'note'];

// Same pattern as logSafe.ts's redactEmails.
const EMAIL_PATTERN = /[^\s"'<>()[\]{},;:]+@[^\s"'<>()[\]{},;:]+\.[a-z]{2,}/gi;

function keyMatches(key: string, needles: readonly string[]): boolean {
  const lower = key.toLowerCase();
  return needles.some((needle) => lower.includes(needle));
}

function redactValue(value: unknown, piiKeys: readonly string[], seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    // Monday column_values and similar arrive as JSON text: redact inside it, keyed.
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.stringify(redactValue(JSON.parse(trimmed), piiKeys, seen));
      } catch {
        // Not JSON after all; fall through to the plain scrub.
      }
    }
    return value.replace(EMAIL_PATTERN, '<email>');
  }
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '<cycle>';
  seen.add(value);
  let out: unknown;
  if (Array.isArray(value)) {
    out = value.map((item) => redactValue(item, piiKeys, seen));
  } else {
    const result: Record<string, unknown> = {};
    for (const [rawKey, child] of Object.entries(value)) {
      const key = rawKey.replace(EMAIL_PATTERN, '<email>');
      if (keyMatches(rawKey, piiKeys)) {
        result[key] = typeof child === 'string' ? `<masked:${child.length}>` : '<masked>';
      } else if (keyMatches(rawKey, FREE_TEXT_KEYS) && typeof child === 'string') {
        result[key] = `<text:${child.length}>`;
      } else {
        result[key] = redactValue(child, piiKeys, seen);
      }
    }
    out = result;
  }
  // Only a cycle (an ancestor) is a problem; a shared sibling reference is not.
  seen.delete(value);
  return out;
}

// A copy of `value` safe to log: PII-keyed values masked, free text reduced to its length, and
// email-shaped text elsewhere replaced. Never mutates its input.
export function redactPayload(value: unknown, piiKeys: readonly string[]): unknown {
  return redactValue(value, piiKeys, new WeakSet());
}

export interface SkipContext {
  worker: string;
  environment: string;
  mode: WriteMode;
  logLevel: LogLevel;
  deliveryId: string;
  piiKeys: readonly string[];
}

// One line per write that was not made. Normal level logs the operation and its argument count
// only; debug adds the redacted arguments.
export function logSkip(ctx: SkipContext, sink: string, operation: string, payload: unknown): void {
  const args = Array.isArray(payload) ? payload.length : payload === undefined ? 0 : 1;
  const line: Record<string, unknown> = {
    writeSwitch: 'skipped',
    worker: ctx.worker,
    environment: ctx.environment,
    mode: ctx.mode,
    deliveryId: ctx.deliveryId,
    sink,
    operation,
    args,
  };
  if (ctx.logLevel === 'debug') {
    // Positional string arguments carry no key to match on, so they are masked outright.
    const maskTop = (v: unknown): unknown => (typeof v === 'string' ? `<masked:${v.length}>` : redactPayload(v, ctx.piiKeys));
    line.payload = Array.isArray(payload) ? payload.map(maskTop) : maskTop(payload);
  }
  console.log(JSON.stringify(line));
}

export function logDebug(ctx: SkipContext, step: string, data?: unknown): void {
  if (ctx.logLevel !== 'debug') return;
  console.log(JSON.stringify({
    writeSwitch: 'debug',
    worker: ctx.worker,
    environment: ctx.environment,
    deliveryId: ctx.deliveryId,
    step,
    data: redactPayload(data, ctx.piiKeys),
  }));
}

type AnyFn = (...args: never[]) => unknown;

// Wraps a client so the listed methods record a skip line instead of writing. Each listed method
// resolves to its placeholder's result; a placeholder is called with `this` = { n }, the 1-based
// count of placeholder calls on this proxy, so it can mint ids like `dry-run-1`. A listed method
// with no placeholder resolves undefined. Every other member is forwarded to the target, bound.
// Debug output masks positional string arguments outright, so clients should take keyed objects
// for useful debug output.
export function recordingProxy<T extends object>(
  target: T,
  sink: string,
  placeholders: { [K in keyof T]?: T[K] extends (...a: infer A) => infer R ? (this: { n: number }, ...a: A) => Awaited<R> : never },
  ctx: SkipContext,
): T {
  let n = 0;
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(placeholders, prop)) {
        const placeholder = (placeholders as Record<string, AnyFn | undefined>)[prop];
        return async (...args: unknown[]) => {
          logSkip(ctx, sink, prop, args);
          n += 1;
          return placeholder ? placeholder.apply({ n }, args as never[]) : undefined;
        };
      }
      const value = Reflect.get(obj, prop, receiver);
      return typeof value === 'function' ? (value as AnyFn).bind(obj) : value;
    },
  });
}

// Wraps a client so the listed write methods are silently dropped (resolve undefined) while reads
// pass through. For callers that already log their own skip line.
export function readOnlyProxy<T extends object>(target: T, writes: readonly (keyof T)[]): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (writes.includes(prop as keyof T)) return async () => undefined;
      const value = Reflect.get(obj, prop, receiver);
      return typeof value === 'function' ? (value as AnyFn).bind(obj) : value;
    },
  });
}
