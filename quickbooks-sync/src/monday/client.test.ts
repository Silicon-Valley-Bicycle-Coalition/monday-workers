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
  it('creates an item', async () => {
    const fetchMock = mockFetchOnce({ data: { create_item: { id: '456' } } });
    const client = newClient();

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
    const client = newClient();

    await client.changeColumnValues(999, '456', { text_col: 'Updated' });

    const body = JSON.parse(((fetchMock.mock.calls[0]![1] as Record<string, unknown>).body as string));
    expect(body.variables.itemId).toBe('456');
    expect(JSON.parse(body.variables.columnValues)).toEqual({ text_col: 'Updated' });
  });

  it('reads an item: its name and each column’s text and raw value', async () => {
    const fetchMock = mockFetchOnce({
      data: {
        items: [
          {
            id: '456',
            name: 'Acme Co',
            state: 'active',
            board: { id: '789' },
            column_values: [
              { id: 'email_col', text: 'ap@acme.test', value: '{"email":"ap@acme.test","text":"AP"}' },
              { id: 'qb_id_col', text: '', value: null },
            ],
          },
        ],
      },
    });
    const client = newClient();

    const item = await client.getItem('456');

    expect(item).toEqual({
      id: '456',
      name: 'Acme Co',
      state: 'active',
      boardId: '789',
      columnValues: {
        email_col: { text: 'ap@acme.test', value: '{"email":"ap@acme.test","text":"AP"}' },
        qb_id_col: { text: '', value: null },
      },
    });
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as Record<string, unknown>).body as string);
    expect(body.variables).toEqual({ ids: ['456'] });
  });

  it('finds item ids on a board by an exact column value', async () => {
    const fetchMock = mockFetchOnce({ data: { items_page_by_column_values: { items: [{ id: '456' }] } } });
    const client = newClient();

    expect(await client.findItemIdsByColumnValue(999, 'qb_id_col', '60')).toEqual(['456']);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as Record<string, unknown>).body as string);
    expect(body.variables).toEqual({ boardId: 999, columnId: 'qb_id_col', value: '60' });
  });

  // GL#33 review: items(ids:) returns archived and deleted items too; state says which.
  it("reports an archived or deleted item's state rather than hiding it", async () => {
    const fetchMock = mockFetchOnce({ data: { items: [{ id: '456', name: 'Old Co', state: 'archived', column_values: [] }] } });
    const client = newClient();

    expect((await client.getItem('456'))?.state).toBe('archived');
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as Record<string, unknown>).body as string);
    expect(body.query).toMatch(/\bstate\b/);
  });

  it('returns null for an item that no longer exists', async () => {
    mockFetchOnce({ data: { items: [] } });
    const client = newClient();
    expect(await client.getItem('456')).toBeNull();
  });

  it('throws on a non-OK HTTP response', async () => {
    mockFetchOnce({}, false);
    const client = newClient();
    await expect(client.createItem(1, 'x', {})).rejects.toThrow(/HTTP 500/);
  });

  it('throws on a GraphQL errors array', async () => {
    mockFetchOnce({ errors: [{ message: 'Board not found' }] });
    const client = newClient();
    await expect(client.createItem(1, 'x', {})).rejects.toThrow(/Board not found/);
  });

  it('surfaces the server message on a 200 response carrying neither data nor errors', async () => {
    // monday.com's shape for some auth and rate-limit failures — without a guard this becomes a
    // confusing "Cannot read properties of undefined" further down the call stack.
    mockFetchOnce({ error_message: 'Not Authenticated', status_code: 401 });
    const client = newClient();
    await expect(client.createItem(1, 'x', {})).rejects.toThrow(/Not Authenticated.*401/);
  });

  it('includes the whole body when a data-less response has no error_message', async () => {
    mockFetchOnce({ something: 'unexpected' });
    const client = newClient();
    await expect(client.createItem(1, 'x', {})).rejects.toThrow(/something.*unexpected/);
  });
});

describe('HttpMondayClient transport (#35)', () => {
  it('sends the transport\'s single pinned API-Version (#39)', async () => {
    const fetchMock = mockFetchOnce({ data: { items: [] } });
    await newClient().getItem('1');
    expect(fetchMock.mock.calls[0]![1].headers['API-Version']).toBe(MONDAY_API_VERSION);
  });

  it('retries a 429 in-process and succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers: { 'Retry-After': '1' } }))
      .mockResolvedValueOnce(Response.json({ data: { items: [] } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(newClient().getItem('1')).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after 3 attempts, leaving longer waits to the queue backoff', async () => {
    const fetchMock = vi.fn(async () => new Response('down', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(newClient().getItem('1')).rejects.toThrow(/exhausted 3 attempts — last error: HTTP 503/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('never retries a create that may have committed', async () => {
    const fetchMock = vi.fn(async () => new Response('oops', { status: 504 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(newClient().createItem(1, 'x', {})).rejects.toBeInstanceOf(AmbiguousWriteError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
