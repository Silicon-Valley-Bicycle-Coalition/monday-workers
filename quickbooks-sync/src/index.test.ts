import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, it, expect, vi, afterEach } from 'vitest';
import worker from './index';

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

describe('scaffold', () => {
  it('applies all four table migrations', async () => {
    for (const table of ['qb_oauth_tokens', 'qb_monday_map', 'qb_events', 'monday_events']) {
      const result = await env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?1"
      )
        .bind(table)
        .first();
      expect(result, `expected table "${table}" to exist`).not.toBeNull();
    }
  });
});

describe('worker entry point', () => {
  it('exposes fetch and queue handlers', () => {
    expect(typeof worker.fetch).toBe('function');
    expect(typeof worker.queue).toBe('function');
  });

  // #68: the purge is a D1 retention pass, not a Monday or QuickBooks write, so it runs with the
  // write switch off (FLAGS is empty in tests, which reads as `off`).
  it('scheduled purges an expired payload using the shipped retention config', async () => {
    const longAgo = '2020-01-01T00:00:00.000Z';
    await env.DB.prepare(
      `INSERT INTO monday_events (event_id, monday_item_id, raw_payload, status, received_at, written_at)
       VALUES ('sched-1', 'sched-1', '{"email":"pat@example.org"}', 'written', ?1, ?1)`
    )
      .bind(longAgo)
      .run();

    await worker.scheduled({} as ScheduledController, env as unknown as import('./types').Env);

    const row = await env.DB.prepare("SELECT raw_payload FROM monday_events WHERE event_id = 'sched-1'").first<{ raw_payload: string }>();
    expect(row!.raw_payload).toBe('{}');
  });

  it('routes /webhooks/monday through the composed app (challenge handshake)', async () => {
    // MONDAY_WEBHOOK_SECRET comes from vitest.config.ts's miniflare bindings.
    const request = new Request('http://localhost/webhooks/monday?secret=test-monday-webhook-secret', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge: 'test' }),
    });
    const requestCtx = createExecutionContext();
    const response = await worker.fetch(request, env as unknown as import('./types').Env, requestCtx);
    await waitOnExecutionContext(requestCtx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: 'test' });
  });

  it('rejects /webhooks/monday without the shared secret', async () => {
    const request = new Request('http://localhost/webhooks/monday', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge: 'test' }),
    });
    const requestCtx = createExecutionContext();
    const response = await worker.fetch(request, env as unknown as import('./types').Env, requestCtx);
    await waitOnExecutionContext(requestCtx);

    expect(response.status).toBe(401);
  });

  it('refuses an unknown ENVIRONMENT value before routing anything', () => {
    // fetch is synchronous up to the config lookup, so the refusal is a synchronous throw — which
    // the Workers runtime turns into a 500 before any route runs.
    expect(() =>
      worker.fetch(new Request('https://worker.example/health'), { ...env, ENVIRONMENT: 'staging' } as unknown as import('./types').Env, ctx)
    ).toThrow('ENVIRONMENT');
  });
});

describe('Monday token from the monday-auth broker', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('builds its Monday client from the MONDAY_AUTH binding when bound', async () => {
    // A Monday -> QuickBooks create with no QuickBooks id yet: the consumer's first call is the
    // Monday item re-read, which is all this checks ("not found" then fails it terminally).
    await env.DB.prepare(
      `INSERT INTO monday_events (event_id, monday_item_id, raw_payload, status, received_at)
       VALUES ('evt-broker', '910101', '{}', 'received', '2026-10-30T00:00:00.000Z')`
    ).run();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ data: { items: [] } }), { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    const auth = { token: vi.fn().mockResolvedValue('brokered') };
    const message = { body: { direction: 'monday-to-qb', eventId: 'evt-broker' }, attempts: 1, ack: vi.fn(), retry: vi.fn() };

    await worker.queue(
      { queue: 'quickbooks-sync-writes-sandbox', messages: [message] } as unknown as MessageBatch<import('./types').QueueMessage>,
      { ...env, ENVIRONMENT: 'sandbox', MONDAY_API_TOKEN: undefined, MONDAY_AUTH: auth, FLAGS: { get: async () => 'on' } } as unknown as import('./types').Env
    );

    expect(auth.token).toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('brokered');
  });
});
