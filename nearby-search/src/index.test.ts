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
