import { describe, it, expect } from 'vitest';
import { parseLoadOptions, isLegacySequential, describeMode } from './options.js';
import { loadConfig } from '../config.js';

const cfg = { batchSize: 10, concurrency: 3, inlineLinks: true, recoveryLookupDelayMs: 2000 };

describe('parseLoadOptions', () => {
  it('takes config values when no flags are given', () => {
    expect(parseLoadOptions([], cfg)).toEqual({ batchSize: 10, concurrency: 3, inlineLinks: true,
      recoveryLookupDelayMs: 2000 });
  });

  it('defaults to the pre-#22 sequential path when config has no load block', () => {
    const o = parseLoadOptions([], undefined);
    expect(o).toEqual({ batchSize: 1, concurrency: 1, inlineLinks: false, recoveryLookupDelayMs: 3000 });
    expect(isLegacySequential(o as never)).toBe(true);
    expect(describeMode(o as never)).toBe('load: mode = sequential (default)');
  });

  it('the shipped config keeps the default sequential', () => {
    const shipped = loadConfig(new URL('../../config/svbc.json', import.meta.url).pathname).load;
    const o = parseLoadOptions([], shipped);
    expect(isLegacySequential(o as never)).toBe(true);
  });

  it('--batched opts in to the recommended settings (10 per request, 3 in flight, inline links)', () => {
    const o = parseLoadOptions(['--batched'], undefined);
    expect(o).toMatchObject({ batchSize: 10, concurrency: 3, inlineLinks: true });
    expect(describeMode(o as never)).toBe('load: mode = batched (size 10, concurrency 3, inline links on)');
  });

  it('size/concurrency/inline flags work on top of --batched and on their own', () => {
    expect(parseLoadOptions(['--batched', '--batch-size', '25', '--no-inline-links'], undefined))
      .toMatchObject({ batchSize: 25, concurrency: 3, inlineLinks: false });
    const alone = parseLoadOptions(['--concurrency', '2'], undefined);
    expect(alone).toMatchObject({ batchSize: 1, concurrency: 2, inlineLinks: false });
    expect(describeMode(alone as never)).toBe('load: mode = batched (size 1, concurrency 2, inline links off)');
    expect(isLegacySequential(parseLoadOptions(['--no-inline-links'], undefined) as never)).toBe(true);
  });

  it('--sequential equals the default, and cannot be combined with --batched', () => {
    expect(parseLoadOptions(['--sequential'], undefined)).toEqual(parseLoadOptions([], undefined));
    expect(parseLoadOptions(['--batched', '--sequential'], undefined)).toMatch(/mutually exclusive/);
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

  it('rejects a mistyped inlineLinks or recoveryLookupDelayMs in config', () => {
    expect(parseLoadOptions([], { ...cfg, inlineLinks: 'false' as unknown as boolean })).toMatch(/inlineLinks/);
    expect(parseLoadOptions([], { ...cfg, recoveryLookupDelayMs: -1 })).toMatch(/recoveryLookupDelayMs/);
    expect(parseLoadOptions([], { ...cfg, recoveryLookupDelayMs: '3000' as unknown as number })).toMatch(/recoveryLookupDelayMs/);
    expect(parseLoadOptions([], { ...cfg, recoveryLookupDelayMs: Infinity })).toMatch(/recoveryLookupDelayMs/);
    expect(parseLoadOptions([], { ...cfg, recoveryLookupDelayMs: 0 })).toMatchObject({ recoveryLookupDelayMs: 0 });
  });
});
