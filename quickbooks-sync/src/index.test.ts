import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import worker from './index';

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
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: 'test' });
  });

  it('rejects /webhooks/monday without the shared secret', async () => {
    const request = new Request('http://localhost/webhooks/monday', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge: 'test' }),
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(401);
  });
});
