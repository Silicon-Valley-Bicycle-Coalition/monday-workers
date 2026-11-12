import { describe, it, expect, vi, afterEach } from 'vitest';
import { HttpMondayClient } from './client';

function stubPages(pages: { cursor: string | null; items: unknown[] }[]) {
  const fetchMock = vi.fn();
  for (const page of pages) {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { boards: [{ items_page: page }] } }) });
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const bodyOf = (fetchMock: ReturnType<typeof vi.fn>, call: number) =>
  JSON.parse((fetchMock.mock.calls[call]![1] as RequestInit).body as string) as { query: string; variables: Record<string, unknown> };

afterEach(() => vi.unstubAllGlobals());

describe('HttpMondayClient.pageItems', () => {
  const client = () => new HttpMondayClient('https://api.monday.com/v2', 'token', { sleepFn: async () => {} });

  it('pages the whole board when given no filter', async () => {
    const fetchMock = stubPages([{ cursor: null, items: [{ id: '1', column_values: [{ id: 'date_a', text: '2026-10-01' }] }] }]);
    const page = await client().pageItems(700, ['date_a'], null);
    expect(page.items.map((i) => i.id)).toEqual(['1']);
    expect(bodyOf(fetchMock, 0).variables.query).toBeNull();
  });

  it('sends an on-or-after date rule on the first page, and lets the cursor carry it after that (#101)', async () => {
    const fetchMock = stubPages([{ cursor: 'c1', items: [] }, { cursor: null, items: [] }]);
    const filter = { dateOnOrAfter: { columnId: 'date_a', dateISO: '2026-09-24' } };
    await client().pageItems(700, ['date_a'], null, filter);
    await client().pageItems(700, ['date_a'], 'c1', filter);

    const first = bodyOf(fetchMock, 0);
    expect(first.query).toContain('query_params: $query');
    expect(first.variables.query).toEqual({
      rules: [{ column_id: 'date_a', compare_value: ['EXACT', '2026-09-24'], operator: 'greater_than_or_equals' }],
    });
    // A cursor already encodes the query; Monday doesn't take both.
    expect(bodyOf(fetchMock, 1).variables).toMatchObject({ cursor: 'c1', query: null });
  });
});
