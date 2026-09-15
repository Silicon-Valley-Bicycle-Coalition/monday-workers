import { describe, it, expect } from 'vitest';
import worker from './index';

describe('worker entry point', () => {
  it('exports fetch, queue, and scheduled handlers', () => {
    expect(typeof worker.fetch).toBe('function');
    expect(typeof worker.queue).toBe('function');
    expect(typeof worker.scheduled).toBe('function');
  });

  it('loads and validates config/svbc.json at import time without throwing', async () => {
    // If validateConfig(rawConfig) threw, importing this module (done at the top of this file)
    // would already have failed the whole test file — this just documents the intent.
    expect(worker).toBeDefined();
  });
});
