import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1CodeFailureStore } from './codeFailures';

const SINCE = '2026-11-17T10:00:00.000Z';
const AT = '2026-11-18T09:00:00.000Z';

describe('D1CodeFailureStore', () => {
  it('grants exactly max slots when reservations race', async () => {
    const store = new D1CodeFailureStore(env.DB);
    const ids = await Promise.all(Array.from({ length: 15 }, () => store.reserveFailure('cf-race', AT, SINCE, 10)));
    expect(ids.filter((id) => id !== null)).toHaveLength(10);
    expect(new Set(ids.filter((id) => id !== null)).size).toBe(10);
  });

  it('counts only that address and only rows at or after the cutoff', async () => {
    const store = new D1CodeFailureStore(env.DB);
    await store.reserveFailure('cf-w', '2026-11-17T09:59:59.000Z', '2000-01-01T00:00:00.000Z', 10);
    await store.reserveFailure('cf-w', SINCE, '2000-01-01T00:00:00.000Z', 10);
    await store.reserveFailure('cf-other', AT, SINCE, 10);

    // In the window: only the row at SINCE counts, so a cap of 2 still grants one more, then refuses.
    expect(await store.reserveFailure('cf-w', AT, SINCE, 2)).not.toBeNull();
    expect(await store.reserveFailure('cf-w', AT, SINCE, 2)).toBeNull();
    // The other address has its own budget.
    expect(await store.reserveFailure('cf-other', AT, SINCE, 2)).not.toBeNull();
  });

  it('frees a slot when it is released', async () => {
    const store = new D1CodeFailureStore(env.DB);
    const id = await store.reserveFailure('cf-rel', AT, SINCE, 1);
    expect(id).not.toBeNull();
    expect(await store.reserveFailure('cf-rel', AT, SINCE, 1)).toBeNull();
    await store.releaseFailure(id!);
    expect(await store.reserveFailure('cf-rel', AT, SINCE, 1)).not.toBeNull();
  });
});
