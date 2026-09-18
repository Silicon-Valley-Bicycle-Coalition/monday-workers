import { describe, it, expect, vi } from 'vitest';
import { HttpFunraiseClient } from './client';

// Verified live against api.funraise.io on 2026-09-18: X-Api-Key auth, pages of 10 selected by
// `page`, and a `q` expression that filters and orders (spec 2026-09-18, "Context").
function fetchReturning(status: number, body: unknown) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  );
}

describe('HttpFunraiseClient', () => {
  it('lists subscriptions updated since a cursor, ordered by updtime, for a given page', async () => {
    const fetchImpl = fetchReturning(200, [{ id: 1, updtime: 5 }]);
    const client = new HttpFunraiseClient('https://api.funraise.io', 'key-1', fetchImpl);

    const rows = await client.listSubscriptionsUpdatedSince(1789000000000, 2);

    expect(rows).toEqual([{ id: 1, updtime: 5 }]);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://api.funraise.io/api/v1/crm/subscription');
    expect(parsed.searchParams.get('q')).toBe('updtime >= 1789000000000 order by updtime asc');
    expect(parsed.searchParams.get('page')).toBe('2');
    expect((init.headers as Record<string, string>)['X-Api-Key']).toBe('key-1');
  });

  it('fetches one subscription by id', async () => {
    const fetchImpl = fetchReturning(200, { id: 257753, status: 'Active' });
    const client = new HttpFunraiseClient('https://api.funraise.io', 'key-1', fetchImpl);

    const row = await client.getSubscription('257753');

    expect(row).toEqual({ id: 257753, status: 'Active' });
    expect((fetchImpl.mock.calls[0] as [string])[0]).toBe('https://api.funraise.io/api/v1/crm/subscription/257753');
  });

  it('returns null for a 404 on a single subscription, so a deleted one is not an error', async () => {
    const client = new HttpFunraiseClient('https://api.funraise.io', 'key-1', fetchReturning(404, { message: 'Not found' }));
    expect(await client.getSubscription('gone')).toBeNull();
  });

  it('throws with the status on any other non-2xx, so the cron retries next run', async () => {
    const client = new HttpFunraiseClient('https://api.funraise.io', 'key-1', fetchReturning(429, { message: 'slow down' }));
    await expect(client.listSubscriptionsUpdatedSince(0, 0)).rejects.toThrow(/429/);
  });

  it('throws when a list response is not an array, so a shape change is loud', async () => {
    const client = new HttpFunraiseClient('https://api.funraise.io', 'key-1', fetchReturning(200, { content: [] }));
    await expect(client.listSubscriptionsUpdatedSince(0, 0)).rejects.toThrow(/expected an array/);
  });
});
