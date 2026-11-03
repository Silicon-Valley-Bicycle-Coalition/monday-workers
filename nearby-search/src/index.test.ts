import { describe, it, expect, vi } from 'vitest';
import { FakeD1 } from './testing';
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

  const dead = (contactId: string) => ({
    body: { boardId: 900, contactId, name: 'Secret Name', label: 'x', kind: 'person', stamp: {} },
    ack: vi.fn(),
    retry: vi.fn(),
  });

  it('releases a pending claim, leaves a done row, and acks a dead-letter batch', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = new FakeD1();
    db.resultRows.push(
      { board_id: '900', contact_id: 'p1', result_item_id: '', created_at: 't' },
      { board_id: '900', contact_id: 'p2', result_item_id: '5000', created_at: 't' },
    );
    const a = dead('p1');
    const b = dead('p2');
    await worker.queue({ queue: 'nearby-search-writes-dlq', messages: [a, b] } as unknown as MessageBatch<never>, { DB: db } as unknown as Env);
    expect(db.resultRows).toEqual([{ board_id: '900', contact_id: 'p2', result_item_id: '5000', created_at: 't' }]);
    expect(a.ack).toHaveBeenCalled();
    expect(b.ack).toHaveBeenCalled();
    expect(err.mock.calls.map(String).join('')).not.toContain('Secret Name');
    err.mockRestore();
  });

  it('retries a dead letter whose claim release fails', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = new FakeD1();
    db.failRelease = true;
    const m = dead('p1');
    await worker.queue({ queue: 'nearby-search-writes-sandbox-dlq', messages: [m] } as unknown as MessageBatch<never>, { DB: db } as unknown as Env);
    expect(m.ack).not.toHaveBeenCalled();
    expect(m.retry).toHaveBeenCalled();
    err.mockRestore();
  });
});
