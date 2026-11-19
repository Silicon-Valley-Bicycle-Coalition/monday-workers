import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1CodeFailureStore } from './codeFailures';

describe('D1CodeFailureStore', () => {
  it('counts only that address and only rows at or after the cutoff', async () => {
    const store = new D1CodeFailureStore(env.DB);
    await store.recordFailure('cf-a', '2026-11-17T09:59:59.000Z');
    await store.recordFailure('cf-a', '2026-11-17T10:00:00.000Z');
    await store.recordFailure('cf-a', '2026-11-18T09:00:00.000Z');
    await store.recordFailure('cf-b', '2026-11-18T09:00:00.000Z');

    expect(await store.countSince('cf-a', '2026-11-17T10:00:00.000Z')).toBe(2);
    expect(await store.countSince('cf-b', '2026-11-17T10:00:00.000Z')).toBe(1);
    expect(await store.countSince('cf-none', '2026-11-17T10:00:00.000Z')).toBe(0);
  });
});
