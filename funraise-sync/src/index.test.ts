import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import worker from './index';

describe('scaffold', () => {
  it('applies the events table migration', async () => {
    const result = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='events'"
    ).first();
    expect(result).not.toBeNull();
  });
});

describe('worker entry point', () => {
  it('exposes fetch and queue handlers', () => {
    expect(typeof worker.fetch).toBe('function');
    expect(typeof worker.queue).toBe('function');
  });
});

describe('scheduled payload purge', () => {
  it('empties raw_payload for written events past the retention window', async () => {
    await env.DB.prepare(
      `INSERT INTO events (event_id, entity_type, entity_id, raw_payload, status, received_at, written_at, monday_item_id)
       VALUES ('evt-purge', 'transaction', 'txn-purge', '{"pii":"x"}', 'written', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'item-1')`
    ).run();

    await worker.scheduled(
      { scheduledTime: Date.now(), cron: '0 9 * * *' } as ScheduledController,
      env as unknown as import('./types').Env
    );

    const row = await env.DB.prepare(`SELECT raw_payload FROM events WHERE event_id = 'evt-purge'`).first<{ raw_payload: string }>();
    expect(row?.raw_payload).toBe('{}');
  });
});
