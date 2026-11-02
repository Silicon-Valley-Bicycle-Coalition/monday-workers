import { describe, it, expect } from 'vitest';
import worker from './index';
import type { Env } from './types';

describe('GET /health', () => {
  it('returns 200 ok without an Access header', async () => {
    const res = await worker.fetch(new Request('https://nearby.example/health'), {} as Env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });
});

describe('queue', () => {
  it('recognizes both dead-letter queue names from wrangler.jsonc', async () => {
    const { isDeadLetterBatch } = await import('./index');
    expect(isDeadLetterBatch('nearby-search-writes-dlq')).toBe(true);
    expect(isDeadLetterBatch('nearby-search-writes-sandbox-dlq')).toBe(true);
    expect(isDeadLetterBatch('nearby-search-writes')).toBe(false);
  });

  it('acks a dead-letter batch without reading the write switch', async () => {
    const { vi } = await import('vitest');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const msg = { body: { boardId: 900, contactId: 'p1', name: 'Secret Name', label: 'x', kind: 'person', stamp: {} }, ack: vi.fn(), retry: vi.fn() };
    await worker.queue({ queue: 'nearby-search-writes-dlq', messages: [msg] } as unknown as MessageBatch<never>, {} as Env);
    expect(msg.ack).toHaveBeenCalled();
    expect(err.mock.calls.map(String).join('')).not.toContain('Secret Name');
    err.mockRestore();
  });
});
