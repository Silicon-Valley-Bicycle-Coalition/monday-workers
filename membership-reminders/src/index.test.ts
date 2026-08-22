import { describe, it, expect } from 'vitest';
import worker from './index';

describe('GET /health', () => {
  it('returns ok', async () => {
    const res = await worker.fetch(new Request('http://worker/health'), {} as never, {} as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
