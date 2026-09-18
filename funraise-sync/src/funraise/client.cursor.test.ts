import { describe, it, expect, vi } from 'vitest';
import { HttpFunraiseClient, MIN_QUERYABLE_UPDTIME_MS } from './client';

// Observed live 2026-09-18: `updtime >= 0`, `> 0` and `>= 1` all answer HTTP 500, while any
// value from 1000000000000 (2001-09-09) up answers 200. A fresh poll starts from cursor 0, so
// the client must floor the cursor or the very first run can never succeed.
describe('HttpFunraiseClient cursor floor', () => {
  function clientCapturing() {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    return { client: new HttpFunraiseClient('https://api.funraise.io', 'key', fetchImpl), fetchImpl };
  }

  it('floors a zero cursor to the earliest updtime Funraise will filter on', async () => {
    const { client, fetchImpl } = clientCapturing();
    await client.listSubscriptionsUpdatedSince(0, 0);
    const q = new URL((fetchImpl.mock.calls[0] as [string])[0]).searchParams.get('q');
    expect(q).toBe(`updtime >= ${MIN_QUERYABLE_UPDTIME_MS} order by updtime asc`);
    expect(MIN_QUERYABLE_UPDTIME_MS).toBe(1000000000000);
  });

  it('passes a real cursor through unchanged', async () => {
    const { client, fetchImpl } = clientCapturing();
    await client.listSubscriptionsUpdatedSince(1789000000000, 3);
    const q = new URL((fetchImpl.mock.calls[0] as [string])[0]).searchParams.get('q');
    expect(q).toBe('updtime >= 1789000000000 order by updtime asc');
  });
});
