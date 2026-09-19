import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
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

  it('routes /webhooks/monday through the composed app (challenge handshake)', async () => {
    // MONDAY_WEBHOOK_SECRET comes from vitest.config.ts's miniflare bindings.
    const request = new Request('http://localhost/webhooks/monday?secret=test-monday-webhook-secret', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge: 'test' }),
    });
    const requestCtx = createExecutionContext();
    const response = await worker.fetch(request, env, requestCtx);
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
    const response = await worker.fetch(request, env, requestCtx);
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
