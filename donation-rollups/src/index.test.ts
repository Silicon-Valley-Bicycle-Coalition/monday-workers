import { describe, it, expect } from 'vitest';
import worker, { isDeadLetterBatch } from './index';

describe('worker entry point', () => {
  it('exposes fetch, queue and scheduled handlers', () => {
    expect(typeof worker.fetch).toBe('function');
    expect(typeof worker.queue).toBe('function');
    expect(typeof worker.scheduled).toBe('function');
  });
});

describe('isDeadLetterBatch', () => {
  it('recognizes the production dead-letter queue', () => {
    expect(isDeadLetterBatch('donation-rollups-recompute-dlq')).toBe(true);
  });

  it('recognizes the sandbox dead-letter queue', () => {
    expect(isDeadLetterBatch('donation-rollups-recompute-sandbox-dlq')).toBe(true);
  });

  it('does not treat either recompute queue as dead letters', () => {
    expect(isDeadLetterBatch('donation-rollups-recompute')).toBe(false);
    expect(isDeadLetterBatch('donation-rollups-recompute-sandbox')).toBe(false);
  });
});
