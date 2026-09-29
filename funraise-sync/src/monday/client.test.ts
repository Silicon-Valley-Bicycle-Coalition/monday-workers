import { describe, it, expect, vi, afterEach } from 'vitest';
import { HttpMondayClient } from './client';
import { AmbiguousWriteError } from './graphql';

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
  it('finds an item by column value', async () => {
    const fetchMock = mockFetchOnce({
      data: { items_page_by_column_values: { items: [{ id: '123' }] } },
    });
    const client = newClient();

    const item = await client.findItemByColumnValue(999, 'email', 'a@example.com');

    expect(item).toEqual({ id: '123' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.monday.com/v2');
    expect(init.headers.Authorization).toBe('token-123');
    const body = JSON.parse(init.body as string);
    expect(body.variables).toEqual({
      boardId: 999,
      columns: [{ column_id: 'email', column_values: ['a@example.com'] }],
    });
  });

  it('returns null when no item matches', async () => {
    mockFetchOnce({ data: { items_page_by_column_values: { items: [] } } });
    const client = newClient();
    const result = await client.findItemByColumnValue(999, 'email', 'nobody@example.com');
    expect(result).toBeNull();
  });

  it('creates an item', async () => {
    const fetchMock = mockFetchOnce({ data: { create_item: { id: '456' } } });
    const client = newClient();

    const item = await client.createItem(999, 'Jane Donor', { email: 'jane@example.com' });

    expect(item).toEqual({ id: '456' });
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.variables.itemName).toBe('Jane Donor');
    expect(JSON.parse(body.variables.columnValues)).toEqual({ email: 'jane@example.com' });
  });

  it('changes column values on an existing item', async () => {
    const fetchMock = mockFetchOnce({ data: { change_multiple_column_values: { id: '456' } } });
    const client = newClient();

    await client.changeColumnValues(999, '456', { status: 'Done' });

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.variables.itemId).toBe('456');
  });

  it('throws on a non-OK HTTP response', async () => {
    mockFetchOnce({}, false);
    const client = newClient();
    await expect(client.findItemByColumnValue(1, 'x', 'y')).rejects.toThrow(/HTTP 500/);
  });

  it('throws on a GraphQL errors array', async () => {
    mockFetchOnce({ errors: [{ message: 'Board not found' }] });
    const client = newClient();
    await expect(client.findItemByColumnValue(1, 'x', 'y')).rejects.toThrow(/Board not found/);
  });
});

describe('HttpMondayClient dataless responses', () => {
  it("surfaces the server's error_message when a 200 response carries no data (rate limit shape)", async () => {
    mockFetchOnce({ error_message: 'Rate limit exceeded', status_code: 429 });
    const client = newClient();

    await expect(client.findItemByColumnValue(999, 'email', 'a@example.com')).rejects.toThrow(
      /Rate limit exceeded.*429/
    );
  });

  it('throws with the raw body when a 200 response has neither data nor error_message', async () => {
    mockFetchOnce({ unexpected: true });
    const client = newClient();

    await expect(client.createItem(1, 'x', {})).rejects.toThrow(/no data.*unexpected/);
  });
});

describe('HttpMondayClient transport (#35)', () => {
  it('pins API-Version 2026-01, the version these queries were written against', async () => {
    const fetchMock = mockFetchOnce({ data: { items_page_by_column_values: { items: [] } } });
    await newClient().findItemByColumnValue(1, 'x', 'y');
    expect(fetchMock.mock.calls[0]![1].headers['API-Version']).toBe('2026-01');
  });

  it('retries a 429 in-process and succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers: { 'Retry-After': '1' } }))
      .mockResolvedValueOnce(Response.json({ data: { items_page_by_column_values: { items: [{ id: '7' }] } } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(newClient().findItemByColumnValue(1, 'x', 'y')).resolves.toEqual({ id: '7' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after 3 attempts, leaving longer waits to the queue backoff', async () => {
    const fetchMock = vi.fn(async () => new Response('down', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(newClient().findItemByColumnValue(1, 'x', 'y')).rejects.toThrow(/exhausted 3 attempts — last error: HTTP 503/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('never retries a create that may have committed', async () => {
    const fetchMock = vi.fn(async () => new Response('oops', { status: 502 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(newClient().createItem(1, 'x', {})).rejects.toBeInstanceOf(AmbiguousWriteError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still retries a create rejected by the complexity budget (it never ran)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ errors: [{ message: 'Complexity budget exhausted', extensions: { code: 'COMPLEXITY_BUDGET_EXHAUSTED', retry_in_seconds: 1 } }] }))
      .mockResolvedValueOnce(Response.json({ data: { create_item: { id: '9' } } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(newClient().createItem(1, 'x', {})).resolves.toEqual({ id: '9' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
