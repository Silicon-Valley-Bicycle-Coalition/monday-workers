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
  it('creates an item', async () => {
    const fetchMock = mockFetchOnce({ data: { create_item: { id: '456' } } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');

    const item = await client.createItem(999, 'Acme Co', { text_col: 'Acme Co' });

    expect(item).toEqual({ id: '456' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.monday.com/v2');
    expect((init as Record<string, unknown>).headers).toBeDefined();
    expect(((init as Record<string, unknown>).headers as Record<string, unknown>).Authorization).toBe('token-123');
    const body = JSON.parse((init as Record<string, unknown>).body as string);
    expect(body.variables.itemName).toBe('Acme Co');
    expect(JSON.parse(body.variables.columnValues)).toEqual({ text_col: 'Acme Co' });
  });

  it('changes column values on an existing item', async () => {
    const fetchMock = mockFetchOnce({ data: { change_multiple_column_values: { id: '456' } } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');

    await client.changeColumnValues(999, '456', { text_col: 'Updated' });

    const body = JSON.parse(((fetchMock.mock.calls[0]![1] as Record<string, unknown>).body as string));
    expect(body.variables.itemId).toBe('456');
    expect(JSON.parse(body.variables.columnValues)).toEqual({ text_col: 'Updated' });
  });

  it('throws on a non-OK HTTP response', async () => {
    mockFetchOnce({}, false);
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');
    await expect(client.createItem(1, 'x', {})).rejects.toThrow(/HTTP 500/);
  });

  it('throws on a GraphQL errors array', async () => {
    mockFetchOnce({ errors: [{ message: 'Board not found' }] });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');
    await expect(client.createItem(1, 'x', {})).rejects.toThrow(/Board not found/);
  });
});
