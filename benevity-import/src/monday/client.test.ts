import { describe, it, expect, vi, afterEach } from 'vitest';
import { HttpMondayClient } from './client';

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
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');

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
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');

    await client.archiveItem('321');

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.query).toContain('archive_item(item_id: $itemId)');
    expect(body.variables).toEqual({ itemId: '321' });
  });

  it('returns an empty array when nothing matches', async () => {
    mockFetchOnce({ data: { items_page_by_column_values: { items: [] } } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');
    expect(await client.findItemsByColumnValue(999, 'email', 'nobody@example.com')).toEqual([]);
  });

  it('finds items by name using the "name" pseudo-column', async () => {
    const fetchMock = mockFetchOnce({
      data: { items_page_by_column_values: { items: [{ id: '456', name: 'Acme, Inc.' }] } },
    });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');

    const items = await client.findItemsByName(999, 'Acme, Inc.');

    expect(items).toEqual([{ id: '456', name: 'Acme, Inc.' }]);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.variables.columns).toEqual([{ column_id: 'name', column_values: ['Acme, Inc.'] }]);
  });

  it('reads linked item ids from a board-relation column', async () => {
    mockFetchOnce({
      data: { items: [{ column_values: [{ linked_item_ids: ['111', '222'] }] }] },
    });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');
    expect(await client.getLinkedItemIds('789', 'organization_link')).toEqual(['111', '222']);
  });

  it('returns an empty array when a board-relation column has no linked items', async () => {
    mockFetchOnce({ data: { items: [{ column_values: [{}] }] } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');
    expect(await client.getLinkedItemIds('789', 'organization_link')).toEqual([]);
  });

  it('creates an item, optionally in a group', async () => {
    const fetchMock = mockFetchOnce({ data: { create_item: { id: '456', name: 'Jane - Donation' } } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');

    const item = await client.createItem(999, 'Jane - Donation', { amount: 50 }, 'review');

    expect(item).toEqual({ id: '456', name: 'Jane - Donation' });
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.variables.itemName).toBe('Jane - Donation');
    expect(body.variables.groupId).toBe('review');
    expect(JSON.parse(body.variables.columnValues)).toEqual({ amount: 50 });
  });

  it('changes column values on an existing item', async () => {
    const fetchMock = mockFetchOnce({ data: { change_multiple_column_values: { id: '456' } } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');
    await client.changeColumnValues(999, '456', { amount: 75 });
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(JSON.parse(body.variables.columnValues)).toEqual({ amount: 75 });
  });

  it('fetches an asset by id', async () => {
    mockFetchOnce({
      data: { assets: [{ id: 'a1', name: 'report.csv', public_url: 'https://files.monday.com/a1' }] },
    });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');
    const asset = await client.fetchAsset('a1');
    expect(asset).toEqual({ id: 'a1', name: 'report.csv', publicUrl: 'https://files.monday.com/a1' });
  });

  it('throws when the requested asset is not found', async () => {
    mockFetchOnce({ data: { assets: [] } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');
    await expect(client.fetchAsset('missing')).rejects.toThrow(/not found/);
  });

  it('throws with the server message when the API returns GraphQL errors', async () => {
    mockFetchOnce({ errors: [{ message: 'Invalid board id' }] });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');
    await expect(client.findItemsByColumnValue(999, 'email', 'x')).rejects.toThrow(/Invalid board id/);
  });
});
