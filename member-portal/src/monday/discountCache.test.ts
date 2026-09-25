import { describe, it, expect, vi } from 'vitest';
import { TtlCache, withCachedDiscounts } from './discountCache';
import type { MondayClient } from './client';

describe('TtlCache', () => {
  it('serves a fresh value without reloading, and reloads once the TTL has passed', async () => {
    let now = 1_000;
    const cache = new TtlCache<string>(60_000, () => now);
    const load = vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second');

    expect(await cache.get('k', load)).toBe('first');
    now += 59_999;
    expect(await cache.get('k', load)).toBe('first');
    now += 1;
    expect(await cache.get('k', load)).toBe('second');
    expect(load).toHaveBeenCalledTimes(2);
  });

  // A Monday blip must not pin an error (or an empty result standing in for one) for the TTL.
  it('does not cache a failed load', async () => {
    const cache = new TtlCache<string>(60_000, () => 0);
    const load = vi.fn().mockRejectedValueOnce(new Error('monday: HTTP 429')).mockResolvedValueOnce('ok');

    await expect(cache.get('k', load)).rejects.toThrow('HTTP 429');
    expect(await cache.get('k', load)).toBe('ok');
  });

  it('keeps separate keys separate', async () => {
    const cache = new TtlCache<string>(60_000, () => 0);
    expect(await cache.get('a', async () => 'A')).toBe('A');
    expect(await cache.get('b', async () => 'B')).toBe('B');
  });
});

describe('withCachedDiscounts', () => {
  function fakeClient(): MondayClient {
    return {
      getDiscountOrganizations: vi.fn().mockResolvedValue([{ name: 'Local Bikes', discountOffered: '10% off' }]),
      getDonorNames: vi.fn().mockResolvedValue([{ id: '1', name: 'Jane' }]),
    } as unknown as MondayClient;
  }

  it('routes getDiscountOrganizations through the cache and leaves every other method alone', async () => {
    const client = fakeClient();
    const cached = withCachedDiscounts(client, new TtlCache(60_000, () => 0), 'board-3');

    await cached.getDiscountOrganizations();
    await cached.getDiscountOrganizations();
    expect(client.getDiscountOrganizations).toHaveBeenCalledTimes(1);

    expect(await cached.getDonorNames(['1'])).toEqual([{ id: '1', name: 'Jane' }]);
    expect(client.getDonorNames).toHaveBeenCalledWith(['1']);
  });
});
