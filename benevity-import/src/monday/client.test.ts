import { describe, it, expect, vi, afterEach } from 'vitest';
import { HttpMondayClient } from './client';
import { AmbiguousWriteError, MONDAY_API_VERSION } from './graphql';

// No real waits between the transport's retries.
function newClient() {
  return new HttpMondayClient('https://api.monday.com/v2', 'token-123', { sleepFn: async () => {} });
}

function mockFetchOnce(responseBody: unknown, ok = true) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => responseBody,
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HttpMondayClient', () => {
  it('finds items by column value', async () => {
    const fetchMock = mockFetchOnce({
      data: { items_page_by_column_values: { items: [{ id: '123', name: 'Jordan Rivera' }] } },
    });
    const client = newClient();

    const items = await client.findItemsByColumnValue(999, 'email', 'a@example.com');

    expect(items).toEqual([{ id: '123', name: 'Jordan Rivera' }]);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.variables).toEqual({
      boardId: 999,
      columns: [{ column_id: 'email', column_values: ['a@example.com'] }],
    });
  });

  it('archives an item by id', async () => {
    const fetchMock = mockFetchOnce({ data: { archive_item: { id: '321' } } });
    const client = newClient();

    await client.archiveItem('321');

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.query).toContain('archive_item(item_id: $itemId)');
    expect(body.variables).toEqual({ itemId: '321' });
  });

  it('returns an empty array when nothing matches', async () => {
    mockFetchOnce({ data: { items_page_by_column_values: { items: [] } } });
    const client = newClient();
    expect(await client.findItemsByColumnValue(999, 'email', 'nobody@example.com')).toEqual([]);
  });

  it('finds items by name using the "name" pseudo-column', async () => {
    const fetchMock = mockFetchOnce({
      data: { items_page_by_column_values: { items: [{ id: '456', name: 'Acme, Inc.' }] } },
    });
    const client = newClient();

    const items = await client.findItemsByName(999, 'Acme, Inc.');

    expect(items).toEqual([{ id: '456', name: 'Acme, Inc.' }]);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.variables.columns).toEqual([{ column_id: 'name', column_values: ['Acme, Inc.'] }]);
  });

  it('reads linked item ids from a board-relation column', async () => {
    mockFetchOnce({
      data: { items: [{ column_values: [{ linked_item_ids: ['111', '222'] }] }] },
    });
    const client = newClient();
    expect(await client.getLinkedItemIds(['789'], 'organization_link')).toEqual(['111', '222']);
  });

  it('returns an empty array when a board-relation column has no linked items', async () => {
    mockFetchOnce({ data: { items: [{ column_values: [{}] }] } });
    const client = newClient();
    expect(await client.getLinkedItemIds(['789'], 'organization_link')).toEqual([]);
  });

  it('reads the linked ids of several items in one request, flattened', async () => {
    const fetchMock = mockFetchOnce({
      data: { items: [{ column_values: [{ linked_item_ids: ['111'] }] }, { column_values: [{ linked_item_ids: ['222', '333'] }] }] },
    });
    const client = newClient();
    expect(await client.getLinkedItemIds(['a-1', 'a-2'], 'person_link')).toEqual(['111', '222', '333']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.variables).toEqual({ ids: ['a-1', 'a-2'], columnId: ['person_link'] });
    // Without an explicit limit items(ids:) returns at most 25.
    expect(body.query).toContain('limit: 100');
  });

  it('splits more than 100 item ids across requests, and makes none for an empty list', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const { variables } = JSON.parse(init.body as string) as { variables: { ids: string[] } };
      return { ok: true, status: 200, json: async () => ({ data: { items: variables.ids.map((id) => ({ column_values: [{ linked_item_ids: [`p-${id}`] }] })) } }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = newClient();
    const ids = Array.from({ length: 150 }, (_, i) => String(i));
    const linked = await client.getLinkedItemIds(ids, 'person_link');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(linked).toHaveLength(150);
    expect(await client.getLinkedItemIds([], 'person_link')).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('creates an item, optionally in a group', async () => {
    const fetchMock = mockFetchOnce({ data: { create_item: { id: '456', name: 'Jane - Donation' } } });
    const client = newClient();

    const item = await client.createItem(999, 'Jane - Donation', { amount: 50 }, 'review');

    expect(item).toEqual({ id: '456', name: 'Jane - Donation' });
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.variables.itemName).toBe('Jane - Donation');
    expect(body.variables.groupId).toBe('review');
    expect(JSON.parse(body.variables.columnValues)).toEqual({ amount: 50 });
  });

  it('changes column values on an existing item', async () => {
    const fetchMock = mockFetchOnce({ data: { change_multiple_column_values: { id: '456' } } });
    const client = newClient();
    await client.changeColumnValues(999, '456', { amount: 75 });
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(JSON.parse(body.variables.columnValues)).toEqual({ amount: 75 });
  });

  it('fetches an asset by id', async () => {
    mockFetchOnce({
      data: { assets: [{ id: 'a1', name: 'report.csv', public_url: 'https://files.monday.com/a1' }] },
    });
    const client = newClient();
    const asset = await client.fetchAsset('a1');
    expect(asset).toEqual({ id: 'a1', name: 'report.csv', publicUrl: 'https://files.monday.com/a1' });
  });

  it('throws when the requested asset is not found', async () => {
    mockFetchOnce({ data: { assets: [] } });
    const client = newClient();
    await expect(client.fetchAsset('missing')).rejects.toThrow(/not found/);
  });

  it("fetches an item's board and the asset ids in its file column", async () => {
    const fetchMock = mockFetchOnce({
      data: { items: [{ board: { id: '777' }, column_values: [{ files: [{ asset_id: 'a1' }, { asset_id: 2 }, {}] }] }] },
    });
    expect(await newClient().fetchItemAssets('5', 'file_col')).toEqual({ boardId: '777', assetIds: ['a1', '2'] });
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.variables).toEqual({ itemIds: ['5'], columnIds: ['file_col'] });
  });

  it('returns null for an item that does not exist', async () => {
    mockFetchOnce({ data: { items: [] } });
    expect(await newClient().fetchItemAssets('5', 'file_col')).toBeNull();
  });

  it('throws with the server message when the API returns GraphQL errors', async () => {
    mockFetchOnce({ errors: [{ message: 'Invalid board id' }] });
    const client = newClient();
    await expect(client.findItemsByColumnValue(999, 'email', 'x')).rejects.toThrow(/Invalid board id/);
  });
});

