import { describe, it, expect } from 'vitest';
import { isD1QuotaError, secondsUntilMidnightUTC, MAX_QUEUE_DELAY_SECONDS } from './quota';

// D1's Free-tier daily limit errors (enforced since 2026-09-01) — the exact texts from
// developers.cloudflare.com/d1/observability/debug-d1/#error-list.
const WRITE_LIMIT = "D1_ERROR: Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.";
const READ_LIMIT = "Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue. See https://developers.cloudflare.com/d1/platform/limits/ for more details.";

describe('isD1QuotaError', () => {
  it('recognizes the daily row write and row read limit errors', () => {
    expect(isD1QuotaError(new Error(WRITE_LIMIT))).toBe(true);
    expect(isD1QuotaError(new Error(READ_LIMIT))).toBe(true);
    expect(isD1QuotaError(WRITE_LIMIT)).toBe(true); // D1 sometimes surfaces plain strings via cause chains
  });

  it('does not match other D1 or Monday errors', () => {
    expect(isD1QuotaError(new Error('D1_ERROR: no such column: archived'))).toBe(false);
    expect(isD1QuotaError(new Error('monday API: HTTP 500'))).toBe(false);
    expect(isD1QuotaError(new Error('Too many subrequests by single Worker invocation.'))).toBe(false);
    expect(isD1QuotaError(null)).toBe(false);
  });
});

describe('secondsUntilMidnightUTC', () => {
  it('counts whole seconds to the next midnight UTC', () => {
    // The minute the 09-03 flood stalled: 3h51m to go.
    expect(secondsUntilMidnightUTC(new Date('2026-09-03T20:09:00Z'))).toBe(3 * 3600 + 51 * 60);
  });

  it('clamps to the 12-hour queue maximum when midnight is further away', () => {
    // The minute the 09-09 flood stalled: 22h02m to go — Queues allows at most 43,200 s.
    expect(secondsUntilMidnightUTC(new Date('2026-09-09T01:58:00Z'))).toBe(MAX_QUEUE_DELAY_SECONDS);
    expect(MAX_QUEUE_DELAY_SECONDS).toBe(43_200);
  });

  it('never returns less than a minute right before midnight', () => {
    expect(secondsUntilMidnightUTC(new Date('2026-09-03T23:59:59.500Z'))).toBe(60);
  });
});
