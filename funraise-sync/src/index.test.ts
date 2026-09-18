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

describe('environment selection', () => {
  // Both configs carry the same retention windows, so this cannot tell which file was selected
  // — src/environment.test.ts proves the selection. What it guards is that moving config
  // selection into the handler did not break the scheduled path under a sandbox env; the case
  // below proves the env var is actually read.
  it('scheduled purge still runs when ENVIRONMENT is "sandbox" (regression guard for the request-time config switch)', async () => {
    await env.DB.prepare(
      `INSERT INTO events (event_id, entity_type, entity_id, raw_payload, status, received_at, written_at, monday_item_id)
       VALUES ('evt-purge-sb', 'transaction', 'txn-purge-sb', '{"pii":"y"}', 'written', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'item-2')`
    ).run();

    await worker.scheduled(
      { scheduledTime: Date.now(), cron: '0 9 * * *' } as ScheduledController,
      { ...env, ENVIRONMENT: 'sandbox' } as unknown as import('./types').Env
    );

    const row = await env.DB.prepare(`SELECT raw_payload FROM events WHERE event_id = 'evt-purge-sb'`).first<{ raw_payload: string }>();
    expect(row?.raw_payload).toBe('{}');
  });

  it('refuses an unknown ENVIRONMENT value instead of guessing a config', async () => {
    await expect(
      worker.scheduled(
        { scheduledTime: Date.now(), cron: '0 9 * * *' } as ScheduledController,
        { ...env, ENVIRONMENT: 'staging' } as unknown as import('./types').Env
      )
    ).rejects.toThrow('ENVIRONMENT');
  });
});
