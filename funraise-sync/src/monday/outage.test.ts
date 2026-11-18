import { describe, it, expect, vi } from 'vitest';
import { AmbiguousWriteError, MondayApiError } from './graphql';
import { isMondayOutage, outageHintSeconds, OutageBreaker } from './outage';

// The canonical outage breaker's tests (GL#101). The copies in other Workers are checked
// byte-identical by CI rather than re-tested.
describe('isMondayOutage', () => {
  it.each([
    ['HTTP 429', new MondayApiError('x', { httpStatus: 429 })],
    ['HTTP 500', new MondayApiError('x', { httpStatus: 500 })],
    ['HTTP 503', new MondayApiError('x', { httpStatus: 503 })],
    ['a network error or timeout (no status)', new MondayApiError('x', {})],
    ['an ambiguous write on a 502', new AmbiguousWriteError('x', { httpStatus: 502 })],
    ['an ambiguous write on a timeout', new AmbiguousWriteError('x', {})],
    ['an exhausted complexity budget', new MondayApiError('x', { httpStatus: 200, code: 'COMPLEXITY_BUDGET_EXHAUSTED' })],
    ['the daily call limit', new MondayApiError('x', { httpStatus: 200, code: 'DAILY_LIMIT_EXCEEDED' })],
    ['a concurrency limit', new MondayApiError('x', { httpStatus: 200, code: 'maxConcurrencyExceeded' })],
    ['a wrapped transport error', new Error('wrapped', { cause: new MondayApiError('x', { httpStatus: 503 }) })],
  ])('is an outage: %s', (_label, err) => {
    expect(isMondayOutage(err)).toBe(true);
  });

  it.each([
    ['a rejected column value', new MondayApiError('x', { httpStatus: 200, code: 'ColumnValueException' })],
    ['HTTP 400', new MondayApiError('x', { httpStatus: 400 })],
    ['HTTP 401 (a token problem, retried per message)', new MondayApiError('x', { httpStatus: 401 })],
    ['an unreadable body on HTTP 200', new AmbiguousWriteError('x', { httpStatus: 200 })],
    ['a plain Error that only mentions 503', new Error('monday API: HTTP 503')],
    ['a non-error', 'HTTP 503'],
  ])('is not an outage: %s', (_label, err) => {
    expect(isMondayOutage(err)).toBe(false);
  });
});

describe('outageHintSeconds', () => {
  it("uses Monday's hint, rounded up", () => {
    expect(outageHintSeconds(new MondayApiError('x', { httpStatus: 429, retryAfterSeconds: 29.2 }))).toBe(30);
  });

  it('defers a daily limit with no hint to midnight UTC', () => {
    const now = new Date('2026-11-12T23:00:00Z');
    expect(outageHintSeconds(new MondayApiError('x', { httpStatus: 200, code: 'DAILY_LIMIT_EXCEEDED' }), now)).toBe(3600);
  });

  it('has none for a bare 5xx', () => {
    expect(outageHintSeconds(new MondayApiError('x', { httpStatus: 503 }))).toBeUndefined();
  });
});

describe('OutageBreaker', () => {
  const message = (attempts?: number) => ({ attempts, retry: vi.fn() });

  it('starts closed and ignores a per-message failure', () => {
    const breaker = new OutageBreaker();
    expect(breaker.trip(new MondayApiError('x', { httpStatus: 400 }))).toBe(false);
    expect(breaker.open).toBe(false);
  });

  it('opens on an outage and defers with the shared backoff for each message’s own attempt', () => {
    const breaker = new OutageBreaker();
    expect(breaker.trip(new MondayApiError('x', { httpStatus: 503 }))).toBe(true);
    expect(breaker.open).toBe(true);
    const first = message(1);
    const fourth = message(4);
    breaker.defer(first);
    breaker.defer(fourth);
    expect(first.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(fourth.retry).toHaveBeenCalledWith({ delaySeconds: 480 });
  });

  it("raises every deferral to Monday's hint, keeping the longest one seen", () => {
    const breaker = new OutageBreaker();
    breaker.trip(new MondayApiError('x', { httpStatus: 429, retryAfterSeconds: 300 }));
    breaker.trip(new MondayApiError('x', { httpStatus: 429, retryAfterSeconds: 90 }));
    expect(breaker.delaySeconds(1)).toBe(300);
    expect(breaker.delaySeconds(7)).toBe(3600);
  });

  it('defers a daily limit to midnight UTC', () => {
    const breaker = new OutageBreaker(() => new Date('2026-11-12T22:00:00Z'));
    breaker.trip(new MondayApiError('x', { httpStatus: 200, code: 'DAILY_LIMIT_EXCEEDED' }));
    expect(breaker.delaySeconds(1)).toBe(7200);
  });
});
