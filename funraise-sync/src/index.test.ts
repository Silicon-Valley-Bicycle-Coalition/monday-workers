import { env } from 'cloudflare:workers';
import { describe, it, expect, vi, afterEach } from 'vitest';
import worker, { isDeadLetterBatch } from './index';

describe('isDeadLetterBatch', () => {
  it('recognizes the production and sandbox dead-letter queues', () => {
    expect(isDeadLetterBatch('funraise-sync-writes-dlq')).toBe(true);
    expect(isDeadLetterBatch('funraise-sync-writes-sandbox-dlq')).toBe(true);
  });

  it('does not treat either write queue as dead letters', () => {
    expect(isDeadLetterBatch('funraise-sync-writes')).toBe(false);
    expect(isDeadLetterBatch('funraise-sync-writes-sandbox')).toBe(false);
  });
});

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

describe('Monday token from the monday-auth broker', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('builds its Monday client from the MONDAY_AUTH binding when bound', async () => {
    // An already-written, already-matched event: the consumer's first Monday call is the column
    // update, which is all this checks.
    await env.DB.prepare(
      `INSERT INTO events (event_id, entity_type, entity_id, raw_payload, status, received_at, matched_donor_item_id, monday_item_id)
       VALUES ('evt-broker', 'transaction', 'txn-broker', '{}', 'matched', '2026-10-30T00:00:00.000Z', '', '910101')`
    ).run();
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ data: { change_multiple_column_values: { id: '910101' } } }), { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    const auth = { token: vi.fn().mockResolvedValue('brokered') };
    const message = { body: { entityType: 'transaction', entityId: 'txn-broker' }, attempts: 1, ack: vi.fn(), retry: vi.fn() };

    await worker.queue(
      { queue: 'funraise-sync-writes-sandbox', messages: [message] } as unknown as MessageBatch<import('./consumer/processBatch').FunraiseQueueMessage>,
      { ...env, ENVIRONMENT: 'sandbox', MONDAY_API_TOKEN: undefined, MONDAY_AUTH: auth, FLAGS: { get: async () => 'on' } } as unknown as import('./types').Env
    );

    expect(auth.token).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('brokered');
  });
});

// GL#101: a verified delivery skips the per-IP limiter; anything else is still limited.
describe('rate limit exemption for verified webhooks', () => {
  const denyingEnv = () => ({
    ...env,
    FUNRAISE_WEBHOOK_SECRET: 's3cret',
    REQUEST_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: false }) },
  }) as unknown as import('./types').Env;
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

  it('passes a verified delivery through even when the limiter is exhausted', async () => {
    const testEnv = denyingEnv();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const response = await worker.fetch(new Request('https://x.example/webhooks/funraise/transaction?secret=s3cret', { method: 'POST', body: '{}' }), testEnv, ctx);
      expect(response.status).not.toBe(429);
      expect(testEnv.REQUEST_RATE_LIMITER.limit).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      warns.mockRestore();
    }
  });

  it('still limits a delivery with the wrong secret', async () => {
    const response = await worker.fetch(new Request('https://x.example/webhooks/funraise/transaction?secret=guess', { method: 'POST', body: '{}' }), denyingEnv(), ctx);
    expect(response.status).toBe(429);
  });
});
