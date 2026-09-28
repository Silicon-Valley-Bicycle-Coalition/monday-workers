// Parses an HTTP Retry-After header (RFC 9110 §10.2.3): either delay-seconds or an HTTP-date.
// Returns whole seconds from `nowMs` (never negative), or undefined when absent or unparseable —
// a malformed hint falls back to the consumer's ordinary backoff rather than failing the retry.
export function parseRetryAfter(value: string | null | undefined, nowMs: number = Date.now()): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  // An HTTP-date always names its month; without this, Date.parse('-5') reads as a year.
  if (!/[A-Za-z]/.test(trimmed)) return undefined;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - nowMs) / 1000));
}

// Test doubles cast partial objects to Response, so `headers` may be missing at runtime.
export function retryAfterHeader(response: Response): string | null {
  return response.headers?.get('Retry-After') ?? null;
}
