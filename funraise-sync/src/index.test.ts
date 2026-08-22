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