describe('HttpMondayClient transport (#35)', () => {
  it('sends the transport\'s single pinned API-Version (#39)', async () => {
    const fetchMock = mockFetchOnce({ data: { items_page_by_column_values: { items: [] } } });
    await newClient().findItemsByColumnValue(1, 'x', 'y');
    expect(fetchMock.mock.calls[0]![1].headers['API-Version']).toBe(MONDAY_API_VERSION);
  });

  it('retries a 429 in-process and succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers: { 'Retry-After': '1' } }))
      .mockResolvedValueOnce(Response.json({ data: { items_page_by_column_values: { items: [{ id: '7', name: 'A' }] } } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(newClient().findItemsByColumnValue(1, 'x', 'y')).resolves.toEqual([{ id: '7', name: 'A' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after 3 attempts, leaving longer waits to the queue backoff', async () => {
    const fetchMock = vi.fn(async () => new Response('down', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(newClient().findItemsByColumnValue(1, 'x', 'y')).rejects.toThrow(/exhausted 3 attempts — last error: HTTP 503/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('never retries a create that may have committed', async () => {
    const fetchMock = vi.fn(async () => new Response('oops', { status: 502 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(newClient().createItem(1, 'x', {})).rejects.toBeInstanceOf(AmbiguousWriteError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
