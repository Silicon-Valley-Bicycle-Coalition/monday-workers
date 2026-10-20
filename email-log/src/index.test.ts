import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import worker, { consumerFor, isDeadLetterBatch } from './index';
import type { LogQueueMessage } from './inbound/extract';
import type { Env } from './types';

describe('consumerFor', () => {
  it.each([
    ['email-log-writes', 'log'],
    ['email-log-writes-sandbox', 'log'],
    ['email-log-writes-dlq', 'dead-letter'],
    ['email-log-writes-sandbox-dlq', 'dead-letter'],
  ] as const)('routes %s to the %s consumer', (queue, kind) => {
    expect(consumerFor(queue)).toBe(kind);
    expect(isDeadLetterBatch(queue)).toBe(kind === 'dead-letter');
  });

  it('throws on any other queue name', () => {
    expect(() => consumerFor('email-log-writes-staging')).toThrow('no consumer for queue "email-log-writes-staging"');
    expect(isDeadLetterBatch('email-log-writes-staging')).toBe(false);
  });
});

describe('worker entry point', () => {
  it('exposes email and queue handlers', () => {
    expect(typeof worker.email).toBe('function');
    expect(typeof worker.queue).toBe('function');
  });

  it('rejects a batch from an unknown queue', async () => {
    const batch = { queue: 'some-other-queue', messages: [] } as unknown as MessageBatch<LogQueueMessage>;
    await expect(worker.queue(batch, env as unknown as Env)).rejects.toThrow('no consumer for queue "some-other-queue"');
  });
});
