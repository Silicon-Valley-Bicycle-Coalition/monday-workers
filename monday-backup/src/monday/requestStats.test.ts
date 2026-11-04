import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequestStats } from './requestStats';

afterEach(() => vi.unstubAllGlobals());

describe('RequestStats', () => {
  it('counts requests, and a repeat of the same body as a retry, then resets on take()', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    const stats = new RequestStats();
    await stats.fetchFn('https://x', { method: 'POST', body: 'a' });
    await stats.fetchFn('https://x', { method: 'POST', body: 'a' });
    await stats.fetchFn('https://x', { method: 'POST', body: 'b' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(stats.take()).toEqual({ requests: 3, retries: 1 });
    expect(stats.take()).toEqual({ requests: 0, retries: 0 });
  });

  it('does not count the same body across a take() as a retry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')));
    const stats = new RequestStats();
    await stats.fetchFn('https://x', { method: 'POST', body: 'a' });
    stats.take();
    await stats.fetchFn('https://x', { method: 'POST', body: 'a' });
    expect(stats.take()).toEqual({ requests: 1, retries: 0 });
  });
});
