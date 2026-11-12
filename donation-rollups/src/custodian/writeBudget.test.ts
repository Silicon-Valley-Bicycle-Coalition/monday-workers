import { describe, it, expect } from 'vitest';
import { WriteBudget } from './writeBudget';

describe('WriteBudget', () => {
  it('grants writes until it runs out, then refuses', () => {
    const b = new WriteBudget(2);
    expect([b.take(), b.take(), b.take()]).toEqual([true, true, false]);
    expect(b.remaining).toBe(0);
  });

  it('an unlimited budget always grants', () => {
    const b = WriteBudget.unlimited();
    for (let i = 0; i < 10_000; i++) expect(b.take()).toBe(true);
  });
});
