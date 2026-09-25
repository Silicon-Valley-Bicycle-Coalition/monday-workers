import { describe, expect, it } from 'vitest';
import { BudgetExhaustedError, Deadline } from './deadline';

describe('Deadline', () => {
  it('is unbounded by default', async () => {
    const d = new Deadline();
    expect(d.remainingMs()).toBe(Number.POSITIVE_INFINITY);
    expect(d.timeoutMs(60_000)).toBe(60_000);
    expect(() => d.check('x')).not.toThrow();
  });

  it('caps timeouts to the time remaining', () => {
    let t = 0;
    const d = new Deadline(10_000, () => t);
    expect(d.timeoutMs(60_000)).toBe(10_000);
    t = 9_990;
    expect(d.timeoutMs(60_000)).toBe(10);
  });

  it('throws a distinguishable error once the deadline has passed', () => {
    const d = new Deadline(10_000, () => 10_000);
    expect(() => d.check('monday API')).toThrow(BudgetExhaustedError);
    expect(() => d.check('monday API')).toThrow(/wall-time budget exhausted — gave up on monday API/);
  });

  it('refuses a retry wait that would cross the deadline, without sleeping', async () => {
    const slept: number[] = [];
    const d = new Deadline(10_000, () => 5_000);
    await d.sleepBeforeRetry(async (ms) => void slept.push(ms), 4_000, 'x');
    await expect(d.sleepBeforeRetry(async (ms) => void slept.push(ms), 5_000, 'x')).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(slept).toEqual([4_000]);
  });
});
