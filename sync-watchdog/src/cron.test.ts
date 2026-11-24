import { describe, it, expect } from 'vitest';
import { cronMatcher, lastRuns } from './cron';

const d = (iso: string) => new Date(iso);

describe('cronMatcher', () => {
  it.each([
    ['*/10 * * * *', '2026-11-23T17:10:00Z', true],
    ['*/10 * * * *', '2026-11-23T17:11:00Z', false],
    ['5 * * * *', '2026-11-23T03:05:00Z', true],
    ['15 9 * * *', '2026-11-23T09:15:00Z', true],
    ['15 9 * * *', '2026-11-23T10:15:00Z', false],
    ['0,30 8-10 * * *', '2026-11-23T10:30:00Z', true],
    ['0,30 8-10 * * *', '2026-11-23T11:30:00Z', false],
    ['0 15 1 * *', '2026-12-01T15:00:00Z', true],
    ['0 15 1 * *', '2026-12-02T15:00:00Z', false],
    ['0 15 1 6 *', '2026-12-01T15:00:00Z', false],
  ])('%s at %s: %s', (cron, at, expected) => {
    expect(cronMatcher(cron)(d(at))).toBe(expected);
  });

  it('numbers weekdays as Cloudflare does: 1 is Sunday (member-map ran Sunday 2026-11-22)', () => {
    expect(cronMatcher('0 13 * * 1')(d('2026-11-22T13:00:00Z'))).toBe(true);
    expect(cronMatcher('0 13 * * 1')(d('2026-11-23T13:00:00Z'))).toBe(false);
    expect(cronMatcher('0 13 * * 2-6')(d('2026-11-23T13:00:00Z'))).toBe(true);
    expect(cronMatcher('0 13 * * 7')(d('2026-11-21T13:00:00Z'))).toBe(true);
  });

  it.each(['0 18 * * 6L', '59 23 LW * *', '0 9 * * MON', '0 9 * *', '60 * * * *', '0 24 * * *', '0 9 * * 0', '*/0 * * * *', '9-5 * * * *', '', '5, * * * *'])(
    'rejects %j',
    (cron) => {
      expect(() => cronMatcher(cron)).toThrow(/cron/);
    },
  );
});

describe('lastRuns', () => {
  const hourly = { cron: '0 * * * *', maxGapHours: 3 };
  const daily = { cron: '0 9 * * *', maxGapHours: 48 };
  const at = (iso: string, count = 1) => ({ at: d(iso), count });

  it('gives each cron its newest matching run', () => {
    const last = lastRuns([hourly, daily], [at('2026-11-23T10:00:00Z'), at('2026-11-23T09:00:00Z', 2), at('2026-11-22T09:00:00Z', 2)]);
    expect(last.get(hourly.cron)).toEqual(d('2026-11-23T10:00:00Z'));
    expect(last.get(daily.cron)).toEqual(d('2026-11-23T09:00:00Z'));
  });

  it('credits a shared minute with too few runs to the most frequent cron, whatever the config order', () => {
    const last = lastRuns([daily, hourly], [at('2026-11-23T09:00:00Z', 1)]);
    expect(last.get(hourly.cron)).toEqual(d('2026-11-23T09:00:00Z'));
    expect(last.has(daily.cron)).toBe(false);
  });

  it('adds up one occurrence recorded across two minutes', () => {
    const last = lastRuns([hourly, daily], [at('2026-11-23T09:01:00Z'), at('2026-11-23T09:00:00Z')]);
    expect(last.get(daily.cron)).toEqual(d('2026-11-23T09:00:00Z'));
  });

  it('accepts a start up to two minutes late (live: 14:21 for a 14:20 cron)', () => {
    const twenty = { cron: '20 * * * *', maxGapHours: 3 };
    expect(lastRuns([twenty], [at('2026-11-23T14:21:00Z')]).get(twenty.cron)).toEqual(d('2026-11-23T14:20:00Z'));
    expect(lastRuns([twenty], [at('2026-11-23T14:22:00Z')]).get(twenty.cron)).toEqual(d('2026-11-23T14:20:00Z'));
    expect(lastRuns([twenty], [at('2026-11-23T14:23:00Z')]).size).toBe(0);
    expect(lastRuns([twenty], [at('2026-11-23T14:19:00Z')]).size).toBe(0);
  });

  it('an exact match wins over a late one', () => {
    const a = { cron: '5 * * * *', maxGapHours: 3 };
    const b = { cron: '6 * * * *', maxGapHours: 3 };
    const last = lastRuns([a, b], [at('2026-11-23T14:06:00Z')]);
    expect([...last.keys()]).toEqual([b.cron]);
  });
});
