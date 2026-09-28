import { describe, it, expect } from 'vitest';
import { parseLoadOptions, isLegacySequential } from './options.js';

const cfg = { batchSize: 10, concurrency: 3, inlineLinks: true, recoveryLookupDelayMs: 2000 };

describe('parseLoadOptions', () => {
  it('takes config values when no flags are given', () => {
    expect(parseLoadOptions([], cfg)).toEqual({ batchSize: 10, concurrency: 3, inlineLinks: true,
      recoveryLookupDelayMs: 2000 });
  });

  it('falls back to built-in defaults when config has no load block', () => {
    expect(parseLoadOptions([], undefined)).toEqual({ batchSize: 10, concurrency: 3, inlineLinks: true,
      recoveryLookupDelayMs: 3000 });
  });

  it('lets flags override config', () => {
    expect(parseLoadOptions(['--batch-size', '25', '--concurrency', '2', '--no-inline-links'], cfg))
      .toMatchObject({ batchSize: 25, concurrency: 2, inlineLinks: false });
  });

  it('--sequential reproduces the pre-#22 path: one create per request, one at a time, links written separately', () => {
    const o = parseLoadOptions(['--sequential'], cfg);
    expect(o).toMatchObject({ batchSize: 1, concurrency: 1, inlineLinks: false });
    expect(isLegacySequential(o as Exclude<typeof o, string>)).toBe(true);
    expect(isLegacySequential(parseLoadOptions(['--batch-size', '1', '--concurrency', '1', '--no-inline-links'], cfg) as never)).toBe(true);
    expect(isLegacySequential(parseLoadOptions(['--batch-size', '1', '--concurrency', '1'], cfg) as never)).toBe(false);
  });

  it('rejects out-of-range or non-integer values with a message', () => {
    expect(parseLoadOptions(['--batch-size', '26'], cfg)).toMatch(/--batch-size/);
    expect(parseLoadOptions(['--batch-size', '0'], cfg)).toMatch(/--batch-size/);
    expect(parseLoadOptions(['--batch-size'], cfg)).toMatch(/--batch-size/);
    expect(parseLoadOptions(['--concurrency', '2.5'], cfg)).toMatch(/--concurrency/);
    expect(parseLoadOptions(['--concurrency', '9'], cfg)).toMatch(/--concurrency/);
    expect(parseLoadOptions([], { ...cfg, batchSize: 40 })).toMatch(/batchSize/);
  });
});
